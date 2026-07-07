#!/usr/bin/env node
/**
 * wasurenagusa-consolidate-all
 * 全アクティブプロジェクトのメモリを一括で再統合する。
 * launchd/cron から毎日深夜2時に実行される想定。
 */

import { basename } from "path";
import { homedir } from "os";
import { join } from "path";
import { writeFile } from "fs/promises";
import { ActiveProjectsTracker } from "../active-projects.js";
import { SQLiteStorage } from "../storage/sqlite.js";
import {
  isConsolidationStaleSqlite,
  isConfigConsolidationStaleSqlite,
} from "../consolidator/staleness.js";
import { runDreamGenerationForProject } from "./dream-worker.js";
import { config, getMemoryPath } from "../config.js";
import { isMainModule } from "../utils/cli-entry.js";
import { increment } from "../observability/counters.js";
import { generateJstTimestamp } from "../utils/operation-logger.js";
import type { GenerateTextFn } from "../llm/provider.js";
import type { MemoryEntry } from "../types.js";

/** 夜間統合dry-runレポートのファイル名（各プロジェクトの.wasurenagusa配下） */
export const DRY_RUN_REPORT_FILE = "consolidation-dryrun-report.json";

export interface ConsolidationDryRunReport {
  generatedAt: string;
  project: string;
  dont: {
    stale: boolean;
    aliveEntryCount: number;
    clusterCount: number;
    dupClusterCount: number;
  };
  config: {
    stale: boolean;
    entryCount: number;
  };
}

function log(message: string): void {
  process.stderr.write(message + "\n");
}

/**
 * 1プロジェクトのメモリ統合をdry-runで実行する（design.md Phase 0 ⑤、タスク0.8）。
 *
 * 【Phase 0止血】統合（dont重複排除・config要約）の書き込み（memoriesへのマージ結果保存・
 * 原本の論理削除・統合キャッシュ〔SQLite consolidated テーブル・consolidated-*.jsonファイル〕
 * への永続化）は停止する。クラスタリング計算・候補件数の算出（読み取り専用）は維持し、
 * 結果を各プロジェクトの .wasurenagusa/consolidation-dryrun-report.json へレポート出力する。
 * 追記型マージへの再設計（Phase 3）まで、この関数は書き込みを一切行わない。
 *
 * 鮮度判定・エントリ読み出しは SQLite を真実源とする（v2 経路）。
 * memory_save は SQLite のみに書き込み、SQLiteStorage.initialize() が起動時に
 * 旧 Markdown(v1) を SQLite へ自動移行するため、Markdown 運用環境のデータも
 * SQLite 側に存在する。よって SQLite を見れば後方互換を保てる。
 * 旧ファイル版の鮮度判定は dont.md / config.md が物理的に無いと false を返すため、
 * Markdown ファイルを持たない SQLite-only 環境（Windows 等）でも本関数は正しく動作する。
 *
 * generateTextFn は統合（dont/config）では使用しない（dry-run中はLLM呼び出し自体をしない）。
 * F3夢生成（統合とは別系統の書き込み。design.mdのdry-run対象外）にのみ引き続き使用する。
 */
export async function consolidateProject(
  projectPath: string,
  options: { generateTextFn?: GenerateTextFn } = {},
): Promise<void> {
  const { generateTextFn } = options;
  const currentProject = basename(projectPath);
  const memoryPath = getMemoryPath(projectPath);
  const dbPath = join(memoryPath, config.sqliteFile);

  const report: ConsolidationDryRunReport = {
    generatedAt: generateJstTimestamp(),
    project: currentProject,
    dont: { stale: false, aliveEntryCount: 0, clusterCount: 0, dupClusterCount: 0 },
    config: { stale: false, entryCount: 0 },
  };

  const storage = new SQLiteStorage(dbPath);
  storage.initialize(memoryPath);
  try {
    // dont統合の分析（embeddingベースのクラスタリングで「同一テーマ重複」候補を検出する。
    // 書き込みはしない＝クラスタ数・重複候補件数をレポートへ記録するのみ）
    const dontStale = isConsolidationStaleSqlite(storage);
    report.dont.stale = dontStale;
    if (dontStale) {
      const dontEntries: MemoryEntry[] = storage.readAliveDontEntries(currentProject);
      report.dont.aliveEntryCount = dontEntries.length;

      // クラスタリング: 各 entry の embedding を取得し、greedy に類似 entry を集める
      // multilingual-e5-small の距離分布に合わせた再較正値・実運用で要チューニング。
      // 旧モデル(all-MiniLM-L6-v2)の距離分布(最近傍平均0.7)を前提にした0.6は、新モデルの
      // 距離分布(最近傍平均0.32へ収縮)ではほぼ弁別せず過統合の懸念があるため、保守的に絞った。
      const SIM_DISTANCE_THRESHOLD = 0.25;
      const clusters: MemoryEntry[][] = [];
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

      // クラスタ size>=2 が重複統合の候補（dry-run中はLLMマージ・memories書き込みを行わない）
      const dupClusters = clusters.filter(c => c.length >= 2);
      report.dont.clusterCount = clusters.length;
      report.dont.dupClusterCount = dupClusters.length;
      log(`[consolidate-all] dry-run ${currentProject}: dont clusters=${clusters.length} dupCandidates=${dupClusters.length}（書き込みなし）`);
    }

    // config統合の分析（候補件数のみレポートへ記録。書き込みはしない）
    const configStale = isConfigConsolidationStaleSqlite(storage);
    report.config.stale = configStale;
    if (configStale) {
      const configEntries = storage.readConfigEntries(currentProject);
      report.config.entryCount = configEntries.length;
      log(`[consolidate-all] dry-run ${currentProject}: config candidates=${configEntries.length}（書き込みなし）`);
    }
  } finally {
    storage.close();
  }

  await writeFile(join(memoryPath, DRY_RUN_REPORT_FILE), JSON.stringify(report, null, 2), "utf-8");

  // 可観測性カウンタ（タスク0.9、R-M1）: 統合候補件数（dont重複クラスタ＋config候補）を記録する
  await increment(memoryPath, "consolidation_count", report.dont.dupClusterCount + report.config.entryCount);

  // F3: 夢生成（夜間バッチ後段。統合とは別系統の書き込みのためdry-run対象外。
  // 直近24h以内にdreamがあればスキップ、fail-open）
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
  // 統合はdry-run化されておりLLM呼び出しは行わない（consolidateProjectのJSDoc参照）ため、
  // APIキーの有無に関わらず処理を実行する。夢生成（F3）はAPIキー無し環境ではプロバイダ側で
  // fail-openする（consolidateProject内のcatchで捕捉・ログのみ）。
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
