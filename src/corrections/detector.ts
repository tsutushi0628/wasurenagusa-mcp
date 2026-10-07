import { createHash } from "node:crypto";
import {
  createBundleKey,
  haveSameBundleKey,
  removeOptionalLimiterWords,
  type CorrectionBundleDescriptor,
} from "./bundle-key.js";
import { removeQuotedAndInjectedContent, type OwnerEvent } from "./events.js";
import {
  correctionConditionKey,
  correctionRequiredValuesKey,
  hasCorrectionPredicate,
  hasUnrepresentedRuleMeaning,
  hasGenericNegativeCommand,
  isAttributiveExpressionModifier,
  isConsultationQuestion,
  matchExpressionTarget,
  renderCorrectionRule,
  renderTypedCorrectionRule,
  type CorrectionRuleInput,
} from "./rule-template.js";

export type CorrectionCandidate = CorrectionBundleDescriptor & {
  score: number;
  status: "candidate" | "confirmed";
  source: "utterance_detection" | "request_repeat";
  ruleText: string;
  ruleInput: CorrectionRuleInput;
  actionKnown: boolean;
  lifetimeKind: "explicit_continuing" | "inferred" | "task" | "routing";
  sourceType: OwnerEvent["sourceType"];
  sessionId?: string;
  eventUuid?: string;
  sourcePosition?: string | number;
  eventOrder?: number;
  availableOrder?: number;
  availableAt?: string | number;
  transcriptByteOffset?: number;
};

const rawBundleTexts = new WeakMap<object, string>();

export type DetectionContext = {
  previousAssistantText?: string;
  previousAssistantToolName?: string;
  previousAssistantSessionId?: string;
};

type TopicMatch = {
  topicKey: string;
  targetKey: string;
  actionKey: string;
  actionKnown: boolean;
};

const REPEAT_CUE = /(?:再度|再び|繰り返し|前にも|以前にも|前回|(?:前|以前)(?:にも|も|に).{0,12}(?:言|伝|指示)|だから)/u;
// 「また」は「もう一つ」「または」の意味でも使うので、語の頭にあり、後ろに今起きている状態・過去の述語が続くときだけ反復とみなす
const REPEAT_MATA = /(?:^|[^\p{Script=Hiragana}])また(?![はいねがぐげご])[^。！？!?]{0,24}?(?:い|た|だ|てる|ている|てた|ていた|ない|違う)(?:ので|から|じゃん|よ|ぞ|ね|って|[。、,！!？?\s]|$)/u;
const PAST_ACTION = /(?:した|していた|している|なった|使った|出した|変えた|保存した|言った|伝えた)/u;
const MISMATCH = /(?:違う|誤り|無視|守っていない)/u;
const TECHNICAL_CAUSE = /(?:原因|エラー|障害|例外|バグ|不具合|失敗)/iu;
const CONTINUING = /(?:今後|毎回|常に|次から)/u;
const DEADLINE = /(?:今回だけ|この作業だけ|今日だけ|一時的)/u;
const UNKNOWN_CONDITION = /(?:場合|とき|時|なら|以外|に限り|限り|条件|だけ|のみ|しか|ばかり|ただし|除く|除外)/u;
const KNOWN_NUMERIC_CONDITION = /\d+\s*(?:字|文字|件|回|分|時間|日|%|％)\s*(?:以内|以下|以上|未満|まで)/u;
const NUMERIC_CONDITIONS = /\d+\s*(?:字|文字|件|回|分|時間|日|%|％)\s*(?:以内|以下|以上|未満|まで)/gu;
const KNOWN_CONDITION_SCOPE = /(?:今回だけ|この作業だけ|今日だけ|一時的)/gu;
const NEGATIVE_SHIKA_EMPHASIS = /しか[^。！？!?]{0,40}?(?:なかった|ませんでした|ません|ない|ぬ|ず)/u;
const THIRD_PARTY = /(?:開発者|同僚|第三者|別の人|他の人|ほかの人|利用者|ユーザー|相手)(?:に(?:は|も)?|が|は)/u;
const EXAMPLE_CONTEXT = /(?:否定例|技術サンプル|コード例|禁止形)/u;
const BROAD_ACTION = /(?:答え|回答して|返事して|待(?:つ|って)|止(?:まる|め|めて)|再開|出(?:す|して|せ)|示(?:す|して|せ)|表示して|見せ|使(?:う|って|え)|説明して|置換して|言い換|避け|控え|制限して|解除して|まとめて|短くして|維持して|再利用して|変更して|変えて|確認して|検証して|照合して|保存して|配置して|保持して|保管して|担当して|任せて|委譲して|割り当て|回す|実行|付(?:け|けて)|書(?:く|いて)|作成して|対応して)/u;
const GENERAL_VERB = /(?:して|ください|する|しろ|せよ|します|にする|として扱|維持|変更|指定|選ん|選択|使っ|使う|出す|出して|話す|答える|保存|配置|担当)/u;
const MODEL_NAME = /(?:Codex|Claude|Sonnet|Opus|GPT(?:[- ]?\d(?:\.\d)?)?|Gemini|モデル)/giu;
const MODEL_ROUTE_ACTION = /(?:使(?:わない|うな|って|う|い|え|わず)|使用(?:して|する|しないで)|利用(?:して|する|しないで)|やめ(?:て|ろ)|担当(?:して|する)|割り当て|回(?:して|す)|実行(?:して|する)|経路を(?:選|使|通)|設計(?:して|する)|実装(?:して|する)|分析(?:して|する)|レビュー(?:して|する)|テスト(?:して|する))/u;
const ROUTE_MODEL_SOURCE = String.raw`(?:Claude(?:\s+Sonnet)?|Codex|Sonnet|Opus|GPT(?:[- ]?\d(?:\.\d)?)?|Gemini)`;
const MODEL_ROUTE_RETRACTION_MODEL = new RegExp(
  `(${ROUTE_MODEL_SOURCE})(?:\\s*(?:は|を))?\\s*(?:じゃなくて(?:いい|もいい)?|ではなくて(?:いい|もいい)?|じゃない|ではない|(?:もう)?使わないで|(?:もう)?使わない|使うな|やめて|なし)(?=$|[、,。.!！?？\\s]|で(?:も|いい)|なら)`,
  "giu",
);
const MODEL_ROUTE_POSITIVE_INSTRUCTION = new RegExp(
  `${ROUTE_MODEL_SOURCE}\\s*(?:を\\s*)?(?:使って|使え|使う|使用して|使用する|利用して|利用する|で(?!は|ない|なく)|にして|にする|を選んで|に割り当てて|に任せて)`,
  "iu",
);
const MODEL_ROUTE_AVAILABILITY_REPORT = /(?:枠|利用上限|レート制限|残量).{0,8}(?:切れ|なし|不足|尽き|到達)|(?:復旧|回復|上限到達|枠切れ)|(?:切れ|不足|尽き|使い切).{0,8}(?:枠|利用上限)/u;
const ROUTE_TASK_SOURCE = String.raw`(?:文書作成|設計|実装|検証|分析|レビュー|テスト|文書|コード|作業|documentation|design|implementation|verification|analysis|review|testing|coding|work)`;
const MODEL_FIRST_ASSIGNMENT = new RegExp(`(${ROUTE_MODEL_SOURCE})\\s*(?:で|を使って|を利用して)\\s*(${ROUTE_TASK_SOURCE})`, "giu");
const TASK_FIRST_ASSIGNMENT = new RegExp(`(${ROUTE_TASK_SOURCE})(?:は|を)?\\s*(${ROUTE_MODEL_SOURCE})\\s*(?:で|に)\\s*(?:担当|実施|実行|処理|任せ)(?:して|する|る)?`, "giu");
const ROUTE_TASKS = [
  { key: "design", pattern: /設計|design/giu },
  { key: "implementation", pattern: /実装|implementation/giu },
  { key: "verification", pattern: /検証|verification/giu },
  { key: "analysis", pattern: /分析|analysis/giu },
  { key: "review", pattern: /レビュー|review/giu },
  { key: "testing", pattern: /テスト|testing/giu },
  { key: "documentation", pattern: /文書|文書作成|documentation/giu },
  { key: "coding", pattern: /コード|coding/giu },
  { key: "work", pattern: /作業|work/giu },
];
const NEGATIVE_ACTION = /(?:ないで|しない|さない|わない|するな|(?:使|出|示|提示|表示|見せ)(?:うな|すな)|やめ|禁止|避け|省(?:く|いて|か)|除外)/u;
const NON_DIRECTIVE_STATEMENT = /(?:予定|つもり|計画)(?:です|だ|である|している|しています)?[。！？!?]*$/u;
const SELF_ACTION_SUBJECT = /(?:私は|私が|自分は|自分が)/u;
const EXPLICIT_COMMAND_ENDING = /(?:て|で|ください|下さい|しろ|せよ|なさい|するな|しないで|ないで|やめ(?:て|ろ)|(?:使|出|示|提示|表示|見せ)(?:うな|すな)|使う|答えろ|出せ|示せ|止まれ|使え|こと)(?:[。！？!?])?$/u;
const R3_PATTERN = /(?:変な|きしょい|キモい|気色悪い|おまえが定義した|俺のわからない|わからない)(?:言葉|日本語|表現|呼称)|って(?:何|なに)\?|ってなに|いみ(?:が)?わからん|意味(?:が)?わからん|意味不明|主語を(?:はぶくな|つけ)/u;

