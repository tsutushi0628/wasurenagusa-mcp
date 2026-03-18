export type TierName = "short" | "medium" | "long";

export interface VectorSearchResult {
  id: string;
  distance: number;
  accessCount: number;
}

export const TIER_THRESHOLDS: Record<TierName, number> = {
  short: 0.2,
  medium: 0.45,
  long: 0.7,
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
