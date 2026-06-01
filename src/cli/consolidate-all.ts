#!/usr/bin/env node
/**
 * wasurenagusa-consolidate-all
 * 全アクティブプロジェクトのメモリを一括で再統合する。
 * launchd/cron から毎日深夜2時に実行される想定。
 */

import { basename } from "path";
import { homedir } from "os";
import { join } from "path";
import { ActiveProjectsTracker } from "../active-projects.js";
import { SQLiteStorage } from "../storage/sqlite.js";
import { DontConsolidator } from "../consolidator/dont-consolidator.js";
import { ConfigConsolidator } from "../consolidator/config-consolidator.js";
import {
  writeConsolidatedDont,
  writeConsolidatedConfig,
  isConsolidationStaleSqlite,
  isConfigConsolidationStaleSqlite,
} from "../consolidator/staleness.js";
import {
  persistConsolidatedDontToSqlite,
  persistConsolidatedConfigToSqlite,
  mergePrinciplesIntoMemories,
} from "../consolidator/persistence-helper.js";
import { runDreamGenerationForProject } from "./dream-worker.js";
import { config, getMemoryPath } from "../config.js";
import { isMainModule } from "../utils/cli-entry.js";
import type { GenerateTextFn } from "../llm/provider.js";
import type { ConsolidatedDont } from "../types.js";

function jstTimestamp(): string {
  const now = new Date();
  const jstOffset = 9 * 60 * 60 * 1000;
  const jst = new Date(now.getTime() + jstOffset);
  return jst.toISOString().replace("Z", "+09:00");
}

function log(message: string): void {
  process.stderr.write(message + "\n");
}

/**
 * 1プロジェクトのメモリを再統合する。
 *
 * 鮮度判定・エントリ読み出しは SQLite を真実源とする（v2 経路）。
 * memory_save は SQLite のみに書き込み、SQLiteStorage.initialize() が起動時に
 * 旧 Markdown(v1) を SQLite へ自動移行するため、Markdown 運用環境のデータも
 * SQLite 側に存在する。よって SQLite を見れば後方互換を保てる。
 * 旧ファイル版の鮮度判定は dont.md / config.md が物理的に無いと false を返すため、
 * Markdown ファイルを持たない SQLite-only 環境（Windows 等）では統合が永久に
 * スキップされてしまう。そのため CLI では使わない。
 *
 * テスト用に generateTextFn を注入できる（省略時は実 LLM）。
 */
