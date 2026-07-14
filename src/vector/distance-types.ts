/**
 * 距離尺度の型封じ（memory-redesign spec Phase 3・系統Bの中核、R-B4）。
 *
 * L2距離とコサイン類似度の取り違え（閾値0.6の誤適用、監査D2）を、規約ではなく型エラーで
 * 再発防止する。閾値は必ず Threshold<M> で保持し、生の number を閾値として持ち回ることを禁止する。
 *
 * 前提: 埋め込みはすべて保存時にL2正規化される（embedding-service が正規化前提をアサートする）。
 * ベクトル索引 vec0 は既定でL2距離を返すため、searchVectors の distance は L2Distance である。
 */

export type L2Distance = { readonly measure: "l2"; readonly value: number };
export type CosineSimilarity = { readonly measure: "cosineSim"; readonly value: number };
export type Threshold<M extends string> = { readonly measure: M; readonly value: number };

export function asL2Distance(value: number): L2Distance {
  return { measure: "l2", value };
}

export function asCosineSimilarity(value: number): CosineSimilarity {
  return { measure: "cosineSim", value };
}

export function l2Threshold(value: number): Threshold<"l2"> {
  return { measure: "l2", value };
}

export function cosineSimThreshold(value: number): Threshold<"cosineSim"> {
  return { measure: "cosineSim", value };
}

/**
 * 正規化済みベクトル前提の変換。||a||=||b||=1 のとき L2^2 = 2(1 - cos) が成り立つため
 * cos = 1 - L2^2/2 で類似度へ戻す。正規化されていないベクトルには使わない
 * （前提は埋め込みサービス側でアサートする）。
 */
export function l2ToCosineSim(d: L2Distance): CosineSimilarity {
  return { measure: "cosineSim", value: 1 - (d.value * d.value) / 2 };
}

/**
 * 距離尺度の「閾値以内か」判定（距離は小さいほど近い＝ value <= threshold）。
 * v と t の measure が同一でなければコンパイルが通らない（尺度混同の型封じ）。
 * 既存 searchVectors の `distance <= threshold` と境界含む挙動を一致させる。
 */
export function isWithin<M extends string>(
  v: { readonly measure: M; readonly value: number },
  t: Threshold<M>,
): boolean {
  return v.value <= t.value;
}

/**
 * 類似度尺度の「閾値以上か」判定（類似度は大きいほど近い＝ value >= threshold）。
 * v と t の measure が同一でなければコンパイルが通らない。
 */
export function meetsSimilarity<M extends string>(
  v: { readonly measure: M; readonly value: number },
  t: Threshold<M>,
): boolean {
  return v.value >= t.value;
}
