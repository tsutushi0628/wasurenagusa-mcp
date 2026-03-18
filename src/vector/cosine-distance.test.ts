import { describe, it, expect } from "vitest";
import { cosineDistance } from "./cosine-distance.js";

describe("cosineDistance", () => {
  describe("basic geometric cases", () => {
    it("returns 0 for identical vectors", () => {
      const v = [1, 2, 3];
      expect(cosineDistance(v, v)).toBe(0);
    });

    it("returns 0 for parallel vectors with different magnitudes", () => {
      const a = [1, 2, 3];
      const b = [2, 4, 6];
      expect(cosineDistance(a, b)).toBeCloseTo(0, 10);
    });

    it("returns approximately 1 for orthogonal vectors", () => {
      const a = [1, 0];
      const b = [0, 1];
      expect(cosineDistance(a, b)).toBeCloseTo(1, 10);
    });

    it("returns approximately 2 for opposite vectors", () => {
      const a = [1, 2, 3];
      const b = [-1, -2, -3];
      expect(cosineDistance(a, b)).toBeCloseTo(2, 10);
    });

    it("returns value between 0 and 1 for acute angle", () => {
      const a = [1, 0];
      const b = [1, 1];
      const dist = cosineDistance(a, b);
      expect(dist).toBeGreaterThan(0);
      expect(dist).toBeLessThan(1);
    });

    it("returns value between 1 and 2 for obtuse angle", () => {
      const a = [1, 0];
      const b = [-1, 1];
      const dist = cosineDistance(a, b);
      expect(dist).toBeGreaterThan(1);
      expect(dist).toBeLessThan(2);
    });
  });

  describe("error handling", () => {
    it("throws when vectors have different lengths", () => {
      expect(() => cosineDistance([1, 2], [1, 2, 3])).toThrow(
        "Vector length mismatch",
      );
    });

    it("throws when first vector is zero", () => {
      expect(() => cosineDistance([0, 0, 0], [1, 2, 3])).toThrow(
        "Vector a is a zero vector",
      );
    });

    it("throws when second vector is zero", () => {
      expect(() => cosineDistance([1, 2, 3], [0, 0, 0])).toThrow(
        "Vector b is a zero vector",
      );
    });

    it("throws when both vectors are zero", () => {
      expect(() => cosineDistance([0, 0], [0, 0])).toThrow("zero vector");
    });

    it("throws for empty vectors (zero-length)", () => {
      expect(() => cosineDistance([], [])).toThrow("zero vector");
    });
  });

  describe("high-dimensional vectors (768-dim)", () => {
    it("returns 0 for identical 768-dim vectors", () => {
      const v = Array.from({ length: 768 }, (_, i) => Math.sin(i));
      expect(cosineDistance(v, v)).toBeCloseTo(0, 10);
    });

    it("returns approximately 2 for opposite 768-dim vectors", () => {
      const v = Array.from({ length: 768 }, (_, i) => Math.sin(i));
      const neg = v.map((x) => -x);
      expect(cosineDistance(v, neg)).toBeCloseTo(2, 10);
    });

    it("returns near 1 for random orthogonal-ish 768-dim vectors", () => {
      // Two vectors built from sin/cos at different frequencies
      // are approximately orthogonal over many dimensions
      const a = Array.from({ length: 768 }, (_, i) => Math.sin(i * 1.0));
      const b = Array.from({ length: 768 }, (_, i) => Math.cos(i * 1000.7));
      const dist = cosineDistance(a, b);
      // Not exactly 1 but should be close for pseudo-random-ish vectors
      expect(dist).toBeGreaterThan(0.5);
      expect(dist).toBeLessThan(1.5);
    });

    it("handles 768-dim vectors with small magnitudes", () => {
      const v = Array.from({ length: 768 }, () => 1e-100);
      const w = Array.from({ length: 768 }, () => 1e-100);
      expect(cosineDistance(v, w)).toBeCloseTo(0, 10);
    });
  });

  describe("Float64 precision edge cases", () => {
    it("handles very large component values", () => {
      const a = [1e150, 1e150];
      const b = [1e150, 1e150];
      expect(cosineDistance(a, b)).toBeCloseTo(0, 10);
    });

    it("handles very small component values that underflow to zero", () => {
      // 1e-200 squared is 1e-400 which underflows to 0 in Float64
      // This correctly triggers the zero-vector error
      expect(() => cosineDistance([1e-200, 1e-200], [1e-200, 1e-200])).toThrow(
        "zero vector",
      );
    });

    it("handles small but representable component values", () => {
      const a = [1e-100, 1e-100];
      const b = [1e-100, 1e-100];
      expect(cosineDistance(a, b)).toBeCloseTo(0, 10);
    });

    it("handles mixed large and small components", () => {
      const a = [1e10, 1e-10];
      const b = [1e10, 1e-10];
      expect(cosineDistance(a, b)).toBeCloseTo(0, 10);
    });

    it("clamps similarity that overshoots 1.0 due to floating-point", () => {
      // When vectors are nearly identical, floating-point arithmetic
      // can produce a dot/(normA*normB) slightly > 1.0
      // The function should still return 0 (not a negative number)
      const a = [1, 1e-16];
      const b = [1, 1e-16];
      const dist = cosineDistance(a, b);
      expect(dist).toBeGreaterThanOrEqual(0);
    });

    it("returns non-negative value always", () => {
      // Test with a variety of parallel-ish vectors
      const cases = [
        [[1, 0, 0], [1, 0, 0]],
        [[3.14, 2.71], [3.14, 2.71]],
        [[0.1, 0.2, 0.3], [0.1, 0.2, 0.3]],
      ];
      for (const [a, b] of cases) {
        expect(cosineDistance(a, b)).toBeGreaterThanOrEqual(0);
      }
    });

    it("does not return NaN for valid inputs", () => {
      const a = [1, 2, 3, 4, 5];
      const b = [5, 4, 3, 2, 1];
      const dist = cosineDistance(a, b);
      expect(Number.isNaN(dist)).toBe(false);
    });
  });
});
