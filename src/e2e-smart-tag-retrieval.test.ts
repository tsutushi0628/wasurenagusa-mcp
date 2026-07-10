import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Gemini API
const mockGenerateContent = vi.fn();
const mockGetGenerativeModel = vi.fn(() => ({
  generateContent: mockGenerateContent,
  embedContent: vi.fn().mockResolvedValue({
    embedding: { values: Array.from({ length: 768 }, () => Math.random()) },
  }),
}));

vi.mock("@google/generative-ai", () => {
  class MockGoogleGenerativeAI {
    constructor(_apiKey: string) {}
    getGenerativeModel = mockGetGenerativeModel;
  }
  return {
    GoogleGenerativeAI: MockGoogleGenerativeAI,
    TaskType: { RETRIEVAL_DOCUMENT: "RETRIEVAL_DOCUMENT" },
  };
});

vi.mock("./analyzer/prompt-loader.js", () => ({
  loadPrompt: vi.fn().mockResolvedValue("mock prompt {{title}} {{content}} {{existingTags}}"),
}));

// Mock child_process spawn (for retag-worker)
vi.mock("child_process", () => ({
  spawn: vi.fn().mockReturnValue({ unref: vi.fn() }),
}));

import { mkdtemp, rm, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { MarkdownStorage } from "./storage/index.js";
import { SearchScorer } from "./vector/search-scorer.js";
import { parseWeightedTags } from "./vector/weighted-tag.js";

describe("E2E: Smart Tag Retrieval", () => {
  let tempDir: string;
  let storage: MarkdownStorage;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "e2e-smart-tag-"));
    await mkdir(join(tempDir, ".wasurenagusa"), { recursive: true });
    storage = new MarkdownStorage(tempDir);
  });

  // design.md Phase2定義4（二重減衰の禁止）により、recencyの反映元は
  // sqlite.ts側のtime-decay（finalScore = rrfScore × 0.5^(ageDays/H)）ただ一つに
  // 一本化された。SearchScorer.score()自体はdaysSinceLastAccessで差を付けない
  // （search-scorer.test.tsの「freshness項は除去済み」で単体保証済み、
  // sqlite-search-relevance.test.tsの時間減衰統合テストで実経路の再順位付けを保証済み）。
  it("SearchScorer単体はdaysSinceLastAccessで差を付けない（recencyはsqlite.ts側time-decayに一本化済み）", () => {
    const oldScore = SearchScorer.score({
      vectorSimilarity: 0.9,
      matchedTagWeights: [0.8],
      daysSinceLastAccess: 30,
      accessCount: 0,
    });

    const recentScore = SearchScorer.score({
      vectorSimilarity: 0.9,
      matchedTagWeights: [0.8],
      daysSinceLastAccess: 1,
      accessCount: 0,
    });

    expect(recentScore).toBe(oldScore);
  });

  it("access frequency causes re-surfacing", () => {
    // Same entry, before and after multiple accesses
    const beforeAccess = SearchScorer.score({
      vectorSimilarity: 0.8,
      matchedTagWeights: [0.7],
      daysSinceLastAccess: 10,
      accessCount: 0,
    });

    const afterAccess = SearchScorer.score({
      vectorSimilarity: 0.8,
      matchedTagWeights: [0.7],
      daysSinceLastAccess: 0, // just accessed
      accessCount: 5,         // frequent access
    });

    expect(afterAccess).toBeGreaterThan(beforeAccess);
  });

  it("tag weight affects ranking", () => {
    const highWeightScore = SearchScorer.score({
      vectorSimilarity: 0.8,
      matchedTagWeights: [0.9, 0.8],
      daysSinceLastAccess: 5,
      accessCount: 0,
    });

    const lowWeightScore = SearchScorer.score({
      vectorSimilarity: 0.8,
      matchedTagWeights: [0.2, 0.1],
      daysSinceLastAccess: 5,
      accessCount: 0,
    });

    expect(highWeightScore).toBeGreaterThan(lowWeightScore);
  });

  it("weighted tags are preserved through save and parse cycle", async () => {
    // Save an entry with weighted tags
    const result = await storage.save({
      category: "config",
      title: "rate-limit設定",
      content: "GeminiのAPIレート制限は1000RPM",
      tags: ["rate-limit:0.9", "Gemini:0.3", "1000RPM:1.0"],
      project: "test",
    });

    expect(result.success).toBe(true);

    // Retrieve it
    const detail = await storage.getDetail({ ids: [result.id] });
    expect(detail.entries).toHaveLength(1);

    // Parse the stored tags
    const weightedTags = parseWeightedTags(detail.entries[0].tags);
    expect(weightedTags).toContainEqual({ tag: "rate-limit", weight: 0.9 });
    expect(weightedTags).toContainEqual({ tag: "Gemini", weight: 0.3 });
    expect(weightedTags).toContainEqual({ tag: "1000RPM", weight: 1.0 });
  });

  it("old but highly relevant beats recent but irrelevant", () => {
    // Old entry with very high relevance
    const oldRelevant = SearchScorer.score({
      vectorSimilarity: 0.98,
      matchedTagWeights: [1.0, 0.9, 0.8],
      daysSinceLastAccess: 60,
      accessCount: 0,
    });

    // Recent entry with low relevance
    const recentIrrelevant = SearchScorer.score({
      vectorSimilarity: 0.3,
      matchedTagWeights: [],
      daysSinceLastAccess: 1,
      accessCount: 0,
    });

    expect(oldRelevant).toBeGreaterThan(recentIrrelevant);
  });
});
