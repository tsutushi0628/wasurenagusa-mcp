import { appendFile, lstat, mkdir, open, readdir, readFile, stat, unlink } from "fs/promises";
import { join } from "path";
import { generateJstDatePart, generateJstTimestamp } from "../utils/operation-logger.js";
import { increment } from "./counters.js";

/** JSONLの短縮キー: ts=時刻、k=行種別、ms=時間、tok=token数、miss=欠落数、st=段別時間、hash=イベントID、v=検出器版。 */
export const CORRECTION_HOOK_EVENT_KINDS = ["SessionStart", "UserPromptSubmit", "PreCompact", "Stop"] as const;
export const CORRECTION_REASON_CODES = ["action_unknown", "pending_unmatched", "always_not_emitted", "ledger_unknown", "automated_prompt"] as const;
export const CORRECTION_METRIC_STAGE_NAMES = ["stdin", "position", "detect", "store", "retrieve", "render", "write"] as const;

export type CorrectionHookEventKind = (typeof CORRECTION_HOOK_EVENT_KINDS)[number];
export type CorrectionReasonCode = (typeof CORRECTION_REASON_CODES)[number];
export type CorrectionMetricStageName = (typeof CORRECTION_METRIC_STAGE_NAMES)[number];
export type CorrectionMetricStageDurations = Record<CorrectionMetricStageName, number>;

export interface CorrectionMetricInput {
  eventKind: CorrectionHookEventKind;
  durationMs: number;
  tokens: number;
  missingCount: number;
  eventIdHash?: string;
  detectorVersion?: string;
  reasonCode?: CorrectionReasonCode;
  stageDurationsMs?: CorrectionMetricStageDurations;
}

export type CorrectionMetricWriteResult = "recorded" | "omitted" | "failed";

const MAX_DAILY_SAMPLES = 1000;
const MAX_RECORD_BYTES = 256;
const MAX_STAGE_DURATION_MS = 9999;
const RETENTION_DAYS = 30;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const METRIC_INPUT_KEYS = new Set([
  "eventKind",
  "durationMs",
  "tokens",
  "missingCount",
  "eventIdHash",
  "detectorVersion",
  "reasonCode",
  "stageDurationsMs",
]);
const EVENT_ID_HASH_PATTERN = /^[a-f0-9]{16,64}$/;
const DETECTOR_VERSION_PATTERN = /^v\d+(?:\.\d+){0,2}$/;
const METRIC_FILE_PATTERN = /^(SessionStart|UserPromptSubmit|PreCompact|Stop)-(\d{4}-\d{2}-\d{2})\.jsonl$/;

interface MetricFileEntry {
  ts: string;
  k: "sample" | "omitted" | "violation";
  ms?: number;
  tok?: number;
  miss?: number;
  st?: readonly [number, number, number, number, number, number, number];
  hash?: string;
  v?: string;
  reason_code?: CorrectionReasonCode;
  total_count?: number;
  omitted_count?: number;
}

interface MetricFileCounts {
  sampleCount: number;
  omittedCount: number;
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function getLogsDirectory(memoryPath: string): string {
  return join(memoryPath, "logs");
}

function getMetricsDirectory(memoryPath: string): string {
  return join(getLogsDirectory(memoryPath), "correction-metrics");
}

function getMetricFilePath(memoryPath: string, eventKind: CorrectionHookEventKind, now: Date): string {
  return join(getMetricsDirectory(memoryPath), `${eventKind}-${generateJstDatePart(now)}.jsonl`);
}

function validateInput(input: CorrectionMetricInput): void {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Invalid correction metric input");
  }

  for (const key of Object.keys(input)) {
    if (!METRIC_INPUT_KEYS.has(key)) throw new Error("Invalid correction metric input");
  }

