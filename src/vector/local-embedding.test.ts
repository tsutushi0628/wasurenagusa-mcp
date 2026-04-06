import { describe, it, expect, beforeAll } from "vitest";
import { LocalEmbedding, EMBEDDING_DIMENSIONS } from "./local-embedding.js";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync } from "fs";

describe("LocalEmbedding", () => {
  const modelDir = mkdtempSync(join(tmpdir(), "wasurenagusa-embedding-test-"));
  let embedding: LocalEmbedding;

  beforeAll(async () => {
    embedding = new LocalEmbedding(modelDir);
    await embedding.initialize();
  }, 120_000); // モデルダウンロードに時間がかかる

  it("EMBEDDING_DIMENSIONS is 384", () => {
    expect(EMBEDDING_DIMENSIONS).toBe(384);
  });

  it("isAvailable returns true after initialize", () => {
    expect(embedding.isAvailable()).toBe(true);
  });

  it("isAvailable returns false before initialize", () => {
    const fresh = new LocalEmbedding(modelDir);
    expect(fresh.isAvailable()).toBe(false);
  });

  it("embed returns a vector of 384 dimensions", async () => {
    const vector = await embedding.embed("テストテキスト");
    expect(vector).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(vector.every((v) => typeof v === "number")).toBe(true);
    // ベクトルがゼロでないことを確認
    expect(vector.some((v) => v !== 0)).toBe(true);
  });

  it("embed returns normalized vector (L2 norm ≈ 1)", async () => {
    const vector = await embedding.embed("normalization test");
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 2);
  });

  it("embedBatch returns vectors for all inputs", async () => {
    const texts = ["first text", "second text", "third text"];
    const vectors = await embedding.embedBatch(texts);
    expect(vectors).toHaveLength(3);
    for (const vector of vectors) {
      expect(vector).toHaveLength(EMBEDDING_DIMENSIONS);
      expect(vector.every((v) => typeof v === "number")).toBe(true);
    }
  });

  it("similar texts produce closer vectors than dissimilar ones", async () => {
    const [vecA, vecB, vecC] = await embedding.embedBatch([
      "TypeScript programming language",
      "JavaScript coding language",
      "Italian pasta recipe with tomato sauce",
    ]);

    // コサイン類似度を計算
    const cosine = (a: number[], b: number[]) =>
      a.reduce((sum, ai, i) => sum + ai * b[i], 0);

    const simAB = cosine(vecA, vecB); // 類似テキスト
    const simAC = cosine(vecA, vecC); // 非類似テキスト

    expect(simAB).toBeGreaterThan(simAC);
  });

  it("embed throws on empty string", async () => {
    await expect(embedding.embed("")).rejects.toThrow();
  });

  it("embedBatch throws on empty array", async () => {
    await expect(embedding.embedBatch([])).rejects.toThrow();
  });
});
