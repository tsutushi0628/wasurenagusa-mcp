#!/usr/bin/env node
/**
 * scripts/gates/eval-golden.ts
 * ゴールデンセット評価（design.md Phase 2、タスク2.3）。
 * recall@1 / @5 / @10 と「正しくゼロ件」クラスの成績を、凍結スナップショットに対して測る。
 *
 * 検証役（qa-engineer）専用資産。実装者は編集しない（G0/G1と同じ運用方針）。
 *
 * Usage:
 *   node --experimental-specifier-resolution=node --loader ts-node/esm \
 *     scripts/gates/eval-golden.ts --store <memoryPath> --golden <goldenQueriesJsonl>
 *
 * 設計方針:
 * - 本番検索の読み取り経路（src/tools/search.ts handleMemorySearch）を「書き込みなし」で
 *   忠実に合成する: embed(query,"query") → searchHybrid → searchVectors distanceマップ →
 *   SearchScorer再ソート。本番経路にある2つの書き込み（incrementAccessCount、critical昇格の
 *   storage.save）と運用ログ（logOperation/counters）は、凍結コーパスを変異させるため意図的に
 *   省く。省いた書き込みはランキング計算の入力に影響しない（アクセス計数は次回検索から効く
 *   遅延効果のため、単発評価では省いても本番ランキングと一致する）。
 * - matchQueryToTags / computeDaysSinceAccess は src/tools/search.ts のモジュール私有関数の
 *   複製（Restrictions「実装者のコードを修正しない」ため export 追加をせず複製する。式は
 *   src/tools/search.ts:49-71 と同一。複製元が変わったらこちらも追随すること）。
 * - 評価は limit=10 の1回実行で行い、同一ランキングから recall@1/@5/@10 を読む
 *   （limit=5実行のtop5とはsearchHybridの刈り込み位置が異なりうるが、G2の新旧比較を
 *   同一条件で行う限り公平。この定義自体を凍結する）。
 * - embedding が使えない場合は FTS5 フォールバックせず即FAILで停止する（ベースラインは
 *   ハイブリッド経路の成績と定義するため。フォールバック測定は無言の条件すり替えになる）。
 * - 出力はゴールデンID（GQ-xxx）・クラス・件数・順位・真偽値のみ。クエリ本文・記憶本文・
 *   タイトルは一切出力しない（エラーメッセージ中に本文が混入しうるため伏字置換する）。
 * - 各クエリの失敗は握りつぶさず failed に計数し、1件でもあれば run-integrity FAIL・
 *   exitCode 1 とする（沈黙成功の禁止）。
 * - 「収集（I/O）」と「評価（純粋関数）」を分離し、評価関数は合成データで単体テストできる
 *   （G0/G1と同型）。
 */

import { join, relative } from "path";
import { existsSync, readFileSync, mkdtempSync, cpSync, rmSync, symlinkSync, statSync } from "fs";
import { tmpdir } from "os";

import { parseArgs, EXCLUDED_DIR_NAMES } from "../backup-store.js";
import { SQLiteStorage } from "../../src/storage/sqlite.js";
import { LocalEmbedding } from "../../src/vector/local-embedding.js";
import { TIER_THRESHOLDS } from "../../src/vector/memory-tier.js";
import { SearchScorer } from "../../src/vector/search-scorer.js";
import { parseWeightedTags } from "../../src/vector/weighted-tag.js";
import { config, getModelsDir } from "../../src/config.js";
import type { MemoryIndexEntry } from "../../src/types.js";

/** 評価実行のlimit（recall@10まで読むため）。この値の変更は評価定義の変更＝比較原点の無効化。 */
export const EVAL_LIMIT = 10;

// ============================================================
// ゴールデンセットの型と読み込み
// ============================================================

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
 * golden-queries.jsonl を読み込み、形式検証する。不正行は黙ってスキップせず即throwする
 * （欠けたまま測ると成績の分母が静かに変わるため）。
 */
