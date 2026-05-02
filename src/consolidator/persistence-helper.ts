/**
 * 集約結果の SQLite 同期書き込みヘルパー。
 *
 * consolidate-worker.ts と consolidate-all.ts の重複（SQLite open → write → close）を
 * 集約する。fail-open: SQLite 書き込みが失敗してもファイル書き込み（呼び出し元）は維持される。
 */

import { join } from "path";
import { SQLiteStorage } from "../storage/sqlite.js";
import { config } from "../config.js";
import {
  writeConsolidatedDontSqlite,
  writeConsolidatedConfigSqlite,
} from "./staleness.js";
import type { ConsolidatedDont, ConsolidatedConfig } from "../types.js";

type Logger = (message: string) => void;

const defaultLogger: Logger = (message) => {
  process.stderr.write(message + "\n");
};

/**
 * SQLite consolidated('dont') へ書き込む。失敗は呼び出し元に伝播させず stderr に1行記録する。
 */
export function persistConsolidatedDontToSqlite(
  memoryPath: string,
  data: ConsolidatedDont,
  logger: Logger = defaultLogger,
): void {
  try {
    const dbPath = join(memoryPath, config.sqliteFile);
    const sqliteStorage = new SQLiteStorage(dbPath);
    sqliteStorage.initialize(memoryPath);
    writeConsolidatedDontSqlite(sqliteStorage, data);
    sqliteStorage.close();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger(`[consolidator-persistence] SQLite dont write failed: ${message}`);
  }
}

/**
 * SQLite consolidated('config') へ書き込む。失敗は呼び出し元に伝播させず stderr に1行記録する。
 */
export function persistConsolidatedConfigToSqlite(
  memoryPath: string,
  data: ConsolidatedConfig,
  logger: Logger = defaultLogger,
): void {
  try {
    const dbPath = join(memoryPath, config.sqliteFile);
    const sqliteStorage = new SQLiteStorage(dbPath);
    sqliteStorage.initialize(memoryPath);
    writeConsolidatedConfigSqlite(sqliteStorage, data);
    sqliteStorage.close();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger(`[consolidator-persistence] SQLite config write failed: ${message}`);
  }
}
