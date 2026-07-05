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
// 他モジュールへの import を持たない葉モジュール（循環参照を避ける）。
export function buildSearchHint(count: number): string {
  return count > 0
    ? "詳細が必要なエントリのIDを memory_get_detail に渡してください。"
    : "該当するメモリが見つかりませんでした。";
}
