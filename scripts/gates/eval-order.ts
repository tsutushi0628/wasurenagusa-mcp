#!/usr/bin/env node
/**
 * scripts/gates/eval-order.ts
 * 本番順位（順序）評価ハーネス（B2/B4 評価土台のCORE・design-b2b4-golden-eval-harness.md §3）。
 *
 * eval-golden.ts（recall中心・legacy rankLikeProduction 再ソート）とは別経路。順序系メトリクス
 * （MRR・nDCG@10・rankPrecision@expectedRankMax）は「searchHybrid().results が本番で返すその順序
 * そのもの」から算出する（不変条件I1）。legacy の rankLikeProduction は distance で再ソートし
 * rrfScore/timeDecay を捨てるため、順序メトリクスをそこに載せてはならない。本ハーネスは
 * searchHybrid の融合式を一切複製せず、SearchFusionTuning シーム経由で A/B 変種を走らせる。
 *
 * 順序メトリクスはこのラウンドでは「記録層」であり合否ゲートではない（不変条件I4）。
 * g2-search の recall@5 > baseline(0.568) が合否権威のまま。
 *
 * Usage:
 *   node --experimental-specifier-resolution=node --loader ts-node/esm \
 *     scripts/gates/eval-order.ts --store <memoryPath> --golden <goldenQueriesJsonl> \
 *     [--rrf-k 60] [--half-life 90] [--pool 50] [--list-weights 1,1] [--out <path>]
 *
 * 出力契約: ゴールデンID・クラス・件数・順位・真偽値・スコアのみ。クエリ本文・記憶本文・
 * タイトルは一切出力しない（エラーメッセージは伏字置換して載せる）。
 */

import { join } from "path";
import { existsSync, readFileSync, writeFileSync, rmSync } from "fs";
import { createHash } from "crypto";

import { parseArgs } from "../backup-store.js";
import { SQLiteStorage, type SearchFusionTuning } from "../../src/storage/sqlite.js";
import { LocalEmbedding } from "../../src/vector/local-embedding.js";
import { config, getModelsDir } from "../../src/config.js";
import {
  loadGoldenQueries,
  sanitizeErrorMessage,
  evaluateRunIntegrity,
  freezeSafeCopy,
  type RunIntegrity,
} from "./eval-golden.js";
// 順序メトリクスの純粋定義は葉モジュール eval-shared.ts に集約（eval-golden との相互import＝
// 循環を断つため。eval-order → eval-shared / eval-order → eval-golden の片方向依存）。
import {
  evaluateOrderOutcome,
  summarizeOrder,
  NDCG_K,
  type OrderOutcome,
  type OrderSummary,
} from "./eval-shared.js";

/** 順序評価の読み取りlimit。searchHybridは全候補を確定順に並べてからsliceするため、本番順序は
 *  limit不変（top-Nを読んでも「本番が返す順序そのもの」を損なわない）。nDCG@10を安定に読むため
 *  50件読む（design §3）。合否ゲートではなく記録層のため、この値は凍結recallベースラインに影響しない。 */
export const ORDER_EVAL_LIMIT = 50;

// 順序メトリクスの純粋定義（computeNdcgAtK / resolveExpectedRankMax / evaluateOrderOutcome /
// summarizeOrder と OrderOutcome / OrderSummary 型、定数 NDCG_K・DEFAULT_EXPECTED_RANK_MAX）は
// 葉モジュール eval-shared.ts へ移設した（eval-golden との循環importを断つため）。上のimport参照。

// ============================================================
// 収集（I/O）
// ============================================================

export interface OrderRunResult {
  outcomes: OrderOutcome[];
  failures: { golden: string; error: string }[];
}

/**
 * ゴールデンセットを本番検索経路（searchHybrid().results）に通し、その返却順序そのものから
 * 順序メトリクスを測る。tuning を渡すと SearchFusionTuning シーム経由でA/B変種を走らせる
 * （融合式は複製しない）。rankLikeProduction は一切呼ばない（不変条件I1）。
 */
export async function runOrderEval(
  storePath: string,
  goldenPath: string,
  tuning?: SearchFusionTuning,
): Promise<OrderRunResult> {
  const goldenQueries = loadGoldenQueries(goldenPath);

  const dbPath = join(storePath, config.sqliteFile);
  if (!existsSync(dbPath)) {
    throw new Error(`ストアが存在しません: ${dbPath}`);
  }
  const storage = new SQLiteStorage(dbPath);
  storage.initialize(storePath);

  try {
    const localEmbedding = new LocalEmbedding(getModelsDir(storePath));
    await localEmbedding.initialize();
    if (!localEmbedding.isAvailable()) {
      throw new Error(
        "LocalEmbeddingが利用できません。FTS5フォールバックでの測定はベースライン定義と異なるため中止します",
      );
    }

    const outcomes: OrderOutcome[] = [];
    const failures: { golden: string; error: string }[] = [];

    for (const q of goldenQueries) {
      try {
        const queryEmbedding = await localEmbedding.embed(q.query, "query");
        // 本番順序そのもの: searchHybrid().results（再ソートを挟まない）。tuningはシーム経由。
        const result = storage.searchHybrid(
          { query: q.query, category: "all", limit: ORDER_EVAL_LIMIT },
          queryEmbedding,
          tuning,
        );
        outcomes.push(evaluateOrderOutcome(q, result.results.map((r) => r.id)));
      } catch (error) {
        failures.push({ golden: q.id, error: sanitizeErrorMessage((error as Error).message, q.query) });
      }
    }

    return { outcomes, failures };
  } finally {
    storage.close();
  }
}

