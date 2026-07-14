import { describe, it, expect } from "vitest";
import { guardMergeOutput, parseLlmJson } from "./output-guard.js";

// タスク3.10: LLM出力の業務整合性ガード（warning設計）の業務要件検証。
// 「捏造sourceIdsは破棄＋warning」「enum外categoryは破棄＋warning」「throwしない」
// 「JSONパース失敗はバッチスキップ扱い」。

describe("guardMergeOutput（入力差分でLLM出力を検査・throwしない）", () => {
  const inputIds = ["a1", "a2", "a3"];

  it("sourceIds が入力ID集合の部分集合ならそのまま通す（warningなし）", () => {
    const r = guardMergeOutput({ sourceIds: ["a1", "a2"] }, inputIds);
    expect(r.warnings).toHaveLength(0);
    expect(r.sanitized.sourceIds).toEqual(["a1", "a2"]);
  });

  it("入力に無い捏造IDを含む sourceIds は丸ごと破棄し warning を残す（throwしない）", () => {
    const r = guardMergeOutput({ sourceIds: ["a1", "zzz"] }, inputIds);
    expect(r.sanitized.sourceIds).toBeUndefined();
    expect(r.warnings.some((w) => w.field === "sourceIds")).toBe(true);
  });

  it("sourceIds が配列でない場合も破棄し warning を残す", () => {
    const r = guardMergeOutput({ sourceIds: "a1" }, inputIds);
    expect(r.sanitized.sourceIds).toBeUndefined();
    expect(r.warnings.some((w) => w.field === "sourceIds")).toBe(true);
  });

  it("category が enum 外なら破棄し warning を残す", () => {
    const r = guardMergeOutput({ category: "bogus" }, inputIds);
    expect(r.sanitized.category).toBeUndefined();
    expect(r.warnings.some((w) => w.field === "category")).toBe(true);
  });

  it("category が enum 内ならそのまま通す", () => {
    const r = guardMergeOutput({ category: "dont" }, inputIds);
    expect(r.sanitized.category).toBe("dont");
    expect(r.warnings).toHaveLength(0);
  });

  it("不正入力でも throw しない（warning設計）", () => {
    expect(() => guardMergeOutput({ sourceIds: 123, category: {} }, inputIds)).not.toThrow();
  });
});

describe("parseLlmJson（JSONパース失敗はバッチスキップ扱い・throwしない）", () => {
  it("正常なJSONオブジェクトは ok=true", () => {
    const r = parseLlmJson('{"sourceIds":["a1"]}');
    expect(r.ok).toBe(true);
    expect(r.skip).toBe(false);
    expect(r.value?.sourceIds).toEqual(["a1"]);
  });

  it("壊れたJSONは throwせず skip=true", () => {
    const r = parseLlmJson("{not json");
    expect(r.ok).toBe(false);
    expect(r.skip).toBe(true);
  });

  it("配列やnullなどオブジェクトでない値は skip=true", () => {
    expect(parseLlmJson("[1,2,3]").skip).toBe(true);
    expect(parseLlmJson("null").skip).toBe(true);
  });
});
