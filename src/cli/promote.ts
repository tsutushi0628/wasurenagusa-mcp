#!/usr/bin/env node
/**
 * 確定原則（principles）承認CLI（memory-redesign Phase 3・タスク3.11／R-A7）。
 *
 *   wasurenagusa-promote list [proposed|approved|expired|rejected]
 *   wasurenagusa-promote approve <id>
 *   wasurenagusa-promote reject <id>
 *   wasurenagusa-promote expire            # TTL到来分を expired へ（保守運用）
 *
 * 承認は人間の明示操作のみ（自動昇格・既定承認の経路を作らない）。対象ストアは
 * WASURENAGUSA_MEMORY_PATH（未指定なら cwd から解決）。本文はローカル表示のみ。
 */
import { join } from "path";
import { config, getMemoryPath } from "../config.js";
import { findProjectRoot } from "../utils/projectRoot.js";
import { SQLiteStorage } from "../storage/sqlite.js";

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
        const state = arg as "proposed" | "approved" | "expired" | "rejected" | undefined;
        const rows = storage.listPrinciples(state);
        for (const r of rows) {
          process.stdout.write(
            `${r.id}\t${r.state}\ttier=${r.originTier}\tvalid_until=${r.validUntil}\tapproved_at=${r.approvedAt ?? "-"}\t${r.text}\n`
          );
        }
        process.stdout.write(`# ${rows.length}件\n`);
        break;
      }
      case "approve": {
        if (!arg) throw new Error("approve には id が必要です");
        const n = storage.approvePrinciple(arg);
        process.stdout.write(n > 0 ? `approved: ${arg}\n` : `対象なし（proposed でない/存在しない）: ${arg}\n`);
        break;
      }
      case "reject": {
        if (!arg) throw new Error("reject には id が必要です");
        const n = storage.rejectPrinciple(arg);
        process.stdout.write(n > 0 ? `rejected: ${arg}\n` : `対象なし（proposed でない/存在しない）: ${arg}\n`);
        break;
      }
      case "expire": {
        const n = storage.expirePrinciples();
        process.stdout.write(`expired: ${n}件\n`);
        break;
      }
      default:
        process.stderr.write(
          "usage: wasurenagusa-promote <list [state] | approve <id> | reject <id> | expire>\n"
        );
        process.exitCode = 2;
    }
  } finally {
    close();
  }
}

main();
