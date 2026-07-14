import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SQLiteStorage } from "../storage/sqlite.js";
import { applyMergeWithLineage, recordSupersedes } from "./lineage.js";

function unitVector(idx: number): number[] {
  const vec = new Array(384).fill(0);
  vec[idx] = 1.0;
  return vec;
}

describe("applyMergeWithLineage（系譜つき追記型マージの合成層）", () => {
  let storage: SQLiteStorage;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-lineage-test-"));
    storage = new SQLiteStorage(join(tmpDir, "test.db"));
    storage.initialize();
  });

  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("統合結果に埋め込みが付与され、原本は deleted・merged_from 系譜が付く", () => {
    const a = storage.save({ category: "dont", title: "A", content: "A", project: "p" });
    const b = storage.save({ category: "dont", title: "B", content: "B", project: "p" });
    storage.upsertVector(a.id, unitVector(0));
    storage.upsertVector(b.id, unitVector(0));

    const { mergedId, absorbedIds } = applyMergeWithLineage(storage, {
      merged: { category: "dont", title: "統合", content: "統合", project: "p" },
      sourceIds: [a.id, b.id],
      embedding: unitVector(0),
    });

    expect(storage.getEmbedding(mergedId)).not.toBeNull();
    expect(absorbedIds.sort()).toEqual([a.id, b.id].sort());
    expect(storage.getMergeParents(mergedId).sort()).toEqual([a.id, b.id].sort());
  });

  it("recordSupersedes で複数の旧版から新版を引ける", () => {
    const o1 = storage.save({ category: "dont", title: "旧1", content: "旧1", project: "p" });
    const o2 = storage.save({ category: "dont", title: "旧2", content: "旧2", project: "p" });
    const n = storage.save({ category: "dont", title: "新", content: "新", project: "p" });

    recordSupersedes(storage, n.id, [o1.id, o2.id]);

    expect(storage.getSupersededBy(o1.id)).toBe(n.id);
    expect(storage.getSupersededBy(o2.id)).toBe(n.id);
  });
});
