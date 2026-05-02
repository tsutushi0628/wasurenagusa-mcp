#!/usr/bin/env node
/**
 * dream-worker
 * 夜間バッチ後段で起動され、直近1日の出来事を「夢」として1件生成・SQLiteに保存する。
 *
 * 使い方: node dream-worker.js <memoryPath> <projectRoot>
 *
 * heart-extension F3:
 * - 直近24h以内に dream があればスキップ（重複防御）
 * - 直近1日の dont/log/decision から強度高め3件をシードにLLMへ送信
 * - 出力 JSON {title, content} を category='dream' で memories に save
 * - 失敗は fail-open（exit 0、stderr に1行）
 *
 * 既存パターン踏襲:
 * - consolidate-worker.ts と同じ isCliEntry / runXForProject の構造
 * - generateTextFn を引数注入してテストでモック差し替え
 */

import { join, basename } from "path";
import { fileURLToPath } from "url";
import { SQLiteStorage } from "../storage/sqlite.js";
import { config } from "../config.js";
import type { GenerateTextFn } from "../llm/provider.js";
import type { MemoryEntry, MemoryCategory } from "../types.js";
import { loadPrompt } from "../analyzer/prompt-loader.js";
import { redactSensitive, truncateForPrompt } from "../utils/redact-sensitive-data.js";

export interface DreamSeed {
  title: string;
  content: string;
  category: MemoryCategory;
  intensity?: number;
}

export interface DreamGenerationOptions {
  memoryPath: string;
  projectRoot: string;
  /** テスト用にLLM呼び出しを差し替えるための注入ポイント */
  generateTextFn?: GenerateTextFn;
}

export interface DreamResult {
  title: string;
  content: string;
}

const DREAM_FRESHNESS_HOURS = 24;
const SEED_INTENSITY_THRESHOLD = 3;
const SEED_LIMIT = 3;
const SEED_LOOKBACK_HOURS = 24;
/** 外部LLMへ送る前にシードの title/content を切り詰める文字数。長すぎるコンテキストの混入と機密漏洩リスクを抑える。 */
const SEED_MAX_CHARS = 200;

/**
 * 直近の dream エントリが24時間以内なら true（=新しく作らない）。
 * null（dream なし）や24時間より古ければ false。
 */
export function isDreamFreshEnough(latestDream: MemoryEntry | null, now: Date): boolean {
  if (!latestDream) return false;
  const lastAt = new Date(latestDream.timestamp).getTime();
  if (Number.isNaN(lastAt)) return false;
  const diffMs = now.getTime() - lastAt;
  const diffHours = diffMs / (1000 * 60 * 60);
  return diffHours < DREAM_FRESHNESS_HOURS;
}

/**
 * シードの title/content を外部LLMプロバイダ送信前にサニタイズする。
 *
 * 過去会話に APIキー・絶対パス・メアド・JWT が混入していると平文でプロバイダログに残るため、
 * `redactSensitive` で機密パターンを [REDACTED] に置換し、`truncateForPrompt` で長さも制限する。
 * 元のオブジェクトは破壊せず、新しい配列を返す。
 */
export function sanitizeSeedsForPrompt(seeds: DreamSeed[]): DreamSeed[] {
  return seeds.map((seed) => ({
    ...seed,
    title: truncateForPrompt(redactSensitive(seed.title), SEED_MAX_CHARS),
    content: truncateForPrompt(redactSensitive(seed.content), SEED_MAX_CHARS),
  }));
}

/**
 * dream プロンプトテンプレートに seeds を埋め込む。
 * テンプレ内の "{{seeds}}" を Markdown 風の箇条書きに置換する。
 */
export function buildDreamPrompt(template: string, seeds: DreamSeed[]): string {
  const seedLines = seeds.length === 0
    ? "（シードなし。日常の小さな揺らぎを描いてください）"
    : seeds
        .map((s, i) => {
          const intensityLabel = s.intensity !== undefined ? ` [intensity:${s.intensity}]` : "";
          return `${i + 1}. [${s.category}]${intensityLabel} ${s.title}\n   ${s.content}`;
        })
        .join("\n");
  return template.replace("{{seeds}}", seedLines);
}

/**
 * LLM 応答テキストから JSON を抽出して title/content をパースする。
 * ```json``` フェンスにも対応。失敗時は null（fail-open）。
 */
export function parseDreamLLMResponse(raw: string): DreamResult | null {
  if (!raw || typeof raw !== "string") return null;
  // 最初の { から最後の } まで（vlmが装飾を付けても拾う）
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as Partial<DreamResult>;
    if (!parsed.title || !parsed.content) return null;
    if (typeof parsed.title !== "string" || typeof parsed.content !== "string") return null;
    return { title: parsed.title, content: parsed.content };
  } catch {
    return null;
  }
}

/**
 * SQLite から直近1件の dream を取得する。なければ null。
 */
function getLatestDream(storage: SQLiteStorage, currentProject: string): MemoryEntry | null {
  const result = storage.search({
    query: "",
    category: "dream",
    project: currentProject,
    limit: 1,
  });
  if (result.results.length === 0) return null;
  const detail = storage.getDetail({ ids: [result.results[0].id] });
  return detail.entries[0] ?? null;
}

/**
 * 直近24時間の dont/log/decision エントリから強度上位 SEED_LIMIT 件を抽出する。
 * intensity の高い順、同点なら timestamp の新しい順。
 */
