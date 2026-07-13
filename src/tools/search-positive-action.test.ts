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

describe("angerHistory positiveAction フォールバック", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEmbedInitialize.mockResolvedValue(undefined);
    mockEmbedIsAvailable.mockReturnValue(true);
    mockEmbed.mockResolvedValue([0.1, 0.2, 0.3]);
    mockStorageIncrementAccessCount.mockReturnValue(undefined);
    mockStorageGetDetail.mockReturnValue({ entries: [], notFound: [] });
    mockStorageGetVectorMetadata.mockReturnValue(new Map());
  });

  it("angerHistory エントリに positiveAction があれば positiveAction がそのまま返る", async () => {
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

    expect(result.angerHistory).toHaveLength(1);
    expect(result.angerHistory[0].positiveAction).toBe(
      "データ保存時は完全形を保持し、表示文字数制限はCSS truncationまたはdisplay:noneで表示層に委譲する"
    );
  });

  it("angerHistory エントリに positiveAction がなければ title が positiveAction キーでフォールバック返却される", async () => {
    mockStorageSearchHybrid.mockReturnValue({
      results: [],
      totalCount: 0,
      hint: "",
    });
    mockStorageSearchVectors.mockReturnValue([]);
    mockListHighIntensityDonts.mockReturnValue([
      {
        id: "old-dont-id",
        timestamp: "2026-01-01T00:00:00+09:00",
        category: "dont",
        title: "旧タイトル（positiveAction未設定）",
        tags: [],
        intensity: 9,
      },
    ]);

    const resultJson = await handleMemorySearch({ query: "テスト" }, "/tmp/project");
    const result = JSON.parse(resultJson);

    expect(result.angerHistory).toHaveLength(1);
    expect(result.angerHistory[0].title).toBe("旧タイトル（positiveAction未設定）");
    expect(result.angerHistory[0].positiveAction).toBe("旧タイトル（positiveAction未設定）");
  });

  it("angerHistory エントリが空なら angerHistory フィールド自体が返らない", async () => {
    mockStorageSearchHybrid.mockReturnValue({
      results: [],
      totalCount: 0,
      hint: "",
    });
    mockStorageSearchVectors.mockReturnValue([]);
    mockListHighIntensityDonts.mockReturnValue([]);

    const resultJson = await handleMemorySearch({ query: "テスト" }, "/tmp/project");
    const result = JSON.parse(resultJson);

    expect(result.angerHistory).toBeUndefined();
  });

  it("angerHistory 複数エントリで positiveAction の有無が混在してもそれぞれ正しく返る", async () => {
    mockStorageSearchHybrid.mockReturnValue({
      results: [],
      totalCount: 0,
      hint: "",
    });
    mockStorageSearchVectors.mockReturnValue([]);
    mockListHighIntensityDonts.mockReturnValue([
      {
        id: "id-with-positive-action",
        timestamp: "2026-01-01T00:00:00+09:00",
        category: "dont",
        title: "タイトルA",
        tags: [],
        intensity: 9,
        positiveAction: "肯定形アクションA",
      },
      {
        id: "id-without-positive-action",
        timestamp: "2026-01-01T00:00:00+09:00",
        category: "dont",
        title: "タイトルB（フォールバック対象）",
        tags: [],
        intensity: 8,
      },
    ]);

    const resultJson = await handleMemorySearch({ query: "テスト" }, "/tmp/project");
    const result = JSON.parse(resultJson);

    expect(result.angerHistory).toHaveLength(2);
    expect(result.angerHistory[0].positiveAction).toBe("肯定形アクションA");
    expect(result.angerHistory[1].positiveAction).toBe("タイトルB（フォールバック対象）");
  });

  it("angerHistory エントリに scenario / whyCore があれば slimAngerEntry に含まれる", async () => {
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
        scenario: "politician-checker パイプラインで公報原文先頭20字を切り捨てて格納",
        whyCore: "データ層で切り詰めると後で完全形が必要な時に取り戻せない",
      },
    ]);

    const resultJson = await handleMemorySearch({ query: "テスト" }, "/tmp/project");
    const result = JSON.parse(resultJson);

    expect(result.angerHistory).toHaveLength(1);
    expect(result.angerHistory[0].scenario).toBe("politician-checker パイプラインで公報原文先頭20字を切り捨てて格納");
    expect(result.angerHistory[0].whyCore).toBe("データ層で切り詰めると後で完全形が必要な時に取り戻せない");
  });

  it("angerHistory エントリに scenario / whyCore がなければそのフィールドは返らない", async () => {
    mockStorageSearchHybrid.mockReturnValue({
      results: [],
      totalCount: 0,
      hint: "",
    });
    mockStorageSearchVectors.mockReturnValue([]);
    mockListHighIntensityDonts.mockReturnValue([
      {
        id: "old-dont-id",
        timestamp: "2026-01-01T00:00:00+09:00",
        category: "dont",
        title: "旧タイトル",
        tags: [],
        intensity: 9,
        positiveAction: "肯定形アクション",
      },
    ]);

    const resultJson = await handleMemorySearch({ query: "テスト" }, "/tmp/project");
    const result = JSON.parse(resultJson);

    expect(result.angerHistory).toHaveLength(1);
    expect(result.angerHistory[0].scenario).toBeUndefined();
    expect(result.angerHistory[0].whyCore).toBeUndefined();
  });
});
