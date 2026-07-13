import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocks for getDetail — getDetail.ts imports SQLiteStorage from ../storage/index.js
const mockStorageGetDetail = vi.fn();
const mockStorageIncrementAccessCount = vi.fn();
const mockStorageMarkLastRead = vi.fn();
const mockStorageInitialize = vi.fn();
const mockStorageClose = vi.fn();
vi.mock("../storage/index.js", () => {
  class MockSQLiteStorage {
    constructor(_dbPath: string) {}
    initialize = mockStorageInitialize;
    getDetail = mockStorageGetDetail;
    incrementAccessCount = mockStorageIncrementAccessCount;
    markLastRead = mockStorageMarkLastRead;
    close = mockStorageClose;
  }
  return { SQLiteStorage: MockSQLiteStorage };
});

vi.mock("../config.js", () => ({
  config: { geminiApiKey: "test-key", sqliteFile: "memory.db" },
  getMemoryPath: vi.fn().mockReturnValue("/tmp/test-memory"),
}));

import { handleMemoryGetDetail } from "../tools/getDetail.js";

describe("access tracking on getDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStorageIncrementAccessCount.mockReturnValue(undefined);
    mockStorageMarkLastRead.mockReturnValue(undefined);
  });

  it("updates lastAccessedAt when entries are found", async () => {
    mockStorageGetDetail.mockReturnValue({
      entries: [
        { id: "entry-1", timestamp: "2024-01-01", category: "config", title: "test", content: "test", tags: [] },
      ],
      notFound: [],
    });

    await handleMemoryGetDetail({ ids: ["entry-1"] }, "/tmp/project");

    expect(mockStorageIncrementAccessCount).toHaveBeenCalledWith(["entry-1"]);
    // 埋め込み非依存の最終読取時刻も、フル取得した id に対して刻まれる
    expect(mockStorageMarkLastRead).toHaveBeenCalledWith(["entry-1"]);
  });

  it("only updates found entries, not missing ones", async () => {
    mockStorageGetDetail.mockReturnValue({
      entries: [
        { id: "entry-1", timestamp: "2024-01-01", category: "config", title: "test", content: "test", tags: [] },
      ],
      notFound: ["entry-missing"],
    });

    await handleMemoryGetDetail({ ids: ["entry-1", "entry-missing"] }, "/tmp/project");

    expect(mockStorageIncrementAccessCount).toHaveBeenCalledWith(["entry-1"]);
  });

  it("does not call incrementAccessCount when no entries found", async () => {
    mockStorageGetDetail.mockReturnValue({
      entries: [],
      notFound: ["entry-missing"],
    });

    await handleMemoryGetDetail({ ids: ["entry-missing"] }, "/tmp/project");

    expect(mockStorageIncrementAccessCount).not.toHaveBeenCalled();
    expect(mockStorageMarkLastRead).not.toHaveBeenCalled();
  });

  it("propagates incrementAccessCount errors (sync storage has no error isolation)", async () => {
    mockStorageGetDetail.mockReturnValue({
      entries: [
        { id: "entry-1", timestamp: "2024-01-01", category: "config", title: "test", content: "test", tags: [] },
      ],
      notFound: [],
    });
    mockStorageIncrementAccessCount.mockImplementation(() => { throw new Error("storage error"); });

    // In v2, incrementAccessCount is sync and not wrapped in try/catch,
    // so errors propagate (finally block still closes storage)
    await expect(
      handleMemoryGetDetail({ ids: ["entry-1"] }, "/tmp/project")
    ).rejects.toThrow("storage error");

    // storage.close() should still be called via finally block
    expect(mockStorageClose).toHaveBeenCalled();
  });
});
