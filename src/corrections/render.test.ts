import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  CORRECTION_OMISSION_MARKER,
  finalizeCorrectionRender,
  renderCorrectionRules,
  type CorrectionRule,
} from "./render.js";
import { estimateTokens } from "../injection/budget.js";

function rule(
  bundleKey: string,
  ruleText: string,
  options: Partial<CorrectionRule> = {},
): CorrectionRule {
  return {
    bundleKey,
    version: 1,
    title: `合成規則 ${bundleKey}`,
    ruleText,
    delivery: "start",
    ...options,
  };
}

describe("renderCorrectionRules", () => {
  it("開始時は6件・1件240文字・本文1440文字・本文1800 tokensの上限を守る", () => {
    const rules = Array.from({ length: 7 }, (_, index) =>
      rule(`start-${index}`, "あ".repeat(240)),
    );

    const result = renderCorrectionRules({ trigger: "start", rules });

    expect(result.includedRules).toHaveLength(6);
    expect(result.includedRules.every((entry) => Array.from(entry.ruleText).length <= 240)).toBe(true);
    expect(result.includedRules.reduce((total, entry) => total + Array.from(entry.ruleText).length, 0)).toBe(1440);
    expect(result.tokenCount).toBeLessThanOrEqual(1800);
    expect(result.tokenCount).toBeLessThanOrEqual(8000);
  });

  it("開始時の環境予算は8000 tokensを上限として本文と同じ完全項目で制御する", () => {
    const result = renderCorrectionRules({
      trigger: "start",
      rules: [rule("start-budget", "応答は常体で行う。")],
      budgetTokens: 1,
    });

    expect(result.text).toBe("");
    expect(result.includedRules).toEqual([]);
    expect(result.ledger).toEqual([]);
    expect(result.tokenCount).toBe(0);
  });

  it("発話時は未到達・定期・関連の優先順で最大3件を選ぶ", () => {
    const rules = [
      rule("restore-1", "未到達規則一。", { delivery: "restore" }),
      rule("restore-2", "未到達規則二。", { delivery: "restore" }),
      rule("refresh-1", "定期規則。", { delivery: "refresh" }),
      rule("related-1", "関連規則一。", { delivery: "related" }),
    ];

    const result = renderCorrectionRules({ trigger: "prompt", rules });

    expect(result.includedRules.map((entry) => entry.bundleKey)).toEqual([
      "restore-1",
      "restore-2",
      "refresh-1",
    ]);
    expect(result.text.indexOf("restore-1")).toBeLessThan(result.text.indexOf("restore-2"));
    expect(result.text.indexOf("restore-2")).toBeLessThan(result.text.indexOf("refresh-1"));
    expect(result.omittedBundleKeys).toContain("related-1");
    expect(result.tokenCount).toBeLessThanOrEqual(800);
  });

  it("発話時は本文640文字・ブロック650 tokens・全出力800 tokensを守る", () => {
    const rules = [
      rule("restore-1", "あ".repeat(240), { delivery: "restore" }),
      rule("restore-2", "い".repeat(240), { delivery: "restore" }),
      rule("refresh-1", "う".repeat(160), { delivery: "refresh" }),
      rule("related-1", "え".repeat(240), { delivery: "related" }),
    ];

    const result = renderCorrectionRules({ trigger: "prompt", rules });
    const includedCharacters = result.includedRules.reduce(
      (total, entry) => total + Array.from(entry.ruleText).length,
      0,
    );

    expect(includedCharacters).toBeLessThanOrEqual(640);
    expect(result.tokenCount).toBeLessThanOrEqual(650);
    expect(result.tokenCount).toBeLessThanOrEqual(800);
  });

  it("発話時も定期分の本文160文字上限を適用し、後続の短い関連規則を選ぶ", () => {
    const result = renderCorrectionRules({
      trigger: "prompt",
      rules: [
        rule("refresh-too-long", "あ".repeat(200), { delivery: "refresh" }),
        rule("related-after-refresh", "短い関連規則。", { delivery: "related" }),
      ],
    });

    expect(result.includedRules.map((entry) => entry.bundleKey)).toEqual([
      "related-after-refresh",
    ]);
    expect(result.omittedBundleKeys).toContain("refresh-too-long");
  });

  it("発話時も定期分のヘッダー・題名・ID込み450 tokens上限を適用する", () => {
    const refreshRule = rule("refresh-title-limit", "本文。", {
      delivery: "refresh",
      title: "合成題名".repeat(110),
    });
    const fullItem = renderCorrectionRules({ trigger: "start", rules: [refreshRule] });
    const promptResult = renderCorrectionRules({ trigger: "prompt", rules: [refreshRule] });

    expect(fullItem.tokenCount).toBeGreaterThan(450);
    expect(fullItem.tokenCount).toBeLessThanOrEqual(650);
    expect(promptResult.includedRules).toEqual([]);
    expect(promptResult.omittedBundleKeys).toEqual(["refresh-title-limit"]);
  });

  it("定期再注入は2件・1件160文字・合計320文字・450 tokens以内に保つ", () => {
    const rules = Array.from({ length: 3 }, (_, index) =>
      rule(`refresh-${index}`, "あ".repeat(160), { delivery: "refresh" }),
    );

    const result = renderCorrectionRules({ trigger: "refresh", rules });
    const includedCharacters = result.includedRules.reduce(
      (total, entry) => total + Array.from(entry.ruleText).length,
      0,
    );

    expect(result.includedRules).toHaveLength(2);
    expect(includedCharacters).toBe(320);
    expect(result.tokenCount).toBeLessThanOrEqual(450);
  });

  it("PreCompactは2件・1件160文字・合計320文字・450 tokens以内に保つ", () => {
    const rules = Array.from({ length: 3 }, (_, index) =>
      rule(`compact-${index}`, "あ".repeat(160)),
    );

    const result = renderCorrectionRules({ trigger: "precompact", rules });
    const includedCharacters = result.includedRules.reduce(
      (total, entry) => total + Array.from(entry.ruleText).length,
      0,
    );

    expect(result.includedRules).toHaveLength(2);
    expect(includedCharacters).toBe(320);
    expect(result.tokenCount).toBeLessThanOrEqual(450);
  });

  it("240文字を超える規則を切らず、条件・否定・複数行をそのまま保つ", () => {
    const completeRule = "条件: 合成fixtureのとき。\nその場合は本文を出さない。";
    const tooLongRule = `${completeRule}\n補足: ${"あ".repeat(240)}`;
    const result = renderCorrectionRules({
      trigger: "start",
      rules: [rule("complete", completeRule), rule("too-long", tooLongRule)],
    });

    expect(result.text).toContain(completeRule);
    expect(result.text).not.toContain(tooLongRule);
    expect(result.text).not.toContain("too-long");
    expect(result.includedRules.map((entry) => entry.bundleKey)).toEqual(["complete"]);
  });

  it("文字上限を超える先頭規則だけを除外し、後続の短い規則を配送する", () => {
    const result = renderCorrectionRules({
      trigger: "start",
      rules: [
        rule("too-long-first", "あ".repeat(241)),
        rule("short-after-long", "短い完全規則。"),
      ],
    });

    expect(result.includedRules.map((entry) => entry.bundleKey)).toEqual([
      "short-after-long",
    ]);
    expect(result.omittedBundleKeys).toContain("too-long-first");
    expect(result.text).toContain("短い完全規則。");
  });

  it("定期分の161文字規則を除外し、後続規則を160文字境界で配送する", () => {
    const result = renderCorrectionRules({
      trigger: "refresh",
      rules: [
        rule("refresh-161", "あ".repeat(161), { delivery: "refresh" }),
        rule("refresh-160", "い".repeat(160), { delivery: "refresh" }),
      ],
    });

    expect(result.includedRules.map((entry) => entry.bundleKey)).toEqual([
      "refresh-160",
    ]);
    expect(result.omittedBundleKeys).toContain("refresh-161");
    expect(result.includedRules[0]?.ruleText).toHaveLength(160);
  });

  it("予算1ではヘッダーやIDだけを出さず空を返す", () => {
    const result = renderCorrectionRules({
      trigger: "prompt",
      rules: [rule("budget-one", "短い規則。")],
      budgetTokens: 1,
    });

    expect(result.text).toBe("");
    expect(result.includedRules).toEqual([]);
    expect(result.ledger).toEqual([]);
  });

  it("ヘッダー・題名・IDも実出力予算に含める", () => {
    const result = renderCorrectionRules({
      trigger: "start",
      rules: [
        rule("id-".repeat(100), "本文。", {
          title: "題名".repeat(100),
        }),
      ],
      budgetTokens: estimateTokens("本文。"),
    });

    expect(result.text).toBe("");
    expect(result.ledger).toEqual([]);
    expect(result.tokenCount).toBeLessThanOrEqual(estimateTokens("本文。"));
  });

  it("省略マーカーが規則と一緒に収まらなければ部分出力をせず空を返す", () => {
    const first = rule("marker-fit", "短い規則。");
    const second = rule("marker-overflow", "次の規則。");
    const single = renderCorrectionRules({ trigger: "start", rules: [first] });
    const result = renderCorrectionRules({
      trigger: "start",
      rules: [first, second],
      budgetTokens: single.tokenCount,
    });

    expect(result.text).toBe("");
    expect(result.includedRules).toEqual([]);
    expect(result.ledger).toEqual([]);
    expect(result.omittedBundleKeys).toEqual(["marker-fit", "marker-overflow"]);
  });

  it("1件を予算落ちさせた後の出力・台帳ID・本文hash・最終hashを一致させる", () => {
    const first = rule("kept-id", "条件: 合成入力。\n否定: 本文を省かない。");
    const second = rule("omitted-id", "次の規則。", {
      title: "長い題名".repeat(100),
    });
    const full = renderCorrectionRules({
      trigger: "start",
      rules: [first, second],
    });
    const single = renderCorrectionRules({ trigger: "start", rules: [first] });
    const markerBudget = estimateTokens(`${single.text}\n\n${CORRECTION_OMISSION_MARKER}`);
    const result = renderCorrectionRules({
      trigger: "start",
      rules: [first, second],
      budgetTokens: markerBudget,
    });
    const expectedOutputHash = createHash("sha256").update(result.text, "utf8").digest("hex");
    const expectedBodyHash = createHash("sha256").update(first.ruleText, "utf8").digest("hex");

    expect(full.includedRules).toHaveLength(2);
    expect(result.includedRules.map((entry) => entry.bundleKey)).toEqual(["kept-id"]);
    expect(result.omittedBundleKeys).toContain("omitted-id");
    expect(result.text).toContain(CORRECTION_OMISSION_MARKER);
    expect(result.text).toContain(first.ruleText);
    expect(result.text).not.toContain(second.bundleKey);
    expect(result.outputHash).toBe(expectedOutputHash);
    expect(result.ledger).toEqual([
      expect.objectContaining({
        bundleKey: "kept-id",
        version: 1,
        bodyHash: expectedBodyHash,
        outputHash: expectedOutputHash,
        outputOrder: 1,
        bodyIncluded: true,
      }),
    ]);
    expect(result.ledger.every((entry) => entry.outputHash === result.outputHash)).toBe(true);
    expect(result.tokenCount).toBeLessThanOrEqual(markerBudget);
  });

  it("外側の最終出力から1規則が落ちた場合、残った規則と出力hashだけを台帳化する", () => {
    const first = rule("final-kept", "条件: 合成入力。\n否定: 本文を省かない。");
    const second = rule("final-dropped", "別の合成規則。");
    const rendered = renderCorrectionRules({
      trigger: "start",
      rules: [first, second],
    });
    const retained = renderCorrectionRules({ trigger: "start", rules: [first] });
    const finalOutput = `既存索引\n\n${retained.text}`;
    const result = finalizeCorrectionRender(rendered, finalOutput);
    const expectedOutputHash = createHash("sha256").update(finalOutput, "utf8").digest("hex");

    expect(result.text).toBe(finalOutput);
    expect(result.includedRules.map((entry) => entry.bundleKey)).toEqual(["final-kept"]);
    expect(result.omittedBundleKeys).toContain("final-dropped");
    expect(result.outputHash).toBe(expectedOutputHash);
    expect(result.ledger).toEqual([
      expect.objectContaining({
        bundleKey: "final-kept",
        outputHash: expectedOutputHash,
        outputOrder: 1,
        bodyIncluded: true,
      }),
    ]);
    expect(result.ledger.some((entry) => entry.bundleKey === "final-dropped")).toBe(false);
  });
});
