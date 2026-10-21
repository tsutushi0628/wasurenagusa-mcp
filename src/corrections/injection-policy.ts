import { readFileSync } from "fs";
import { resolve } from "path";
import type Database from "better-sqlite3";
import { readCorrectionFeatureModes, type CorrectionFeatureModes } from "./environment-mode.js";
import type { CorrectionRule } from "./render.js";
import {
  CORRECTION_COMPLIANCE_SCHEMA_VERSION,
  CORRECTION_PRINCIPLES_SCHEMA_VERSION,
} from "../storage/correction-schema.js";
import { getSchemaVersion } from "../storage/schema.js";
import { isCorrectionComplianceEnabled } from "./compliance.js";
import { correctionPrincipleCandidateFilter } from "./principles.js";
import { parseCorrectionRuleInput } from "./rule-template.js";
import { isPendingOutputLedger, supportsPendingOutputLedger } from "./session-store.js";
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
  projectRoot: string;
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
  rulingsExcludedCount: number;
  correctionMatchedReinjectionKeys: string[];
}

function normalizeRulingText(text: string): string {
  return text.normalize("NFKC").trim().replace(/[。.!?]+$/u, "").trim();
}

function readRulingTexts(projectRoot: string, projectName: string): ReadonlySet<string> {
  let rulingsPath = process.env.WASURENAGUSA_RULINGS_PATH;
  if (rulingsPath === undefined) {
    rulingsPath = resolve(projectRoot, ".claude", "rulings", "rulings.json");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(rulingsPath, "utf8"));
  } catch {
    return new Set<string>();
  }
  if (typeof parsed !== "object" || parsed === null || !("rulings" in parsed) || !Array.isArray(parsed.rulings)) {
    return new Set<string>();
  }

  const texts = new Set<string>();
  for (const ruling of parsed.rulings) {
    if (typeof ruling !== "object" || ruling === null) continue;
    if (ruling.status !== "active" && ruling.status !== "fixed") continue;
    if (ruling.scope !== "main" && ruling.scope !== "all") continue;
    if (ruling.project !== null && ruling.project !== projectName) continue;
    if (typeof ruling.rule !== "string" || !Array.isArray(ruling.quotes)) continue;
    if (ruling.quotes.some((quote: unknown) =>
      typeof quote !== "object" || quote === null || !("text" in quote) || typeof quote.text !== "string",
    )) continue;
    const ruleText = normalizeRulingText(ruling.rule);
    if (ruleText !== "") texts.add(ruleText);
    for (const quote of ruling.quotes) {
      const quoteText = normalizeRulingText(quote.text);
      if (quoteText !== "") texts.add(quoteText);
    }
  }
  return texts;
}

function readRulingEvidenceKeys(
  storage: SQLiteStorage,
  rulingTexts: ReadonlySet<string>,
  candidateBundleKeys: ReadonlySet<string>,
  principleMembers: readonly CorrectionPrincipleMember[],
): ReadonlySet<string> {
  const keys = new Set<string>();
  if (rulingTexts.size === 0 || candidateBundleKeys.size === 0) return keys;
  const evidenceBundleKeys = new Set(candidateBundleKeys);
  const principlesByMember = new Map<string, Set<string>>();
  for (const member of principleMembers) {
    if (!candidateBundleKeys.has(member.principle_key)) continue;
    evidenceBundleKeys.add(member.member_key);
    let principleKeys = principlesByMember.get(member.member_key);
    if (principleKeys === undefined) {
      principleKeys = new Set<string>();
      principlesByMember.set(member.member_key, principleKeys);
    }
    principleKeys.add(member.principle_key);
    if (rulingTexts.has(normalizeRulingText(member.rule_text))) keys.add(member.member_key);
  }
  storage.runCorrectionTransaction(({ db }) => {
    const rows = db.prepare(`
      SELECT DISTINCT evidence.bundle_key, event.excerpt, evidence.conditions
      FROM owner_correction_evidence AS evidence
      JOIN owner_correction_events AS event ON event.event_id = evidence.event_id
      WHERE evidence.bundle_key IN (${[...evidenceBundleKeys].map(() => "?").join(", ")})
    `).all(...evidenceBundleKeys) as Array<{ bundle_key: string; excerpt: string; conditions: string }>;
    for (const row of rows) {
      if (rulingTexts.has(normalizeRulingText(row.excerpt))) keys.add(row.bundle_key);
      const evidenceInput = parseCorrectionRuleInput(row.conditions);
      if (evidenceInput !== null && evidenceInput.commandText !== undefined
        && rulingTexts.has(normalizeRulingText(evidenceInput.commandText))) {
        keys.add(row.bundle_key);
      }
    }
  });
  for (const [memberKey, principleKeys] of principlesByMember) {
    if (!keys.has(memberKey)) continue;
    for (const principleKey of principleKeys) keys.add(principleKey);
  }
  return keys;
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
  rule_text: string;
}

