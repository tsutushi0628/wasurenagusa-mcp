/**
 * scripts/gates/eval-shared.ts
 * 順序評価の純粋メトリクス層（eval-golden.ts と eval-order.ts が共有する葉モジュール）。
 *
 * 循環importを断つための土台: eval-golden.ts（recall中心・legacy再ソート）と eval-order.ts
 * （本番順序メトリクス）はどちらもここに片方向で依存する。このモジュールは eval-golden.ts /
 * eval-order.ts を一切importしない真の葉であり、fs/path 等のI/Oも持たない純粋関数のみを置く。
 *
 * ここに置くのは「本番順序 searchHybrid().results から算出する順序メトリクス」の純粋定義:
 *   GoldenQuery（ゴールデン設問の形）／OrderOutcome・OrderSummary（順序メトリクスの型）／
 *   computeNdcgAtK・resolveExpectedRankMax・evaluateOrderOutcome・summarizeOrder。
 * ゴールデン読み込み・整合検査・凍結コピー等のローダ群は eval-golden.ts に残す（葉に持ち込まない）。
 */

/** expectedRankMax未指定クエリの既定上限（rankPrecisionの分母定義）。 */
export const DEFAULT_EXPECTED_RANK_MAX = 5;
/** nDCGの打ち切り位置。 */
export const NDCG_K = 10;

export interface GoldenQuery {
  id: string;
  query: string;
  queryClass: string;
  expect: "hit" | "correct-zero";
  expectedIds: string[];
  expectedRankMax?: number;
  sourceNote?: string;
  validityNote?: string;
}

/**
 * rankedIds中でexpectedIdsのいずれかが最初に現れる順位（1始まり）。現れなければnull。
 * 純粋関数（Set構築と線形走査のみ・I/O／ゴールデン読み込み／モジュール状態への依存なし）。
 * 順序評価の順位探索ロジックはこの葉モジュールを単一真実源とし、eval-golden.ts は本関数を
 * 再輸出して従来の importer（g2-search.ts / eval-golden.test.ts 等）を無改変で保つ。
 */
export function bestExpectedRank(rankedIds: string[], expectedIds: string[]): number | null {
  const expected = new Set(expectedIds);
  for (let i = 0; i < rankedIds.length; i++) {
    if (expected.has(rankedIds[i])) return i + 1;
  }
  return null;
}

/**
 * 二値関連度のnDCG@k。rel_i = rankedIds[i]∈expectedIds ? 1 : 0。
 * DCG@k = Σ_{i=0}^{k-1} rel_i / log2(i+2)、IDCG@k = 理想配置（関連を先頭に詰めた）でのDCG@k。
 * IDCG=0（関連ゼロ）のとき0を返す。1始まりでなく0始まりindex（log2(i+2)）で定義する。
 */
export function computeNdcgAtK(rankedIds: string[], expectedIds: string[], k: number): number {
  const expected = new Set(expectedIds);
  let dcg = 0;
  const upto = Math.min(k, rankedIds.length);
  for (let i = 0; i < upto; i++) {
    if (expected.has(rankedIds[i])) {
      dcg += 1 / Math.log2(i + 2);
    }
  }
  const idealHits = Math.min(k, expected.size);
  let idcg = 0;
  for (let i = 0; i < idealHits; i++) {
    idcg += 1 / Math.log2(i + 2);
  }
  return idcg === 0 ? 0 : dcg / idcg;
}

export interface OrderOutcome {
  golden: string;
  queryClass: string;
  expect: "hit" | "correct-zero";
  resultCount: number;
  /** 本番順序（searchHybrid().results そのもの）でのexpectedId最良順位（1始まり）。圏外/correct-zeroはnull。 */
  bestRank: number | null;
  /** MRR用。bestRankの逆数。圏外/correct-zeroは0。 */
  reciprocalRank: number;
  ndcgAt10: number;
  hitAt1: boolean;
  hitAt5: boolean;
  hitAt10: boolean;
  /** このクエリのrankPrecision判定に使った上限（expectedRankMax ?? 既定）。 */
  expectedRankMax: number;
  /** bestRank <= expectedRankMax か（hit期待のみ意味を持つ。correct-zeroはfalse）。 */
  rankPrecisionHit: boolean;
  /** correct-zero期待が実際に0件だったか（hit期待はnull）。 */
  zeroCorrect: boolean | null;
}

