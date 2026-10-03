import type Database from "better-sqlite3";
import type { CorrectionRule } from "./render.js";
import {
  retrieveCorrectionCandidates,
  type CorrectionRetrievalInput,
  type RetrievedCorrectionRule,
} from "./retrieval.js";
import { SQLiteStorage } from "../storage/sqlite.js";

const START_RULE_LIMIT = 6;
const MODEL_ROUTING_RESERVATION_LIMIT = 2;
const RESTORE_RULE_LIMIT = 2;
const PROMPT_REFRESH_LIMIT = 1;
const FULL_REFRESH_LIMIT = 2;
const RELATED_RULE_LIMIT = 2;
const PROMPT_RULE_LIMIT = 3;
const COOLDOWN_HUMAN_TURNS = 10;

export type CorrectionInjectionTrigger = "start" | "prompt" | "refresh" | "compact";

export interface CorrectionInjectionRequest extends CorrectionRetrievalInput {
  sessionIdHash: string;
  compactEpoch: number;
  humanOrdinal: number;
  trigger: CorrectionInjectionTrigger;
}

export interface CorrectionUnreachedRule {
  bundleKey: string;
  version: number;
  reason: "item_limit" | "token_budget" | "not_emitted";
}

export interface CorrectionInjectionSelection {
  rules: CorrectionRule[];
  unreached: CorrectionUnreachedRule[];
  alwaysOnCount: number;
  ftsCandidateCount: number;
}

interface InjectionHistoryRow {
  bundle_key: string;
  version: number;
  human_ordinal: number;
  trigger: CorrectionInjectionTrigger;
  emitted_at: string;
  output_order: number;
  body_included: 0 | 1;
  stdout_status: "emitted" | "failed";
}

interface CorrectionEvidencePosition {
  bundle_key: string;
  human_ordinal: number;
}

interface SessionHistory {
  injections: InjectionHistoryRow[];
  evidencePositions: CorrectionEvidencePosition[];
}

function comparePriority(left: RetrievedCorrectionRule, right: RetrievedCorrectionRule): number {
  return right.intensity - left.intensity ||
    right.sessionCount - left.sessionCount ||
    Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt) ||
    left.bundleKey.localeCompare(right.bundleKey);
}

function orderAlwaysOnByTopic(rules: readonly RetrievedCorrectionRule[]): RetrievedCorrectionRule[] {
  const topics = new Map<string, RetrievedCorrectionRule[]>();
  for (const rule of rules) {
    const topicRules = topics.get(rule.topicKey) ?? [];
    topicRules.push(rule);
    topics.set(rule.topicKey, topicRules);
  }
  for (const topicRules of topics.values()) topicRules.sort(comparePriority);

  const ordered: RetrievedCorrectionRule[] = [];
  let round = 0;
  while (ordered.length < rules.length) {
    const roundRules = Array.from(topics.values())
      .map((topicRules) => topicRules[round])
      .filter((rule): rule is RetrievedCorrectionRule => rule !== undefined)
      .sort(comparePriority);
    if (roundRules.length === 0) return ordered;
    ordered.push(...roundRules);
    round += 1;
  }
  return ordered;
}

function readSessionHistory(storage: SQLiteStorage, input: CorrectionInjectionRequest): SessionHistory {
  return storage.runCorrectionTransaction(({ db }) => {
    const injections = db.prepare(`
      SELECT bundle_key, version, human_ordinal, trigger, emitted_at, output_order, body_included, stdout_status
      FROM owner_correction_injections
      WHERE session_id_hash = ? AND compact_epoch = ?
      ORDER BY human_ordinal, output_order, bundle_key
    `).all(input.sessionIdHash, input.compactEpoch) as InjectionHistoryRow[];
    const evidencePositions = db.prepare(`
      SELECT e.bundle_key, event.human_ordinal
      FROM owner_correction_evidence e
      JOIN owner_correction_events event ON event.event_id = e.event_id
      WHERE event.session_id_hash = ? AND event.human_ordinal <= ?
      ORDER BY event.human_ordinal, e.bundle_key
    `).all(input.sessionIdHash, input.humanOrdinal) as CorrectionEvidencePosition[];
    return { injections, evidencePositions };
  });
}

