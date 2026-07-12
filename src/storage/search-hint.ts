// 検索ヒント文言の一元化。
//
// 背景: 「詳細が必要なエントリのIDを memory_get_detail に渡してください。」/
// 「該当するメモリが見つかりませんでした。」の分岐が sqlite.ts(search/searchHybrid)・
// markdown.ts(search) の3箇所に個別実装されており、tools/search.ts では
// マージ前（アクティブプロジェクト横断検索で結果が合流する前）に確定した
// hint をそのまま使い回していたため、マージ後に件数が変わっても文言が
// 追随しない不整合があった。本モジュールを唯一の判定源にし、呼び出し側は
// 必ず「最終的な返却件数」を渡して都度再導出する。
//
// 実行時の import を持たない葉モジュール（循環参照を避ける）。FtsFallbackStage の
// type-only import はコンパイル時に消えるため実行時依存は増えない（types.ts 自体も葉モジュール）。
import type { FtsFallbackStage } from "../types.js";

// フォールバック段のラベル（design.md Phase2定義1・tasks.md 2.10「フレーズ／AND／OR」の表記に従う）。
// 段名の正本定義は types.ts の FtsFallbackStage（可観測性カウンタ search_fallback_* と同じ段集合）。
// Record<FtsFallbackStage, string> で型結合しているため、段の追加・改名時はここが型エラーで追随を強制される。
export const FTS_FALLBACK_STAGE_LABELS: Record<FtsFallbackStage, string> = {
  phrase: "フレーズ",
  and: "AND",
  or: "OR",
};

// fallbackStage: 発火したFTSフォールバック段（タスク2.10: ヒットの経路可視化）。
// 段がヒットした検索（FTS経路）でのみ渡され、ヒント末尾にラベルを付記する。
// 0件時は段が発火し得ない（発火＝その段でヒットあり）ため、ラベルは付けない。
// 既存の文言と件数再導出ロジックは不変（第2引数省略時の出力は従来とバイト同一）。
export function buildSearchHint(count: number, fallbackStage?: FtsFallbackStage | null): string {
  if (count <= 0) {
    return "該当するメモリが見つかりませんでした。";
  }
  const base = "詳細が必要なエントリのIDを memory_get_detail に渡してください。";
  return fallbackStage
    ? `${base}（フォールバック段: ${FTS_FALLBACK_STAGE_LABELS[fallbackStage]}）`
    : base;
}
