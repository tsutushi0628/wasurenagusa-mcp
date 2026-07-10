import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SQLiteStorage } from "./sqlite.js";
import { snapshot, type MetricsSnapshot } from "../observability/counters.js";

/**
 * 書き込み失敗計数の導入とWAL設定の確認固定（タスク1.12、design.md Phase 1 ⑥、R-A5）。
 *
 * 前提の事実: WALとbusyタイムアウトはHEAD時点で既に設定済み（src/storage/schema.ts）。
 * 本テストは新規設定ではなく、既存設定が実際に効いていることの固定と、
 * 書き込み失敗が握りつぶされず計数されることの検証を行う。
 *
 * 計数は本番実装上fire-and-forget（同期メソッドの外側で非同期JSONL追記するfail-open設計、
 * counters.ts既存方針を踏襲）のため、書き込み完了までポーリングで待ち合わせる。
 */
async function waitForWriteFailureCount(memoryPath: string, minCount: number, timeoutMs = 2000): Promise<MetricsSnapshot> {
  const start = Date.now();
  for (;;) {
    const snap = await snapshot(memoryPath);
    if (snap.writeFailureCount.total >= minCount) return snap;
    if (Date.now() - start > timeoutMs) return snap;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
describe("多並列アクセス耐性（R-A5）", () => {
  let tmpDir: string;
  let memoryPath: string;
  let storage: SQLiteStorage;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-write-resilience-test-"));
    memoryPath = join(tmpDir, ".wasurenagusa");
    mkdirSync(memoryPath, { recursive: true });
    storage = new SQLiteStorage(join(memoryPath, "memory.db"));
    storage.initialize(memoryPath);
  });

  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("WAL設定の確認固定（R-A5 AC1/AC2）", () => {
    it("接続はWALモードで動作する", () => {
      expect(storage.getJournalMode()).toBe("wal");
    });

    it("busyタイムアウトが設定されている(0より大きい)", () => {
      expect(storage.getBusyTimeout()).toBeGreaterThan(0);
    });
  });

  describe("書き込み失敗の計数と警報（R-A5 AC3）", () => {
    it("saveがCHECK制約違反で失敗すると、例外は握りつぶされず再throwされる", () => {
      expect(() => {
        // categoryはCHECK制約で列挙値に限定されている。不正値を直接渡して書き込み失敗を誘発する。
        storage.save({ category: "invalid-category" as never, title: "t", content: "c" });
      }).toThrow();
    });

    it("saveの書き込み失敗はカウンタへ計上される（握りつぶされない）", async () => {
      expect(() => {
        storage.save({ category: "invalid-category" as never, title: "t", content: "c" });
      }).toThrow();

      const snap = await waitForWriteFailureCount(memoryPath, 1);
      expect(snap.writeFailureCount.total).toBeGreaterThanOrEqual(1);
    });

    it("softDeleteの書き込み失敗（DBクローズ後の呼び出し）もカウンタへ計上される", async () => {
      const entry = storage.save({ category: "log", title: "対象", content: "本文" });
      storage.close();

      expect(() => {
        storage.softDelete([entry.id]);
      }).toThrow();

      // closeされたstorage経由ではmemoryPathを引けないため、直接ディレクトリを指定して確認する
      const snap = await waitForWriteFailureCount(memoryPath, 1);
      expect(snap.writeFailureCount.total).toBeGreaterThanOrEqual(1);
    });
  });
});
