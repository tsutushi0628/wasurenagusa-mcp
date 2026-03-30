import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocks for getDetail
const mockStorageGetDetail = vi.fn();
vi.mock("../storage/index.js", () => {
  class MockMarkdownStorage {
    constructor(_projectRoot: string) {}
    getDetail = mockStorageGetDetail;
  }
  return { MarkdownStorage: MockMarkdownStorage };
});

const mockIncrementAccessCount = vi.fn();
vi.mock("../vector/vector-store.js", () => {
  class MockVectorStore {
    constructor(_memoryPath: string) {}
    incrementAccessCount = mockIncrementAccessCount;
  }
  return { VectorStore: MockVectorStore };
});

vi.mock("../config.js", () => ({
  config: { geminiApiKey: "test-key" },
  getMemoryPath: vi.fn().mockReturnValue("/tmp/test-memory"),
}));

import { handleMemoryGetDetail } from "../tools/getDetail.js";

describe("access tracking on getDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIncrementAccessCount.mockResolvedValue(undefined);
  });

  it("updates lastAccessedAt when entries are found", async () => {
    mockStorageGetDetail.mockResolvedValueOnce({
      entries: [
        { id: "entry-1", timestamp: "2024-01-01", category: "config", title: "test", content: "test", tags: [] },
      ],
      notFound: [],
    });

    await handleMemoryGetDetail({ ids: ["entry-1"] }, "/tmp/project");

    expect(mockIncrementAccessCount).toHaveBeenCalledWith(["entry-1"]);
  });

  it("only updates found entries, not missing ones", async () => {
    mockStorageGetDetail.mockResolvedValueOnce({
      entries: [
        { id: "entry-1", timestamp: "2024-01-01", category: "config", title: "test", content: "test", tags: [] },
      ],
      notFound: ["entry-missing"],
    });

    await handleMemoryGetDetail({ ids: ["entry-1", "entry-missing"] }, "/tmp/project");

    expect(mockIncrementAccessCount).toHaveBeenCalledWith(["entry-1"]);
  });

  it("does not call incrementAccessCount when no entries found", async () => {
    mockStorageGetDetail.mockResolvedValueOnce({
      entries: [],
      notFound: ["entry-missing"],
    });

    await handleMemoryGetDetail({ ids: ["entry-missing"] }, "/tmp/project");

    expect(mockIncrementAccessCount).not.toHaveBeenCalled();
  });

  it("does not break getDetail if incrementAccessCount fails", async () => {
    mockStorageGetDetail.mockResolvedValueOnce({
      entries: [
        { id: "entry-1", timestamp: "2024-01-01", category: "config", title: "test", content: "test", tags: [] },
      ],
      notFound: [],
    });
    mockIncrementAccessCount.mockRejectedValueOnce(new Error("vector store error"));

    const resultJson = await handleMemoryGetDetail({ ids: ["entry-1"] }, "/tmp/project");
    const result = JSON.parse(resultJson);

    // getDetail should still succeed
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].id).toBe("entry-1");
  });
});
