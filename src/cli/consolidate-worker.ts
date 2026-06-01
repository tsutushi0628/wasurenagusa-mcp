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
import { isMainModule } from "../utils/cli-entry.js";
import { MarkdownStorage } from "../storage/index.js";
import { config } from "../config.js";
import { DontConsolidator } from "../consolidator/dont-consolidator.js";
import { ConfigConsolidator } from "../consolidator/config-consolidator.js";
import {
  writeConsolidatedDont,
  writeConsolidatedConfig,
  writeDontSummary,
  isConsolidationStale,
  isConfigConsolidationStale,
} from "../consolidator/staleness.js";
import {
  persistConsolidatedDontToSqlite,
  persistConsolidatedConfigToSqlite,
} from "../consolidator/persistence-helper.js";
import type { GenerateTextFn } from "../llm/provider.js";
import type { ConsolidatedDont } from "../types.js";

interface DontConsolidationOptions {
  memoryPath: string;
  projectRoot: string;
  generateTextFn?: GenerateTextFn;
}

/**
 * 1プロジェクトの dont 統合を実行する。
 * - MarkdownStorage から dont エントリ読込
 * - DontConsolidator で統合
 * - 結果を ① consolidated-dont.json ② SQLite consolidated('dont') の二重で書き込み
 * - サマリ生成・consolidated-dont-summary.md を書き込み
 *
 * モック LLM テスト用に generateTextFn を注入できる。
 */
export async function runDontConsolidationForProject(
  options: DontConsolidationOptions,
): Promise<ConsolidatedDont | null> {
  const { memoryPath, projectRoot, generateTextFn } = options;
  const currentProject = basename(projectRoot);
  const storage = new MarkdownStorage(projectRoot);

  const dontEntries = await storage.readDontEntries(currentProject);
  if (dontEntries.length === 0) return null;

  const consolidator = new DontConsolidator(generateTextFn);
  const result = await consolidator.consolidate(dontEntries);
  if (!result) return null;

  // ① ファイル書き込み（既存パス: PreToolUse / Stop guard が直読する）
  await writeConsolidatedDont(memoryPath, result);

  // ② SQLite 書き込み（B0a 修復: agent モードの SessionStart 注入が読む）
  // ファイル書き込みが先に成功している前提で、SQLite 失敗は fail-open でログのみ。
  persistConsolidatedDontToSqlite(memoryPath, result);

  // サマリ生成・保存
  const summary = await consolidator.generateSummary(result);
  await writeDontSummary(memoryPath, summary);

  return result;
}

/**
 * 1プロジェクトの config 統合を実行する。
 * dont と同様にファイル + SQLite の二重書き。
 */
export async function runConfigConsolidationForProject(
  options: DontConsolidationOptions,
): Promise<void> {
  const { memoryPath, projectRoot, generateTextFn } = options;
  const currentProject = basename(projectRoot);
  const storage = new MarkdownStorage(projectRoot);

  const configEntries = await storage.readConfigEntries(currentProject);
  if (configEntries.length === 0) return;

  const consolidator = new ConfigConsolidator(generateTextFn);
  const result = await consolidator.consolidate(configEntries);
  if (!result) return;

  await writeConsolidatedConfig(memoryPath, result);
  persistConsolidatedConfigToSqlite(memoryPath, result);
}

async function main() {
  const [memoryPath, projectRoot] = process.argv.slice(2);

  if (!memoryPath || !projectRoot) {
    process.exit(1);
  }

  if (!config.geminiApiKey && !config.openaiApiKey && !config.anthropicApiKey) {
    process.exit(0);
  }

  // dont統合（全エントリ対象）
  if (await isConsolidationStale(memoryPath)) {
    await runDontConsolidationForProject({ memoryPath, projectRoot });
  }

  // config統合
  if (await isConfigConsolidationStale(memoryPath)) {
    await runConfigConsolidationForProject({ memoryPath, projectRoot });
  }
}

// import 時に main を実行しない。bin(symlink) 経由でも起動するよう realpath 比較する。
if (isMainModule(import.meta.url)) {
  main().catch(() => {
    process.exit(1);
  });
}
