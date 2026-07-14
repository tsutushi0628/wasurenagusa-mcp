import { ConsolidatedDont, ConsolidatedConfig } from "../types.js";
import { SQLiteStorage } from "../storage/sqlite.js";

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

// v1互換（ファイルベースの統合鮮度チェック・Markdown書き込み）は物理削除済み。
// 死因・設計意図は docs/graveyard.md を参照。
