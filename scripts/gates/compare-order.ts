#!/usr/bin/env node
/**
 * scripts/gates/compare-order.ts
 * 順序評価のA/B判定（B2/B4 評価土台のCORE・design-b2b4-golden-eval-harness.md §4）。
 *
 * eval-order.ts が出す2本のレポート（baseline vs candidate）を読み、機械可読なA/B判定を出す:
 *   - 集約メトリクス差分（candidate − baseline）: recall@1/5/10・MRR・nDCG@10・rankPrecision
 *   - 関連アイテムのクエリ別順位変化（改善/不変/悪化・純順位デルタ）
 *   - regressionFree: どのヒットクエリでも関連アイテムの最良順位が「2位以上」悪化していない
 *     （境界: 圏外は limit+1 に丸めて比較。1位ぶんの誤差は許容）
 *
 * regressionFree は本ラウンドでは助言的（非ブロッキング・不変条件I4）。合否権威は g2-search の
 * recall@5 > baseline のまま。ここでは exitCode で「集団不一致(2) / 回帰あり(1) / 清浄(0)」を示すが、
 * これは較正の意思決定支援であって本番ゲートではない。
 *
 * 同順集団の同一性（goldenSha256・snapshotSha256・limit・ndcgK）が食い違う2本は比較不能として
 * exitCode 2 で拒否する（異なる母集団の差分は無意味なため無言で通さない）。
 *
 * Usage:
 *   node --experimental-specifier-resolution=node --loader ts-node/esm \
 *     scripts/gates/compare-order.ts --baseline <baseline.json> --candidate <candidate.json> [--out <path>]
 */

import { existsSync, readFileSync, writeFileSync } from "fs";

import { parseArgs } from "../backup-store.js";
import type { OrderEvalReport } from "./eval-order.js";

/** 回帰許容の閾値（位置）。関連アイテムがこの位置数を超えて沈んだら回帰扱い。 */
export const REGRESSION_TOLERANCE = 1;

// ============================================================
// ロード・検証
// ============================================================

export function loadOrderReport(path: string): OrderEvalReport {
  if (!existsSync(path)) {
    throw new Error(`順序評価レポートが存在しません: ${path}`);
  }
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as OrderEvalReport;
  if (parsed.kind !== "order-eval") {
    throw new Error(`順序評価レポートでない（kind=${String((parsed as { kind?: string }).kind)}）: ${path}`);
  }
  return parsed;
}

export interface PopulationCheck {
  same: boolean;
  reasons: string[];
}

/** 同順集団の同一性を検証する。golden/snapshot/limit/ndcgK が全て一致で初めて比較可能。 */
export function checkSamePopulation(baseline: OrderEvalReport, candidate: OrderEvalReport): PopulationCheck {
  const reasons: string[] = [];
  if (baseline.goldenSha256 !== candidate.goldenSha256) reasons.push("goldenSha256 不一致（ゴールデンセットが異なる）");
  if (baseline.snapshotSha256 !== candidate.snapshotSha256) reasons.push("snapshotSha256 不一致（凍結スナップショットが異なる）");
  if (baseline.limit !== candidate.limit) reasons.push(`limit 不一致（${baseline.limit} vs ${candidate.limit}）`);
  if (baseline.ndcgK !== candidate.ndcgK) reasons.push(`ndcgK 不一致（${baseline.ndcgK} vs ${candidate.ndcgK}）`);
  return { same: reasons.length === 0, reasons };
}

// ============================================================
// 差分算出（純粋関数）
// ============================================================

/** 圏外(null)を limit+1 に丸めた順位。順位が良い(小さい)ほど良。 */
export function boundRank(rank: number | null, limit: number): number {
  return rank === null ? limit + 1 : rank;
}

export interface PerQueryRankDelta {
  golden: string;
  baselineRank: number | null;
  candidateRank: number | null;
  /** 丸め後デルタ = boundedBaseline − boundedCandidate（正=改善/上昇、負=悪化/下降）。 */
  netRankDelta: number;
  direction: "improved" | "unchanged" | "worsened";
  /** このクエリが回帰許容を超えて悪化したか（boundedCandidate − boundedBaseline > 許容）。 */
  regressed: boolean;
}

export interface AggregateDeltas {
  recallAt1: number;
  recallAt5: number;
  recallAt10: number;
  mrr: number;
  ndcgAt10: number;
  rankPrecision: number;
}

export interface RankChangeSummary {
  improved: number;
  unchanged: number;
  worsened: number;
  /** Σ(boundedBaseline − boundedCandidate)。正なら全体として順位が上昇。 */
  netRankDelta: number;
}

export interface CompareResult {
  kind: "order-compare";
  samePopulation: boolean;
  populationReasons: string[];
  limit: number;
  baselineTuning: OrderEvalReport["tuning"];
  candidateTuning: OrderEvalReport["tuning"];
  aggregateDeltas: AggregateDeltas;
  rankChange: RankChangeSummary;
  perQuery: PerQueryRankDelta[];
  /** どのヒットクエリも許容超の悪化をしていない（助言的・非ブロッキング）。 */
  regressionFree: boolean;
  generatedAt: string;
}

