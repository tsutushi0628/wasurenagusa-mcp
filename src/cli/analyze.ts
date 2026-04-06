#!/usr/bin/env node
/**
 * wasurenagusa-analyze CLI
 * Stop Hook用: 会話を分析して重要情報を自動保存
 *
 * 使い方: wasurenagusa-analyze
 * stdinからHook入力JSONを受け取る（transcript_pathを含む）
 */

import { config as dotenvConfig } from "dotenv";
import { basename, dirname, join, resolve } from "path";
import { homedir } from "os";
import { mkdir, writeFile } from "fs/promises";
import { fileURLToPath } from "url";
import { Analyzer } from "../analyzer/index.js";
import { SQLiteStorage } from "../storage/index.js";
import { getMemoryPath, config } from "../config.js";
import { findProjectRoot } from "../utils/projectRoot.js";
import { SaveParams } from "../types.js";
import { computeConversationMeta } from "../analyzer/conversation-meta.js";
import { readTranscript } from "./transcript-reader.js";
import { ChangeLogger } from "../scheduler/change-logger.js";

// __dirnameベースで.envを探す（CWDに依存しない）
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const envPath = resolve(__dirname, "../../.env");
dotenvConfig({ path: envPath });

interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  stop_hook_active?: boolean;
}

async function main() {
  // stdinからHook入力を読み取る
  let inputData = "";
  for await (const chunk of process.stdin) {
    inputData += chunk;
  }

  const hookInput: HookInput = JSON.parse(inputData);

  // 無限ループ防止: stop_hook_activeがtrueなら何もしない
  if (hookInput.stop_hook_active) {
    process.exit(0);
  }

  // スケジューラー起動のClaude CLIセッションは分析をスキップ（ログ爆発防止）
  if (process.env.WASURENAGUSA_SCHEDULER === "1") {
    process.exit(0);
  }

  // LLM APIキーがない場合はスキップ
  if (!process.env.GEMINI_API_KEY && !process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    process.exit(0);
  }

  // トランスクリプトを読み込み
  const { conversationLog, parsedMessages } = await readTranscript(hookInput.transcript_path);
  if (!conversationLog) {
    process.exit(0);
  }

  // メタ情報を計算（諦め検知用）
  const meta = computeConversationMeta(parsedMessages);

  // LLMで分析
  const analyzer = new Analyzer();
  const analysis = await analyzer.analyze({
    conversationLog,
    latestMessage: conversationLog.split("\n\n").slice(-1)[0] || "",
    meta,
  });

  // 保存が必要な場合
  if (analysis.shouldSave && analysis.category && analysis.title && analysis.summary) {
    const projectRoot = findProjectRoot(hookInput.cwd);
    const memoryPath = getMemoryPath(projectRoot);
    const dbPath = join(memoryPath, config.sqliteFile);
    const storage = new SQLiteStorage(dbPath);
    storage.initialize(memoryPath);

    // 重複チェック: 同カテゴリの既存エントリと比較
    let replaceId: string | undefined;
    try {
      const existingSearch = storage.search({
        query: analysis.title,
        category: analysis.category,
        limit: 50,
      });
      if (existingSearch.totalCount > 0) {
        const detail = storage.getDetail({
          ids: existingSearch.results.map(r => r.id),
        });
        const existingEntries = detail.entries.map(e => ({
          id: e.id,
          title: e.title,
          content: e.content,
        }));
        const duplicateId = await analyzer.checkDuplicate({
          newTitle: analysis.title,
          newContent: analysis.summary,
          existingEntries,
        });
        if (duplicateId) {
          replaceId = duplicateId;
        }
      }
    } catch {
      // 重複チェック失敗時は新規追加にフォールバック
    }

    const saveParams: SaveParams = {
      category: analysis.category,
      title: analysis.title,
      content: analysis.summary,
      tags: analysis.tags,
      project: basename(projectRoot),
      scope: analysis.scope || undefined,
      replaceId,
      intensity: analysis.intensity,
    };

    storage.save(saveParams);
    storage.close();
  }

  // 変更ログ記録（Stop Hook相乗り）
  try {
    const schedulerDir = join(homedir(), ".wasurenagusa", "scheduler");
    await mkdir(schedulerDir, { recursive: true });
    const changeLogger = new ChangeLogger(schedulerDir);
    await changeLogger.recordChanges(hookInput.cwd);
  } catch {
    // 変更ログ記録の失敗は握りつぶす（既存機能を壊さない）
  }

  // 最終セッション終了時刻を記録（スケジューラのアイドル判定用）
  try {
    const schedulerDir = join(homedir(), ".wasurenagusa", "scheduler");
    await mkdir(schedulerDir, { recursive: true });
    const lastSessionPath = join(schedulerDir, "last-session.json");
    await writeFile(lastSessionPath, JSON.stringify({ endedAt: new Date().toISOString() }));
  } catch {
    // 記録失敗は握りつぶす
  }

  // セッショントピックのembedding保存（shouldSaveに関係なく毎セッション）
  if (analysis.sessionTopic) {
    try {
      const { EmbeddingService } = await import("../vector/embedding-service.js");
      const { config } = await import("../config.js");
      const embeddingService = new EmbeddingService(config.geminiApiKey);
      if (embeddingService.isAvailable()) {
        const topicEmbedding = await embeddingService.embed(analysis.sessionTopic);

        // last-session-topic.json に保存（次のSessionStartで使用）
        const topicProjectRoot = findProjectRoot(hookInput.cwd);
        const { getMemoryPath } = await import("../config.js");
        const memoryPath = getMemoryPath(topicProjectRoot);
        const topicPath = join(memoryPath, "last-session-topic.json");

        const topicData = {
          topic: analysis.sessionTopic,
          embedding: topicEmbedding,
          project: basename(topicProjectRoot),
          sessionId: hookInput.session_id,
          timestamp: new Date().toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" }).replace(" ", "T") + "+09:00",
        };

        await writeFile(topicPath, JSON.stringify(topicData, null, 2));
      }
    } catch (error) {
      console.error("[session-topic] embedding保存失敗:", error);
    }
  }

  // アクティブプロジェクト更新（横断記憶検索用）
  try {
    const schedulerDir = join(homedir(), ".wasurenagusa", "scheduler");
    const { ActiveProjectsTracker } = await import("../active-projects.js");
    const activeTracker = new ActiveProjectsTracker(schedulerDir);
    const activeProjectRoot = findProjectRoot(hookInput.cwd);
    let topicText = "";
    if (analysis.sessionTopic) {
      topicText = analysis.sessionTopic;
    }
    await activeTracker.update({
      name: basename(activeProjectRoot),
      path: activeProjectRoot,
      lastSessionAt: new Date().toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" }).replace(" ", "T") + "+09:00",
      sessionTopic: topicText,
    });
  } catch {
    // アクティブプロジェクト更新の失敗は握りつぶす（既存機能を壊さない）
  }
}

main().catch((err) => {
  console.error(err);
});
