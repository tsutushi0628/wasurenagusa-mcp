import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocks（save-tag-enrichment.test.ts と同じ骨格）
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
  config: { geminiApiKey: "", sqliteFile: "memory.db", modelsDir: "models" },
  getMemoryPath: vi.fn().mockReturnValue("/tmp/test-memory-project-attribution"),
}));

import { handleMemorySave } from "./save.js";

describe("memory_save: project 帰属（起動プロジェクトへの暗黙帰属事故の再発防止）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStorageSave.mockReturnValue({ success: true, id: "test-id", path: "sqlite", message: "saved" });
    mockEmbedInitialize.mockResolvedValue(undefined);
    mockEmbedIsAvailable.mockReturnValue(false);
    mockEmbed.mockResolvedValue([0.1, 0.2, 0.3]);
  });

  it("project を明示指定すると、その値がそのまま実作業プロジェクトとして保存される", async () => {
    await handleMemorySave(
      { category: "log", title: "他プロジェクト作業ログ", content: "内容", project: "politician-checker" },
      "/tmp/firebase-kit",
    );

    const savedParams = mockStorageSave.mock.calls[0][0];
    expect(savedParams.project).toBe("politician-checker");
  });

  it("project を省略すると、起動プロジェクト名へ暗黙フォールバックせずunknownが明示刻印される（禁止フォールバック#5）", async () => {
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await handleMemorySave(
        { category: "log", title: "本体作業ログ", content: "内容" },
        "/tmp/firebase-kit",
      );

      const savedParams = mockStorageSave.mock.calls[0][0];
      expect(savedParams.project).toBe("unknown");
      const warned = stderrSpy.mock.calls.some((call) => String(call[0]).includes("project省略"));
      expect(warned).toBe(true);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("project に空文字を渡すと、省略時と同様にunknownが明示刻印される", async () => {
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await handleMemorySave(
        { category: "log", title: "空文字指定ログ", content: "内容", project: "" },
        "/tmp/firebase-kit",
      );

      const savedParams = mockStorageSave.mock.calls[0][0];
      expect(savedParams.project).toBe("unknown");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("project を明示指定するとproject_confidenceがconfirmedになる", async () => {
    await handleMemorySave(
      { category: "log", title: "明示指定ログ", content: "内容", project: "politician-checker" },
      "/tmp/firebase-kit",
    );

    const savedParams = mockStorageSave.mock.calls[0][0];
    expect(savedParams.projectConfidence).toBe("confirmed");
  });

  it("project を省略するとproject_confidenceがunknownになる", async () => {
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await handleMemorySave(
        { category: "log", title: "省略ログ", content: "内容" },
        "/tmp/firebase-kit",
      );

      const savedParams = mockStorageSave.mock.calls[0][0];
      expect(savedParams.projectConfidence).toBe("unknown");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("project の前後に空白を含む文字列を渡すと、trim済みの値で保存される（未trimのまま刻むと表記ゆれで単一プロジェクト検索が割れる）", async () => {
    await handleMemorySave(
      { category: "log", title: "前後空白付きprojectログ", content: "内容", project: "  politician-checker  " },
      "/tmp/firebase-kit",
    );

    const savedParams = mockStorageSave.mock.calls[0][0];
    expect(savedParams.project).toBe("politician-checker");
  });
});