function wasEmitted(row: InjectionHistoryRow): boolean {
  return row.body_included === 1 && row.stdout_status === "emitted";
}

function injectionKey(bundleKey: string, version: number): string {
  return `${bundleKey}:${version}`;
}

function successfulHistory(history: SessionHistory): InjectionHistoryRow[] {
  return history.injections.filter(wasEmitted);
}

function latestSuccessfulInjections(history: SessionHistory): Map<string, InjectionHistoryRow> {
  const latest = new Map<string, InjectionHistoryRow>();
  for (const row of successfulHistory(history)) {
    const key = injectionKey(row.bundle_key, row.version);
    const current = latest.get(key);
    if (
      current === undefined || row.human_ordinal > current.human_ordinal ||
      (row.human_ordinal === current.human_ordinal && row.output_order > current.output_order)
    ) {
      latest.set(key, row);
    }
  }
  return latest;
}

function latestEvidenceAfter(
  history: SessionHistory,
  bundleKey: string,
  injectedAt: number,
): number | null {
  let latestOrdinal: number | null = null;
  for (const evidence of history.evidencePositions) {
    if (evidence.bundle_key !== bundleKey || evidence.human_ordinal <= injectedAt) continue;
    if (latestOrdinal === null || evidence.human_ordinal > latestOrdinal) latestOrdinal = evidence.human_ordinal;
  }
  return latestOrdinal;
}

function hasRecentCorrection(history: SessionHistory, rule: RetrievedCorrectionRule, latest: InjectionHistoryRow | undefined): boolean {
  if (!latest) return false;
  return latestEvidenceAfter(history, rule.bundleKey, latest.human_ordinal) !== null;
}

function isCooling(
  history: SessionHistory,
  latestInjections: Map<string, InjectionHistoryRow>,
  rule: RetrievedCorrectionRule,
  allowRecentCorrection: boolean,
  humanOrdinal: number,
): boolean {
  const latest = latestInjections.get(injectionKey(rule.bundleKey, rule.version));
  if (!latest) return false;
  if (allowRecentCorrection && hasRecentCorrection(history, rule, latest)) return false;
  if (humanOrdinal < latest.human_ordinal) return true;
  return humanOrdinal - latest.human_ordinal <= COOLDOWN_HUMAN_TURNS;
}

function unreachedRules(
  rules: readonly RetrievedCorrectionRule[],
  history: SessionHistory,
  includedKeys?: ReadonlySet<string>,
): CorrectionUnreachedRule[] {
  const successfulKeys = new Set(
    successfulHistory(history).map((row) => injectionKey(row.bundle_key, row.version)),
  );
  return rules
    .map((rule) => {
      const key = injectionKey(rule.bundleKey, rule.version);
      if (successfulKeys.has(key) || (includedKeys && !includedKeys.has(key))) return null;
      const attempts = history.injections.filter((row) =>
        row.bundle_key === rule.bundleKey && row.version === rule.version,
      );
      let reason: CorrectionUnreachedRule["reason"] = attempts.length === 0 ? "item_limit" : "not_emitted";
      if (attempts.some((row) => row.body_included === 0 && row.stdout_status === "emitted")) {
        reason = "token_budget";
      }
      return { bundleKey: rule.bundleKey, version: rule.version, reason };
    })
    .filter((entry): entry is CorrectionUnreachedRule => entry !== null);
}

function requiredDeliveryRules(
  alwaysOn: readonly RetrievedCorrectionRule[],
  projectRules: readonly RetrievedCorrectionRule[],
): RetrievedCorrectionRule[] {
  const rules = [...alwaysOn, ...projectRules.filter((rule) => rule.topicKey === "model_routing")];
  return rules.filter((rule, index) =>
    rules.findIndex((entry) => entry.bundleKey === rule.bundleKey && entry.version === rule.version) === index,
  );
}

