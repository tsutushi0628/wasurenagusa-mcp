#!/usr/bin/env node
/**
 * 承認制ガード（guards テーブル）の承認CLI（memory-redesign spec Phase 4・タスク4.5・R-C4）。
 *
 *   wasurenagusa-guard-approve list [proposed|active|expired|disabled]
 *   wasurenagusa-guard-approve approve <id>
 *
 * 承認は人間の明示操作のみ（自動承認・自動生成の経路は一切作らない）。
 * アクティブ規則数が上限を超える有効化はエラーで拒否する（src/guards/registry.ts activateGuard）。
 * 対象ストアは WASURENAGUSA_MEMORY_PATH（未指定なら cwd から解決）。
 */
import { join } from "path";
import { config, getMemoryPath } from "../config.js";
import { findProjectRoot } from "../utils/projectRoot.js";
import { SQLiteStorage } from "../storage/sqlite.js";
import { activateGuard, GuardCapExceededError, GuardNotFoundError } from "../guards/registry.js";

function resolveStorage(): { storage: SQLiteStorage; close: () => void } {
  const memoryPath = process.env.WASURENAGUSA_MEMORY_PATH ?? getMemoryPath(findProjectRoot(process.cwd()));
  const storage = new SQLiteStorage(join(memoryPath, config.sqliteFile));
  storage.initialize(memoryPath);
  return { storage, close: () => storage.close() };
}

function main(): void {
  const [cmd, arg] = process.argv.slice(2);
  const { storage, close } = resolveStorage();
  try {
    switch (cmd) {
      case "list": {
        const state = arg;
        const db = storage.connection;
        const rows = state
          ? (db.prepare("SELECT * FROM guards WHERE state = ? ORDER BY created_at").all(state) as Array<Record<string, unknown>>)
          : (db.prepare("SELECT * FROM guards ORDER BY created_at").all() as Array<Record<string, unknown>>);
        for (const r of rows) {
          process.stdout.write(
            `${r.id}\t${r.state}\tsource=${r.source_incident_id}\texpires_at=${r.expires_at}\tapproved_at=${r.approved_at ?? "-"}\t${r.pattern}\n`
          );
        }
        process.stdout.write(`# ${rows.length}件\n`);
        break;
      }
      case "approve": {
        if (!arg) throw new Error("approve には id が必要です");
        try {
          activateGuard(storage.connection, arg);
          process.stdout.write(`approved: ${arg}\n`);
        } catch (error) {
          if (error instanceof GuardNotFoundError || error instanceof GuardCapExceededError) {
            process.stderr.write(`${error.message}\n`);
            process.exitCode = 1;
            break;
          }
          throw error;
        }
        break;
      }
      default:
        process.stderr.write("usage: wasurenagusa-guard-approve <list [state] | approve <id>>\n");
        process.exitCode = 2;
    }
  } finally {
    close();
  }
}

main();
