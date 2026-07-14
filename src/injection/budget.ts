/**
 * 注入トークンバジェット機構（design.md「注入ビルダ」節・タスク0.10/4.2）。
 * 「上限内は素通し・超過時は行境界で切り詰め・欠損は必ず可視化する
 * （無言で切らない・全文フォールバック経路を作らない）」という業務要件をここに集約する。
 * src/cli/context.ts はこのモジュールの関数をそのまま再エクスポートして使う
 * （呼び出し側の再実装を禁止する。Component Isolation原則）。
 */

/** 注入トークンバジェットの既定値（環境変数 WASURENAGUSA_INJECTION_TOKEN_BUDGET 未設定時） */
export const DEFAULT_INJECTION_TOKEN_BUDGET = 8000;

export interface InjectionBudgetResult {
  /** バジェット適用後の最終出力文字列 */
  text: string;
  /** 切り詰めが発生したか */
  truncated: boolean;
  /** 切り詰めで省略された概算トークン数（truncated=falseなら0） */
  omittedTokens: number;
}

/**
 * トークン概算（保守的・過小評価しない側に倒す）。
 * 「文字数 ÷ 2」と「UTF-8バイト数 ÷ 3」の2通りで見積もり、大きい方を採用する。
 * 正確なトークナイザではなく概算だが、日本語のようなマルチバイト文字を含む
 * テキストでも実トークン数を下回らないことを優先する。
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  const charEstimate = Math.ceil(text.length / 2);
  const byteEstimate = Math.ceil(Buffer.byteLength(text, "utf-8") / 3);
  return Math.max(charEstimate, byteEstimate);
}

/**
 * 注入文字列にトークンバジェット上限を適用する。
 * 上限内なら素通し。超過時は行境界で末尾から切り詰め、可視マーカー行を残す。
 * 無言で切らない・フォールバックで全文をそのまま流す経路は作らない
 * （呼び出し側は必ず本関数の戻り値をそのまま出力に使う）。
 */
export function enforceInjectionTokenBudget(
  text: string,
  budgetTokens: number,
): InjectionBudgetResult {
  const totalTokens = estimateTokens(text);
  if (totalTokens <= budgetTokens) {
    return { text, truncated: false, omittedTokens: 0 };
  }

  const lines = text.split("\n");

  // マーカー行自身のトークンも最終出力に含まれるため、先に「最悪ケースのマーカー幅」で
  // その分を確保してから本文を詰める（マーカーを勘定せず付加すると出力がバジェット超過する）。
  // 省略トークン数は最大でも totalTokens 桁までしか増えないため、totalTokens で桁数を固定した
  // マーカーを見積もり上限に使う（実際の省略数はこれ以下なので桁数は等しいか少ない）。
  const markerFor = (omitted: number): string =>
    `（注入がバジェット上限で切り詰められました: 約${omitted} トークン省略）`;
  const reservedMarkerTokens = estimateTokens(markerFor(totalTokens));

  const keptLines: string[] = [];
  let keptTokens = 0;
  for (const line of lines) {
    const lineTokens = estimateTokens(line);
    if (keptTokens + lineTokens + reservedMarkerTokens > budgetTokens) break;
    keptLines.push(line);
    keptTokens += lineTokens;
  }

  // 行境界見積もり（改行文字を勘定しない）と最終結合文字列の実概算にはズレが出るため、
  // 最終文字列を実測し、バジェットを超えていれば末尾行を削って確実に収める（保険の最終ガード）。
  const build = (kept: string[]): string => {
    const omitted = totalTokens - kept.reduce((s, l) => s + estimateTokens(l), 0);
    return [...kept, markerFor(omitted)].join("\n");
  };
  let finalText = build(keptLines);
  while (keptLines.length > 0 && estimateTokens(finalText) > budgetTokens) {
    keptLines.pop();
    finalText = build(keptLines);
  }

  const omittedTokens =
    totalTokens - keptLines.reduce((s, l) => s + estimateTokens(l), 0);

  return {
    text: finalText,
    truncated: true,
    omittedTokens,
  };
}

/**
 * 注入バジェット超過時のfail-loud警告をstderrへ1行出力する。
 * truncated=falseのときは何も出力しない（無言で切っていないため警告は不要）。
 */
export function logInjectionBudgetWarning(
  budgetTokens: number,
  result: InjectionBudgetResult,
): void {
  if (!result.truncated) return;
  console.error(
    `[injection] 注入がトークンバジェット上限(${budgetTokens})を超過したため切り詰めました: 約${result.omittedTokens} トークン省略`,
  );
}
