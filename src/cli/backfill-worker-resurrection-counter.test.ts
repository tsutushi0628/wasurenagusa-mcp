import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  detectAndRecordResurrection,
  getResurrectionMeasurementFailureCount,
  resetResurrectionMeasurementFailureCountForTest,
} from "./backfill-worker.js";
import { SQLiteStorage } from "../storage/sqlite.js";

/**
 * 可観測性カウンタ（タスク0.9、R-M1）: 蘇生件数（deleted行への埋め込み付与の検出）。
 *
 * 論理削除済み(deleted_at IS NOT NULL)のmemoriesに対応するvectors行が残っていることを
 * 「蘇生」の兆候として検出し、observability countersへ記録する。
 * backfill-worker自体のクエリはdeleted_at IS NULLを絞り込むため蘇生を起こさないが、
 * 他経路での再発（またはvector未清算の放置）を検知する安全網として毎回のbackfill実行時に
 * 呼び出される。
 */
describe("backfill-worker: 蘇生件数の検出と計数", () => {
  let tmpDir: string;
  let memoryPath: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-resurrection-test-"));
    memoryPath = join(tmpDir, ".wasurenagusa");
    dbPath = join(memoryPath, "memory.db");
    mkdirSync(memoryPath, { recursive: true });
    resetResurrectionMeasurementFailureCountForTest();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("削除済みエントリのベクトルが残っている（蘇生）場合、件数を検出して記録する", async () => {
    const storage = new SQLiteStorage(dbPath);
    storage.initialize(memoryPath);
    const entry = storage.save({
      category: "dont",
      title: "蘇生検出テスト",
      content: "削除後にベクトルが残るケース",
      project: "myproject",
    });
    storage.upsertVector(entry.id, new Array(384).fill(0.1));
    storage.softDelete([entry.id]);
    // softDelete はベクトル自体を消さない設計（deleteVectorsは呼び出し元が明示的に呼ぶ）。
    // ここでは意図的にdeleteVectorsを呼ばず「蘇生（または未清算）」状態を再現する。

    const count = await detectAndRecordResurrection(storage, memoryPath);
    storage.close();

    expect(count).toBe(1);

    const today = new Date();
    const jst = new Date(today.getTime() + 9 * 60 * 60 * 1000);
    const datePart = jst.toISOString().slice(0, 10);
    const logPath = join(memoryPath, "logs", `counters-${datePart}.jsonl`);
    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    const resurrectionEntry = lines.find((e) => e.metric === "resurrection_count");
    expect(resurrectionEntry).toBeDefined();
    expect(resurrectionEntry.value).toBe(1);
  });

  it("削除済みエントリのベクトルが正しく清算済みなら、蘇生件数は0で記録される", async () => {
    const storage = new SQLiteStorage(dbPath);
    storage.initialize(memoryPath);
    const entry = storage.save({
      category: "dont",
      title: "正常清算テスト",
      content: "削除時にベクトルも消すケース",
      project: "myproject",
    });
    storage.upsertVector(entry.id, new Array(384).fill(0.1));
    storage.softDelete([entry.id]);
    storage.deleteVectors([entry.id]);

    const count = await detectAndRecordResurrection(storage, memoryPath);
    storage.close();

    expect(count).toBe(0);
  });

  it("蘇生件数の計測（countTombstones）が失敗しても本処理は落とさず、偽の0を記録せず計測失敗が可視化される", async () => {
    // countTombstones()自体がSQL読み取りで失敗するケースを再現する
    // （fail-open: detectAndRecordResurrectionは例外を投げず、nullを返す）
    const failingStorage = {
      countTombstones: () => {
        throw new Error("DB read failed");
      },
    } as unknown as SQLiteStorage;

    const before = getResurrectionMeasurementFailureCount();

    const count = await detectAndRecordResurrection(failingStorage, memoryPath);

    expect(count).toBeNull();
    expect(getResurrectionMeasurementFailureCount()).toBe(before + 1);

    // 偽の0をresurrection_countとして記録しない（JSONLに行自体が書かれない）
    const today = new Date();
    const jst = new Date(today.getTime() + 9 * 60 * 60 * 1000);
    const datePart = jst.toISOString().slice(0, 10);
    const logPath = join(memoryPath, "logs", `counters-${datePart}.jsonl`);
    if (existsSync(logPath)) {
      const lines = readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      expect(lines.some((e) => e.metric === "resurrection_count")).toBe(false);
    }
  });
});
