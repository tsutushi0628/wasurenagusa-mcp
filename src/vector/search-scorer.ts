export interface ScoreParams {
  vectorSimilarity: number;
  matchedTagWeights: number[];
  daysSinceLastAccess: number;
  accessCount: number;
  halfLifeDays?: number;
  predictionError?: number; // 予測誤差スカラ（0〜1）。大きいほど surface 加点
}

export class SearchScorer {
  static score(params: ScoreParams): number {
    const {
      vectorSimilarity,
      matchedTagWeights,
      daysSinceLastAccess,
      accessCount,
      halfLifeDays = 14,
      predictionError,
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

    // 予測誤差が大きい記憶ほど「学ぶべき外れ」として加点（恒等元1.0、cap 1.3）。
    // predictionError 未指定時は 1.0 で既存スコア完全不変（後方互換）。
    const errorBoost = 1.0 + Math.min(0.3, (predictionError ?? 0) * 0.3);

    return vectorSimilarity * tagWeightScore * freshness * accessBoost * errorBoost;
  }
}