type RouteAssignment = { key: string; model: string };
type ExpressionTarget = { term?: string; modifierUnparsed: boolean };

function hasNegativeAction(sentence: string): boolean {
  return NEGATIVE_ACTION.test(sentence) || hasGenericNegativeCommand(sentence);
}

function hasExplicitCommandEnding(sentence: string): boolean {
  return EXPLICIT_COMMAND_ENDING.test(sentence) || hasGenericNegativeCommand(sentence);
}

function routeAssignments(sentence: string): RouteAssignment[] | null {
  const tasks = ROUTE_TASKS.flatMap(({ key, pattern }) => {
    pattern.lastIndex = 0;
    return Array.from(sentence.matchAll(pattern), (match) => ({ key, index: match.index ?? 0, length: match[0].length }));
  }).filter((task) => {
    const rest = sentence.slice(task.index + task.length);
    return task.key !== "work" || !/^\s*について/u.test(rest);
  });
  const matches: Array<{ key: string; model: string; start: number; end: number }> = [];
  for (const match of sentence.matchAll(MODEL_FIRST_ASSIGNMENT)) {
    const model = match[1];
    const task = match[2];
    const start = match.index ?? 0;
    const taskIndex = start + match[0].indexOf(task);
    const key = routeTaskKey(task);
    if (key) matches.push({ key, model, start: taskIndex, end: taskIndex + task.length });
  }
  for (const match of sentence.matchAll(TASK_FIRST_ASSIGNMENT)) {
    const task = match[1];
    const model = match[2];
    const start = match.index ?? 0;
    const key = routeTaskKey(task);
    if (key) matches.push({ key, model, start, end: start + task.length });
  }
  if (matches.length === 0 || tasks.length === 0) return null;
  const assignmentsByTask = new Map<string, string>();
  for (const task of tasks) {
    const matched = matches.find(({ key, start, end }) => key === task.key && task.index >= start && task.index < end);
    if (!matched) return null;
    const prior = assignmentsByTask.get(task.key);
    if (prior && normalizeModelName(prior) !== normalizeModelName(matched.model)) return null;
    assignmentsByTask.set(task.key, matched.model);
  }
  return Array.from(assignmentsByTask.entries()).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, model]) => ({ key, model: canonicalModelName(model) }));
}

function routeConditionKey(sentence: string): string | null {
  const assignments = routeAssignments(sentence);
  if (!assignments) return null;
  return assignments.map(({ key, model }) => `${key}=${normalizeModelName(model)}`).join(",");
}

function canonicalModelName(value: string): string {
  const normalized = normalizeModelName(value);
  if (/^claude sonnet$/u.test(normalized)) return "Claude Sonnet";
  if (/^codex$/u.test(normalized)) return "Codex";
  if (/^claude$/u.test(normalized)) return "Claude";
  if (/^sonnet$/u.test(normalized)) return "Sonnet";
  if (/^opus$/u.test(normalized)) return "Opus";
  if (/^gemini$/u.test(normalized)) return "Gemini";
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toUpperCase();
}

