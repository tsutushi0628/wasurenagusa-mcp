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

import { basename } from "path";
import { spawn } from "child_process";
import { findProjectRoot } from "../utils/projectRoot.js";
import { MarkdownStorage } from "../storage/index.js";
import { getMemoryPath, config } from "../config.js";
import {
  isConsolidationStale,
  readConsolidatedDont,
  formatConsolidatedDont,
} from "../consolidator/index.js";
import { loadOwnerProfile, getOwnerProfilePath } from "../utils/owner-profile.js";

interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  source?: string;
  model?: string;
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
  const scriptPath = new URL("./consolidate-worker.js", import.meta.url).pathname;
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
  projectRoot: string,
): Promise<string> {
  try {
    // 統合が古くなっていればバックグラウンドで再統合を開始（次回セッション向け）
    if (await isConsolidationStale(memoryPath)) {
      if (config.geminiApiKey) {
        spawnConsolidationBackground(memoryPath, projectRoot);
      }
    }

    // 現時点の統合版を読み込み（前回のconsolidation結果）
    const consolidated = await readConsolidatedDont(memoryPath);
    if (consolidated) {
      const formatted = formatConsolidatedDont(consolidated);
      if (formatted) return formatted;
    }
  } catch {
    // 統合読み込み失敗時はフォールバック
  }

  // フォールバック: 従来の全件注入
  const context = await storage.getContext(currentProject);
  return context.dont;
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
  const context = await storage.getContext(currentProject);

  // dont部分は統合レイヤー経由で取得
  const dontContent = await getDontContent(storage, currentProject, memoryPath, projectRoot);

  // 出力を組み立て
  const output: string[] = [];

  output.push("=== wasurenagusa メモリ ===\n");

  if (context.config && context.config !== "（設定情報なし）") {
    output.push("## 設定情報（config）\n");
    output.push(context.config + "\n");
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
    // 初回テンプレート配置時のガイド
    const profilePath = getOwnerProfilePath(memoryPath);
    output.push(`（owner-profile.md が未記入です。お時間のある時に記入してください: ${profilePath}）\n`);
  }

  if (output.length === 1) {
    output.push("（まだメモリがありません）");
  }

  // stdoutに出力（Hooksがこれをコンテキストに注入する）
  console.log(output.join("\n"));
}

main().catch(console.error);
