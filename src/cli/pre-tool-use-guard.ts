#!/usr/bin/env node
/**
 * wasurenagusa-pretool-guard CLI
 * PreToolUse Hook用: Claude Code がツールを実行する直前に
 * consolidated-dont.json の guardPattern で tool_input をチェックする。
 *
 * stdin から PreToolUse hook input JSON（tool_name + tool_input 含む）を受け取り、
 * tool_input を JSON.stringify した文字列を message として既存 guard.ts の
 * checkGuard 純粋関数に渡す。
 *
 * - マッチ → exit 2 + stderr に理由（Claude Code がツール実行を中断）
 * - 不一致 → exit 0
 * - 同一セッション・同一パターンで MAX_BLOCK_COUNT(3) 超過 → exit 0（警告のみ）
 *
 * fail-open 設計を厳守: 想定外例外は全て exit 0 でツール実行を通過させる。
 */

import { join } from "path";
import { readFile } from "fs/promises";
import { findProjectRoot } from "../utils/projectRoot.js";
import { getMemoryPath } from "../config.js";
import {
  checkGuard,
  extractGuardPrinciples,
  readBlockCounts,
  writeBlockCounts,
  type GuardResult,
  type BlockCounts,
} from "./guard.js";
import type { ConsolidatedDont } from "../types.js";

export interface PreToolUseHookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  tool_name: string;
  tool_input?: Record<string, unknown>;
}

/**
 * tool_input を JSON 文字列に変換する。
 * undefined のときは空文字列、JSON.stringify が失敗したら空文字列（fail-open）。
 */
export function extractToolInputMessage(input: PreToolUseHookInput): string {
  if (input.tool_input === undefined || input.tool_input === null) {
    return "";
  }
  try {
    return JSON.stringify(input.tool_input);
  } catch {
    return "";
  }
}

/**
 * PreToolUse ガード判定。テスト可能な純粋関数。
 * consolidated が null/undefined のときは pass を返す（fail-open）。
 */
export function runPreToolUseGuard(
  input: PreToolUseHookInput,
  blockCounts: BlockCounts,
  consolidated: ConsolidatedDont | null,
): GuardResult {
  if (!consolidated) {
    return { action: "pass" };
  }

  const message = extractToolInputMessage(input);
  if (!message) {
    return { action: "pass" };
  }

  const guardPrinciples = extractGuardPrinciples(consolidated);
  if (guardPrinciples.length === 0) {
    return { action: "pass" };
  }

  return checkGuard(message, guardPrinciples, blockCounts);
}

async function main() {
  // stdin から Hook 入力を読み取る（1MB 上限: 巨大入力による OOM 防止）
  const MAX_STDIN_SIZE = 1024 * 1024; // 1MB
  let inputData = "";
  for await (const chunk of process.stdin) {
    inputData += chunk;
    if (inputData.length > MAX_STDIN_SIZE) {
      // fail-open: 入力が巨大すぎる → ガード不能、通過
      process.exit(0);
    }
  }

  let hookInput: PreToolUseHookInput;
  try {
    hookInput = JSON.parse(inputData);
  } catch {
    // JSON 解析失敗 → fail-open
    process.exit(0);
  }

  // tool_input が無いと判定不能 → fail-open
  if (!hookInput.tool_input) {
    process.exit(0);
  }

  // cwd からプロジェクトルートとメモリパスを取得
  let memoryPath: string;
  try {
    const projectRoot = findProjectRoot(hookInput.cwd);
    memoryPath = getMemoryPath(projectRoot);
  } catch {
    // プロジェクトルート特定失敗 → fail-open
    process.exit(0);
  }

  // consolidated-dont.json を読み込み
  let consolidated: ConsolidatedDont | null;
  try {
    const filePath = join(memoryPath, "consolidated-dont.json");
    const raw = await readFile(filePath, "utf-8");
    consolidated = JSON.parse(raw) as ConsolidatedDont;
  } catch {
    // ファイルなし/読み込み失敗 → fail-open（ガードなし）
    process.exit(0);
  }

  if (!consolidated) {
    process.exit(0);
  }

  // ブロックカウント読み込み
  const sessionId = hookInput.session_id ?? "unknown";
  const blockCounts = await readBlockCounts(sessionId);

  // ガード判定実行
  const result = runPreToolUseGuard(hookInput, blockCounts, consolidated);

  // ガード判定の出力フォーマットを pretool-guard 用に整える
  const formatStderr = (msg: string): string => {
    // checkGuard の prefix は "[wasurenagusa-guard]" なので、PreTool 版に置換
    return msg.replace(/^\[wasurenagusa-guard\]/, "[wasurenagusa-pretool-guard]");
  };

  if (result.action === "block") {
    await writeBlockCounts(sessionId, blockCounts);
    if (result.message) {
      process.stderr.write(formatStderr(result.message) + "\n");
    }
    process.exit(2);
  }

  // pass（警告メッセージありの場合）
  if (result.message) {
    process.stderr.write(formatStderr(result.message) + "\n");
  }
  process.exit(0);
}

main().catch(() => {
  // 想定外エラー → fail-open（絶対にツール実行をブロックしない）
  process.exit(0);
});
