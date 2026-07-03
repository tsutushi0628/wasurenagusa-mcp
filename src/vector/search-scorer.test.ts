import { describe, it, expect } from "vitest";
import { SearchScorer } from "./search-scorer.js";

describe("SearchScorer", () => {
  describe("freshness", () => {
    it("returns 1.0 for daysSinceLastAccess = 0", () => {
      const score = SearchScorer.score({
        vectorSimilarity: 1.0,
        matchedTagWeights: [],
        daysSinceLastAccess: 0,
        accessCount: 0,
      });
      // freshness=1.0, tagWeightScore=1.0, accessBoost=1.0
      expect(score).toBeCloseTo(1.0, 5);
    });

    it("returns floor 0.7 for very old entries (100+ days)", () => {
      const score = SearchScorer.score({
        vectorSimilarity: 1.0,
        matchedTagWeights: [],
        daysSinceLastAccess: 100,
        accessCount: 0,
      });
      // freshness should be floor 0.7
      expect(score).toBeCloseTo(0.7, 5);
    });

    it("returns ~0.952 for daysSinceLastAccess = 1 (halfLife=14)", () => {
      const score = SearchScorer.score({
        vectorSimilarity: 1.0,
        matchedTagWeights: [],
        daysSinceLastAccess: 1,
        accessCount: 0,
      });
      // e^(-0.693 * 1/14) = e^(-0.0495) ≈ 0.9517
      expect(score).toBeCloseTo(0.9517, 2);
    });

    it("returns floor 0.7 at half-life (14 days)", () => {
      const score = SearchScorer.score({
        vectorSimilarity: 1.0,
        matchedTagWeights: [],
        daysSinceLastAccess: 14,
        accessCount: 0,
      });
      // e^(-0.693 * 14/14) = e^(-0.693) ≈ 0.5, max(0.7, 0.5) = 0.7
      expect(score).toBeCloseTo(0.7, 5);
    });

    it("respects custom halfLifeDays", () => {
      const score = SearchScorer.score({
        vectorSimilarity: 1.0,
        matchedTagWeights: [],
        daysSinceLastAccess: 7,
        accessCount: 0,
        halfLifeDays: 7,
      });
      // e^(-0.693 * 7/7) = e^(-0.693) ≈ 0.5, max(0.7, 0.5) = 0.7
      expect(score).toBeCloseTo(0.7, 5);
    });

    it("returns > 0.7 for 3 days with halfLife=7", () => {
      const score = SearchScorer.score({
        vectorSimilarity: 1.0,
        matchedTagWeights: [],
        daysSinceLastAccess: 3,
        accessCount: 0,
        halfLifeDays: 7,
      });
      // e^(-0.693 * 3/7) = e^(-0.297) ≈ 0.743
      expect(score).toBeCloseTo(0.743, 2);
    });
  });

  describe("tagWeightScore", () => {
    it("returns 1.0 for empty matchedTagWeights (no penalty)", () => {
      const score = SearchScorer.score({
        vectorSimilarity: 1.0,
        matchedTagWeights: [],
        daysSinceLastAccess: 0,
        accessCount: 0,
      });
      expect(score).toBeCloseTo(1.0, 5);
    });

    it("boosts score with single high-weight tag", () => {
      const score = SearchScorer.score({
        vectorSimilarity: 1.0,
        matchedTagWeights: [0.9],
        daysSinceLastAccess: 0,
        accessCount: 0,
      });
      // tagWeightScore = 1.0 + 0.9 = 1.9
      expect(score).toBeGreaterThan(1.0);
    });

    it("boosts more with multiple tags", () => {
      const scoreSingle = SearchScorer.score({
        vectorSimilarity: 1.0,
        matchedTagWeights: [0.9],
        daysSinceLastAccess: 0,
        accessCount: 0,
      });
      const scoreMultiple = SearchScorer.score({
        vectorSimilarity: 1.0,
        matchedTagWeights: [0.9, 0.5, 0.3],
        daysSinceLastAccess: 0,
        accessCount: 0,
      });
      expect(scoreMultiple).toBeGreaterThan(scoreSingle);
    });

    it("handles all weight 1.0 tags for maximum boost", () => {
      const score = SearchScorer.score({
        vectorSimilarity: 1.0,
        matchedTagWeights: [1.0, 1.0, 1.0],
        daysSinceLastAccess: 0,
        accessCount: 0,
      });
      // tagWeightScore = 1.0 + 3.0 = 4.0
      expect(score).toBeCloseTo(4.0, 5);
    });
  });

  describe("accessBoost", () => {
    it("returns 1.0 for accessCount = 0", () => {
      const score = SearchScorer.score({
        vectorSimilarity: 1.0,
        matchedTagWeights: [],
        daysSinceLastAccess: 0,
        accessCount: 0,
      });
      expect(score).toBeCloseTo(1.0, 5);
    });

    it("returns 1.04 for accessCount = 1", () => {
      const score = SearchScorer.score({
        vectorSimilarity: 1.0,
        matchedTagWeights: [],
        daysSinceLastAccess: 0,
        accessCount: 1,
      });
      expect(score).toBeCloseTo(1.04, 5);
    });

    it("returns 1.12 for accessCount = 3", () => {
      const score = SearchScorer.score({
        vectorSimilarity: 1.0,
        matchedTagWeights: [],
        daysSinceLastAccess: 0,
        accessCount: 3,
      });
      expect(score).toBeCloseTo(1.12, 5);
    });

    it("caps at 1.2 for accessCount = 5", () => {
      const score = SearchScorer.score({
        vectorSimilarity: 1.0,
        matchedTagWeights: [],
        daysSinceLastAccess: 0,
        accessCount: 5,
      });
      expect(score).toBeCloseTo(1.2, 5);
    });

    it("caps at 1.2 for accessCount = 100", () => {
      const score = SearchScorer.score({
        vectorSimilarity: 1.0,
        matchedTagWeights: [],
        daysSinceLastAccess: 0,
        accessCount: 100,
      });
      expect(score).toBeCloseTo(1.2, 5);
    });
  });

  describe("errorBoost（予測誤差ループ）", () => {
    it("predictionError未指定なら従来値と完全一致（恒等元1.0）", () => {
      const baseline = SearchScorer.score({
        vectorSimilarity: 0.85,
        matchedTagWeights: [0.5],
        daysSinceLastAccess: 3,
        accessCount: 2,
      });
      const withUndefined = SearchScorer.score({
        vectorSimilarity: 0.85,
        matchedTagWeights: [0.5],
        daysSinceLastAccess: 3,
        accessCount: 2,
        predictionError: undefined,
      });
      // 予測誤差を渡さない場合、後方互換でスコアは不変
      expect(withUndefined).toBe(baseline);
    });

    it("predictionError=0 はスコア不変（的中は加点しない）", () => {
      const baseline = SearchScorer.score({
        vectorSimilarity: 1.0,
        matchedTagWeights: [],
        daysSinceLastAccess: 0,
        accessCount: 0,
      });
      const withZero = SearchScorer.score({
        vectorSimilarity: 1.0,
        matchedTagWeights: [],
        daysSinceLastAccess: 0,
        accessCount: 0,
        predictionError: 0,
      });
      expect(withZero).toBeCloseTo(baseline, 5);
    });

    it("予測誤差が大きいほどスコアが上がる（surface加点）", () => {
      const low = SearchScorer.score({
        vectorSimilarity: 1.0,
        matchedTagWeights: [],
        daysSinceLastAccess: 0,
        accessCount: 0,
        predictionError: 0.2,
      });
      const high = SearchScorer.score({
        vectorSimilarity: 1.0,
        matchedTagWeights: [],
        daysSinceLastAccess: 0,
        accessCount: 0,
        predictionError: 0.8,
      });
      expect(high).toBeGreaterThan(low);
    });

    it("predictionError=1 でも boost は cap 1.3 で頭打ち", () => {
      const score = SearchScorer.score({
        vectorSimilarity: 1.0,
        matchedTagWeights: [],
        daysSinceLastAccess: 0,
        accessCount: 0,
        predictionError: 1,
      });
      // 1.0 * 1.0 * 1.0 * 1.0 * 1.3 = 1.3
      expect(score).toBeCloseTo(1.3, 5);
    });

    it("predictionErrorが1超でも cap 1.3 を超えない（防御）", () => {
      const score = SearchScorer.score({
        vectorSimilarity: 1.0,
        matchedTagWeights: [],
        daysSinceLastAccess: 0,
        accessCount: 0,
        predictionError: 99,
      });
      expect(score).toBeCloseTo(1.3, 5);
    });
  });

  describe("composite score", () => {
    it("all neutral returns 1.0", () => {
      const score = SearchScorer.score({
        vectorSimilarity: 1.0,
        matchedTagWeights: [],
        daysSinceLastAccess: 0,
        accessCount: 0,
      });
      expect(score).toBeCloseTo(1.0, 5);
    });

    it("high relevance + fresh + frequent access = high score", () => {
      const score = SearchScorer.score({
        vectorSimilarity: 0.95,
        matchedTagWeights: [0.9, 0.8],
        daysSinceLastAccess: 1,
        accessCount: 5,
      });
      // vectorSim=0.95, tagWeight=1.0+1.7=2.7, freshness≈0.952, accessBoost=1.2
      expect(score).toBeGreaterThan(2.0);
    });

    it("low relevance + old + no access = low score", () => {
      const score = SearchScorer.score({
        vectorSimilarity: 0.3,
        matchedTagWeights: [],
        daysSinceLastAccess: 100,
        accessCount: 0,
      });
      // 0.3 * 1.0 * 0.7 * 1.0 = 0.21
      expect(score).toBeCloseTo(0.21, 2);
    });

    it("old but highly relevant still ranks well (REQ-3.4)", () => {
      const score = SearchScorer.score({
        vectorSimilarity: 0.98,
        matchedTagWeights: [1.0, 0.9],
        daysSinceLastAccess: 100,
        accessCount: 0,
      });
      // vectorSim=0.98, tagWeight=1.0+1.9=2.9, freshness=0.7, accessBoost=1.0
      // 0.98 * 2.9 * 0.7 * 1.0 ≈ 1.989
      expect(score).toBeGreaterThan(1.5);
    });

    it("vector-only hit uses tagWeightScore=1.0 (REQ-4.4)", () => {
      const score = SearchScorer.score({
        vectorSimilarity: 0.85,
        matchedTagWeights: [],
        daysSinceLastAccess: 0,
        accessCount: 0,
      });
      // 0.85 * 1.0 * 1.0 * 1.0 = 0.85
      expect(score).toBeCloseTo(0.85, 5);
    });
  });
});