function routeTaskKey(value: string): string | null {
  for (const { key, pattern } of ROUTE_TASKS) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) return key;
  }
  return null;
}

function normalizeModelName(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function trimCommandPrefix(value: string): string {
  return value.replace(/^(?:(?:今後|毎回|常に|次から)は?|今回だけは?|この作業だけは?|今日だけは?)\s*/u, "").trim();
}

function extractExpressionTarget(sentence: string, preserveModifier: boolean): ExpressionTarget {
  const targetMatch = matchExpressionTarget(sentence);
  if (!targetMatch) return { modifierUnparsed: false };
  if (!preserveModifier) return { term: targetMatch[0], modifierUnparsed: false };
  const targetIndex = targetMatch.index ?? 0;
  let modifier = sentence.slice(0, targetIndex).replace(/^.*[、,。！？!?]/u, "");
  modifier = modifier.replace(/^.*(?:今後|毎回|常に|次から|今回だけ|この作業だけ|今日だけ)(?:は|、)?/u, "");
  modifier = modifier.replace(/^[、,]\s*/u, "").trim();
  if (!modifier) return { term: targetMatch[0], modifierUnparsed: false };
  const term = `${modifier}${targetMatch[0]}`;
  if (Array.from(term).length > 160) return { modifierUnparsed: true };
  if (!isAttributiveExpressionModifier(modifier)) return { term, modifierUnparsed: true };
  return { term, modifierUnparsed: false };
}

function requiredValues(
  sentence: string,
  topic: TopicMatch,
  toneException: boolean,
  routeAssignment?: RouteAssignment,
  expressionTarget?: ExpressionTarget,
): Record<string, string> {
  const values: Record<string, string> = {};
  if (topic.topicKey === "tone") {
    const style = toneException || topic.actionKey === "use_casual" ? "常体"
      : topic.actionKey === "use_polite" ? "敬体" : "";
    if (style) values.style = style;
    if (toneException || /オーナー|owner|自分/u.test(sentence)) values.audience = "owner";
    return values;
  }

  if (topic.topicKey === "response_policy") {
    const subjects: Record<string, string> = {
      "response:question": "質問",
      "response:answer": "回答",
      "response:reply": "返答",
      "response:wait": "指示",
    };
    const subject = subjects[topic.targetKey];
    if (subject) values.subject = subject;
    return values;
  }

  if (topic.topicKey === "document_delivery") {
    let documentKind = sentence.match(/(?:(?:社外|社内|ユーザー|オーナー|外部|内部)向け)?(?:文案|報告|回答文|返答文|文書|文章|本文|資料)/u)?.[0];
    if (/文案.{0,8}報告|報告.{0,8}文案/u.test(sentence)) {
      const audience = sentence.match(/((?:社外|社内|ユーザー|オーナー|外部|内部)向け)?文案/u)?.[1] ?? "";
      documentKind = `${audience}文案・報告`;
    }
    if (!documentKind && topic.actionKey === "present_full") documentKind = "文章";
    if (documentKind) values.documentKind = documentKind;
    const range = sentence.match(/(?:冒頭|末尾|指定範囲|指定した範囲)[^、。！？!?]*/u)?.[0];
    if (range) values.range = range;
    return values;
  }

  if (topic.topicKey === "expression_policy") {
    const target = expressionTarget ?? { term: matchExpressionTarget(sentence)?.[0], modifierUnparsed: false };
    if (target.term) values.term = target.term;
    const replacement = sentence.match(/([^、。！？!?]+?)を([^、。！？!?]+?)に(?:置換|置き換|言い換)/u);
    if (replacement) {
      const sourceExpression = trimCommandPrefix(replacement[1]);
      const targetExpression = replacement[2].trim();
      if (sourceExpression && targetExpression && Array.from(sourceExpression).length <= 40 && Array.from(targetExpression).length <= 40) {
        values.sourceExpression = sourceExpression;
        values.targetExpression = targetExpression;
      }
    }
    return values;
  }

  if (topic.topicKey === "summary_constraints") {
    const subject = sentence.match(/要約/u) ? "要約" : sentence.match(/字数|文字数|長さ/u) ? "字数" : "";
    if (subject) values.subject = subject;
    const limits = Array.from(sentence.matchAll(NUMERIC_CONDITIONS), (match) => match[0].normalize("NFKC").replace(/\s+/gu, ""));
    NUMERIC_CONDITIONS.lastIndex = 0;
    if (limits.length === 1) values.limit = limits[0];
    return values;
  }

  if (topic.topicKey === "design_components") {
    const component = sentence.match(/CSS\s*部品|CSS|フォント|デザイン部品|部品/u)?.[0];
    if (component) values.component = component.replace(/\s+/gu, "");
    const changedValue = sentence.match(/(?:CSS\s*部品|CSS|フォント|デザイン部品|部品)を([^、。！？!?]+?)に(?:変更|変え)/u)?.[1]?.trim();
    if (changedValue) values.targetValue = changedValue;
    return values;
  }

  if (topic.topicKey === "verification") {
    const comparison = sentence.match(/([^、。！？!?]+?)を([^、。！？!?]+?)と照合/u);
    if (comparison) {
      const subject = trimCommandPrefix(comparison[1]);
      if (subject) values.subject = subject;
      values.source = comparison[2].trim();
    }
    const evidence = sentence.match(/([^、。！？!?]+?)の(?:検証)?根拠/u)?.[1];
    if (evidence) {
      const subject = trimCommandPrefix(evidence);
      if (subject) values.subject = subject;
      values.evidence = "検証根拠";
    }
    return values;
  }

  if (topic.topicKey === "delegation_roles") {
    const assignment = sentence.match(/(?:設計|実装|作業)(?:は|を)?\s*([A-Za-z][A-Za-z0-9-]*|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]{2,20})\s*(?:に)?(?:任せ|担当|委譲)/iu);
    const workType = sentence.match(/設計|実装|作業/u)?.[0];
    if (workType) values.workType = workType;
    if (assignment) values.assignee = assignment[1];
    return values;
  }

  if (topic.topicKey === "storage_location") {
    const artifactType = sentence.match(/成果物|一時ファイル|中間生成物|ログ|手順|スクリプト/u)?.[0];
    if (artifactType) values.artifactType = artifactType;
    let destination = sentence.match(/(?:保存|配置)先(?:は|を)?([^、。！？!?]+)/u)?.[1]?.trim();
    if (!destination) destination = sentence.match(/(?:リポジトリ直下|作業ツリー|一時領域|\.tmp\/[A-Za-z0-9_./-]+)/u)?.[0];
    if (!destination) destination = sentence.match(/(?:成果物|一時ファイル|中間生成物|ログ|手順|スクリプト)(?:を)?([^、。！？!?]+?)(?:へ|に)(?:保存|配置|置)/u)?.[1]?.trim();
    if (destination && !destination.startsWith("/") && !destination.startsWith("~") && !/^[A-Za-z]:[\\/]/u.test(destination)) {
      values.destination = destination;
    }
    const duration = sentence.match(/\d+\s*(?:日|時間|分|週|月)(?:間)?/u)?.[0]?.replace(/\s+/gu, "");
    if (duration) values.duration = duration;
    return values;
  }

  if (topic.topicKey === "model_routing") {
    const assignments = routeAssignment ? [routeAssignment] : routeAssignments(sentence);
    if (assignments && assignments.length === 1) {
      values.workType = assignments[0].key;
      values.model = assignments[0].model;
    } else {
      const modelName = sentence.match(new RegExp(ROUTE_MODEL_SOURCE, "iu"))?.[0];
      if (modelName) values.model = canonicalModelName(modelName);
    }
  }
  return values;
}

