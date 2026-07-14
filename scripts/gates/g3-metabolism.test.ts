import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, cpSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  checkAppendOnly,
  checkLineageComplete,
  checkBatchCap,
  checkHumanGate,
  checkDistanceTypes,
} from "./g3-metabolism.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// タスク3.16の検証: 実装状態で構造検査が PASS し、意図的な違反状態（原本更新）で FAIL する。

describe("G3 構造検査（実装状態でPASS）", () => {
  it("append-only は実装状態で PASS", () => {
    expect(checkAppendOnly(REPO_ROOT).result).toBe("PASS");
  });
  it("lineage-complete は PASS", () => {
    expect(checkLineageComplete(REPO_ROOT).result).toBe("PASS");
  });
  it("batch-cap は PASS", () => {
    expect(checkBatchCap(REPO_ROOT).result).toBe("PASS");
  });
  it("human-gate は PASS", () => {
    expect(checkHumanGate(REPO_ROOT).result).toBe("PASS");
  });
  it("distance-types は PASS", () => {
    expect(checkDistanceTypes(REPO_ROOT).result).toBe("PASS");
  });
});

describe("G3 は意図的な違反状態で FAIL する（原本更新の混入）", () => {
  let tmpRepo: string;

  beforeEach(() => {
    tmpRepo = mkdtempSync(join(tmpdir(), "g3-violation-"));
    // 検査に必要な最小ファイル構成を作る
    mkdirSync(join(tmpRepo, "src/storage"), { recursive: true });
    // 原本本文を UPDATE する（append-only 違反）マージメソッドを注入
    const violating = `
  applyAppendOnlyMerge(input: { merged: SaveParams; sourceIds: string[] }) {
    const saved = this.saveInternal(input.merged);
    // 違反: 原本の本文を書き換える
    this.db.prepare("UPDATE memories SET content = ? WHERE id = ?").run("x", "y");
    for (const sid of input.sourceIds) {
      insertLineageStmt.run(this.generateId(), saved.id, sid); // 'merged_from'
    }
    return { mergedId: saved.id };
  }`;
    writeFileSync(join(tmpRepo, "src/storage/sqlite.ts"), violating, "utf-8");
  });

  afterEach(() => {
    rmSync(tmpRepo, { recursive: true, force: true });
  });

  it("原本本文UPDATEを混入させると append-only が FAIL", () => {
    const r = checkAppendOnly(tmpRepo);
    expect(r.result).toBe("FAIL");
    expect((r.measured.violations as string[]).some((v) => v.includes("原本本文のUPDATE"))).toBe(true);
  });
});