const round3 = (x: number): number => Math.round(x * 1000) / 1000;

/** 2本のレポートから、ヒット期待クエリの順位デルタと集約差分を算出する。 */
export function comparePerQuery(baseline: OrderEvalReport, candidate: OrderEvalReport, limit: number): PerQueryRankDelta[] {
  const bMap = baseline.summary.perQueryBestRank;
  const cMap = candidate.summary.perQueryBestRank;
  // ヒット期待クエリの母集合はperQueryBestRankのキー集合（両者一致のはず。和集合で漏れを検出）。
  const goldens = Array.from(new Set([...Object.keys(bMap), ...Object.keys(cMap)])).sort();
  return goldens.map((golden) => {
    const baselineRank = bMap[golden] ?? null;
    const candidateRank = cMap[golden] ?? null;
    const bb = boundRank(baselineRank, limit);
    const bc = boundRank(candidateRank, limit);
    const netRankDelta = bb - bc;
    const direction: PerQueryRankDelta["direction"] = netRankDelta > 0 ? "improved" : netRankDelta < 0 ? "worsened" : "unchanged";
    return {
      golden,
      baselineRank,
      candidateRank,
      netRankDelta,
      direction,
      regressed: bc - bb > REGRESSION_TOLERANCE,
    };
  });
}

export function compareReports(baseline: OrderEvalReport, candidate: OrderEvalReport): CompareResult {
  const pop = checkSamePopulation(baseline, candidate);
  const limit = baseline.limit;
  const perQuery = comparePerQuery(baseline, candidate, limit);

  const rankChange: RankChangeSummary = {
    improved: perQuery.filter((p) => p.direction === "improved").length,
    unchanged: perQuery.filter((p) => p.direction === "unchanged").length,
    worsened: perQuery.filter((p) => p.direction === "worsened").length,
    netRankDelta: perQuery.reduce((acc, p) => acc + p.netRankDelta, 0),
  };

  const bs = baseline.summary;
  const cs = candidate.summary;
  const aggregateDeltas: AggregateDeltas = {
    recallAt1: round3(cs.recallAt1 - bs.recallAt1),
    recallAt5: round3(cs.recallAt5 - bs.recallAt5),
    recallAt10: round3(cs.recallAt10 - bs.recallAt10),
    mrr: round3(cs.mrr - bs.mrr),
    ndcgAt10: round3(cs.ndcgAt10 - bs.ndcgAt10),
    rankPrecision: round3(cs.rankPrecision - bs.rankPrecision),
  };

  return {
    kind: "order-compare",
    samePopulation: pop.same,
    populationReasons: pop.reasons,
    limit,
    baselineTuning: baseline.tuning,
    candidateTuning: candidate.tuning,
    aggregateDeltas,
    rankChange,
    perQuery,
    regressionFree: perQuery.every((p) => !p.regressed),
    generatedAt: new Date().toISOString(),
  };
}

// ============================================================
// CLI
// ============================================================

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const baselineArg = args["baseline"];
  const candidateArg = args["candidate"];

  if (!baselineArg || !candidateArg) {
    console.error("Usage: compare-order.ts --baseline <baseline.json> --candidate <candidate.json> [--out path]");
    process.exit(1);
    return;
  }

  const baseline = loadOrderReport(baselineArg);
  const candidate = loadOrderReport(candidateArg);
  const result = compareReports(baseline, candidate);

  const outPath = args["out"];
  if (outPath) {
    writeFileSync(outPath, JSON.stringify(result, null, 2));
  }
  console.log(JSON.stringify(result));

  const d = result.aggregateDeltas;
  console.log(
    `\n== compare-order（助言・非ブロッキング）: samePopulation=${result.samePopulation} ` +
      `regressionFree=${result.regressionFree} | Δrecall@5=${d.recallAt5} ΔMRR=${d.mrr} ` +
      `ΔnDCG@10=${d.ndcgAt10} ΔrankPrecision=${d.rankPrecision} | ` +
      `改善=${result.rankChange.improved} 不変=${result.rankChange.unchanged} 悪化=${result.rankChange.worsened} ` +
      `純順位デルタ=${result.rankChange.netRankDelta} ==`,
  );

  // exitCode: 集団不一致=2（比較不能）／回帰あり=1／清浄=0。合否権威でなく較正の意思決定支援。
  if (!result.samePopulation) {
    console.error("集団不一致のため比較不能:", result.populationReasons.join("; "));
    process.exitCode = 2;
  } else {
    process.exitCode = result.regressionFree ? 0 : 1;
  }
}

if (process.argv[1] && process.argv[1].endsWith("compare-order.ts")) {
  main().catch((error) => {
    console.error("compare-order 失敗:", error);
    process.exit(1);
  });
}