  if (!CORRECTION_HOOK_EVENT_KINDS.includes(input.eventKind)) throw new Error("Invalid correction metric input");
  if (!Number.isSafeInteger(input.durationMs) || input.durationMs < 0) throw new Error("Invalid correction metric input");
  if (!Number.isSafeInteger(input.tokens) || input.tokens < 0) throw new Error("Invalid correction metric input");
  if (!Number.isSafeInteger(input.missingCount) || input.missingCount < 0) throw new Error("Invalid correction metric input");
  const stageMetricsRequired = input.eventKind === "SessionStart" || input.eventKind === "UserPromptSubmit";
  const stageDurationsMs = input.stageDurationsMs;
  if (stageMetricsRequired && stageDurationsMs === undefined) throw new Error("Invalid correction metric input");
  if (stageDurationsMs !== undefined) {
    if (typeof stageDurationsMs !== "object" || stageDurationsMs === null || Array.isArray(stageDurationsMs)) {
      throw new Error("Invalid correction metric input");
    }
    const stageKeys = Object.keys(stageDurationsMs);
    if (
      stageKeys.length !== CORRECTION_METRIC_STAGE_NAMES.length
      || stageKeys.some((key) => !CORRECTION_METRIC_STAGE_NAMES.includes(key as CorrectionMetricStageName))
    ) {
      throw new Error("Invalid correction metric input");
    }
    for (const stageName of CORRECTION_METRIC_STAGE_NAMES) {
      const durationMs = stageDurationsMs[stageName];
      if (!Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > MAX_STAGE_DURATION_MS) {
        throw new Error("Invalid correction metric input");
      }
    }
  }
  if (input.eventIdHash !== undefined && (typeof input.eventIdHash !== "string" || !EVENT_ID_HASH_PATTERN.test(input.eventIdHash))) {
    throw new Error("Invalid correction metric input");
  }
  if (input.detectorVersion !== undefined && (
    typeof input.detectorVersion !== "string"
    || input.detectorVersion.length > 16
    || !DETECTOR_VERSION_PATTERN.test(input.detectorVersion)
  )) {
    throw new Error("Invalid correction metric input");
  }
  if (input.reasonCode !== undefined && !CORRECTION_REASON_CODES.includes(input.reasonCode)) {
    throw new Error("Invalid correction metric input");
  }
}

async function ensureMetricsDirectory(memoryPath: string): Promise<string> {
  const logsDirectory = getLogsDirectory(memoryPath);
  await mkdir(logsDirectory, { recursive: true, mode: 0o700 });
  const logsStat = await lstat(logsDirectory);
  if (!logsStat.isDirectory() || logsStat.isSymbolicLink()) throw new Error("Invalid correction metrics directory");

  const metricsDirectory = getMetricsDirectory(memoryPath);
  await mkdir(metricsDirectory, { recursive: true, mode: 0o700 });
  const metricsStat = await lstat(metricsDirectory);
  if (!metricsStat.isDirectory() || metricsStat.isSymbolicLink()) throw new Error("Invalid correction metrics directory");
  return metricsDirectory;
}

