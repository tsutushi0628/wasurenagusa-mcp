import { describe, it, expect, beforeAll } from "vitest";
import { LocalEmbedding, EMBEDDING_DIMENSIONS, DEFAULT_MODEL, buildPrefixedText } from "./local-embedding.js";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync } from "fs";

// buildPrefixedText はモデル初期化不要な純粋関数のため、ネットワーク・ダウンロード無しで
// 「文書は passage:、クエリは query: プレフィックスが付く」という業務意図を固定する。
describe("buildPrefixedText", () => {
  it("passage 用途では passage: プレフィックスを付与する（保存経路が使う）", () => {
    expect(buildPrefixedText("本番API URL", "passage")).toBe("passage: 本番API URL");
  });

  it("query 用途では query: プレフィックスを付与する（検索経路が使う）", () => {
    expect(buildPrefixedText("本番API URL", "query")).toBe("query: 本番API URL");
  });
});

describe("LocalEmbedding", () => {
  // モデルダウンロードは初回のみ発生させたいため、テスト実行間で使い回せる固定ディレクトリにする
  // （mkdtempSyncで毎回新規ディレクトリを切ると多言語モデルを毎回再ダウンロードしてしまう）。
  const modelDir = join(tmpdir(), "wasurenagusa-embedding-test-multilingual-e5-small");
  mkdirSync(modelDir, { recursive: true });
  let embedding: LocalEmbedding;

  beforeAll(async () => {
    embedding = new LocalEmbedding(modelDir);
    await embedding.initialize();
  }, 120_000); // モデルダウンロードに時間がかかる

  it("EMBEDDING_DIMENSIONS is 384", () => {
    expect(EMBEDDING_DIMENSIONS).toBe(384);
  });

  it("DEFAULT_MODEL is the multilingual model (日本語意味検索の改善が前提)", () => {
    expect(DEFAULT_MODEL).toBe("Xenova/multilingual-e5-small");
  });

  it("isAvailable returns true after initialize", () => {
    expect(embedding.isAvailable()).toBe(true);
  });

  it("isAvailable returns false before initialize", () => {
    const fresh = new LocalEmbedding(modelDir);
    expect(fresh.isAvailable()).toBe(false);
  });

  it("embed returns a vector of 384 dimensions", async () => {
    const vector = await embedding.embed("テストテキスト", "passage");
    expect(vector).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(vector.every((v) => typeof v === "number")).toBe(true);
    // ベクトルがゼロでないことを確認
    expect(vector.some((v) => v !== 0)).toBe(true);
  });

  it("embed returns normalized vector (L2 norm ≈ 1)", async () => {
    const vector = await embedding.embed("normalization test", "passage");
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 2);
  });

  it("embedBatch returns vectors for all inputs", async () => {
    const texts = ["first text", "second text", "third text"];
    const vectors = await embedding.embedBatch(texts, "passage");
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
    ], "passage");

    // コサイン類似度を計算
    const cosine = (a: number[], b: number[]) =>
      a.reduce((sum, ai, i) => sum + ai * b[i], 0);

    const simAB = cosine(vecA, vecB); // 類似テキスト
    const simAC = cosine(vecA, vecC); // 非類似テキスト

    expect(simAB).toBeGreaterThan(simAC);
  });

  it("同じ日本語クエリでも passage/query でプレフィックスが変わり異なるベクトルになる（非対称プレフィックスが実際に配線されている証明）", async () => {
    const text = "本番APIのURLはどこ？";
    const asPassage = await embedding.embed(text, "passage");
    const asQuery = await embedding.embed(text, "query");
    expect(asPassage).not.toEqual(asQuery);
  });

  it("embed throws on empty string", async () => {
    await expect(embedding.embed("", "passage")).rejects.toThrow();
  });

  it("embedBatch throws on empty array", async () => {
    await expect(embedding.embedBatch([], "passage")).rejects.toThrow();
  });
});
