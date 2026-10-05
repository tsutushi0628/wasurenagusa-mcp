import { describe, expect, it } from "vitest";
import { createBundleKey, diceCoefficient, haveSameBundleKey } from "./bundle-key.js";

describe("correction bundle keys", () => {
  it("groups matching topic, action, polarity, and conditions", () => {
    const first = {
      topicKey: "response_policy",
      actionKey: "answer_then_stop",
      polarity: "positive",
      conditionKey: "owner_response",
      normalizedText: "質問には答えてから止まる",
      conditionKnown: true,
    };
    const same = { ...first, normalizedText: "質問に答えてから止まる" };

    expect(haveSameBundleKey(first, same)).toBe(true);
  });

  it("separates polarity and condition changes", () => {
    const base = {
      topicKey: "tone",
      actionKey: "use_casual",
      polarity: "positive",
      conditionKey: "owner_response",
      normalizedText: "今後は常体で答える",
      conditionKnown: true,
    };

    expect(haveSameBundleKey(base, { ...base, polarity: "negative" })).toBe(false);
    expect(haveSameBundleKey(base, { ...base, conditionKey: "this_task_only" })).toBe(false);
  });

  it("keeps model-routing instructions separate when assignments differ", () => {
    const codex = {
      topicKey: "model_routing",
      actionKey: "route_task",
      polarity: "positive",
      conditionKey: "implementation=codex;design=owner",
      normalizedText: "実装はCodex、設計はオーナーが担当する",
      conditionKnown: true,
    };
    const sonnet = {
      ...codex,
      conditionKey: "implementation=sonnet;design=owner",
      normalizedText: "実装はSonnet、設計はオーナーが担当する",
    };

    expect(haveSameBundleKey(codex, sonnet)).toBe(false);
  });

  it("keeps the Dice helper independent from typed bundle grouping", () => {
    expect(diceCoefficient("かな漢字", "かな漢語")).toBeCloseTo(2 / 3);
    expect(diceCoefficient("a", "a")).toBe(1);
    expect(diceCoefficient("a", "b")).toBe(0);
    expect(diceCoefficient("", "")).toBe(1);

    const base = "abcdefghijklmnopqrstu";
    const threshold = "abcdefghijxymnopqrstu";
    const belowThreshold = "abcdefghixyzmnopqrstu";
    const descriptor = {
      topicKey: "document_delivery",
      actionKey: "present_full",
      polarity: "positive",
      conditionKey: "general",
      conditionKnown: true,
      normalizedText: base,
    };
    expect(diceCoefficient(base, threshold)).toBe(0.85);
    expect(haveSameBundleKey(descriptor, { ...descriptor, normalizedText: threshold })).toBe(true);
    expect(haveSameBundleKey(descriptor, { ...descriptor, normalizedText: belowThreshold })).toBe(false);
  });

  it("does not fuzz unknown topics or candidates with unknown conditions", () => {
    const first = {
      topicKey: "unknown",
      actionKey: "unknown",
      polarity: "positive",
      conditionKey: "unknown",
      normalizedText: "今後は青い印を付けて",
      conditionKnown: false,
    };
    const similar = { ...first, normalizedText: "今後は青い印を付けてください" };

    expect(haveSameBundleKey(first, { ...first })).toBe(true);
    expect(haveSameBundleKey(first, similar)).toBe(false);
  });

  it("normalizes outer whitespace, trailing punctuation, and ASCII case for unknown and model routes", () => {
    for (const topicKey of ["unknown", "model_routing"]) {
      const first = {
        topicKey,
        actionKey: "route_or_unknown",
        polarity: "positive",
        conditionKey: "general",
        normalizedText: "  Choose CODEX now。！！  ",
        conditionKnown: false,
        plainCommandEligible: true,
      };
      const same = { ...first, normalizedText: "choose codex now" };
      const different = { ...first, normalizedText: "choose claude now" };

      expect(haveSameBundleKey(first, same)).toBe(true);
      expect(haveSameBundleKey(first, different)).toBe(false);
      expect(createBundleKey(first)).toBe(createBundleKey(same));
    }
  });

  it("uses the round-zero Dice threshold without a type-formability gate", () => {
    const base = {
      topicKey: "document_delivery",
      actionKey: "present_full",
      polarity: "positive",
      conditionKey: "lifetime:inferred",
      normalizedText: "abcdefghijklmnopqrstu",
      conditionKnown: true,
      ruleFormable: false,
    };
    const threshold = { ...base, normalizedText: "abcdefghijxymnopqrstu" };

    expect(haveSameBundleKey(base, threshold)).toBe(true);
    expect(createBundleKey(base)).toMatch(/^oc:v1:/u);
    expect(createBundleKey(base)).not.toBe(createBundleKey(threshold));
  });
});