function matchesTopic(sentence: string): TopicMatch | null {
  if (/口調|文体|敬体|常体|敬語/u.test(sentence)) {
    const targetKey = sentence.match(/常体/u) ? "tone:casual" : sentence.match(/敬体|敬語/u) ? "tone:politeness" : "tone:general";
    const hasToneAction = /(?:答え|話|使|維持|保|変更|変え|選|直|やめ|する|です|ます)/u.test(sentence);
    const actionKey = sentence.includes("常体") ? "use_casual"
      : /敬体|敬語/u.test(sentence) ? "use_polite" : "adjust_tone";
    return { topicKey: "tone", targetKey, actionKey, actionKnown: hasToneAction };
  }

  if (/モデル|経路|利用枠|Codex|Claude|Sonnet|Opus|GPT|Gemini/iu.test(sentence)
    && MODEL_ROUTE_ACTION.test(sentence)) {
    const names = Array.from(sentence.matchAll(MODEL_NAME), (match) => match[0].toLocaleLowerCase("en-US"));
    return {
      topicKey: "model_routing",
      targetKey: "model_routing",
      actionKey: "route_task",
      actionKnown: names.length > 0 && MODEL_ROUTE_ACTION.test(sentence),
    };
  }

  if (/質問|回答|返答|待機/u.test(sentence)) {
    const targetKey = sentence.match(/質問/u) ? "response:question"
      : sentence.match(/回答/u) ? "response:answer" : sentence.match(/返答/u) ? "response:reply" : "response:wait";
    const hasAnswer = /(?:答え(?:て|る|ろ)|回答(?:して|する)|返事(?:して|する))/u.test(sentence);
    const hasStop = /(?:止(?:まって|まる|めて|める)|停止(?:して|する))/u.test(sentence);
    const hasWait = /(?:待(?:って|つ)|待機(?:して|する))/u.test(sentence);
    const actionKey = hasAnswer && hasStop ? "answer_then_stop"
      : hasAnswer ? "answer" : hasWait ? "wait" : hasStop ? "stop" : "response_order";
    return {
      topicKey: "response_policy",
      targetKey,
      actionKey,
      actionKnown: hasAnswer || hasStop || hasWait || /再開/u.test(sentence),
    };
  }

  if (/文書|文章|本文|全文|提示/u.test(sentence)) {
    const isFull = /全文|本文|全体/u.test(sentence);
    const hasPresentAction = /(?:出(?:して|す|せ)|示(?:して|す|せ)|提示(?:して|する)|見せ(?:て|る)|表示(?:して|する)|出さないで|出さない|出すな|示さない|提示しない|表示しない|見せない)/u.test(sentence);
    return {
      topicKey: "document_delivery",
      targetKey: isFull ? "document:full" : "document:content",
      actionKey: isFull ? "present_full" : "present",
      actionKnown: hasPresentAction,
    };
  }

  if (/言葉|用語|略号|略語|比喩/u.test(sentence)) {
    const hasExpressionAction = /(?:使(?:って|う|わない|え)|説明(?:して|する)|置換(?:して|する)|言い換(?:えて|える)|避け(?:て|る)|控え(?:て|る))/u.test(sentence);
    return {
      topicKey: "expression_policy",
      targetKey: sentence.match(/比喩/u) ? "expression:metaphor" : "expression:terms",
      actionKey: /置換|言い換/u.test(sentence) ? "replace_terms" : /説明/u.test(sentence) ? "explain_terms" : "use_terms",
      actionKnown: hasExpressionAction,
    };
  }

  if (/要約|字数|文字数|長さ/u.test(sentence)) {
    const hasNumericLimit = KNOWN_NUMERIC_CONDITION.test(sentence);
    const hasSummaryAction = /(?:制限(?:して|する)|解除(?:して|する)|まとめ(?:て|る)|短く(?:して|する)|抑(?:えて|える)|\d+\s*(?:字|文字)\s*(?:以内|以下|以上|未満|まで))/u.test(sentence);
    return {
      topicKey: "summary_constraints",
      targetKey: sentence.match(/(?:字数|文字数|長さ)/u) ? "summary:length" : "summary:content",
      actionKey: /解除/u.test(sentence) ? "release_summary_limit" : hasNumericLimit ? "limit_summary_length" : "constrain_summary",
      actionKnown: hasSummaryAction,
    };
  }

  if (/デザイン|部品|フォント|CSS/u.test(sentence)) {
    const hasDesignAction = /(?:維持(?:して|する)|再利用(?:して|する)|変更(?:して|する)|変え(?:て|る)|使(?:って|う)|保(?:って|つ)|適用(?:して|する))/u.test(sentence);
    return {
      topicKey: "design_components",
      targetKey: sentence.match(/フォント/u) ? "design:font" : sentence.match(/CSS/u) ? "design:css" : "design:component",
      actionKey: /維持|保/u.test(sentence) ? "preserve_design" : /再利用/u.test(sentence) ? "reuse_design" : "change_design",
      actionKnown: hasDesignAction,
    };
  }

  if (/検証|確認|出典|原本/u.test(sentence)) {
    const hasVerificationAction = /(?:照合(?:して|する)|確認(?:して|する)|示(?:して|す|せ)|提示(?:して|する)|検証(?:して|する)|見(?:て|る)|使(?:って|う))/u.test(sentence);
    return {
      topicKey: "verification",
      targetKey: sentence.match(/原本/u) ? "verification:source" : sentence.match(/出典/u) ? "verification:citation" : "verification:check",
      actionKey: /照合|原本/u.test(sentence) ? "compare_source" : /示|提示/u.test(sentence) ? "show_evidence" : "verify",
      actionKnown: hasVerificationAction,
    };
  }

  if (/設計|実装|作業|委譲/u.test(sentence)) {
    const hasDelegationAction = /(?:担当(?:して|する)|任せ(?:て|る)|委譲(?:して|する)|実施(?:して|する)|行(?:って|う)|設計(?:して|する)|実装(?:して|する))/u.test(sentence);
    return {
      topicKey: "delegation_roles",
      targetKey: sentence.match(/設計/u) ? "delegation:design" : sentence.match(/実装/u) ? "delegation:implementation" : "delegation:work",
      actionKey: "assign_roles",
      actionKnown: hasDelegationAction,
    };
  }

  if (/保存|配置|一時|成果物/u.test(sentence)) {
    const hasStorageAction = /(?:保存(?:して|する)|置(?:いて|く)|配置(?:して|する)|保持(?:して|する)|保管(?:して|する))/u.test(sentence);
    return {
      topicKey: "storage_location",
      targetKey: sentence.match(/一時/u) ? "storage:temporary" : sentence.match(/成果物/u) ? "storage:artifact" : "storage:location",
      actionKey: /保持|保管/u.test(sentence) ? "retain_artifact" : "set_storage_location",
      actionKnown: hasStorageAction,
    };
  }

  if (BROAD_ACTION.test(sentence) || hasGenericNegativeCommand(sentence)) {
    return { topicKey: "unknown", targetKey: "unknown", actionKey: "unknown", actionKnown: true };
  }
  return null;
}

