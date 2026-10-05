import { createHash } from "node:crypto";

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
    && left.conditionKey === right.conditionKey;
}

export function haveSameBundleKey(
  left: CorrectionBundleDescriptor,
  right: CorrectionBundleDescriptor,
): boolean {
  if (!sameDimensions(left, right)) return false;
  if (left.plainCommandEligible || right.plainCommandEligible) {
    if (!left.plainCommandEligible || !right.plainCommandEligible) return false;
    if (left.topicKey === "unknown" || left.topicKey === "model_routing") {
      return normalizedExactText(left.normalizedText) === normalizedExactText(right.normalizedText);
    }
    return typeof left.requiredValuesKey === "string"
      && left.requiredValuesKey === right.requiredValuesKey;
  }
  if (left.topicKey === "unknown" || right.topicKey === "unknown") {
    return normalizedExactText(left.normalizedText) === normalizedExactText(right.normalizedText);
  }
  if (!left.conditionKnown || !right.conditionKnown) {
    return normalizedExactText(left.normalizedText) === normalizedExactText(right.normalizedText);
  }
  return diceCoefficient(left.normalizedText, right.normalizedText) >= DICE_THRESHOLD;
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
    : candidate.normalizedText.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (candidate.plainCommandEligible && candidate.topicKey !== "unknown" && candidate.topicKey !== "model_routing") {
    normalizedText = `plain-values:${candidate.requiredValuesKey ?? ""}`;
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
