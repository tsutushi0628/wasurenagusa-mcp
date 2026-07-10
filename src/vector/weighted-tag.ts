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

/**
 * クエリ文字列とタグ配列を照合し、一致したタグの重みを返す（検索スコアリングの加点用）。
 * 元々 src/tools/search.ts の非公開関数だったが、最終順位の決定権を src/storage/sqlite.ts
 * 側の searchHybrid/search に一本化する再設計（design.md Phase 2）に伴い、ここへ移設した。
 */
export function matchQueryToTags(query: string, tags: string[]): number[] {
  const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const weightedTags = parseWeightedTags(tags);
  const matchedWeights: number[] = [];

  for (const wt of weightedTags) {
    const tagLower = wt.tag.toLowerCase();
    for (const term of queryTerms) {
      if (tagLower.includes(term) || term.includes(tagLower)) {
        matchedWeights.push(wt.weight);
        break;
      }
    }
  }

  return matchedWeights;
}