function conditionDescriptor(sentence: string, topicKey: string): {
  conditionKey: string;
  conditionKnown: boolean;
  lifetimeKind: CorrectionCandidate["lifetimeKind"];
  conditions: string[];
} {
  const deadline = DEADLINE.exec(sentence)?.[0];
  const continuing = CONTINUING.exec(sentence)?.[0];
  const scope = deadline ? `task:${deadline}` : continuing ? "continuing" : "general";
  let conditionKnown = true;
  const conditionParts = [scope];
  const numericConditions = Array.from(sentence.matchAll(NUMERIC_CONDITIONS), (match) => match[0].normalize("NFKC"));
  for (const numericCondition of numericConditions) {
    const limit = `limit:${numericCondition}`;
    if (!conditionParts.includes(limit)) conditionParts.push(limit);
  }
  const withoutNegativeShika = sentence.replace(NEGATIVE_SHIKA_EMPHASIS, " ");
  if (withoutNegativeShika !== sentence) conditionParts.push("modifier:shika-negative");
  const unrecognizedConditionText = withoutNegativeShika
    .replace(KNOWN_CONDITION_SCOPE, " ")
    .replace(NUMERIC_CONDITIONS, " ")
    .replace(/\s+/gu, " ");
  const parsedConditionText = removeOptionalLimiterWords(unrecognizedConditionText);
  NUMERIC_CONDITIONS.lastIndex = 0;
  if (UNKNOWN_CONDITION.test(parsedConditionText)) {
    conditionKnown = false;
    const conditionText = parsedConditionText
      .match(/[^、。！？!?]*(?:場合|とき|時|なら|以外|に限り|限り|条件|だけ|のみ|しか|ばかり|ただし|除く|除外)[^、。！？!?]*/u)?.[0]?.trim();
    conditionParts.push(`unparsed:${conditionText ?? "condition"}`);
  }

  let hasTaskRoute = true;
  if (topicKey === "model_routing") {
    const route = routeConditionKey(sentence);
    hasTaskRoute = route !== null;
    if (route) conditionParts.push(`route:${route}`);
    else conditionKnown = false;
  }

  if (topicKey === "tone" && /オーナー|owner|自分/u.test(sentence)) conditionParts.push("audience:owner");
  const lifetimeKind: CorrectionCandidate["lifetimeKind"] = topicKey === "model_routing" && !hasTaskRoute ? "routing"
    : deadline ? "task"
    : continuing ? "explicit_continuing"
      : topicKey === "model_routing" ? "routing" : "inferred";
  return { conditionKey: conditionParts.join(";"), conditionKnown, lifetimeKind, conditions: [] };
}

function hasPoliteEnding(value: string): boolean {
  const cleaned = removeQuotedAndInjectedContent(value.normalize("NFKC"));
  const sentences = cleaned.split("\n").filter((line) => !/^\s{0,3}>/u.test(line)).join("\n")
    .split(/[。！？!?\n]+/u)
    .map((sentence) => sentence.replace(/[\s\]）)】」』*_~]+$/gu, "").trim())
    .filter(Boolean);
  return sentences.some((sentence) => /(?:です|ます|でした|ました|ません)$/u.test(sentence));
}

