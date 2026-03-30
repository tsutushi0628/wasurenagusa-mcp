import { describe, it, expect, vi, beforeEach } from "vitest";
import { retagEntries } from "./retag-worker.js";

const mockVectorSearch = vi.fn();
const mockGetEntryMetadata = vi.fn();
vi.mock("../vector/vector-store.js", () => {
  class MockVectorStore {
    constructor(_memoryPath: string) {}
    search = mockVectorSearch;
    getEntryMetadata = mockGetEntryMetadata;
  }
  return { VectorStore: MockVectorStore };
});

const mockEnrich = vi.fn();
vi.mock("../vector/tag-enricher.js", () => {
  class MockTagEnricher {
    constructor(_apiKey: string) {}
    enrich = mockEnrich;
  }
  return { TagEnricher: MockTagEnricher };
});

const mockEmbed = vi.fn();
vi.mock("../vector/embedding-service.js", () => {
  class MockEmbeddingService {
    constructor(_apiKey: string) {}
    embed = mockEmbed;
    isAvailable = vi.fn().mockReturnValue(true);
  }
  return { EmbeddingService: MockEmbeddingService };
});

const mockStorageGetDetail = vi.fn();
const mockStorageSave = vi.fn();
vi.mock("../storage/index.js", () => {
  class MockMarkdownStorage {
    constructor(_projectRoot: string) {}
    getDetail = mockStorageGetDetail;
    save = mockStorageSave;
  }
  return { MarkdownStorage: MockMarkdownStorage };
});

vi.mock("../config.js", () => ({
  config: { geminiApiKey: "test-key" },
  getMemoryPath: vi.fn().mockReturnValue("/tmp/test-memory"),
}));

vi.mock("../vector/memory-tier.js", () => ({
  TIER_THRESHOLDS: { medium: 0.6 },
}));

describe("RetagWorker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEmbed.mockResolvedValue([0.1, 0.2, 0.3]);
    mockStorageSave.mockResolvedValue({ success: true, id: "test", path: "/tmp/test.md", message: "saved" });
  });

  it("searches past entries by new theme vector", async () => {
    mockVectorSearch.mockResolvedValueOnce([
      { id: "past-1", distance: 0.2, accessCount: 1 },
    ]);
    mockStorageGetDetail.mockResolvedValueOnce({
      entries: [
        { id: "past-1", timestamp: "2024-01-01", category: "config", title: "test", content: "test content", tags: ["old-tag:0.5"], project: "test" },
      ],
      notFound: [],
    });
    mockEnrich.mockResolvedValueOnce({
      tags: [{ tag: "new-theme", weight: 0.8 }, { tag: "old-tag", weight: 0.6 }],
      newThemes: [],
    });

    await retagEntries(["new-theme"], "/tmp/project");

    expect(mockVectorSearch).toHaveBeenCalledTimes(1);
    expect(mockEnrich).toHaveBeenCalledTimes(1);
  });

  it("limits to 20 entries per run", async () => {
    // Return 25 results from vector search
    const results = Array.from({ length: 25 }, (_, i) => ({
      id: `entry-${i}`,
      distance: 0.1 + i * 0.01,
      accessCount: 0,
    }));
    mockVectorSearch.mockResolvedValueOnce(results);

    const entries = Array.from({ length: 25 }, (_, i) => ({
      id: `entry-${i}`,
      timestamp: "2024-01-01",
      category: "config" as const,
      title: `test ${i}`,
      content: `content ${i}`,
      tags: [],
      project: "test",
    }));
    mockStorageGetDetail.mockResolvedValueOnce({ entries: entries.slice(0, 20), notFound: [] });

    mockEnrich.mockResolvedValue({
      tags: [{ tag: "new", weight: 0.8 }],
      newThemes: [],
    });

    await retagEntries(["theme"], "/tmp/project");

    // Should only process 20 entries max
    expect(mockEnrich.mock.calls.length).toBeLessThanOrEqual(20);
  });

  it("merges tags with max weight for same tag name", async () => {
    mockVectorSearch.mockResolvedValueOnce([
      { id: "entry-1", distance: 0.2, accessCount: 0 },
    ]);
    mockStorageGetDetail.mockResolvedValueOnce({
      entries: [
        { id: "entry-1", timestamp: "2024-01-01", category: "config", title: "test", content: "content", tags: ["shared-tag:0.5", "old-only:0.3"], project: "test" },
      ],
      notFound: [],
    });
    mockEnrich.mockResolvedValueOnce({
      tags: [
        { tag: "shared-tag", weight: 0.9 },  // higher than existing 0.5
        { tag: "new-tag", weight: 0.7 },
      ],
      newThemes: [],
    });

    await retagEntries(["theme"], "/tmp/project");

    expect(mockStorageSave).toHaveBeenCalledTimes(1);
    const savedParams = mockStorageSave.mock.calls[0][0];
    // shared-tag should have max(0.5, 0.9) = 0.9
    expect(savedParams.tags).toContain("shared-tag:0.9");
    // old-only should be preserved
    expect(savedParams.tags).toContain("old-only:0.3");
    // new-tag should be added
    expect(savedParams.tags).toContain("new-tag:0.7");
  });

  it("does not modify entries on enrichment failure", async () => {
    mockVectorSearch.mockResolvedValueOnce([
      { id: "entry-1", distance: 0.2, accessCount: 0 },
    ]);
    mockStorageGetDetail.mockResolvedValueOnce({
      entries: [
        { id: "entry-1", timestamp: "2024-01-01", category: "config", title: "test", content: "content", tags: ["original:0.5"], project: "test" },
      ],
      notFound: [],
    });
    mockEnrich.mockRejectedValueOnce(new Error("API error"));

    await retagEntries(["theme"], "/tmp/project");

    // Should not save when enrichment fails
    expect(mockStorageSave).not.toHaveBeenCalled();
  });
});
