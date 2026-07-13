import { createHash } from "crypto";

/**
 * ハッシュ用正規化: 前後の空白除去＋連続空白（改行・全角スペース含む。JSのSpace_Separator）を
 * 単一半角スペースに圧縮するのみ。大文字小文字統一・全角半角統一・句読点除去等の意味的正規化は
 * 一切行わない（過剰正規化で別記憶を誤統合しないための保守的な線引き＝オーナー指示）。
 */
export function normalizeForHash(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export interface ContentHashInput {
  project?: string;
  scope?: string;
  category: string;
  title: string;
  content: string;
}

/**
 * 重複判定用content-hash。project + scope + category + 正規化(title, content) を軸に
 * SHA-256で決定論的に算出する（LLM不使用）。
 *
 * 軸選定の理由: memories テーブルの列構成（schema.ts: project/scope/category/title/content）のうち
 * project・scope・category は既存の検索フィルタ・インデックス（idx_memories_project 等、
 * sqlite.ts の search 系フィルタ句）と同じ分割粒度。同一contentでも category が違えば
 * （例: 同じ文面が decision と log）意味が異なるため別記憶として区別する。
 * knowledgeGap/positiveAction/scenario/whyCore/predictedFactors 等の付帯フィールドは
 * ハッシュに含めない（オーナー指定の軸どおり。付帯情報の差は「同じ記憶への追記」として
 * 統合対象に含める設計）。
 *
 * フィールド境界はJSON.stringifyの配列化で区切る（"ab"+"" と "a"+"b" のような文字列連結時の
 * 区切り文字衝突を避けるため）。
 */
export function computeContentHash(input: ContentHashInput): string {
  const normalizedProject = (input.project ?? "").trim();
  const normalizedScope = (input.scope ?? "").trim();
  const normalizedTitle = normalizeForHash(input.title);
  const normalizedContent = normalizeForHash(input.content);
  const canonical = JSON.stringify([
    normalizedProject,
    normalizedScope,
    input.category,
    normalizedTitle,
    normalizedContent,
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
