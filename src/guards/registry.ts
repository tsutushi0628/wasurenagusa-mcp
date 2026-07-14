/**
 * 承認制ガードレジストリ（memory-redesign spec Phase 4・タスク4.5・R-C4）。
 *
 * guards テーブル（schema.ts GUARDS_DDL）を正本とし、consolidated-dont.json の
 * guardPatterns 読み取りに代わってガード判定の唯一の入力源になる。
 *
 * fail-safe設計: guards テーブルに state='active' の行が0件（または全て期限切れ）なら、
 * 常に「何もブロックしない」結果を返す（自動生成パターンの誤爆による自己DoS事故の再発防止）。
 * 承認・有効化は人間の明示操作（wasurenagusa-guard-approve CLI）のみで行い、自動承認・自動生成の
 * 経路は一切実装しない。
 */
import type Database from "better-sqlite3";
import { safeRegexTest } from "../cli/guard.js";

/** アクティブ規則数の既定上限（design.md「上限超過の有効化はエラー」）。 */
export const DEFAULT_MAX_ACTIVE_GUARDS = 20;

export type GuardState = "proposed" | "active" | "expired" | "disabled";

export interface GuardRule {
  id: string;
  pattern: string;
  sourceIncidentId: string;
  approvedAt: string | null;
  expiresAt: string;
  state: GuardState;
  createdAt: string;
}

export interface GuardEvaluationResult {
  /** "pass" = ブロックしない, "block" = ブロックする */
  action: "pass" | "block";
  message?: string;
  /** マッチした規則のid（"pass"時はundefined） */
  matchedGuardId?: string;
}

interface GuardRow {
  id: string;
  pattern: string;
  source_incident_id: string;
  approved_at: string | null;
  expires_at: string;
  state: GuardState;
  created_at: string;
}

function rowToRule(row: GuardRow): GuardRule {
  return {
    id: row.id,
    pattern: row.pattern,
    sourceIncidentId: row.source_incident_id,
    approvedAt: row.approved_at,
    expiresAt: row.expires_at,
    state: row.state,
    createdAt: row.created_at,
  };
}

/**
 * 評価対象の規則（state='active' かつ expires_at が now より未来）のみを取得する。
 * proposed / expired / disabled は一切返さない（未承認・失効は評価しない）。
 */
export function getActiveGuards(db: Database.Database, now: Date = new Date()): GuardRule[] {
  const nowIso = now.toISOString();
  const rows = db
    .prepare(
      "SELECT id, pattern, source_incident_id, approved_at, expires_at, state, created_at FROM guards WHERE state = 'active' AND expires_at > ?"
    )
    .all(nowIso) as GuardRow[];
  return rows.map(rowToRule);
}

/**
 * ガード判定のコアロジック。テスト可能な純粋寄りの関数（DBアクセスはgetActiveGuardsで完結済みの
 * 規則配列を受け取る）。
 *
 * fail-safe: activeGuards が空配列なら常に pass を返す（guardsテーブルが空/active0件でも
 * 絶対にブロックしない）。
 */
export function evaluateGuards(message: string, activeGuards: GuardRule[]): GuardEvaluationResult {
  if (activeGuards.length === 0) {
    return { action: "pass" };
  }

  for (const guard of activeGuards) {
    if (safeRegexTest(guard.pattern, message)) {
      return {
        action: "block",
        message: `[wasurenagusa-guard-registry] ガード規則 ${guard.id}（出所: ${guard.sourceIncidentId}）に違反しています。`,
        matchedGuardId: guard.id,
      };
    }
  }

  return { action: "pass" };
}

/**
 * guards テーブルから active 規則を取得し評価する統合関数（DB接続を持つ呼び出し元向け）。
 */
export function checkGuardsFromDb(
  db: Database.Database,
  message: string,
  now: Date = new Date(),
): GuardEvaluationResult {
  const activeGuards = getActiveGuards(db, now);
  return evaluateGuards(message, activeGuards);
}

/**
 * 現在の active 規則数を数える（上限判定用）。
 */
export function countActiveGuards(db: Database.Database, now: Date = new Date()): number {
  const nowIso = now.toISOString();
  const row = db
    .prepare("SELECT COUNT(*) as c FROM guards WHERE state = 'active' AND expires_at > ?")
    .get(nowIso) as { c: number };
  return row.c;
}

