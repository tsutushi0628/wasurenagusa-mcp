import { describe, it, expect, vi, beforeEach } from "vitest";

const mockListHighIntensityDonts = vi.fn();
const mockStorageSearch = vi.fn();
const mockStorageSearchHybrid = vi.fn();
const mockStorageSearchVectors = vi.fn();
const mockStorageIncrementAccessCount = vi.fn();
const mockStorageGetVectorMetadata = vi.fn();
const mockStorageGetDetail = vi.fn();
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
    listHighIntensityDonts = mockListHighIntensityDonts;
    markLastRead = vi.fn();
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
  return {
    LocalEmbedding: MockLocalEmbedding,
    getSharedEmbedding: async () => ({
      isAvailable: mockEmbedIsAvailable,
      embed: mockEmbed,
      embedBatch: vi.fn(),
    }),
    disposeSharedEmbedding: async () => {},
  };
});

vi.mock("../vector/memory-tier.js", () => ({
  TIER_THRESHOLDS: { critical: 0.3, medium: 0.6, archive: 0.9 },
  shouldPromoteToCritical: vi.fn().mockReturnValue(false),
}));

vi.mock("../config.js", () => ({
  config: { geminiApiKey: "test-key", sqliteFile: "memory.db", modelsDir: "models" },
  getMemoryPath: vi.fn().mockReturnValue("/tmp/test-memory"),
  getModelsDir: vi.fn().mockReturnValue("/tmp/test-memory/models"),
}));

import { handleMemorySearch } from "./search.js";

/**
 * search応答からangerHistory固定付帯ブロックが廃止されたことを検証する（タスク4.3）。
 * 業務要件: 検索応答は「検索結果とhintのみ」で構成され、クエリ無関係な高強度dontの
 * 固定リストを毎回付与しない。listHighIntensityDontsが何を返そうと応答に反映されない
 * ことを確認する（=呼び出し自体が発生しない設計に根治済みであることの外形検証）。
 */
describe("search応答: angerHistory固定付帯の廃止（タスク4.3）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEmbedInitialize.mockResolvedValue(undefined);
    mockEmbedIsAvailable.mockReturnValue(true);
    mockEmbed.mockResolvedValue([0.1, 0.2, 0.3]);
    mockStorageIncrementAccessCount.mockReturnValue(undefined);
    mockStorageGetDetail.mockReturnValue({ entries: [], notFound: [] });
    mockStorageGetVectorMetadata.mockReturnValue(new Map());
  });

  it("高強度dontが存在してもangerHistoryフィールドが応答に含まれない", async () => {
    mockStorageSearchHybrid.mockReturnValue({
      results: [],
      totalCount: 0,
      hint: "",
    });
    mockStorageSearchVectors.mockReturnValue([]);
    mockListHighIntensityDonts.mockReturnValue([
      {
        id: "mow30vwu-731c",
        timestamp: "2026-01-01T00:00:00+09:00",
        category: "dont",
        title: "データは完全形保存／表示は表示層で制御",
        tags: [],
        intensity: 9,
        positiveAction: "データ保存時は完全形を保持し、表示文字数制限はCSS truncationまたはdisplay:noneで表示層に委譲する",
      },
    ]);

    const resultJson = await handleMemorySearch({ query: "テスト" }, "/tmp/project");
    const result = JSON.parse(resultJson);

    expect(result.angerHistory).toBeUndefined();
    expect(mockListHighIntensityDonts).not.toHaveBeenCalled();
  });

  it("通常の検索結果とhintのみが返る（応答フィールドがresults/totalCount/hint/fallbackStageのみに限定される）", async () => {
    mockStorageSearchHybrid.mockReturnValue({
      results: [{ id: "m1", title: "設定A", tags: [] }],
      totalCount: 1,
      hint: "",
    });
    mockStorageSearchVectors.mockReturnValue([]);

    const resultJson = await handleMemorySearch({ query: "設定" }, "/tmp/project");
    const result = JSON.parse(resultJson);

    const allowedKeys = new Set(["results", "totalCount", "hint", "fallbackStage"]);
    for (const key of Object.keys(result)) {
      expect(allowedKeys.has(key)).toBe(true);
    }
    expect(result.results).toEqual([{ id: "m1", title: "設定A" }]);
  });
});