function makeCorrectionRule(rule: RetrievedCorrectionRule, delivery: CorrectionRule["delivery"]): CorrectionRule {
  return {
    bundleKey: rule.bundleKey,
    version: rule.version,
    title: rule.title,
    ruleText: rule.ruleText,
    delivery,
  };
}

function isRefreshOrdinal(humanOrdinal: number): boolean {
  return humanOrdinal >= 31 && (humanOrdinal - 31) % 30 === 0;
}

function orderForRefresh(
  rules: readonly RetrievedCorrectionRule[],
  latestInjections: Map<string, InjectionHistoryRow>,
): RetrievedCorrectionRule[] {
  return [...rules].sort((left, right) => {
    const leftInjection = latestInjections.get(injectionKey(left.bundleKey, left.version));
    const rightInjection = latestInjections.get(injectionKey(right.bundleKey, right.version));
    const leftOrdinal = leftInjection?.human_ordinal ?? -1;
    const rightOrdinal = rightInjection?.human_ordinal ?? -1;
    return leftOrdinal - rightOrdinal ||
      (leftInjection?.output_order ?? 0) - (rightInjection?.output_order ?? 0) ||
      comparePriority(left, right);
  });
}

function buildSelection(
  rules: CorrectionRule[],
  unreached: CorrectionUnreachedRule[],
  alwaysOnCount: number,
  ftsCandidateCount: number,
): CorrectionInjectionSelection {
  return { rules, unreached, alwaysOnCount, ftsCandidateCount };
}

