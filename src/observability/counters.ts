/**
 * 可観測性カウンタ（タスク0.9、design.md Phase 0 ⑥、R-M1）。
 *
 * 5指標（ゼロヒット率、注入トークン数、統合件数、ガードブロック件数、蘇生件数）を
 * JSONL追記で計測し、閾値超過をsnapshot()で判定する。計測はPhase 0で最初に出荷する
 * 計器であり、以降の全改修効果はこの計器で測る（R-M1）。
 *
 * 設計:
 * - increment() は1回の観測イベントをそのまま {ts, metric, value} としてJSONLへ追記する
 *   （既存の logs/operation-*.jsonl と同じ日付別ファイル・fail-open方針を踏襲。
 *   ファイル名は counters-YYYY-MM-DD.jsonl とし、既存の operation ログとは別ファイルにして
 *   既存ログ形式を壊さない）
 * - snapshot() がその日のJSONLを読み戻して集計し、閾値と比較したalertを付与する
 *   （design.mdの契約 `increment(metric, value)`、`snapshot(): Metrics` に対応）
 * - 計数の書き込み失敗は本処理を落とさない（fail-open）が、失敗自体はプロセス内メモリの
 *   カウンタで計上する（書き込み失敗の可視化。ディスク書き込みが失敗している状況で
 *   失敗をディスクに書こうとしても意味がないため、プロセス内カウンタに留める）
 */