interface SessionHistory {
  injections: InjectionHistoryRow[];
  evidencePositions: CorrectionEvidencePosition[];
  principleMembers: CorrectionPrincipleMember[];
  skipSelection: boolean;
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
    if (supportsPendingOutputLedger(db)) {
      const pendingOutputs = db.prepare(`
        SELECT last_confirmed_ordinal, output_ledger, output_hash, output_callback_succeeded_at
        FROM owner_correction_pending
        WHERE session_id_hash = ? AND matched_event_id IS NULL
          AND output_callback_succeeded_at IS NOT NULL AND output_ledger IS NOT NULL
          AND output_hash IS NOT NULL
          AND (output_epoch = ? OR (? = 'compact' AND output_epoch < ?))
        ORDER BY received_at, receipt_id
      `).all(input.sessionIdHash, input.compactEpoch, input.trigger, input.compactEpoch) as Array<{
        last_confirmed_ordinal: number;
        output_ledger: string;
        output_hash: string;
        output_callback_succeeded_at: string;
      }>;
      for (const pending of pendingOutputs) {
        const output: unknown = JSON.parse(pending.output_ledger);
        if (!isPendingOutputLedger(output)) continue;
        if (output.entries.some((entry) => !entry.bodyIncluded || entry.outputHash !== pending.output_hash)) continue;
        for (const entry of output.entries) {
          injections.push({
            bundle_key: entry.bundleKey,
            version: entry.version,
            human_ordinal: pending.last_confirmed_ordinal + 1,
            trigger: output.trigger,
            emitted_at: pending.output_callback_succeeded_at,
            output_order: entry.outputOrder,
            body_included: 1,
            stdout_status: "emitted",
          });
        }
      }
    }
    const skipSelection = (input.trigger === "start" || input.trigger === "compact")
      && injections.some((row) => row.trigger === input.trigger);
    if (skipSelection) return { injections, evidencePositions: [], principleMembers: [], skipSelection };
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
        SELECT member.principle_key, member.member_key, member_bundle.rule_text
        FROM owner_correction_principle_members AS member
        JOIN owner_correction_bundles AS member_bundle
          ON member_bundle.bundle_key = member.member_key
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
    return { injections, evidencePositions, principleMembers, skipSelection };
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
  rulingsExcludedCount: number,
  correctionMatchedReinjectionKeys: readonly string[] = [],
): CorrectionInjectionSelection {
  return {
    rules,
    unreached,
    alwaysOnCount,
    ftsCandidateCount,
    rulingsExcludedCount,
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
  const history = readSessionHistory(storage, input, featureModes.principles);
  let retrievalFeatureModes = featureModes;
  if (history.skipSelection) retrievalFeatureModes = { ...featureModes, candidateInjection: "off" };
  const retrieval = retrieveCorrectionCandidates(storage, input, retrievalFeatureModes);
  const candidateInjectionEnabled = featureModes.candidateInjection === "on";
  let alwaysOn = orderAlwaysOnByTopic(retrieval.alwaysOn);
  const projectRules = retrieval.projectRules;
  let candidateRules: RetrievedCorrectionRule[] = [];
  if (candidateInjectionEnabled && input.trigger !== "compact") {
    candidateRules = retrieval.candidates;
  }
  let deliveryRules = requiredDeliveryRules(alwaysOn, projectRules);
  const rulingTexts = readRulingTexts(input.projectRoot, input.project);
  if (history.skipSelection) {
    const unmatchedDeliveryRules = deliveryRules.filter((rule) => !rulingTexts.has(normalizeRulingText(rule.ruleText)));
    const alwaysOnCount = alwaysOn.filter((rule) => !rulingTexts.has(normalizeRulingText(rule.ruleText))).length;
    return buildSelection([], unreachedRules(unmatchedDeliveryRules, history), alwaysOnCount, retrieval.ftsCandidateCount, deliveryRules.length - unmatchedDeliveryRules.length);
  }
  const successfulKeys = new Set(
    successfulHistory(history).map((row) => injectionKey(row.bundle_key, row.version)),
  );
  const latestInjections = latestSuccessfulInjections(history);
  const relatedRuleMap = new Map<string, RetrievedCorrectionRule>();
  if (input.trigger === "prompt" || input.trigger === "refresh") {
    for (const rule of retrieval.related) {
      relatedRuleMap.set(injectionKey(rule.bundleKey, rule.version), rule);
    }
    for (const rule of relatedPrincipleReinjectionRules(storage, featureModeInput, featureModes, history, latestInjections)) {
      const key = injectionKey(rule.bundleKey, rule.version);
      if (!relatedRuleMap.has(key)) relatedRuleMap.set(key, rule);
    }
  }
  const relatedRules = [...relatedRuleMap.values()];
  const complianceRestoreCandidates = readComplianceRestoreRules(storage, input, featureModes.principles);
  const evidenceCandidates = [...deliveryRules, ...candidateRules, ...relatedRules, ...complianceRestoreCandidates];
  if (input.trigger === "start" || input.trigger === "compact") {
    evidenceCandidates.push(...projectRules);
  }
  const rulingEvidenceKeys = readRulingEvidenceKeys(
    storage,
    rulingTexts,
    new Set(evidenceCandidates.map((rule) => rule.bundleKey)),
    history.principleMembers,
  );
  const matchesRuling = (rule: RetrievedCorrectionRule): boolean =>
    rulingTexts.has(normalizeRulingText(rule.ruleText)) || rulingEvidenceKeys.has(rule.bundleKey);
  const rulingsExcludedKeys = new Set<string>();
  const isAvailable = (rule: RetrievedCorrectionRule): boolean => {
    if (!matchesRuling(rule)) return true;
    rulingsExcludedKeys.add(injectionKey(rule.bundleKey, rule.version));
    return false;
  };
  alwaysOn = [
    ...orderAlwaysOnByTopic(alwaysOn.filter((rule) => !matchesRuling(rule))),
    ...alwaysOn.filter(matchesRuling),
  ];
  deliveryRules = requiredDeliveryRules(alwaysOn, projectRules);
  const complianceRestoreRules = complianceRestoreCandidates.filter(isAvailable);
  const complianceRestoreKeys = new Set(complianceRestoreRules.map((rule) => injectionKey(rule.bundleKey, rule.version)));
  const alwaysOnCount = alwaysOn.filter((rule) => !matchesRuling(rule)).length;
  const unreached = unreachedRules(deliveryRules.filter((rule) => !matchesRuling(rule)), history);
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
  if (input.trigger === "start" || input.trigger === "compact") {
    const availableModels = deliveryRules
      .filter((rule) => rule.topicKey === "model_routing")
      .filter((rule) => !isCooling(history, latestInjections, rule, true, featureModeInput))
      .filter(isAvailable)
      .sort(comparePriority);
    for (const rule of availableModels.slice(0, MODEL_ROUTING_RESERVATION_LIMIT)) addRule(rule, "start");
    const availableAlwaysOn = orderAlwaysOnByTopic(alwaysOn
      .filter((rule) => rule.topicKey !== "model_routing")
      .filter((rule) => {
        if (isCooling(history, latestInjections, rule, true, featureModeInput)) return !matchesRuling(rule);
        return isAvailable(rule);
      }))
      .filter((rule) => !selectedKeys.has(injectionKey(rule.bundleKey, rule.version)))
      .filter((rule) => !isCooling(history, latestInjections, rule, true, featureModeInput));
    const chosenAlwaysOn = availableAlwaysOn.slice(0, START_RULE_LIMIT - selected.length);
    for (const rule of chosenAlwaysOn) addRule(rule, "start");
    const remainingSlots = START_RULE_LIMIT - selected.length;
    if (remainingSlots > 0) {
      const chosenProjectRules = projectRules
        .filter((rule) => rule.topicKey !== "model_routing")
        .filter((rule) => !selectedKeys.has(injectionKey(rule.bundleKey, rule.version)))
        .filter((rule) => !isCooling(history, latestInjections, rule, true, featureModeInput))
        .filter(isAvailable)
        .slice(0, remainingSlots);
      for (const rule of chosenProjectRules) addRule(rule, "start");
    }
    const candidateSlots = Math.max(0, START_RULE_LIMIT - selected.length);
    if (candidateSlots > 0) {
      const startCandidates = [...candidateRules]
        .sort(comparePriority)
        .filter((rule) => !selectedKeys.has(injectionKey(rule.bundleKey, rule.version)))
        .filter(isAvailable)
        .slice(0, Math.min(CANDIDATE_RULE_LIMIT, candidateSlots));
      for (const rule of startCandidates) addCandidateRule(rule);
    }
    const omittedKeys = new Set(deliveryRules
      .filter((rule) => !selectedKeys.has(injectionKey(rule.bundleKey, rule.version)))
      .map((rule) => injectionKey(rule.bundleKey, rule.version)));
    const startUnreached = unreachedRules(deliveryRules.filter((rule) => !matchesRuling(rule)), history, omittedKeys);
    return buildSelection(selected, startUnreached, alwaysOnCount, retrieval.ftsCandidateCount, rulingsExcludedKeys.size, [...correctionMatchedReinjectionKeys]);
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
  ).filter(isAvailable);
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
        .filter(isAvailable)
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
      return buildSelection(selected, unreached, alwaysOnCount, retrieval.ftsCandidateCount, rulingsExcludedKeys.size, [...correctionMatchedReinjectionKeys]);
    }
    if (isRefreshOrdinal(input.humanOrdinal)) {
      for (const rule of relatedReinjections) addRule(rule, "refresh");
      if (selected.length < FULL_REFRESH_LIMIT) {
        const refreshRules = orderForRefresh(alwaysOn, latestInjections)
          .filter((rule) => !selectedKeys.has(injectionKey(rule.bundleKey, rule.version)))
          .filter((rule) => !isCooling(history, latestInjections, rule, true, featureModeInput))
          .filter(isAvailable)
          .slice(0, FULL_REFRESH_LIMIT - selected.length);
        for (const rule of refreshRules) addRule(rule, "refresh");
      }
    }
    appendRefreshCandidates();
    return buildSelection(selected, unreached, alwaysOnCount, retrieval.ftsCandidateCount, rulingsExcludedKeys.size, [...correctionMatchedReinjectionKeys]);
  }

  for (const rule of restorationOrder.slice(0, restoreLimit)) {
    const complianceViolation = complianceRestoreKeys.has(injectionKey(rule.bundleKey, rule.version));
    addRule(rule, "restore", complianceViolation);
  }

  if (isRefreshOrdinal(input.humanOrdinal) && selected.length < PROMPT_RULE_LIMIT) {
    const refreshRules = orderForRefresh(alwaysOn, latestInjections)
      .filter((rule) => !selectedKeys.has(injectionKey(rule.bundleKey, rule.version)))
      .filter((rule) => !isCooling(history, latestInjections, rule, true, featureModeInput))
      .filter(isAvailable)
      .slice(0, PROMPT_REFRESH_LIMIT);
    for (const rule of refreshRules) addRule(rule, "refresh");
  }

  for (const rule of relatedRules) {
    if (selected.length >= PROMPT_RULE_LIMIT || selected.filter((entry) => entry.delivery === "related").length >= RELATED_RULE_LIMIT) break;
    const allowRecentCorrection = !isCorrectionReinjectionEnabled(featureModeInput);
    if (isCooling(history, latestInjections, rule, allowRecentCorrection, featureModeInput)
      && !shouldReinjectRelatedDuringCooldown(featureModeInput, history, latestInjections, rule)) continue;
    if (!isAvailable(rule)) continue;
    addRule(rule, "related");
  }

  if (input.trigger === "prompt" && selected.length < PROMPT_RULE_LIMIT) {
    addCandidatePromptRules(PROMPT_RULE_LIMIT - selected.length);
  }

  return buildSelection(selected, unreached, alwaysOnCount, retrieval.ftsCandidateCount, rulingsExcludedKeys.size, [...correctionMatchedReinjectionKeys]);
}