// ============================================================
// レポート組み立て
// ============================================================

export interface OrderEvalReport {
  kind: "order-eval";
  /** 較正シームに渡した上書き（未指定＝本番定数）。順序メトリクスの再現条件を記録する。 */
  tuning: SearchFusionTuning | null;
  limit: number;
  ndcgK: number;
  summary: OrderSummary;
  integrity: RunIntegrity;
  /** 同順集団の同一性検証用（compare-order）。 */
  goldenSha256: string;
  snapshotSha256: string;
  generatedAt: string;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function buildOrderReport(
  run: OrderRunResult,
  goldenCount: number,
  tuning: SearchFusionTuning | null,
  goldenSha256: string,
  snapshotSha256: string,
): OrderEvalReport {
  return {
    kind: "order-eval",
    tuning,
    limit: ORDER_EVAL_LIMIT,
    ndcgK: NDCG_K,
    summary: summarizeOrder(run.outcomes),
    integrity: evaluateRunIntegrity(goldenCount, run.outcomes.length, run.failures.length),
    goldenSha256,
    snapshotSha256,
    generatedAt: new Date().toISOString(),
  };
}

// ============================================================
// CLI
// ============================================================

/** --list-weights "1,1" → [1,1]。空/未指定はundefined。不正な数値はthrow（無言のすり替え防止）。 */
export function parseListWeights(raw: string | undefined): number[] | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const parts = raw.split(",").map((s) => s.trim());
  const weights = parts.map((s) => {
    const n = Number(s);
    if (!Number.isFinite(n)) throw new Error(`--list-weights の値が数値でない: ${s}`);
    return n;
  });
  return weights;
}

/** CLI引数から SearchFusionTuning を組む。全て未指定なら null（本番定数＝ベースライン測定）。 */
export function buildTuningFromArgs(args: Record<string, string>): SearchFusionTuning | null {
  const tuning: SearchFusionTuning = {};
  if (args["rrf-k"] !== undefined) tuning.rrfK = Number(args["rrf-k"]);
  if (args["half-life"] !== undefined) tuning.halfLifeDays = Number(args["half-life"]);
  if (args["pool"] !== undefined) tuning.poolSize = Number(args["pool"]);
  const lw = parseListWeights(args["list-weights"]);
  if (lw !== undefined) tuning.listWeights = lw;
  return Object.keys(tuning).length === 0 ? null : tuning;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const storeArg = args["store"];
  const goldenArg = args["golden"];

  if (!storeArg || !goldenArg) {
    console.error(
      "Usage: eval-order.ts --store <memoryPath> --golden <goldenQueriesJsonl> " +
        "[--rrf-k N] [--half-life N] [--pool N] [--list-weights w1,w2] [--out path]",
    );
    process.exit(1);
    return;
  }

  const tuning = buildTuningFromArgs(args);
  const goldenCount = loadGoldenQueries(goldenArg).length;
  const goldenSha256 = sha256File(goldenArg);
  // 凍結原本のdbバイト列を同順集団アンカーとして評価前に採る（SQLite書き込みで変わる前）。
  const snapshotSha256 = sha256File(join(storeArg, config.sqliteFile));

  // 凍結原本を直接開かず使い捨てコピー上で評価する（凍結アンカー保護・eval-goldenと同型）。
  const { dir: copyDir, storeDir } = freezeSafeCopy(storeArg);
  let run: OrderRunResult;
  try {
    run = await runOrderEval(storeDir, goldenArg, tuning ?? undefined);
  } finally {
    rmSync(copyDir, { recursive: true, force: true });
  }

  const report = buildOrderReport(run, goldenCount, tuning, goldenSha256, snapshotSha256);

  for (const f of run.failures) {
    console.log(JSON.stringify({ golden: f.golden, result: "ERROR", error: f.error }));
  }
  const outPath = args["out"];
  if (outPath) {
    writeFileSync(outPath, JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify(report));

  const s = report.summary;
  console.log(
    `\n== eval-order 順序メトリクス（記録層・合否ゲートでない）: ` +
      `MRR=${s.mrr} nDCG@10=${s.ndcgAt10} rankPrecision=${s.rankPrecision} ` +
      `recall@1=${s.recallAt1} recall@5=${s.recallAt5} recall@10=${s.recallAt10} ` +
      `(golden=${goldenCount}, processed=${run.outcomes.length}, failed=${run.failures.length}, ` +
      `tuning=${tuning ? "override" : "production-default"}) ==`,
  );
  process.exitCode = report.integrity.result === "PASS" ? 0 : 1;
}

if (process.argv[1] && process.argv[1].endsWith("eval-order.ts")) {
  main().catch((error) => {
    console.error("eval-order 失敗:", error);
    process.exit(1);
  });
}
