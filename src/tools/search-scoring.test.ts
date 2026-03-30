import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocks
const mockStorageSearch = vi.fn();
const mockStorageGetDetail = vi.fn();
vi.mock("../storage/index.js", () => {
  class MockMarkdownStorage {
    constructor(_projectRoot: string) {}
    search = mockStorageSearch;
    getDetail = mockStorageGetDetail;
    save = vi.fn().mockResolvedValue({});
  }
  return { MarkdownStorage: MockMarkdownStorage };
});

const mockEmbed = vi.fn();
const mockEmbedIsAvailable = vi.fn();
vi.mock("../vector/embedding-service.js", () => {
  class MockEmbeddingService {
    constructor(_apiKey: string) {}
    embed = mockEmbed;
    isAvailable = mockEmbedIsAvailable;
  }
  return { EmbeddingService: MockEmbeddingService };
});

const mockVectorSearch = vi.fn();
const mockIncrementAccessCount = vi.fn();
const mockGetEntryMetadata = vi.fn();
vi.mock("../vector/vector-store.js", () => {
  class MockVectorStore {
    constructor(_memoryPath: string) {}
    search = mockVectorSearch;
    incrementAccessCount = mockIncrementAccessCount;
    getEntryMetadata = mockGetEntryMetadata;
  }
  return { VectorStore: MockVectorStore };
});

vi.mock("../vector/memory-tier.js", () => ({
  TIER_THRESHOLDS: { critical: 0.3, medium: 0.6, archive: 0.9 },
  shouldPromoteToCritical: vi.fn().mockReturnValue(false),
}));

vi.mock("../config.js", () => ({
  config: { geminiApiKey: "test-key" },
  getMemoryPath: vi.fn().mockReturnValue("/tmp/test-memory"),
}));

import { handleMemorySearch } from "./search.js";

describe("search.ts scoring integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEmbedIsAvailable.mockReturnValue(true);
    mockEmbed.mockResolvedValue([0.1, 0.2, 0.3]);
    mockIncrementAccessCount.mockResolvedValue(undefined);
    mockStorageGetDetail.mockResolvedValue({ entries: [], notFound: [] });
  });

  it("sorts results by composite score (not just timestamp)", async () => {
    // Keyword search returns 2 entries
    mockStorageSearch.mockResolvedValueOnce({
      results: [
        { id: "old-high-relevance", timestamp: "2024-01-01T00:00:00+09:00", category: "config", title: "rate-limit設定", tags: ["rate-limit:0.9", "API:0.3"], project: "test" },
        { id: "recent-low-relevance", timestamp: "2024-06-01T00:00:00+09:00", category: "config", title: "一般設定", tags: ["設定:0.2"], project: "test" },
      ],
      totalCount: 2,
      hint: "",
    });

    // Vector search returns same IDs with different distances
    mockVectorSearch.mockResolvedValueOnce([
      { id: "old-high-relevance", distance: 0.1, accessCount: 5 },   // very similar
      { id: "recent-low-relevance", distance: 0.5, accessCount: 0 }, // less similar
    ]);

    // Metadata for freshness calculation
    mockGetEntryMetadata.mockResolvedValueOnce(new Map([
      ["old-high-relevance", { lastAccessedAt: "2024-01-01T00:00:00+09:00", accessCount: 5 }],
      ["recent-low-relevance", { lastAccessedAt: "2024-06-01T00:00:00+09:00", accessCount: 0 }],
    ]));

    const resultJson = await handleMemorySearch({ query: "rate-limit" }, "/tmp/project");
    const result = JSON.parse(resultJson);

    // Old but highly relevant entry should rank above recent low-relevance entry
    // due to vector similarity and tag weight boost
    expect(result.results[0].id).toBe("old-high-relevance");
  });

  it("vector-only hits use tagWeightScore=1.0 (no penalty)", async () => {
    mockStorageSearch.mockResolvedValueOnce({
      results: [],
      totalCount: 0,
      hint: "",
    });

    mockVectorSearch.mockResolvedValueOnce([
      { id: "vector-only-hit", distance: 0.2, accessCount: 0 },
    ]);

    mockStorageGetDetail.mockResolvedValueOnce({
      entries: [
        { id: "vector-only-hit", timestamp: "2024-06-01T00:00:00+09:00", category: "config", title: "テスト", tags: [], content: "test", project: "test" },
      ],
      notFound: [],
    });

    mockGetEntryMetadata.mockResolvedValueOnce(new Map([
      ["vector-only-hit", { lastAccessedAt: new Date().toISOString(), accessCount: 0 }],
    ]));

    const resultJson = await handleMemorySearch({ query: "テスト" }, "/tmp/project");
    const result = JSON.parse(resultJson);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].id).toBe("vector-only-hit");
  });
});
