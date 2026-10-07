import { describe, expect, it } from "vitest";
import {
  detectOwnerCorrections,
  getModelRoutingRetractionTargets,
  isModelRoutingRetraction,
} from "./detector.js";
import { extractOwnerEvent } from "./events.js";
import {
  parseCorrectionRuleInput,
  renderPlainCorrectionRule,
  serializeCorrectionRuleInput,
} from "./rule-template.js";

function detect(text: string, context: Record<string, unknown> = {}) {
  const event = extractOwnerEvent({
    type: "user",
    origin: { kind: "human" },
    sessionId: "synthetic-session",
    message: { content: text },
  });
  return event ? detectOwnerCorrections(event, context) : [];
}

describe("detectOwnerCorrections", () => {
  it("extracts each finite topic only when its target and action appear together", () => {
    const examples = [
      ["tone", "今後は常体で答えて"],
      ["response_policy", "今後は質問に答えてから止まって"],
      ["document_delivery", "今後は文案・報告の全文を表示して"],
      ["expression_policy", "今後は略語を説明して"],
      ["summary_constraints", "今後は要約を100文字以内にして"],
      ["design_components", "今後はCSS部品を維持して"],
      ["verification", "今後は仕様書を原本と照合して"],
      ["delegation_roles", "今後は実装はarchitectに任せて"],
      ["storage_location", "今後は成果物をリポジトリ直下に保存して"],
      ["model_routing", "今後は実装をClaude Sonnetで担当して"],
    ] as const;

    for (const [topicKey, text] of examples) {
      const candidate = detect(text)[0];
      expect(candidate).toMatchObject({ topicKey, status: "confirmed" });
      expect(candidate?.ruleText).not.toBe(text);
      expect(candidate?.ruleText).not.toBe("");
    }
    expect(detect("今後は全文の提示について確認")).toEqual([]);
  });

  it("preserves action polarity and target modifiers in compound document and tone instructions", () => {
    const mixedDocumentActions = detect("今後、文書は要約しないで全文を出して")[0];
    const explicitToneChoice = detect("今後、敬語を使わないで常体で書いて")[0];
    const scopedDocument = detect("今後、社外向け文書は全文を出して")[0];
    const explicitDocumentNegation = detect("今後、文書の全文を出さないで")[0];

    expect(mixedDocumentActions).toMatchObject({ status: "candidate", ruleText: "" });
    expect(explicitToneChoice).toMatchObject({
      status: "confirmed",
      topicKey: "tone",
      polarity: "positive",
      ruleText: "応答は毎回常体で書く",
    });
    expect(scopedDocument).toMatchObject({
      status: "confirmed",
      topicKey: "document_delivery",
      ruleText: "社外向け文書は毎回全文を表示する",
    });
    expect(explicitDocumentNegation).toMatchObject({
      status: "confirmed",
      polarity: "negative",
      ruleText: "文書は毎回全文を表示しない",
    });
  });

  it("preserves negative expression modifiers across four modifier and four bare-target fixtures", () => {
    const modifiedFixtures = [
      ["今後は変な言葉を使わないで", "変な言葉"],
      ["今後は俺のわからない言葉を使わないで", "俺のわからない言葉"],
      ["今後は知らない用語を使わないで", "知らない用語"],
      ["今後は意味の分からない略語を使うな", "意味の分からない略語"],
    ] as const;
    const bareFixtures = [
      ["今後は言葉を使わないで", "言葉"],
      ["今後は用語を使わないで", "用語"],
      ["今後は略語を使わないで", "略語"],
      ["今後は比喩を使わないで", "比喩"],
    ] as const;

    for (const [command, target] of modifiedFixtures) {
      expect(detect(command)[0]?.ruleText).toBe(`毎回、${target}を使わない`);
    }
    for (const [command, target] of bareFixtures) {
      expect(detect(command)[0]?.ruleText).toBe(`毎回、${target}を使わない`);
    }
  });

  it("classifies generic Japanese prohibitions as negative and renders their command text", () => {
    const commands = ["架空の青色試料番号を書くな。", "架空の青色試料番号を書かない。"];

    for (const command of commands) {
      const candidate = detect(command)[0];

      expect(candidate).toMatchObject({ status: "candidate", polarity: "negative" });
      expect(candidate?.ruleInput.commandText).toBe(command);
      expect(candidate?.ruleText).toBe(command);
    }
    expect(detect("文章は短くない。")).toHaveLength(0);
  });

  it("keeps modifier variants in one bundle without dropping their rule text", () => {
    const fixtures = [
      ["今後は変な言葉を使わないで", "変な言葉"],
      ["今後は俺のわからない言葉を使わないで", "俺のわからない言葉"],
      ["今後は知らない言葉を使わないで", "知らない言葉"],
      ["今後は意味不明な言葉を使わないで", "意味不明な言葉"],
    ] as const;
    const candidates = fixtures.map(([command]) => detect(command)[0]);
    const first = candidates[0];

    expect(first).toBeDefined();
    expect(new Set(candidates.map((candidate) => candidate?.bundleKey)).size).toBe(1);
    for (const [index, candidate] of candidates.entries()) {
      expect(candidate).toMatchObject({
        topicKey: "expression_policy",
        actionKey: "use_terms",
        polarity: "negative",
        ruleText: `毎回、${fixtures[index][1]}を使わない`,
      });
    }

    const opposite = detect("今後は言葉を使え")[0];
    expect(opposite).toBeDefined();
    expect(opposite?.bundleKey).not.toBe(first?.bundleKey);
    expect(detect("今後は言葉を使わないで")[0]?.bundleKey).not.toBe(first?.bundleKey);
    expect(detect("今後は難しい言葉を使わないで")[0]?.bundleKey).not.toBe(first?.bundleKey);
  });

  it("uses the unchanged plain command when an expression modifier cannot be extracted", () => {
    const command = "今後はこの語彙では判断に迷う言葉を使うな";
    const candidate = detect(command)[0];

    expect(candidate).toMatchObject({
      status: "candidate",
      ruleText: "",
      ruleInput: {
        directive: false,
        plainCommandEligible: true,
        commandText: command,
        requiredValues: { term: "この語彙では判断に迷う言葉" },
      },
    });
    expect(renderPlainCorrectionRule(candidate!.ruleInput)).toBe(command);
    expect(detect("今後はこの課題では判断に迷う言葉を使うな")[0]?.bundleKey)
      .not.toBe(candidate?.bundleKey);
  });

  it("does not treat a consultation's separate imperative as a continuing document rule", () => {
    const candidate = detect("今後、文書は全文を出すべきか、まず確認して")[0];

    expect(candidate).toMatchObject({
      status: "candidate",
      topicKey: "document_delivery",
      ruleText: "",
      ruleInput: { question: true, directive: false },
    });
  });

  it("keeps the scoring boundary for repeat corrections, continuing instructions, and ordinary requests", () => {
    const repeated = detect("前回も言ったけれど、質問に答えて止まって");
    const continuing = detect("今後は質問に答えてから止まって");
    const request = detect("質問に答えてください");

    expect(repeated[0]).toMatchObject({ score: 5, status: "candidate", topicKey: "response_policy" });
    expect(continuing[0]).toMatchObject({ score: 4, status: "confirmed", lifetimeKind: "explicit_continuing" });
    expect(request[0]).toMatchObject({ score: 2, status: "candidate", source: "request_repeat" });
  });

  it("keeps ordinary typed and unknown requests as bodyless candidates", () => {
    const typedRequest = detect("質問に答えてください")[0];
    const unknownRequest = detect("記事の下書きを書いて")[0];

    expect(typedRequest).toMatchObject({ status: "candidate", ruleText: "", ruleInput: { directive: false } });
    expect(unknownRequest).toMatchObject({ topicKey: "unknown", status: "candidate", ruleText: "", ruleInput: { directive: false } });
  });

  it("marks only short, single-sentence behavior commands as plain eligible", () => {
    const eligible = [
      "全文を出して",
      "質問に答えろ",
      "要約を短くしないで",
      "その印を使うな",
    ].map((text) => detect(text)[0]);
    const positiveUnknown = detect("記事の下書きを書いて")[0];
    const longCommand = detect("x".repeat(35) + "質問に答えて")[0];
    const question = detect("質問に答えて?")[0];
    const sensitive = detect("前回も言ったが token=synthetic-secret-value-1234567890 を使うな")[0];
    const segmented = detect("質問に答えろ。記事の下書きを書いて。");

    expect(eligible.map((candidate) => candidate?.ruleInput.plainCommandEligible)).toEqual([true, true, true, true]);
    expect(eligible.slice(0, 2).map((candidate) => candidate?.ruleText)).toEqual(["", ""]);
    expect(positiveUnknown?.ruleInput.plainCommandEligible).toBe(false);
    expect(longCommand?.ruleInput.plainCommandEligible).toBe(false);
    expect(question?.ruleInput.plainCommandEligible).toBe(false);
    expect(sensitive?.ruleInput.plainCommandEligible).toBe(false);
    expect(sensitive?.ruleInput.commandText).toBe("");
    expect(sensitive?.ruleText).toBe("");
    expect(segmented.map((candidate) => candidate.ruleInput.plainCommandEligible)).toEqual([true, false]);
  });

  it("groups plain known topics by required values and plain unknown or routing commands by exact text", () => {
    const sameValues = detect("文案は全文を出して")[0];
    const sameValuesVariant = detect("文案の全文を表示して")[0];
    const differentValues = detect("資料の全文を出して")[0];
    const modelRoute = detect("実装はCodexで担当して")[0];
    const differentModelRoute = detect("実装はSonnetで担当して")[0];

    expect(sameValues).toMatchObject({ ruleInput: { plainCommandEligible: true } });
    expect(sameValuesVariant).toMatchObject({ ruleInput: { plainCommandEligible: true } });
    expect(differentValues).toMatchObject({ ruleInput: { plainCommandEligible: true } });
    expect(sameValues?.bundleKey).toBe(sameValuesVariant?.bundleKey);
    expect(sameValues?.bundleKey).not.toBe(differentValues?.bundleKey);
    expect(modelRoute).toMatchObject({ topicKey: "model_routing", lifetimeKind: "routing", ruleInput: { plainCommandEligible: true } });
    expect(differentModelRoute?.bundleKey).not.toBe(modelRoute?.bundleKey);
  });

  it("keeps short taskless model instructions on the routing path and detects retractions separately", () => {
    const forced = detect("Codexを使って")[0];
    const prohibited = detect("Codexを使うな")[0];
    const forcedHard = detect("Codexを使え")[0];
    const prohibitedSoft = detect("Codexを使わないで")[0];
    const prohibitedStop = detect("Codexをやめて")[0];
    const differentModel = detect("Claudeを使って")[0];
    const retractionEvent = extractOwnerEvent({
      type: "user",
      origin: { kind: "human" },
      sessionId: "synthetic-session",
      message: { content: "今回はCodexじゃない" },
    });
    const quotaEvent = extractOwnerEvent({
      type: "user",
      origin: { kind: "human" },
      sessionId: "synthetic-session",
      message: { content: "Codexの枠なし" },
    });

    expect(forced).toMatchObject({
      topicKey: "model_routing",
      polarity: "positive",
      lifetimeKind: "routing",
      ruleText: "",
      ruleInput: { plainCommandEligible: true, requiredValues: { model: "Codex" }, directive: false },
    });
    expect(prohibited).toMatchObject({
      topicKey: "model_routing",
      polarity: "negative",
      lifetimeKind: "routing",
      ruleText: "",
      ruleInput: { plainCommandEligible: true, requiredValues: { model: "Codex" }, directive: false },
    });
    expect(forcedHard).toMatchObject({ topicKey: "model_routing", ruleInput: { plainCommandEligible: true } });
    expect(prohibitedSoft).toMatchObject({ topicKey: "model_routing", polarity: "negative", ruleInput: { plainCommandEligible: true } });
    expect(prohibitedStop).toMatchObject({ topicKey: "model_routing", polarity: "negative", ruleInput: { plainCommandEligible: true } });
    expect(differentModel?.bundleKey).not.toBe(forced?.bundleKey);
    expect(detect("Codex")).toEqual([]);
    expect(retractionEvent).not.toBeNull();
    expect(quotaEvent).not.toBeNull();
    if (!retractionEvent || !quotaEvent) throw new Error("synthetic model route events were not extracted");
    expect(detectOwnerCorrections(retractionEvent)).toEqual([]);
    expect(isModelRoutingRetraction(retractionEvent)).toBe(true);
    expect(isModelRoutingRetraction(quotaEvent)).toBe(false);
  });

  it("does not treat a replacement instruction or model-free wording as a routing retraction", () => {
    const createEvent = (prompt: string) => extractOwnerEvent({
      hookEventName: "UserPromptSubmit",
      prompt,
    });
    const replacementEvent = createEvent("Claudeじゃない、Codex使って");
    const genericEvent = createEvent("毎回説明はなしで");
    const retractionEvent = createEvent("Codexじゃなくていい");

    if (!replacementEvent || !genericEvent || !retractionEvent) {
      throw new Error("synthetic routing prompts were not extracted");
    }

    expect(isModelRoutingRetraction(replacementEvent)).toBe(false);
    expect(isModelRoutingRetraction(genericEvent)).toBe(false);
    expect(isModelRoutingRetraction(retractionEvent)).toBe(true);
    expect(getModelRoutingRetractionTargets(replacementEvent)).toEqual([]);
    expect(getModelRoutingRetractionTargets(retractionEvent)).toEqual(["Codex"]);
  });

  it("renders full-document corrections as typed rules without reprimand markers", () => {
    const generic = detect("全文出してって前も言ったよね、毎回全文出して")[0];
    const scopedNegative = detect("前も言ったよね、毎回、社外向け文書の全文を出さないで")[0];

    expect(generic).toMatchObject({
      topicKey: "document_delivery",
      polarity: "positive",
      status: "confirmed",
      ruleText: "文章は毎回全文を表示する",
    });
    expect(scopedNegative).toMatchObject({
      topicKey: "document_delivery",
      polarity: "negative",
      status: "confirmed",
      ruleText: "社外向け文書は毎回全文を表示しない",
    });
    expect(`${generic?.ruleText} ${scopedNegative?.ruleText}`).not.toMatch(/前も言ったよね|何回言わせる/u);
  });

  it("adds the prior-action match only for the same finite target", () => {
    const matching = detect("また回答が違うので、質問に答えてから止まって", {
      previousAssistantText: "質問への回答を続けます。",
    });
    const unrelated = detect("また回答が違うので、質問に答えてから止まって", {
      previousAssistantText: "フォントを調整します。",
    });

    expect(matching[0]?.score).toBe(9);
    expect(matching[0]?.status).toBe("confirmed");
    expect(unrelated[0]?.score).toBe(7);
    expect(unrelated[0]?.status).toBe("candidate");
  });

  it("does not read the additive また (another / or / also) as a repeated correction", () => {
    for (const text of [
      "要約のルール変更して、要約のプロンプト修正して、また一つなんかの法律対応して。",
      "要約は短くするか、または箇条書きにして",
      "また、要約のプロンプトも修正して",
      "たまたま要約が長くなったので、要約を100文字以内にして",
      "複数ファイルにまたがる要約を100文字以内にして",
      "また次の要約も100文字以内にして",
      "また他の要約も短くして",
    ]) {
      const candidates = detect(text);
      expect(candidates.every((candidate) => candidate.source !== "utterance_detection")).toBe(true);
      expect(candidates.every((candidate) => candidate.ruleInput.directive === false)).toBe(true);
    }
    for (const text of [
      "また要約が長いので、要約を100文字以内にして",
      "また、要約が長いので、要約を100文字以内にして",
      "また要約が長くなってるから、要約を100文字以内にして",
    ]) {
      expect(detect(text).some((candidate) => candidate.source === "utterance_detection")).toBe(true);
    }
  });

  it("keeps identical utterances as separate event evidence with their own available order", () => {
    const firstEvent = extractOwnerEvent({
      type: "user",
      origin: { kind: "human" },
      sessionId: "synthetic-session",
      uuid: "utterance-one",
      position: 3,
      order: 3,
      availableOrder: 3,
      availableAt: 300,
      message: { content: "質問に答えてください" },
    });
    const secondEvent = extractOwnerEvent({
      type: "user",
      origin: { kind: "human" },
      sessionId: "synthetic-session",
      uuid: "utterance-two",
      position: 5,
      order: 5,
      availableOrder: 5,
      availableAt: 500,
      message: { content: "質問に答えてください" },
    });
    const first = firstEvent ? detectOwnerCorrections(firstEvent)[0] : undefined;
    const second = secondEvent ? detectOwnerCorrections(secondEvent)[0] : undefined;

    expect(first).toMatchObject({ eventUuid: "utterance-one", sourcePosition: 3, eventOrder: 3, availableOrder: 3, availableAt: 300 });
    expect(second).toMatchObject({ eventUuid: "utterance-two", sourcePosition: 5, eventOrder: 5, availableOrder: 5, availableAt: 500 });
    expect(first?.bundleKey).toBe(second?.bundleKey);
  });

  it("confirms the narrow B9 tone exception only when the last assistant text used polite endings", () => {
    const polite = detect("なぜ敬語なの？", {
      previousAssistantText: "確認します。次に確認する。",
    });
    const plain = detect("なぜ敬語なの？", {
      previousAssistantText: "確認する。こちらを進める。",
    });

    expect(polite[0]).toMatchObject({
      score: 6,
      status: "confirmed",
      topicKey: "tone",
      ruleText: "オーナーへの応答は常体で書く",
    });
    expect(plain[0]).toMatchObject({ score: 4, status: "candidate", topicKey: "tone" });

    const noPunctuation = detect("なぜ敬語なの", {
      previousAssistantText: "確認します。",
    })[0];
    expect(noPunctuation).toMatchObject({
      status: "confirmed",
      ruleInput: { toneException: true, question: true },
    });
    if (!noPunctuation) throw new Error("synthetic tone exception was not detected");
    expect(parseCorrectionRuleInput(serializeCorrectionRuleInput(noPunctuation.ruleInput))).not.toBeNull();
  });

  it("keeps artifact and task-limited B9 questions out of the general response rule", () => {
    const artifact = detect("この文書がなぜ敬語なの？", {
      previousAssistantText: "確認します。",
    })[0];
    const task = detect("今回だけの返答がなぜ敬語なの？", {
      previousAssistantText: "確認します。",
    })[0];

    expect(artifact).toMatchObject({ status: "candidate", topicKey: "tone" });
    expect(artifact?.ruleText).toBe("");
    expect(task).toMatchObject({ status: "candidate", topicKey: "tone", lifetimeKind: "task" });
    expect(task?.conditionKey).toContain("task:今回だけ");
    expect(task?.ruleText).toBe("");
  });

  it("does not use polite wording inside tilde fences or quotations for B9", () => {
    const fenced = detect("なぜ敬語なの？", {
      previousAssistantText: "~~~text\n確認します。\n~~~",
    })[0];
    const quoted = detect("なぜ敬語なの？", {
      previousAssistantText: "「確認します。」",
    })[0];

    expect(fenced).toMatchObject({ score: 4, status: "candidate", topicKey: "tone" });
    expect(quoted).toMatchObject({ score: 4, status: "candidate", topicKey: "tone" });
  });

  it("keeps generic tone questions as candidates and rejects B9 carryover from another session", () => {
    const generic = detect("なぜ文体なの？", {
      previousAssistantText: "こちらを確認します。",
    });
    const otherSessionEvent = extractOwnerEvent({
      type: "user",
      origin: { kind: "human" },
      sessionId: "current-session",
      message: { content: "なぜ敬語なの？" },
    });
    const otherSession = otherSessionEvent
      ? detectOwnerCorrections(otherSessionEvent, {
        previousAssistantText: "こちらを確認します。",
        previousAssistantSessionId: "different-session",
      })
      : [];

    expect(generic[0]).toMatchObject({ score: 4, status: "candidate", topicKey: "tone" });
    expect(otherSession[0]).toMatchObject({ score: 4, status: "candidate", topicKey: "tone" });
  });

  it("keeps vague commands unconfirmed and permits explicit commands with unknown conditions", () => {
    const vagueAction = detect("今後、質問について独自の方法で対応して")[0];
    const unknownCondition = detect("今後、特定の場合だけ質問に答えて")[0];

    expect(vagueAction).toMatchObject({ status: "candidate", ruleText: "" });
    expect(unknownCondition).toMatchObject({
      status: "confirmed",
      conditionKnown: false,
      ruleText: "今後、特定の場合だけ質問に答えて",
    });
  });

  it("uses normalized command text when an explicit unknown-topic command has no typed rule", () => {
    const command = detect("以前にも言ったが、今後はＩＤ用の印を変更して")[0];
    const vagueCommand = detect("以前にも言ったが、今後は対応して")[0];

    expect(command).toMatchObject({
      topicKey: "unknown",
      status: "confirmed",
      ruleText: "今後はID用の印を変更して",
    });
    expect(vagueCommand).toMatchObject({ status: "candidate", ruleText: "" });
  });

  it("preserves every numeric bound in conditions and separates different limits", () => {
    const limit100 = detect("今後は要約を100文字以内にして")[0];
    const limit200 = detect("今後は要約を200文字以内にして")[0];
    const atMost = detect("今後は要約を100文字以下にして")[0];
    const lessThan = detect("今後は要約を100文字未満にして")[0];
    const multiple = detect("今後は要約を100文字以内かつ2件以下にして")[0];
    const both = detect("今後は要約を100文字以内にして。今後は要約を200文字以内にして");

    expect(limit100?.ruleInput.requiredValues.limit).toBe("100文字以内");
    expect(limit200?.ruleInput.requiredValues.limit).toBe("200文字以内");
    expect(limit100?.bundleKey).not.toBe(limit200?.bundleKey);
    expect(atMost?.bundleKey).not.toBe(lessThan?.bundleKey);
    expect(multiple?.ruleText).toBe("今後は要約を100文字以内かつ2件以下にして");
    expect(both).toHaveLength(2);
    expect(new Set(both.map((candidate) => candidate.bundleKey)).size).toBe(2);
  });

  it("同じ動作の条件細部は同束にし、案件境界とモデル期限は分ける", () => {
    const proposal = detect("文案作成時は今後、文案・報告の全文を表示して")[0];
    const report = detect("報告作成時は今後、文案・報告の全文を示して")[0];
    const projectA = detect("今後は合成Aプロジェクトの文案・報告の全文を表示して")[0];
    const projectB = detect("今後は合成Bプロジェクトの文案・報告の全文を表示して")[0];
    const ordinaryRoute = detect("実装はClaudeで担当する")[0];
    const temporaryRoute = detect("一時的な利用枠ではClaudeで実装して")[0];

    expect(proposal?.bundleKey).not.toBe(report?.bundleKey);
    expect(proposal?.ruleInput.conditions).toEqual([]);
    expect(report?.ruleInput.conditions).toEqual([]);
    expect(projectA?.bundleKey).toBe(projectB?.bundleKey);
    expect(ordinaryRoute?.lifetimeKind).toBe("routing");
    expect(temporaryRoute?.lifetimeKind).toBe("task");
  });

  it("質問・相談は規則文にせず、未解析条件つき命令は条件を残して候補にする", () => {
    const question = detect("今後は質問に答えるべきですか")[0];
    const consultation = detect("今後は質問に答えてよいか相談したい")[0];
    const missingCondition = detect("今後は特定の場合だけ質問に答えて")[0];

    for (const candidate of [question, consultation]) {
      expect(candidate?.status).toBe("candidate");
      expect(candidate?.ruleText).toBe("");
    }
    expect(missingCondition).toMatchObject({
      status: "confirmed",
      conditionKnown: false,
      ruleText: "今後は特定の場合だけ質問に答えて",
    });
    expect(question?.ruleText).not.toContain("答えるべきですか");
    expect(consultation?.ruleText).not.toContain("相談したい");
  });

  it("keeps explicit commands when their conditions are unresolved", () => {
    const numericAndUnknown = detect("今後は特定の場合だけ回答を100文字以内にして")[0];
    const deadlineAndUnknown = detect("今回だけは特別な条件の場合だけ質問に答えて")[0];

    expect(numericAndUnknown).toMatchObject({
      status: "candidate",
      conditionKnown: false,
      ruleText: "今後は特定の場合だけ回答を100文字以内にして",
    });
    expect(numericAndUnknown?.ruleInput.conditionKnown).toBe(false);
    expect(deadlineAndUnknown).toMatchObject({
      status: "candidate",
      conditionKnown: false,
      lifetimeKind: "task",
      ruleText: "",
    });
  });

  it("keeps newline conditions and instructions in one bounded candidate", () => {
    const taskLimited = detect("今回だけは\n今後は常体で答えて")[0];
    const unresolved = detect("特別な条件の場合だけ\n今後は常体で答えて")[0];
    const longCondition = `${"あ".repeat(294)}特定の場合だけ`;
    const longEvent = extractOwnerEvent({
      type: "user",
      origin: { kind: "human" },
      message: { content: `${longCondition}\n今後は常体で答えて` },
    });

    expect(taskLimited).toMatchObject({ status: "candidate", lifetimeKind: "task" });
    expect(taskLimited?.conditionKey).toContain("task:今回だけ");
    expect(taskLimited?.ruleText).toBe("");
    expect(unresolved).toMatchObject({ status: "confirmed", conditionKnown: false });
    expect(longEvent?.segments).toHaveLength(1);
    expect(longEvent ? detectOwnerCorrections(longEvent) : []).toEqual([]);
  });

  it("does not score target-only fragments, quoted instructions, or third-party requests", () => {
    expect(detect("全文の提示について" )).toEqual([]);
    expect(detect("『今後は常体で答えて』という例を確認して")).toEqual([]);
    expect(detect("開発者には毎回全文を示して")).toEqual([]);
    expect(detect("開発者が毎回全文を示す")).toEqual([]);
    expect(detect("否定例: 今後は常体で答えて")).toEqual([]);
  });

  it("keeps unknown topic instructions as separate candidates unless the normalized text is identical", () => {
    const first = detect("今後は橙色の印を付けて");
    const same = detect("今後は橙色の印を付けて");
    const paraphrase = detect("今後は橙色の印を付けてください");

    expect(first[0]).toMatchObject({ topicKey: "unknown", status: "confirmed" });
    expect(first[0]?.bundleKey).toBe(same[0]?.bundleKey);
    expect(first[0]?.bundleKey).not.toBe(paraphrase[0]?.bundleKey);
  });

  it("does not bundle model-name-only mentions or different assignments", () => {
    const implementationByCodex = detect("実装はCodexで担当する")[0];
    const designByCodex = detect("設計はCodexで担当する")[0];
    const implementationBySonnet = detect("実装はSonnetで担当する")[0];

    expect(detect("Codex")).toEqual([]);
    expect(implementationByCodex?.topicKey).toBe("model_routing");
    expect(implementationByCodex?.bundleKey).not.toBe(designByCodex?.bundleKey);
    expect(implementationByCodex?.bundleKey).not.toBe(implementationBySonnet?.bundleKey);
  });

  it("keeps a combined model route as one normalized untyped command", () => {
    const codexAssignments = detect("今後は合成プロジェクトのすべての作業について、Codexで設計して、Claudeで実装して");
    const claudeAssignments = detect("今後は合成プロジェクトのすべての作業について、Claudeで設計して、Claudeで実装して");
    const codexRoute = codexAssignments[0];
    const claudeRoute = claudeAssignments[0];
    const ownerDesign = detect("今後は実装をCodexで担当して、設計はオーナーが担当する")[0];

    expect(codexAssignments).toHaveLength(1);
    expect(codexRoute).toMatchObject({
      topicKey: "model_routing",
      conditionKnown: true,
      ruleInput: { plainCommandEligible: false, directive: true },
      ruleText: "今後は合成プロジェクトのすべての作業について、Codexで設計して、Claudeで実装して",
    });
    expect(claudeAssignments).toHaveLength(1);
    expect(claudeRoute?.ruleText).toBe("今後は合成プロジェクトのすべての作業について、Claudeで設計して、Claudeで実装して");
    expect(codexRoute?.bundleKey).not.toBe(claudeRoute?.bundleKey);
    expect(ownerDesign).toMatchObject({ topicKey: "model_routing", status: "candidate", conditionKnown: false });
  });

  it("keeps single prohibitions negative and as repeat candidates", () => {
    const candidate = detect("この用語を使うな")[0];

    expect(candidate).toMatchObject({ status: "candidate", polarity: "negative", source: "request_repeat" });
  });

  it("retains known and unknown negative document actions as negative candidates", () => {
    const known = detect("全文を出さないで")[0];
    const unknown = detect("全文を省いて")[0];
    const positive = detect("今後は全文を出して")[0];
    const continuingNegative = detect("今後は全文を出さないで")[0];

    expect(known).toMatchObject({ topicKey: "document_delivery", actionKey: "present_full", status: "candidate", polarity: "negative" });
    expect(known?.source).toBe("request_repeat");
    expect(unknown).toMatchObject({ topicKey: "document_delivery", status: "candidate", polarity: "negative", actionKnown: false });
    expect(positive?.bundleKey).not.toBe(continuingNegative?.bundleKey);
    expect(continuingNegative).toMatchObject({ topicKey: "document_delivery", actionKey: "present_full", polarity: "negative" });
  });

  it("does not convert the owner's plans into continuing AI instructions", () => {
    expect(detect("私は今後、文書の全文を出す予定です")).toEqual([]);
    expect(detect("今後、私は文書の全文を出すつもりです")).toEqual([]);
    expect(detect("今後は文書の全文を出す予定です")).toEqual([]);
    expect(detect("私は今後、文書の全文を出す")).toEqual([]);
    expect(detect("今後は文書の全文を出す")[0]).toMatchObject({ status: "candidate" });
    expect(detect("今後は文書の全文を出して")[0]).toMatchObject({
      status: "confirmed",
      ruleText: "文書は毎回全文を表示する",
      lifetimeKind: "explicit_continuing",
    });
    expect(detect("今後は予定表を確認して")[0]).toMatchObject({
      status: "confirmed",
      ruleText: "今後は予定表を確認して",
      topicKey: "verification",
    });
  });

  it("returns at most three distinct bundles per utterance", () => {
    const candidates = detect("今後は常体で答えて。毎回、全文を提示して。常に要約の字数を100字以内にして。次から保存先を一時領域に指定して。");

    expect(candidates.length).toBeLessThanOrEqual(3);
    expect(new Set(candidates.map((candidate) => candidate.bundleKey)).size).toBe(candidates.length);
  });

  it("never confirms sensitive commands and permits explicit commands with unresolved conditions", () => {
    const sensitive = detect("今後はtoken=synthetic-secret-value-1234567890を使って回答して");
    const missingCondition = detect("今後は特定の場合だけ質問に答えて");

    expect(sensitive.every((candidate) => candidate.status !== "confirmed")).toBe(true);
    expect(sensitive[0]?.ruleText).not.toContain("synthetic-secret-value");
    expect(missingCondition[0]).toMatchObject({ status: "confirmed", conditionKnown: false });
  });

  it("keeps shared-sanitizer secret matches candidate-only through detection", () => {
    const googleKey = `AIza${"Q".repeat(35)}`;
    const jwt = `eyJ${"A".repeat(12)}.eyJ${"B".repeat(12)}.${"C".repeat(12)}`;
    const unicodeHomePath = ["", "Users", "合成利用者", "private.txt"].join("/");

    for (const value of [googleKey, jwt, unicodeHomePath]) {
      const candidates = detect(`今後は ${value} を使って回答して`);

      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates.every((candidate) => candidate.status !== "confirmed")).toBe(true);
      expect(candidates.every((candidate) => !candidate.ruleText.includes(value))).toBe(true);
    }
  });

  it("does not confirm a long paste candidate", () => {
    const candidates = detect(`今後は常体で答えて ${"合成文 ".repeat(700)}`);

    expect(candidates.every((candidate) => candidate.status !== "confirmed")).toBe(true);
  });

  it("does not split a bundle when an optional だけ condition word is present", () => {
    const pairs = [
      ["今後は質問に答えてから止まって", "今後は質問だけに答えてから止まって"],
      ["今後は常体で答えて", "今後は常体だけで答えて"],
      ["今後は文案・報告の全文を表示して", "今後は文案・報告の全文だけを表示して"],
      ["今後は略語を説明して", "今後は略語だけを説明して"],
      ["今後は要約を100文字以内にして", "今後は要約だけを100文字以内にして"],
      ["今後はCSS部品を維持して", "今後はCSS部品だけを維持して"],
      ["今後は仕様書を原本と照合して", "今後は仕様書だけを原本と照合して"],
      ["今後は成果物をリポジトリ直下に保存して", "今後は成果物だけをリポジトリ直下に保存して"],
    ] as const;

    for (const [unlimitedText, limitedText] of pairs) {
      const unlimited = detect(unlimitedText)[0];
      const limited = detect(limitedText)[0];

      expect(unlimited).toBeDefined();
      expect(limited).toBeDefined();
      expect(limited?.conditionKnown).toBe(true);
      expect(limited?.conditionKey).toBe(unlimited?.conditionKey);
      expect(unlimited?.bundleKey, `${unlimitedText} <> ${limitedText}`).toBe(limited?.bundleKey);
    }
  });

  it("normalizes のみ and ばかり as limiters and keeps しか〜ない as negative emphasis", () => {
    const base = detect("今後は文案・報告の全文を表示して")[0];

    for (const limiter of ["のみ", "ばかり"]) {
      const limited = detect(`今後は文案・報告の全文${limiter}を表示して`)[0];

      expect(limited?.conditionKey).toBe(base?.conditionKey);
      expect(limited?.bundleKey).toBe(base?.bundleKey);
    }

    const negativeEmphasis = detect("今後は文案・報告の全文しか表示しない")[0];

    expect(negativeEmphasis).toMatchObject({ polarity: "negative", conditionKnown: true });
    expect(negativeEmphasis?.conditionKey).toContain("modifier:shika-negative");
    expect(negativeEmphasis?.bundleKey).not.toBe(base?.bundleKey);
  });

  it("keeps unclear reactions as candidates and excludes ordinary definition questions", () => {
    const reactionContext = {
      previousAssistantText: "合成方式Aは、対象を二段階で処理します。",
      previousAssistantSessionId: "synthetic-session",
    };
    const reactions = [
      "それって何?",
      "これってなに？",
      "ってなに",
      "いみがわからん",
      "意味わからん",
      "意味不明",
    ].map((text) => detect(text, reactionContext)[0]);
    const questionContext = {
      previousAssistantText: "合成方式Aについて、どの点を知りたいですか？",
      previousAssistantSessionId: "synthetic-session",
    };
    const ordinaryQuestions = [
      "合成方式って何?",
      "合成方式ってなに？",
      "APIって何?",
      "OAuthってなに？",
      "その用語って何?",
      "プロジェクトってなに？",
    ].map((text) => detect(text, questionContext));
    const pendingSubmissionReaction = detect("意味わからん")[0];
    const otherSessionReaction = detect("意味わからん", {
      previousAssistantText: "合成方式Aは、対象を二段階で処理します。",
      previousAssistantSessionId: "different-session",
    })[0];
    const unclearContext = detect("棚って何だ? 何のことだ? わかりづらい。")[0];
    const longUnclearQuestion = detect(`${"合成語".repeat(20)}意味不明？`)[0];
    const unclearDescription = detect("この説明は意味不明です。", reactionContext)[0];

    expect(reactions).toHaveLength(6);
    for (const candidate of reactions) {
      expect(candidate).toMatchObject({
        status: "candidate",
        source: "utterance_detection",
        ruleText: "",
        ruleInput: { directive: false, plainCommandEligible: false },
      });
    }
    expect(ordinaryQuestions).toEqual([[], [], [], [], [], []]);
    expect(pendingSubmissionReaction).toMatchObject({ status: "candidate", source: "utterance_detection", ruleText: "" });
    expect(otherSessionReaction).toBeUndefined();
    expect(unclearContext).toMatchObject({ status: "candidate", source: "utterance_detection", ruleText: "" });
    expect(longUnclearQuestion).toBeUndefined();
    expect(unclearDescription).toBeUndefined();
  });
});
