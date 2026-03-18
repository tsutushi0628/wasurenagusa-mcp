import { describe, it, expect } from "vitest";
import {
  filterByTier,
  shouldPromoteToCritical,
  TIER_THRESHOLDS,
  CRITICAL_PROMOTION_THRESHOLD,
  VectorSearchResult,
} from "./memory-tier.js";

function makeResult(id: string, distance: number, accessCount: number): VectorSearchResult {
  return { id, distance, accessCount };
}

describe("memory-tier", () => {
  describe("filterByTier()", () => {
    describe("short tier (threshold: 0.2)", () => {
      it("distance が閾値ちょうどの場合は含まれる", () => {
        const results = [makeResult("a", 0.2, 0)];
        const filtered = filterByTier(results, "short");
        expect(filtered).toHaveLength(1);
        expect(filtered[0].id).toBe("a");
      });

      it("distance が閾値をわずかに超える場合は除外される", () => {
        const results = [makeResult("a", 0.200001, 0)];
        const filtered = filterByTier(results, "short");
        expect(filtered).toHaveLength(0);
      });

      it("distance が閾値未満の場合は含まれる", () => {
        const results = [makeResult("a", 0.1, 0)];
        const filtered = filterByTier(results, "short");
        expect(filtered).toHaveLength(1);
      });
    });

    describe("medium tier (threshold: 0.45)", () => {
      it("distance が閾値ちょうどの場合は含まれる", () => {
        const results = [makeResult("a", 0.45, 0)];
        const filtered = filterByTier(results, "medium");
        expect(filtered).toHaveLength(1);
      });

      it("distance が閾値をわずかに超える場合は除外される", () => {
        const results = [makeResult("a", 0.450001, 0)];
        const filtered = filterByTier(results, "medium");
        expect(filtered).toHaveLength(0);
      });

      it("distance が閾値未満の場合は含まれる", () => {
        const results = [makeResult("a", 0.3, 0)];
        const filtered = filterByTier(results, "medium");
        expect(filtered).toHaveLength(1);
      });
    });

    describe("long tier (threshold: 0.7)", () => {
      it("distance が閾値ちょうどの場合は含まれる", () => {
        const results = [makeResult("a", 0.7, 0)];
        const filtered = filterByTier(results, "long");
        expect(filtered).toHaveLength(1);
      });

      it("distance が閾値をわずかに超える場合は除外される", () => {
        const results = [makeResult("a", 0.700001, 0)];
        const filtered = filterByTier(results, "long");
        expect(filtered).toHaveLength(0);
      });

      it("distance が閾値未満の場合は含まれる", () => {
        const results = [makeResult("a", 0.5, 0)];
        const filtered = filterByTier(results, "long");
        expect(filtered).toHaveLength(1);
      });
    });

    it("空の結果配列を渡した場合は空配列を返す", () => {
      const filtered = filterByTier([], "short");
      expect(filtered).toHaveLength(0);
      expect(filtered).toEqual([]);
    });

    it("混合distanceの結果から閾値以下のみをフィルタリングする", () => {
      const results = [
        makeResult("close", 0.1, 2),
        makeResult("boundary", 0.2, 1),
        makeResult("far", 0.5, 3),
        makeResult("very-far", 0.9, 0),
      ];
      const filtered = filterByTier(results, "short");
      expect(filtered).toHaveLength(2);
      expect(filtered[0].id).toBe("close");
      expect(filtered[1].id).toBe("boundary");
    });

    it("元の配列の順序を保持する", () => {
      const results = [
        makeResult("c", 0.15, 0),
        makeResult("a", 0.05, 0),
        makeResult("b", 0.1, 0),
      ];
      const filtered = filterByTier(results, "short");
      expect(filtered.map((r) => r.id)).toEqual(["c", "a", "b"]);
    });
  });

  describe("shouldPromoteToCritical()", () => {
    it("accessCount が 5 の場合は false を返す（閾値は strictly greater than）", () => {
      expect(shouldPromoteToCritical(5)).toBe(false);
    });

    it("accessCount が 6 の場合は true を返す", () => {
      expect(shouldPromoteToCritical(6)).toBe(true);
    });

    it("accessCount が 0 の場合は false を返す", () => {
      expect(shouldPromoteToCritical(0)).toBe(false);
    });

    it("accessCount が大きい値の場合は true を返す", () => {
      expect(shouldPromoteToCritical(100)).toBe(true);
    });
  });

  describe("定数値", () => {
    it("TIER_THRESHOLDS の値が正しい", () => {
      expect(TIER_THRESHOLDS.short).toBe(0.2);
      expect(TIER_THRESHOLDS.medium).toBe(0.45);
      expect(TIER_THRESHOLDS.long).toBe(0.7);
    });

    it("CRITICAL_PROMOTION_THRESHOLD は 5", () => {
      expect(CRITICAL_PROMOTION_THRESHOLD).toBe(5);
    });
  });
});
