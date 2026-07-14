/**
 * 昇格の人間ゲート（memory-redesign Phase 3・タスク3.11／R-A7）。
 *
 * 観測知見を「確定原則（principles）」へ昇格させる経路を、起草（proposed）→人間承認（approved）の
 * 2段に構造分離する。自動昇格・既定承認は作らない。起草時に必須フィールド（出所ティア・証拠・TTL）を
 * 検証し、欠く候補は起草段階で拒否する。承認は CLI（src/cli/promote.ts）の明示操作だけが行う。
 *
 * 本モジュールは検証と起草の合成のみ（storage の名前付きメソッドを呼ぶ）。破壊 SQL は持たない。
 */
import type { SQLiteStorage } from "../storage/sqlite.js";

export interface PrincipleDraft {
  text: string;
  originTier: "owner_confirmed" | "agent_observed";
  /** 根拠となる記憶ID（1件以上必須）。*/
  evidenceIds: string[];
  /** TTL（ISO日時文字列・必須）。到来で expired になる。*/
  validUntil: string;
}

export interface DraftValidationError {
  field: string;
  reason: string;
}

/** 起草候補の必須フィールドを検証する（欠落・不正を列挙）。空配列なら妥当。 */
export function validateDraft(draft: Partial<PrincipleDraft>): DraftValidationError[] {
  const errors: DraftValidationError[] = [];
  if (!draft.text || draft.text.trim().length === 0) {
    errors.push({ field: "text", reason: "本文が空" });
  }
  if (draft.originTier !== "owner_confirmed" && draft.originTier !== "agent_observed") {
    errors.push({ field: "originTier", reason: "出所ティアが不正（owner_confirmed|agent_observed）" });
  }
  if (!Array.isArray(draft.evidenceIds) || draft.evidenceIds.length === 0) {
    errors.push({ field: "evidenceIds", reason: "証拠（根拠記憶ID）が1件以上必要" });
  }
  if (!draft.validUntil || Number.isNaN(Date.parse(draft.validUntil))) {
    errors.push({ field: "validUntil", reason: "TTL（valid_until）が未指定または不正な日時" });
  }
  return errors;
}

export interface DraftResult {
  ok: boolean;
  id?: string;
  errors: DraftValidationError[];
}

/**
 * 候補を検証し、妥当なら state='proposed'（approved_at=NULL）で起草する。
 * 検証NGは起草せず errors を返す（拒否）。起草は昇格ではない（承認は人間ゲートが別途行う）。
 */
export function draftPrinciple(
  storage: SQLiteStorage,
  draft: Partial<PrincipleDraft>,
  idFactory: () => string,
): DraftResult {
  const errors = validateDraft(draft);
  if (errors.length > 0) return { ok: false, errors };
  const id = idFactory();
  storage.insertPrinciple({
    id,
    text: draft.text!,
    originTier: draft.originTier!,
    evidenceIds: draft.evidenceIds!,
    validUntil: draft.validUntil!,
  });
  return { ok: true, id, errors: [] };
}
