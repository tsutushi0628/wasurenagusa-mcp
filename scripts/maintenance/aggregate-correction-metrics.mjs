#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const CORRECTION_METRIC_STAGE_NAMES = ["stdin", "position", "detect", "store", "retrieve", "render", "write"];

const EVENT_KINDS = ["SessionStart", "UserPromptSubmit"];
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function getJstDate(now = new Date()) {
  return new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

function validateDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function parseSample(line) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    throw new Error("日次メトリクスの形式が不正です");
  }
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error("日次メトリクスの形式が不正です");
  }
  if (entry.k === "omitted") return { kind: "omitted" };
  if (entry.k !== "sample") throw new Error("日次メトリクスの形式が不正です");
  if (entry.st === undefined) return { kind: "legacy" };
  if (
    !Array.isArray(entry.st)
    || entry.st.length !== CORRECTION_METRIC_STAGE_NAMES.length
    || entry.st.some((value) => !Number.isSafeInteger(value) || value < 0)
  ) {
    throw new Error("日次メトリクスの段別値が不正です");
  }
  return { kind: "sample", stages: entry.st };
}

export function summarizeCorrectionMetricLines(contents) {
  if (typeof contents !== "string") throw new Error("日次メトリクスの形式が不正です");
  const valuesByStage = Object.fromEntries(CORRECTION_METRIC_STAGE_NAMES.map((stage) => [stage, []]));
  let samples = 0;
  let legacySamples = 0;

  for (const line of contents.split("\n")) {
    if (line.trim().length === 0) continue;
    const parsed = parseSample(line);
    if (parsed.kind === "omitted") continue;
    if (parsed.kind === "legacy") {
      legacySamples++;
      continue;
    }
    samples++;
    for (let index = 0; index < CORRECTION_METRIC_STAGE_NAMES.length; index++) {
      valuesByStage[CORRECTION_METRIC_STAGE_NAMES[index]].push(parsed.stages[index]);
    }
  }

  const stages = {};
  for (const stage of CORRECTION_METRIC_STAGE_NAMES) {
    const values = valuesByStage[stage].sort((a, b) => a - b);
    stages[stage] = values.length === 0
      ? { p50: null, p95: null, max: null }
      : {
        p50: values[Math.ceil(values.length * 0.5) - 1],
        p95: values[Math.ceil(values.length * 0.95) - 1],
        max: values[values.length - 1],
      };
  }

  return { samples, legacySamples, stages };
}

async function readMetricsFile(directory, eventKind, date) {
  try {
    return await readFile(join(directory, `${eventKind}-${date}.jsonl`), "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return "";
    throw new Error("日次メトリクスを読めません");
  }
}

function formatSummary(eventKind, summary) {
  const lines = [`${eventKind} samples=${summary.samples} legacy=${summary.legacySamples}`, "段 p50(ms) p95(ms) max(ms)"];
  for (const stage of CORRECTION_METRIC_STAGE_NAMES) {
    const values = summary.stages[stage];
    const p50 = values.p50 === null ? "-" : values.p50;
    const p95 = values.p95 === null ? "-" : values.p95;
    const max = values.max === null ? "-" : values.max;
    lines.push(`${stage} ${p50} ${p95} ${max}`);
  }
  return lines;
}

export async function main(argv = process.argv.slice(2)) {
  const [metricsDirectory, dateArgument, ...extraArguments] = argv;
  if (!metricsDirectory || extraArguments.length > 0) {
    throw new Error("使い方: node scripts/maintenance/aggregate-correction-metrics.mjs <metrics-directory> [YYYY-MM-DD]");
  }
  const date = dateArgument === undefined ? getJstDate() : dateArgument;
  if (!validateDate(date)) throw new Error("日付はYYYY-MM-DDで指定してください");
  let directoryStat;
  try {
    directoryStat = await stat(metricsDirectory);
  } catch {
    throw new Error("メトリクス保存先が見つかりません");
  }
  if (!directoryStat.isDirectory()) throw new Error("メトリクス保存先が見つかりません");

  const output = [`日付: ${date}`];
  for (const eventKind of EVENT_KINDS) {
    const contents = await readMetricsFile(metricsDirectory, eventKind, date);
    output.push(...formatSummary(eventKind, summarizeCorrectionMetricLines(contents)));
  }
  process.stdout.write(`${output.join("\n")}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "集計に失敗しました";
    process.stderr.write(`[aggregate-correction-metrics] ${message}\n`);
    process.exitCode = 1;
  });
}
