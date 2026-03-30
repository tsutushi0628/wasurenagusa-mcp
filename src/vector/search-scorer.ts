export interface ScoreParams {
  vectorSimilarity: number;
  matchedTagWeights: number[];
  daysSinceLastAccess: number;
  accessCount: number;
  halfLifeDays?: number;
}

export class SearchScorer {
  static score(params: ScoreParams): number {
    const {
      vectorSimilarity,
      matchedTagWeights,
      daysSinceLastAccess,
      accessCount,
      halfLifeDays = 14,
    } = params;

    const freshness = Math.max(
      0.7,
      Math.exp((-0.693 * daysSinceLastAccess) / halfLifeDays),
    );

    const tagWeightScore =
      matchedTagWeights.length > 0
        ? 1.0 + matchedTagWeights.reduce((sum, w) => sum + w, 0)
        : 1.0;

    const accessBoost = Math.min(1.2, 1.0 + accessCount * 0.04);

    return vectorSimilarity * tagWeightScore * freshness * accessBoost;
  }
}
