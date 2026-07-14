#!/usr/bin/env node
/**
 * scripts/gates/g4-injection-guard.ts
 * Phase 4（最小注入＋承認制ガード）完了ゲート（design.md Phase 4 ③、タスク4.11、R-M3）。
 *
 * 検証役（qa-engineer）専用資産。実装者は編集しない（design.md「ゲート運用」）。
 *
 * 契約11項目: injection-budget（PT-02再利用） / injection-composition / fail-loud /
 * pull-fixed-blocks / get-context-cap / guard-approval / guard-cap（PT-03再利用） /
 * circuit-breaker / kill-switch / dead-code-removed / before-after。
 *
 * old g0の1KB下限（MIN_INJECTION_BYTES）は使わない。Phase4はバジェット上限と
 * 最小索引の構成適合（composition）のみを見る（design.md Phase 4 ③に1KB下限の記載はない）。
 *
 * 各検査は「静的構造検査（ソース走査、G3方式）」または「関数検査（実装関数を合成フィクスチャに
 * 通す、PT-02/PT-03方式）」のいずれか。関数検査は意図的な違反状態のテストを可能にするため、
 * 検査対象の実装関数を差し替え可能な overrides 引数を持つ（既定値は本番実装そのもの）。
 *
 * Usage:
 *   node --loader ts-node/esm scripts/gates/g4-injection-guard.ts \
 *     [--repo-root <dir>] [--store <ストアパス（スナップショット可）>]
 *
 * 出力形式: G0/G1/G3と同型（1検査1行のJSON: check/result/measured/threshold）。
 * 記憶本文は一切出力しない（件数・真偽値・比率・ファイル位置のみ）。
 */
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";
import { existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import Database from "better-sqlite3";
import * as fc from "fast-check";

import { SQLiteStorage } from "../../src/storage/sqlite.js";
import { buildInjection as prodBuildInjection } from "../../src/injection/builder.js";
import { estimateTokens, DEFAULT_INJECTION_TOKEN_BUDGET } from "../../src/injection/budget.js";
import { GUARDS_DDL } from "../../src/storage/schema.js";
import {
  getActiveGuards as prodGetActiveGuards,
  evaluateGuards as prodEvaluateGuards,
  activateGuard as prodActivateGuard,
  countActiveGuards,
  GuardCapExceededError,
  DEFAULT_MAX_ACTIVE_GUARDS,
  type GuardRule,
} from "../../src/guards/registry.js";
import {
  isCircuitOpen as prodIsCircuitOpen,
  type EvalAction,
} from "../../src/guards/circuit-breaker.js";
import { isKilled as prodIsKilled, KILL_SWITCH_FILE_NAME } from "../../src/guards/kill-switch.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_REPO_ROOT = resolve(__dirname, "..", "..");

export interface CheckResult {
  check: string;
  result: "PASS" | "FAIL";
  measured: Record<string, unknown>;
  threshold: Record<string, unknown>;
}

function read(repoRoot: string, rel: string): string | null {
  const p = join(repoRoot, rel);
  return existsSync(p) ? readFileSync(p, "utf-8") : null;
}

// ------------------------------------------------------------------
// 前提アサート
// ------------------------------------------------------------------

export interface PreconditionResult {
  ok: boolean;
  dbOpens: boolean;
  schemaVersion: number | null;
  memoriesCount: number;
  reason?: string;
}

/**
 * design.md契約:「schema_version テーブルの MAX(version)=8、memories 総件数が1,000件以上」。
 * ただし実装は本Spec内で version 8 以降も正当に進行しうる（guardsテーブル新設=8が最低要件）ため、
 * 「8以上」で判定する（8固定はP4着手時点の版数を指しており、以降の版数前進を誤ってFAIL扱いに
 * しないための解釈。契約の実質＝guardsテーブルが存在する版数以降であること、を守る）。
 */
export function checkPreconditions(storePath: string): PreconditionResult {
  const dbPath = join(storePath, "memory.db");
  if (!existsSync(dbPath)) {
    return { ok: false, dbOpens: false, schemaVersion: null, memoriesCount: 0, reason: "DBファイルが存在しない" };
  }
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (e) {
    return { ok: false, dbOpens: false, schemaVersion: null, memoriesCount: 0, reason: `DBが開けない: ${String(e)}` };
  }
  try {
    const versionRow = db.prepare("SELECT MAX(version) as v FROM schema_version").get() as { v: number | null };
    const schemaVersion = versionRow?.v ?? null;
    const countRow = db.prepare("SELECT COUNT(*) as c FROM memories").get() as { c: number };
    const memoriesCount = countRow.c;
    const ok = schemaVersion !== null && schemaVersion >= 8 && memoriesCount >= 1000;
    return {
      ok,
      dbOpens: true,
      schemaVersion,
      memoriesCount,
      reason: ok ? undefined : `前提不成立（schemaVersion=${schemaVersion}, memoriesCount=${memoriesCount}）`,
    };
  } finally {
    db.close();
  }
}

// ------------------------------------------------------------------
// injection-budget（PT-02再利用）: buildInjectionの戻り値が常にバジェット以下
// ------------------------------------------------------------------

export interface InjectionBudgetDeps {
  buildInjection: typeof prodBuildInjection;
}

export function checkInjectionBudget(deps: InjectionBudgetDeps = { buildInjection: prodBuildInjection }): CheckResult {
  let violations = 0;
  let runs = 0;
  const budgetTokens = DEFAULT_INJECTION_TOKEN_BUDGET;
  try {
    fc.assert(
      fc.property(
        fc.array(fc.record({ titleLength: fc.integer({ min: 0, max: 400 }) }), { minLength: 0, maxLength: 40 }),
        (plans) => {
          runs++;
          const tmpDir = mkdtempSync(join(tmpdir(), "g4-injection-budget-"));
          const storage = new SQLiteStorage(join(tmpDir, "test.db"));
          storage.initialize();
          try {
            plans.forEach((p, i) => {
              storage.save({
                category: "log",
                title: "あ".repeat(p.titleLength) || `t${i}`,
                content: `content-${i}`,
              });
            });
            const result = deps.buildInjection(storage, undefined, budgetTokens, new Date());
            if (estimateTokens(result.text) > budgetTokens) violations++;
          } finally {
            storage.close();
            rmSync(tmpDir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 100 },
    );
  } catch {
    // fc.assertはproperty内でthrowしない設計にしているため通常ここには来ないが、
    // 予期しない例外もFAIL側に倒す。
    violations = Math.max(violations, 1);
  }
  return {
    check: "injection-budget",
    result: violations === 0 ? "PASS" : "FAIL",
    measured: { runs, violations, budgetTokens },
    threshold: { violations: 0 },
  };
}

// ------------------------------------------------------------------
// injection-composition: 注入本文が「最小索引」定義に適合する（design.md Data Models）
// ------------------------------------------------------------------

export function checkInjectionComposition(repoRoot: string): CheckResult {
  const builderSrc = read(repoRoot, "src/injection/builder.ts") ?? "";
  const sqliteSrc = read(repoRoot, "src/storage/sqlite.ts") ?? "";
  const violations: string[] = [];

  if (!/getMinimalIndexEntries\(/.test(builderSrc)) violations.push("最小索引取得(getMinimalIndexEntries)を呼んでいない");
  if (!/getInjectablePrinciples\(/.test(builderSrc)) violations.push("確定原則取得(getInjectablePrinciples)を呼んでいない");
  // 索引側: state='active'のタイトル行のみを対象にすること（本文contentを注入しない）。
  if (!/state\s*=\s*'active'/.test(sqliteSrc)) violations.push("最小索引がstate='active'を条件にしていない");
  if (/`\[\$\{e\.category\}\]\s*\$\{e\.title\}\s*\(\$\{e\.id\}\)`/.test(builderSrc) === false &&
      !/\[\$\{e\.category\}\]\s+\$\{e\.title\}\s+\(\$\{e\.id\}\)/.test(builderSrc)) {
    violations.push("索引の出力形式が「[カテゴリ] 要旨 (ID)」でない");
  }
  // 原則側: approved かつ有効期限内のみ（構造的に含める）。
  if (!/approved_at IS NOT NULL/.test(sqliteSrc) || !/valid_until\s*>\s*\?/.test(sqliteSrc)) {
    violations.push("確定原則がapproved_at非NULLかつvalid_until未到来を要求していない");
  }
  // 全文本文を注入本文へ混入させる経路が無いこと（索引はタイトルのみで本文contentを含めない）。
  if (/e\.content|entry\.content/.test(builderSrc)) {
    violations.push("注入本文の構成にcontent（本文全文）を含めている");
  }

  return {
    check: "injection-composition",
    result: violations.length === 0 ? "PASS" : "FAIL",
    measured: { violations },
    threshold: { violations: 0 },
  };
}

// ------------------------------------------------------------------
// fail-loud: サマリ欠損状態で全文が注入されず、スキップ計数と警報が出る
// ------------------------------------------------------------------

export function checkFailLoud(repoRoot: string): CheckResult {
  const builderSrc = read(repoRoot, "src/injection/builder.ts") ?? "";
  const contextSrc = read(repoRoot, "src/cli/context.ts") ?? "";
  const violations: string[] = [];

  // builder.ts: 取得失敗時はskippedへ積むのみで、全文フォールバックしない。
  if (!/skipped\.push\(/.test(builderSrc)) violations.push("builder.tsにskipped計数が無い");
  if (/catch[\s\S]{0,200}(readContent|fullText|全文)/.test(builderSrc)) {
    violations.push("builder.tsのcatch節に全文フォールバックの痕跡がある");
  }
  // context.ts: 「素材が存在するのに注入されなかった」真の欠損が1件以上なら warning(console.error)と
  // カウンタ計上を行う。索引0件（minimal-index-empty）等の正常系ラベルは BENIGN_SKIP_LABELS で除外し、
  // 除外後に残る欠損（deficiencySkips）で判定する（rank2: 正当な空索引で偽警告を上げない）。
  if (!/BENIGN_SKIP_LABELS/.test(contextSrc)) {
    violations.push("context.tsが正常系ラベル(BENIGN_SKIP_LABELS)を除外していない");
  }
  if (!/(deficiencySkips|injectionResult\.skipped)\.length\s*>\s*0/.test(contextSrc)) {
    violations.push("context.tsが欠損件数を判定していない");
  }
  if (!/console\.error\(["']\[injection\]/.test(contextSrc)) {
    violations.push("context.tsがfail-loud警報(console.error)を出していない");
  }
  if (!/increment\(memoryPath,\s*["']injection_skipped_count["']/.test(contextSrc)) {
    violations.push("context.tsがinjection_skipped_countを計上していない");
  }
  // 全文注入を行わない旨の物理的裏付け（30日分全文注入の廃止コメント/実装が復活していない）。
  if (/全文注入.*行う|readEntriesByCategory\([^)]*\).*join.*inject/i.test(contextSrc)) {
    violations.push("context.tsに全文注入の痕跡がある");
  }

  return {
    check: "fail-loud",
    result: violations.length === 0 ? "PASS" : "FAIL",
    measured: { violations },
    threshold: { violations: 0 },
  };
}

// ------------------------------------------------------------------
// pull-fixed-blocks: 検索応答に固定付帯ブロックが含まれない
// ------------------------------------------------------------------

export function checkPullFixedBlocks(repoRoot: string): CheckResult {
  const searchSrc = read(repoRoot, "src/tools/search.ts") ?? "";
  const violations: string[] = [];

  if (!existsSync(join(repoRoot, "src/tools/search.ts"))) {
    violations.push("src/tools/search.tsが存在しない");
  } else {
    // handleMemorySearch内でlistHighIntensityDontsを無条件に呼んでいないこと（push型付帯の禁止）。
    if (/listHighIntensityDonts\(/.test(searchSrc)) {
      violations.push("search.tsがlistHighIntensityDontsを呼んでいる（無条件付帯の疑い）");
    }
    // slimResultの構成要素がresults/totalCount/hintのみであること（固定ブロックのプロパティが無い）。
    const slimResultMatch = searchSrc.match(/slimResult:\s*\{([\s\S]{0,400}?)\}\s*=\s*\{/);
    if (slimResultMatch) {
      const fields = slimResultMatch[1];
      if (/dont|highIntensity|固定/.test(fields)) {
        violations.push("slimResultの型定義に固定付帯ブロックのフィールドがある");
      }
    }
  }

  return {
    check: "pull-fixed-blocks",
    result: violations.length === 0 ? "PASS" : "FAIL",
    measured: { violations },
    threshold: { violations: 0 },
  };
}

// ------------------------------------------------------------------
// get-context-cap: 上限適用の確認
// ------------------------------------------------------------------

export function checkGetContextCap(repoRoot: string): CheckResult {
  // 上限定数・getContext本体は src/storage/sqlite.ts に実装されている（src/cli/context.tsではない）。
  const sqliteSrc = read(repoRoot, "src/storage/sqlite.ts") ?? "";
  const violations: string[] = [];

  if (!/GET_CONTEXT_MAX_ENTRIES\s*=\s*200/.test(sqliteSrc)) violations.push("GET_CONTEXT_MAX_ENTRIES=200が無い");
  if (!/GET_CONTEXT_MAX_CHARS\s*=\s*20000/.test(sqliteSrc)) violations.push("GET_CONTEXT_MAX_CHARS=20000が無い");
  if (!/truncated/.test(sqliteSrc)) violations.push("truncatedフラグの実装が無い");
  if (!/getContext\(currentProject/.test(sqliteSrc)) violations.push("getContext本体が見つからない");

  return {
    check: "get-context-cap",
    result: violations.length === 0 ? "PASS" : "FAIL",
    measured: { violations },
    threshold: { violations: 0 },
  };
}

// ------------------------------------------------------------------
// guard-approval: 未承認(proposed)と失効(expired)のパターンが評価されない
// ------------------------------------------------------------------

export interface GuardApprovalDeps {
  getActiveGuards: typeof prodGetActiveGuards;
  evaluateGuards: typeof prodEvaluateGuards;
}

export function checkGuardApproval(
  deps: GuardApprovalDeps = { getActiveGuards: prodGetActiveGuards, evaluateGuards: prodEvaluateGuards },
): CheckResult {
  const tmpDir = mkdtempSync(join(tmpdir(), "g4-guard-approval-"));
  const db = new Database(join(tmpDir, "memory.db"));
  db.exec(GUARDS_DDL);
  const violations: string[] = [];
  try {
    const now = new Date("2026-06-01T00:00:00.000Z");
    const insert = db.prepare(
      `INSERT INTO guards (id, pattern, source_incident_id, approved_at, expires_at, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    );
    // proposed（未承認）: 評価対象に含まれてはならない。
    insert.run("g-proposed", "rm -rf /", "inc-1", null, "2099-01-01T00:00:00.000Z", "proposed");
    // expired（失効）: state='active'のまま期限切れの行、または state='expired' の行の両方を試す。
    insert.run("g-expired-state", "curl .*evil", "inc-2", "2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z", "expired");
    insert.run("g-expired-active-past", "danger-pattern", "inc-3", "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", "active");
    // active（承認済み・有効期限内）: 評価対象に含まれるべき。
    insert.run("g-active", "block-me", "inc-4", "2026-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z", "active");

    const activeGuards: GuardRule[] = deps.getActiveGuards(db, now);
    const ids = activeGuards.map((g) => g.id).sort();
    if (ids.join(",") !== "g-active") {
      violations.push(`評価対象に未承認/失効が混入: ${JSON.stringify(ids)}`);
    }

    const proposedEval = deps.evaluateGuards("rm -rf /", activeGuards);
    if (proposedEval.action === "block") violations.push("proposed規則のパターンでブロックされた");
    const expiredEval = deps.evaluateGuards("curl .*evil", activeGuards);
    if (expiredEval.action === "block") violations.push("expired規則のパターンでブロックされた");
    const activeEval = deps.evaluateGuards("block-me", activeGuards);
    if (activeEval.action !== "block") violations.push("active規則のパターンでブロックされなかった");
  } finally {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }

  return {
    check: "guard-approval",
    result: violations.length === 0 ? "PASS" : "FAIL",
    measured: { violations },
    threshold: { violations: 0 },
  };
}

// ------------------------------------------------------------------
// guard-cap（PT-03再利用）: 上限超過の有効化は常にエラー
// ------------------------------------------------------------------

export interface GuardCapDeps {
  activateGuard: typeof prodActivateGuard;
}

export function checkGuardCap(deps: GuardCapDeps = { activateGuard: prodActivateGuard }): CheckResult {
  const maxActiveGuards = DEFAULT_MAX_ACTIVE_GUARDS;
  const tmpDir = mkdtempSync(join(tmpdir(), "g4-guard-cap-"));
  const db = new Database(join(tmpDir, "memory.db"));
  db.exec(GUARDS_DDL);
  const violations: string[] = [];
  try {
    const insert = db.prepare(
      `INSERT INTO guards (id, pattern, source_incident_id, approved_at, expires_at, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    );
    for (let i = 0; i < maxActiveGuards; i++) {
      insert.run(`cap-active-${i}`, `p-${i}`, `inc-${i}`, "2026-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z", "active");
    }
    insert.run("cap-proposed-extra", "p-extra", "inc-extra", null, "2099-01-01T00:00:00.000Z", "proposed");

    let threw = false;
    try {
      deps.activateGuard(db, "cap-proposed-extra", maxActiveGuards);
    } catch (e) {
      threw = e instanceof GuardCapExceededError;
    }
    if (!threw) violations.push("上限到達済みでの有効化がGuardCapExceededErrorをthrowしなかった");
    const row = db.prepare("SELECT state FROM guards WHERE id = 'cap-proposed-extra'").get() as { state: string };
    if (row.state !== "proposed") violations.push("上限超過にもかかわらず規則がactiveへ遷移した");
    if (countActiveGuards(db) !== maxActiveGuards) violations.push("アクティブ件数が上限を超えて増加した");
  } finally {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }

  return {
    check: "guard-cap",
    result: violations.length === 0 ? "PASS" : "FAIL",
    measured: { violations, maxActiveGuards },
    threshold: { violations: 0 },
  };
}

// ------------------------------------------------------------------
// circuit-breaker: ブロック率注入試験での自動停止
// ------------------------------------------------------------------

export interface CircuitBreakerDeps {
  isCircuitOpen: typeof prodIsCircuitOpen;
}

export function checkCircuitBreaker(
  deps: CircuitBreakerDeps = { isCircuitOpen: prodIsCircuitOpen },
): CheckResult {
  const violations: string[] = [];

  // 閾値超過（ブロック率15% > 10%）: サーキットは開くべき。
  const highRateHistory: EvalAction[] = Array.from({ length: 100 }, (_, i) => (i < 15 ? "block" : "pass"));
  if (!deps.isCircuitOpen(highRateHistory)) violations.push("ブロック率15%でサーキットが開かなかった");

  // 閾値未満（ブロック率5% < 10%）: サーキットは開かないべき。
  const lowRateHistory: EvalAction[] = Array.from({ length: 100 }, (_, i) => (i < 5 ? "block" : "pass"));
  if (deps.isCircuitOpen(lowRateHistory)) violations.push("ブロック率5%でサーキットが誤って開いた");

  return {
    check: "circuit-breaker",
    result: violations.length === 0 ? "PASS" : "FAIL",
    measured: { violations },
    threshold: { violations: 0 },
  };
}

// ------------------------------------------------------------------
// kill-switch: killファイル作成での即時全停止
// ------------------------------------------------------------------

export interface KillSwitchDeps {
  isKilled: typeof prodIsKilled;
}

export function checkKillSwitch(deps: KillSwitchDeps = { isKilled: prodIsKilled }): CheckResult {
  const tmpDir = mkdtempSync(join(tmpdir(), "g4-kill-switch-"));
  const violations: string[] = [];
  try {
    if (deps.isKilled(tmpDir)) violations.push("killファイル未作成なのにisKilledがtrueを返した");
    writeFileSync(join(tmpDir, KILL_SWITCH_FILE_NAME), "");
    if (!deps.isKilled(tmpDir)) violations.push("killファイル作成後もisKilledがfalseを返した");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  return {
    check: "kill-switch",
    result: violations.length === 0 ? "PASS" : "FAIL",
    measured: { violations },
    threshold: { violations: 0 },
  };
}

// ------------------------------------------------------------------
// dead-code-removed: 死機能の物理削除と死因記録の存在
// ------------------------------------------------------------------

export function checkDeadCodeRemoved(repoRoot: string): CheckResult {
  const violations: string[] = [];
  const graveyard = read(repoRoot, "docs/graveyard.md") ?? "";

  if (!graveyard) {
    violations.push("docs/graveyard.mdが存在しない");
  }

  // 対象1・2: v1ワーカー（consolidate-worker/retag-worker）は物理削除済みであること。
  for (const rel of ["src/cli/consolidate-worker.ts", "src/cli/retag-worker.ts"]) {
    if (existsSync(join(repoRoot, rel))) violations.push(`${rel} が物理削除されていない`);
  }
  // 対象3: v1鮮度判定関数（非Sqlite名）が staleness.ts に残っていないこと。
  const stalenessSrc = read(repoRoot, "src/consolidator/staleness.ts") ?? "";
  const v1FnNames = [
    "isConsolidationStale(",
    "readConsolidatedDont(",
    "writeConsolidatedDont(",
    "isConfigConsolidationStale(",
    "readConsolidatedConfig(",
    "writeConsolidatedConfig(",
    "readDontSummary(",
    "writeDontSummary(",
  ];
  for (const fn of v1FnNames) {
    const name = fn.slice(0, -1); // 末尾の "(" を除いた関数名
    // 違反とみなすのは「モジュール関数としての再宣言」のみ（`export function <name>(`）。
    // `storage.<name>(`のようなSQLiteStorageクラスメソッド呼び出し（v2正本の一部）は対象外。
    const reDeclared = new RegExp(`export function ${name}\\(`);
    if (reDeclared.test(stalenessSrc)) {
      violations.push(`v1鮮度判定関数が残存: ${fn}`);
    }
  }
  // 対象4: replaceIdの死んだ迂回分岐がsave.tsのMCPハンドラ内に残っていないこと。
  const saveSrc = read(repoRoot, "src/tools/save.ts") ?? "";
  if (/params\.replaceId/.test(saveSrc)) {
    violations.push("save.tsのMCPハンドラにreplaceId死コードが残存");
  }
  // 対象5: UserPromptSubmitの空関数呼び出し間接層が削除されていること（意味のある実装 or 早期return）。
  const contextSrc = read(repoRoot, "src/cli/context.ts") ?? "";
  if (/function\s+handleUserPromptSubmit\(\)\s*\{\s*\}/.test(contextSrc)) {
    violations.push("handleUserPromptSubmitが空関数のまま残存");
  }
  // 予測誤差ループ: 削除ではなく「保留」。graveyardに保留理由の記録があることを以て可とする。
  if (!/予測誤差ループ[\s\S]{0,50}保留/.test(graveyard) && !/削除を保留/.test(graveyard)) {
    violations.push("予測誤差ループの保留理由がgraveyardに記録されていない");
  }

  return {
    check: "dead-code-removed",
    result: violations.length === 0 ? "PASS" : "FAIL",
    measured: { violations },
    threshold: { violations: 0 },
  };
}

// ------------------------------------------------------------------
// before-after: 固定タスクスイートでの注入前後比較レポートの存在
// ------------------------------------------------------------------

export function checkBeforeAfter(repoRoot: string): CheckResult {
  const exists = existsSync(join(repoRoot, "scripts/compare-injection-effect.ts"));
  return {
    check: "before-after",
    result: exists ? "PASS" : "FAIL",
    measured: { compareScriptPresent: exists },
    threshold: { compareScriptPresent: true },
  };
}

// ------------------------------------------------------------------
// 実行
// ------------------------------------------------------------------

export interface G4Options {
  repoRoot?: string;
  storePath?: string;
}

export function runG4(options: G4Options = {}): { precondition: PreconditionResult; checks: CheckResult[] } {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const precondition = options.storePath
    ? checkPreconditions(options.storePath)
    : { ok: true, dbOpens: true, schemaVersion: null, memoriesCount: -1, reason: "--store未指定のため前提アサートをスキップ" };

  if (options.storePath && !precondition.ok) {
    return { precondition, checks: [] };
  }

  const checks: CheckResult[] = [
    checkInjectionBudget(),
    checkInjectionComposition(repoRoot),
    checkFailLoud(repoRoot),
    checkPullFixedBlocks(repoRoot),
    checkGetContextCap(repoRoot),
    checkGuardApproval(),
    checkGuardCap(),
    checkCircuitBreaker(),
    checkKillSwitch(),
    checkDeadCodeRemoved(repoRoot),
    checkBeforeAfter(repoRoot),
  ];
  return { precondition, checks };
}

function parseFlag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const { precondition, checks } = runG4({
    repoRoot: parseFlag("--repo-root"),
    storePath: parseFlag("--store"),
  });

  console.log(JSON.stringify({ precondition }));
  if (checks.length === 0) {
    console.log("== G4(注入・ガード)結果: 前提アサート不成立のため検査未実行 ==");
    process.exitCode = 1;
    return;
  }
  for (const c of checks) console.log(JSON.stringify(c));
  const failed = checks.filter((c) => c.result === "FAIL");
  console.log(`\n== G4(注入・ガード)結果: ${checks.length - failed.length}/${checks.length} PASS ==`);
  if (failed.length > 0) console.log(`FAIL項目: ${failed.map((c) => c.check).join(", ")}`);
  process.exitCode = failed.length > 0 ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith("g4-injection-guard.ts")) {
  main().catch((e) => {
    console.error(String(e?.stack ?? e));
    process.exitCode = 1;
  });
}
