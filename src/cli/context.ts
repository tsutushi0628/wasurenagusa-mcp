#!/usr/bin/env node
/**
 * wasurenagusa-context CLI
 * SessionStart Hook用: config/dontを読み込んで標準出力に出力
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
  formatConsolidatedDont,
  formatConsolidatedConfig,
} from "../consolidator/index.js";
import { loadOwnerProfile, getOwnerProfilePath } from "../utils/owner-profile.js";
import { EmbeddingService } from "../vector/embedding-service.js";
import { VectorStore } from "../vector/vector-store.js";
import { TIER_THRESHOLDS } from "../vector/memory-tier.js";

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
    // agentモード: タイトル+件数+強度のインデックスのみ
    const consolidated = await readConsolidatedDont(memoryPath);
    if (consolidated && consolidated.principles.length > 0) {
      const sorted = [...consolidated.principles].sort((a, b) => b.score - a.score);
      const principleLines = sorted.map(
        p => `- [統合済み] ${p.theme}（${p.sourceCount}件, 強度${p.maxIntensity}）`
      );
      layers.push("### 行動原則（統合済み）\n" + principleLines.join("\n"));
    }

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

    const recentEntries = dontEntries
      .filter(e => {
        if (consolidatedSourceIds.has(e.id)) return false;
        const entryDate = new Date(e.timestamp);
        return entryDate >= thirtyDaysAgo;
      })
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 5);

    if (recentEntries.length > 0) {
      const recentLines = recentEntries.map(e => `- ${e.title}`);
      layers.push("### 直近の注意事項（最新5件）\n" + recentLines.join("\n"));
    }

    if (layers.length === 0) return "";
    return layers.join("\n\n");
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

async function main() {
  // stdinからHook入力JSONを読み取る
  let cwd: string;
  try {
    const inputData = await readStdin();
    if (inputData.trim()) {
      const hookInput: HookInput = JSON.parse(inputData);
      cwd = hookInput.cwd;
    } else {
      cwd = process.cwd();
    }
  } catch {
    cwd = process.cwd();
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
      output.push("### dont（行動原則）");
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

    // ベクトル検索による関連記憶 → タイトルのみ
    const embeddingService = new EmbeddingService(config.geminiApiKey);
    if (embeddingService.isAvailable()) {
      try {
        const vectorStore = new VectorStore(memoryPath);

        let queryEmbedding: number[];
        const topicPath = join(memoryPath, "last-session-topic.json");
        try {
          const topicRaw = await readFile(topicPath, "utf-8");
          const topicData = JSON.parse(topicRaw);
          if (topicData.embedding && Array.isArray(topicData.embedding)) {
            queryEmbedding = topicData.embedding;
          } else {
            queryEmbedding = await embeddingService.embed(currentProject);
          }
        } catch {
          queryEmbedding = await embeddingService.embed(currentProject);
        }

        const vectorResults = await vectorStore.search(
          queryEmbedding,
          TIER_THRESHOLDS.medium,
          5
        );

        if (vectorResults.length > 0) {
          const ids = vectorResults.map(r => r.id);
          const details = await storage.getDetail({ ids });

          output.push("### 関連する記憶（自動検索）");
          for (const entry of details.entries) {
            output.push(`- [ID:${entry.id}] ${entry.title}`);
          }
          output.push("");
        }
      } catch (error) {
        console.error("[vector] context注入時ベクトル検索失敗:", error);
      }
    }

    // 他プロジェクト横断検索 → タイトルのみ
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

          const crossTitles: string[] = [];

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
                  crossTitles.push(`- [${proj.name}] ${entry.title}`);
                }
              }
            } catch {
              continue;
            }
          }

          if (crossTitles.length > 0) {
            output.push("### 他プロジェクトの関連記憶");
            output.push(...crossTitles);
            output.push("");
          }
        }
      }
    } catch {
      // 横断検索の失敗は握りつぶす
    }

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
      output.push("## やってはいけないこと（dont）\n");
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

main().catch(console.error);
