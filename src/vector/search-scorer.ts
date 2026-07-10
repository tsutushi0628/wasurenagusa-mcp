export interface ScoreParams {
  // 「関連度の芯」。呼び出し元によって中身が異なる（従来のcosine類似度、または
  // sqlite.ts searchHybrid()のRRF×時間減衰スコアなど）。フィールド名は
  // eval-golden.ts（実装者編集禁止・実クラスを直接呼ぶ）との呼び出し互換のため据え置く。
  vectorSimilarity: number;
  matchedTagWeights: number[];
  // 【廃止済み・未使用】design.md Phase2定義4により、recencyの反映元はsqlite.ts側の
  // time-decay（finalScore = rrfScore × 0.5^(ageDays/H)）ただ一つに一本化した（二重減衰の禁止）。
  // このフィールドはeval-golden.ts（実装者編集禁止）が実クラスへ渡す呼び出しの型互換のためだけに
  // 残置しており、スコア計算には一切使用しない。
  daysSinceLastAccess?: number;
  accessCount: number;
  // 【廃止済み・未使用】上記と同じ理由でeval-golden.ts互換のためだけに残置。
  halfLifeDays?: number;
  predictionError?: number; // 予測誤差スカラ（0〜1）。大きいほど surface 加点
}

export class SearchScorer {
  static score(params: ScoreParams): number {
    const { vectorSimilarity, matchedTagWeights, accessCount, predictionError } = params;

    const tagWeightScore =
      matchedTagWeights.length > 0
        ? 1.0 + matchedTagWeights.reduce((sum, w) => sum + w, 0)
        : 1.0;

    const accessBoost = Math.min(1.2, 1.0 + accessCount * 0.04);

    // 予測誤差が大きい記憶ほど「学ぶべき外れ」として加点（恒等元1.0、cap 1.3）。
    // predictionError 未指定時は 1.0 で既存スコア完全不変（後方互換）。
    const errorBoost = 1.0 + Math.min(0.3, (predictionError ?? 0) * 0.3);

    return vectorSimilarity * tagWeightScore * accessBoost * errorBoost;
  }
}
