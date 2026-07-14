#!/usr/bin/env node
/**
 * wasurenagusa-context CLI
 * SessionStart Hook用: config/dontを読み込んで標準出力に出力
 * UserPromptSubmit Hook用: 記憶想起はプロジェクト側のhooksで管理するため何もしない
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
import { realpathSync } from "fs";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { findProjectRoot } from "../utils/projectRoot.js";
import { SQLiteStorage } from "../storage/index.js";
import { getMemoryPath, config } from "../config.js";

import { loadOwnerProfile, getOwnerProfilePath } from "../utils/owner-profile.js";
import { EmbeddingService } from "../vector/embedding-service.js";
import { increment } from "../observability/counters.js";
import { buildInjection, BENIGN_SKIP_LABELS } from "../injection/builder.js";
import {
  DEFAULT_INJECTION_TOKEN_BUDGET,
  enforceInjectionTokenBudget,
  estimateTokens,
  logInjectionBudgetWarning,
} from "../injection/budget.js";

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

// トークン概算・注入バジェット強制・fail-loud警告は src/injection/budget.ts が単一実装
// （タスク4.2でそちらへ移設。呼び出し側の再実装を禁止する）。既存の import 経路
// （このファイルからのimport）を壊さないよう、ここでは re-export のみ行う。
export {
  estimateTokens,
  DEFAULT_INJECTION_TOKEN_BUDGET,
  type InjectionBudgetResult,
  enforceInjectionTokenBudget,
  logInjectionBudgetWarning,
} from "../injection/budget.js";

export async function main() {
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

  // UserPromptSubmit: 記憶想起はプロジェクト側のhooksで管理するため何もしない
  if (hookEventName === "UserPromptSubmit") {
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

  // v1書き込み経路の物理遮断（タスク0.6、R-A3）: consolidate-worker（MarkdownStorage
  // 経由でconsolidated-dont.json等のv1資産へ書き込む）のSessionStartからのspawnは
  // 恒久停止済み。夜間統合（v2、Phase 3で追記型に再設計予定）に一本化する。

  // embedding backfill: API keyがあればバックグラウンドで未生成分を埋める
  const embeddingServiceForBackfill = new EmbeddingService(config.geminiApiKey, memoryPath);
  if (embeddingServiceForBackfill.isAvailable()) {
    spawnBackfillBackground(memoryPath, projectRoot);
  }

  // F3/F4: dream / success 各セクションを並列取得（fail-open: 失敗時は空文字）
  const [dreamContent, successContent] = await Promise.all([
    getDreamContent(storage, currentProject),
    getSuccessContent(storage, currentProject),
  ]);

  // 注入本文は最小索引＋承認済み原則のみで構成する（タスク4.2）。
  // 全文注入（30日分・サマリ欠落時の全文フォールバック）は行わない。
  const budgetTokens = parseInt(
    process.env.WASURENAGUSA_INJECTION_TOKEN_BUDGET || String(DEFAULT_INJECTION_TOKEN_BUDGET),
    10,
  );
  const injectionResult = buildInjection(storage, currentProject, budgetTokens);

  // 「素材が存在するのに注入されなかった」真の欠損だけを警告・計上する（rank2）。
  // 索引0件（minimal-index-empty）等の正常系ラベルは除外し、正当な空索引セッションで
  // 偽の「素材欠損」警告を上げない。除外後に残る欠損ラベルがあるときだけ fail-loud する。
  const deficiencySkips = injectionResult.skipped.filter((label) => !BENIGN_SKIP_LABELS.has(label));
  if (deficiencySkips.length > 0) {
    console.error("[injection] 素材欠損/切り詰め:", deficiencySkips.join(", "));
    await increment(memoryPath, "injection_skipped_count", deficiencySkips.length);
  }

  // 出力を組み立て
  const output: string[] = [];
  output.push("## 記憶インデックス（詳細はサブエージェント経由で memory_get_detail を使用）\n");
  output.push(injectionResult.text || "（対象なし）");
  output.push("");

  // F3 dream / F4 success（短文セクションのため全文注入の対象外として残す）
  if (dreamContent) {
    output.push(dreamContent + "\n");
  }
  if (successContent) {
    output.push(successContent + "\n");
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

  // ベクトル検索・他プロジェクト横断検索は全文注入の温床だったため廃止（タスク4.2）。
  // 必要時は memory_search / memory_get_detail をpull的に呼ぶ運用に一本化する。

  // メモリ活用ルール（サブエージェント委譲前提）
  output.push("## メモリ活用ルール");
  output.push("- 詳細が必要な場合はサブエージェントに memory_search / memory_get_detail を委譲すること");
  output.push("- メインコンテキストに記憶の生データを持ち込まない");
  output.push("- 「覚えろ」と言われたら memory_save で保存すること（MEMORY.mdへの書き込み禁止）");

  // 注入トークンバジェットを最終安全網として再度強制してからstdoutに出力
  // （buildInjectionの本文は既にバジェット内だが、dream/success/オーナープロファイル等
  // 追加セクションを足した最終合成後の総量を保証するため、ここでも一段適用する）。
  const budgetResult = enforceInjectionTokenBudget(output.join("\n"), budgetTokens);
  logInjectionBudgetWarning(budgetTokens, budgetResult);
  console.log(budgetResult.text);

  // 可観測性カウンタ（タスク0.9、R-M1）: 実際に注入した本文のトークン数を記録する。
  // context.tsはHook呼び出しの短命プロセスのため、fire-and-forget（void）にすると
  // プロセス終了が書き込み完了を待たずに先行しログが欠落しうる。ここはawaitする
  // （検索側 search.ts は長命なMCPサーバプロセス内で呼ばれるためfire-and-forgetのままでよい）。
  await increment(memoryPath, "injection_tokens", estimateTokens(budgetResult.text));

  storage.close();
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
