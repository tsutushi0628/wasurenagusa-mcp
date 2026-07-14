import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SQLiteStorage } from "./sqlite.js";

// 追記型マージ（Phase 3 / R-A6・タスク3.7）と supersedes 系譜（タスク3.8）の業務要件検証。
// 検証観点は「原本を壊さず（本文UPDATE・物理DELETEなし）、統合結果を新レコードとして追記し、
// 100% に merged_from 系譜が付き、吸収された原本は deleted へ遷移し索引行が同一Txで除去される」。

function unitVector(idx: number): number[] {
  const vec = new Array(384).fill(0);
  vec[idx] = 1.0;
  return vec;
}

describe("applyAppendOnlyMerge（追記型マージ・非破壊）", () => {
  let storage: SQLiteStorage;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-merge-test-"));
    storage = new SQLiteStorage(join(tmpDir, "test.db"));
    storage.initialize();
  });

  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("マージ結果が新レコードとして追加される（新規 id・active）", () => {
    const a = storage.save({ category: "dont", title: "A", content: "原本A", project: "p" });
    const b = storage.save({ category: "dont", title: "B", content: "原本B", project: "p" });
    storage.upsertVector(a.id, unitVector(0));
    storage.upsertVector(b.id, unitVector(0));

    const { mergedId } = storage.applyAppendOnlyMerge({
      merged: { category: "dont", title: "統合", content: "統合された教訓", project: "p" },
      sourceIds: [a.id, b.id],
    });

    expect(mergedId).not.toBe(a.id);
    expect(mergedId).not.toBe(b.id);
    const detail = storage.getDetail({ ids: [mergedId] });
    expect(detail.entries).toHaveLength(1);
    expect(detail.entries[0].content).toBe("統合された教訓");
  });

  it("原本の本文が変更も物理削除もされない（deleted でも本文は原型のまま行が残る）", () => {
    const a = storage.save({ category: "dont", title: "A", content: "原本A本文", project: "p" });
    storage.upsertVector(a.id, unitVector(0));

    storage.applyAppendOnlyMerge({
      merged: { category: "dont", title: "統合", content: "統合本文", project: "p" },
      sourceIds: [a.id],
    });

    // 物理行は残っている（DELETE FROM memories していない）＝生SQLで直接確認。
    const row = storage.connection
      .prepare("SELECT content, state FROM memories WHERE id = ?")
      .get(a.id) as { content: string; state: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.content).toBe("原本A本文"); // 本文は書き換えられていない
    expect(row!.state).toBe("deleted"); // 論理遷移のみ
  });

  it("マージ結果の 100% に merged_from 系譜が付く", () => {
    const a = storage.save({ category: "dont", title: "A", content: "A", project: "p" });
    const b = storage.save({ category: "dont", title: "B", content: "B", project: "p" });
    const c = storage.save({ category: "dont", title: "C", content: "C", project: "p" });

    const { mergedId } = storage.applyAppendOnlyMerge({
      merged: { category: "dont", title: "統合", content: "統合", project: "p" },
      sourceIds: [a.id, b.id, c.id],
    });

    const parents = storage.getMergeParents(mergedId);
    expect(parents.sort()).toEqual([a.id, b.id, c.id].sort());
  });

  it("吸収された原本は deleted へ遷移し、索引行が同一トランザクションで除去される", () => {
    const a = storage.save({ category: "dont", title: "A", content: "A", project: "p" });
    storage.upsertVector(a.id, unitVector(0));
    // 索引行が存在することを確認
    expect(storage.getEmbedding(a.id)).not.toBeNull();

    const { absorbedIds } = storage.applyAppendOnlyMerge({
      merged: { category: "dont", title: "統合", content: "統合", project: "p" },
      sourceIds: [a.id],
    });

    expect(absorbedIds).toContain(a.id);
    // vectors / vector_metadata から除去済み（I2維持）
    expect(storage.getEmbedding(a.id)).toBeNull();
    const meta = storage.connection
      .prepare("SELECT COUNT(*) AS c FROM vector_metadata WHERE id = ?")
      .get(a.id) as { c: number };
    expect(meta.c).toBe(0);
  });
});

describe("supersedes 系譜（タスク3.8）", () => {
  let storage: SQLiteStorage;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-supersede-test-"));
    storage = new SQLiteStorage(join(tmpDir, "test.db"));
    storage.initialize();
  });

  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("supersedes を記録すると、旧版から新版を引ける（原本本文は不変）", () => {
    const oldM = storage.save({ category: "dont", title: "旧", content: "旧見解", project: "p" });
    const newM = storage.save({ category: "dont", title: "新", content: "新見解", project: "p" });

    storage.insertSupersedes(newM.id, oldM.id);

    expect(storage.getSupersededBy(oldM.id)).toBe(newM.id);
    // 原本は変更されない
    const row = storage.connection
      .prepare("SELECT content, state FROM memories WHERE id = ?")
      .get(oldM.id) as { content: string; state: string };
    expect(row.content).toBe("旧見解");
    expect(row.state).toBe("active");
  });

  it("supersede されていない記憶では null を返す", () => {
    const m = storage.save({ category: "dont", title: "x", content: "x", project: "p" });
    expect(storage.getSupersededBy(m.id)).toBeNull();
  });
});
