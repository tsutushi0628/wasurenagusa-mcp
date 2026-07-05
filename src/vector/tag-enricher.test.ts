import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGenerateContent = vi.fn();
const mockGetGenerativeModel = vi.fn(() => ({
  generateContent: mockGenerateContent,
}));

vi.mock("@google/generative-ai", () => {
  class MockGoogleGenerativeAI {
    constructor(_apiKey: string) {}
    getGenerativeModel = mockGetGenerativeModel;
  }
  return {
    GoogleGenerativeAI: MockGoogleGenerativeAI,
  };
});

vi.mock("../analyzer/prompt-loader.js", () => ({
  loadPrompt: vi.fn().mockResolvedValue("mock prompt {{title}} {{content}} {{existingTags}}"),
}));

import { TagEnricher, TAG_MODEL } from "./tag-enricher.js";
import { DEFAULT_MODELS } from "../llm/provider.js";

describe("TagEnricher", () => {
  it("TAG_MODEL is aligned with the repo-standard Gemini default (drift detection)", () => {
    // provider.ts 側だけ世代更新されて tag-enricher が旧世代のまま取り残される
    // ドリフトを検知する（実行時のimport結合はせず、定数一致だけを検証する）。
    expect(TAG_MODEL).toBe(DEFAULT_MODELS.gemini);
  });
  let enricher: TagEnricher;

  beforeEach(() => {
    vi.clearAllMocks();
    enricher = new TagEnricher("test-api-key");
  });

  it("isAvailable returns true with API key", () => {
    expect(enricher.isAvailable()).toBe(true);
  });

  it("isAvailable returns false without API key", () => {
    const noKey = new TagEnricher("");
    expect(noKey.isAvailable()).toBe(false);
  });

  it("returns enriched tags with weights from Gemini response", async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => JSON.stringify([
          { tag: "rate-limit", weight: 0.9 },
          { tag: "Gemini", weight: 0.3 },
          { tag: "API制限", weight: 0.8 },
          { tag: "1000RPM", weight: 1.0 },
          { tag: "クォータ", weight: 0.7 },
          { tag: "スロットリング", weight: 0.6 },
          { tag: "エラーハンドリング", weight: 0.5 },
        ]),
      },
    });

    const result = await enricher.enrich("rate-limit対策", "GeminiのAPIレート制限", ["Gemini", "API"], []);
    expect(result.tags).toHaveLength(7);
    expect(result.tags[0]).toEqual({ tag: "rate-limit", weight: 0.9 });
    for (const wt of result.tags) {
      expect(wt.weight).toBeGreaterThanOrEqual(0.0);
      expect(wt.weight).toBeLessThanOrEqual(1.0);
    }
  });

  it("returns newThemes for tags with weight >= 0.5 not in existing themes", async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => JSON.stringify([
          { tag: "rate-limit", weight: 0.9 },
          { tag: "Gemini", weight: 0.3 },
          { tag: "スロットリング", weight: 0.6 },
        ]),
      },
    });

    const existingThemes = ["Gemini"];
    const result = await enricher.enrich("テスト", "テスト内容", [], existingThemes);
    expect(result.newThemes).toContain("rate-limit");
    expect(result.newThemes).toContain("スロットリング");
    expect(result.newThemes).not.toContain("Gemini");
  });

  it("does not include existing themes in newThemes", async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => JSON.stringify([
          { tag: "rate-limit", weight: 0.9 },
        ]),
      },
    });

    const existingThemes = ["rate-limit"];
    const result = await enricher.enrich("テスト", "テスト内容", [], existingThemes);
    expect(result.newThemes).toEqual([]);
  });

  it("falls back to original tags with weight 1.0 on Gemini API error", async () => {
    mockGenerateContent.mockRejectedValueOnce(new Error("API Error"));

    const result = await enricher.enrich("テスト", "テスト内容", ["tag1", "tag2"], []);
    expect(result.tags).toEqual([
      { tag: "tag1", weight: 1.0 },
      { tag: "tag2", weight: 1.0 },
    ]);
    expect(result.newThemes).toEqual([]);
  });

  it("falls back on invalid JSON response", async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => "not valid json",
      },
    });

    const result = await enricher.enrich("テスト", "テスト内容", ["original"], []);
    expect(result.tags).toEqual([{ tag: "original", weight: 1.0 }]);
    expect(result.newThemes).toEqual([]);
  });

  it("clamps weights outside [0, 1] range", async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => JSON.stringify([
          { tag: "over", weight: 1.5 },
          { tag: "under", weight: -0.3 },
          { tag: "normal", weight: 0.7 },
        ]),
      },
    });

    const result = await enricher.enrich("テスト", "テスト内容", [], []);
    expect(result.tags).toEqual([
      { tag: "over", weight: 1.0 },
      { tag: "under", weight: 0.0 },
      { tag: "normal", weight: 0.7 },
    ]);
  });
});
