import { l2Threshold, type Threshold } from "./distance-types.js";

export type TierName = "short" | "medium" | "long";

export interface VectorSearchResult {
  id: string;
  distance: number;
  accessCount: number;
}

// 各ティアの距離閾値。vec0 は正規化ベクトルに対しL2距離を返すため L2 の Threshold で保持する
// （生 number の持ち回りを禁止。値そのものはラベル付きペアで較正＝タスク3.6）。
export const TIER_THRESHOLDS_TYPED: Record<TierName, Threshold<"l2">> = {
  short: l2Threshold(0.2),
  medium: l2Threshold(0.45),
  long: l2Threshold(0.7),
};

// 後方互換: 生 number を要求する既存呼び出し（context.ts / retag-worker.ts が searchVectors へ渡す）向け。
// searchVectors の引数が number 契約のため、型付き閾値から value を取り出して供給する。
export const TIER_THRESHOLDS: Record<TierName, number> = {
  short: TIER_THRESHOLDS_TYPED.short.value,
  medium: TIER_THRESHOLDS_TYPED.medium.value,
  long: TIER_THRESHOLDS_TYPED.long.value,
};

export const CRITICAL_PROMOTION_THRESHOLD = 5;

export function filterByTier(
  results: VectorSearchResult[],
  tier: TierName
): VectorSearchResult[] {
  const threshold = TIER_THRESHOLDS[tier];
  return results.filter((r) => r.distance <= threshold);
}

export function shouldPromoteToCritical(accessCount: number): boolean {
  return accessCount > CRITICAL_PROMOTION_THRESHOLD;
}
