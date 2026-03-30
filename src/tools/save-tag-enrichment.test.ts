import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocks
const mockStorageSave = vi.fn();
vi.mock("../storage/index.js", () => {
  class MockMarkdownStorage {
    constructor(_projectRoot: string) {}
    save = mockStorageSave;
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

const mockVectorUpsert = vi.fn();
const mockVectorDelete = vi.fn();
vi.mock("../vector/vector-store.js", () => {
  class MockVectorStore {
    constructor(_memoryPath: string) {}
    upsert = mockVectorUpsert;
    delete = mockVectorDelete;
  }
  return { VectorStore: MockVectorStore };
});

const mockEnrich = vi.fn();
const mockEnricherIsAvailable = vi.fn();
vi.mock("../vector/tag-enricher.js", () => {
  class MockTagEnricher {
    constructor(_apiKey: string) {}
    enrich = mockEnrich;
    isAvailable = mockEnricherIsAvailable;
  }
  return { TagEnricher: MockTagEnricher };
});

const mockIsNewTheme = vi.fn();
const mockAddThemes = vi.fn();
vi.mock("../vector/theme-registry.js", () => {
  class MockThemeRegistry {
    constructor(_memoryPath: string) {}
    isNewTheme = mockIsNewTheme;
    addThemes = mockAddThemes;
  }
  return { ThemeRegistry: MockThemeRegistry };
});

vi.mock("../config.js", () => ({
  config: { geminiApiKey: "test-key" },
  getMemoryPath: vi.fn().mockReturnValue("/tmp/test-memory"),
}));

import { handleMemorySave } from "./save.js";

describe("save.ts tag enrichment integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStorageSave.mockResolvedValue({
      success: true,
      id: "test-id-001",
      path: "/tmp/test.md",
      message: "saved",
    });
    mockEmbed.mockResolvedValue([0.1, 0.2, 0.3]);
    mockEmbedIsAvailable.mockReturnValue(true);
    mockEnricherIsAvailable.mockReturnValue(true);
    mockVectorUpsert.mockResolvedValue(undefined);
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
    mockEnricherIsAvailable.mockReturnValue(false);

    await handleMemorySave(
      { category: "config", title: "test", content: "test content", tags: ["original"] },
      "/tmp/project",
    );

    expect(mockEnrich).not.toHaveBeenCalled();
    expect(mockEmbed).not.toHaveBeenCalled();
    const savedParams = mockStorageSave.mock.calls[0][0];
    expect(savedParams.tags).toEqual(["original"]);
  });
});