/** GoldenQueryの解決済みexpectedRankMax（未指定なら既定）。 */
export function resolveExpectedRankMax(q: GoldenQuery): number {
  return q.expectedRankMax ?? DEFAULT_EXPECTED_RANK_MAX;
}

/** 本番順序のID列（searchHybrid().results.map(id)）を受け、順序メトリクスを算出する純粋関数。 */
export function evaluateOrderOutcome(q: GoldenQuery, rankedIds: string[]): OrderOutcome {
  const expectedRankMax = resolveExpectedRankMax(q);
  if (q.expect === "correct-zero") {
    return {
      golden: q.id,
      queryClass: q.queryClass,
      expect: q.expect,
      resultCount: rankedIds.length,
      bestRank: null,
      reciprocalRank: 0,
      ndcgAt10: 0,
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      expectedRankMax,
      rankPrecisionHit: false,
      zeroCorrect: rankedIds.length === 0,
    };
  }
  const rank = bestExpectedRank(rankedIds, q.expectedIds);
  return {
    golden: q.id,
    queryClass: q.queryClass,
    expect: q.expect,
    resultCount: rankedIds.length,
    bestRank: rank,
    reciprocalRank: rank === null ? 0 : 1 / rank,
    ndcgAt10: computeNdcgAtK(rankedIds, q.expectedIds, NDCG_K),
    hitAt1: rank !== null && rank <= 1,
    hitAt5: rank !== null && rank <= 5,
    hitAt10: rank !== null && rank <= 10,
    expectedRankMax,
    rankPrecisionHit: rank !== null && rank <= expectedRankMax,
    zeroCorrect: null,
  };
}

export interface OrderSummary {
  hitQueries: number;
  recallAt1: number;
  recallAt5: number;
  recallAt10: number;
  /** ヒット期待クエリ平均のMean Reciprocal Rank（本番順序基準）。 */
  mrr: number;
  /** ヒット期待クエリ平均のnDCG@10。 */
  ndcgAt10: number;
  /** ヒット期待クエリのうち bestRank<=expectedRankMax の割合。 */
  rankPrecision: number;
  /** ゴールデンID→本番順序でのbestRank（compare-orderの同順集団比較の入力）。 */
  perQueryBestRank: Record<string, number | null>;
  zeroQueries: number;
  zeroCorrectCount: number;
  zeroCorrectRate: number;
  byClass: Record<string, { total: number; hitAt5: number; rankPrecisionHit: number; zeroCorrect: number }>;
}

const round3 = (x: number): number => Math.round(x * 1000) / 1000;

export function summarizeOrder(outcomes: OrderOutcome[]): OrderSummary {
  const hits = outcomes.filter((o) => o.expect === "hit");
  const zeros = outcomes.filter((o) => o.expect === "correct-zero");
  const ratio = (n: number, d: number): number => (d === 0 ? 0 : round3(n / d));
  const mean = (vals: number[]): number => (vals.length === 0 ? 0 : round3(vals.reduce((a, b) => a + b, 0) / vals.length));

  const byClass: OrderSummary["byClass"] = {};
  const perQueryBestRank: Record<string, number | null> = {};
  for (const o of outcomes) {
    byClass[o.queryClass] ??= { total: 0, hitAt5: 0, rankPrecisionHit: 0, zeroCorrect: 0 };
    byClass[o.queryClass].total += 1;
    if (o.hitAt5) byClass[o.queryClass].hitAt5 += 1;
    if (o.rankPrecisionHit) byClass[o.queryClass].rankPrecisionHit += 1;
    if (o.zeroCorrect === true) byClass[o.queryClass].zeroCorrect += 1;
    if (o.expect === "hit") perQueryBestRank[o.golden] = o.bestRank;
  }

  return {
    hitQueries: hits.length,
    recallAt1: ratio(hits.filter((o) => o.hitAt1).length, hits.length),
    recallAt5: ratio(hits.filter((o) => o.hitAt5).length, hits.length),
    recallAt10: ratio(hits.filter((o) => o.hitAt10).length, hits.length),
    mrr: mean(hits.map((o) => o.reciprocalRank)),
    ndcgAt10: mean(hits.map((o) => o.ndcgAt10)),
    rankPrecision: ratio(hits.filter((o) => o.rankPrecisionHit).length, hits.length),
    perQueryBestRank,
    zeroQueries: zeros.length,
    zeroCorrectCount: zeros.filter((o) => o.zeroCorrect === true).length,
    zeroCorrectRate: ratio(zeros.filter((o) => o.zeroCorrect === true).length, zeros.length),
    byClass,
  };
}
