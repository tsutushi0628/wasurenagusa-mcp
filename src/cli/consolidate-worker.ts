#!/usr/bin/env node
/**
 * consolidate-worker
 * detachedプロセスとして起動され、dont/config統合をバックグラウンドで実行する。
 *
 * 使い方: node consolidate-worker.js <memoryPath> <projectRoot>
 *
 * context.ts の SessionStart hook から spawn される。
 * hookの5秒タイムアウトに影響を与えず、LLM APIコールを完了できる。
 */

import { basename } from "path";
import { MarkdownStorage } from "../storage/index.js";
import { config } from "../config.js";
import { DontConsolidator } from "../consolidator/dont-consolidator.js";
import { ConfigConsolidator } from "../consolidator/config-consolidator.js";
import {
  writeConsolidatedDont,
  writeConsolidatedConfig,
  isConsolidationStale,
  isConfigConsolidationStale,
} from "../consolidator/staleness.js";

async function main() {
  const [memoryPath, projectRoot] = process.argv.slice(2);

  if (!memoryPath || !projectRoot) {
    process.exit(1);
  }

  if (!config.geminiApiKey && !config.openaiApiKey && !config.anthropicApiKey) {
    process.exit(0);
  }

  const currentProject = basename(projectRoot);
  const storage = new MarkdownStorage(projectRoot);

  // dont統合（criticalエントリは統合から除外）
  if (await isConsolidationStale(memoryPath)) {
    const dontEntries = await storage.readDontEntries(currentProject);
    const consolidationTargets = dontEntries.filter(e => e.importance !== "critical");
    if (consolidationTargets.length > 0) {
      const consolidator = new DontConsolidator();
      const result = await consolidator.consolidate(consolidationTargets);
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

main().catch(() => {
  process.exit(1);
});
