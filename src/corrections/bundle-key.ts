import { createHash } from "node:crypto";
import { normalizeCorrectionRequiredValuesKey } from "./rule-template.js";

export type CorrectionBundleDescriptor = {
  topicKey: string;
  actionKey: string;
  polarity: string;
  conditionKey: string;
  normalizedText: string;
  conditionKnown: boolean;
  plainCommandEligible?: boolean;
  requiredValuesKey?: string;
  bundleKey?: string;
};

const DICE_THRESHOLD = 0.85;
const OPTIONAL_LIMITER_WORD = /(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー])(?:だけ|のみ|しか|ばかり)(?=\s*(?:を|は|が|も|に|で|と|へ|から|まで|表示|出|見せ|書|答|使|説明|確認|維持|保存|提示|照合|まとめ|作成|実行|["、。！？!?]|$))/gu;
const TOTALITY_WORD = /(?:全部|すべて|全て|あらゆる|全件|全量|丸ごと)/u;

function hasTotalityWord(descriptor: CorrectionBundleDescriptor): boolean {
  return TOTALITY_WORD.test(descriptor.normalizedText.normalize("NFKC"));
}

export function removeOptionalLimiterWords(value: string): string {
  return value.replace(OPTIONAL_LIMITER_WORD, "");
}

function normalizedCharacters(value: string): string[] {
  return Array.from(value.normalize("NFKC").replace(/\s+/gu, " ").trim());
}

function normalizedExactText(value: string): string {
  return value.normalize("NFKC")
    .trim()
    .replace(/[。．.!！?？、,]+$/u, "")
    .trim()
    .toLocaleLowerCase("en-US");
}

function normalizedBundleText(descriptor: CorrectionBundleDescriptor): string {
  const normalized = descriptor.normalizedText.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (descriptor.topicKey === "unknown" || descriptor.topicKey === "model_routing" || descriptor.plainCommandEligible) {
    return normalized;
  }
  if (descriptor.conditionKey.split(";").includes("modifier:shika-negative")) return normalized;
  return removeOptionalLimiterWords(normalized);
}

function normalizedRequiredValuesKey(descriptor: CorrectionBundleDescriptor): string | undefined {
  if (typeof descriptor.requiredValuesKey !== "string") return undefined;
  if (groupsByExpressionTarget(descriptor)) {
    return normalizeCorrectionRequiredValuesKey(
      descriptor.requiredValuesKey,
      descriptor.topicKey,
      descriptor.actionKey,
      descriptor.polarity,
    );
  }
  if (descriptor.topicKey === "unknown" || descriptor.topicKey === "model_routing"
    || descriptor.conditionKey.split(";").includes("modifier:shika-negative")) {
    return descriptor.requiredValuesKey;
  }
  return removeOptionalLimiterWords(descriptor.requiredValuesKey.normalize("NFKC"));
}

function bigramCounts(value: string): Map<string, number> {
  const characters = normalizedCharacters(value);
  const counts = new Map<string, number>();
  if (characters.length < 2) return counts;
  for (let index = 0; index < characters.length - 1; index += 1) {
    const bigram = `${characters[index]}${characters[index + 1]}`;
    counts.set(bigram, (counts.get(bigram) ?? 0) + 1);
  }
  return counts;
}

export function diceCoefficient(left: string, right: string): number {
  const leftBigrams = bigramCounts(left);
  const rightBigrams = bigramCounts(right);
  const leftCount = Array.from(leftBigrams.values()).reduce((sum, count) => sum + count, 0);
  const rightCount = Array.from(rightBigrams.values()).reduce((sum, count) => sum + count, 0);
  if (leftCount === 0 && rightCount === 0) {
    return normalizedCharacters(left).join("") === normalizedCharacters(right).join("") ? 1 : 0;
  }
  if (leftCount === 0 || rightCount === 0) return 0;

  let overlap = 0;
  for (const [bigram, count] of leftBigrams) {
    overlap += Math.min(count, rightBigrams.get(bigram) ?? 0);
  }
  return (2 * overlap) / (leftCount + rightCount);
}

function sameDimensions(left: CorrectionBundleDescriptor, right: CorrectionBundleDescriptor): boolean {
  return left.topicKey === right.topicKey
    && left.actionKey === right.actionKey
    && left.polarity === right.polarity
    && left.conditionKey === right.conditionKey
    && hasTotalityWord(left) === hasTotalityWord(right);
}

function groupsByExpressionTarget(descriptor: CorrectionBundleDescriptor): boolean {
  return descriptor.topicKey === "expression_policy"
    && descriptor.actionKey === "use_terms"
    && descriptor.polarity === "negative";
}

export function haveSameBundleKey(
  left: CorrectionBundleDescriptor,
  right: CorrectionBundleDescriptor,
): boolean {
  if (!sameDimensions(left, right)) return false;
  if (groupsByExpressionTarget(left)) {
    return normalizedRequiredValuesKey(left) !== undefined
      && normalizedRequiredValuesKey(left) === normalizedRequiredValuesKey(right);
  }
  if (left.plainCommandEligible || right.plainCommandEligible) {
    if (!left.plainCommandEligible || !right.plainCommandEligible) return false;
    if (left.topicKey === "unknown" || left.topicKey === "model_routing") {
      return normalizedExactText(left.normalizedText) === normalizedExactText(right.normalizedText);
    }
    return normalizedRequiredValuesKey(left) !== undefined
      && normalizedRequiredValuesKey(left) === normalizedRequiredValuesKey(right);
  }
  if (left.topicKey === "unknown" || right.topicKey === "unknown") {
    return normalizedExactText(left.normalizedText) === normalizedExactText(right.normalizedText);
  }
  if (!left.conditionKnown || !right.conditionKnown) {
    return normalizedExactText(left.normalizedText) === normalizedExactText(right.normalizedText);
  }
  return diceCoefficient(normalizedBundleText(left), normalizedBundleText(right)) >= DICE_THRESHOLD;
}

function hashKey(value: string): string {
  return `oc:v1:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function createBundleKey(
  candidate: CorrectionBundleDescriptor,
  existing: CorrectionBundleDescriptor[] = [],
): string {
  const matching = existing.find((item) => haveSameBundleKey(candidate, item));
  if (matching?.bundleKey) return matching.bundleKey;
  let normalizedText = candidate.topicKey === "unknown" || candidate.topicKey === "model_routing"
    ? normalizedExactText(candidate.normalizedText)
    : normalizedBundleText(candidate);
  const expressionTargetKey = groupsByExpressionTarget(candidate) ? normalizedRequiredValuesKey(candidate) : undefined;
  if (expressionTargetKey !== undefined) {
    normalizedText = `expression-target:${expressionTargetKey}`;
  } else if (candidate.plainCommandEligible && candidate.topicKey !== "unknown" && candidate.topicKey !== "model_routing") {
    normalizedText = `plain-values:${normalizedRequiredValuesKey(candidate) ?? ""}`;
  }
  if (candidate.topicKey !== "unknown" && candidate.topicKey !== "model_routing" && hasTotalityWord(candidate)) {
    normalizedText = `totality:all:${normalizedText}`;
  }
  const identity = [
    candidate.topicKey,
    candidate.actionKey,
    candidate.polarity,
    candidate.conditionKey,
    normalizedText,
  ].join("\u001f");
  return hashKey(identity);
}
