export type CorrectionRuleTopic =
  | "tone"
  | "response_policy"
  | "document_delivery"
  | "expression_policy"
  | "summary_constraints"
  | "design_components"
  | "verification"
  | "delegation_roles"
  | "storage_location"
  | "model_routing"
  | "unknown";

export type CorrectionRuleLifetime = "explicit_continuing" | "inferred" | "task" | "routing";

export type CorrectionRuleInput = {
  version: 2;
  topicKey: CorrectionRuleTopic;
  actionKey: string;
  polarity: "positive" | "negative";
  requiredValues: Record<string, string>;
  conditions: string[];
  boundaryKey: string;
  lifetimeKind: CorrectionRuleLifetime;
  continuationBasis: string;
  directive: boolean;
  question: boolean;
  toneException: boolean;
  conditionKnown: boolean;
  commandText?: string;
};

const TOPICS = new Set<CorrectionRuleTopic>([
  "tone",
  "response_policy",
  "document_delivery",
  "expression_policy",
  "summary_constraints",
  "design_components",
  "verification",
  "delegation_roles",
  "storage_location",
  "model_routing",
  "unknown",
]);

const LIFETIMES = new Set<CorrectionRuleLifetime>([
  "explicit_continuing",
  "inferred",
  "task",
  "routing",
]);

const VALUE_KEYS = new Set([
  "audience",
  "style",
  "subject",
  "documentKind",
  "range",
  "term",
  "sourceExpression",
  "targetExpression",
  "limit",
  "component",
  "targetValue",
  "source",
  "evidence",
  "workType",
  "assignee",
  "artifactType",
  "destination",
  "duration",
  "model",
]);

const CONDITION_SUFFIX = /(?:時|場合|とき)$/u;
const FORBIDDEN_VALUE = /[\u0000-\u001f\u007f]/u;
const CONSULTATION_QUESTION = /(?:べきか|でしょうか|ですか|相談|どう思う|したい|してよいか|していいか)/u;
const SUMMARY_ACTION = /(?:要約|要点|概要)[^、。！？!?]{0,12}(?:しないで|しない|するな|しなくて|して|する)/u;
const FULL_DOCUMENT_ACTION = /(?:全文|本文|全体)[^、。！？!?]{0,12}(?:出(?:して|す|さないで|さない|すな)|示(?:して|す|さないで|さない|すな)|提示(?:して|する|しないで)|表示(?:して|する|しないで)|見せ(?:て|る|ない))/u;
const PAST_CORRECTION_REFERENCE = /(?:前回|前(?:にも|も|に)|以前(?:にも|も|に))[^、。！？!?]{0,10}(?:言った|言いました|言っていた|伝えた|伝えました|指示した|指示しました)(?:よね|でしょう|けれど|けど|が|のに|んだ)?/gu;
const REPRIMAND_MARKER = /(?:もう)?(?:何回|何度)(?:も)?(?:言わせる|言わす|言ったら|言った|伝えさせる)(?:(?:んだ|の)?(?:よね|よ|でしょう|かな)?)/gu;
const REPEAT_ADVERB = /(?:再度|再び|繰り返し)/gu;
const ALSO_CUE = /(^|[、,\s])また(?=$|[、,\s]|[\p{Script=Han}\p{Script=Katakana}])/gu;
const CORRECTIVE_COMMAND_PREDICATE = /(?:するな|やめ(?:て|ろ)|しないで|答え(?:て|ろ)(?:ください)?|示(?:して|せ)(?:ください)?|出(?:して|せ)(?:ください)?|止(?:めて|まれ)(?:ください)?|確認(?:して|しろ)(?:ください)?|使(?:って|え|うな?)(?:ください)?|維持(?:して|しろ)(?:ください)?|変更(?:して|しろ)(?:ください)?|説明(?:して|しろ)(?:ください)?|省(?:いて|け)|除外(?:して|しろ)|照合(?:して|しろ)(?:ください)?|提示(?:して|しろ)(?:ください)?|表示(?:して|しろ)(?:ください)?|見せ(?:て|ないで|るな)(?:ください)?|(?:出|示|提示|表示|使|説明|省)(?:さないで|しないで|わないで|さない|しない)|(?:文字|字|件|行|項目)(?:以内|以下|未満|程度)?[^、。！？!?]{0,8}にして|まとめて|短くして|制限して|解除して|避けて|控えて|再利用して|保存して|配置して|保持して|保管して|担当して|任せて|委譲して|割り当てて|実行して|設計(?:して|する)|実装(?:して|する)|検証(?:して|する)|分析(?:して|する)|レビュー(?:して|する)|テスト(?:して|する)|付けて|書いて|作成して|変えて|禁止)/u;

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function removeCorrectionMarkers(value: string): string {
  const normalized = normalizeText(value.normalize("NFKC")
    .replace(PAST_CORRECTION_REFERENCE, " ")
    .replace(REPRIMAND_MARKER, " ")
    .replace(REPEAT_ADVERB, " ")
    .replace(ALSO_CUE, "$1 ")
    .replace(/って(?=[、,])/gu, ""));
  return normalized.replace(/^[、,]+|[、,]+$/gu, "").trim();
}