import { appendFile, mkdir, readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { generateJstDatePart, generateJstTimestamp } from "../utils/operation-logger.js";

export type MetricName =
  | "search_total"
  | "search_zero_hit"
  | "injection_tokens"
  | "consolidation_count"
  | "guard_block_count"
  | "resurrection_count"
  | "write_failure_count"
  | "search_fallback_phrase"
  | "search_fallback_and"
  | "search_fallback_or"
  | "tag_enrich_failure_count"
  | "embedding_failure_count"
  | "llm_output_guard_warning"
  | "llm_output_batch_skip"
  | "injection_skipped_count";

export interface CounterEntry {
  ts: string;
  metric: MetricName;
  value: number;
}

export interface Thresholds {
  /** ゼロヒット率（0〜1）。この値を超えたらalert */
  zeroHitRate: number;
  /** ゼロヒット率のalert判定に必要な最小サンプル数（少数サンプルの誤警報防止） */
  zeroHitRateMinSamples: number;
  /** 注入トークン数の単発観測値。この値を超えたらalert */
  injectionTokens: number;
  /** 統合候補件数（1日の合計）。この値を超えたらalert */
  consolidationCount: number;
  /** ガードブロック件数（1日の合計）。この値を超えたらalert */
  guardBlockCount: number;
  /** 蘇生件数（その日の最大ゲージ読み）。この値以上でalert（設計上ゼロが正のため既定1） */
  resurrectionCount: number;
  /** DB書き込み失敗件数（1日の合計）。R-A5 AC3。設計上ゼロが正のため既定1（発生時点でalert） */
  writeFailureCount: number;
}

/**
 * 既定閾値。R-M1の計測を最初に出荷する段階の暫定値であり、実測データで再較正する
 * 前提の仮基準（design.md ゲートG3の「仮基準5%、確定値を出力に記録する」と同じ位置づけ）。
 * - injectionTokens: src/cli/context.ts の DEFAULT_INJECTION_TOKEN_BUDGET と同じ値。
 *   循環importを避けるためここでは値を複製する（Phase 4の注入ビルダ再設計で一本化予定）。
 */
export const DEFAULT_THRESHOLDS: Thresholds = {
  zeroHitRate: 0.5,
  zeroHitRateMinSamples: 10,
  injectionTokens: 8000,
  consolidationCount: 50,
  guardBlockCount: 5,
  resurrectionCount: 1,
  writeFailureCount: 1,
};

export interface ZeroHitRateSnapshot {
  totalSearches: number;
  zeroHitSearches: number;
  rate: number;
  alert: boolean;
}

export interface CountMetricSnapshot {
  /** その日の観測値の合計 */
  total: number;
  /** その日の観測値の最大値（単発の異常値を見逃さないため） */
  max: number;
  /** 記録された観測回数 */
  observations: number;
  alert: boolean;
}

/**
 * ゲージ系メトリクス（backfill-worker.tsの蘇生検出のように、毎回「現在の絶対値」を
 * 記録する計測）のスナップショット。加算イベント（sum）ではないため合計(total)は持たない
 * （同じ状態を複数回記録すると実行回数倍に水増しされ意味を失うため、意図的に除外している）。
 */
export interface GaugeMetricSnapshot {
  /** その日最後に記録された値（現在のゲージ読み） */
  latest: number;
  /** その日に観測された最大値 */
  max: number;
  /** 記録された観測回数 */
  observations: number;
  alert: boolean;
}

export interface MetricsSnapshot {
  zeroHitRate: ZeroHitRateSnapshot;
  injectionTokens: CountMetricSnapshot;
  consolidationCount: CountMetricSnapshot;
  guardBlockCount: CountMetricSnapshot;
  /** ゲージ系メトリクス（sumでは水増しされるためCountMetricSnapshotではなくGaugeMetricSnapshot） */
  resurrectionCount: GaugeMetricSnapshot;
  /** DB書き込み失敗件数（タスク1.12、R-A5 AC3）。SQLiteStorageの書き込み系メソッドが
   *  例外送出時に計上する。counterWriteFailureCount（カウンタ自身のJSONL書き込み失敗）とは別指標 */
  writeFailureCount: CountMetricSnapshot;
  /** カウンタ書き込み失敗件数（プロセス内計測、G0や警報がfail-open状況を拾えるように公開） */
  counterWriteFailureCount: number;
  /** その日のJSONL読み戻しで検出した壊れ行数（無言破棄せず可視化する） */
  corruptLineCount: number;
}

// 計数書き込み失敗のプロセス内カウンタ（fail-open時の可視化用）。
// ディスク書き込みが失敗している状況を前提にした指標のため、ディスクへは書かない。
let counterWriteFailureCount = 0;

export function getCounterWriteFailureCount(): number {
  return counterWriteFailureCount;
}

/** テスト専用: プロセス内失敗カウンタをリセットする */
export function resetCounterWriteFailureCountForTest(): void {
  counterWriteFailureCount = 0;
}

function getCountersLogFilePath(memoryPath: string, date: Date): string {
  return join(memoryPath, "logs", `counters-${generateJstDatePart(date)}.jsonl`);
}

/**
 * 1件の観測イベントをJSONLへ追記する。
 * 書き込み失敗は本処理を落とさない（fail-open）。失敗自体はプロセス内カウンタへ計上する。
 */
export async function increment(
  memoryPath: string,
  metric: MetricName,
  value: number = 1,
  now: Date = new Date(),
): Promise<void> {
  const entry: CounterEntry = { ts: generateJstTimestamp(now), metric, value };
  const line = JSON.stringify(entry) + "\n";
  const logsDir = join(memoryPath, "logs");
  const filePath = getCountersLogFilePath(memoryPath, now);

  try {
    await mkdir(logsDir, { recursive: true });
    await appendFile(filePath, line, "utf-8");
  } catch (error) {
    counterWriteFailureCount++;
    console.error("[observability] カウンタ書き込み失敗:", error);
  }
}

interface ReadTodayEntriesResult {
  entries: CounterEntry[];
  /** JSON.parseに失敗し読み飛ばした行数（無言破棄せずsnapshot()へ持ち帰る） */
  corruptLineCount: number;
}

/**
 * 既存ファイルの読込失敗（権限エラー等）はthrowで表面化させる（fail-loud）。
 * ファイル自体が未作成（その日まだ1件も記録が無い）はexistsSyncの早期returnで
 * 正常系として扱う（エラーではない）。
 */
async function readTodayEntries(memoryPath: string, now: Date): Promise<ReadTodayEntriesResult> {
  const filePath = getCountersLogFilePath(memoryPath, now);
  if (!existsSync(filePath)) return { entries: [], corruptLineCount: 0 };

  const raw = await readFile(filePath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const entries: CounterEntry[] = [];
  let corruptLineCount = 0;
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as CounterEntry);
    } catch {
      corruptLineCount++;
    }
  }
  return { entries, corruptLineCount };
}