export function loadGoldenQueries(path: string): GoldenQuery[] {
  if (!existsSync(path)) {
    throw new Error(`ゴールデンセットが存在しません: ${path}`);
  }
  const lines = readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  const seen = new Set<string>();
  return lines.map((line, i) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`ゴールデンセット${i + 1}行目がJSONとして不正: ${(error as Error).message}`);
    }
    const q = parsed as GoldenQuery;
    if (!q.id || typeof q.query !== "string" || q.query.length === 0) {
      throw new Error(`ゴールデンセット${i + 1}行目: id/queryが不正`);
    }
    if (q.expect !== "hit" && q.expect !== "correct-zero") {
      throw new Error(`ゴールデンセット${i + 1}行目(${q.id}): expectが不正（${String(q.expect)}）`);
    }
    if (!Array.isArray(q.expectedIds)) {
      throw new Error(`ゴールデンセット${i + 1}行目(${q.id}): expectedIdsが配列でない`);
    }
    if (q.expect === "hit" && q.expectedIds.length === 0) {
      throw new Error(`ゴールデンセット${i + 1}行目(${q.id}): hit期待なのにexpectedIdsが空`);
    }
    if (q.expect === "correct-zero" && q.expectedIds.length > 0) {
      throw new Error(`ゴールデンセット${i + 1}行目(${q.id}): correct-zeroなのにexpectedIdsが非空`);
    }
    if (seen.has(q.id)) {
      throw new Error(`ゴールデンセット${i + 1}行目: id重複（${q.id}）`);
    }
    seen.add(q.id);
    return q;
  });
}

// ============================================================
// 本番ランキングの読み取り専用複製
// ============================================================

/** src/tools/search.ts:49-53 の複製（実装者コード不変更のため）。nowはテスト決定性のための注入点で、
 *  既定値では複製元と同一挙動。 */
export function computeDaysSinceAccess(lastAccessedAt: string, now: number = Date.now()): number {
  const lastAccess = new Date(lastAccessedAt).getTime();
  return Math.max(0, (now - lastAccess) / (1000 * 60 * 60 * 24));
}

/** src/tools/search.ts:55-71 の複製（実装者コード不変更のため）。 */
export function matchQueryToTags(query: string, tags: string[]): number[] {
  const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const weightedTags = parseWeightedTags(tags);
  const matchedWeights: number[] = [];

  for (const wt of weightedTags) {
    const tagLower = wt.tag.toLowerCase();
    for (const term of queryTerms) {
      if (tagLower.includes(term) || term.includes(tagLower)) {
        matchedWeights.push(wt.weight);
        break;
      }
    }
  }

  return matchedWeights;
}

export interface RankInputs {
  query: string;
  entries: MemoryIndexEntry[];
  vectorDistanceMap: Map<string, number>;
  metadata: Map<string, { lastAccessedAt: string; accessCount: number }>;
  predictionErrors: Map<string, number>;
  now?: number;
}

/**
 * src/tools/search.ts:164-198 のSearchScorer再ソートの複製（読み取り専用・書き込みなし）。
 * 入力を全て引数で受ける純粋関数（I/O分離）。
 */