export function hasCorrectionPredicate(value: string): boolean {
  return CORRECTIVE_COMMAND_PREDICATE.test(value);
}

export function isConsultationQuestion(value: string): boolean {
  return CONSULTATION_QUESTION.test(value);
}

export function hasUnrepresentedRuleMeaning(input: CorrectionRuleInput): boolean {
  const commandText = input.commandText ?? "";
  if (!commandText) return false;
  if (input.topicKey === "document_delivery" && input.actionKey === "present_full") {
    if (SUMMARY_ACTION.test(commandText) && FULL_DOCUMENT_ACTION.test(commandText)) return true;
    const modifier = commandText.match(/(?:社外|社内|ユーザー|オーナー|外部|内部)向け/u)?.[0];
    if (modifier && !input.requiredValues.documentKind?.includes(modifier)) return true;
  }
  if (input.topicKey === "tone") {
    const style = input.actionKey === "use_casual" ? "常体"
      : input.actionKey === "use_polite" ? "(?:敬語|敬体|ですます)" : "";
    if (!style) return false;
    const negative = new RegExp(`${style}.{0,8}(?:ではなく|でなく|(?:を|は)?(?:使わない|使うな|使わず|書かない|答えない|話さない|維持しない|やめ(?:て|ろ)|禁止))`, "u").test(commandText);
    const positive = new RegExp(`${style}.{0,8}(?:で(?:書|答|話)|を(?:使|維持)|に(?:する|変える))`, "u").test(commandText);
    if ((input.polarity === "negative" && positive) || (input.polarity === "positive" && negative)) return true;
  }
  return false;
}

function questionGuardApplies(input: CorrectionRuleInput): boolean {
  if (input.toneException) return false;
  return (input.question && !input.directive) || isConsultationQuestion(input.commandText ?? "");
}

function orderedValues(values: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of Object.keys(values).sort()) {
    result[key] = normalizeText(values[key]);
  }
  return result;
}

