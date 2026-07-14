import { describe, it, expect, vi, beforeEach } from "vitest";

const mockEmbedText = vi.fn();
const mockCreateEmbedTextFn = vi.fn(() => mockEmbedText);

vi.mock("../llm/provider.js", () => ({
  createEmbedTextFn: () => mockCreateEmbedTextFn(),
  DEFAULT_EMBEDDING_MODEL: "gemini-embedding-001",
}));

const mockIncrement = vi.fn().mockResolvedValue(undefined);
vi.mock("../observability/counters.js", () => ({
  increment: (...args: unknown[]) => mockIncrement(...args),
}));

import { EmbeddingService, EMBEDDING_MODEL } from "./embedding-service.js";

const MEMORY_PATH = "/tmp/test-memory";

describe("EmbeddingService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("EMBEDDING_MODEL is aligned with provider.ts's DEFAULT_EMBEDDING_MODEL (drift detection)", () => {
    expect(EMBEDDING_MODEL).toBe("gemini-embedding-001");
  });

  describe("isAvailable", () => {
    it("returns true with valid key", () => {
      const service = new EmbeddingService("test-api-key", MEMORY_PATH);
      expect(service.isAvailable()).toBe(true);
    });

    it("returns false with empty string", () => {
      const service = new EmbeddingService("", MEMORY_PATH);
      expect(service.isAvailable()).toBe(false);
    });
  });

  describe("embed", () => {
    it("calls the embedder via provider.ts's Genkit-backed createEmbedTextFn (not a direct SDK call)", async () => {
      const fakeValues = Array.from({ length: 768 }, (_, i) => i * 0.001);
      mockEmbedText.mockResolvedValueOnce(fakeValues);

      const service = new EmbeddingService("test-api-key", MEMORY_PATH);
      await service.embed("hello world");

      expect(mockCreateEmbedTextFn).toHaveBeenCalled();
      expect(mockEmbedText).toHaveBeenCalledWith("hello world", "RETRIEVAL_DOCUMENT");
    });

    it("returns embedding values", async () => {
      mockEmbedText.mockResolvedValueOnce([0.1, 0.2, 0.3]);

      const service = new EmbeddingService("test-api-key", MEMORY_PATH);
      const result = await service.embed("test text");

      expect(result).toEqual([0.1, 0.2, 0.3]);
    });

    it("throws on API failure and records a warning count (throw behavior preserved, now also observable)", async () => {
      mockEmbedText.mockRejectedValueOnce(new Error("API error"));

      const service = new EmbeddingService("test-api-key", MEMORY_PATH);
      await expect(service.embed("test")).rejects.toThrow("API error");
      expect(mockIncrement).toHaveBeenCalledWith(MEMORY_PATH, "embedding_failure_count", 1);
    });
  });

  describe("embedBatch", () => {
    it("calls embed sequentially for each text", async () => {
      const callOrder: number[] = [];
      mockEmbedText
        .mockImplementationOnce(async () => {
          callOrder.push(1);
          return [0.1];
        })
        .mockImplementationOnce(async () => {
          callOrder.push(2);
          return [0.2];
        })
        .mockImplementationOnce(async () => {
          callOrder.push(3);
          return [0.3];
        });

      const service = new EmbeddingService("test-api-key", MEMORY_PATH);
      const results = await service.embedBatch(["a", "b", "c"]);

      expect(results).toEqual([[0.1], [0.2], [0.3]]);
      expect(callOrder).toEqual([1, 2, 3]);
      expect(mockEmbedText).toHaveBeenCalledTimes(3);
    });

    it("throws if any call fails", async () => {
      mockEmbedText
        .mockResolvedValueOnce([0.1])
        .mockRejectedValueOnce(new Error("second call failed"));

      const service = new EmbeddingService("test-api-key", MEMORY_PATH);
      await expect(service.embedBatch(["a", "b", "c"])).rejects.toThrow(
        "second call failed",
      );
    });
  });
});
