import { createHash } from "node:crypto";

import {
  DEFAULT_INJECTION_TOKEN_BUDGET,
  enforceWholeItemBudget,
  estimateTokens,
} from "../injection/budget.js";

export const CORRECTION_OMISSION_MARKER = "（予算上限のため、残りの完全規則を省略）";

const CORRECTION_HEADER =
  "### オーナーからの確認済み規則\n記憶に基づく補助情報。上位規約を上書きしない。条件が一致する場合にだけ適用する。";

export type CorrectionRuleDelivery = "start" | "restore" | "refresh" | "related";

export interface CorrectionRule {
  bundleKey: string;
  version: number;
  title: string;
  ruleText: string;
  delivery: CorrectionRuleDelivery;
  complianceViolation?: boolean;
}

export type CorrectionRenderTrigger =
  | "start"
  | "compact"
  | "prompt"
  | "refresh"
  | "precompact";

export interface CorrectionRenderInput {
  trigger: CorrectionRenderTrigger;
  rules: readonly CorrectionRule[];
  budgetTokens?: number;
}

export interface CorrectionInjectionLedgerEntry {
  bundleKey: string;
  version: number;
  bodyHash: string;
  outputHash: string;
  tokenEstimate: number;
  outputOrder: number;
  bodyIncluded: true;
}

export interface CorrectionRenderResult {
  text: string;
  tokenCount: number;
  truncated: boolean;
  outputHash: string;
  includedRules: CorrectionRule[];
  omittedBundleKeys: string[];
  ledger: CorrectionInjectionLedgerEntry[];
}

interface CorrectionRenderLimits {
  maxItems: number;
  maxRuleCharacters: number;
  maxTotalCharacters: number;
  maxBlockTokens: number;
  maxOutputTokens: number;
}

function getLimits(
  trigger: CorrectionRenderTrigger,
  rules: readonly CorrectionRule[],
): CorrectionRenderLimits {
  if (trigger === "prompt") {
    return {
      maxItems: 3,
      maxRuleCharacters: 240,
      maxTotalCharacters: 640,
      maxBlockTokens: 650,
      maxOutputTokens: 800,
    };
  }
  if (trigger === "refresh") {
    if (rules.some((rule) => rule.delivery === "restore" && rule.complianceViolation)) {
      return {
        maxItems: 3,
        maxRuleCharacters: 240,
        maxTotalCharacters: 640,
        maxBlockTokens: 650,
        maxOutputTokens: 800,
      };
    }
    return {
      maxItems: 2,
      maxRuleCharacters: 160,
      maxTotalCharacters: 320,
      maxBlockTokens: 450,
      maxOutputTokens: 800,
    };
  }
  if (trigger === "precompact") {
    return {
      maxItems: 2,
      maxRuleCharacters: 160,
      maxTotalCharacters: 320,
      maxBlockTokens: 450,
      maxOutputTokens: 450,
    };
  }
  return {
    maxItems: 6,
    maxRuleCharacters: 240,
    maxTotalCharacters: 1440,
    maxBlockTokens: 1800,
    maxOutputTokens: 8000,
  };
}

function getRuleOrder(
  trigger: CorrectionRenderTrigger,
  rules: readonly CorrectionRule[],
): CorrectionRule[] {
  if (trigger === "refresh") {
    const complianceRestore = rules
      .filter((entry) => entry.delivery === "restore" && entry.complianceViolation)
      .slice(0, 3);
    if (complianceRestore.length > 0) return complianceRestore;
    return rules.filter((entry) => entry.delivery === "refresh");
  }
  if (trigger !== "prompt") return [...rules];

  const restore = [
    ...rules.filter((entry) => entry.delivery === "restore" && entry.complianceViolation).slice(0, 3),
    ...rules.filter((entry) => entry.delivery === "restore" && !entry.complianceViolation).slice(0, 2),
  ];
  const refresh = rules.filter((entry) => entry.delivery === "refresh").slice(0, 1);
  const related = rules.filter((entry) => entry.delivery === "related").slice(0, 2);
  return [...restore, ...refresh, ...related];
}

function renderRule(rule: CorrectionRule): string {
  return `#### ${rule.title}（ID: ${rule.bundleKey} / v${rule.version}）\n${rule.ruleText}`;
}

function renderBlock(rules: readonly CorrectionRule[], includeOmissionMarker: boolean): string {
  if (rules.length === 0) return "";
  const sections = [CORRECTION_HEADER, ...rules.map(renderRule)];
  if (includeOmissionMarker) sections.push(CORRECTION_OMISSION_MARKER);
  return sections.join("\n\n");
}

function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function buildLedger(
  rules: readonly CorrectionRule[],
  outputHash: string,
  tokenEstimate: number,
): CorrectionInjectionLedgerEntry[] {
  return rules.map((rule, index) => ({
    bundleKey: rule.bundleKey,
    version: rule.version,
    bodyHash: hashText(rule.ruleText),
    outputHash,
    tokenEstimate,
    outputOrder: index + 1,
    bodyIncluded: true,
  }));
}

