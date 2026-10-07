import type Database from "better-sqlite3";
import { readCorrectionFeatureModes, type CorrectionFeatureModes } from "./environment-mode.js";
import type { CorrectionRule } from "./render.js";
import {
  CORRECTION_COMPLIANCE_SCHEMA_VERSION,
  CORRECTION_PRINCIPLES_SCHEMA_VERSION,
} from "../storage/correction-schema.js";
import { getSchemaVersion } from "../storage/schema.js";
import { isCorrectionComplianceEnabled } from "./compliance.js";
import { getActiveCorrectionGraduationKeys } from "./graduation.js";
import { correctionPrincipleCandidateFilter } from "./principles.js";
import {
  retrieveCorrectionCandidates,
  scoreCorrectionRelevance,
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
const CANDIDATE_RULE_LIMIT = 2;
const COOLDOWN_HUMAN_TURNS = 10;
const COMPLIANCE_RESTORE_LIMIT = 3;

export type CorrectionInjectionTrigger = "start" | "prompt" | "refresh" | "compact";

export interface CorrectionInjectionRequest extends CorrectionRetrievalInput {
  sessionIdHash: string;
  compactEpoch: number;
  humanOrdinal: number;
  trigger: CorrectionInjectionTrigger;
  detectedStoredCorrectionBundleKeys?: readonly string[];
  featureModes?: CorrectionFeatureModes;
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
  correctionMatchedReinjectionKeys: string[];
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
  source: "utterance_detection" | "request_repeat" | "legacy_import";
}

interface CorrectionPrincipleMember {
  principle_key: string;
  member_key: string;
}

interface SessionHistory {
  injections: InjectionHistoryRow[];
  evidencePositions: CorrectionEvidencePosition[];
  principleMembers: CorrectionPrincipleMember[];
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

function readSessionHistory(
  storage: SQLiteStorage,
  input: CorrectionInjectionRequest,
  principlesMode: CorrectionFeatureModes["principles"],
): SessionHistory {
  return storage.runCorrectionTransaction(({ db }) => {
    const injections = db.prepare(`
      SELECT bundle_key, version, human_ordinal, trigger, emitted_at, output_order, body_included, stdout_status
      FROM owner_correction_injections
      WHERE session_id_hash = ? AND compact_epoch = ?
      ORDER BY human_ordinal, output_order, bundle_key
    `).all(input.sessionIdHash, input.compactEpoch) as InjectionHistoryRow[];
    const evidencePositions = db.prepare(`
      SELECT e.bundle_key, e.source, event.human_ordinal
      FROM owner_correction_evidence e
      JOIN owner_correction_events event ON event.event_id = e.event_id
      WHERE event.session_id_hash = ? AND event.human_ordinal <= ?
      ORDER BY event.human_ordinal, e.bundle_key
    `).all(input.sessionIdHash, input.humanOrdinal) as CorrectionEvidencePosition[];
    let principleMembers: CorrectionPrincipleMember[] = [];
    if (principlesMode === "on" && getSchemaVersion(db as unknown as Database.Database) >= CORRECTION_PRINCIPLES_SCHEMA_VERSION) {
      principleMembers = db.prepare(`
        SELECT member.principle_key, member.member_key
        FROM owner_correction_principle_members AS member
        JOIN owner_correction_bundles AS principle
          ON principle.bundle_key = member.principle_key
        JOIN owner_correction_versions AS version
          ON version.bundle_key = principle.bundle_key AND version.version = principle.version
        JOIN memories AS memory
          ON memory.id = principle.memory_id
        WHERE principle.status = 'confirmed'
          AND principle.confirmed_at IS NOT NULL
          AND julianday(principle.confirmed_at) <= julianday(?)
          AND version.status = 'confirmed'
          AND version.confirmed_at IS NOT NULL
          AND julianday(version.confirmed_at) <= julianday(?)
          AND (principle.expires_at IS NULL OR julianday(principle.expires_at) > julianday(?))
          AND (version.expires_at IS NULL OR julianday(version.expires_at) > julianday(?))
          AND julianday(member.attached_at) <= julianday(?)
          AND memory.state = 'active'
          AND memory.category = 'dont'
        ORDER BY member.principle_key, member.member_key
      `).all(input.at, input.at, input.at, input.at, input.at) as CorrectionPrincipleMember[];
    }
    return { injections, evidencePositions, principleMembers };
  });
}

function readComplianceRestoreRules(
  storage: SQLiteStorage,
  input: CorrectionInjectionRequest,
  principlesMode: CorrectionFeatureModes["principles"],
): RetrievedCorrectionRule[] {
  if (!isCorrectionComplianceEnabled()) return [];
  if (input.trigger !== "prompt" && input.trigger !== "refresh") return [];

  return storage.runCorrectionTransaction(({ db }) => {
    if (getSchemaVersion(db as unknown as Database.Database) < CORRECTION_COMPLIANCE_SCHEMA_VERSION) return [];
    const exclusion = correctionPrincipleCandidateFilter(
      db as unknown as Database.Database,
      input.at,
      "bundle",
      principlesMode,
    );
    return db.prepare(`
      SELECT violation.bundle_key, violation.version, memory.title, version.rule_text, bundle.topic_key,
        bundle.condition_key, bundle.visibility, bundle.project, bundle.scope, bundle.intensity,
        bundle.session_count, bundle.last_seen_at, bundle.expires_at, bundle.lifetime_kind,
        bundle.continuation_basis
      FROM owner_correction_violations AS violation
      JOIN owner_correction_bundles AS bundle
        ON bundle.bundle_key = violation.bundle_key
      JOIN owner_correction_versions AS version
        ON version.bundle_key = violation.bundle_key AND version.version = violation.version
      JOIN memories AS memory
        ON memory.id = bundle.memory_id
      WHERE violation.session_id_hash = ?
        AND violation.human_ordinal < ?
        AND bundle.status = 'confirmed'
        AND bundle.version = violation.version
        AND version.status = 'confirmed'
        AND memory.state = 'active'
        AND memory.category = 'dont'
        AND (bundle.expires_at IS NULL OR bundle.expires_at > ?)
        AND (
          SELECT COUNT(DISTINCT reinjection.human_ordinal)
          FROM owner_correction_injections AS reinjection
          WHERE reinjection.session_id_hash = violation.session_id_hash
            AND reinjection.bundle_key = violation.bundle_key
            AND reinjection.version = violation.version
            AND reinjection.human_ordinal > (
              SELECT MIN(first_violation.human_ordinal)
              FROM owner_correction_violations AS first_violation
              WHERE first_violation.session_id_hash = violation.session_id_hash
                AND first_violation.bundle_key = violation.bundle_key
                AND first_violation.version = violation.version
            )
            AND reinjection.trigger IN ('prompt','refresh')
            AND reinjection.body_included = 1
            AND reinjection.stdout_status = 'emitted'
        ) < 2
        ${exclusion.sql}
      GROUP BY violation.bundle_key, violation.version
      ORDER BY MAX(violation.detected_at) DESC, bundle.intensity DESC, violation.bundle_key
      LIMIT ${COMPLIANCE_RESTORE_LIMIT}
    `).all(input.sessionIdHash, input.humanOrdinal, input.at, ...exclusion.parameters) as Array<{
      bundle_key: string;
      version: number;
      title: string;
      rule_text: string;
      topic_key: string;
      condition_key: string;
      visibility: "owner" | "project";
      project: string;
      scope: string;
      intensity: number;
      session_count: number;
      last_seen_at: string;
      expires_at: string | null;
      lifetime_kind: "explicit_continuing" | "inferred" | "task" | "routing";
      continuation_basis: string;
    }>;
  }).map((row) => ({
    bundleKey: row.bundle_key,
    version: row.version,
    title: row.title,
    ruleText: row.rule_text,
    topicKey: row.topic_key,
    conditionKey: row.condition_key,
    visibility: row.visibility,
    project: row.project,
    scope: row.scope,
    intensity: row.intensity,
    sessionCount: row.session_count,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    lifetimeKind: row.lifetime_kind,
    continuationBasis: row.continuation_basis,
  }));
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

function principleKeysForBundle(
  bundleKey: string,
  principleMembers: readonly CorrectionPrincipleMember[],
): Set<string> {
  return new Set(principleMembers
    .filter((member) => member.principle_key === bundleKey || member.member_key === bundleKey)
    .map((member) => member.principle_key));
}

function correctionBundlesMatch(
  targetBundleKey: string,
  detectedBundleKey: string,
  principleMembers: readonly CorrectionPrincipleMember[],
): boolean {
  if (targetBundleKey === detectedBundleKey) return true;
  const targetPrincipleKeys = principleKeysForBundle(targetBundleKey, principleMembers);
  if (targetPrincipleKeys.size === 0) return false;
  const detectedPrincipleKeys = principleKeysForBundle(detectedBundleKey, principleMembers);
  return Array.from(targetPrincipleKeys).some((principleKey) => detectedPrincipleKeys.has(principleKey));
}

function isCorrectionReinjectionEnabled(input: CorrectionInjectionRequest): boolean {
  const featureModes = input.featureModes ?? readCorrectionFeatureModes();
  return featureModes.reinjection === "on";
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

function hasRecentCorrection(
  history: SessionHistory,
  rule: RetrievedCorrectionRule,
  latest: InjectionHistoryRow | undefined,
): boolean {
  if (!latest) return false;
  return latestEvidenceAfter(history, rule.bundleKey, latest.human_ordinal) !== null;
}

function hasCurrentCorrectionMatch(
  history: SessionHistory,
  rule: RetrievedCorrectionRule,
  latest: InjectionHistoryRow | undefined,
  input: CorrectionInjectionRequest,
): boolean {
  if (!latest) return false;
  if (input.humanOrdinal <= latest.human_ordinal) return false;
  const detectedBundleKeys = currentCorrectionBundleKeys(history, input);
  return detectedBundleKeys.some((bundleKey) =>
    correctionBundlesMatch(rule.bundleKey, bundleKey, history.principleMembers),
  );
}

function currentCorrectionBundleKeys(
  history: SessionHistory,
  input: CorrectionInjectionRequest,
): string[] {
  return [
    ...history.evidencePositions
      .filter((evidence) => evidence.human_ordinal === input.humanOrdinal && evidence.source === "utterance_detection")
      .map((evidence) => evidence.bundle_key),
    ...(input.detectedStoredCorrectionBundleKeys ?? []),
  ];
}

function relatedPrincipleReinjectionRules(
  storage: SQLiteStorage,
  input: CorrectionInjectionRequest,
  featureModes: CorrectionFeatureModes,
  history: SessionHistory,
  latestInjections: Map<string, InjectionHistoryRow>,
): RetrievedCorrectionRule[] {
  if (featureModes.principles !== "on" || featureModes.reinjection !== "on") return [];
  if (input.trigger !== "prompt" && input.trigger !== "refresh") return [];
  if (history.principleMembers.length === 0) return [];
  const detectedBundleKeys = currentCorrectionBundleKeys(history, input);
  const hasCoolingPrincipleMatch = Array.from(latestInjections.values()).some((latest) => {
    if (input.humanOrdinal <= latest.human_ordinal) return false;
    if (input.humanOrdinal - latest.human_ordinal > COOLDOWN_HUMAN_TURNS) return false;
    return detectedBundleKeys.some((bundleKey) =>
      correctionBundlesMatch(latest.bundle_key, bundleKey, history.principleMembers),
    );
  });
  if (!hasCoolingPrincipleMatch) return [];

  const memberRetrieval = retrieveCorrectionCandidates(storage, input, {
    ...featureModes,
    principles: "shadow",
  });
  return memberRetrieval.related.filter((rule) =>
    isCorrectionMatchedCooldownRelease(history, latestInjections, rule, input),
  );
}

function hasCooldownReleaseEvidence(
  history: SessionHistory,
  rule: RetrievedCorrectionRule,
  latest: InjectionHistoryRow | undefined,
  input: CorrectionInjectionRequest,
): boolean {
  if (!latest) return false;
  if (!isCorrectionReinjectionEnabled(input)) return hasRecentCorrection(history, rule, latest);
  return hasCurrentCorrectionMatch(history, rule, latest, input);
}

function isCooling(
  history: SessionHistory,
  latestInjections: Map<string, InjectionHistoryRow>,
  rule: RetrievedCorrectionRule,
  allowRecentCorrection: boolean,
  input: CorrectionInjectionRequest,
): boolean {
  const latest = latestInjections.get(injectionKey(rule.bundleKey, rule.version));
  if (!latest) return false;
  if (allowRecentCorrection && hasCooldownReleaseEvidence(history, rule, latest, input)) return false;
  if (input.humanOrdinal < latest.human_ordinal) return true;
  return input.humanOrdinal - latest.human_ordinal <= COOLDOWN_HUMAN_TURNS;
}

function shouldReinjectRelatedDuringCooldown(
  input: CorrectionInjectionRequest,
  history: SessionHistory,
  latestInjections: Map<string, InjectionHistoryRow>,
  rule: RetrievedCorrectionRule,
): boolean {
  if ((input.trigger !== "prompt" && input.trigger !== "refresh") || !isCorrectionReinjectionEnabled(input)) return false;
  const latest = latestInjections.get(injectionKey(rule.bundleKey, rule.version));
  if (!latest || !isCooling(history, latestInjections, rule, false, input)) return false;
  return hasCurrentCorrectionMatch(history, rule, latest, input);
}

function isCorrectionMatchedCooldownRelease(
  history: SessionHistory,
  latestInjections: Map<string, InjectionHistoryRow>,
  rule: RetrievedCorrectionRule,
  input: CorrectionInjectionRequest,
): boolean {
  if (!isCorrectionReinjectionEnabled(input)) return false;
  const latest = latestInjections.get(injectionKey(rule.bundleKey, rule.version));
  if (!latest || input.humanOrdinal <= latest.human_ordinal) return false;
  if (input.humanOrdinal - latest.human_ordinal > COOLDOWN_HUMAN_TURNS) return false;
  return hasCurrentCorrectionMatch(history, rule, latest, input);
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

function makeCorrectionRule(
  rule: RetrievedCorrectionRule,
  delivery: CorrectionRule["delivery"],
  complianceViolation = false,
): CorrectionRule {
  return {
    bundleKey: rule.bundleKey,
    version: rule.version,
    title: rule.title,
    ruleText: rule.ruleText,
    delivery,
    complianceViolation,
  };
}

function makeCandidateCorrectionRule(rule: RetrievedCorrectionRule): CorrectionRule {
  return {
    bundleKey: rule.bundleKey,
    version: rule.version,
    title: "仮の注意",
    ruleText: rule.ruleText,
    delivery: "candidate",
    provisional: true,
  };
}

function relevantCandidateRules(
  retrieval: ReturnType<typeof retrieveCorrectionCandidates>,
  input: CorrectionInjectionRequest,
): RetrievedCorrectionRule[] {
  return retrieval.candidates
    .map((rule) => ({
      rule,
      relevance: scoreCorrectionRelevance({
        query: retrieval.query.text,
        queryTerms: retrieval.query.terms,
        ruleText: rule.ruleText,
        topicKey: rule.topicKey,
        conditionKey: rule.conditionKey,
        topicKeys: input.topicKeys,
        toolNames: input.toolNames,
      }),
    }))
    .filter((entry): entry is { rule: RetrievedCorrectionRule; relevance: number } => entry.relevance !== null)
    .sort((left, right) => right.relevance - left.relevance || comparePriority(left.rule, right.rule))
    .map((entry) => entry.rule);
}

function eligibleCandidatePromptRules(
  candidates: readonly RetrievedCorrectionRule[],
  retrieval: ReturnType<typeof retrieveCorrectionCandidates>,
  input: CorrectionInjectionRequest,
  history: SessionHistory,
  latestInjections: Map<string, InjectionHistoryRow>,
): RetrievedCorrectionRule[] {
  const relevantKeys = new Set(relevantCandidateRules(retrieval, input).map((rule) => injectionKey(rule.bundleKey, rule.version)));
  const eligible = candidates.filter((rule) => !isCooling(history, latestInjections, rule, false, input));
  const ordered = [
    ...eligible.filter((rule) => relevantKeys.has(injectionKey(rule.bundleKey, rule.version))),
    ...eligible.filter((rule) => !latestInjections.has(injectionKey(rule.bundleKey, rule.version))).sort(comparePriority),
    ...eligible.filter((rule) => hasCurrentCorrectionMatch(history, rule, latestInjections.get(injectionKey(rule.bundleKey, rule.version)), input)),
  ];
  const seen = new Set<string>();
  return ordered.filter((rule) => {
    const key = injectionKey(rule.bundleKey, rule.version);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  correctionMatchedReinjectionKeys: readonly string[] = [],
): CorrectionInjectionSelection {
  return {
    rules,
    unreached,
    alwaysOnCount,
    ftsCandidateCount,
    correctionMatchedReinjectionKeys: [...correctionMatchedReinjectionKeys],
  };
}

export function selectCorrectionInjections(
  storage: SQLiteStorage,
  input: CorrectionInjectionRequest,
): CorrectionInjectionSelection {
  if (!input.sessionIdHash) throw new Error("correction injection requires a session hash");
  if (!Number.isSafeInteger(input.compactEpoch) || input.compactEpoch < 0) throw new Error("correction compact epoch is invalid");
  if (!Number.isSafeInteger(input.humanOrdinal) || input.humanOrdinal < 0) throw new Error("correction human ordinal is invalid");

  const featureModes = input.featureModes ?? readCorrectionFeatureModes();
  const featureModeInput = { ...input, featureModes };
  const retrieval = retrieveCorrectionCandidates(storage, input, featureModes);
  const candidateInjectionEnabled = featureModes.candidateInjection === "on";
  const reflectedGraduations = getActiveCorrectionGraduationKeys(storage, input.at, undefined, featureModes.graduation);
  const excludeGraduated = input.trigger === "prompt" || input.trigger === "refresh";
  const isAvailable = (rule: RetrievedCorrectionRule): boolean =>
    !excludeGraduated || !reflectedGraduations.has(rule.bundleKey);
  const history = readSessionHistory(storage, input, featureModes.principles);
  const complianceRestoreRules = readComplianceRestoreRules(storage, input, featureModes.principles).filter(isAvailable);
  const complianceRestoreKeys = new Set(complianceRestoreRules.map((rule) => injectionKey(rule.bundleKey, rule.version)));
  const alwaysOn = orderAlwaysOnByTopic(retrieval.alwaysOn.filter(isAvailable));
  const projectRules = retrieval.projectRules.filter(isAvailable);
  const candidateRules = candidateInjectionEnabled && (input.trigger === "start" || input.trigger === "prompt" || input.trigger === "refresh")
    ? retrieval.candidates.filter(isAvailable)
    : [];
  const deliveryRules = requiredDeliveryRules(alwaysOn, projectRules);
  const successfulKeys = new Set(
    successfulHistory(history).map((row) => injectionKey(row.bundle_key, row.version)),
  );
  const latestInjections = latestSuccessfulInjections(history);
  const relatedRuleMap = new Map<string, RetrievedCorrectionRule>();
  for (const rule of retrieval.related.filter(isAvailable)) {
    relatedRuleMap.set(injectionKey(rule.bundleKey, rule.version), rule);
  }
  for (const rule of relatedPrincipleReinjectionRules(storage, featureModeInput, featureModes, history, latestInjections).filter(isAvailable)) {
    const key = injectionKey(rule.bundleKey, rule.version);
    if (!relatedRuleMap.has(key)) relatedRuleMap.set(key, rule);
  }
  const relatedRules = [...relatedRuleMap.values()];
  const unreached = unreachedRules(deliveryRules, history);
  const selected: CorrectionRule[] = [];
  const selectedKeys = new Set<string>();
  const correctionMatchedReinjectionKeys = new Set<string>();
  const addRule = (
    rule: RetrievedCorrectionRule,
    delivery: CorrectionRule["delivery"],
    complianceViolation = false,
  ): boolean => {
    const key = injectionKey(rule.bundleKey, rule.version);
    if (selectedKeys.has(key)) return false;
    selectedKeys.add(key);
    selected.push(makeCorrectionRule(rule, delivery, complianceViolation));
    if (isCorrectionMatchedCooldownRelease(history, latestInjections, rule, featureModeInput)) {
      correctionMatchedReinjectionKeys.add(key);
    }
    return true;
  };
  const addCandidateRule = (rule: RetrievedCorrectionRule): boolean => {
    const key = injectionKey(rule.bundleKey, rule.version);
    if (selectedKeys.has(key)) return false;
    selectedKeys.add(key);
    selected.push(makeCandidateCorrectionRule(rule));
    return true;
  };
  const addCandidatePromptRules = (limit: number): void => {
    if (limit <= 0) return;
    const relatedCandidates = eligibleCandidatePromptRules(candidateRules, retrieval, featureModeInput, history, latestInjections)
      .filter(isAvailable)
      .filter((rule) => !selectedKeys.has(injectionKey(rule.bundleKey, rule.version)))
      .slice(0, Math.min(CANDIDATE_RULE_LIMIT, limit));
    for (const rule of relatedCandidates) addCandidateRule(rule);
  };
  const hasAttemptForTrigger = history.injections.some((row) => row.trigger === input.trigger);

  if (input.trigger === "start" || input.trigger === "compact") {
    if (hasAttemptForTrigger) return buildSelection([], unreached, alwaysOn.length, retrieval.ftsCandidateCount);
    const availableModels = deliveryRules
      .filter((rule) => rule.topicKey === "model_routing")
      .filter((rule) => !isCooling(history, latestInjections, rule, true, featureModeInput))
      .sort(comparePriority);
    for (const rule of availableModels.slice(0, MODEL_ROUTING_RESERVATION_LIMIT)) addRule(rule, "start");
    const availableAlwaysOn = orderAlwaysOnByTopic(alwaysOn.filter((rule) => rule.topicKey !== "model_routing"))
      .filter((rule) => !selectedKeys.has(injectionKey(rule.bundleKey, rule.version)))
      .filter((rule) =>
      !isCooling(history, latestInjections, rule, true, featureModeInput),
    );
    const chosenAlwaysOn = availableAlwaysOn.slice(0, START_RULE_LIMIT - selected.length);
    for (const rule of chosenAlwaysOn) addRule(rule, "start");
    const remainingSlots = START_RULE_LIMIT - selected.length;
    const chosenProjectRules = projectRules
      .filter((rule) => rule.topicKey !== "model_routing")
      .filter((rule) => !selectedKeys.has(injectionKey(rule.bundleKey, rule.version)))
      .filter((rule) => !isCooling(history, latestInjections, rule, true, featureModeInput))
      .slice(0, remainingSlots);
    for (const rule of chosenProjectRules) addRule(rule, "start");
    const candidateSlots = Math.max(0, START_RULE_LIMIT - selected.length);
    const startCandidates = [...candidateRules]
      .sort(comparePriority)
      .filter((rule) => !selectedKeys.has(injectionKey(rule.bundleKey, rule.version)))
      .slice(0, Math.min(CANDIDATE_RULE_LIMIT, candidateSlots));
    for (const rule of startCandidates) addCandidateRule(rule);
    const omittedKeys = new Set(deliveryRules
      .filter((rule) => !selectedKeys.has(injectionKey(rule.bundleKey, rule.version)))
      .map((rule) => injectionKey(rule.bundleKey, rule.version)));
    const startUnreached = unreachedRules(deliveryRules, history, omittedKeys);
    return buildSelection(selected, startUnreached, alwaysOn.length, retrieval.ftsCandidateCount, [...correctionMatchedReinjectionKeys]);
  }

  const recentCorrections = deliveryRules.filter((rule) => {
    const latest = latestInjections.get(injectionKey(rule.bundleKey, rule.version));
    return hasCooldownReleaseEvidence(history, rule, latest, featureModeInput);
  });
  const restorationCandidates = [
    ...complianceRestoreRules,
    ...recentCorrections,
    ...deliveryRules.filter((rule) => !successfulKeys.has(injectionKey(rule.bundleKey, rule.version))),
  ].filter((rule, index, rules) => rules.findIndex((entry) => entry.bundleKey === rule.bundleKey && entry.version === rule.version) === index);

  const restorationOrder = restorationCandidates.filter((rule) =>
    complianceRestoreKeys.has(injectionKey(rule.bundleKey, rule.version)) ||
      !isCooling(history, latestInjections, rule, true, featureModeInput),
  );
  const restoreLimit = Math.max(RESTORE_RULE_LIMIT, complianceRestoreRules.length);

  if (input.trigger === "refresh") {
    const refreshCandidateLimit = complianceRestoreRules.length > 0
      ? Math.max(3, complianceRestoreRules.length)
      : FULL_REFRESH_LIMIT;
    const appendRefreshCandidates = (): void => {
      if (isRefreshOrdinal(input.humanOrdinal)) {
        addCandidatePromptRules(refreshCandidateLimit - selected.length);
      }
    };
    const relatedReinjections = isRefreshOrdinal(input.humanOrdinal)
      ? relatedRules
        .filter((rule) => isCooling(history, latestInjections, rule, false, featureModeInput))
        .filter((rule) => shouldReinjectRelatedDuringCooldown(featureModeInput, history, latestInjections, rule))
        .slice(0, FULL_REFRESH_LIMIT)
      : [];
    if (restorationOrder.length > 0) {
      const priorityRestorations = restorationOrder.filter((rule) =>
        complianceRestoreKeys.has(injectionKey(rule.bundleKey, rule.version)),
      );
      const remainingRestorations = restorationOrder.filter((rule) =>
        !complianceRestoreKeys.has(injectionKey(rule.bundleKey, rule.version)),
      );
      for (const rule of priorityRestorations.slice(0, restoreLimit)) {
        const complianceViolation = complianceRestoreKeys.has(injectionKey(rule.bundleKey, rule.version));
        addRule(rule, "restore", complianceViolation);
      }
      for (const rule of relatedReinjections) {
        if (selected.length >= restoreLimit) break;
        addRule(rule, "refresh");
      }
      for (const rule of remainingRestorations) {
        if (selected.length >= restoreLimit) break;
        addRule(rule, "restore");
      }
      appendRefreshCandidates();
      return buildSelection(selected, unreached, alwaysOn.length, retrieval.ftsCandidateCount, [...correctionMatchedReinjectionKeys]);
    }
    if (isRefreshOrdinal(input.humanOrdinal)) {
      for (const rule of relatedReinjections) addRule(rule, "refresh");
      const refreshRules = orderForRefresh(alwaysOn, latestInjections)
        .filter((rule) => !selectedKeys.has(injectionKey(rule.bundleKey, rule.version)))
        .filter((rule) => !isCooling(history, latestInjections, rule, true, featureModeInput))
        .slice(0, FULL_REFRESH_LIMIT - selected.length);
      for (const rule of refreshRules) addRule(rule, "refresh");
    }
    appendRefreshCandidates();
    return buildSelection(selected, unreached, alwaysOn.length, retrieval.ftsCandidateCount, [...correctionMatchedReinjectionKeys]);
  }

  for (const rule of restorationOrder.slice(0, restoreLimit)) {
    const complianceViolation = complianceRestoreKeys.has(injectionKey(rule.bundleKey, rule.version));
    addRule(rule, "restore", complianceViolation);
  }

  if (isRefreshOrdinal(input.humanOrdinal) && selected.length < PROMPT_RULE_LIMIT) {
    const refreshRules = orderForRefresh(alwaysOn, latestInjections)
      .filter((rule) => !selectedKeys.has(injectionKey(rule.bundleKey, rule.version)))
      .filter((rule) => !isCooling(history, latestInjections, rule, true, featureModeInput))
      .slice(0, PROMPT_REFRESH_LIMIT);
    for (const rule of refreshRules) addRule(rule, "refresh");
  }

  for (const rule of relatedRules) {
    if (selected.length >= PROMPT_RULE_LIMIT || selected.filter((entry) => entry.delivery === "related").length >= RELATED_RULE_LIMIT) break;
    const allowRecentCorrection = !isCorrectionReinjectionEnabled(featureModeInput);
    if (isCooling(history, latestInjections, rule, allowRecentCorrection, featureModeInput)
      && !shouldReinjectRelatedDuringCooldown(featureModeInput, history, latestInjections, rule)) continue;
    addRule(rule, "related");
  }

  if (input.trigger === "prompt" && selected.length < PROMPT_RULE_LIMIT) {
    addCandidatePromptRules(PROMPT_RULE_LIMIT - selected.length);
  }

  return buildSelection(selected, unreached, alwaysOn.length, retrieval.ftsCandidateCount, [...correctionMatchedReinjectionKeys]);
}
