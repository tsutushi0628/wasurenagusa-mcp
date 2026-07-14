/**
 * 注入ビルダ（design.md「注入ビルダ」節・タスク4.2）。
 *
 * push型注入の質量崩壊（症状⑤：30日分の全文注入・サマリ欠落時の全文フォールバック）を根治する。
 * 注入本文は design.md Data Models「最小索引」の定義に厳密適合させる:
 *   - 対象: state='active' のタイトル行 と、承認済み（approved かつ有効期限内）の確定原則のみ
 *   - 形式: 1件1行「[カテゴリ] 日本語1行要旨 (ID)」
 *   - 件数上限: 原則は全件、記憶索引は上限 MINIMAL_INDEX_LIMIT 行
 *   - 分量上限: トークンバジェット（budget.ts）
 *
 * 素材欠損（索引0件・principlesテーブル未初期化等）時は全文フォールバックせず、
 * skipped配列に理由を積んで返す（呼び出し側がfail-loud警告を出す）。
 */
import type { SQLiteStorage } from "../storage/sqlite.js";
import {
  DEFAULT_INJECTION_TOKEN_BUDGET,
  enforceInjectionTokenBudget,
  estimateTokens,
} from "./budget.js";

/** 記憶索引の件数上限（design.md「最小索引」既定値） */
export const MINIMAL_INDEX_LIMIT = 50;

/**
 * skipped ラベルのうち「素材欠損ではない正常系」を表すもの（fail-loud 警告・カウンタ対象外）。
 *
 * 「索引0件・確定原則のみ」等の正当な空索引セッション（新規プロジェクト・全記憶が確定原則へ昇華済み等）は
 * 欠損ではないため、これらのラベルだけが skipped に載っていても呼び出し側は警告しない（rank2）。
 * 素材が存在するのに注入されなかった真の欠損（minimal-index-error・principles-error・budget-truncated:*）は
 * このセットに含めないため、従来どおり警告＋カウンタ計上される。
 */
export const BENIGN_SKIP_LABELS: ReadonlySet<string> = new Set(["minimal-index-empty"]);

export interface InjectionBuildResult {
  /** バジェット適用後の注入本文（最小索引＋承認済み原則のみで構成） */
  text: string;
  /** 注入本文の概算トークン数 */
  tokenCount: number;
  /** バジェット超過により末尾が切り詰められたか */
  truncated: boolean;
  /**
   * 素材欠損・切り詰めの理由ラベル一覧。
   * 空でない場合、呼び出し側はfail-loud警告（stderr・可観測性カウンタ）を出すこと。
   * 空でも「注入対象が0件だった」自体は正常系（新規プロジェクト等）でありうる。
   */
  skipped: string[];
}

/**
 * 最小索引と承認済み確定原則から、トークンバジェット以下の注入本文を構成する。
 * 全文（記憶本文・dont本文全件等）を注入するコード経路をここに作らない。
 */
export function buildInjection(
  storage: SQLiteStorage,
  currentProject: string | undefined,
  budgetTokens: number = DEFAULT_INJECTION_TOKEN_BUDGET,
  now: Date = new Date(),
): InjectionBuildResult {
  const skipped: string[] = [];
  const sections: string[] = [];

  // 最小索引（state='active' のタイトル行のみ。本文は含めない）
  let indexEntries: Array<{ id: string; title: string; category: string }> = [];
  try {
    indexEntries = storage.getMinimalIndexEntries(currentProject, MINIMAL_INDEX_LIMIT);
  } catch (error) {
    console.error("[injection] 最小索引の取得に失敗:", error);
    skipped.push("minimal-index-error");
  }
  if (indexEntries.length > 0) {
    const lines = indexEntries.map(
      (e) => `[${e.category}] ${e.title} (${e.id})`,
    );
    sections.push("### 最小索引\n" + lines.join("\n"));
  } else if (skipped.length === 0) {
    // 索引0件（新規プロジェクト等）は欠損ではないため fail-loud 対象外だが、
    // 「なぜ空か」を可観測にするため理由だけ積む（警告は出さない）。
    skipped.push("minimal-index-empty");
  }

  // 承認済み確定原則（approved かつ valid_until 未到来のみ。未承認・失効は構造的に含まれない）
  let principles: Array<{ id: string; text: string }> = [];
  try {
    principles = storage.getInjectablePrinciples(now);
  } catch (error) {
    console.error("[injection] 確定原則の取得に失敗:", error);
    skipped.push("principles-error");
  }
  if (principles.length > 0) {
    const lines = principles.map((p) => `- ${p.text} (${p.id})`);
    sections.push("### 確定原則\n" + lines.join("\n"));
  }

  const bodyText = sections.join("\n\n");
  const budgetResult = enforceInjectionTokenBudget(bodyText, budgetTokens);
  if (budgetResult.truncated) {
    skipped.push(`budget-truncated:${budgetResult.omittedTokens}`);
  }

  return {
    text: budgetResult.text,
    tokenCount: estimateTokens(budgetResult.text),
    truncated: budgetResult.truncated,
    skipped,
  };
}