async function getExistingMetricsDirectory(memoryPath: string): Promise<string | undefined> {
  const logsDirectory = getLogsDirectory(memoryPath);
  let logsStat;
  try {
    logsStat = await lstat(logsDirectory);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  if (!logsStat.isDirectory() || logsStat.isSymbolicLink()) throw new Error("Invalid correction metrics directory");

  const metricsDirectory = getMetricsDirectory(memoryPath);
  let metricsStat;
  try {
    metricsStat = await lstat(metricsDirectory);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  if (!metricsStat.isDirectory() || metricsStat.isSymbolicLink()) throw new Error("Invalid correction metrics directory");
  return metricsDirectory;
}

function getRetentionCutoff(now: Date): string {
  const cutoff = new Date(now.getTime() + JST_OFFSET_MS - RETENTION_DAYS * DAY_MS);
  return cutoff.toISOString().slice(0, 10);
}

export async function rotateCorrectionMetrics(memoryPath: string, now: Date = new Date()): Promise<number> {
  const metricsDirectory = await getExistingMetricsDirectory(memoryPath);
  if (metricsDirectory === undefined) return 0;

  const cutoffDate = getRetentionCutoff(now);
  const files = await readdir(metricsDirectory, { withFileTypes: true });
  let removedCount = 0;

  for (const file of files) {
    if (!file.isFile()) continue;
    const matched = METRIC_FILE_PATTERN.exec(file.name);
    if (matched === null || matched[2] >= cutoffDate) continue;
    await unlink(join(metricsDirectory, file.name));
    removedCount++;
  }

  return removedCount;
}

async function readMetricFileCounts(filePath: string): Promise<MetricFileCounts> {
  let fileStat;
  try {
    fileStat = await lstat(filePath);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return { sampleCount: 0, omittedCount: 0 };
    throw error;
  }
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error("Invalid correction metric file");

  const contents = await readFile(filePath, "utf-8");
  let sampleCount = 0;
  let omittedCount = 0;
  for (const line of contents.split("\n")) {
    if (line.trim().length === 0) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new Error("Invalid correction metric file");
    }
    if (typeof entry !== "object" || entry === null || !("k" in entry)) {
      throw new Error("Invalid correction metric file");
    }
    const parsed = entry as { k: unknown; total_count?: unknown; omitted_count?: unknown };
    if (parsed.k === "violation") continue;
    if (parsed.k === "sample") {
      if (omittedCount > 0 || sampleCount >= MAX_DAILY_SAMPLES) throw new Error("Invalid correction metric file");
      sampleCount++;
      continue;
    }
    if (parsed.k !== "omitted") throw new Error("Invalid correction metric file");

    const nextOmittedCount = omittedCount + 1;
    if (
      sampleCount !== MAX_DAILY_SAMPLES
      || parsed.omitted_count !== nextOmittedCount
      || parsed.total_count !== sampleCount + nextOmittedCount
    ) {
      throw new Error("Invalid correction metric file");
    }
    omittedCount = nextOmittedCount;
  }
  return { sampleCount, omittedCount };
}

function getSampleEntry(input: CorrectionMetricInput, now: Date): MetricFileEntry {
  const entry: MetricFileEntry = {
    ts: generateJstTimestamp(now),
    k: "sample",
    ms: input.durationMs,
    tok: input.tokens,
    miss: input.missingCount,
  };
  if (input.stageDurationsMs !== undefined) {
    entry.st = [
      input.stageDurationsMs.stdin,
      input.stageDurationsMs.position,
      input.stageDurationsMs.detect,
      input.stageDurationsMs.store,
      input.stageDurationsMs.retrieve,
      input.stageDurationsMs.render,
      input.stageDurationsMs.write,
    ];
  }
  if (input.eventIdHash !== undefined) entry.hash = input.eventIdHash;
  if (input.detectorVersion !== undefined) entry.v = input.detectorVersion;
  if (input.reasonCode !== undefined) entry.reason_code = input.reasonCode;
  return entry;
}

function getOmittedEntry(now: Date, totalCount: number, omittedCount: number): MetricFileEntry {
  return {
    ts: generateJstTimestamp(now),
    k: "omitted",
    total_count: totalCount,
    omitted_count: omittedCount,
  };
}

function getViolationEntry(now: Date): MetricFileEntry {
  return {
    ts: generateJstTimestamp(now),
    k: "violation",
  };
}

async function withMetricFileLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${filePath}.lock`;
  const maxAttempts = 20;
  const retryDelayMs = 5;
  const staleLockMs = 30_000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let lockHandle;
    try {
      lockHandle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (getErrorCode(error) !== "EEXIST") throw error;
      let lockStat;
      try {
        lockStat = await stat(lockPath);
      } catch (statError) {
        if (getErrorCode(statError) !== "ENOENT") throw statError;
      }
      if (lockStat !== undefined && Date.now() - lockStat.mtimeMs > staleLockMs) {
        try {
          await unlink(lockPath);
        } catch (unlinkError) {
          if (getErrorCode(unlinkError) !== "ENOENT") throw unlinkError;
        }
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      continue;
    }

    try {
      return await operation();
    } finally {
      await lockHandle.close();
      await unlink(lockPath);
    }
  }

  throw new Error("Correction metric lock timeout");
}

function serializeEntry(entry: MetricFileEntry): string {
  const line = `${JSON.stringify(entry)}\n`;
  if (Buffer.byteLength(line, "utf-8") > MAX_RECORD_BYTES) throw new Error("Correction metric record exceeds size limit");
  return line;
}

async function appendEntry(filePath: string, entry: MetricFileEntry): Promise<void> {
  const line = serializeEntry(entry);
  await appendFile(filePath, line, { encoding: "utf-8", mode: 0o600 });
}

async function recordValidatedMetric(memoryPath: string, input: CorrectionMetricInput, now: Date): Promise<CorrectionMetricWriteResult> {
  const filePath = getMetricFilePath(memoryPath, input.eventKind, now);
  return withMetricFileLock(filePath, async () => {
    const counts = await readMetricFileCounts(filePath);
    if (counts.sampleCount >= MAX_DAILY_SAMPLES) {
      const omittedCount = counts.omittedCount + 1;
      await appendEntry(filePath, getOmittedEntry(now, counts.sampleCount + omittedCount, omittedCount));
      return "omitted";
    }
    await appendEntry(filePath, getSampleEntry(input, now));
    return "recorded";
  });
}

export async function recordCorrectionMetric(
  memoryPath: string,
  input: CorrectionMetricInput,
  now: Date = new Date(),
): Promise<CorrectionMetricWriteResult> {
  validateInput(input);

  try {
    await ensureMetricsDirectory(memoryPath);
    await rotateCorrectionMetrics(memoryPath, now);
    return await recordValidatedMetric(memoryPath, input, now);
  } catch {
    console.error("[observability] 訂正メトリクス記録失敗");
    await increment(memoryPath, "write_failure_count", 1, now);
    return "failed";
  }
}

export async function recordCorrectionViolationMetric(
  memoryPath: string,
  now: Date = new Date(),
): Promise<CorrectionMetricWriteResult> {
  try {
    await ensureMetricsDirectory(memoryPath);
    await rotateCorrectionMetrics(memoryPath, now);
    const filePath = getMetricFilePath(memoryPath, "Stop", now);
    return await withMetricFileLock<CorrectionMetricWriteResult>(filePath, async () => {
      await readMetricFileCounts(filePath);
      await appendEntry(filePath, getViolationEntry(now));
      return "recorded";
    });
  } catch {
    console.error("[observability] 訂正メトリクス記録失敗");
    await increment(memoryPath, "write_failure_count", 1, now);
    return "failed";
  }
}