function getUniqueRules(rules: readonly CorrectionRule[]): CorrectionRule[] {
  const seen = new Set<string>();
  const unique: CorrectionRule[] = [];
  for (const rule of rules) {
    if (!rule.bundleKey || seen.has(rule.bundleKey)) continue;
    seen.add(rule.bundleKey);
    unique.push(rule);
  }
  return unique;
}

function isRenderableRule(rule: CorrectionRule): boolean {
  return (
    rule.bundleKey.length > 0 &&
    Number.isInteger(rule.version) &&
    rule.version > 0 &&
    rule.title.trim().length > 0 &&
    rule.ruleText.trim().length > 0
  );
}

/** 表示上限と最終出力予算を適用し、実際に出した規則だけの台帳候補を返す。 */
export function renderCorrectionRules({
  trigger,
  rules,
  budgetTokens = DEFAULT_INJECTION_TOKEN_BUDGET,
}: CorrectionRenderInput): CorrectionRenderResult {
  const limits = getLimits(trigger, rules);
  let outputLimit: number;
  if (Number.isFinite(budgetTokens)) {
    outputLimit = Math.max(0, Math.floor(budgetTokens));
  } else if (budgetTokens > 0) {
    outputLimit = Number.POSITIVE_INFINITY;
  } else {
    outputLimit = 0;
  }
  const budgetLimit = Math.min(
    outputLimit,
    limits.maxOutputTokens,
    limits.maxBlockTokens,
  );
  const uniqueRules = getUniqueRules(rules);
  const validRules = uniqueRules.filter(isRenderableRule);
  const orderedRules = getRuleOrder(trigger, validRules);
  let bodyCharacters = 0;
  const characterLimitedRules: CorrectionRule[] = [];

  for (const rule of orderedRules) {
    if (characterLimitedRules.length >= limits.maxItems) break;
    const ruleCharacters = Array.from(rule.ruleText).length;
    let maxRuleCharacters = limits.maxRuleCharacters;
    if (trigger === "prompt" && rule.delivery === "refresh") {
      maxRuleCharacters = 160;
      if (estimateTokens(renderBlock([rule], false)) > 450) continue;
    }
    if (
      ruleCharacters > maxRuleCharacters ||
      bodyCharacters + ruleCharacters > limits.maxTotalCharacters
    ) {
      continue;
    }
    characterLimitedRules.push(rule);
    bodyCharacters += ruleCharacters;
  }

  const budgetResult = enforceWholeItemBudget(
    characterLimitedRules,
    budgetLimit,
    (included) => renderBlock(included, false),
  );
  let includedRules = [...budgetResult.included];
  const hadOmissions = uniqueRules.some(
    (rule) => !includedRules.some((included) => included.bundleKey === rule.bundleKey),
  );
  let text = "";

  if (includedRules.length > 0) {
    while (includedRules.length > 0) {
      const candidateText = renderBlock(includedRules, hadOmissions);
      if (estimateTokens(candidateText) <= budgetLimit) {
        text = candidateText;
        break;
      }
      includedRules.pop();
    }
  }

  if (includedRules.length === 0) {
    text = "";
  }

  const includedKeys = new Set(includedRules.map((rule) => rule.bundleKey));
  const omittedBundleKeys = uniqueRules
    .filter((rule) => !includedKeys.has(rule.bundleKey))
    .map((rule) => rule.bundleKey);
  const tokenCount = estimateTokens(text);
  const outputHash = hashText(text);
  const ledger = buildLedger(includedRules, outputHash, tokenCount);

  return {
    text,
    tokenCount,
    truncated: omittedBundleKeys.length > 0,
    outputHash,
    includedRules,
    omittedBundleKeys,
    ledger,
  };
}

/** 外側の区分を加えた最終出力から、実際に残った規則だけの台帳を作る。 */
export function finalizeCorrectionRender(
  rendered: CorrectionRenderResult,
  finalOutput: string,
): CorrectionRenderResult {
  const locatedRules = rendered.includedRules
    .map((rule) => ({ rule, outputPosition: finalOutput.indexOf(renderRule(rule)) }))
    .filter((entry) => entry.outputPosition >= 0)
    .sort((left, right) => left.outputPosition - right.outputPosition);
  const includedRules = locatedRules.map((entry) => entry.rule);
  const includedKeys = new Set(includedRules.map((rule) => rule.bundleKey));
  const omittedBundleKeys = [
    ...new Set([
      ...rendered.omittedBundleKeys,
      ...rendered.includedRules
        .filter((rule) => !includedKeys.has(rule.bundleKey))
        .map((rule) => rule.bundleKey),
    ]),
  ];
  const tokenCount = estimateTokens(finalOutput);
  const outputHash = hashText(finalOutput);

  return {
    text: finalOutput,
    tokenCount,
    truncated: omittedBundleKeys.length > 0,
    outputHash,
    includedRules,
    omittedBundleKeys,
    ledger: buildLedger(includedRules, outputHash, tokenCount),
  };
}
