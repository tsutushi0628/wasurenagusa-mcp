import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SQLiteStorage } from "./sqlite.js";
import { cosineSimThreshold } from "../vector/distance-types.js";

// 特定方向のダミーベクトル（1次元だけ値を持たせ、L2正規化しておく）
function unitVector(idx: number): number[] {
  const vec = new Array(384).fill(0);
  vec[idx] = 1.0;
  return vec;
}

describe("searchVectorsByCategory（カテゴリ限定KNN・コサイン類似度の型で判定）", () => {
  let storage: SQLiteStorage;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-catknn-test-"));
    storage = new SQLiteStorage(join(tmpDir, "test.db"));
    storage.initialize();
  });

  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("近傍探索が対象カテゴリで事前に絞り込まれる（他カテゴリの近傍が結果に混ざらない）", () => {
    // 同一方向(idx=0)のベクトルを category 違いで2件保存する
    const dont = storage.save({ category: "dont", title: "d", content: "dont-x", project: "p" });
    const cfg = storage.save({ category: "config", title: "c", content: "cfg-x", project: "p" });
    storage.upsertVector(dont.id, unitVector(0));
    storage.upsertVector(cfg.id, unitVector(0)); // dont と全く同じ方向＝最近傍

    // dont カテゴリに絞った近傍探索では config の同方向ベクトルは返らない
    const results = storage.searchVectorsByCategory(
      unitVector(0),
      "dont",
      cosineSimThreshold(0.5),
      10,
    );
    const ids = results.map((r) => r.id);
    expect(ids).toContain(dont.id);
    expect(ids).not.toContain(cfg.id);
  });

  it("類似判定がコサイン類似度の型で行われる（結果に measure='cosineSim' の類似度が付く）", () => {
    const a = storage.save({ category: "dont", title: "a", content: "aaa", project: "p" });
    storage.upsertVector(a.id, unitVector(0));

    const results = storage.searchVectorsByCategory(
      unitVector(0),
      "dont",
      cosineSimThreshold(0.5),
      10,
    );
    const hit = results.find((r) => r.id === a.id);
    expect(hit).toBeDefined();
    expect(hit!.similarity.measure).toBe("cosineSim");
    // 完全一致方向 → cos ≈ 1
    expect(hit!.similarity.value).toBeCloseTo(1, 3);
  });

  it("類似度が閾値未満の近傍は除外される（>= 閾値のみ残る）", () => {
    const near = storage.save({ category: "dont", title: "n", content: "near", project: "p" });
    const far = storage.save({ category: "dont", title: "f", content: "far", project: "p" });
    storage.upsertVector(near.id, unitVector(0));
    storage.upsertVector(far.id, unitVector(200)); // 直交（cos=0）

    const results = storage.searchVectorsByCategory(
      unitVector(0),
      "dont",
      cosineSimThreshold(0.5),
      10,
    );
    const ids = results.map((r) => r.id);
    expect(ids).toContain(near.id);
    expect(ids).not.toContain(far.id);
  });
});
