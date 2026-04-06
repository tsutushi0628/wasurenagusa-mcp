import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocks
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

import { handleMemorySave } from "./save.js";
import { config } from "../config.js";

describe("save.ts tag enrichment integration", () => {
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
  });

  it("runs tag enrichment in parallel with embedding", async () => {
    mockEnrich.mockResolvedValueOnce({
      tags: [
        { tag: "rate-limit", weight: 0.9 },
        { tag: "API", weight: 0.3 },
      ],
      newThemes: [],
    });

    await handleMemorySave(
      { category: "config", title: "test", content: "test content", tags: ["original"] },
      "/tmp/project",
    );

    expect(mockEnrich).toHaveBeenCalledTimes(1);
    expect(mockEmbed).toHaveBeenCalledTimes(1);
    expect(mockStorageSave).toHaveBeenCalledTimes(1);
    const savedParams = mockStorageSave.mock.calls[0][0];
    expect(savedParams.tags).toEqual(["rate-limit:0.9", "API:0.3"]);
  });

  it("falls back to original tags on enrichment error", async () => {
    mockEnrich.mockRejectedValueOnce(new Error("Gemini API error"));

    await handleMemorySave(
      { category: "config", title: "test", content: "test content", tags: ["original"] },
      "/tmp/project",
    );

    expect(mockStorageSave).toHaveBeenCalledTimes(1);
    const savedParams = mockStorageSave.mock.calls[0][0];
    expect(savedParams.tags).toEqual(["original"]);
  });

  it("skips enrichment when API key unavailable", async () => {
    mockEmbedIsAvailable.mockReturnValue(false);
    // config.geminiApiKeyを空にしてTagEnricherもスキップさせる
    (config as Record<string, unknown>).geminiApiKey = "";

    await handleMemorySave(
      { category: "config", title: "test", content: "test content", tags: ["original"] },
      "/tmp/project",
    );

    expect(mockEnrich).not.toHaveBeenCalled();
    expect(mockEmbed).not.toHaveBeenCalled();
    const savedParams = mockStorageSave.mock.calls[0][0];
    expect(savedParams.tags).toEqual(["original"]);

    // restore
    (config as Record<string, unknown>).geminiApiKey = "test-key";
  });
});
