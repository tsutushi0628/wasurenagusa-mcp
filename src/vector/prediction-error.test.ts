import { describe, it, expect } from "vitest";
import { computePredictionError } from "./prediction-error.js";

describe("computePredictionError", () => {
  it("見立てが完全的中したら誤差0", () => {
    // 予測と実測が同じ集合 → Jaccard距離0
    expect(computePredictionError(["a", "b", "c"], ["a", "b", "c"])).toBe(0);
  });

  it("見立てが全外しなら誤差1", () => {
    // 交差ゼロ → Jaccard距離1
    expect(computePredictionError(["a", "b"], ["x", "y"])).toBe(1);
  });

  it("半分外したら誤差は0.5前後（中間値）", () => {
    // 予測{a,b} 実測{b,c}: 交差1 / 和集合3 = 1 - 1/3 ≈ 0.667
    const err = computePredictionError(["a", "b"], ["b", "c"]);
    expect(err).toBeGreaterThan(0);
    expect(err).toBeLessThan(1);
    // 1要素一致/3要素和 のケースを明示確認（中庸の誤差になる）
    expect(err).toBeCloseTo(0.667, 2);
  });

  it("予測が空配列なら差分計算不能で undefined", () => {
    expect(computePredictionError([], ["a"])).toBeUndefined();
  });

  it("実測が空配列なら差分計算不能で undefined", () => {
    expect(computePredictionError(["a"], [])).toBeUndefined();
  });

  it("空文字・空白のみ要素は除去され、全除去なら undefined", () => {
    expect(computePredictionError(["  ", ""], ["a"])).toBeUndefined();
  });

  it("大文字小文字・前後空白のゆれは正規化され同一視される", () => {
    // " Auth " と "auth" は同じ変数として扱われ的中（誤差0）になる
    expect(computePredictionError([" Auth ", "DB"], ["auth", "db"])).toBe(0);
  });

  it("戻り値は0〜1の範囲に収まり小数第3位で丸められる", () => {
    // 予測{a,b,c} 実測{c,d}: 交差1 / 和集合4 = 0.75
    const err = computePredictionError(["a", "b", "c"], ["c", "d"]);
    expect(err).toBeGreaterThanOrEqual(0);
    expect(err).toBeLessThanOrEqual(1);
    expect(err).toBe(0.75);
  });
});
