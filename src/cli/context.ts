#!/usr/bin/env node
/**
 * wasurenagusa-context CLI
 * SessionStart Hook用: config/dontを読み込んで標準出力に出力
 * UserPromptSubmit Hook用: 記憶想起リマインドテキストを出力
 *
 * 使い方: wasurenagusa-context
 * Hooks設定で呼び出される（stdoutがClaudeのコンテキストに注入される）
 *
 * Hook入力（stdin JSON）:
 * {
 *   "session_id": "...",
 *   "transcript_path": "...",
 *   "cwd": "/path/to/project",
 *   "hook_event_name": "SessionStart",
 *   "source": "startup" | "resume" | "clear" | "compact",
 *   "model": "..."
 * }
 */

import { basename, join } from "path";
import { homedir } from "os";
import { readFile } from "fs/promises";
import { realpathSync } from "fs";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { findProjectRoot } from "../utils/projectRoot.js";
import { SQLiteStorage } from "../storage/index.js";
import { getMemoryPath, config } from "../config.js";

import {
  isConsolidationStaleSqlite,
  isConfigConsolidationStaleSqlite,
  readConsolidatedDontSqlite,
  readConsolidatedConfigSqlite,
  readDontSummary,
  formatConsolidatedDont,
  formatConsolidatedConfig,
} from "../consolidator/index.js";
import { loadOwnerProfile, getOwnerProfilePath } from "../utils/owner-profile.js";
import { EmbeddingService } from "../vector/embedding-service.js";
import { VectorStore } from "../vector/vector-store.js";
import { TIER_THRESHOLDS } from "../vector/memory-tier.js";
import type { MemoryEntry } from "../types.js";

type OutputMode = "injection" | "agent";

interface ProjectConfig {
  outputMode?: OutputMode;
}

interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  source?: string;
  model?: string;
}

/**
 * プロジェクトローカルの .wasurenagusa/config.json から outputMode を読み取る。
 * ファイルが存在しない場合やoutputModeが未設定の場合は "injection"（デフォルト）。
 */
