import { describe, expect, it } from "vitest";
import {
  mergeCorrectionRuleInputs,
  parseCorrectionRuleInput,
  renderCorrectionRule,
  renderTypedCorrectionRule,
  serializeCorrectionRuleInput,
  type CorrectionRuleInput,
} from "./rule-template.js";

const base = {
  version: 2,
  polarity: "positive",
  conditions: [],
  boundaryKey: "lifetime:explicit_continuing",
  lifetimeKind: "explicit_continuing",
  continuationBasis: "explicit-continuing-command",
  directive: true,
  question: false,
  toneException: false,
  conditionKnown: true,
} as const;

function rule(overrides: Partial<CorrectionRuleInput>): CorrectionRuleInput {
  return { ...base, topicKey: "response_policy", actionKey: "answer", requiredValues: {}, ...overrides };
}

describe("owner correction rule templates", () => {
  it("renders a bounded rule for each of the ten topics", () => {
    const inputs = [
      rule({ topicKey: "tone", actionKey: "use_casual", requiredValues: { audience: "owner", style: "常体" } }),
      rule({ topicKey: "response_policy", actionKey: "answer", requiredValues: { subject: "質問" } }),
      rule({ topicKey: "document_delivery", actionKey: "present_full", requiredValues: { documentKind: "文案・報告" } }),
      rule({ topicKey: "expression_policy", actionKey: "explain_terms", requiredValues: { term: "略語" } }),
      rule({ topicKey: "summary_constraints", actionKey: "limit_summary_length", requiredValues: { subject: "要約", limit: "100文字以内" } }),
      rule({ topicKey: "design_components", actionKey: "preserve_design", requiredValues: { component: "CSS部品" } }),
      rule({ topicKey: "verification", actionKey: "compare_source", requiredValues: { subject: "仕様書", source: "原本" } }),
      rule({ topicKey: "delegation_roles", actionKey: "assign_roles", requiredValues: { workType: "実装", assignee: "architect" } }),
      rule({ topicKey: "storage_location", actionKey: "set_storage_location", requiredValues: { artifactType: "成果物", destination: "リポジトリ直下" } }),
      rule({ topicKey: "model_routing", actionKey: "route_task", requiredValues: { workType: "implementation", model: "Claude Sonnet" } }),
    ];

    expect(inputs.map(renderCorrectionRule)).toEqual([
      "オーナーへの応答は毎回常体で書く",
      "毎回、質問に回答する",
      "文案・報告は毎回全文を表示する",
      "毎回、略語を説明する",
      "毎回、要約を100文字以内にまとめる",
      "毎回、CSS部品を維持する",
      "毎回、仕様書を原本と照合する",
      "毎回、実装はarchitectに任せる",
      "毎回、成果物をリポジトリ直下へ保存する",
      "毎回、実装にはClaude Sonnetを使う",
    ]);
  });

  it("leaves questions, consultations, unknown types, and missing values without rule text", () => {
    const question = rule({ directive: false, question: true });
    const consultation = rule({ directive: false });
    const unknown = rule({ topicKey: "unknown", actionKey: "unknown" });
    const missingStorage = rule({ topicKey: "storage_location", actionKey: "set_storage_location", requiredValues: { artifactType: "成果物" } });
    const unresolvedCondition = rule({ conditionKnown: false });

    expect([question, consultation, unknown, missingStorage, unresolvedCondition].map(renderCorrectionRule))
      .toEqual(["", "", "", "", ""]);
  });

  it("falls back to a bounded normalized correction command only when its predicate is explicit", () => {
    const untypedCommand = rule({
      topicKey: "document_delivery",
      actionKey: "present_full",
      requiredValues: {},
      commandText: "全文を出さないで",
    });
    const conditionalCommand = rule({
      topicKey: "unknown",
      actionKey: "unknown",
      requiredValues: {},
      conditionKnown: false,
      commandText: "引用時は全文を出さないで",
    });
    const untypedRouteCommand = rule({
      topicKey: "model_routing",
      actionKey: "route_task",
      requiredValues: {},
      conditionKnown: false,
      commandText: "実装にはClaude Sonnetを使う",
    });
    const genericUnknown = rule({
      topicKey: "unknown",
      actionKey: "unknown",
      requiredValues: {},
      commandText: "対応して",
    });
    const consultation = rule({
      topicKey: "document_delivery",
      actionKey: "present_full",
      requiredValues: {},
      directive: false,
      question: true,
      commandText: "全文を出してよいか相談したい",
    });
    const correctiveQuestion = rule({
      topicKey: "response_policy",
      actionKey: "answer",
      polarity: "negative",
      requiredValues: { subject: "質問" },
      question: true,
      commandText: "質問には回答しないで？",
    });
    const untypedQuestion = rule({
      topicKey: "unknown",
      actionKey: "unknown",
      requiredValues: {},
      directive: false,
      question: true,
      commandText: "今後は青い印を付けてよいか？",
    });
    const oversized = rule({
      topicKey: "unknown",
      actionKey: "unknown",
      requiredValues: {},
      commandText: `${"合成条件".repeat(60)}全文を出さないで`,
    });

    expect(renderCorrectionRule(untypedCommand)).toBe("全文を出さないで");
    expect(renderCorrectionRule(conditionalCommand)).toBe("引用時は全文を出さないで");
    expect(renderCorrectionRule(untypedRouteCommand)).toBe("実装にはClaude Sonnetを使う");
    expect(renderCorrectionRule(correctiveQuestion)).toBe("毎回、質問には回答しない");
    expect([genericUnknown, consultation, untypedQuestion, oversized].map(renderCorrectionRule))
      .toEqual(["", "", "", ""]);
  });

  it("removes repetition and reprimand markers from fallback rule text", () => {
    const previousInstruction = rule({
      topicKey: "unknown",
      actionKey: "unknown",
      requiredValues: {},
      conditionKnown: false,
      commandText: "以前にも言ったが、今後はＩＤ用の印を変更して",
    });
    const reprimand = rule({
      topicKey: "unknown",
      actionKey: "unknown",
      requiredValues: {},
      conditionKnown: false,
      commandText: "何回言わせるんだよ、また全文を出さないで",
    });
    const targetCondition = rule({
      topicKey: "unknown",
      actionKey: "unknown",
      requiredValues: {},
      conditionKnown: false,
      commandText: "前回の操作をまたいで設定を変更して",
    });

    expect(renderCorrectionRule(previousInstruction)).toBe("今後はID用の印を変更して");
    expect(renderCorrectionRule(reprimand)).toBe("全文を出さないで");
    expect(renderCorrectionRule(targetCondition)).toBe("前回の操作をまたいで設定を変更して");
  });

  it("does not flatten an unrepresented negated document action into a full-text rule", () => {
    const mixedActions = rule({
      topicKey: "document_delivery",
      actionKey: "present_full",
      polarity: "negative",
      requiredValues: { documentKind: "文書" },
      commandText: "今後、文書は要約しないで全文を出して",
    });
    const scopedDocument = rule({
      topicKey: "document_delivery",
      actionKey: "present_full",
      requiredValues: { documentKind: "社外向け文書" },
    });
    const unscopedDocument = rule({
      topicKey: "document_delivery",
      actionKey: "present_full",
      requiredValues: { documentKind: "文書" },
      commandText: "今後、社外向け文書は全文を出して",
    });
    const mismatchedTone = rule({
      topicKey: "tone",
      actionKey: "use_casual",
      polarity: "negative",
      requiredValues: { style: "常体" },
      commandText: "今後、敬語を使わないで常体で書いて",
    });
    const storedMixedActions = parseCorrectionRuleInput(serializeCorrectionRuleInput(mixedActions));

    expect(renderTypedCorrectionRule(mixedActions)).toBe("");
    expect(renderCorrectionRule(mixedActions)).toBe("");
    expect(storedMixedActions).not.toBeNull();
    if (!storedMixedActions) throw new Error("synthetic mixed action did not survive serialization");
    expect(renderCorrectionRule(storedMixedActions)).toBe("");
    expect(renderCorrectionRule(scopedDocument)).toBe("社外向け文書は毎回全文を表示する");
    expect(renderCorrectionRule(unscopedDocument)).toBe("");
    expect(renderCorrectionRule(mismatchedTone)).toBe("");
  });

  it("keeps a consultation question guarded even when its trailing clause is imperative", () => {
    const consultation = rule({
      topicKey: "document_delivery",
      actionKey: "present_full",
      requiredValues: { documentKind: "文書" },
      question: true,
      commandText: "今後、文書は全文を出すべきか、まず確認して",
    });
    const storedConsultation = parseCorrectionRuleInput(serializeCorrectionRuleInput(consultation));

    expect(renderTypedCorrectionRule(consultation)).toBe("");
    expect(renderCorrectionRule(consultation)).toBe("");
    expect(storedConsultation).not.toBeNull();
    if (!storedConsultation) throw new Error("synthetic consultation did not survive serialization");
    expect(renderCorrectionRule(storedConsultation)).toBe("");
  });

  it("merges typed condition branches without losing any condition", () => {
    const proposal = rule({
      topicKey: "document_delivery",
      actionKey: "present_full",
      requiredValues: { documentKind: "文案・報告" },
      conditions: ["文案作成時"],
    });
    const report = { ...proposal, conditions: ["報告作成時"] };
    const merged = mergeCorrectionRuleInputs([proposal, report]);

    expect(merged?.conditions).toEqual(["報告作成時", "文案作成時"]);
    expect(renderCorrectionRule(merged as CorrectionRuleInput))
      .toBe("報告作成時または文案作成時は文案・報告は毎回全文を表示する");
    expect(mergeCorrectionRuleInputs([proposal, { ...report, requiredValues: { documentKind: "回答" } }]))
      .toBeNull();
    const general = mergeCorrectionRuleInputs([proposal, { ...proposal, conditions: [] }]);
    expect(general?.conditions).toEqual([]);
    expect(renderCorrectionRule(general as CorrectionRuleInput))
      .toBe("文案・報告は毎回全文を表示する");
  });

  it("serializes and parses only the v2 typed input", () => {
    const input = rule({
      topicKey: "model_routing",
      actionKey: "route_task",
      requiredValues: { workType: "implementation", model: "Claude Sonnet" },
    });

    const encoded = serializeCorrectionRuleInput(input);
    expect(parseCorrectionRuleInput(encoded)).toEqual(input);
    expect(parseCorrectionRuleInput("[]")).toBeNull();
    expect(parseCorrectionRuleInput('{"topicKey":"unknown","ruleText":"raw utterance"}')).toBeNull();
  });
});
