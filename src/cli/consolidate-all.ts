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
import { MarkdownStorage } from "../storage/index.js";
import { DontConsolidator } from "../consolidator/dont-consolidator.js";
import { ConfigConsolidator } from "../consolidator/config-consolidator.js";
import {
  writeConsolidatedDont,
  writeConsolidatedConfig,
  isConsolidationStale,
  isConfigConsolidationStale,
} from "../consolidator/staleness.js";
import {
  persistConsolidatedDontToSqlite,
  persistConsolidatedConfigToSqlite,
  mergePrinciplesIntoMemories,
} from "../consolidator/persistence-helper.js";
import { runDreamGenerationForProject } from "./dream-worker.js";
import { config, getMemoryPath } from "../config.js";

function log(message: string): void {
  process.stderr.write(message + "\n");
}

async function consolidateProject(projectPath: string): Promise<void> {
  const currentProject = basename(projectPath);
  const memoryPath = getMemoryPath(projectPath);
  const storage = new MarkdownStorage(projectPath);

  // dont統合
  if (await isConsolidationStale(memoryPath)) {
    const dontEntries = await storage.readDontEntries(currentProject);
    if (dontEntries.length > 0) {
      const consolidator = new DontConsolidator();
      const result = await consolidator.consolidate(dontEntries);
      if (result) {
        await writeConsolidatedDont(memoryPath, result);
        // B0a 修復: SQLite consolidated('dont') にも同期書き込み（fail-open）
        persistConsolidatedDontToSqlite(memoryPath, result, log);
        // 重複排除: principles を新規 dont として保存 + 元 source を論理削除
        const mergeStats = mergePrinciplesIntoMemories(memoryPath, result.principles, currentProject, log);
        if (mergeStats.merged > 0) {
          log(`[consolidate-all] ${currentProject}: merged=${mergeStats.merged} softDeleted=${mergeStats.softDeleted}`);
        }
      }
    }
  }

  // config統合
  if (await isConfigConsolidationStale(memoryPath)) {
    const configEntries = await storage.readConfigEntries(currentProject);
    if (configEntries.length > 0) {
      const consolidator = new ConfigConsolidator();
      const result = await consolidator.consolidate(configEntries);
      if (result) {
        await writeConsolidatedConfig(memoryPath, result);
        persistConsolidatedConfigToSqlite(memoryPath, result, log);
      }
    }
  }

  // F3: 夢生成（夜間バッチ後段。直近24h以内にdreamがあればスキップ、fail-open）
  try {
    const dreamResult = await runDreamGenerationForProject({
      memoryPath,
      projectRoot: projectPath,
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

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  log(`[consolidate-all] Fatal: ${message}`);
  process.exit(1);
});
