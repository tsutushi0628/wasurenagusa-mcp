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
import type { ConsolidatedDont, ConsolidatedConfig, ConsolidatedPrinciple } from "../types.js";

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
 * 統合された principles を新規 dont エントリとして memories へ保存し、
 * 元の source エントリを論理削除する。
 *
 * 設計意図: consolidator が「日付切り詰め」系の似たエントリ N 件を 1 つの principle に集約しても、
 * 元の N 件は memories に残り続けるため重複が消えない問題があった。
 * principle を新規 dont として保存 + sourceIds を論理削除することで、
 * memory_search 結果から重複が消え、必要なら memory_get_detail で復元可能な状態にする。
 *
 * fail-open: 個別 principle の保存・削除失敗は他の principle 処理を止めず stderr に1行記録する。
 */
export function mergePrinciplesIntoMemories(
  memoryPath: string,
  principles: ConsolidatedPrinciple[],
  currentProject: string,
  logger: Logger = defaultLogger,
): { merged: number; softDeleted: number } {
  let merged = 0;
  let softDeleted = 0;
  try {
    const dbPath = join(memoryPath, config.sqliteFile);
    const sqliteStorage = new SQLiteStorage(dbPath);
    sqliteStorage.initialize(memoryPath);

    for (const p of principles) {
      // sourceIds が空のものだけスキップ（singleton も positiveRule への書き換え目的で処理する）
      if (!p.sourceIds || p.sourceIds.length < 1) continue;

      try {
        // principle を新規 dont エントリとして保存
        sqliteStorage.save({
          category: "dont",
          title: p.theme || `[merged ${p.sourceCount} entries]`,
          content: p.rule,
          tags: p.tags ?? [],
          project: currentProject,
          intensity: p.maxIntensity,
        });
        merged += 1;

        // 元の source エントリを論理削除
        const result = sqliteStorage.softDelete(p.sourceIds);
        softDeleted += result.softDeleted.length;

        // 統合で吸収済みの重複 source のベクトルを除去する。残すと searchVectors が
        // 死んだ ID を近傍として返し続け、k 件の枠を食って生きた近重複の検出を妨げる。
        // （復元が必要になった場合は backfill-worker が埋め込みを再生成する）
        if (result.softDeleted.length > 0) {
          sqliteStorage.deleteVectors(result.softDeleted);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger(`[consolidator-merge] principle '${p.theme}' merge failed: ${message}`);
      }
    }

    sqliteStorage.close();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger(`[consolidator-merge] DB open failed: ${message}`);
  }
  return { merged, softDeleted };
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
