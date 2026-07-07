import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * v1書き込み経路の物理遮断（タスク0.6、R-A3）: retag-worker のspawn遮断。
 *
 * retag-worker.ts は MarkdownStorage（v1）経由でエントリを読み書きする。
 * 新テーマ検出時にこれをdetachedプロセスとしてspawnする経路（src/tools/save.ts）は、
 * v1系書き込みの実体の一つであり、恒久停止の対象となる。
 * テーマ登録自体（SQLiteのthemesテーブルへの追記）はv2書き込みのため維持する。
 */

const mockStorageSave = vi.fn();
const mockStorageInitialize = vi.fn();
const mockStorageIsNewTheme = vi.fn();
const mockStorageAddThemes = vi.fn();
const mockStorageDeleteVectors = vi.fn();
const mockStorageUpsertVector = vi.fn();
const mockStorageClose = vi.fn();
vi.mock("../storage/sqlite.js", () => {
  class MockSQLiteStorage {
    constructor(_dbPath: string) {}
    initialize = mockStorageInitialize;
    save = mockStorageSave;
    isNewTheme = mockStorageIsNewTheme;
    addThemes = mockStorageAddThemes;
    deleteVectors = mockStorageDeleteVectors;
    upsertVector = mockStorageUpsertVector;
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

const mockEnrich = vi.fn();
vi.mock("../vector/tag-enricher.js", () => {
  class MockTagEnricher {
    constructor(_apiKey: string) {}
    enrich = mockEnrich;
  }
  return { TagEnricher: MockTagEnricher };
});

vi.mock("../config.js", () => ({
  config: { geminiApiKey: "test-key", sqliteFile: "memory.db", modelsDir: "models" },
  getMemoryPath: vi.fn().mockReturnValue("/tmp/test-memory"),
}));

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));
vi.mock("child_process", () => ({
  spawn: mockSpawn,
}));

import { handleMemorySave } from "./save.js";

describe("save.ts: 新テーマ検出時でもretag-workerはspawnされない（v1書き込み経路の物理遮断）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStorageSave.mockReturnValue({
      success: true,
      id: "test-id-001",
      path: "sqlite",
      message: "saved",
    });
    mockEmbedInitialize.mockResolvedValue(undefined);
    mockEmbed.mockResolvedValue([0.1, 0.2, 0.3]);
    mockEmbedIsAvailable.mockReturnValue(true);
    mockStorageIsNewTheme.mockReturnValue(true);
    mockSpawn.mockReturnValue({ unref: vi.fn() });
  });

  it("新テーマが検出されても child_process.spawn は一切呼ばれない", async () => {
    mockEnrich.mockResolvedValueOnce({
      tags: [{ tag: "rate-limit", weight: 0.9 }],
      newThemes: ["rate-limit"],
    });

    await handleMemorySave(
      { category: "config", title: "test", content: "test content", tags: ["original"] },
      "/tmp/project",
    );

    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("spawnを遮断しても、テーマ登録自体（SQLite themesテーブルへの追記）は維持される", async () => {
    mockEnrich.mockResolvedValueOnce({
      tags: [{ tag: "rate-limit", weight: 0.9 }],
      newThemes: ["rate-limit"],
    });

    await handleMemorySave(
      { category: "config", title: "test", content: "test content", tags: ["original"] },
      "/tmp/project",
    );

    expect(mockStorageAddThemes).toHaveBeenCalledWith(["rate-limit"]);
  });

  it("新テーマが0件のときは従来通りspawnもテーマ登録も発生しない", async () => {
    mockEnrich.mockResolvedValueOnce({ tags: [], newThemes: [] });

    await handleMemorySave(
      { category: "config", title: "test", content: "test content", tags: ["original"] },
      "/tmp/project",
    );

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockStorageAddThemes).not.toHaveBeenCalled();
  });
});
