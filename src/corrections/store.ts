import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { SaveParams, SaveResult } from "../types.js";
import { CORRECTION_PRINCIPLES_SCHEMA_VERSION } from "../storage/correction-schema.js";
import {
  correctionConditionKey,
  mergeCorrectionRuleInputs,
  parseCorrectionRuleInput,
  renderPlainCorrectionRule,
  renderCorrectionRule,
  serializeCorrectionRuleInput,
  type CorrectionRuleInput,
} from "./rule-template.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const CANDIDATE_TTL_MS = 7 * DAY_MS;
const EVIDENCE_WINDOW_MS = 30 * DAY_MS;
const INFERRED_TTL_MS = 30 * DAY_MS;
const ROUTING_TTL_MS = DAY_MS;

export type CorrectionStatus = "candidate" | "confirmed" | "expired" | "rejected" | "disputed";
export type CorrectionLifetimeKind = "explicit_continuing" | "inferred" | "task" | "routing";

export interface CorrectionStoreTransaction {
  db: Pick<Database.Database, "inTransaction" | "prepare">;
  save: (params: SaveParams) => SaveResult;
}

export interface CorrectionCandidateInput {
  firstEventId: string;
  bundleKey: string;
  ruleText: string;
  topicKey: string;
  polarity: string;
  conditionKey: string;
  project: string;
  scope: string;
  visibility: "project" | "owner";
  lifetimeKind: CorrectionLifetimeKind;
  continuationBasis: string;
  conditions: string;
  firstSeenAt: string;
}

export interface CorrectionEvidenceInput {
  eventId: string;
  at?: string;
  bundleKey: string;
  ruleText: string;
  topicKey: string;
  polarity: string;
  conditionKey: string;
  visibility: "project" | "owner";
  decision: "candidate" | "confirmed" | "owner_confirmed";
  lifetimeKind: CorrectionLifetimeKind;
  continuationBasis: string;
  sessionEndsAt?: string;
  evidence: {
    source: "utterance_detection" | "request_repeat" | "legacy_import";
    score: number;
    detectorVersion: string;
    conditions: string;
    polarity: string;
  };
}

export interface CorrectionStoreResult {
  bundleKey: string;
  status: CorrectionStatus;
  occurrenceCount: number;
  sessionCount: number;
  intensity: number;
  version: number;
  memoryId: string | null;
}

export interface CorrectionVersionSnapshot {
  bundleKey: string;
  version: number;
  ruleText: string;
  bodyHash: string;
  conditions: string;
  conditionKey: string;
  polarity: string;
  visibility: "project" | "owner";
  status: CorrectionStatus;
  confirmedAt: string | null;
  expiresAt: string | null;
  lifetimeKind: CorrectionLifetimeKind;
  continuationBasis: string;
  evidenceEventIds: string[];
  effectiveFrom: string;
  effectiveTo: string | null;
  changeReason: string;
}

interface EventRow {
  event_id: string;
  session_id_hash: string;
  observed_at: string;
  project: string;
  scope: string;
}

interface BundleRow {
  bundle_key: string;
  memory_id: string | null;
  rule_text: string;
  topic_key: string;
  polarity: string;
  condition_key: string;
  project: string;
  scope: string;
  visibility: "project" | "owner";
  status: CorrectionStatus;
  intensity: number;
  occurrence_count: number;
  session_count: number;
  first_seen_at: string;
  last_seen_at: string;
  expires_at: string | null;
  lifetime_kind: CorrectionLifetimeKind;
  continuation_basis: string;
  confirmed_at: string | null;
  version: number;
  counterevidence_event_id: string | null;
  last_confirmation_asked_at: string | null;
  confirmation_state: "none" | "offered" | "answered";
}

interface EvidenceRow {
  event_id: string;
  score: number;
  conditions: string;
  detector_version: string;
  polarity: string;
  session_id_hash: string;
  observed_at: string;
}

interface VersionFields {
  ruleText: string;
  conditions: string;
  conditionKey: string;
  polarity: string;
  visibility: "project" | "owner";
  status: CorrectionStatus;
  confirmedAt: string | null;
  expiresAt: string | null;
  lifetimeKind: CorrectionLifetimeKind;
  continuationBasis: string;
}

interface BundleUpdate {
  bundleKey: string;
  memoryId: string | null;
  ruleText: string;
  topicKey: string;
  polarity: string;
  conditionKey: string;
  project: string;
  scope: string;
  visibility: "project" | "owner";
  status: CorrectionStatus;
  intensity: number;
  occurrenceCount: number;
  sessionCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  expiresAt: string | null;
  lifetimeKind: CorrectionLifetimeKind;
  continuationBasis: string;
  confirmedAt: string | null;
  version: number;
  counterevidenceEventId: string | null;
  lastConfirmationAskedAt: string | null;
  confirmationState: "none" | "offered" | "answered";
}

function assertTransaction(transaction: CorrectionStoreTransaction): void {
  if (!transaction.db.inTransaction) throw new Error("correction store requires an active transaction");
}

function parseTime(value: string, name: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(`${name} must be a valid timestamp`);
  return time;
}

