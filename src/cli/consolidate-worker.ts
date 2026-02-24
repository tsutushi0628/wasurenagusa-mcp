#!/usr/bin/env node
/**
 * consolidate-worker
 * detachedプロセスとして起動され、dont統合をバックグラウンドで実行する。
 *
 * 使い方: node consolidate-worker.js <memoryPath> <projectRoot>
 *
 * context.ts の SessionStart hook から spawn される。
 * hookの5秒タイムアウトに影響を与えず、Gemini APIコールを完了できる。
 */

import { basename } from "path";
import { MarkdownStorage } from "../storage/index.js";
import { config } from "../config.js";
import { DontConsolidator } from "../consolidator/dont-consolidator.js";
import { writeConsolidatedDont } from "../consolidator/staleness.js";

async function main() {
  const [memoryPath, projectRoot] = process.argv.slice(2);

  if (!memoryPath || !projectRoot) {
    process.exit(1);
  }

  if (!config.geminiApiKey) {
    process.exit(0);
  }

  const currentProject = basename(projectRoot);
  const storage = new MarkdownStorage(projectRoot);
  const entries = await storage.readDontEntries(currentProject);

  if (entries.length === 0) {
    process.exit(0);
  }

  const consolidator = new DontConsolidator();
  const result = await consolidator.consolidate(entries);

  if (result) {
    await writeConsolidatedDont(memoryPath, result);
  }
}

main().catch(() => {
  process.exit(1);
});