function selectSeeds(storage: SQLiteStorage, currentProject: string, now: Date): DreamSeed[] {
  const sinceMs = now.getTime() - SEED_LOOKBACK_HOURS * 60 * 60 * 1000;
  const candidates: DreamSeed[] = [];

  for (const category of ["dont", "log", "decision"] as const) {
    const result = storage.search({
      query: "",
      category,
      project: currentProject,
      limit: 30,
    });
    const detail = storage.getDetail({ ids: result.results.map((r) => r.id) });
    for (const entry of detail.entries) {
      const ts = new Date(entry.timestamp).getTime();
      if (Number.isNaN(ts) || ts < sinceMs) continue;
      candidates.push({
        title: entry.title,
        content: entry.content,
        category: entry.category,
        intensity: entry.intensity,
      });
    }
  }

  // 強度優先 → 強度なし or 低いものは後回し（ランダムで埋める）
  const highIntensity = candidates
    .filter((c) => (c.intensity ?? 0) >= SEED_INTENSITY_THRESHOLD)
    .sort((a, b) => (b.intensity ?? 0) - (a.intensity ?? 0));

  const lowIntensity = candidates.filter((c) => (c.intensity ?? 0) < SEED_INTENSITY_THRESHOLD);

  const picked: DreamSeed[] = [];
  for (const c of highIntensity) {
    if (picked.length >= SEED_LIMIT) break;
    picked.push(c);
  }
  if (picked.length < SEED_LIMIT) {
    for (const c of lowIntensity) {
      if (picked.length >= SEED_LIMIT) break;
      picked.push(c);
    }
  }

  return picked;
}

function logErr(message: string): void {
  process.stderr.write(message + "\n");
}

/**
 * 1プロジェクトの夢生成を実行する。
 *
 * - 直近24h以内に dream があればスキップして null を返す
 * - シードが0件なら LLM を呼ばずに null を返す（無意味な夢を作らない）
 * - LLM 呼び出し / プロンプト読込 / JSON パース 失敗は全て fail-open で null
 * - 成功時のみ DreamResult を返し、SQLite に dream として保存する
 */
export async function runDreamGenerationForProject(
  options: DreamGenerationOptions,
): Promise<DreamResult | null> {
  const { memoryPath, projectRoot, generateTextFn } = options;
  const currentProject = basename(projectRoot);
  const dbPath = join(memoryPath, config.sqliteFile);

  let storage: SQLiteStorage;
  try {
    storage = new SQLiteStorage(dbPath);
    storage.initialize(memoryPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logErr(`[dream-worker] SQLite open failed: ${message}`);
    return null;
  }

  try {
    const now = new Date();

    // 重複防御: 直近24h以内に dream があればスキップ
    const latestDream = getLatestDream(storage, currentProject);
    if (isDreamFreshEnough(latestDream, now)) {
      return null;
    }

    // シード抽出（直近1日の dont/log/decision）
    const seeds = selectSeeds(storage, currentProject, now);
    if (seeds.length === 0) {
      // シードなし＝この1日は何もイベントがなかった。夢を作らない。
      return null;
    }

    // 生成関数の用意（注入優先、なければ実LLM）
    let runGenerate: GenerateTextFn;
    if (generateTextFn) {
      runGenerate = generateTextFn;
    } else {
      try {
        const { createGenerateTextFn } = await import("../llm/provider.js");
        runGenerate = createGenerateTextFn();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logErr(`[dream-worker] LLM provider unavailable: ${message}`);
        return null;
      }
    }

    // プロンプト読込
    let template: string;
    try {
      template = await loadPrompt("dream.txt");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logErr(`[dream-worker] dream prompt load failed: ${message}`);
      return null;
    }

    // 外部LLMプロバイダへ送る直前に機密情報を [REDACTED] へ置換する（過去会話混入対策）
    const sanitizedSeeds = sanitizeSeedsForPrompt(seeds);
    const prompt = buildDreamPrompt(template, sanitizedSeeds);

    // LLM 呼び出し
    let raw: string;
    try {
      raw = await runGenerate(prompt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logErr(`[dream-worker] LLM call failed: ${message}`);
      return null;
    }

    const parsed = parseDreamLLMResponse(raw);
    if (!parsed) {
      logErr(`[dream-worker] dream LLM response parse failed`);
      return null;
    }

    // SQLite へ保存（INSERT トリガー経由で memories_fts / vec0 と同期）
    storage.save({
      category: "dream",
      title: parsed.title,
      content: parsed.content,
      tags: ["dream"],
      project: currentProject,
      scope: "general",
    });

    return parsed;
  } finally {
    try {
      storage.close();
    } catch {
      // close 失敗は握りつぶす
    }
  }
}

async function main(): Promise<void> {
  const [memoryPath, projectRoot] = process.argv.slice(2);

  if (!memoryPath || !projectRoot) {
    logErr("[dream-worker] usage: dream-worker.js <memoryPath> <projectRoot>");
    process.exit(0);
  }

  if (!config.geminiApiKey && !config.openaiApiKey && !config.anthropicApiKey) {
    // API キーなし → fail-open
    process.exit(0);
  }

  await runDreamGenerationForProject({ memoryPath, projectRoot });
}

// CLI エントリ判定: import 時に main を実行しない（isDirectRun パターン）
const isCliEntry =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isCliEntry) {
  main().catch(() => {
    // 想定外エラー → fail-open（exit 0）
    process.exit(0);
  });
}
