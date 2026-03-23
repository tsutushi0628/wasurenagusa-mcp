#!/usr/bin/env node
/**
 * wasurenagusa-guard CLI
 * Stop Hook用: consolidated-dont.jsonのguardPatternでClaudeの応答をチェック
 *
 * stdinからStopフックJSON（last_assistant_message含む）を受け取り、
 * maxIntensity >= 5 のguardPatternでマッチ検査する。
 *
 * - マッチ → exit 2 + stderrに理由（Claudeがやり直す）
 * - 不一致 → exit 0
 * - 同一セッション・同一パターンで3回超過 → exit 0（警告のみ、通過させる）
 *
 * fail-open設計: ガード機能が壊れてセッションをブロックする事態は絶対に避ける
 */

import { join } from "path";
import { readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import vm from "node:vm";
import { findProjectRoot } from "../utils/projectRoot.js";
import { getMemoryPath } from "../config.js";
import type { ConsolidatedDont, ConsolidatedPrinciple } from "../types.js";

export const MAX_BLOCK_COUNT = 3;

export interface StopHookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  last_assistant_message?: string;
  stop_hook_active?: boolean;
}

export interface BlockCounts {
  [pattern: string]: number;
}

export interface GuardResult {
  /** "pass" = exit 0, "block" = exit 2 */
  action: "pass" | "block";
  /** stderrに出力するメッセージ（blockまたは警告通過時） */
  message?: string;
}

// NOTE: read-modify-writeの競合リスクあるが、Claude Code Hooksはシーケンシャル実行のため実害なし
export function getBlockCountPath(sessionId: string): string {
  return join(tmpdir(), `wasurenagusa-guard-${sessionId}.json`);
}

export async function readBlockCounts(sessionId: string): Promise<BlockCounts> {
  try {
    const raw = await readFile(getBlockCountPath(sessionId), "utf-8");
    return JSON.parse(raw);
  } catch {
    // fail-open: ファイルなし or JSON不正 → 初回扱い（ガードが壊れてセッションをブロックしない）
    return {};
  }
}

export async function writeBlockCounts(sessionId: string, counts: BlockCounts): Promise<void> {
  try {
    await writeFile(getBlockCountPath(sessionId), JSON.stringify(counts));
  } catch {
    // 書き込み失敗は握りつぶす
  }
}

/**
 * タイムアウト付き正規表現テスト（ReDoS対策）。
 * vm.runInNewContextで隔離実行し、タイムアウト時はfalseを返す（fail-open）。
 */
export function safeRegexTest(pattern: string, input: string, timeoutMs: number = 100): boolean {
  try {
    const script = new vm.Script(`new RegExp(pattern, "i").test(input)`);
    const context = vm.createContext({ pattern, input });
    return script.runInNewContext(context, { timeout: timeoutMs }) as boolean;
  } catch {
    // タイムアウトまたはエラー → fail-open（マッチしなかったとみなす）
    return false;
  }
}

export function extractGuardPrinciples(consolidated: ConsolidatedDont): ConsolidatedPrinciple[] {
  return consolidated.principles.filter(
    (p) => p.maxIntensity >= 5 && p.guardPattern
  );
}

/**
 * ガードチェックのコアロジック。
 * テスト可能な純粋関数（ファイルI/O部分はblockCountsを引数で受け取る）。
 */
export function checkGuard(
  message: string,
  guardPrinciples: ConsolidatedPrinciple[],
  blockCounts: BlockCounts,
): GuardResult {
  for (const principle of guardPrinciples) {
    const patternStr = principle.guardPattern;
    if (!patternStr) continue;

    if (safeRegexTest(patternStr, message)) {
      const currentCount = blockCounts[patternStr] ?? 0;

      if (currentCount >= MAX_BLOCK_COUNT) {
        return {
          action: "pass",
          message: `[wasurenagusa-guard] 警告: "${principle.theme}" に${currentCount + 1}回目のマッチ。上限超過のため通過させます。`,
        };
      }

      // ブロックカウント更新（呼び出し元がpersistする）
      blockCounts[patternStr] = currentCount + 1;

      const guardMessage =
        principle.guardMessage || `行動原則「${principle.theme}」に違反しています。`;
      return {
        action: "block",
        message: `[wasurenagusa-guard] ${guardMessage}`,
      };
    }
  }

  return { action: "pass" };
}

async function main() {
  // stdinからHook入力を読み取る（1MB上限: 巨大入力によるOOM防止）
  const MAX_STDIN_SIZE = 1024 * 1024; // 1MB
  let inputData = "";
  for await (const chunk of process.stdin) {
    inputData += chunk;
    if (inputData.length > MAX_STDIN_SIZE) {
      // fail-open: 入力が巨大すぎる → ガード不能、通過させる
      process.exit(0);
    }
  }

  let hookInput: StopHookInput;
  try {
    hookInput = JSON.parse(inputData);
  } catch {
    // JSON解析失敗 → fail-open
    process.exit(0);
  }

  // last_assistant_messageがなければチェック不要
  const message = hookInput.last_assistant_message;
  if (!message) {
    process.exit(0);
  }

  // cwdからプロジェクトルートとメモリパスを取得
  let memoryPath: string;
  try {
    const projectRoot = findProjectRoot(hookInput.cwd);
    memoryPath = getMemoryPath(projectRoot);
  } catch {
    // プロジェクトルート特定失敗 → fail-open
    process.exit(0);
  }

  // consolidated-dont.jsonを読み込み
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

  // guardPatternを持つ高intensity principleを抽出
  const guardPrinciples = extractGuardPrinciples(consolidated);
  if (guardPrinciples.length === 0) {
    process.exit(0);
  }

  // ブロックカウント読み込み
  const sessionId = hookInput.session_id ?? "unknown";
  const blockCounts = await readBlockCounts(sessionId);

  // ガードチェック実行
  const result = checkGuard(message, guardPrinciples, blockCounts);

  if (result.action === "block") {
    await writeBlockCounts(sessionId, blockCounts);
    if (result.message) {
      process.stderr.write(result.message + "\n");
    }
    process.exit(2);
  }

  // pass
  if (result.message) {
    process.stderr.write(result.message + "\n");
  }
  process.exit(0);
}

main().catch(() => {
  // 想定外エラー → fail-open
  process.exit(0);
});