function canonicalInput(input: CorrectionRuleInput): CorrectionRuleInput {
  return {
    version: 2,
    topicKey: input.topicKey,
    actionKey: input.actionKey,
    polarity: input.polarity,
    requiredValues: orderedValues(input.requiredValues),
    conditions: Array.from(new Set(input.conditions.map(normalizeText))).sort(),
    boundaryKey: normalizeText(input.boundaryKey),
    lifetimeKind: input.lifetimeKind,
    continuationBasis: normalizeText(input.continuationBasis),
    directive: input.directive,
    question: input.question,
    toneException: input.toneException,
    conditionKnown: input.conditionKnown,
    ...(input.commandText !== undefined ? { commandText: normalizeText(input.commandText) } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeValue(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Array.from(value).length <= 160
    && !FORBIDDEN_VALUE.test(value) && normalizeText(value) === value;
}

function validInput(input: CorrectionRuleInput): boolean {
  if (input.version !== 2 || !TOPICS.has(input.topicKey) || !LIFETIMES.has(input.lifetimeKind)) return false;
  if (!input.actionKey || Array.from(input.actionKey).length > 80 || !input.boundaryKey) return false;
  if (input.polarity !== "positive" && input.polarity !== "negative") return false;
  if (typeof input.continuationBasis !== "string" || !input.continuationBasis) return false;
  if (typeof input.directive !== "boolean" || typeof input.question !== "boolean"
    || typeof input.toneException !== "boolean" || typeof input.conditionKnown !== "boolean") return false;
  if (input.commandText !== undefined && (typeof input.commandText !== "string"
    || Array.from(input.commandText).length > 240 || normalizeText(input.commandText) !== input.commandText)) return false;
  if (!isRecord(input.requiredValues) || Object.keys(input.requiredValues).some((key) => !VALUE_KEYS.has(key))) return false;
  if (Object.values(input.requiredValues).some((value) => !isSafeValue(value))) return false;
  if (!Array.isArray(input.conditions) || input.conditions.some((value) => {
    return !isSafeValue(value) || Array.from(value).length > 40 || !CONDITION_SUFFIX.test(value);
  })) return false;
  if (input.toneException && (input.topicKey !== "tone" || input.actionKey !== "use_casual" || !input.question)) return false;
  return true;
}

function hasValues(input: CorrectionRuleInput, keys: string[]): boolean {
  return keys.every((key) => typeof input.requiredValues[key] === "string" && input.requiredValues[key].length > 0);
}

function topicRule(input: CorrectionRuleInput): string {
  const values = input.requiredValues;
  if (input.topicKey === "tone") {
    if (input.actionKey !== "use_casual" && input.actionKey !== "use_polite") return "";
    if (!hasValues(input, ["style"])) return "";
    const audience = values.audience === "owner" ? "オーナーへの応答は" : "応答は";
    const stylePhrase = input.polarity === "negative" ? `${values.style}では書かない` : `${values.style}で書く`;
    return `${audience}${input.lifetimeKind === "explicit_continuing" ? "毎回" : ""}${stylePhrase}`;
  }

  if (input.topicKey === "response_policy") {
    if (!hasValues(input, ["subject"])) return "";
    if (input.actionKey === "answer") {
      return input.polarity === "negative" ? `${values.subject}には回答しない` : `${values.subject}に回答する`;
    }
    if (input.actionKey === "answer_then_stop" && input.polarity === "positive") {
      return `${values.subject}に回答してから停止する`;
    }
    if (input.actionKey === "wait" && input.polarity === "positive") return "指示まで待機する";
    if (input.actionKey === "stop" && input.polarity === "positive") return "回答後に停止する";
    return "";
  }

  if (input.topicKey === "document_delivery") {
    if (!hasValues(input, ["documentKind"])) return "";
    const continuation = input.lifetimeKind === "explicit_continuing" ? "毎回" : "";
    if (input.actionKey === "present_full") {
      const verb = input.polarity === "negative" ? "全文を表示しない" : "全文を表示する";
      return `${values.documentKind}は${continuation}${verb}`;
    }
    if (input.actionKey === "present" && hasValues(input, ["range"])) {
      const verb = input.polarity === "negative" ? "を表示しない" : "を表示する";
      return `${values.documentKind}は${continuation}${values.range}${verb}`;
    }
    return "";
  }

  if (input.topicKey === "expression_policy") {
    if (input.actionKey === "explain_terms" && hasValues(input, ["term"]) && input.polarity === "positive") {
      return `${values.term}を説明する`;
    }
    if (input.actionKey === "replace_terms" && hasValues(input, ["sourceExpression", "targetExpression"]) && input.polarity === "positive") {
      return `${values.sourceExpression}を${values.targetExpression}に置き換える`;
    }
    if (input.actionKey === "use_terms" && hasValues(input, ["term"])) {
      const verb = input.polarity === "negative" ? "使わない" : "使う";
      return `${values.term}を${verb}`;
    }
    return "";
  }

  if (input.topicKey === "summary_constraints") {
    if (!hasValues(input, ["subject"])) return "";
    if (input.actionKey === "limit_summary_length" && hasValues(input, ["limit"]) && input.polarity === "positive") {
      return `${values.subject}を${values.limit}にまとめる`;
    }
    if (input.actionKey === "release_summary_limit" && input.polarity === "positive") {
      return `${values.subject}の字数制限を解除する`;
    }
    return "";
  }

  if (input.topicKey === "design_components") {
    if (!hasValues(input, ["component"])) return "";
    if (input.actionKey === "preserve_design" && input.polarity === "positive") return `${values.component}を維持する`;
    if (input.actionKey === "reuse_design" && input.polarity === "positive") return `${values.component}を再利用する`;
    if (input.actionKey === "change_design" && hasValues(input, ["targetValue"])) {
      const verb = input.polarity === "negative" ? "変更しない" : `を${values.targetValue}に変更する`;
      if (input.polarity === "negative") return `${values.component}を変更しない`;
      return `${values.component}${verb}`;
    }
    return "";
  }

  if (input.topicKey === "verification") {
    if (input.actionKey === "compare_source" && hasValues(input, ["subject", "source"]) && input.polarity === "positive") {
      return `${values.subject}を${values.source}と照合する`;
    }
    if (input.actionKey === "show_evidence" && hasValues(input, ["subject", "evidence"]) && input.polarity === "positive") {
      return `${values.subject}の検証根拠を提示する`;
    }
    return "";
  }

  if (input.topicKey === "delegation_roles") {
    if (input.actionKey !== "assign_roles" || !hasValues(input, ["workType", "assignee"])) return "";
    const verb = input.polarity === "negative" ? "に任せない" : "に任せる";
    return `${values.workType}は${values.assignee}${verb}`;
  }

  if (input.topicKey === "storage_location") {
    if (input.actionKey === "set_storage_location" && hasValues(input, ["artifactType", "destination"])) {
      const verb = input.polarity === "negative" ? "へ保存しない" : "へ保存する";
      return `${values.artifactType}を${values.destination}${verb}`;
    }
    if (input.actionKey === "retain_artifact" && hasValues(input, ["artifactType", "duration"]) && input.polarity === "positive") {
      return `${values.artifactType}を${values.duration}保持する`;
    }
    return "";
  }

  if (input.topicKey === "model_routing") {
    if (input.actionKey !== "route_task" || !hasValues(input, ["workType", "model"])) return "";
    const verb = input.polarity === "negative" ? "使わない" : "使う";
    const workTypes: Record<string, string> = {
      design: "設計",
      implementation: "実装",
      verification: "検証",
      analysis: "分析",
      review: "レビュー",
      testing: "テスト",
      documentation: "文書作成",
      coding: "コード作成",
      work: "作業",
    };
    const workType = workTypes[values.workType];
    if (!workType) return "";
    return `${workType}には${values.model}を${verb}`;
  }

  return "";
}

export function renderTypedCorrectionRule(input: CorrectionRuleInput): string {
  const canonical = canonicalInput(input);
  if (!validInput(canonical) || !canonical.conditionKnown || canonical.topicKey === "unknown") return "";
  if (!canonical.directive && !canonical.toneException) return "";
  if (questionGuardApplies(canonical) || hasUnrepresentedRuleMeaning(canonical)) return "";
  const statement = topicRule(canonical);
  if (!statement) return "";
  const taskScope = canonical.boundaryKey.match(/(?:^|;)task:(今回だけ|この作業だけ|今日だけ|一時的)(?:;|$)/u)?.[1];
  const continued = canonical.lifetimeKind === "explicit_continuing"
    && canonical.topicKey !== "tone" && canonical.topicKey !== "document_delivery";
  const body = continued ? `毎回、${statement}` : statement;
  let result = body;
  if (canonical.conditions.length > 0) result = `${canonical.conditions.join("または")}は${body}`;
  if (taskScope) result = `${taskScope}、${result}`;
  if (Array.from(result).length > 240) return "";
  return result;
}

export function renderCorrectionRule(input: CorrectionRuleInput): string {
  const typedRule = renderTypedCorrectionRule(input);
  if (typedRule) return typedRule;
  const canonical = canonicalInput(input);
  if (!validInput(canonical) || (!canonical.directive && !canonical.toneException) || !canonical.commandText) return "";
  if (questionGuardApplies(canonical) || hasUnrepresentedRuleMeaning(canonical)) return "";
  const cleanedCommand = removeCorrectionMarkers(canonical.commandText);
  if (!hasCorrectionPredicate(cleanedCommand)) return "";
  return cleanedCommand;
}

export function serializeCorrectionRuleInput(input: CorrectionRuleInput): string {
  return JSON.stringify(canonicalInput(input));
}

export function correctionRequiredValuesKey(input: CorrectionRuleInput): string {
  return JSON.stringify(orderedValues(input.requiredValues));
}

export function correctionConditionKey(input: CorrectionRuleInput): string {
  return normalizeText(input.boundaryKey);
}

export function parseCorrectionRuleInput(value: string): CorrectionRuleInput | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const input = parsed as unknown as CorrectionRuleInput;
  if (!validInput(input)) return null;
  return canonicalInput(input);
}

function mergeIdentity(input: CorrectionRuleInput): string {
  return JSON.stringify({
    version: input.version,
    topicKey: input.topicKey,
    actionKey: input.actionKey,
    polarity: input.polarity,
    requiredValues: orderedValues(input.requiredValues),
    boundaryKey: input.boundaryKey,
    lifetimeKind: input.lifetimeKind,
    directive: input.directive,
    question: input.question,
    toneException: input.toneException,
    conditionKnown: input.conditionKnown,
  });
}

export function mergeCorrectionRuleInputs(inputs: CorrectionRuleInput[]): CorrectionRuleInput | null {
  if (inputs.length === 0) return null;
  const canonicalInputs = inputs.map(canonicalInput);
  if (canonicalInputs.some((input) => !validInput(input))) return null;
  const identity = mergeIdentity(canonicalInputs[0]);
  if (canonicalInputs.some((input) => mergeIdentity(input) !== identity)) return null;
  const first = canonicalInputs[0];
  const continuationBases = Array.from(new Set(canonicalInputs.map((input) => input.continuationBasis))).sort();
  const conditions = canonicalInputs.some((input) => input.conditions.length === 0)
    ? []
    : Array.from(new Set(canonicalInputs.flatMap((input) => input.conditions))).sort();
  return {
    ...first,
    conditions,
    continuationBasis: continuationBases.join("+"),
  };
}
