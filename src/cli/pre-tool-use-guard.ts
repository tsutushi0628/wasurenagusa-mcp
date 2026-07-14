#!/usr/bin/env node
/**
 * wasurenagusa-pretool-guard CLI
 * PreToolUse Hook用: Claude Code がツールを実行する直前に、承認制ガードレジストリ
 * （guards テーブル。src/guards/registry.ts）の state='active' かつ期限内の規則で
 * tool_input をチェックする。
 *
 * 照合元は memory-redesign spec Phase 4 タスク4.5 で consolidated-dont.json の
 * guardPattern 読取から guards テーブルへ差し替え済み（統合キャッシュJSONの
 * guardPatterns 読み取りは廃止）。旧 checkGuard ベースの純粋関数（runPreToolUseGuard等）
 * は Stop Hook（guard.ts）向けの後方互換のためファイル内に残すが、本CLIの main() は
 * 参照しない。
 *
 * 評価の最前段はキルスイッチ→サーキットブレーカ→ガード評価の順で固定する（タスク4.6）。
 * 既定モードは dry-run（タスク4.15。違反を検出してもブロックせずログにのみ記録する）。
 * settings.json本配線・実ブロック有効化はオーナー承認後の別作業（本タスクでは行わない）。
 *
 * - dry-run（既定）: 検出しても常に exit 0（ブロックしない）。履歴のみ記録する
 * - enforce（WASURENAGUSA_GUARD_MODE=enforce 明示時のみ）: マッチ → exit 2 + stderr
 * - キルスイッチ有効時・サーキットブレーカ作動時: 評価自体をスキップして exit 0
 *
 * fail-open 設計を厳守: 想定外例外は全て exit 0 でツール実行を通過させる。
 */

import { join } from "path";
import { findProjectRoot } from "../utils/projectRoot.js";
import { getMemoryPath, config } from "../config.js";
import {
  checkGuard,
  extractGuardPrinciples,
  readBlockCounts,
  writeBlockCounts,
  type GuardResult,
  type BlockCounts,
} from "./guard.js";
import { increment } from "../observability/counters.js";
import type { ConsolidatedDont } from "../types.js";
import { isKilled } from "../guards/kill-switch.js";
import { isCircuitOpen, getRecentHistory, recordEvaluation } from "../guards/circuit-breaker.js";
import { getActiveGuards, evaluateGuardsWithMode, DEFAULT_GUARD_RUN_MODE, type GuardRunMode } from "../guards/registry.js";
import { SQLiteStorage } from "../storage/sqlite.js";

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

function resolveGuardMode(): GuardRunMode {
  // 既定は dry-run（タスク4.15）。settings.json本配線・本番有効化は別作業のオーナー承認後。
  return process.env.WASURENAGUSA_GUARD_MODE === "enforce" ? "enforce" : DEFAULT_GUARD_RUN_MODE;
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

  // 最前段①: 外部キルスイッチ（ストア直下 guards.kill の存在で即時全停止）。
  if (isKilled(memoryPath)) {
    process.exit(0);
  }

  // 最前段②: サーキットブレーカ（直近100回のブロック率>10%で全ガード自動停止＋警報）。
  const recentHistory = await getRecentHistory(memoryPath);
  if (isCircuitOpen(recentHistory)) {
    console.error(
      "[wasurenagusa-pretool-guard] サーキットブレーカ作動: 直近評価のブロック率が閾値を超過したため全ガードを停止しました。"
    );
    process.exit(0);
  }

  const message = extractToolInputMessage(hookInput);
  if (!message) {
    process.exit(0);
  }

  // guards テーブル（正本）から state='active' かつ期限内の規則を取得して評価する。
  // 未承認(proposed)・失効(expired)・停止(disabled)は一切評価されない（fail-safe）。
  let storage: SQLiteStorage | undefined;
  try {
    storage = new SQLiteStorage(join(memoryPath, config.sqliteFile));
    storage.initialize(memoryPath);
    const activeGuards = getActiveGuards(storage.connection);
    const mode = resolveGuardMode();
    const { result, observation } = evaluateGuardsWithMode(message, activeGuards, mode);

    // サーキットブレーカ履歴へ記録（検出の実態＝observation.action。dry-runでも記録する）。
    await recordEvaluation(memoryPath, observation.action);

    if (result.action === "block") {
      await increment(memoryPath, "guard_block_count", 1);
      if (result.message) {
        process.stderr.write(result.message + "\n");
      }
      storage.close();
      process.exit(2);
    }

    storage.close();
    process.exit(0);
  } catch {
    // guards テーブル未初期化・DB接続失敗等 → fail-open（ガード不能でも通過させる）
    try {
      storage?.close();
    } catch {
      // クローズ失敗も握りつぶす（fail-open）
    }
    process.exit(0);
  }
}

main().catch(() => {
  // 想定外エラー → fail-open（絶対にツール実行をブロックしない）
  process.exit(0);
});
