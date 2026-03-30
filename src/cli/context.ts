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
import { spawn } from "child_process";
import { findProjectRoot } from "../utils/projectRoot.js";
import { MarkdownStorage } from "../storage/index.js";
import { getMemoryPath, config } from "../config.js";
import {
  isConsolidationStale,
  isConfigConsolidationStale,
  readConsolidatedDont,
  readConsolidatedConfig,
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

async function getDontContent(
  storage: MarkdownStorage,
  currentProject: string,
  memoryPath: string,
  outputMode: OutputMode,
): Promise<string> {
  const layers: string[] = [];

  if (outputMode === "agent") {
    // agentモード: サマリファイルがあればサマリ注入
    const summary = await readDontSummary(memoryPath);
    if (summary) {
      layers.push("### 行動原則（サマリ）\n" + summary);

      // 統合済みに含まれない直近エントリのみ追加
      const consolidated = await readConsolidatedDont(memoryPath);
      const dontEntries = await storage.readDontEntries(currentProject);
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
    const consolidated = await readConsolidatedDont(memoryPath);
    if (consolidated) {
      const formatted = formatConsolidatedDont(consolidated);
      if (formatted) {
        layers.push("### 行動原則（統合済み）\n\n" + formatted);
      }
    }
  } catch {
    // 統合読み込み失敗時はスキップ
  }

  const dontEntries = await storage.readDontEntries(currentProject);
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  let consolidatedSourceIds = new Set<string>();
  try {
    const consolidated = await readConsolidatedDont(memoryPath);
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
    const context = await storage.getContext(currentProject);
    return context.dont;
  }

  return layers.join("\n\n");
}

async function getConfigContent(
  storage: MarkdownStorage,
  currentProject: string,
  memoryPath: string,
  outputMode: OutputMode,
): Promise<string> {
  if (outputMode === "agent") {
    // agentモード: テーマ+IDのインデックスのみ
    const consolidated = await readConsolidatedConfig(memoryPath);
    if (!consolidated || consolidated.summaries.length === 0) return "";

    const lines = consolidated.summaries.map(s => {
      const ids = s.sourceIds.map(id => `ID:${id}`).join(", ");
      return `- [${ids}] ${s.theme}`;
    });

    return lines.join("\n");
  }

  // injectionモード: 全文注入
  try {
    const consolidated = await readConsolidatedConfig(memoryPath);
    if (consolidated) {
      const formatted = formatConsolidatedConfig(consolidated);
      if (formatted) return formatted;
    }
  } catch {
    // 統合読み込み失敗時はフォールバック
  }

  // フォールバック: 従来の全件注入
  const context = await storage.getContext(currentProject);
  return context.config;
}

async function handleUserPromptSubmit(): Promise<void> {
  // UserPromptSubmitの記憶想起はプロジェクト側のhooksで管理する
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

  // MarkdownStorageでコンテキスト取得
  const storage = new MarkdownStorage(projectRoot);

  // dont/configいずれかの統合が古ければバックグラウンドで再統合（次回セッション向け）
  const [dontStale, configStale] = await Promise.all([
    isConsolidationStale(memoryPath),
    isConfigConsolidationStale(memoryPath),
  ]);
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

  // 統合レイヤー経由で取得（統合版があればそれを、なければ生データを注入）
  const [configContent, dontContent] = await Promise.all([
    getConfigContent(storage, currentProject, memoryPath, outputMode),
    getDontContent(storage, currentProject, memoryPath, outputMode),
  ]);

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

    if (dontContent && dontContent !== "（ルールなし）") {
      output.push("## 行動原則（dont由来）\n");
      output.push(dontContent);
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
          const details = await storage.getDetail({ ids });

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
                const projStorage = new MarkdownStorage(proj.path);
                const crossDetail = await projStorage.getDetail({
                  ids: crossResults.map(r => r.id),
                });

                for (const entry of crossDetail.entries) {
                  crossProjectMemories.push(`[${proj.name}] ${entry.title}: ${entry.content}`);
                }
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

  // stdoutに出力（Hooksがこれをコンテキストに注入する）
  console.log(output.join("\n"));
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

main().catch(console.error);
