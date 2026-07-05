import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocks（既存 search-scoring.test.ts / search-positive-action.test.ts と同じ骨格）
const mockStorageSearch = vi.fn();
const mockStorageSearchHybrid = vi.fn();
const mockStorageSearchVectors = vi.fn();
const mockStorageIncrementAccessCount = vi.fn();
const mockStorageGetVectorMetadata = vi.fn();
const mockStorageGetPredictionErrors = vi.fn();
const mockStorageGetDetail = vi.fn();
const mockStorageSave = vi.fn();
const mockListHighIntensityDonts = vi.fn();
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
    getPredictionErrors = mockStorageGetPredictionErrors;
    getDetail = mockStorageGetDetail;
    save = mockStorageSave;
    listHighIntensityDonts = mockListHighIntensityDonts;
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
  config: { geminiApiKey: "", sqliteFile: "memory.db", modelsDir: "models" },
  getMemoryPath: vi.fn().mockReturnValue("/tmp/test-memory-hint-consistency"),
}));

const mockGetActiveProjects = vi.fn();
vi.mock("../active-projects.js", () => ({
  ActiveProjectsTracker: class {
    constructor(_schedulerDir: string) {}
    getActiveProjects = mockGetActiveProjects;
  },
}));

import { handleMemorySearch } from "./search.js";

describe("memory_search: hint は最終返却件数から再導出される（マージ前凍結hintを使い回さない）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEmbedInitialize.mockResolvedValue(undefined);
    mockEmbedIsAvailable.mockReturnValue(true);
    mockEmbed.mockResolvedValue([0.1, 0.2, 0.3]);
    mockStorageIncrementAccessCount.mockReturnValue(undefined);
    mockStorageGetDetail.mockReturnValue({ entries: [], notFound: [] });
    mockStorageGetVectorMetadata.mockReturnValue(new Map());
    mockStorageGetPredictionErrors.mockReturnValue(new Map());
    mockStorageSearchVectors.mockReturnValue([]);
    mockListHighIntensityDonts.mockReturnValue([]);
    mockGetActiveProjects.mockResolvedValue([]);
  });

  it("project未指定・0件時は「見つからない」文言になる", async () => {
    // storage側のhintをわざと矛盾させても、最終件数(0件)から再導出されることを検証する
    mockStorageSearchHybrid.mockReturnValue({
      results: [],
      totalCount: 0,
      hint: "詳細が必要なエントリのIDを memory_get_detail に渡してください。",
    });

    const resultJson = await handleMemorySearch({ query: "test" }, "/tmp/project");
    const result = JSON.parse(resultJson);

    expect(result.results).toHaveLength(0);
    expect(result.hint).toBe("該当するメモリが見つかりませんでした。");
  });

  it("project未指定・非0件時は詳細誘導文言になる", async () => {
    mockStorageSearchHybrid.mockReturnValue({
      results: [
        { id: "a1", timestamp: "2026-01-01T00:00:00+09:00", category: "log", title: "本体作業ログ", tags: [], project: "p" },
      ],
      totalCount: 1,
      hint: "該当するメモリが見つかりませんでした。", // わざと矛盾させる
    });

    const resultJson = await handleMemorySearch({ query: "test" }, "/tmp/project");
    const result = JSON.parse(resultJson);

    expect(result.results).toHaveLength(1);
    expect(result.hint).toBe("詳細が必要なエントリのIDを memory_get_detail に渡してください。");
  });

  it("単一project指定・0件時は「見つからない」文言になる", async () => {
    mockStorageSearchHybrid.mockReturnValue({ results: [], totalCount: 0, hint: "" });

    const resultJson = await handleMemorySearch({ query: "test", project: "politician-checker" }, "/tmp/project");
    const result = JSON.parse(resultJson);

    expect(result.results).toHaveLength(0);
    expect(result.hint).toBe("該当するメモリが見つかりませんでした。");
  });

  it("project='active'指定でbaseが0件でもアクティブプロジェクト横断でmergedが非0件になれば、hintは誘導文言になる（見つからないままにしない＝欠陥Aの核）", async () => {
    // 1回目呼び出し=起動プロジェクト自身の検索（0件）、2回目呼び出し=アクティブプロジェクト横断ループ内の検索（1件）
    mockStorageSearchHybrid
      .mockReturnValueOnce({ results: [], totalCount: 0, hint: "該当するメモリが見つかりませんでした。" })
      .mockReturnValueOnce({
        results: [
          { id: "b1", timestamp: "2026-01-01T00:00:00+09:00", category: "log", title: "他プロジェクトのメモリ", tags: [], project: "other-project" },
        ],
        totalCount: 1,
        hint: "詳細が必要なエントリのIDを memory_get_detail に渡してください。",
      });
    mockGetActiveProjects.mockResolvedValue([
      { name: "other-project", path: "/tmp/other-project", lastSessionAt: "2026-01-01T00:00:00+09:00", sessionTopic: "x" },
    ]);

    const resultJson = await handleMemorySearch({ query: "test", project: "active" }, "/tmp/project");
    const result = JSON.parse(resultJson);

    expect(result.results.length).toBeGreaterThan(0);
    expect(result.hint).toBe("詳細が必要なエントリのIDを memory_get_detail に渡してください。");
  });

  it("不変条件: hint は常に最終 results 件数と一致する（0件⇔見つからない／非0件⇔誘導文言）", async () => {
    mockStorageSearchHybrid.mockReturnValue({
      results: [
        { id: "c1", timestamp: "2026-01-01T00:00:00+09:00", category: "log", title: "x", tags: [], project: "p" },
      ],
      totalCount: 1,
      hint: "",
    });

    const resultJson = await handleMemorySearch({ query: "test" }, "/tmp/project");
    const result = JSON.parse(resultJson);

    const expectedHint = result.results.length > 0
      ? "詳細が必要なエントリのIDを memory_get_detail に渡してください。"
      : "該当するメモリが見つかりませんでした。";
    expect(result.hint).toBe(expectedHint);
  });
});
