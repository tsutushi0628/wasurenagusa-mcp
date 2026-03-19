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
      }
    }
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