export function selectCorrectionInjections(
  storage: SQLiteStorage,
  input: CorrectionInjectionRequest,
): CorrectionInjectionSelection {
  if (!input.sessionIdHash) throw new Error("correction injection requires a session hash");
  if (!Number.isSafeInteger(input.compactEpoch) || input.compactEpoch < 0) throw new Error("correction compact epoch is invalid");
  if (!Number.isSafeInteger(input.humanOrdinal) || input.humanOrdinal < 0) throw new Error("correction human ordinal is invalid");

  const retrieval = retrieveCorrectionCandidates(storage, input);
  const history = readSessionHistory(storage, input);
  const alwaysOn = orderAlwaysOnByTopic(retrieval.alwaysOn);
  const deliveryRules = requiredDeliveryRules(alwaysOn, retrieval.projectRules);
  const successfulKeys = new Set(
    successfulHistory(history).map((row) => injectionKey(row.bundle_key, row.version)),
  );
  const latestInjections = latestSuccessfulInjections(history);
  const unreached = unreachedRules(deliveryRules, history);
  const selected: CorrectionRule[] = [];
  const selectedKeys = new Set<string>();
  const addRule = (rule: RetrievedCorrectionRule, delivery: CorrectionRule["delivery"]): boolean => {
    const key = injectionKey(rule.bundleKey, rule.version);
    if (selectedKeys.has(key)) return false;
    selectedKeys.add(key);
    selected.push(makeCorrectionRule(rule, delivery));
    return true;
  };
  const hasAttemptForTrigger = history.injections.some((row) => row.trigger === input.trigger);

  if (input.trigger === "start" || input.trigger === "compact") {
    if (hasAttemptForTrigger) return buildSelection([], unreached, alwaysOn.length, retrieval.ftsCandidateCount);
    const availableModels = deliveryRules
      .filter((rule) => rule.topicKey === "model_routing")
      .filter((rule) => !isCooling(history, latestInjections, rule, true, input.humanOrdinal))
      .sort(comparePriority);
    for (const rule of availableModels.slice(0, MODEL_ROUTING_RESERVATION_LIMIT)) addRule(rule, "start");
    const availableAlwaysOn = orderAlwaysOnByTopic(alwaysOn.filter((rule) => rule.topicKey !== "model_routing"))
      .filter((rule) => !selectedKeys.has(injectionKey(rule.bundleKey, rule.version)))
      .filter((rule) =>
      !isCooling(history, latestInjections, rule, true, input.humanOrdinal),
    );
    const chosenAlwaysOn = availableAlwaysOn.slice(0, START_RULE_LIMIT - selected.length);
    for (const rule of chosenAlwaysOn) addRule(rule, "start");
    const remainingSlots = START_RULE_LIMIT - selected.length;
    const chosenProjectRules = retrieval.projectRules
      .filter((rule) => rule.topicKey !== "model_routing")
      .filter((rule) => !selectedKeys.has(injectionKey(rule.bundleKey, rule.version)))
      .filter((rule) => !isCooling(history, latestInjections, rule, true, input.humanOrdinal))
      .slice(0, remainingSlots);
    for (const rule of chosenProjectRules) addRule(rule, "start");
    const omittedKeys = new Set(deliveryRules
      .filter((rule) => !selectedKeys.has(injectionKey(rule.bundleKey, rule.version)))
      .map((rule) => injectionKey(rule.bundleKey, rule.version)));
    const startUnreached = unreachedRules(deliveryRules, history, omittedKeys);
    return buildSelection(selected, startUnreached, alwaysOn.length, retrieval.ftsCandidateCount);
  }

  const recentCorrections = deliveryRules.filter((rule) => {
    const latest = latestInjections.get(injectionKey(rule.bundleKey, rule.version));
    return hasRecentCorrection(history, rule, latest);
  });
  const restorationCandidates = [
    ...recentCorrections,
    ...deliveryRules.filter((rule) => !successfulKeys.has(injectionKey(rule.bundleKey, rule.version))),
  ].filter((rule, index, rules) => rules.findIndex((entry) => entry.bundleKey === rule.bundleKey && entry.version === rule.version) === index);

  const restorationOrder = restorationCandidates.filter((rule) =>
    !isCooling(history, latestInjections, rule, true, input.humanOrdinal),
  );

  if (input.trigger === "refresh") {
    if (restorationOrder.length > 0) {
      for (const rule of restorationOrder.slice(0, RESTORE_RULE_LIMIT)) addRule(rule, "restore");
      return buildSelection(selected, unreached, alwaysOn.length, retrieval.ftsCandidateCount);
    }
    if (isRefreshOrdinal(input.humanOrdinal)) {
      const refreshRules = orderForRefresh(alwaysOn, latestInjections)
        .filter((rule) => !isCooling(history, latestInjections, rule, true, input.humanOrdinal))
        .slice(0, FULL_REFRESH_LIMIT);
      for (const rule of refreshRules) addRule(rule, "refresh");
    }
    return buildSelection(selected, unreached, alwaysOn.length, retrieval.ftsCandidateCount);
  }

  for (const rule of restorationOrder.slice(0, RESTORE_RULE_LIMIT)) addRule(rule, "restore");

  if (isRefreshOrdinal(input.humanOrdinal) && selected.length < PROMPT_RULE_LIMIT) {
    const refreshRules = orderForRefresh(alwaysOn, latestInjections)
      .filter((rule) => !selectedKeys.has(injectionKey(rule.bundleKey, rule.version)))
      .filter((rule) => !isCooling(history, latestInjections, rule, true, input.humanOrdinal))
      .slice(0, PROMPT_REFRESH_LIMIT);
    for (const rule of refreshRules) addRule(rule, "refresh");
  }

  for (const rule of retrieval.related) {
    if (selected.length >= PROMPT_RULE_LIMIT || selected.filter((entry) => entry.delivery === "related").length >= RELATED_RULE_LIMIT) break;
    if (isCooling(history, latestInjections, rule, true, input.humanOrdinal)) continue;
    addRule(rule, "related");
  }

  return buildSelection(selected, unreached, alwaysOn.length, retrieval.ftsCandidateCount);
}
