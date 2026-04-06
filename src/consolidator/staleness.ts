import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { config } from "../config.js";
import { ConsolidatedDont, ConsolidatedConfig } from "../types.js";
import { SQLiteStorage } from "../storage/sqlite.js";

const CONSOLIDATED_DONT_SUMMARY_FILE = "consolidated-dont-summary.md";

// === v2: SQLiteStorage経由の統合鮮度チェック ===

export function isConsolidationStaleSqlite(storage: SQLiteStorage): boolean {
  return storage.isConsolidationStale("dont");
}

export function isConfigConsolidationStaleSqlite(storage: SQLiteStorage): boolean {
  return storage.isConsolidationStale("config");
}

export function readConsolidatedDontSqlite(storage: SQLiteStorage): ConsolidatedDont | null {
  return storage.readConsolidated("dont") as ConsolidatedDont | null;
}

export function readConsolidatedConfigSqlite(storage: SQLiteStorage): ConsolidatedConfig | null {
  return storage.readConsolidated("config") as ConsolidatedConfig | null;
}

export function writeConsolidatedDontSqlite(storage: SQLiteStorage, data: ConsolidatedDont): void {
  storage.writeConsolidated("dont", data);
}

export function writeConsolidatedConfigSqlite(storage: SQLiteStorage, data: ConsolidatedConfig): void {
  storage.writeConsolidated("config", data);
}

// === v1互換: ファイルベースの統合鮮度チェック（段階移行期間中に使用） ===

import { stat } from "fs/promises";
import { parseMarkdown } from "../storage/parser.js";

export async function isConsolidationStale(memoryPath: string): Promise<boolean> {
  const dontPath = join(memoryPath, config.categoryFiles.dont);
  const consolidatedPath = join(memoryPath, config.consolidatedDontFile);

  if (!existsSync(dontPath)) return false;
  if (!existsSync(consolidatedPath)) return true;

  const [dontStat, consolidatedStat] = await Promise.all([
    stat(dontPath),
    stat(consolidatedPath),
  ]);

  if (dontStat.mtimeMs > consolidatedStat.mtimeMs) return true;

  const consolidated = await readConsolidatedDont(memoryPath);
  if (!consolidated) return true;

  const dontContent = await readFile(dontPath, "utf-8");
  const entries = parseMarkdown(dontContent, "dont");

  return entries.length !== consolidated.sourceEntryCount;
}

export async function readConsolidatedDont(memoryPath: string): Promise<ConsolidatedDont | null> {
  const consolidatedPath = join(memoryPath, config.consolidatedDontFile);
  if (!existsSync(consolidatedPath)) return null;

  try {
    const content = await readFile(consolidatedPath, "utf-8");
    return JSON.parse(content) as ConsolidatedDont;
  } catch {
    return null;
  }
}

export async function writeConsolidatedDont(memoryPath: string, data: ConsolidatedDont): Promise<void> {
  const consolidatedPath = join(memoryPath, config.consolidatedDontFile);
  await writeFile(consolidatedPath, JSON.stringify(data, null, 2), "utf-8");
}

// === Config Consolidation ===

export async function isConfigConsolidationStale(memoryPath: string): Promise<boolean> {
  const configPath = join(memoryPath, config.categoryFiles.config);
  const consolidatedPath = join(memoryPath, config.consolidatedConfigFile);

  if (!existsSync(configPath)) return false;
  if (!existsSync(consolidatedPath)) return true;

  const [configStat, consolidatedStat] = await Promise.all([
    stat(configPath),
    stat(consolidatedPath),
  ]);

  if (configStat.mtimeMs > consolidatedStat.mtimeMs) return true;

  const consolidated = await readConsolidatedConfig(memoryPath);
  if (!consolidated) return true;

  const configContent = await readFile(configPath, "utf-8");
  const entries = parseMarkdown(configContent, "config");

  return entries.length !== consolidated.sourceEntryCount;
}

export async function readConsolidatedConfig(memoryPath: string): Promise<ConsolidatedConfig | null> {
  const consolidatedPath = join(memoryPath, config.consolidatedConfigFile);
  if (!existsSync(consolidatedPath)) return null;

  try {
    const content = await readFile(consolidatedPath, "utf-8");
    return JSON.parse(content) as ConsolidatedConfig;
  } catch {
    return null;
  }
}

export async function writeConsolidatedConfig(memoryPath: string, data: ConsolidatedConfig): Promise<void> {
  const consolidatedPath = join(memoryPath, config.consolidatedConfigFile);
  await writeFile(consolidatedPath, JSON.stringify(data, null, 2), "utf-8");
}

// === Dont Summary ===

export async function readDontSummary(memoryPath: string): Promise<string | null> {
  const summaryPath = join(memoryPath, CONSOLIDATED_DONT_SUMMARY_FILE);
  if (!existsSync(summaryPath)) return null;

  try {
    const content = await readFile(summaryPath, "utf-8");
    if (content.trim().length === 0) return null;
    return content;
  } catch {
    return null;
  }
}

export async function writeDontSummary(memoryPath: string, summary: string): Promise<void> {
  const summaryPath = join(memoryPath, CONSOLIDATED_DONT_SUMMARY_FILE);
  await writeFile(summaryPath, summary, "utf-8");
}
