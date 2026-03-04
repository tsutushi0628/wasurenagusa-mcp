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
import { MarkdownStorage } from "../storage/index.js";
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
    const storage = new MarkdownStorage(projectRoot);

    // 重複チェック: 同カテゴリの既存エントリと比較
    let replaceId: string | undefined;
    try {
      const existingSearch = await storage.search({
        query: analysis.title,
        category: analysis.category,
        limit: 50,
      });
      if (existingSearch.totalCount > 0) {
        const detail = await storage.getDetail({
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
    };

    await storage.save(saveParams);
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
}

main().catch((err) => {
  console.error(err);
});
