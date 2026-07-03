/**
 * 予測誤差ループ: 着手前の見立て（predictedFactors）と実測（actualFactors）の
 * 集合非一致度を Jaccard 距離で算出する純粋関数（I/O無し・LLM無し）。
 *
 * 0 = 完全一致（見立て的中）、1 = 全外し。
 * どちらかが空配列なら undefined（差分計算不能 → 保存しない）。
 */
export function computePredictionError(
  predicted: string[],
  actual: string[],
): number | undefined {
  const normalize = (arr: string[]): Set<string> => {
    const out = new Set<string>();
    for (const item of arr) {
      const norm = item.trim().toLowerCase();
      if (norm.length > 0) {
        out.add(norm);
      }
    }
    return out;
  };

  const predictedSet = normalize(predicted);
  const actualSet = normalize(actual);

  // どちらかが空なら差分計算不能
  if (predictedSet.size === 0 || actualSet.size === 0) {
    return undefined;
  }

  let intersectionSize = 0;
  for (const item of predictedSet) {
    if (actualSet.has(item)) {
      intersectionSize++;
    }
  }
  const unionSize = predictedSet.size + actualSet.size - intersectionSize;

  // Jaccard距離 = 1 - (交差 / 和集合)。小数第3位で丸め。
  const distance = 1 - intersectionSize / unionSize;
  return Math.round(distance * 1000) / 1000;
}