function toIso(value: number): string {
  return new Date(value).toISOString();
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validateInput(input: CorrectionEvidenceInput): void {
  if (!input.eventId || !input.bundleKey || !input.topicKey || !input.conditionKey) {
    throw new Error("correction evidence is missing a required field");
  }
  if (typeof input.ruleText !== "string" || Array.from(input.ruleText).length > 240) {
    throw new Error("correction rule must be a string of at most 240 characters");
  }
  if (!Number.isSafeInteger(input.evidence.score) || input.evidence.score < 0) {
    throw new Error("correction evidence score must be a non-negative safe integer");
  }
  if (input.evidence.polarity !== input.polarity) throw new Error("correction evidence polarity mismatch");
  const ruleInput = parseCorrectionRuleInput(input.evidence.conditions);
  const renderedRuleText = ruleInput ? renderCorrectionRule(ruleInput) : "";
  const questionNeedsReview = ruleInput?.question === true && ruleInput.toneException !== true;
  if (!ruleInput || ruleInput.topicKey !== input.topicKey || ruleInput.polarity !== input.polarity
    || ruleInput.lifetimeKind !== input.lifetimeKind || ruleInput.continuationBasis !== input.continuationBasis
    || correctionConditionKey(ruleInput) !== input.conditionKey
    || (input.ruleText !== renderedRuleText && !(questionNeedsReview && input.ruleText === ""))) {
    throw new Error("correction evidence does not match its typed rule input");
  }
  if (input.at !== undefined) parseTime(input.at, "correction effective time");
  if (input.sessionEndsAt !== undefined) parseTime(input.sessionEndsAt, "session end time");
}

function getEvent(db: CorrectionStoreTransaction["db"], eventId: string): EventRow {
  const event = db.prepare(`
    SELECT event_id, session_id_hash, observed_at, project, scope
    FROM owner_correction_events WHERE event_id = ?
  `).get(eventId) as EventRow | undefined;
  if (!event) throw new Error("correction evidence event was not found");
  parseTime(event.observed_at, "event observed time");
  return event;
}

export function storedBundleKey(
  logicalBundleKey: string,
  project: string,
  scope: string,
  sessionIdHash: string,
  lifetimeKind: CorrectionLifetimeKind,
  visibility: "project" | "owner",
): string {
  const sessionBoundary = lifetimeKind === "task" ? sessionIdHash : "";
  const projectBoundary = visibility === "owner" ? "owner" : project;
  const scopeBoundary = visibility === "owner" ? "owner" : scope;
  const identity = JSON.stringify([logicalBundleKey, projectBoundary, scopeBoundary, sessionBoundary]);
  return `oc:v2:${sha256(identity)}`;
}

function ruleInputFromConditions(conditions: string): CorrectionRuleInput {
  const input = parseCorrectionRuleInput(conditions);
  if (!input) throw new Error("correction typed rule conditions are invalid");
  return input;
}

function getBundle(db: CorrectionStoreTransaction["db"], bundleKey: string): BundleRow | undefined {
  return db.prepare(`
    SELECT bundle_key, memory_id, rule_text, topic_key, polarity, condition_key, project, scope,
      visibility, status, intensity, occurrence_count, session_count, first_seen_at, last_seen_at,
      expires_at, lifetime_kind, continuation_basis, confirmed_at, version, counterevidence_event_id,
      last_confirmation_asked_at, confirmation_state
    FROM owner_correction_bundles WHERE bundle_key = ?
  `).get(bundleKey) as BundleRow | undefined;
}

function loadEvidenceRows(
  db: CorrectionStoreTransaction["db"],
  bundleKey: string,
  polarity: string,
): EvidenceRow[] {
  return db.prepare(`
    SELECT e.event_id, e.score, e.conditions, e.detector_version, e.polarity, v.session_id_hash, v.observed_at
    FROM owner_correction_evidence e
    JOIN owner_correction_events v ON v.event_id = e.event_id
    WHERE e.bundle_key = ? AND e.polarity = ?
    ORDER BY datetime(v.observed_at), e.event_id
  `).all(bundleKey, polarity) as EvidenceRow[];
}

function usableRuleInputs(rows: EvidenceRow[]): CorrectionRuleInput[] {
  const result: CorrectionRuleInput[] = [];
  for (const row of rows) {
    const input = parseCorrectionRuleInput(row.conditions);
    if (!input || (input.question && !input.toneException) || !renderCorrectionRule(input)) continue;
    result.push(input);
  }
  return result;
}

function detectorMajorVersion(version: string): number {
  const match = version.match(/(?:^|[-.])v(\d+)(?:$|[-.])/iu);
  if (!match) return 0;
  const majorVersion = Number(match[1]);
  if (!Number.isSafeInteger(majorVersion)) return 0;
  return majorVersion;
}

function eligiblePlainCommandRows(rows: EvidenceRow[]): EvidenceRow[] {
  return rows.filter((row) => {
    const input = parseCorrectionRuleInput(row.conditions);
    return input !== null
      && detectorMajorVersion(row.detector_version) >= 3
      && input.plainCommandEligible
      && renderCorrectionRule(input).length === 0
      && renderPlainCorrectionRule(input).length > 0;
  });
}

function distinctPlainCommandRows(rows: EvidenceRow[]): EvidenceRow[] {
  const actions = new Map<string, EvidenceRow>();
  for (const row of rows) {
    const input = parseCorrectionRuleInput(row.conditions);
    if (!input?.commandText) continue;
    const minute = Math.floor(parseTime(row.observed_at, "plain correction evidence time") / 60000);
    const actionKey = JSON.stringify([minute, input.commandText]);
    if (!actions.has(actionKey)) actions.set(actionKey, row);
  }
  return Array.from(actions.values()).sort((left, right) => {
    const timeOrder = parseTime(left.observed_at, "plain correction evidence time")
      - parseTime(right.observed_at, "plain correction evidence time");
    if (timeOrder !== 0) return timeOrder;
    return left.event_id.localeCompare(right.event_id);
  });
}

function selectPlainCommandRuleText(rows: EvidenceRow[]): string {
  const variants = new Map<string, { ruleText: string; sessions: Set<string> }>();
  for (const row of rows) {
    const input = parseCorrectionRuleInput(row.conditions);
    if (!input?.commandText) continue;
    const ruleText = renderPlainCorrectionRule(input);
    if (!ruleText) continue;
    let variant = variants.get(input.commandText);
    if (!variant) {
      variant = { ruleText, sessions: new Set() };
      variants.set(input.commandText, variant);
    }
    variant.sessions.add(row.session_id_hash);
  }
  const allVariants = Array.from(variants.values());
  const repeatedVariants = allVariants.filter((variant) => variant.sessions.size >= 2);
  const candidates = repeatedVariants.length > 0 ? repeatedVariants : allVariants;
  candidates.sort((left, right) => {
    const lengthOrder = Array.from(left.ruleText).length - Array.from(right.ruleText).length;
    if (lengthOrder !== 0) return lengthOrder;
    return left.ruleText.localeCompare(right.ruleText);
  });
  return candidates[0]?.ruleText ?? "";
}

function ruleInputSnapshot(rows: EvidenceRow[], usableInputs: CorrectionRuleInput[]): string {
  let merged = mergeCorrectionRuleInputs(usableInputs);
  if (!merged) {
    const parsedInputs = rows.map((row) => parseCorrectionRuleInput(row.conditions)).filter((input): input is CorrectionRuleInput => input !== null);
    merged = mergeCorrectionRuleInputs(parsedInputs);
  }
  if (merged) return serializeCorrectionRuleInput(merged);
  const first = rows[0];
  if (!first) throw new Error("correction rule evidence is missing");
  const input = parseCorrectionRuleInput(first.conditions);
  if (!input) throw new Error("correction rule evidence is invalid");
  return serializeCorrectionRuleInput(input);
}

function evidenceIdsForBundle(db: CorrectionStoreTransaction["db"], bundleKey: string): string[] {
  const rows = db.prepare(`
    SELECT e.event_id, v.observed_at
    FROM owner_correction_evidence e
    JOIN owner_correction_events v ON v.event_id = e.event_id
    WHERE e.bundle_key = ?
    ORDER BY datetime(v.observed_at), e.event_id
  `).all(bundleKey) as Array<{ event_id: string }>;
  return rows.map((row) => row.event_id);
}

function withEventId(eventIds: string[], eventId: string): string[] {
  if (eventIds.includes(eventId)) return eventIds;
  return [...eventIds, eventId];
}

function insertVersion(
  db: CorrectionStoreTransaction["db"],
  bundleKey: string,
  version: number,
  fields: VersionFields,
  evidenceEventIds: string[],
  effectiveFrom: string,
  changeReason: string,
): void {
  const previous = db.prepare(`
    SELECT effective_from FROM owner_correction_versions
    WHERE bundle_key = ? ORDER BY version DESC LIMIT 1
  `).get(bundleKey) as { effective_from: string } | undefined;
  if (previous && parseTime(effectiveFrom, "version effective time") < parseTime(previous.effective_from, "previous version time")) {
    throw new Error("correction version effective time moved backwards");
  }
  db.prepare(`
    INSERT INTO owner_correction_versions (
      bundle_key, version, rule_text, body_hash, conditions, condition_key, polarity, visibility,
      status, confirmed_at, expires_at, lifetime_kind, continuation_basis, evidence_event_ids,
      effective_from, change_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    bundleKey,
    version,
    fields.ruleText,
    sha256(fields.ruleText),
    fields.conditions,
    fields.conditionKey,
    fields.polarity,
    fields.visibility,
    fields.status,
    fields.confirmedAt,
    fields.expiresAt,
    fields.lifetimeKind,
    fields.continuationBasis,
    JSON.stringify(evidenceEventIds),
    effectiveFrom,
    changeReason,
  );
}

function asVersionFields(bundle: BundleUpdate, conditions: string): VersionFields {
  return {
    ruleText: bundle.ruleText,
    conditions,
    conditionKey: bundle.conditionKey,
    polarity: bundle.polarity,
    visibility: bundle.visibility,
    status: bundle.status,
    confirmedAt: bundle.confirmedAt,
    expiresAt: bundle.expiresAt,
    lifetimeKind: bundle.lifetimeKind,
    continuationBasis: bundle.continuationBasis,
  };
}

function insertInitialBundle(
  transaction: CorrectionStoreTransaction,
  input: CorrectionCandidateInput,
): BundleRow {
  const db = transaction.db;
  const firstSeenAt = input.firstSeenAt;
  const candidateExpiresAt = toIso(parseTime(firstSeenAt, "candidate first seen time") + CANDIDATE_TTL_MS);
  let initialVisibility: "project" | "owner" = "project";
  if (input.visibility === "owner" && input.lifetimeKind === "explicit_continuing") {
    initialVisibility = "owner";
  }
  db.prepare(`
    INSERT INTO owner_correction_bundles (
      bundle_key, memory_id, rule_text, topic_key, polarity, condition_key, project, scope,
      visibility, status, intensity, occurrence_count, session_count, first_seen_at, last_seen_at,
      expires_at, lifetime_kind, continuation_basis, confirmed_at, version, counterevidence_event_id,
      last_confirmation_asked_at, confirmation_state
    ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, 'candidate', 1, 0, 0, ?, ?, ?, ?, ?, NULL, 1, NULL, NULL, 'none')
  `).run(
    input.bundleKey,
    input.ruleText,
    input.topicKey,
    input.polarity,
    input.conditionKey,
    input.project,
    input.scope,
    initialVisibility,
    firstSeenAt,
    firstSeenAt,
    candidateExpiresAt,
    input.lifetimeKind,
    input.continuationBasis,
  );
  insertVersion(db, input.bundleKey, 1, {
    ruleText: input.ruleText,
    conditions: input.conditions,
    conditionKey: input.conditionKey,
    polarity: input.polarity,
    visibility: initialVisibility,
    status: "candidate",
    confirmedAt: null,
    expiresAt: candidateExpiresAt,
    lifetimeKind: input.lifetimeKind,
    continuationBasis: input.continuationBasis,
  }, [input.firstEventId], firstSeenAt, "candidate_created");
  const bundle = getBundle(db, input.bundleKey);
  if (!bundle) throw new Error("correction bundle insert failed");
  return bundle;
}

export function prepareCorrectionBundle(
  transaction: CorrectionStoreTransaction,
  input: CorrectionCandidateInput,
): CorrectionStoreResult {
  assertTransaction(transaction);
  if (!input.firstEventId || !input.bundleKey || typeof input.ruleText !== "string" || !input.topicKey || !input.conditionKey || !input.project || !input.scope) {
    throw new Error("correction candidate is missing a required field");
  }
  if (Array.from(input.ruleText).length > 240) throw new Error("correction rule exceeds 240 characters");
  parseTime(input.firstSeenAt, "candidate first seen time");
  const ruleInput = ruleInputFromConditions(input.conditions);
  const renderedRuleText = renderCorrectionRule(ruleInput);
  const questionNeedsReview = ruleInput.question && !ruleInput.toneException;
  const storedRuleText = questionNeedsReview ? "" : renderedRuleText;
  if (ruleInput.topicKey !== input.topicKey || ruleInput.lifetimeKind !== input.lifetimeKind
    || ruleInput.continuationBasis !== input.continuationBasis
    || correctionConditionKey(ruleInput) !== input.conditionKey
    || (input.ruleText !== storedRuleText && !(questionNeedsReview && input.ruleText === renderedRuleText))) {
    throw new Error("correction candidate does not match its typed rule input");
  }
  const event = getEvent(transaction.db, input.firstEventId);
  const resolvedBundleKey = storedBundleKey(input.bundleKey, input.project, input.scope, event.session_id_hash, input.lifetimeKind, input.visibility);
  const resolvedInput = { ...input, bundleKey: resolvedBundleKey, ruleText: storedRuleText };

  let bundle = getBundle(transaction.db, resolvedBundleKey);
  if (!bundle) bundle = insertInitialBundle(transaction, resolvedInput);
  if (
    bundle.topic_key !== input.topicKey || bundle.polarity !== input.polarity ||
    bundle.condition_key !== input.conditionKey
  ) {
    throw new Error("correction bundle key descriptor collision");
  }
  if (bundle.project !== input.project && input.visibility !== "owner") {
    throw new Error("project correction cannot use a different project");
  }
  if (bundle.scope !== input.scope && input.visibility !== "owner") {
    throw new Error("project correction cannot use a different scope");
  }
  return resultFromBundle(bundle);
}

function updateBundle(db: CorrectionStoreTransaction["db"], bundle: BundleUpdate): void {
  db.prepare(`
    UPDATE owner_correction_bundles SET
      memory_id = ?, rule_text = ?, topic_key = ?, polarity = ?, condition_key = ?, project = ?, scope = ?,
      visibility = ?, status = ?, intensity = ?, occurrence_count = ?, session_count = ?, first_seen_at = ?,
      last_seen_at = ?, expires_at = ?, lifetime_kind = ?, continuation_basis = ?, confirmed_at = ?,
      version = ?, counterevidence_event_id = ?, last_confirmation_asked_at = ?, confirmation_state = ?
    WHERE bundle_key = ?
  `).run(
    bundle.memoryId,
    bundle.ruleText,
    bundle.topicKey,
    bundle.polarity,
    bundle.conditionKey,
    bundle.project,
    bundle.scope,
    bundle.visibility,
    bundle.status,
    bundle.intensity,
    bundle.occurrenceCount,
    bundle.sessionCount,
    bundle.firstSeenAt,
    bundle.lastSeenAt,
    bundle.expiresAt,
    bundle.lifetimeKind,
    bundle.continuationBasis,
    bundle.confirmedAt,
    bundle.version,
    bundle.counterevidenceEventId,
    bundle.lastConfirmationAskedAt,
    bundle.confirmationState,
    bundle.bundleKey,
  );
  if (bundle.status === "confirmed" && bundle.memoryId !== null) {
    const memoryUpdate = db.prepare("UPDATE memories SET intensity = ? WHERE id = ?").run(bundle.intensity, bundle.memoryId);
    if (memoryUpdate.changes !== 1) throw new Error("correction memory intensity copy was not updated");
  }
}

function resultFromBundle(bundle: BundleRow): CorrectionStoreResult {
  return {
    bundleKey: bundle.bundle_key,
    status: bundle.status,
    occurrenceCount: bundle.occurrence_count,
    sessionCount: bundle.session_count,
    intensity: bundle.intensity,
    version: bundle.version,
    memoryId: bundle.memory_id,
  };
}

function archiveMemory(db: CorrectionStoreTransaction["db"], memoryId: string | null): void {
  if (!memoryId) return;
  db.prepare("UPDATE memories SET state = 'archived' WHERE id = ? AND state = 'active'").run(memoryId);
}

function restoreOrSaveMemory(
  transaction: CorrectionStoreTransaction,
  bundle: BundleUpdate,
): string {
  const saveParams: SaveParams = {
    category: "dont",
    title: `owner-correction:${bundle.bundleKey}`,
    content: bundle.ruleText,
    tags: ["owner_correction", bundle.topicKey],
    project: bundle.project,
    scope: bundle.scope,
    intensity: bundle.intensity,
  };
  if (bundle.memoryId) {
    const saved = transaction.save({ ...saveParams, replaceId: bundle.memoryId });
    transaction.db.prepare("UPDATE memories SET state = 'active' WHERE id = ?").run(saved.id);
    return saved.id;
  }
  return transaction.save(saveParams).id;
}

function addEvidence(transaction: CorrectionStoreTransaction, input: CorrectionEvidenceInput): boolean {
  const db = transaction.db;
  const inserted = db.prepare(`
    INSERT INTO owner_correction_evidence (
      event_id, bundle_key, source, score, detector_version, conditions, polarity
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id, bundle_key) DO NOTHING
  `).run(
    input.eventId,
    input.bundleKey,
    input.evidence.source,
    input.evidence.score,
    input.evidence.detectorVersion,
    input.evidence.conditions,
    input.evidence.polarity,
  );
  if (inserted.changes === 1) return true;

  const existing = db.prepare(`
    SELECT source, score, detector_version, conditions, polarity
    FROM owner_correction_evidence WHERE event_id = ? AND bundle_key = ?
  `).get(input.eventId, input.bundleKey) as {
    source: string;
    score: number;
    detector_version: string;
    conditions: string;
    polarity: string;
  } | undefined;
  if (
    !existing || existing.source !== input.evidence.source || existing.score !== input.evidence.score ||
    existing.detector_version !== input.evidence.detectorVersion || existing.conditions !== input.evidence.conditions ||
    existing.polarity !== input.evidence.polarity
  ) {
    throw new Error("correction event and bundle evidence collision");
  }
  return false;
}

function calculateIntensity(rows: EvidenceRow[]): number {
  let intensity = 1;
  rows.forEach((row, index) => {
    const scoreIntensity = 1 + Math.floor(row.score / 2);
    if (index === 0) {
      intensity = Math.max(intensity, scoreIntensity);
      return;
    }
    intensity = Math.min(5, Math.max(intensity, scoreIntensity) + 1);
  });
  return Math.min(5, intensity);
}

function updateStrengthEventBaseIntensity(
  db: CorrectionStoreTransaction["db"],
  bundleKey: string,
  cycleStartAt: string,
  baseIntensity: number,
): void {
  const events = db.prepare(`
    SELECT at, reason, basis
    FROM owner_correction_strength_events
    WHERE bundle_key = ? AND at >= ?
  `).all(bundleKey, cycleStartAt) as Array<{ at: string; reason: string; basis: string }>;
  const update = db.prepare(`
    UPDATE owner_correction_strength_events SET basis = ?
    WHERE bundle_key = ? AND at = ? AND reason = ?
  `);
  for (const event of events) {
    const parsed: unknown = JSON.parse(event.basis);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("strength event basis must be a JSON object");
    }
    update.run(
      JSON.stringify({ ...(parsed as Record<string, unknown>), baseIntensity }),
      bundleKey,
      event.at,
      event.reason,
    );
  }
}

function clampIntensity(value: number): number {
  return Math.min(5, Math.max(1, value));
}

function getRepeatRows(
  rows: EvidenceRow[],
  currentEventAt: string,
  windowMs = EVIDENCE_WINDOW_MS,
  includeWindowStart = true,
): EvidenceRow[] {
  const currentTime = parseTime(currentEventAt, "event observed time");
  const cutoff = currentTime - windowMs;
  return rows.filter((row) => {
    const eventTime = parseTime(row.observed_at, "evidence observed time");
    return (includeWindowStart ? eventTime >= cutoff : eventTime > cutoff) && eventTime <= currentTime;
  });
}

function desiredLifetime(input: CorrectionEvidenceInput, current: BundleRow): CorrectionLifetimeKind {
  if (input.lifetimeKind === "explicit_continuing") return "explicit_continuing";
  if (current.lifetime_kind === "explicit_continuing") return "explicit_continuing";
  return input.lifetimeKind;
}

function activeExpiry(
  lifetimeKind: CorrectionLifetimeKind,
  lastSeenAt: string,
  sessionEndsAt: string | undefined,
  existingTaskExpiry: string | null,
): string | null {
  if (lifetimeKind === "explicit_continuing") return null;
  if (lifetimeKind === "inferred") return toIso(parseTime(lastSeenAt, "last evidence time") + INFERRED_TTL_MS);
  if (lifetimeKind === "routing") return toIso(parseTime(lastSeenAt, "last evidence time") + ROUTING_TTL_MS);
  if (sessionEndsAt) return sessionEndsAt;
  if (existingTaskExpiry) return existingTaskExpiry;
  throw new Error("task correction requires a session end time");
}

function currentConditions(db: CorrectionStoreTransaction["db"], bundle: BundleRow): string {
  const row = db.prepare(`
    SELECT conditions FROM owner_correction_versions WHERE bundle_key = ? AND version = ?
  `).get(bundle.bundle_key, bundle.version) as { conditions: string } | undefined;
  if (!row) throw new Error("correction bundle version is missing");
  return row.conditions;
}

function modelRoutingRetractionTime(
  db: CorrectionStoreTransaction["db"],
  bundle: BundleRow,
): string | null {
  if (bundle.status !== "expired" || bundle.topic_key !== "model_routing" || !bundle.counterevidence_event_id) return null;
  const version = db.prepare(`
    SELECT change_reason FROM owner_correction_versions WHERE bundle_key = ? AND version = ?
  `).get(bundle.bundle_key, bundle.version) as { change_reason: string } | undefined;
  if (!version) throw new Error("correction bundle version is missing");
  if (version.change_reason !== "model_routing_retracted") return null;
  const event = db.prepare(`
    SELECT observed_at FROM owner_correction_events WHERE event_id = ?
  `).get(bundle.counterevidence_event_id) as { observed_at: string } | undefined;
  if (!event) throw new Error("model routing retraction event is missing");
  return event.observed_at;
}

function sameModelName(targetModel: string, bundleModel: string): boolean {
  const normalizedTarget = targetModel.normalize("NFKC").trim().toLocaleLowerCase("en-US");
  const normalizedBundle = bundleModel.normalize("NFKC").trim().toLocaleLowerCase("en-US");
  return normalizedBundle === normalizedTarget;
}

function expirationVersion(
  transaction: CorrectionStoreTransaction,
  bundle: BundleRow,
  reason: string,
  expiresAt = bundle.expires_at,
  counterevidenceEventId = bundle.counterevidence_event_id,
): BundleRow {
  if (!expiresAt) throw new Error("expired correction bundle is missing its deadline");
  const conditions = currentConditions(transaction.db, bundle);
  const next: BundleUpdate = {
    bundleKey: bundle.bundle_key,
    memoryId: bundle.memory_id,
    ruleText: bundle.rule_text,
    topicKey: bundle.topic_key,
    polarity: bundle.polarity,
    conditionKey: bundle.condition_key,
    project: bundle.project,
    scope: bundle.scope,
    visibility: bundle.visibility,
    status: "expired",
    intensity: bundle.intensity,
    occurrenceCount: bundle.occurrence_count,
    sessionCount: bundle.session_count,
    firstSeenAt: bundle.first_seen_at,
    lastSeenAt: bundle.last_seen_at,
    expiresAt,
    lifetimeKind: bundle.lifetime_kind,
    continuationBasis: bundle.continuation_basis,
    confirmedAt: bundle.confirmed_at,
    version: bundle.version + 1,
    counterevidenceEventId,
    lastConfirmationAskedAt: bundle.last_confirmation_asked_at,
    confirmationState: bundle.confirmation_state,
  };
  updateBundle(transaction.db, next);
  let evidenceEventIds = evidenceIdsForBundle(transaction.db, bundle.bundle_key);
  if (counterevidenceEventId) evidenceEventIds = withEventId(evidenceEventIds, counterevidenceEventId);
  insertVersion(
    transaction.db,
    bundle.bundle_key,
    next.version,
    asVersionFields(next, conditions),
    evidenceEventIds,
    expiresAt,
    reason,
  );
  archiveMemory(transaction.db, bundle.memory_id);
  const updated = getBundle(transaction.db, bundle.bundle_key);
  if (!updated) throw new Error("expired correction bundle disappeared");
  return updated;
}

function expireIfDue(
  transaction: CorrectionStoreTransaction,
  bundle: BundleRow,
  at: string,
): BundleRow {
  if (bundle.status !== "candidate" && bundle.status !== "confirmed") return bundle;
  if (!bundle.expires_at || parseTime(bundle.expires_at, "correction expiration") > parseTime(at, "correction effective time")) {
    return bundle;
  }
  let reason = "confirmed_expired";
  if (bundle.status === "candidate") reason = "candidate_expired";
  return expirationVersion(transaction, bundle, reason);
}

function substantiveChange(
  current: BundleRow,
  next: BundleUpdate,
  currentSnapshotConditions: string,
  nextConditions: string,
): boolean {
  return current.rule_text !== next.ruleText || currentSnapshotConditions !== nextConditions ||
    current.condition_key !== next.conditionKey || current.polarity !== next.polarity ||
    current.visibility !== next.visibility || current.status !== next.status ||
    current.confirmed_at !== next.confirmedAt || current.expires_at !== next.expiresAt ||
    current.lifetime_kind !== next.lifetimeKind || current.continuation_basis !== next.continuationBasis;
}

function ensureDescriptorMatches(input: CorrectionEvidenceInput, event: EventRow, bundle: BundleRow): void {
  if (
    bundle.topic_key !== input.topicKey || bundle.polarity !== input.polarity ||
    bundle.condition_key !== input.conditionKey
  ) {
    throw new Error("correction bundle key descriptor collision");
  }
  if (bundle.project !== event.project && input.visibility !== "owner") {
    throw new Error("project correction cannot use evidence from another project");
  }
  if (bundle.scope !== event.scope && input.visibility !== "owner") {
    throw new Error("project correction cannot use evidence from another scope");
  }
}

function transitionToTerminal(
  transaction: CorrectionStoreTransaction,
  bundle: BundleRow,
  status: "rejected" | "disputed",
  eventId: string,
  at: string,
  reason: string,
): BundleRow {
  const currentConditionsValue = currentConditions(transaction.db, bundle);
  const next: BundleUpdate = {
    bundleKey: bundle.bundle_key,
    memoryId: bundle.memory_id,
    ruleText: bundle.rule_text,
    topicKey: bundle.topic_key,
    polarity: bundle.polarity,
    conditionKey: bundle.condition_key,
    project: bundle.project,
    scope: bundle.scope,
    visibility: bundle.visibility,
    status,
    intensity: bundle.intensity,
    occurrenceCount: bundle.occurrence_count,
    sessionCount: bundle.session_count,
    firstSeenAt: bundle.first_seen_at,
    lastSeenAt: bundle.last_seen_at,
    expiresAt: bundle.expires_at,
    lifetimeKind: bundle.lifetime_kind,
    continuationBasis: bundle.continuation_basis,
    confirmedAt: bundle.confirmed_at,
    version: bundle.version + 1,
    counterevidenceEventId: eventId,
    lastConfirmationAskedAt: bundle.last_confirmation_asked_at,
    confirmationState: bundle.confirmation_state,
  };
  if (status === "rejected") next.confirmationState = "answered";
  updateBundle(transaction.db, next);
  insertVersion(
    transaction.db,
    bundle.bundle_key,
    next.version,
    asVersionFields(next, currentConditionsValue),
    withEventId(evidenceIdsForBundle(transaction.db, bundle.bundle_key), eventId),
    at,
    reason,
  );
  archiveMemory(transaction.db, bundle.memory_id);
  const updated = getBundle(transaction.db, bundle.bundle_key);
  if (!updated) throw new Error("terminal correction bundle disappeared");
  return updated;
}

function stopContradictoryBundles(
  transaction: CorrectionStoreTransaction,
  bundle: BundleRow,
  eventId: string,
  at: string,
  conditions: string[],
): BundleRow | null {
  const conflicts = transaction.db.prepare(`
    SELECT bundle_key FROM owner_correction_bundles
    WHERE topic_key = ? AND condition_key = ? AND polarity <> ?
      AND project = ? AND scope = ? AND status IN ('candidate','confirmed','expired')
    ORDER BY bundle_key
  `).all(bundle.topic_key, bundle.condition_key, bundle.polarity, bundle.project, bundle.scope) as Array<{ bundle_key: string }>;
  const overlappingConflicts = conflicts.filter((conflict) => {
    const other = getBundle(transaction.db, conflict.bundle_key);
    if (!other) throw new Error("contradictory correction bundle disappeared");
    const otherInput = parseCorrectionRuleInput(currentConditions(transaction.db, other));
    if (!otherInput) return false;
    if (conditions.length === 0 || otherInput.conditions.length === 0) return true;
    return conditions.some((condition) => otherInput.conditions.includes(condition));
  });
  if (overlappingConflicts.length === 0) return null;

  let stopped = getBundle(transaction.db, bundle.bundle_key);
  if (!stopped) throw new Error("correction bundle disappeared during conflict check");
  if (stopped.status !== "disputed") {
    stopped = transitionToTerminal(transaction, stopped, "disputed", eventId, at, "counterevidence_conflict");
  }
  for (const conflict of overlappingConflicts) {
    const other = getBundle(transaction.db, conflict.bundle_key);
    if (!other) throw new Error("contradictory correction bundle disappeared");
    if (other.status === "rejected" || other.status === "disputed") continue;
    transitionToTerminal(transaction, other, "disputed", eventId, at, "counterevidence_conflict");
  }
  return stopped;
}

export function applyCorrectionEvidence(
  transaction: CorrectionStoreTransaction,
  input: CorrectionEvidenceInput,
): CorrectionStoreResult {
  assertTransaction(transaction);
  validateInput(input);
  const submittedInput = input;
  const submittedRuleInput = ruleInputFromConditions(submittedInput.evidence.conditions);
  const shortModelRoute = submittedRuleInput.topicKey === "model_routing"
    && submittedRuleInput.plainCommandEligible
    && !submittedRuleInput.requiredValues.workType;
  const repeatWindow = shortModelRoute ? ROUTING_TTL_MS : EVIDENCE_WINDOW_MS;
  const includeRepeatWindowStart = !shortModelRoute;
  if (submittedRuleInput.question && !submittedRuleInput.toneException) {
    input = { ...submittedInput, ruleText: "", decision: "candidate" };
  }
  const db = transaction.db;
  const event = getEvent(db, input.eventId);
  const bundleKey = storedBundleKey(input.bundleKey, event.project, event.scope, event.session_id_hash, input.lifetimeKind, input.visibility);
  const storedInput = { ...input, bundleKey };
  let at = new Date().toISOString();
  if (input.at !== undefined) at = input.at;
  parseTime(at, "correction effective time");

  prepareCorrectionBundle(transaction, {
    firstEventId: input.eventId,
    bundleKey: input.bundleKey,
    ruleText: input.ruleText,
    topicKey: input.topicKey,
    polarity: input.polarity,
    conditionKey: input.conditionKey,
    project: event.project,
    scope: event.scope,
    visibility: input.visibility,
    lifetimeKind: input.lifetimeKind,
    continuationBasis: input.continuationBasis,
    conditions: input.evidence.conditions,
    firstSeenAt: event.observed_at,
  });
  let bundle = getBundle(db, bundleKey);
  if (!bundle) throw new Error("prepared correction bundle was not found");
  ensureDescriptorMatches(storedInput, event, bundle);
  if (bundle.status === "rejected" || bundle.status === "disputed") return resultFromBundle(bundle);

  bundle = expireIfDue(transaction, bundle, at);
  const retractionAt = shortModelRoute ? modelRoutingRetractionTime(db, bundle) : null;
  if (retractionAt && parseTime(event.observed_at, "event observed time") <= parseTime(retractionAt, "model routing retraction time")) {
    return resultFromBundle(bundle);
  }
  const existingConditions = currentConditions(db, bundle);
  const inserted = addEvidence(transaction, storedInput);
  let rows = loadEvidenceRows(db, bundleKey, input.polarity);
  if (retractionAt) {
    const retractionTime = parseTime(retractionAt, "model routing retraction time");
    rows = rows.filter((row) => parseTime(row.observed_at, "evidence observed time") > retractionTime);
  }
  if (rows.length === 0) throw new Error("correction evidence disappeared after insert");
  const usableRows = rows.filter((row) => {
    const evidenceRule = parseCorrectionRuleInput(row.conditions);
    return evidenceRule !== null && !(evidenceRule.question && !evidenceRule.toneException)
      && renderCorrectionRule(evidenceRule).length > 0;
  });
  const plainEvidenceRows = eligiblePlainCommandRows(rows).filter((row) =>
    getRepeatRows([row], event.observed_at, repeatWindow, includeRepeatWindowStart).length > 0,
  );
  const plainActionRows = distinctPlainCommandRows(plainEvidenceRows);
  const usableInputs = usableRuleInputs(rows);
  const mergedInput = mergeCorrectionRuleInputs(usableInputs);
  let generatedRuleText = "";
  if (mergedInput) generatedRuleText = renderCorrectionRule(mergedInput);
  const recentPlainRows = getRepeatRows(plainActionRows, event.observed_at, repeatWindow, includeRepeatWindowStart);
  if (!generatedRuleText) generatedRuleText = selectPlainCommandRuleText(recentPlainRows);
  const mergedConditions = ruleInputSnapshot(rows, usableInputs);

  const refreshedBundle = getBundle(db, bundleKey);
  if (!refreshedBundle) throw new Error("correction bundle disappeared before conflict check");
  const conflictConditions = mergedInput
    ? mergedInput.conditions
    : ruleInputFromConditions(input.evidence.conditions).conditions;
  const hasContradictionRule = Boolean(input.ruleText) || shortModelRoute && Boolean(generatedRuleText);
  const contradicted = hasContradictionRule
    ? stopContradictoryBundles(transaction, refreshedBundle, input.eventId, at, conflictConditions)
    : null;
  if (contradicted) return resultFromBundle(contradicted);

  const plainEvidenceIds = new Set(plainEvidenceRows.map((row) => row.event_id));
  const countedRows = shortModelRoute
    ? plainActionRows
    : rows.filter((row) => !plainEvidenceIds.has(row.event_id)).concat(plainActionRows);
  const evidenceCount = countedRows.length;
  const hasUnappliedEvidence = inserted || evidenceCount > bundle.occurrence_count;
  const proofRows = usableRows.concat(plainActionRows);
  const sessionRows = proofRows.length > 0 ? proofRows : countedRows;
  const freshRoutingCycle = bundle.status === "expired" && shortModelRoute;
  const occurrenceCount = freshRoutingCycle ? evidenceCount : Math.max(bundle.occurrence_count, evidenceCount);
  const observedSessionCount = new Set(sessionRows.map((row) => row.session_id_hash)).size;
  const sessionCount = freshRoutingCycle ? observedSessionCount : Math.max(bundle.session_count, observedSessionCount);
  let metricRows = countedRows;
  if (usableRows.length > 0) metricRows = usableRows;
  else if (plainActionRows.length > 0) metricRows = plainActionRows;
  const strengthCycleStartAt = freshRoutingCycle ? metricRows[0]?.observed_at ?? event.observed_at : bundle.first_seen_at;
  const schemaVersion = db.prepare("SELECT MAX(version) AS version FROM schema_version").get() as { version: number | null };
  let strengthDelta = 0;
  if (schemaVersion.version !== null && schemaVersion.version >= CORRECTION_PRINCIPLES_SCHEMA_VERSION) {
    const strengthEvent = db.prepare(`
      SELECT COALESCE(SUM(delta), 0) AS delta
      FROM owner_correction_strength_events
      WHERE bundle_key = ? AND at >= ?
    `).get(bundle.bundle_key, strengthCycleStartAt) as { delta: number };
    strengthDelta = strengthEvent.delta;
  }
  const baseIntensity = calculateIntensity(metricRows);
  const intensity = clampIntensity(baseIntensity + strengthDelta);
  let firstSeenAt = bundle.first_seen_at;
  let lastSeenAt = bundle.last_seen_at;
  const datedRows = metricRows;
  if (datedRows.length > 0) {
    firstSeenAt = datedRows[0].observed_at;
    lastSeenAt = datedRows[datedRows.length - 1].observed_at;
  }

  if (!hasUnappliedEvidence) return resultFromBundle(bundle);
  if (schemaVersion.version !== null && schemaVersion.version >= CORRECTION_PRINCIPLES_SCHEMA_VERSION) {
    updateStrengthEventBaseIntensity(db, bundle.bundle_key, strengthCycleStartAt, baseIntensity);
  }

  const recentUsableRows = getRepeatRows(usableRows, event.observed_at, repeatWindow, includeRepeatWindowStart);
  const recentProofRows = getRepeatRows(proofRows, event.observed_at, repeatWindow, includeRepeatWindowStart);
  const plainRepeatConfirmed = plainActionRows.length > 0
    && recentProofRows.length >= 2
    && new Set(recentProofRows.map((row) => row.session_id_hash)).size >= 2;
  const repeatConfirmed = usableRows.length > 0 && recentUsableRows.length >= 2 || plainRepeatConfirmed;
  const immediateConfirmed = input.ruleText.length > 0
    && (input.decision === "confirmed" || input.decision === "owner_confirmed");
  const ownerConfirmed = input.decision === "owner_confirmed" && input.ruleText.length > 0;
  const shouldConfirm = immediateConfirmed || repeatConfirmed;
  const lifetimeKind = desiredLifetime(input, bundle);
  let continuationBasis = input.continuationBasis;
  if (bundle.lifetime_kind === "explicit_continuing" && input.lifetimeKind !== "explicit_continuing") {
    continuationBasis = bundle.continuation_basis;
  }
  let status = bundle.status;
  let expiresAt = bundle.expires_at;
  let confirmedAt = bundle.confirmed_at;
  let visibility: "project" | "owner" = bundle.visibility;

  if (bundle.status === "candidate" || bundle.status === "expired") {
    if (shouldConfirm) {
      status = "confirmed";
      confirmedAt = at;
      expiresAt = activeExpiry(lifetimeKind, lastSeenAt, input.sessionEndsAt, null);
    } else {
      status = "candidate";
      if (bundle.status === "expired") {
        const eventTime = parseTime(event.observed_at, "event observed time");
        expiresAt = toIso(eventTime + CANDIDATE_TTL_MS);
      }
    }
  } else if (bundle.status === "confirmed") {
    expiresAt = activeExpiry(lifetimeKind, lastSeenAt, input.sessionEndsAt, bundle.expires_at);
  }

  const canBeOwner = lifetimeKind === "explicit_continuing" || ownerConfirmed || sessionCount >= 2;
  if (input.visibility === "owner" && canBeOwner) visibility = "owner";
  if (lifetimeKind === "explicit_continuing" && input.visibility === "owner") visibility = "owner";

  const next: BundleUpdate = {
    bundleKey: bundle.bundle_key,
    memoryId: bundle.memory_id,
    ruleText: generatedRuleText || input.ruleText || bundle.rule_text,
    topicKey: bundle.topic_key,
    polarity: bundle.polarity,
    conditionKey: bundle.condition_key,
    project: bundle.project,
    scope: bundle.scope,
    visibility,
    status,
    intensity,
    occurrenceCount,
    sessionCount,
    firstSeenAt,
    lastSeenAt,
    expiresAt,
    lifetimeKind,
    continuationBasis,
    confirmedAt,
    version: bundle.version,
    counterevidenceEventId: retractionAt ? null : bundle.counterevidence_event_id,
    lastConfirmationAskedAt: bundle.last_confirmation_asked_at,
    confirmationState: bundle.confirmation_state,
  };
  if (ownerConfirmed && immediateConfirmed) next.confirmationState = "answered";
  const changed = substantiveChange(bundle, next, existingConditions, mergedConditions);
  if (changed) next.version += 1;

  if (status === "confirmed") {
    const contentChanged = bundle.rule_text !== next.ruleText || bundle.project !== next.project || bundle.scope !== next.scope;
    if (!bundle.memory_id || contentChanged) next.memoryId = restoreOrSaveMemory(transaction, next);
    else if (bundle.status !== "confirmed") {
      db.prepare("UPDATE memories SET state = 'active' WHERE id = ?").run(bundle.memory_id);
    }
  } else if (bundle.status === "confirmed") {
    archiveMemory(db, bundle.memory_id);
  }

  updateBundle(db, next);
  if (changed) {
    let changeReason = "bundle_updated";
    if (status === "confirmed" && bundle.status !== "confirmed") {
      if (immediateConfirmed) changeReason = "confirmed_immediate";
      else changeReason = "confirmed_repeat";
    }
    if (ownerConfirmed) changeReason = "confirmed_owner_id";
    insertVersion(
      db,
      next.bundleKey,
      next.version,
      asVersionFields(next, mergedConditions),
      evidenceIdsForBundle(db, next.bundleKey),
      at,
      changeReason,
    );
  }

  const updated = getBundle(db, bundleKey);
  if (!updated) throw new Error("correction bundle disappeared during update");
  return resultFromBundle(updated);
}

export function expireCorrectionBundles(
  transaction: CorrectionStoreTransaction,
  at: string,
): string[] {
  assertTransaction(transaction);
  parseTime(at, "correction expiration time");
  const rows = transaction.db.prepare(`
    SELECT bundle_key FROM owner_correction_bundles
    WHERE status IN ('candidate','confirmed') AND expires_at IS NOT NULL
    ORDER BY bundle_key
  `).all() as Array<{ bundle_key: string }>;
  const targetTime = parseTime(at, "correction expiration time");
  const expired: string[] = [];
  for (const row of rows) {
    const bundle = getBundle(transaction.db, row.bundle_key);
    if (!bundle) throw new Error("correction bundle disappeared during expiration");
    if (!bundle.expires_at || parseTime(bundle.expires_at, "correction expiration") > targetTime) continue;
    let reason = "confirmed_expired";
    if (bundle.status === "candidate") reason = "candidate_expired";
    expirationVersion(transaction, bundle, reason);
    expired.push(row.bundle_key);
  }
  return expired;
}

export function cancelCorrectionBundle(
  transaction: CorrectionStoreTransaction,
  input: { bundleKey: string; eventId: string; at: string },
): CorrectionStoreResult {
  assertTransaction(transaction);
  parseTime(input.at, "correction cancellation time");
  getEvent(transaction.db, input.eventId);
  const bundle = getBundle(transaction.db, input.bundleKey);
  if (!bundle) throw new Error("correction bundle was not found");
  if (bundle.status === "rejected" && bundle.counterevidence_event_id === input.eventId) return resultFromBundle(bundle);
  if (bundle.status === "rejected" || bundle.status === "disputed") {
    throw new Error("terminal correction bundle cannot be changed");
  }
  return resultFromBundle(transitionToTerminal(transaction, bundle, "rejected", input.eventId, input.at, "owner_cancelled"));
}

export function disputeCorrectionBundles(
  transaction: CorrectionStoreTransaction,
  input: { bundleKeys: [string, string]; eventId: string; at: string },
): CorrectionStoreResult[] {
  assertTransaction(transaction);
  parseTime(input.at, "correction conflict time");
  if (input.bundleKeys[0] === input.bundleKeys[1]) throw new Error("a correction conflict requires two bundles");
  getEvent(transaction.db, input.eventId);
  const bundles = input.bundleKeys.map((bundleKey) => {
    const bundle = getBundle(transaction.db, bundleKey);
    if (!bundle) throw new Error("correction bundle was not found");
    if (bundle.status === "disputed" && bundle.counterevidence_event_id === input.eventId) return bundle;
    if (bundle.status === "rejected" || bundle.status === "disputed") {
      throw new Error("terminal correction bundle cannot be changed");
    }
    return transitionToTerminal(transaction, bundle, "disputed", input.eventId, input.at, "counterevidence_conflict");
  });
  return bundles.map(resultFromBundle);
}

export function disputeRecentModelRoutingBundles(
  transaction: CorrectionStoreTransaction,
  input: { eventId: string; at: string; targetModels: string[] },
): CorrectionStoreResult[] {
  assertTransaction(transaction);
  parseTime(input.at, "model routing retraction time");
  getEvent(transaction.db, input.eventId);
  const retraction = transaction.db.prepare(`
    SELECT session_id_hash, human_ordinal FROM owner_correction_events WHERE event_id = ?
  `).get(input.eventId) as { session_id_hash: string; human_ordinal: number } | undefined;
  if (!retraction) throw new Error("model routing retraction event was not found");
  if (input.targetModels.length === 0) return [];

  const priorBundles = transaction.db.prepare(`
    SELECT DISTINCT b.bundle_key
    FROM owner_correction_events basis
    JOIN owner_correction_evidence evidence ON evidence.event_id = basis.event_id
    JOIN owner_correction_bundles b ON b.bundle_key = evidence.bundle_key
    WHERE basis.session_id_hash = ? AND basis.human_ordinal >= ? AND basis.human_ordinal < ?
      AND b.topic_key = 'model_routing' AND b.status IN ('candidate','confirmed','expired')
    ORDER BY b.bundle_key
  `).all(
    retraction.session_id_hash,
    Math.max(0, retraction.human_ordinal - 5),
    retraction.human_ordinal,
  ) as Array<{ bundle_key: string }>;

  const expired: CorrectionStoreResult[] = [];
  for (const row of priorBundles) {
    const bundle = getBundle(transaction.db, row.bundle_key);
    if (!bundle) throw new Error("model routing bundle disappeared during retraction");
    const ruleInput = parseCorrectionRuleInput(currentConditions(transaction.db, bundle));
    const bundleModel = ruleInput?.requiredValues.model;
    if (!bundleModel || !input.targetModels.some((targetModel) => sameModelName(targetModel, bundleModel))) continue;
    const stopped = expirationVersion(transaction, bundle, "model_routing_retracted", input.at, input.eventId);
    expired.push(resultFromBundle(stopped));
  }
  return expired;
}

export function getCorrectionVersionAt(
  db: CorrectionStoreTransaction["db"],
  bundleKey: string,
  at: string,
): CorrectionVersionSnapshot | null {
  if (!db.inTransaction) throw new Error("correction history read requires an active transaction");
  const targetTime = parseTime(at, "correction history time");
  const rows = db.prepare(`
    SELECT bundle_key, version, rule_text, body_hash, conditions, condition_key, polarity, visibility,
      status, confirmed_at, expires_at, lifetime_kind, continuation_basis, evidence_event_ids,
      effective_from, change_reason
    FROM owner_correction_versions WHERE bundle_key = ? ORDER BY version
  `).all(bundleKey) as Array<{
    bundle_key: string;
    version: number;
    rule_text: string;
    body_hash: string;
    conditions: string;
    condition_key: string;
    polarity: string;
    visibility: "project" | "owner";
    status: CorrectionStatus;
    confirmed_at: string | null;
    expires_at: string | null;
    lifetime_kind: CorrectionLifetimeKind;
    continuation_basis: string;
    evidence_event_ids: string;
    effective_from: string;
    change_reason: string;
  }>;
  let selectedIndex = -1;
  rows.forEach((row, index) => {
    if (parseTime(row.effective_from, "version effective time") <= targetTime) selectedIndex = index;
  });
  if (selectedIndex < 0) return null;

  const row = rows[selectedIndex];
  let effectiveTo: string | null = null;
  if (selectedIndex < rows.length - 1) effectiveTo = rows[selectedIndex + 1].effective_from;
  if ((row.status === "candidate" || row.status === "confirmed") && row.expires_at) {
    const expirationTime = parseTime(row.expires_at, "version expiration time");
    if (effectiveTo === null || expirationTime < parseTime(effectiveTo, "next version effective time")) {
      effectiveTo = row.expires_at;
    }
  }
  if (effectiveTo !== null && targetTime >= parseTime(effectiveTo, "version effective end")) return null;

  const evidenceEventIds: unknown = JSON.parse(row.evidence_event_ids);
  if (!Array.isArray(evidenceEventIds) || evidenceEventIds.some((eventId) => typeof eventId !== "string")) {
    throw new Error("correction version evidence list is invalid");
  }
  return {
    bundleKey: row.bundle_key,
    version: row.version,
    ruleText: row.rule_text,
    bodyHash: row.body_hash,
    conditions: row.conditions,
    conditionKey: row.condition_key,
    polarity: row.polarity,
    visibility: row.visibility,
    status: row.status,
    confirmedAt: row.confirmed_at,
    expiresAt: row.expires_at,
    lifetimeKind: row.lifetime_kind,
    continuationBasis: row.continuation_basis,
    evidenceEventIds: evidenceEventIds as string[],
    effectiveFrom: row.effective_from,
    effectiveTo,
    changeReason: row.change_reason,
  };
}