function detectUnclearReaction(
  sentence: string,
  context: DetectionContext,
  event: OwnerEvent,
): CorrectionCandidate | null {
  const previousAssistantText = context.previousAssistantText?.trim() ?? "";
  const sameSession = event.sessionId === undefined || context.previousAssistantSessionId === undefined
    || event.sessionId === context.previousAssistantSessionId;
  if (!sameSession) return null;

  const normalizedReactionText = sentence.replace(/って何だ(?=[?？])/gu, "って何").replace(/？/gu, "?");
  const match = R3_PATTERN.exec(normalizedReactionText);
  if (!match) return null;
  const matchedText = match[0];
  const isUnclearReaction = matchedText.startsWith("って")
    || matchedText.includes("わからん")
    || matchedText === "意味不明";
  if (!isUnclearReaction) return null;

  if (matchedText === "意味不明") {
    const isStandalone = normalizedReactionText.replace(/[?]$/u, "").trim() === "意味不明"
      && event.text.trim() === sentence.trim();
    const isShortQuestion = Array.from(event.text).length < 40 && /[?？]/u.test(sentence);
    if (!isStandalone && !isShortQuestion) return null;
  }

  if (!previousAssistantText) {
    const segmentStart = event.text.indexOf(sentence);
    if (segmentStart < 0 || segmentStart + match.index >= 120) return null;
  }

  if (matchedText.startsWith("って")) {
    const subject = sentence.slice(0, match.index).trim();
    const hasUnclearFollowup = /わかりづらい/u.test(event.text);
    if (subject && !/^(?:それ|これ|あれ)$/u.test(subject) && !hasUnclearFollowup) return null;
  }

  const condition = conditionDescriptor(sentence, "unknown");
  const ruleInput: CorrectionRuleInput = {
    version: 2,
    topicKey: "unknown",
    actionKey: "unclear_reaction",
    polarity: "negative",
    requiredValues: {},
    conditions: condition.conditions,
    boundaryKey: condition.conditionKey,
    lifetimeKind: condition.lifetimeKind,
    continuationBasis: "inferred-repeat",
    directive: false,
    plainCommandEligible: false,
    question: /[?？]|って(?:何|なに)/u.test(sentence),
    toneException: false,
    conditionKnown: condition.conditionKnown,
    commandText: "",
  };
  const normalizedText = sentence.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const descriptor: CorrectionBundleDescriptor = {
    topicKey: "unknown",
    actionKey: "unclear_reaction",
    polarity: "negative",
    conditionKey: correctionConditionKey(ruleInput),
    normalizedText,
    conditionKnown: condition.conditionKnown,
    plainCommandEligible: false,
    requiredValuesKey: correctionRequiredValuesKey(ruleInput),
  };

  return {
    ...descriptor,
    score: 2,
    status: "candidate",
    source: "utterance_detection",
    ruleText: "",
    ruleInput,
    actionKnown: false,
    lifetimeKind: condition.lifetimeKind,
    sourceType: event.sourceType,
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
    ...(event.uuid ? { eventUuid: event.uuid } : {}),
    ...(event.position !== undefined ? { sourcePosition: event.position } : {}),
    ...(event.order !== undefined ? { eventOrder: event.order } : {}),
    ...(event.availableOrder !== undefined ? { availableOrder: event.availableOrder } : {}),
    ...(event.availableAt !== undefined ? { availableAt: event.availableAt } : {}),
    ...(event.transcriptByteOffset !== undefined ? { transcriptByteOffset: event.transcriptByteOffset } : {}),
  };
}

function scoreSentence(sentence: string, topic: TopicMatch, context: DetectionContext, allowB9ToneException: boolean): {
  score: number;
  hasCorrectionSignal: boolean;
  hasContinuingSignal: boolean;
  hasContinuingCommand: boolean;
  priorActionMatch: boolean;
  b9ToneException: boolean;
} {
  const hasMismatch = MISMATCH.test(sentence);
  const toneQuestion = topic.topicKey === "tone"
    && /(?:なぜ|なんで|何で)/u.test(sentence)
    && /(?:口調|文体|敬体|常体|敬語|ですます)/u.test(sentence)
    && /(?:なの|なん|なんだ|ですか)/u.test(sentence);
  const hasPastQuestion = ((/(?:なぜ|なんで|何で)/u.test(sentence) && PAST_ACTION.test(sentence))
    && !TECHNICAL_CAUSE.test(sentence)) || toneQuestion;
  const hasPredicate = hasCorrectionPredicate(sentence);
  const repeated = (REPEAT_CUE.test(sentence) || REPEAT_MATA.test(sentence)) && (hasPredicate || hasMismatch);
  const repeatedScore = repeated ? 3 : 0;
  const pastActionScore = hasPastQuestion || hasMismatch ? 2 : 0;
  const continuing = CONTINUING.test(sentence) && !DEADLINE.test(sentence);
  const continuingScore = continuing ? 2 : 0;
  const hasContinuingCommand = continuing && hasExplicitCommandEnding(sentence)
    && !NON_DIRECTIVE_STATEMENT.test(sentence)
    && !SELF_ACTION_SUBJECT.test(sentence);
  const actionScore = topic.actionKnown || hasNegativeAction(sentence) ? 2 : 0;
  const previousText = context.previousAssistantText ?? "";
  const previousAction = `${previousText} ${context.previousAssistantToolName ?? ""}`;
  const targetPatterns: Record<string, RegExp> = {
    "response:question": /質問|question|ask/iu,
    "response:answer": /回答|answer/iu,
    "response:reply": /返答|reply/iu,
    "response:wait": /待機|待|wait/iu,
    "document:full": /全文|本文|全体|document|content/iu,
    "document:content": /文書|文章|本文|document|content/iu,
    "expression:metaphor": /比喩|metaphor/iu,
    "expression:terms": /言葉|用語|略号|略語|term|word/iu,
    "summary:length": /字数|文字数|長さ|length/iu,
    "summary:content": /要約|summary/iu,
    "design:font": /フォント|font/iu,
    "design:css": /CSS/iu,
    "design:component": /デザイン|部品|component|design/iu,
    "verification:source": /原本|source/iu,
    "verification:citation": /出典|citation|source/iu,
    "verification:check": /検証|確認|verification|check/iu,
    "delegation:design": /設計|design/iu,
    "delegation:implementation": /実装|implementation/iu,
    "delegation:work": /作業|委譲|work|delegate/iu,
    "storage:temporary": /一時|temporary|temp/iu,
    "storage:artifact": /成果物|artifact/iu,
    "storage:location": /保存|配置|storage|save/iu,
    model_routing: /Codex|Claude|Sonnet|Opus|GPT|Gemini|model|route/iu,
  };
  const previousHasTarget = topic.topicKey !== "tone" && targetPatterns[topic.targetKey]?.test(previousAction) === true;
  const b9ToneException = allowB9ToneException && topic.topicKey === "tone"
    && /(?:なぜ|なんで|何で)/u.test(sentence)
    && /(?:敬語|敬体|ですます)/u.test(sentence)
    && /(?:なの|なん|なんだ|ですか)/u.test(sentence)
    && hasPoliteEnding(previousText);
  const priorActionMatch = b9ToneException || (topic.topicKey !== "tone" && previousHasTarget);
  const score = b9ToneException
    ? 6
    : toneQuestion ? 4
      : repeatedScore + pastActionScore + actionScore + continuingScore + (priorActionMatch ? 2 : 0);
  return {
    score,
    hasCorrectionSignal: repeated || hasMismatch || hasPastQuestion,
    hasContinuingSignal: continuing,
    hasContinuingCommand,
    priorActionMatch,
    b9ToneException,
  };
}

