import { describe, it, expect } from "vitest";
import {
  asL2Distance,
  asCosineSimilarity,
  l2Threshold,
  cosineSimThreshold,
  l2ToCosineSim,
  isWithin,
  meetsSimilarity,
} from "./distance-types.js";

describe("distance-types（距離尺度の型封じ）", () => {
  it("同一尺度同士の比較（L2距離が閾値以内か）が判定できる", () => {
    const near = asL2Distance(0.2);
    const far = asL2Distance(0.8);
    const t = l2Threshold(0.25);
    expect(isWithin(near, t)).toBe(true);
    expect(isWithin(far, t)).toBe(false);
  });

  it("境界値（value === threshold）は within とみなす（<= 判定・既存 searchVectors と一致）", () => {
    expect(isWithin(asL2Distance(0.25), l2Threshold(0.25))).toBe(true);
  });

  it("l2ToCosineSim が正規化ベクトル前提で正しい値を返す（cos = 1 - L2^2/2）", () => {
    // 完全一致: L2=0 → cos=1
    expect(l2ToCosineSim(asL2Distance(0)).value).toBeCloseTo(1, 10);
    // 直交: L2=sqrt(2) → cos=0
    expect(l2ToCosineSim(asL2Distance(Math.SQRT2)).value).toBeCloseTo(0, 10);
    // 正反対: L2=2 → cos=-1
    expect(l2ToCosineSim(asL2Distance(2)).value).toBeCloseTo(-1, 10);
    // 一般値: L2=0.5 → cos = 1 - 0.125 = 0.875
    expect(l2ToCosineSim(asL2Distance(0.5)).value).toBeCloseTo(0.875, 10);
  });

  it("meetsSimilarity はコサイン類似度が閾値以上かを判定する（>= 判定）", () => {
    expect(meetsSimilarity(asCosineSimilarity(0.9), cosineSimThreshold(0.85))).toBe(true);
    expect(meetsSimilarity(asCosineSimilarity(0.8), cosineSimThreshold(0.85))).toBe(false);
  });

  it("尺度混同コードは型エラーになる（型レベルのネガティブテスト・type-check ゲートで担保）", () => {
    const l2 = asL2Distance(0.2);
    const cosT = cosineSimThreshold(0.85);
    // @ts-expect-error L2距離値をコサイン類似度の閾値と比較することはコンパイルで拒否される
    isWithin(l2, cosT);

    const cos = asCosineSimilarity(0.9);
    const l2T = l2Threshold(0.25);
    // @ts-expect-error コサイン類似度値をL2距離の閾値と比較することはコンパイルで拒否される
    meetsSimilarity(cos, l2T);
    expect(true).toBe(true);
  });
});