export async function consolidateProject(
  projectPath: string,
  options: { generateTextFn?: GenerateTextFn } = {},
): Promise<void> {
  const { generateTextFn } = options;
  const currentProject = basename(projectPath);
  const memoryPath = getMemoryPath(projectPath);
  const dbPath = join(memoryPath, config.sqliteFile);

  // 読み取り・鮮度判定は1接続を使い回す（try/finally で必ず閉じる）。
  // 統合結果の書き込み（ファイル＋SQLite）は既存の fail-open ヘルパが個別に開閉する。
  const storage = new SQLiteStorage(dbPath);
  storage.initialize(memoryPath);
  try {
    // dont統合（embedding ベースのクラスタリングで「同一テーマ重複」だけを統合する重複排除）
    if (isConsolidationStaleSqlite(storage)) {
      const dontEntries = storage.readAliveDontEntries(currentProject);

      // クラスタリング: 各 entry の embedding を取得し、greedy に類似 entry を集める
      const SIM_DISTANCE_THRESHOLD = 0.6; // 距離 0.6（保守めの類似度。様子見しつつ調整する）
      const clusters: typeof dontEntries[] = [];
      const assigned = new Set<string>();
      for (const entry of dontEntries) {
        if (assigned.has(entry.id)) continue;
        const eEmb = storage.getEmbedding(entry.id);
        const cluster = [entry];
        assigned.add(entry.id);
        if (eEmb) {
          const similar = storage.searchVectors(eEmb, SIM_DISTANCE_THRESHOLD, 30);
          for (const r of similar) {
            if (assigned.has(r.id) || r.id === entry.id) continue;
            const candidate = dontEntries.find(e => e.id === r.id);
            if (candidate) {
              cluster.push(candidate);
              assigned.add(r.id);
            }
          }
        }
        clusters.push(cluster);
      }

      // クラスタ size>=2 だけを LLM で重複排除統合（singleton はそのまま放置）
      const dupClusters = clusters.filter(c => c.length >= 2);
      const principles = [];
      if (dupClusters.length > 0) {
        const consolidator = new DontConsolidator(generateTextFn);
        for (const cluster of dupClusters) {
          const merged = await consolidator.mergeCluster(cluster);
          if (merged) principles.push(merged);
        }
      }

      // 統合 principle を memories へ反映（新規 dont 保存＋元 source の論理削除）
      let mergeStats = { merged: 0, softDeleted: 0 };
      if (principles.length > 0) {
        mergeStats = mergePrinciplesIntoMemories(memoryPath, principles, currentProject, log);
      }

      // 収束: 統合後の「生存 dont 件数」を source_entry_count として記録する。これを残さないと
      // 鮮度判定が永久に stale=true のままになり毎晩クラスタリングを無駄に再実行する。
      // principle が無い回でも既存の principles を保持したまま件数だけ更新して鮮度を確定させる。
      const aliveAfter = storage.readAliveDontEntries(currentProject).length;
      const prior = storage.readConsolidated("dont") as ConsolidatedDont | null;
      const result: ConsolidatedDont = {
        principles: principles.length > 0 ? principles : (prior?.principles ?? []),
        consolidatedAt: jstTimestamp(),
        sourceEntryCount: aliveAfter,
        version: 1,
      };
      await writeConsolidatedDont(memoryPath, result);
      persistConsolidatedDontToSqlite(memoryPath, result, log);
      log(`[consolidate-all] ${currentProject}: clusters=${clusters.length} dup=${dupClusters.length} merged=${mergeStats.merged} softDeleted=${mergeStats.softDeleted} alive=${aliveAfter}`);
    }

    // config統合
    if (isConfigConsolidationStaleSqlite(storage)) {
      const configEntries = storage.readConfigEntries(currentProject);
      if (configEntries.length > 0) {
        const consolidator = new ConfigConsolidator(generateTextFn);
        const result = await consolidator.consolidate(configEntries);
        if (result) {
          await writeConsolidatedConfig(memoryPath, result);
          persistConsolidatedConfigToSqlite(memoryPath, result, log);
        }
      }
    }
  } finally {
    storage.close();
  }

  // F3: 夢生成（夜間バッチ後段。直近24h以内にdreamがあればスキップ、fail-open）
  try {
    const dreamResult = await runDreamGenerationForProject({
      memoryPath,
      projectRoot: projectPath,
      generateTextFn,
    });
    if (dreamResult) {
      log(`[consolidate-all] dream generated for ${currentProject}: ${dreamResult.title}`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log(`[consolidate-all] dream generation failed (${currentProject}): ${message}`);
  }
}

async function main(): Promise<void> {
  // APIキーが一つもなければ何もしない
  if (!config.geminiApiKey && !config.openaiApiKey && !config.anthropicApiKey) {
    log("[consolidate-all] No API key available. Exiting.");
    process.exit(0);
  }

  const schedulerDir = join(homedir(), ".wasurenagusa", "scheduler");
  const tracker = new ActiveProjectsTracker(schedulerDir);
  const projects = await tracker.getActiveProjects();

  if (projects.length === 0) {
    log("[consolidate-all] No active projects found.");
    return;
  }

  log(`[consolidate-all] Processing ${projects.length} project(s)...`);

  for (const project of projects) {
    log(`[consolidate-all] ${project.name}`);
    try {
      await consolidateProject(project.path);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[consolidate-all] ERROR (${project.name}): ${message}`);
    }
  }

  log("[consolidate-all] Done.");
}

// import 時に main を実行しない（テストから consolidateProject を import できるように）。
// bin(symlink) 経由でも起動するよう realpath 比較する isMainModule を使う。
if (isMainModule(import.meta.url)) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    log(`[consolidate-all] Fatal: ${message}`);
    process.exit(1);
  });
}
