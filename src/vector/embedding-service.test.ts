import { describe, it, expect, vi, beforeEach } from "vitest";

const mockEmbedContent = vi.fn();
const mockGetGenerativeModel = vi.fn(() => ({
  embedContent: mockEmbedContent,
}));

vi.mock("@google/generative-ai", () => {
  class MockGoogleGenerativeAI {
    constructor(_apiKey: string) {}
    getGenerativeModel = mockGetGenerativeModel;
  }
  return {
    GoogleGenerativeAI: MockGoogleGenerativeAI,
    TaskType: {
      TASK_TYPE_UNSPECIFIED: "TASK_TYPE_UNSPECIFIED",
      RETRIEVAL_QUERY: "RETRIEVAL_QUERY",
      RETRIEVAL_DOCUMENT: "RETRIEVAL_DOCUMENT",
      SEMANTIC_SIMILARITY: "SEMANTIC_SIMILARITY",
      CLASSIFICATION: "CLASSIFICATION",
      CLUSTERING: "CLUSTERING",
    },
  };
});

import { EmbeddingService } from "./embedding-service.js";

describe("EmbeddingService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("isAvailable", () => {
    it("returns true with valid key", () => {
      const service = new EmbeddingService("test-api-key");
      expect(service.isAvailable()).toBe(true);
    });

    it("returns false with empty string", () => {
      const service = new EmbeddingService("");
      expect(service.isAvailable()).toBe(false);
    });
  });

  describe("embed", () => {
    it("calls API with correct parameters", async () => {
      const fakeValues = Array.from({ length: 768 }, (_, i) => i * 0.001);
      mockEmbedContent.mockResolvedValueOnce({
        embedding: { values: fakeValues },
      });

      const service = new EmbeddingService("test-api-key");
      await service.embed("hello world");

      expect(mockGetGenerativeModel).toHaveBeenCalledWith({
        model: "gemini-embedding-001",
      });
      expect(mockEmbedContent).toHaveBeenCalledWith({
        content: { parts: [{ text: "hello world" }], role: "user" },
        taskType: "RETRIEVAL_DOCUMENT",
      });
    });

    it("returns embedding values", async () => {
      const fakeValues = [0.1, 0.2, 0.3];
      mockEmbedContent.mockResolvedValueOnce({
        embedding: { values: fakeValues },
      });

      const service = new EmbeddingService("test-api-key");
      const result = await service.embed("test text");

      expect(result).toEqual([0.1, 0.2, 0.3]);
    });

    it("throws on API failure", async () => {
      mockEmbedContent.mockRejectedValueOnce(new Error("API error"));

      const service = new EmbeddingService("test-api-key");
      await expect(service.embed("test")).rejects.toThrow("API error");
    });
  });

  describe("embedBatch", () => {
    it("calls embed sequentially for each text", async () => {
      const callOrder: number[] = [];
      mockEmbedContent
        .mockImplementationOnce(async () => {
          callOrder.push(1);
          return { embedding: { values: [0.1] } };
        })
        .mockImplementationOnce(async () => {
          callOrder.push(2);
          return { embedding: { values: [0.2] } };
        })
        .mockImplementationOnce(async () => {
          callOrder.push(3);
          return { embedding: { values: [0.3] } };
        });

      const service = new EmbeddingService("test-api-key");
      const results = await service.embedBatch(["a", "b", "c"]);

      expect(results).toEqual([[0.1], [0.2], [0.3]]);
      expect(callOrder).toEqual([1, 2, 3]);
      expect(mockEmbedContent).toHaveBeenCalledTimes(3);
    });

    it("throws if any call fails", async () => {
      mockEmbedContent
        .mockResolvedValueOnce({ embedding: { values: [0.1] } })
        .mockRejectedValueOnce(new Error("second call failed"));

      const service = new EmbeddingService("test-api-key");
      await expect(service.embedBatch(["a", "b", "c"])).rejects.toThrow(
        "second call failed",
      );
    });
  });
});