export class GuardCapExceededError extends Error {
  constructor(current: number, max: number) {
    super(`アクティブ規則数の上限(${max})を超過するため有効化できません（現在${current}件）`);
    this.name = "GuardCapExceededError";
  }
}

export class GuardNotFoundError extends Error {
  constructor(id: string) {
    super(`ガード規則が見つかりません: ${id}`);
    this.name = "GuardNotFoundError";
  }
}

/**
 * proposed または disabled の規則を active へ遷移させる（人間の明示承認操作専用）。
 * 上限（既定20・引数で変更可）を超える有効化は例外をthrowする（規則は遷移しない）。
 * 自動承認・自動生成は一切実装しない（呼び出しは常に人間操作のCLI経由）。
 */
export function activateGuard(
  db: Database.Database,
  id: string,
  maxActiveGuards: number = DEFAULT_MAX_ACTIVE_GUARDS,
  now: Date = new Date(),
): void {
  const row = db.prepare("SELECT id, state FROM guards WHERE id = ?").get(id) as
    | { id: string; state: GuardState }
    | undefined;
  if (!row) {
    throw new GuardNotFoundError(id);
  }
  if (row.state === "active") {
    // 既にactiveなら冪等に成功扱い（再承認を許す）。
    return;
  }

  const currentActive = countActiveGuards(db, now);
  if (currentActive >= maxActiveGuards) {
    throw new GuardCapExceededError(currentActive, maxActiveGuards);
  }

  const nowIso = now.toISOString();
  db.prepare("UPDATE guards SET state = 'active', approved_at = ? WHERE id = ?").run(nowIso, id);
}

// --- 4.15 dry-run観測モード ---

export type GuardRunMode = "dry-run" | "enforce";

/**
 * 既定モードは dry-run（実ブロックしない）。settings.json の本配線・ON切替はオーナー承認後の
 * 別作業で行う。ここでは機構のみを提供し、本配線（4.15③④）は含まない。
 */
export const DEFAULT_GUARD_RUN_MODE: GuardRunMode = "dry-run";

export interface GuardObservationLogEntry {
  ts: string;
  action: "pass" | "block";
  mode: GuardRunMode;
  matchedGuardId?: string;
}

/**
 * dry-runを考慮したガード評価。dry-runモードでは違反を検出しても実際のブロック(action="block")には
 * せず、検出結果をログエントリとして返すのみで呼び出し元へは pass 相当の判断材料を渡す。
 * enforceモードでは evaluateGuards の結果をそのまま返す。
 *
 * 戻り値の result.action は「実際にブロックすべきか」を表す（dry-runでは常に"pass"）。
 * observation には検出の実態（本来なら block だったか）を残す。
 */
export interface DryRunAwareResult {
  result: GuardEvaluationResult;
  observation: GuardObservationLogEntry;
}

export function evaluateGuardsWithMode(
  message: string,
  activeGuards: GuardRule[],
  mode: GuardRunMode = DEFAULT_GUARD_RUN_MODE,
  now: Date = new Date(),
): DryRunAwareResult {
  const rawResult = evaluateGuards(message, activeGuards);

  if (mode === "dry-run") {
    return {
      result: { action: "pass" },
      observation: {
        ts: now.toISOString(),
        action: rawResult.action,
        mode,
        matchedGuardId: rawResult.matchedGuardId,
      },
    };
  }

  return {
    result: rawResult,
    observation: {
      ts: now.toISOString(),
      action: rawResult.action,
      mode,
      matchedGuardId: rawResult.matchedGuardId,
    },
  };
}

/**
 * 観測ログ（GuardObservationLogEntry[]）からブロック率レポートを生成する。
 * 「検出はしたが dry-run のため実際にはブロックしなかった」件数も可視化する。
 */
export interface BlockRateReport {
  totalObservations: number;
  wouldBlockCount: number;
  wouldBlockRate: number;
  mode: GuardRunMode | "mixed";
}

export function computeBlockRateReport(entries: GuardObservationLogEntry[]): BlockRateReport {
  const totalObservations = entries.length;
  const wouldBlockCount = entries.filter((e) => e.action === "block").length;
  const wouldBlockRate = totalObservations > 0 ? wouldBlockCount / totalObservations : 0;
  const modes = new Set(entries.map((e) => e.mode));
  const mode: GuardRunMode | "mixed" = modes.size === 1 ? (entries[0]?.mode ?? DEFAULT_GUARD_RUN_MODE) : "mixed";

  return { totalObservations, wouldBlockCount, wouldBlockRate, mode };
}
