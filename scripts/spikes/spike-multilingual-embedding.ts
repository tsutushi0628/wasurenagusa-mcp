/**
 * spike-multilingual-embedding: 差替え候補モデルの実在確認スパイク（タスク1.1）
 *
 * 目的: モデル差替え判断（タスク1.8、コミット a9cb7ab・2026-07-04）の前提事実を、
 * 差替え後の本セッションで遡って固定する。各候補モデルを @huggingface/transformers で
 * 実際にロードし、次元数と日本語文ペア（類似ペア／非類似ペア）の類似度サンプルを
 * 実行確認する。ロード不可（ONNX未提供・取得失敗）の候補は候補から外す。
 *
 * 候補:
 *  - Xenova/all-MiniLM-L6-v2 （旧デフォルト。英語中心、コミットa9cb7ab以前）
 *  - Xenova/multilingual-e5-small （現行デフォルト。コミットa9cb7ab採用）
 *  - Xenova/paraphrase-multilingual-MiniLM-L12-v2 （未採用の多言語代替候補）
 *
 * 本番ストア（memory.db）には一切接続・書き込みしない。モデル取得は使い捨ての
 * 一時ディレクトリのみに対して行う。既に本プロジェクトの .wasurenagusa/models 配下に
 * キャッシュ済みの2候補は、ネットワーク再取得を避けるため使い捨てディレクトリへ
 * 読み取り専用でコピーしてから使う（本番モデルキャッシュ自体への書き込みは発生しない）。
 *
 * 既存スパイク（spike-fts5-trigram.ts等）の自己完結（src/依存なし・ビルド不要で
 * そのまま実行できる）方針を踏襲し、cosine類似度とe5プレフィックス付与はこのファイル内で
 * 完結させる（本体実装は src/vector/cosine-distance.ts, src/vector/local-embedding.ts の
 * buildPrefixedText と同一ロジック）。
 *
 * Usage: npx ts-node --esm scripts/spikes/spike-multilingual-embedding.ts
 */

import { pipeline, env, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { mkdtempSync, rmSync, cpSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// src/vector/cosine-distance.ts の cosineDistance と同一ロジック（自己完結のため複製）。
// 1 - cosineDistance = コサイン類似度。
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// src/vector/local-embedding.ts の buildPrefixedText と同一ロジック（自己完結のため複製）。
function buildPrefixedText(text: string, usage: "passage" | "query"): string {
  const prefix = usage === "query" ? "query: " : "passage: ";
  return prefix + text;
}

interface CandidateResult {
  name: string;
  loadable: boolean;
  detail: string;
  dimensions?: number;
  similarSimilarity?: number;
  dissimilarSimilarity?: number;
}

// 日本語文ペア（固定・記憶本文は含まない一般文）: 類似ペアと非類似ペア
const SIMILAR_PAIR: [string, string] = [
  "今日は天気が良いので散歩に行った。",
  "天気が良かったので今日は外を歩いた。",
];
const DISSIMILAR_PAIR: [string, string] = [
  "今日は天気が良いので散歩に行った。",
  "この関数はSQLiteのトランザクションをロールバックする。",
];

// 本プロジェクトの既存モデルキャッシュ（読み取り専用の参照元。書き込みはしない）
const PROD_MODELS_DIR = join(process.cwd(), ".wasurenagusa", "models");

// e5系モデルは非対称プレフィックス（query:/passage:）が前提（src/vector/local-embedding.ts と同じ規約）。
// それ以外のモデルは無加工の文で埋め込む。
function isE5Family(modelName: string): boolean {
  return /e5/i.test(modelName);
}

function seedCacheIfAvailable(modelName: string, cacheDir: string): void {
  const src = join(PROD_MODELS_DIR, modelName);
  if (existsSync(src)) {
    const dest = join(cacheDir, modelName);
    cpSync(src, dest, { recursive: true });
  }
}

async function embedOne(extractor: FeatureExtractionPipeline, text: string): Promise<number[]> {
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array);
}

async function embedPair(
  extractor: FeatureExtractionPipeline,
  modelName: string,
  pair: [string, string],
): Promise<number[][]> {
  const texts = isE5Family(modelName)
    ? [buildPrefixedText(pair[0], "passage"), buildPrefixedText(pair[1], "passage")]
    : pair;
  return [await embedOne(extractor, texts[0]), await embedOne(extractor, texts[1])];
}

async function evaluateCandidate(modelName: string, cacheDir: string): Promise<CandidateResult> {
  seedCacheIfAvailable(modelName, cacheDir);

  env.cacheDir = cacheDir;
  env.allowRemoteModels = true;

  let extractor: FeatureExtractionPipeline;
  try {
    extractor = (await pipeline("feature-extraction", modelName, { dtype: "fp32" })) as FeatureExtractionPipeline;
  } catch (error) {
    return {
      name: modelName,
      loadable: false,
      detail: `ロード不可（ONNX提供なし、または取得失敗）: ${(error as Error).message}`,
    };
  }

  try {
    const [simA, simB] = await embedPair(extractor, modelName, SIMILAR_PAIR);
    const [disA, disB] = await embedPair(extractor, modelName, DISSIMILAR_PAIR);

    return {
      name: modelName,
      loadable: true,
      detail: "ロード成功",
      dimensions: simA.length,
      similarSimilarity: cosineSimilarity(simA, simB),
      dissimilarSimilarity: cosineSimilarity(disA, disB),
    };
  } catch (error) {
    return {
      name: modelName,
      loadable: false,
      detail: `ロードは成功したが埋め込み実行に失敗: ${(error as Error).message}`,
    };
  }
}

async function main(): Promise<void> {
  const candidates = [
    "Xenova/all-MiniLM-L6-v2",
    "Xenova/multilingual-e5-small",
    "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
  ];

  const tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-spike-embedding-"));
  const results: CandidateResult[] = [];

  try {
    for (const name of candidates) {
      console.log(`--- 候補: ${name} をロード中... ---`);
      results.push(await evaluateCandidate(name, tmpDir));
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log("\n=== spike-multilingual-embedding 実行結果 ===");
  for (const r of results) {
    if (r.loadable) {
      const gap = (r.similarSimilarity ?? 0) - (r.dissimilarSimilarity ?? 0);
      console.log(
        `[OK] ${r.name}: 次元数=${r.dimensions}, 類似ペア類似度=${r.similarSimilarity?.toFixed(4)}, ` +
          `非類似ペア類似度=${r.dissimilarSimilarity?.toFixed(4)}, 分離幅=${gap.toFixed(4)}`,
      );
    } else {
      console.log(`[NG] ${r.name}: ${r.detail}（候補から除外）`);
    }
  }

  const loadableCount = results.filter((r) => r.loadable).length;
  console.log(`\n合計 ${results.length}件中 ${loadableCount}件がロード可能（候補として有効）`);
}

main().catch((error) => {
  console.error("spike-multilingual-embedding 実行失敗:", error);
  process.exit(1);
});
