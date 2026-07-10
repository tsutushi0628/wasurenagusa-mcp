import { WeightedTag } from "../types.js";

/**
 * "tag:weight" 形式の文字列をパースしてWeightedTagに変換する。
 * 後方互換: 重みなし("Gemini")はweight 1.0として扱う。
 * コロン後が数値でない場合("scope:backend")はタグ名全体として扱う。
 */
export function parseWeightedTag(raw: string): WeightedTag {
  const lastColon = raw.lastIndexOf(":");
  if (lastColon === -1) {
    return { tag: raw, weight: 1.0 };
  }

  const afterColon = raw.substring(lastColon + 1);
  if (afterColon === "") {
    return { tag: raw.substring(0, lastColon), weight: 1.0 };
  }

  const weight = Number(afterColon);
  if (isNaN(weight)) {
    // コロン後が数値でない場合は全体をタグ名として扱う
    return { tag: raw, weight: 1.0 };
  }

  const clamped = Math.min(1.0, Math.max(0.0, weight));
  return { tag: raw.substring(0, lastColon), weight: clamped };
}

/**
 * WeightedTagを "tag:weight" 形式の文字列にフォーマットする。
 */
export function formatWeightedTag(wt: WeightedTag): string {
  return `${wt.tag}:${wt.weight}`;
}

/**
 * タグ文字列配列をWeightedTag配列にパースする。
 */
export function parseWeightedTags(tags: string[]): WeightedTag[] {
  return tags.map(parseWeightedTag);
}

/**
 * WeightedTag配列をタグ文字列配列にフォーマットする。
 */
export function formatWeightedTags(wts: WeightedTag[]): string[] {
  return wts.map(formatWeightedTag);
}

// 注: クエリ×タグ照合関数（matchQueryToTags）はここに置かない。
// WIPコミット32f8c0aで一時新設されたが、設計契約(design.md Phase2)に消費者が存在せず、
// ゴールデンセット較正でも順位品質を悪化させることが実測されたため、
// PdM裁定（2026-07-11・QA報告書§5-bis）により配線せず削除した。
