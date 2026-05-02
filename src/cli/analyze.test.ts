import { describe, it, expect } from "vitest";
import { buildSaveParamsFromAnalysis } from "./analyze.js";
import type { AnalysisResult } from "../types.js";

/**
 * heart-extension B0c: analyze.ts が AnalysisResult.knowledgeGap を
 * SaveParams.knowledgeGap に引き渡すことを保証する。
 */
describe("analyze: buildSaveParamsFromAnalysis (B0c)", () => {
  function makeAnalysis(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
    return {
      shouldSave: true,
      category: "dont",
      title: "test title",
      summary: "test summary",
      tags: ["t1"],
      reason: "test reason",
      scope: "backend",
      intensity: 5,
      ...overrides,
    };
  }

  it("analysis.knowledgeGap が SaveParams.knowledgeGap に渡る", () => {
    const analysis = makeAnalysis({
      knowledgeGap: ["Gemini APIのfinishReason種類", "max_tokensの上限値"],
    });

    const saveParams = buildSaveParamsFromAnalysis(analysis, "myproject");

    expect(saveParams.knowledgeGap).toEqual([
      "Gemini APIのfinishReason種類",
      "max_tokensの上限値",
    ]);
  });

  it("knowledgeGap が無い場合は SaveParams.knowledgeGap が undefined", () => {
    const analysis = makeAnalysis({ knowledgeGap: undefined });

    const saveParams = buildSaveParamsFromAnalysis(analysis, "myproject");

    expect(saveParams.knowledgeGap).toBeUndefined();
  });

  it("空配列の knowledgeGap も保持される（空でも保存意図を尊重）", () => {
    const analysis = makeAnalysis({ knowledgeGap: [] });

    const saveParams = buildSaveParamsFromAnalysis(analysis, "myproject");

    expect(saveParams.knowledgeGap).toEqual([]);
  });

  it("category / title / summary / project / replaceId / intensity が正しく転写される", () => {
    const analysis = makeAnalysis({
      category: "dont",
      title: "本番DB禁止",
      summary: "本番DBに直接接続するな",
      tags: ["db", "production"],
      scope: "backend",
      intensity: 5,
      knowledgeGap: ["仕様A"],
    });

    const saveParams = buildSaveParamsFromAnalysis(analysis, "myproject", "old-id-001");

    expect(saveParams.category).toBe("dont");
    expect(saveParams.title).toBe("本番DB禁止");
    expect(saveParams.content).toBe("本番DBに直接接続するな");
    expect(saveParams.tags).toEqual(["db", "production"]);
    expect(saveParams.project).toBe("myproject");
    expect(saveParams.scope).toBe("backend");
    expect(saveParams.intensity).toBe(5);
    expect(saveParams.replaceId).toBe("old-id-001");
    expect(saveParams.knowledgeGap).toEqual(["仕様A"]);
  });

  it("scope が空文字なら undefined に正規化される", () => {
    const analysis = makeAnalysis({ scope: "" });

    const saveParams = buildSaveParamsFromAnalysis(analysis, "myproject");

    expect(saveParams.scope).toBeUndefined();
  });

  it("category/title/summary が欠けている場合は throw する（防御）", () => {
    const noCategory = makeAnalysis({ category: null });
    expect(() => buildSaveParamsFromAnalysis(noCategory, "p")).toThrow();

    const noTitle = makeAnalysis({ title: null });
    expect(() => buildSaveParamsFromAnalysis(noTitle, "p")).toThrow();

    const noSummary = makeAnalysis({ summary: null });
    expect(() => buildSaveParamsFromAnalysis(noSummary, "p")).toThrow();
  });

  /**
   * heart-extension F4: success カテゴリも保存パスを通る（MemoryCategory 拡張で自然に通る前提の確認）
   */
  it("F4: category='success' の AnalysisResult から SaveParams を構築できる", () => {
    const analysis = makeAnalysis({
      category: "success",
      title: "媚び化リスク指摘で同意",
      summary: "S1: 反対意見後の称賛。媚び化リスクを指摘した上で、ユーザーから強い肯定を得た。",
      tags: ["success", "feedback"],
      scope: "ai",
      intensity: undefined, // success では intensity は出力しない
      knowledgeGap: undefined,
    });

    const saveParams = buildSaveParamsFromAnalysis(analysis, "myproject");

    expect(saveParams.category).toBe("success");
    expect(saveParams.title).toBe("媚び化リスク指摘で同意");
    expect(saveParams.intensity).toBeUndefined();
    expect(saveParams.knowledgeGap).toBeUndefined();
  });
});