/**
 * alert判定に使う比較方式。
 * - "sum"：1日の合計件数が閾値を超えたら異常（例: 統合候補件数・ガードブロック件数の
 *   累積活動量）
 * - "max"：単発の観測値そのものが閾値を超えたら異常（例: 1回のセッションの注入
 *   トークン数。日をまたぐ合算には意味がない）
 */
type AlertMode = "sum" | "max";

/**
 * alert判定の境界の扱い。
 * - "exclusive"：閾値を超えたら（>）異常
 * - "inclusive"：閾値以上で（>=）異常
 * メトリクス名でのハードコード分岐ではなく、呼び出し側（snapshot()）が指標ごとの
 * 設計意図として明示する（例: 蘇生件数は「ゼロが正」のため閾値到達そのものが異常＝inclusive）。
 */
type AlertBoundary = "inclusive" | "exclusive";

function summarizeCountMetric(
  entries: CounterEntry[],
  metric: MetricName,
  threshold: number,
  mode: AlertMode,
  boundary: AlertBoundary,
): CountMetricSnapshot {
  const values = entries.filter((e) => e.metric === metric).map((e) => e.value);
  const total = values.reduce((sum, v) => sum + v, 0);
  const max = values.length > 0 ? Math.max(...values) : 0;
  const comparisonValue = mode === "sum" ? total : max;
  return {
    total,
    max,
    observations: values.length,
    alert: boundary === "inclusive" ? comparisonValue >= threshold : comparisonValue > threshold,
  };
}

/**
 * ゲージ系メトリクス（backfill-worker.tsが毎回「現在の絶対値」を記録する蘇生件数）専用の集計。
 * sum（合計）は同じ状態を複数回記録すると実行回数倍に水増しされ意味を持たないため、
 * その日最後の読み（latest）とその日の最大値（max）のみで表す。
 */
function summarizeGaugeMetric(
  entries: CounterEntry[],
  metric: MetricName,
  threshold: number,
  boundary: AlertBoundary,
): GaugeMetricSnapshot {
  const values = entries.filter((e) => e.metric === metric).map((e) => e.value);
  const max = values.length > 0 ? Math.max(...values) : 0;
  const latest = values.length > 0 ? values[values.length - 1] : 0;
  return {
    latest,
    max,
    observations: values.length,
    alert: boundary === "inclusive" ? max >= threshold : max > threshold,
  };
}

/**
 * その日（JST）に記録された観測イベントを読み戻し、5指標に集計してalertを判定する。
 * 閾値は省略時 DEFAULT_THRESHOLDS を使う。
 */
export async function snapshot(
  memoryPath: string,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
  now: Date = new Date(),
): Promise<MetricsSnapshot> {
  const { entries, corruptLineCount } = await readTodayEntries(memoryPath, now);

  const totalSearches = entries
    .filter((e) => e.metric === "search_total")
    .reduce((sum, e) => sum + e.value, 0);
  const zeroHitSearches = entries
    .filter((e) => e.metric === "search_zero_hit")
    .reduce((sum, e) => sum + e.value, 0);
  const rate = totalSearches > 0 ? zeroHitSearches / totalSearches : 0;
  const zeroHitRate: ZeroHitRateSnapshot = {
    totalSearches,
    zeroHitSearches,
    rate,
    alert: totalSearches >= thresholds.zeroHitRateMinSamples && rate > thresholds.zeroHitRate,
  };

  return {
    zeroHitRate,
    injectionTokens: summarizeCountMetric(entries, "injection_tokens", thresholds.injectionTokens, "max", "exclusive"),
    consolidationCount: summarizeCountMetric(entries, "consolidation_count", thresholds.consolidationCount, "sum", "exclusive"),
    guardBlockCount: summarizeCountMetric(entries, "guard_block_count", thresholds.guardBlockCount, "sum", "exclusive"),
    resurrectionCount: summarizeGaugeMetric(entries, "resurrection_count", thresholds.resurrectionCount, "inclusive"),
    writeFailureCount: summarizeCountMetric(entries, "write_failure_count", thresholds.writeFailureCount, "sum", "inclusive"),
    counterWriteFailureCount: getCounterWriteFailureCount(),
    corruptLineCount,
  };
}