export function rankLikeProduction(inputs: RankInputs): MemoryIndexEntry[] {
  const { query, entries, vectorDistanceMap, metadata, predictionErrors, now } = inputs;
  const scored = entries.map((entry) => {
    const meta = metadata.get(entry.id);
    const distance = vectorDistanceMap.get(entry.id);
    const vectorSimilarity = distance !== undefined ? 1 - distance : 1.0;
    const daysSinceLastAccess = meta ? computeDaysSinceAccess(meta.lastAccessedAt, now) : 0;
    const accessCount = meta ? meta.accessCount : 0;
    const matchedTagWeights = matchQueryToTags(query, entry.tags);

    const score = SearchScorer.score({
      vectorSimilarity,
      matchedTagWeights,
      daysSinceLastAccess,
      accessCount,
      predictionError: predictionErrors.get(entry.id),
    });

    return { entry, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.entry);
}

// ============================================================
// 評価（純粋関数）
// ============================================================

export interface QueryOutcome {
  golden: string;
  queryClass: string;
  expect: "hit" | "correct-zero";
  resultCount: number;
  /** ヒット期待: いずれかのexpectedIdの最良順位（1始まり）。圏外はnull。correct-zeroはnull。 */
  bestRank: number | null;
  hitAt1: boolean;
  hitAt5: boolean;
  hitAt10: boolean;
  /** correct-zero期待クエリが実際に0件だったか（hit期待クエリではnull） */
  zeroCorrect: boolean | null;
}

/** rankedIds中でexpectedIdsのいずれかが最初に現れる順位（1始まり）。現れなければnull。 */
export function bestExpectedRank(rankedIds: string[], expectedIds: string[]): number | null {
  const expected = new Set(expectedIds);
  for (let i = 0; i < rankedIds.length; i++) {
    if (expected.has(rankedIds[i])) return i + 1;
  }
  return null;
}

export function evaluateQueryOutcome(q: GoldenQuery, rankedIds: string[]): QueryOutcome {
  if (q.expect === "correct-zero") {
    return {
      golden: q.id,
      queryClass: q.queryClass,
      expect: q.expect,
      resultCount: rankedIds.length,
      bestRank: null,
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
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
    hitAt1: rank !== null && rank <= 1,
    hitAt5: rank !== null && rank <= 5,
    hitAt10: rank !== null && rank <= 10,
    zeroCorrect: null,
  };
}

export interface EvalSummary {
  hitQueries: number;
  recallAt1: number;
  recallAt5: number;
  recallAt10: number;
  zeroQueries: number;
  zeroCorrectCount: number;
  zeroCorrectRate: number;
  byClass: Record<string, { total: number; hitAt5: number; zeroCorrect: number }>;
}

/** recall@k = ヒット期待クエリのうちexpectedIdが上位k件に入った割合。正ゼロ率は別軸で数える。 */
export function summarizeOutcomes(outcomes: QueryOutcome[]): EvalSummary {
  const hits = outcomes.filter((o) => o.expect === "hit");
  const zeros = outcomes.filter((o) => o.expect === "correct-zero");
  const ratio = (n: number, d: number): number => (d === 0 ? 0 : Math.round((n / d) * 1000) / 1000);

  const byClass: Record<string, { total: number; hitAt5: number; zeroCorrect: number }> = {};
  for (const o of outcomes) {
    byClass[o.queryClass] ??= { total: 0, hitAt5: 0, zeroCorrect: 0 };
    byClass[o.queryClass].total += 1;
    if (o.hitAt5) byClass[o.queryClass].hitAt5 += 1;
    if (o.zeroCorrect === true) byClass[o.queryClass].zeroCorrect += 1;
  }

  return {
    hitQueries: hits.length,
    recallAt1: ratio(hits.filter((o) => o.hitAt1).length, hits.length),
    recallAt5: ratio(hits.filter((o) => o.hitAt5).length, hits.length),
    recallAt10: ratio(hits.filter((o) => o.hitAt10).length, hits.length),
    zeroQueries: zeros.length,
    zeroCorrectCount: zeros.filter((o) => o.zeroCorrect === true).length,
    zeroCorrectRate: ratio(zeros.filter((o) => o.zeroCorrect === true).length, zeros.length),
    byClass,
  };
}

export interface RunIntegrity {
  check: "eval-run-integrity";
  result: "PASS" | "FAIL";
  measured: { golden: number; processed: number; failed: number };
  threshold: { failedMax: 0; processedMustEqualGolden: true };
}

export function evaluateRunIntegrity(golden: number, processed: number, failed: number): RunIntegrity {
  return {
    check: "eval-run-integrity",
    result: failed === 0 && processed === golden ? "PASS" : "FAIL",
    measured: { golden, processed, failed },
    threshold: { failedMax: 0, processedMustEqualGolden: true },
  };
}

// ============================================================
// 収集（I/O）
// ============================================================

/** エラーメッセージにクエリ本文が混入しうるため伏字化する（本文非出力の契約）。 */
export function sanitizeErrorMessage(message: string, queryText: string): string {
  return queryText.length > 0 ? message.split(queryText).join("[query]") : message;
}

export interface RunResult {
  outcomes: QueryOutcome[];
  failures: { golden: string; error: string }[];
}

export async function runGoldenEval(storePath: string, goldenPath: string): Promise<RunResult> {
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

    const outcomes: QueryOutcome[] = [];
    const failures: { golden: string; error: string }[] = [];

    for (const q of goldenQueries) {
      try {
        const queryEmbedding = await localEmbedding.embed(q.query, "query");

        // 本番と同順: searchHybrid（RRF融合＋stateフィルタ＋limit刈り込み）
        const result = storage.searchHybrid(
          { query: q.query, category: "all", limit: EVAL_LIMIT },
          queryEmbedding,
        );

        // 本番と同源: searchVectorsのdistanceマップ（src/tools/search.ts:116-119）
        const vectorDistanceMap = new Map<string, number>();
        for (const vr of storage.searchVectors(queryEmbedding, TIER_THRESHOLDS.medium, EVAL_LIMIT)) {
          vectorDistanceMap.set(vr.id, vr.distance);
        }
        // 本番経路の書き込み（incrementAccessCount・critical昇格save）はここで意図的に実行しない

        const allIds = result.results.map((r) => r.id);
        const ranked = rankLikeProduction({
          query: q.query,
          entries: result.results,
          vectorDistanceMap,
          metadata: storage.getVectorMetadata(allIds),
          predictionErrors: storage.getPredictionErrors(allIds),
        });

        outcomes.push(evaluateQueryOutcome(q, ranked.map((e) => e.id)));
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
// CLI
// ============================================================

/** 直接実行(CLI)時の凍結保護: 原本ストアをSQLiteで開くと(migration/PRAGMA/WALチェックポイントで)
 *  memory.dbのバイト列が変わり凍結アンカーのsha256を壊す。runGoldenEvalはSQLiteStorageを
 *  読み書きで開くため、CLI経路では使い捨てコピー上で評価し原本を一切開かない(G2 freshCopyと同型)。
 *  models/(埋め込みモデル実体)はシンボリックリンクで原本参照し複製ゼロにする。
 *  G2内部呼び出しは runGoldenEval を直接importし、既にコピー済みstoreDirを渡すため本コピーは
 *  かからない(二重コピー回避)。 */
function freezeSafeCopy(storePath: string): { dir: string; storeDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "eval-golden-"));
  const storeDir = join(dir, ".wasurenagusa");
  cpSync(storePath, storeDir, {
    recursive: true,
    filter: (src: string) => {
      const relPath = relative(storePath, src);
      if (EXCLUDED_DIR_NAMES.has(relPath) && existsSync(src) && statSync(src).isDirectory()) return false;
      return true;
    },
  });
  for (const name of EXCLUDED_DIR_NAMES) {
    const originalDir = join(storePath, name);
    if (existsSync(originalDir)) symlinkSync(originalDir, join(storeDir, name), "dir");
  }
  return { dir, storeDir };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const storeArg = args["store"];
  const goldenArg = args["golden"];

  if (!storeArg || !goldenArg) {
    console.error("Usage: eval-golden.ts --store <memoryPath> --golden <goldenQueriesJsonl>");
    process.exit(1);
    return;
  }

  const goldenCount = loadGoldenQueries(goldenArg).length;
  // 凍結原本を直接開かず使い捨てコピー上で評価する(凍結アンカー保護)。評価データは同一。
  const { dir: copyDir, storeDir } = freezeSafeCopy(storeArg);
  let outcomes: RunResult["outcomes"];
  let failures: RunResult["failures"];
  try {
    ({ outcomes, failures } = await runGoldenEval(storeDir, goldenArg));
  } finally {
    rmSync(copyDir, { recursive: true, force: true });
  }

  for (const o of outcomes) {
    console.log(JSON.stringify(o));
  }
  for (const f of failures) {
    console.log(JSON.stringify({ golden: f.golden, result: "ERROR", error: f.error }));
  }

  const summary = summarizeOutcomes(outcomes);
  const integrity = evaluateRunIntegrity(goldenCount, outcomes.length, failures.length);
  console.log(JSON.stringify({ metric: "baseline-summary", measured: summary }));
  console.log(JSON.stringify(integrity));

  console.log(
    `\n== eval-golden ベースライン: recall@1=${summary.recallAt1} recall@5=${summary.recallAt5} ` +
      `recall@10=${summary.recallAt10} 正ゼロ=${summary.zeroCorrectCount}/${summary.zeroQueries} ` +
      `(golden=${goldenCount}, processed=${outcomes.length}, failed=${failures.length}) ==`,
  );
  process.exitCode = integrity.result === "PASS" ? 0 : 1;
}

if (process.argv[1] && process.argv[1].endsWith("eval-golden.ts")) {
  main().catch((error) => {
    console.error("eval-golden 失敗:", error);
    process.exit(1);
  });
}