async function readOutputMode(memoryPath: string): Promise<OutputMode> {
  const configPath = join(memoryPath, "config.json");
  const raw = await readFile(configPath, "utf-8");
  const parsed: ProjectConfig = JSON.parse(raw);
  if (parsed.outputMode !== "injection" && parsed.outputMode !== "agent") {
    throw new Error(`Invalid outputMode: ${String(parsed.outputMode)}`);
  }
  return parsed.outputMode;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * consolidationをdetachedプロセスとして非同期実行する。
 * SessionStart hookの5秒タイムアウトに引っかからないよう、
 * 結果は次回セッションで利用する方式に変更。
 */
function spawnConsolidationBackground(memoryPath: string, projectRoot: string): void {
  if (!config.geminiApiKey && !config.openaiApiKey && !config.anthropicApiKey) return;

  const scriptPath = new URL("./consolidate-worker.js", import.meta.url).pathname;
  const child = spawn(process.execPath, [scriptPath, memoryPath, projectRoot], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}

/**
 * embedding backfillをdetachedプロセスとして非同期実行する。
 * embedding未生成のメモリエントリを最大backfillBatchSize件ずつ埋める。
 */
function spawnBackfillBackground(memoryPath: string, projectRoot: string): void {
  const scriptPath = new URL("./backfill-worker.js", import.meta.url).pathname;
  const child = spawn(process.execPath, [scriptPath, memoryPath, projectRoot], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}

/**
 * heart-extension F3: 直近24時間以内の dream エントリ1件を
 * "### 今朝の夢\n${content}" の文字列で返す。
 * 0件 / 期間外 / 失敗時は空文字（セクション省略）。
 */
export async function getDreamContent(
  storage: SQLiteStorage,
  currentProject: string,
): Promise<string> {
  try {
    const result = storage.search({
      query: "",
      category: "dream",
      project: currentProject,
      limit: 1,
    });
    if (result.results.length === 0) return "";

    const detail = storage.getDetail({ ids: [result.results[0].id] });
    const entry = detail.entries[0];
    if (!entry) return "";

    const ts = new Date(entry.timestamp).getTime();
    if (Number.isNaN(ts)) return "";
    const ageMs = Date.now() - ts;
    const ageHours = ageMs / (1000 * 60 * 60);
    if (ageHours >= 24) return "";

    return `### 今朝の夢\n${entry.content}`;
  } catch {
    return "";
  }
}

/**
 * heart-extension F4: 直近30日以内の success エントリ上位3件を
 * "### 効いた提案パターン\n- title: 1行要約" の形式で返す。
 * 0件 / 期間外 / 失敗時は空文字（セクション省略）。
 */
export async function getSuccessContent(
  storage: SQLiteStorage,
  currentProject: string,
): Promise<string> {
  try {
    const result = storage.search({
      query: "",
      category: "success",
      project: currentProject,
      limit: 30,
    });
    if (result.results.length === 0) return "";

    const detail = storage.getDetail({ ids: result.results.map((r) => r.id) });
    const cutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1000;

    const fresh = detail.entries.filter((e) => {
      const ts = new Date(e.timestamp).getTime();
      if (Number.isNaN(ts)) return false;
      return ts >= cutoffMs;
    });
    if (fresh.length === 0) return "";

    // 既に search が timestamp DESC で返してくる前提だが、念のため再ソート
    fresh.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    const top3 = fresh.slice(0, 3);

    const lines = top3.map((e) => {
      const summary = e.content.replace(/\s+/g, " ").trim();
      const oneLine = summary.length > 80 ? summary.substring(0, 80) + "…" : summary;
      return `- **${e.title}**: ${oneLine}`;
    });

    return "### 効いた提案パターン\n" + lines.join("\n");
  } catch {
    return "";
  }
}

interface DontContentExtras {
  /** F4 success セクション本文（"### 効いた提案パターン..."）。空文字なら省略 */
  successContent?: string;
  /** F3 dream セクション本文（"### 今朝の夢..."）。空文字なら省略 */
  dreamContent?: string;
}

async function getDontContent(
  storage: SQLiteStorage,
  currentProject: string,
  memoryPath: string,
  outputMode: OutputMode,
  extras: DontContentExtras = {},
): Promise<string> {
  const layers: string[] = [];

  if (outputMode === "agent") {
    // agentモード: サマリファイルがあればサマリ注入
    const summary = await readDontSummary(memoryPath);
    if (summary) {
      layers.push("### 行動原則（サマリ）\n" + summary);

      // 統合済みに含まれない直近エントリのみ追加
      const consolidated = readConsolidatedDontSqlite(storage);
      const dontEntries = storage.readDontEntries(currentProject);
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const consolidatedSourceIds = new Set<string>();
      if (consolidated) {
        for (const principle of consolidated.principles) {
          for (const sourceId of principle.sourceIds) {
            consolidatedSourceIds.add(sourceId);
          }
        }
      }

      // 重要度の高いdontエントリ上位3件を原文付きで注入
      // intensityフィールドがあればそれで降順ソート、なければ直近順
      const allDontEntries = [...dontEntries].sort((a, b) => {
        const intensityA = a.intensity ?? 0;
        const intensityB = b.intensity ?? 0;
        if (intensityB !== intensityA) return intensityB - intensityA;
        return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
      });
      const top3Entries = allDontEntries.slice(0, 3);
      const top3Ids = new Set(top3Entries.map(e => e.id));

      if (top3Entries.length > 0) {
        const top3Lines = top3Entries.map(e => {
          const intensityLabel = e.intensity ? ` [重要度:${e.intensity}]` : "";
          // 統合済みprincipleから対応するpositiveRuleを検索
          let positiveRule: string | undefined;
          if (consolidated) {
            const matchedPrinciple = consolidated.principles.find(p =>
              p.sourceIds.includes(e.id)
            );
            if (matchedPrinciple) {
              positiveRule = matchedPrinciple.positiveRule;
            }
          }
          if (positiveRule) {
            return `- **${e.title}**${intensityLabel}\n  ${positiveRule}\n  ※経緯: ${e.content}`;
          }
          return `- **${e.title}**${intensityLabel}\n  ${e.content}`;
        });
        layers.push("### 重要な行動原則 トップ3\n" + top3Lines.join("\n"));
      }

      // F4 success: 行動原則トップ3 と 直近の注意事項 の間に挿入
      if (extras.successContent) {
        layers.push(extras.successContent);
      }

      // F3 dream: success の後、直近の注意事項の前に挿入（D-10 セクション順）
      if (extras.dreamContent) {
        layers.push(extras.dreamContent);
      }

      const recentCandidates = dontEntries
        .filter(e => {
          if (consolidatedSourceIds.has(e.id)) return false;
          if (top3Ids.has(e.id)) return false;
          const entryDate = new Date(e.timestamp);
          return entryDate >= thirtyDaysAgo;
        })
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      // 直近エントリのタイトル重複排除（類似タイトルは新しい方だけ残す）
      const recentEntries = deduplicateByTitle(recentCandidates).slice(0, 5);

      if (recentEntries.length > 0) {
        const recentLines = recentEntries.map(e => `- ${e.title}`);
        layers.push("### 直近の注意事項（最新5件）\n" + recentLines.join("\n"));
      }

      if (layers.length === 0) return "";
      return layers.join("\n\n");
    }

    // サマリファイルがない場合: injectionモードと同じ全文出力にフォールバック
    // （以下のinjectionモード処理にそのまま流れる）
  }

  // injectionモード: 全文注入
  try {
    const consolidated = readConsolidatedDontSqlite(storage);
    if (consolidated) {
      const formatted = formatConsolidatedDont(consolidated);
      if (formatted) {
        layers.push("### 行動原則（統合済み）\n\n" + formatted);
      }
    }
  } catch {
    // 統合読み込み失敗時はスキップ
  }

  const dontEntries = storage.readDontEntries(currentProject);
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  let consolidatedSourceIds = new Set<string>();
  try {
    const consolidated = readConsolidatedDontSqlite(storage);
    if (consolidated) {
      for (const principle of consolidated.principles) {
        for (const sourceId of principle.sourceIds) {
          consolidatedSourceIds.add(sourceId);
        }
      }
    }
  } catch {
    // 読み込み失敗時は空セットで続行
  }

  const recentEntries = dontEntries.filter(e => {
    if (consolidatedSourceIds.has(e.id)) return false;
    const entryDate = new Date(e.timestamp);
    return entryDate >= thirtyDaysAgo;
  });

  if (recentEntries.length > 0) {
    const recentLines = recentEntries.map(e => `- **${e.title}**: ${e.content}`).join("\n");
    layers.push("### 直近の注意事項\n\n" + recentLines);
  }

  if (layers.length === 0) {
    // フォールバック: 層が一つもない場合は従来の全件注入
    const context = storage.getContext(currentProject);
    return context.dont;
  }

  return layers.join("\n\n");
}

async function getConfigContent(
  storage: SQLiteStorage,
  currentProject: string,
  memoryPath: string,
  outputMode: OutputMode,
): Promise<string> {
  if (outputMode === "agent") {
    // agentモード: テーマ+IDのインデックスのみ
    const consolidated = readConsolidatedConfigSqlite(storage);
    if (!consolidated || consolidated.summaries.length === 0) return "";

    const lines = consolidated.summaries.map(s => {
      const ids = s.sourceIds.map(id => `ID:${id}`).join(", ");
      return `- [${ids}] ${s.theme}`;
    });

    return lines.join("\n");
  }

  // injectionモード: 全文注入
  try {
    const consolidated = readConsolidatedConfigSqlite(storage);
    if (consolidated) {
      const formatted = formatConsolidatedConfig(consolidated);
      if (formatted) return formatted;
    }
  } catch {
    // 統合読み込み失敗時はフォールバック
  }

  // フォールバック: 従来の全件注入
  const context = storage.getContext(currentProject);
  return context.config;
}

async function handleUserPromptSubmit(): Promise<void> {
  // UserPromptSubmitの記憶想起はプロジェクト側のhooksで管理する
}

/**
 * トークン概算（保守的・過小評価しない側に倒す）。
 * 「文字数 ÷ 2」と「UTF-8バイト数 ÷ 3」の2通りで見積もり、大きい方を採用する。
 * 正確なトークナイザではなく概算だが、日本語のようなマルチバイト文字を含む
 * テキストでも実トークン数を下回らないことを優先する。
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  const charEstimate = Math.ceil(text.length / 2);
  const byteEstimate = Math.ceil(Buffer.byteLength(text, "utf-8") / 3);
  return Math.max(charEstimate, byteEstimate);
}

/** 注入トークンバジェットの既定値（環境変数 WASURENAGUSA_INJECTION_TOKEN_BUDGET 未設定時） */
export const DEFAULT_INJECTION_TOKEN_BUDGET = 8000;

export interface InjectionBudgetResult {
  /** バジェット適用後の最終出力文字列 */
  text: string;
  /** 切り詰めが発生したか */
  truncated: boolean;
  /** 切り詰めで省略された概算トークン数（truncated=falseなら0） */
  omittedTokens: number;
}

/**
 * 注入文字列にトークンバジェット上限を適用する。
 * 上限内なら素通し。超過時は行境界で末尾から切り詰め、可視マーカー行を残す。
 * 無言で切らない・フォールバックで全文をそのまま流す経路は作らない
 * （呼び出し側は必ず本関数の戻り値をそのまま出力に使う）。
 */
export function enforceInjectionTokenBudget(
  text: string,
  budgetTokens: number,
): InjectionBudgetResult {
  const totalTokens = estimateTokens(text);
  if (totalTokens <= budgetTokens) {
    return { text, truncated: false, omittedTokens: 0 };
  }

  const lines = text.split("\n");
  const keptLines: string[] = [];
  let keptTokens = 0;
  for (const line of lines) {
    const lineTokens = estimateTokens(line);
    if (keptTokens + lineTokens > budgetTokens) break;
    keptLines.push(line);
    keptTokens += lineTokens;
  }

  const omittedTokens = totalTokens - keptTokens;
  const marker = `（注入がバジェット上限で切り詰められました: 約${omittedTokens} トークン省略）`;

  return {
    text: [...keptLines, marker].join("\n"),
    truncated: true,
    omittedTokens,
  };
}

/**
 * 注入バジェット超過時のfail-loud警告をstderrへ1行出力する。
 * truncated=falseのときは何も出力しない（無言で切っていないため警告は不要）。
 */
export function logInjectionBudgetWarning(
  budgetTokens: number,
  result: InjectionBudgetResult,
): void {
  if (!result.truncated) return;
  console.error(
    `[context] 注入がトークンバジェット上限(${budgetTokens})を超過したため切り詰めました: 約${result.omittedTokens} トークン省略`,
  );
}

async function main() {
  // stdinからHook入力JSONを読み取る
  let cwd: string;
  let hookEventName: string = "SessionStart";
  try {
    const inputData = await readStdin();
    if (inputData.trim()) {
      const hookInput: HookInput = JSON.parse(inputData);
      cwd = hookInput.cwd;
      hookEventName = hookInput.hook_event_name || "SessionStart";
    } else {
      cwd = process.cwd();
    }
  } catch {
    cwd = process.cwd();
  }

  // UserPromptSubmit: 記憶想起リマインドのみ出力
  if (hookEventName === "UserPromptSubmit") {
    await handleUserPromptSubmit();
    return;
  }

  // cwdからプロジェクトルートを探索
  const projectRoot = findProjectRoot(cwd);
  const currentProject = basename(projectRoot);
  const memoryPath = getMemoryPath(projectRoot);

  // SQLiteStorageでコンテキスト取得
  const dbPath = join(memoryPath, config.sqliteFile);
  const storage = new SQLiteStorage(dbPath);
  storage.initialize(memoryPath);

  // dont/configいずれかの統合が古ければバックグラウンドで再統合（次回セッション向け）
  const dontStale = isConsolidationStaleSqlite(storage);
  const configStale = isConfigConsolidationStaleSqlite(storage);
  if (dontStale || configStale) {
    spawnConsolidationBackground(memoryPath, projectRoot);
  }

  // embedding backfill: API keyがあればバックグラウンドで未生成分を埋める
  const embeddingServiceForBackfill = new EmbeddingService(config.geminiApiKey);
  if (embeddingServiceForBackfill.isAvailable()) {
    spawnBackfillBackground(memoryPath, projectRoot);
  }

  // outputModeを読み取る（デフォルト: injection）
  let outputMode: OutputMode = "injection";
  try {
    outputMode = await readOutputMode(memoryPath);
  } catch {
    // config.json が存在しない or outputMode未設定 → デフォルトの injection で続行
  }

  // F3/F4: dream / success 各セクションを並列取得（fail-open: 失敗時は空文字）
  const [configContent, dreamContent, successContent] = await Promise.all([
    getConfigContent(storage, currentProject, memoryPath, outputMode),
    getDreamContent(storage, currentProject),
    getSuccessContent(storage, currentProject),
  ]);

  // 統合レイヤー経由で取得（統合版があればそれを、なければ生データを注入）
  // dont 内に success / dream を埋め込む（agent モード時は D-10 のセクション順で挟まれる）
  const dontContent = await getDontContent(
    storage,
    currentProject,
    memoryPath,
    outputMode,
    { dreamContent, successContent },
  );

  // 出力を組み立て
  const output: string[] = [];

  if (outputMode === "agent") {
    // agentモード: インデックスのみ注入
    output.push("## 記憶インデックス（詳細はサブエージェント経由で memory_get_detail を使用）\n");

    if (configContent) {
      output.push("### config（設定情報）");
      output.push(configContent);
      output.push("");
    }

    if (dontContent) {
      output.push("### 行動原則（過去のフィードバック由来）");
      output.push(dontContent);
      output.push("");
    }

    // オーナープロファイル注入（短いのでそのまま残す）
    const ownerProfile = await loadOwnerProfile(memoryPath);
    if (ownerProfile) {
      output.push("### オーナー判断基準");
      output.push(ownerProfile);
      output.push("");
    } else {
      const profilePath = getOwnerProfilePath(memoryPath);
      output.push(`（owner-profile.md が未記入です。お時間のある時に記入してください: ${profilePath}）`);
      output.push("");
    }

    // agentモードではベクトル検索・他プロジェクト横断検索を省略
    // （コンテキスト効率のため。必要時はサブエージェント経由でmemory_searchを使う）

    // メモリ活用ルール（サブエージェント委譲前提）
    output.push("## メモリ活用ルール");
    output.push("- 詳細が必要な場合はサブエージェントに memory_search / memory_get_detail を委譲すること");
    output.push("- メインコンテキストに記憶の生データを持ち込まない");
    output.push("- 「覚えろ」と言われたら memory_save で保存すること（MEMORY.mdへの書き込み禁止）");
  } else {
    // injectionモード: 全文注入
    output.push("=== wasurenagusa メモリ ===\n");

    if (configContent && configContent !== "（設定情報なし）") {
      output.push("## 設定情報（config）\n");
      output.push(configContent + "\n");
    }

    // F3 dream: 設定情報と行動原則の間に挿入（design.md §4.4.2 injection モード）
    if (dreamContent) {
      output.push(dreamContent + "\n");
    }

    if (dontContent && dontContent !== "（ルールなし）") {
      output.push("## 行動原則（dont由来）\n");
      output.push(dontContent);
    }

    // F4 success: 行動原則の下に挿入（design.md §4.5.2 injection モード）
    if (successContent) {
      output.push(successContent + "\n");
    }

    // オーナープロファイル注入
    const ownerProfile = await loadOwnerProfile(memoryPath);
    if (ownerProfile) {
      output.push("## オーナーの判断基準\n");
      output.push(ownerProfile + "\n");
    } else {
      const profilePath = getOwnerProfilePath(memoryPath);
      output.push(`（owner-profile.md が未記入です。お時間のある時に記入してください: ${profilePath}）\n`);
    }

    if (output.length === 1) {
      output.push("（まだメモリがありません）");
    }

    // ベクトル検索による関連記憶注入（全文）
    const embeddingService = new EmbeddingService(config.geminiApiKey);
    if (embeddingService.isAvailable()) {
      try {
        const vectorStore = new VectorStore(memoryPath);

        let queryEmbedding: number[];
        let querySource: string;
        const topicPath = join(memoryPath, "last-session-topic.json");
        try {
          const topicRaw = await readFile(topicPath, "utf-8");
          const topicData = JSON.parse(topicRaw);
          if (topicData.embedding && Array.isArray(topicData.embedding)) {
            queryEmbedding = topicData.embedding;
            querySource = topicData.topic;
          } else {
            queryEmbedding = await embeddingService.embed(currentProject);
            querySource = currentProject;
          }
        } catch {
          queryEmbedding = await embeddingService.embed(currentProject);
          querySource = currentProject;
        }

        const vectorResults = await vectorStore.search(
          queryEmbedding,
          TIER_THRESHOLDS.medium,
          5
        );

        if (vectorResults.length > 0) {
          const ids = vectorResults.map(r => r.id);
          const details = storage.getDetail({ ids });

          const lines: string[] = ["\n## 関連する記憶（自動検索）\n"];
          for (const entry of details.entries) {
            lines.push(`### ${entry.title}`);
            let snippet = entry.content;
            if (snippet.length > 200) {
              snippet = snippet.substring(0, 200) + "...";
            }
            lines.push(snippet);
            lines.push("");
          }

          process.stdout.write(lines.join("\n"));
        }
      } catch (error) {
        console.error("[vector] context注入時ベクトル検索失敗:", error);
      }
    }

    // 他のアクティブプロジェクトの関連記憶を横断検索（全文）
    try {
      const crossEmbeddingService = new EmbeddingService(config.geminiApiKey);
      if (crossEmbeddingService.isAvailable()) {
        const { ActiveProjectsTracker } = await import("../active-projects.js");
        const schedulerDir = join(homedir(), ".wasurenagusa", "scheduler");
        const activeTracker = new ActiveProjectsTracker(schedulerDir);
        const otherProjects = await activeTracker.getOtherActiveProjects(currentProject);

        if (otherProjects.length > 0) {
          let crossQueryEmbedding: number[];
          const crossTopicPath = join(memoryPath, "last-session-topic.json");
          try {
            const topicRaw = await readFile(crossTopicPath, "utf-8");
            const topicData = JSON.parse(topicRaw);
            if (topicData.embedding && Array.isArray(topicData.embedding)) {
              crossQueryEmbedding = topicData.embedding;
            } else {
              crossQueryEmbedding = await crossEmbeddingService.embed(currentProject);
            }
          } catch {
            crossQueryEmbedding = await crossEmbeddingService.embed(currentProject);
          }

          const crossProjectMemories: string[] = [];

          for (const proj of otherProjects) {
            try {
              const projMemoryPath = getMemoryPath(proj.path);
              const projVectorStore = new VectorStore(projMemoryPath);

              const crossResults = await projVectorStore.search(crossQueryEmbedding, TIER_THRESHOLDS.short, 3);

              if (crossResults.length > 0) {
                const projDbPath = join(getMemoryPath(proj.path), config.sqliteFile);
                const projStorage = new SQLiteStorage(projDbPath);
                projStorage.initialize();
                const crossDetail = projStorage.getDetail({
                  ids: crossResults.map(r => r.id),
                });

                for (const entry of crossDetail.entries) {
                  crossProjectMemories.push(`[${proj.name}] ${entry.title}: ${entry.content}`);
                }
                projStorage.close();
              }
            } catch {
              continue;
            }
          }

          if (crossProjectMemories.length > 0) {
            output.push("\n## 他プロジェクトの関連記憶（横断検索）\n");
            for (const mem of crossProjectMemories) {
              output.push(`- ${mem}`);
            }
          }
        }
      }
    } catch {
      // 横断検索の失敗は握りつぶす
    }

    // メモリ活用ルール（全文注入モード向け）
    output.push("");
    output.push("## メモリ活用ルール（必須）");
    output.push("- 作業開始前に `memory_search` で関連するメモリを検索し、過去の知見・設定・失敗を確認すること");
    output.push("- 「覚えろ」と言われたら `memory_save` で保存すること（MEMORY.mdへの書き込み禁止）");
    output.push("- 上記の設定情報（config）は過去にユーザーが覚えさせた重要情報。作業対象に関連するものは必ず参照すること");
  }

  // 注入トークンバジェットを強制してからstdoutに出力（Hooksがこれをコンテキストに注入する）
  const budgetTokens = parseInt(
    process.env.WASURENAGUSA_INJECTION_TOKEN_BUDGET || String(DEFAULT_INJECTION_TOKEN_BUDGET),
    10,
  );
  const budgetResult = enforceInjectionTokenBudget(output.join("\n"), budgetTokens);
  logInjectionBudgetWarning(budgetTokens, budgetResult);
  console.log(budgetResult.text);

  storage.close();
}

/**
 * タイトルのトークン重複率でエントリを重複排除する。
 * 既に追加済みエントリとタイトルトークンが50%以上重複していたら除外。
 * 入力順を維持する（先にあるものを優先）。
 */
function deduplicateByTitle(entries: MemoryEntry[]): MemoryEntry[] {
  if (entries.length <= 1) return entries;

  const kept: MemoryEntry[] = [];
  const keptTokensList: string[][] = [];

  for (const entry of entries) {
    const tokens = extractTitleTokens(entry.title);
    const isDuplicate = keptTokensList.some(keptTokens => {
      if (tokens.length === 0 || keptTokens.length === 0) return false;
      const overlap = tokens.filter(t => keptTokens.includes(t));
      return overlap.length >= 2 && overlap.length >= tokens.length * 0.5;
    });
    if (!isDuplicate) {
      kept.push(entry);
      keptTokensList.push(tokens);
    }
  }
  return kept;
}

/**
 * タイトルからトークンを抽出（漢字bigram + カタカナ + 英数字）
 */
function extractTitleTokens(title: string): string[] {
  const tokens: string[] = [];
  const kanjiSequences = title.match(/[\u4E00-\u9FFF]{2,}/g);
  if (kanjiSequences) {
    for (const seq of kanjiSequences) {
      for (let i = 0; i + 1 < seq.length; i += 2) {
        tokens.push(seq.substring(i, i + 2));
      }
    }
  }
  const kata = title.match(/[\u30A0-\u30FF]{2,}/g);
  if (kata) tokens.push(...kata);
  const en = title.match(/[a-zA-Z0-9][-a-zA-Z0-9]{1,}/g);
  if (en) tokens.push(...en.map(s => s.toLowerCase()));
  return tokens;
}

/**
 * CLIエントリ判定: 現在のモジュールが `node <path>` で直接実行されたか判定する。
 * npmグローバルbinはsymlinkとして配置されるため、argv[1]（symlink自体のパス）と
 * import.meta.url由来の実ファイルパスは生パス比較だと不一致になり、main()が
 * 呼ばれない（記憶ストアの注入が無言で0バイトになる）事故が起きていた。
 * 両辺をrealpathで実体パス解決してから比較することで、symlink経由の起動も検知する。
 * realpath解決が例外（存在しないパス等）の場合は生パス比較にフォールバックする
 * （fail-open: 判定不能時に起動を握りつぶさない。従来の直接node実行の挙動は維持）。
 */
export function isDirectRun(argv1: string | undefined, moduleUrl: string): boolean {
  if (argv1 === undefined) return false;

  const modulePath = fileURLToPath(moduleUrl);
  try {
    return realpathSync(argv1) === realpathSync(modulePath);
  } catch {
    return argv1 === modulePath;
  }
}

if (isDirectRun(process.argv[1], import.meta.url)) {
  main().catch(console.error);
}
