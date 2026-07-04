import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocks
const mockStorageSearch = vi.fn();
const mockStorageSearchHybrid = vi.fn();
const mockStorageSearchVectors = vi.fn();
const mockStorageIncrementAccessCount = vi.fn();
const mockStorageGetVectorMetadata = vi.fn();
const mockStorageGetDetail = vi.fn();
const mockStorageSave = vi.fn();
const mockStorageInitialize = vi.fn();
const mockStorageClose = vi.fn();
vi.mock("../storage/sqlite.js", () => {
  class MockSQLiteStorage {
    constructor(_dbPath: string) {}
    initialize = mockStorageInitialize;
    search = mockStorageSearch;
    searchHybrid = mockStorageSearchHybrid;
    searchVectors = mockStorageSearchVectors;
    incrementAccessCount = mockStorageIncrementAccessCount;
    getVectorMetadata = mockStorageGetVectorMetadata;
    getDetail = mockStorageGetDetail;
    save = mockStorageSave;
    close = mockStorageClose;
  }
  return { SQLiteStorage: MockSQLiteStorage };
});

const mockEmbed = vi.fn();
const mockEmbedIsAvailable = vi.fn();
const mockEmbedInitialize = vi.fn();
vi.mock("../vector/local-embedding.js", () => {
  class MockLocalEmbedding {
    constructor(_modelDir: string) {}
    initialize = mockEmbedInitialize;
    embed = mockEmbed;
    isAvailable = mockEmbedIsAvailable;
  }
  return { LocalEmbedding: MockLocalEmbedding };
});

vi.mock("../vector/memory-tier.js", () => ({
  TIER_THRESHOLDS: { critical: 0.3, medium: 0.6, archive: 0.9 },
  shouldPromoteToCritical: vi.fn().mockReturnValue(false),
}));

vi.mock("../config.js", () => ({
  config: { geminiApiKey: "test-key", sqliteFile: "memory.db", modelsDir: "models" },
  getMemoryPath: vi.fn().mockReturnValue("/tmp/test-memory"),
}));

import { handleMemorySearch } from "./search.js";

describe("search.ts scoring integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEmbedInitialize.mockResolvedValue(undefined);
    mockEmbedIsAvailable.mockReturnValue(true);
    mockEmbed.mockResolvedValue([0.1, 0.2, 0.3]);
    mockStorageIncrementAccessCount.mockReturnValue(undefined);
    mockStorageGetDetail.mockReturnValue({ entries: [], notFound: [] });
  });

  it("sorts results by composite score (not just timestamp)", async () => {
    // searchHybrid returns merged FTS5 + vector results
    mockStorageSearchHybrid.mockReturnValue({
      results: [
        { id: "old-high-relevance", timestamp: "2024-01-01T00:00:00+09:00", category: "config", title: "rate-limit設定", tags: ["rate-limit:0.9", "API:0.3"], project: "test" },
        { id: "recent-low-relevance", timestamp: "2024-06-01T00:00:00+09:00", category: "config", title: "一般設定", tags: ["設定:0.2"], project: "test" },
      ],
      totalCount: 2,
      hint: "",
    });

    // Vector search returns same IDs with different distances
    mockStorageSearchVectors.mockReturnValue([
      { id: "old-high-relevance", distance: 0.1, accessCount: 5 },   // very similar
      { id: "recent-low-relevance", distance: 0.5, accessCount: 0 }, // less similar
    ]);

    // Metadata for freshness calculation
    mockStorageGetVectorMetadata.mockReturnValue(new Map([
      ["old-high-relevance", { lastAccessedAt: "2024-01-01T00:00:00+09:00", accessCount: 5 }],
      ["recent-low-relevance", { lastAccessedAt: "2024-06-01T00:00:00+09:00", accessCount: 0 }],
    ]));

    const resultJson = await handleMemorySearch({ query: "rate-limit" }, "/tmp/project");
    const result = JSON.parse(resultJson);

    // Old but highly relevant entry should rank above recent low-relevance entry
    // due to vector similarity and tag weight boost
    expect(result.results[0].id).toBe("old-high-relevance");
  });

  it("vector-only hits are returned via searchHybrid", async () => {
    // In v2, searchHybrid internally merges FTS5 + vector results,
    // so vector-only hits appear in the searchHybrid result directly
    mockStorageSearchHybrid.mockReturnValue({
      results: [
        { id: "vector-only-hit", timestamp: "2024-06-01T00:00:00+09:00", category: "config", title: "テスト", tags: [], project: "test" },
      ],
      totalCount: 1,
      hint: "",
    });

    mockStorageSearchVectors.mockReturnValue([
      { id: "vector-only-hit", distance: 0.2, accessCount: 0 },
    ]);

    mockStorageGetVectorMetadata.mockReturnValue(new Map([
      ["vector-only-hit", { lastAccessedAt: new Date().toISOString(), accessCount: 0 }],
    ]));

    const resultJson = await handleMemorySearch({ query: "テスト" }, "/tmp/project");
    const result = JSON.parse(resultJson);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].id).toBe("vector-only-hit");
  });

  it("検索クエリは query 用途で埋め込む（e5系の非対称プレフィックス: クエリ側）", async () => {
    mockStorageSearchHybrid.mockReturnValue({ results: [], totalCount: 0, hint: "" });
    mockStorageSearchVectors.mockReturnValue([]);

    await handleMemorySearch({ query: "本番APIのURLはどこ？" }, "/tmp/project");

    expect(mockEmbed).toHaveBeenCalledWith("本番APIのURLはどこ？", "query");
  });
});