function explicitTonePolarity(sentence: string, topic: TopicMatch): CorrectionRuleInput["polarity"] | null | undefined {
  if (topic.topicKey !== "tone") return undefined;
  const style = topic.actionKey === "use_casual" ? "常体"
    : topic.actionKey === "use_polite" ? "(?:敬語|敬体|ですます)" : "";
  if (!style) return undefined;
  const negative = new RegExp(`${style}.{0,8}(?:ではなく|でなく|(?:を|は)?(?:使わない|使うな|使わず|書かない|答えない|話さない|維持しない|やめ(?:て|ろ)|禁止))`, "u").test(sentence);
  const positive = new RegExp(`${style}.{0,8}(?:で(?:書|答|話)|を(?:使|維持)|に(?:する|変える))`, "u").test(sentence);
  if (negative && positive) return null;
  if (negative) return "negative";
  if (positive) return "positive";
  return undefined;
}

function detectSentence(
  sentence: string,
  context: DetectionContext,
  event: OwnerEvent,
): CorrectionCandidate | null {
  if (Array.from(sentence).length > 300 || THIRD_PARTY.test(sentence) || EXAMPLE_CONTEXT.test(sentence)
    || /^(?:という例|例として|引用|引用文|過去の指示)/u.test(sentence)
    || NON_DIRECTIVE_STATEMENT.test(sentence)
    || SELF_ACTION_SUBJECT.test(sentence)) return null;
  const unclearReaction = detectUnclearReaction(sentence, context, event);
  if (unclearReaction) return unclearReaction;
  const topic = matchesTopic(sentence);
  if (!topic) return null;
  const toneQuestion = topic.topicKey === "tone"
    && /(?:なぜ|なんで|何で)/u.test(sentence)
    && /(?:口調|文体|敬体|常体|敬語|ですます)/u.test(sentence)
    && /(?:なの|なん|なんだ|ですか)/u.test(sentence);
  const sameSession = event.sessionId === undefined || context.previousAssistantSessionId === undefined
    || event.sessionId === context.previousAssistantSessionId;
  const sessionContext = sameSession ? context : {};
  const condition = conditionDescriptor(sentence, topic.topicKey);
  const hasArtifactTarget = /(?:文書|文章|本文|成果物|資料|出力|引用|記述|回答文|返答文)/u.test(sentence);
  const specialTone = toneQuestion
    && /(?:敬語|敬体|ですます)/u.test(sentence)
    && !hasArtifactTarget
    && condition.conditionKnown
    && condition.lifetimeKind !== "task"
    && hasPoliteEnding(sessionContext.previousAssistantText ?? "");
  const hasBehavior = topic.actionKnown || toneQuestion || BROAD_ACTION.test(sentence) || GENERAL_VERB.test(sentence)
    || hasNegativeAction(sentence);
  if (!hasBehavior) return null;

  const scored = scoreSentence(sentence, topic, sessionContext, specialTone);
  const negative = hasNegativeAction(sentence);
  const tonePolarity = explicitTonePolarity(sentence, topic);
  const polarity = specialTone ? "positive" : tonePolarity ?? (negative ? "negative" : "positive");
  const actionKnown = topic.actionKnown || specialTone;
  const actionKey = specialTone ? "use_casual" : topic.actionKey;
  const topicForRule = specialTone ? { ...topic, actionKey: "use_casual" } : topic;
  const extractedExpressionTarget = topicForRule.topicKey === "expression_policy"
    ? extractExpressionTarget(sentence, actionKey === "use_terms" && polarity === "negative")
    : { modifierUnparsed: false };
  const ruleConditionKnown = condition.conditionKnown && !event.hasSensitiveValue && !event.isPasteCandidate;
  const looksLikeQuestion = /[?？]|(?:ですか|でしょうか|べきか|相談|どう思う|したい)/u.test(sentence);
  const normalizedCommand = sentence.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const hasCorrectionMark = scored.hasCorrectionSignal || hasNegativeAction(sentence) || scored.hasContinuingCommand;
  const directive = (hasCorrectionMark && hasExplicitCommandEnding(sentence) && hasCorrectionPredicate(sentence)
    && !isConsultationQuestion(normalizedCommand) && tonePolarity !== null) || specialTone;
  let commandText = "";
  if (!event.hasSensitiveValue && !event.isPasteCandidate && Array.from(normalizedCommand).length <= 240) {
    commandText = normalizedCommand;
  }
  const requiredRuleValues = event.hasSensitiveValue || event.isPasteCandidate
    ? {} : requiredValues(sentence, topicForRule, specialTone, undefined, extractedExpressionTarget);
  const hasRequiredRuleValues = Object.values(requiredRuleValues).some((value) => value.length > 0);
  const hasModelName = new RegExp(MODEL_NAME.source, "iu").test(normalizedCommand);
  const tasklessModelRoute = topic.topicKey === "model_routing" && routeAssignments(normalizedCommand) === null;
  const plainCommandEligible = Array.from(normalizedCommand).length <= 40
    && hasExplicitCommandEnding(normalizedCommand)
    && hasCorrectionPredicate(normalizedCommand)
    && !looksLikeQuestion
    && !isConsultationQuestion(normalizedCommand)
    && !event.hasSensitiveValue
    && !event.isPasteCandidate
    && !THIRD_PARTY.test(normalizedCommand)
    && !EXAMPLE_CONTEXT.test(normalizedCommand)
    && (topic.topicKey === "unknown"
      ? hasNegativeAction(normalizedCommand)
      : topic.topicKey === "model_routing"
        ? Boolean(requiredRuleValues.model) && hasModelName
          && (tasklessModelRoute || Boolean(requiredRuleValues.workType))
        : hasRequiredRuleValues || extractedExpressionTarget.modifierUnparsed);
  const plainModelRoute = tasklessModelRoute && plainCommandEligible;
  const input: CorrectionRuleInput = {
    version: 2,
    topicKey: topic.topicKey as CorrectionRuleInput["topicKey"],
    actionKey,
    polarity,
    requiredValues: requiredRuleValues,
    conditions: condition.conditions,
    boundaryKey: condition.conditionKey,
    lifetimeKind: condition.lifetimeKind,
    continuationBasis: condition.lifetimeKind === "explicit_continuing" ? "explicit-continuing-command"
      : condition.lifetimeKind === "task" ? "task-scoped-request"
        : condition.lifetimeKind === "routing" ? "temporary-model-routing" : "inferred-repeat",
    directive: plainModelRoute ? false : directive || specialTone,
    plainCommandEligible,
    question: looksLikeQuestion || specialTone,
    toneException: specialTone,
    conditionKnown: ruleConditionKnown,
    commandText,
  };
  if (extractedExpressionTarget.modifierUnparsed) input.directive = false;
  else if (hasUnrepresentedRuleMeaning(input)) input.directive = false;
  const typedRuleText = renderTypedCorrectionRule(input);
  const ruleInput = { ...input };
  if (typedRuleText.length > 0) delete ruleInput.commandText;
  const ruleText = renderCorrectionRule(ruleInput);
  const descriptor: CorrectionBundleDescriptor = {
    topicKey: topic.topicKey,
    actionKey,
    polarity,
    conditionKey: correctionConditionKey(ruleInput),
    normalizedText: normalizedCommand,
    conditionKnown: ruleConditionKnown,
    plainCommandEligible,
    requiredValuesKey: correctionRequiredValuesKey(input),
  };
  const status = !event.hasSensitiveValue
    && !event.isPasteCandidate
    && ruleText.length > 0
    && (hasCorrectionPredicate(sentence) || specialTone)
    && ((scored.score >= 6 && scored.priorActionMatch) || (scored.hasContinuingCommand && scored.score >= 4))
    ? "confirmed"
    : "candidate";

  if (scored.score < 2 && !scored.hasCorrectionSignal && !scored.hasContinuingSignal) return null;
  return {
    ...descriptor,
    score: scored.score,
    status,
    source: scored.hasCorrectionSignal ? "utterance_detection" : "request_repeat",
    ruleText,
    ruleInput,
    actionKnown,
    lifetimeKind: condition.lifetimeKind,
    sourceType: event.sourceType,
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
    ...(event.uuid ? { eventUuid: event.uuid } : {}),
    ...(event.position !== undefined ? { sourcePosition: event.position } : {}),
    ...(event.order !== undefined ? { eventOrder: event.order } : {}),
    ...(event.availableOrder !== undefined ? { availableOrder: event.availableOrder } : {}),
    ...(event.availableAt !== undefined ? { availableAt: event.availableAt } : {}),
    ...(event.transcriptByteOffset !== undefined ? { transcriptByteOffset: event.transcriptByteOffset } : {}),
  };
}

