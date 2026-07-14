import { describe, it, expect } from "vitest";
import { calibrateThreshold, type ScoredPair } from "./calibrate-merge-threshold.js";

// 合成データ（実ラベルではない・スクリプトの較正ロジック検証専用）。
// 実データ較正の権威ある物差しは人手ラベル（タスク3.5）で作る＝実装者は作らない。
function makePairs(sameSims: number[], diffSims: number[]): ScoredPair[] {
  return [
    ...sameSims.map((s) => ({ label: "same" as const, similarity: s })),
    ...diffSims.map((s) => ({ label: "different" as const, similarity: s })),
  ];
}

describe("calibrateThreshold（誤統合率5%以下の最小閾値を確定）", () => {
  it("same が高類似・different が低類似のとき、誤統合率0で分離する閾値を選ぶ", () => {
    const pairs = makePairs(
      [0.95, 0.96, 0.97, 0.98, 0.99],
      [0.1, 0.2, 0.3, 0.4, 0.5],
    );
    const r = calibrateThreshold(pairs);
    expect(r.achievedTarget).toBe(true);
    expect(r.falseMergeRate).toBeLessThanOrEqual(0.05);
    // different の最大(0.5)より上・same の最小(0.95)以下 → recall=1
    expect(r.threshold).toBeGreaterThan(0.5);
    expect(r.threshold).toBeLessThanOrEqual(0.95);
    expect(r.recall).toBe(1);
  });

  it("誤統合率が target 以下になる最小閾値を選ぶ（recall最大化）", () => {
    // different 20件中1件だけ 0.9（他は低い）。5%=1件までの誤統合を許容 → 0.9 を含めてよい閾値でなく、
    // 0.9 を1件だけ誤統合として許す最小閾値（<=0.9）が選ばれ、recall を最大化する。
    const diff = [0.9, ...Array.from({ length: 19 }, (_, i) => 0.1 + i * 0.01)];
    const same = Array.from({ length: 10 }, (_, i) => 0.8 + i * 0.01); // 0.80..0.89
    const r = calibrateThreshold(makePairs(same, diff));
    expect(r.falseMergeRate).toBeLessThanOrEqual(0.05);
    // 1/20 = 0.05 ちょうどを許容するので、0.9 を1件含む閾値まで下げられる
    expect(r.threshold).toBeLessThanOrEqual(0.9);
    expect(r.recall).toBeGreaterThan(0); // 一部の same を検出できる
  });

  it("different が高類似に密集し目標未達なら achievedTarget=false で保守的に最大閾値を返す", () => {
    const pairs = makePairs([0.9, 0.91], [0.92, 0.93, 0.94, 0.95]);
    const r = calibrateThreshold(pairs);
    expect(r.achievedTarget).toBe(false);
    expect(r.threshold).toBeGreaterThan(0.95); // 全 different を除外する保守閾値
    expect(r.falseMergeRate).toBe(0);
  });

  it("same または different が空なら較正できずthrowする", () => {
    expect(() => calibrateThreshold(makePairs([0.9], []))).toThrow();
    expect(() => calibrateThreshold(makePairs([], [0.1]))).toThrow();
  });

  it("分布統計（件数・min/max/mean/median）を both クラスで記録する", () => {
    const r = calibrateThreshold(makePairs([0.9, 0.8, 0.7], [0.1, 0.2]));
    expect(r.sameStats.count).toBe(3);
    expect(r.differentStats.count).toBe(2);
    expect(r.sameStats.median).toBeCloseTo(0.8, 10);
    expect(r.differentStats.mean).toBeCloseTo(0.15, 10);
  });
});