export function detectOwnerCorrections(event: OwnerEvent, context: DetectionContext = {}): CorrectionCandidate[] {
  if (event.isSlashCommand || event.isHandoffPaste) return [];
  const candidates: CorrectionCandidate[] = [];
  for (const sentence of event.segments) {
    const candidate = detectSentence(sentence, context, event);
    if (!candidate) continue;
    const rawText = candidate.normalizedText;
    const comparableCandidate = { ...candidate, normalizedText: rawText };
    candidate.normalizedText = createHash("sha256").update(rawText, "utf8").digest("hex");
    rawBundleTexts.set(candidate, rawText);
    const comparableExisting = candidates.map((item) => ({
      ...item,
      normalizedText: rawBundleTexts.get(item) ?? item.normalizedText,
    }));
    const existingIndex = comparableExisting.findIndex((item) => haveSameBundleKey(item, comparableCandidate));
    const existing = existingIndex < 0 ? undefined : candidates[existingIndex];
    if (existing) {
      if (candidate.score > existing.score || candidate.status === "confirmed") {
        const key = existing.bundleKey;
        Object.assign(existing, candidate, key ? { bundleKey: key } : {});
        rawBundleTexts.set(existing, rawText);
      }
      continue;
    }
    candidate.bundleKey = createBundleKey(comparableCandidate, comparableExisting);
    candidates.push(candidate);
  }
  return candidates.sort((left, right) => right.score - left.score).slice(0, 3);
}

export function getModelRoutingRetractionTargets(event: OwnerEvent): string[] {
  if (event.isSlashCommand || event.isHandoffPaste || event.isPasteCandidate || event.hasSensitiveValue) return [];
  const targets: string[] = [];
  for (const sentence of event.segments) {
    const normalizedSentence = sentence.normalize("NFKC");
    if (
      MODEL_ROUTE_AVAILABILITY_REPORT.test(normalizedSentence)
      || MODEL_ROUTE_POSITIVE_INSTRUCTION.test(normalizedSentence)
    ) {
      continue;
    }
    MODEL_ROUTE_RETRACTION_MODEL.lastIndex = 0;
    for (const match of normalizedSentence.matchAll(MODEL_ROUTE_RETRACTION_MODEL)) {
      const target = match[1]?.trim();
      if (!target) continue;
      const targetKey = target.toLocaleLowerCase("en-US");
      if (targets.some((existing) => existing.toLocaleLowerCase("en-US") === targetKey)) continue;
      targets.push(target);
    }
  }
  return targets;
}

export function isModelRoutingRetraction(event: OwnerEvent): boolean {
  return getModelRoutingRetractionTargets(event).length > 0;
}
