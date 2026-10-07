import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { CORRECTION_PRINCIPLES_SCHEMA_VERSION } from "../storage/correction-schema.js";
import {
  cancelCorrectionBundle,
  type CorrectionStoreResult,
  type CorrectionStoreTransaction,
} from "./store.js";
import { diceCoefficient } from "./bundle-key.js";
import { correctionRequiredValuesKey, parseCorrectionRuleInput } from "./rule-template.js";
import { readEnvironmentMode } from "./environment-mode.js";

const PRINCIPLE_PREFIX = "pr:v1:";
const CANDIDATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INFERRED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ABSTRACTION_DICE_THRESHOLD = 0.5;
const ABSTRACTION_MEMBER_LIMIT = 10;
const ABSTRACTION_GROUP_LIMIT = 20;
const ABSTRACTION_MIN_SESSIONS = 3;
const OWNER_VISIBLE_TOPICS = new Set([
  "tone",
  "response_policy",
  "document_delivery",
  "expression_policy",
  "summary_constraints",
  "storage_location",
  "verification",
  "delegation_roles",
  "unknown",
  "model_routing",
]);
const CONTENT_WORD = /[\p{Script=Han}\p{Script=Katakana}A-Za-z0-9]{2,}/gu;
const NEGATIVE_POLARITY = /(?:ない|なく|ず|ません|禁止|避け(?:る|て|ます)|控え(?:る|て|ます)|やめ(?:る|て|ます)|しない|しません|行わない|使わない|表示しない|書かない|答えない)/u;
const POSITIVE_POLARITY = /(?:する|します|できる|使う|用いる|保つ|維持する|確認する|行う|答える|表示する|書く|保存する|配置する|説明する|提示する)/u;

export type CorrectionPrinciplesMode = "off" | "shadow" | "on";
export type CorrectionPrincipleCreationResult =
  | { status: "ready"; principleKey: string }
  | { status: "disabled"; principleKey: null }
  | { status: "terminal"; principleKey: string };
export type CorrectionPrincipleAttachSource = "cluster" | "later_attach";

export interface CorrectionPrincipleEvidence {
  evidenceCount: number;
  sessionCount: number;
  eventIds: string[];
  firstAt: string | null;
  latestAt: string | null;
}

export interface CorrectionPrincipleAbstractionEvidence {
  eventId: string;
  sessionIdHash: string;
  observedAt: string;
  rawTextHash: string;
}

export interface CorrectionPrincipleAbstractionCandidate {
  bundleKey: string;
  ruleText: string;
  topicKey: string;
  polarity: string;
  status: string;
  visibility: string;
  requiredValuesKeys: string[];
  evidence: CorrectionPrincipleAbstractionEvidence[];
}

export interface CorrectionPrincipleAbstractionGroupItem {
  id: number;
  bundleKey: string;
  ruleText: string;
}

export interface CorrectionPrincipleAbstractionGroup {
  groupId: string;
  kind: CorrectionPrincipleAttachSource;
  principleKey: string | null;
  memberBundleKeys: string[];
  distinctSessionCount: number;
  items: CorrectionPrincipleAbstractionGroupItem[];
}

export interface CorrectionPrincipleAbstractionOutput {
  group_id: string;
  verdict: "merge" | "none";
  principle: string;
  odd_ids: number[];
}

export type CorrectionPrincipleAbstractionGuardReason =
  | "none"
  | "mixed_intents"
  | "empty_principle"
  | "principle_too_long"
  | "unsupported_term"
  | "polarity_ambiguous"
  | "polarity_mismatch";

export interface CorrectionPrincipleAbstractionGuardResult {
  accepted: boolean;
  reason: CorrectionPrincipleAbstractionGuardReason | null;
  principle: string | null;
}

interface PrincipleBundleRow {
  bundle_key: string;
  memory_id: string | null;
  rule_text: string;
  topic_key: string;
  polarity: string;
  condition_key: string;
  project: string;
  scope: string;
  visibility: "owner" | "project";
  status: "candidate" | "confirmed" | "expired" | "rejected" | "disputed";
  intensity: number;
  occurrence_count: number;
  session_count: number;
  first_seen_at: string;
  last_seen_at: string;
  expires_at: string | null;
  lifetime_kind: "explicit_continuing" | "inferred" | "task" | "routing";
  continuation_basis: string;
  confirmed_at: string | null;
  version: number;
  counterevidence_event_id: string | null;
  last_confirmation_asked_at: string | null;
  confirmation_state: "none" | "offered" | "answered";
}

interface PrincipleEvidenceRow {
  event_id: string;
  session_id_hash: string;
  observed_at: string;
  raw_text_hash: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hasCorrectionPrinciplesSchema(db: Pick<Database.Database, "prepare">): boolean {
  const version = db.prepare("SELECT MAX(version) AS version FROM schema_version").get() as {
    version: number | null;
  };
  return version.version !== null && version.version >= CORRECTION_PRINCIPLES_SCHEMA_VERSION;
}

function parseAt(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("correction principle time must be valid");
  return parsed;
}

function toIso(value: number): string {
  return new Date(value).toISOString();
}

function getPrincipleBundle(
  db: Pick<Database.Database, "prepare">,
  principleKey: string,
): PrincipleBundleRow | undefined {
  return db.prepare(`
    SELECT bundle_key, memory_id, rule_text, topic_key, polarity, condition_key, project, scope,
      visibility, status, intensity, occurrence_count, session_count, first_seen_at, last_seen_at,
      expires_at, lifetime_kind, continuation_basis, confirmed_at, version, counterevidence_event_id,
      last_confirmation_asked_at, confirmation_state
    FROM owner_correction_bundles WHERE bundle_key = ?
  `).get(principleKey) as PrincipleBundleRow | undefined;
}

function assertPrincipleKey(principleKey: string): void {
  if (!principleKey.startsWith(PRINCIPLE_PREFIX)) throw new Error("correction principle key is invalid");
}

function readPrincipleEvidence(
  db: Pick<Database.Database, "prepare">,
  principleKey: string,
): CorrectionPrincipleEvidence {
  const rows = db.prepare(`
    SELECT event.event_id, event.session_id_hash, event.observed_at, event.raw_text_hash
    FROM owner_correction_principle_members AS member
    JOIN owner_correction_bundles AS member_bundle
      ON member_bundle.bundle_key = member.member_key
      AND member_bundle.status NOT IN ('rejected', 'disputed')
    JOIN owner_correction_evidence AS evidence ON evidence.bundle_key = member.member_key
    JOIN owner_correction_events AS event ON event.event_id = evidence.event_id
    WHERE member.principle_key = ?
    ORDER BY event.observed_at, event.session_id_hash, event.event_id
  `).all(principleKey) as PrincipleEvidenceRow[];
  const uniqueEvidence: PrincipleEvidenceRow[] = [];
  const seenEvidence = new Set<string>();
  for (const row of rows) {
    const minute = Math.floor(parseAt(row.observed_at) / 60_000);
    const key = `${minute}:${row.raw_text_hash}`;
    if (seenEvidence.has(key)) continue;
    seenEvidence.add(key);
    uniqueEvidence.push(row);
  }
  const sessions = new Set(uniqueEvidence.map((row) => row.session_id_hash));
  const orderedTimes = uniqueEvidence.map((row) => parseAt(row.observed_at)).sort((left, right) => left - right);
  const firstAt = orderedTimes.length === 0 ? null : toIso(orderedTimes[0]);
  const latestAt = orderedTimes.length === 0 ? null : toIso(orderedTimes[orderedTimes.length - 1]);
  return {
    evidenceCount: uniqueEvidence.length,
    sessionCount: sessions.size,
    eventIds: uniqueEvidence.map((row) => row.event_id),
    firstAt,
    latestAt,
  };
}

function insertPrincipleVersion(
  db: Pick<Database.Database, "prepare">,
  input: {
    bundle: PrincipleBundleRow;
    version: number;
    status: "candidate" | "confirmed" | "rejected";
    confirmedAt: string | null;
    expiresAt: string | null;
    evidenceEventIds: readonly string[];
    effectiveFrom: string;
    changeReason: string;
  },
): void {
  db.prepare(`
    INSERT INTO owner_correction_versions (
      bundle_key, version, rule_text, body_hash, conditions, condition_key, polarity, visibility,
      status, confirmed_at, expires_at, lifetime_kind, continuation_basis, evidence_event_ids,
      effective_from, change_reason
    ) VALUES (?, ?, ?, ?, '[]', ?, ?, 'owner', ?, ?, ?, 'inferred', 'principle_abstraction', ?, ?, ?)
  `).run(
    input.bundle.bundle_key,
    input.version,
    input.bundle.rule_text,
    sha256(input.bundle.rule_text),
    input.bundle.condition_key,
    input.bundle.polarity,
    input.status,
    input.confirmedAt,
    input.expiresAt,
    JSON.stringify(input.evidenceEventIds),
    input.effectiveFrom,
    input.changeReason,
  );
}

function summarizeOrEmpty(
  db: Pick<Database.Database, "prepare">,
  principleKey: string,
  fallbackAt: string,
): CorrectionPrincipleEvidence {
  const evidence = readPrincipleEvidence(db, principleKey);
  if (evidence.firstAt !== null && evidence.latestAt !== null) return evidence;
  return { ...evidence, firstAt: fallbackAt, latestAt: fallbackAt };
}

export function getCorrectionPrinciplesMode(
  env: NodeJS.ProcessEnv = process.env,
): CorrectionPrinciplesMode {
  return readEnvironmentMode({
    name: "WASURENAGUSA_PRINCIPLES",
    value: env.WASURENAGUSA_PRINCIPLES,
    acceptedValues: ["off", "shadow", "on"],
    defaultValue: "shadow",
    invalidValue: "off",
    lowercase: true,
  });
}

export function normalizeCorrectionPrincipleText(ruleText: string): string {
  const normalized = ruleText.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) throw new Error("correction principle text is empty");
  if (Array.from(normalized).length > 120) throw new Error("correction principle text exceeds 120 characters");
  return normalized;
}

export function correctionPrincipleKey(ruleText: string): string {
  return PRINCIPLE_PREFIX + sha256(normalizeCorrectionPrincipleText(ruleText));
}

export function correctionPrincipleCandidateFilter(
  db: Pick<Database.Database, "prepare">,
  at: string,
  bundleAlias: "b" | "bundle" = "b",
  mode: CorrectionPrinciplesMode = getCorrectionPrinciplesMode(),
): { sql: string; parameters: string[] } {
  if (mode !== "on") {
    return { sql: `AND ${bundleAlias}.bundle_key NOT LIKE 'pr:v1:%'`, parameters: [] };
  }
  if (!hasCorrectionPrinciplesSchema(db)) {
    return { sql: "", parameters: [] };
  }
  const table = db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get("owner_correction_principle_members");
  if (!table) throw new Error("schema version 13 is missing owner correction principle members");
  return {
    sql: `
      AND NOT EXISTS (
        SELECT 1
        FROM owner_correction_principle_members AS member
        JOIN owner_correction_bundles AS principle
          ON principle.bundle_key = member.principle_key
        WHERE member.member_key = ${bundleAlias}.bundle_key
          AND principle.status = 'confirmed'
          AND principle.confirmed_at IS NOT NULL
          AND julianday(principle.confirmed_at) <= julianday(?)
      )
    `,
    parameters: [at],
  };
}

export function createCorrectionPrinciple(
  transaction: CorrectionStoreTransaction,
  input: { ruleText: string; polarity: "positive" | "negative"; at: string },
): CorrectionPrincipleCreationResult {
  if (getCorrectionPrinciplesMode() === "off" || !hasCorrectionPrinciplesSchema(transaction.db)) {
    return { status: "disabled", principleKey: null };
  }
  const ruleText = normalizeCorrectionPrincipleText(input.ruleText);
  const at = toIso(parseAt(input.at));
  const principleKey = correctionPrincipleKey(ruleText);
  const existing = getPrincipleBundle(transaction.db, principleKey);
  if (existing) {
    if (existing.rule_text !== ruleText || existing.polarity !== input.polarity) {
      throw new Error("correction principle key descriptor collision");
    }
    if (existing.status === "rejected" || existing.status === "disputed") {
      return { status: "terminal", principleKey };
    }
    return { status: "ready", principleKey };
  }

  const expiresAt = toIso(parseAt(at) + CANDIDATE_TTL_MS);
  transaction.db.prepare(`
    INSERT INTO owner_correction_bundles (
      bundle_key, memory_id, rule_text, topic_key, polarity, condition_key, project, scope,
      visibility, status, intensity, occurrence_count, session_count, first_seen_at, last_seen_at,
      expires_at, lifetime_kind, continuation_basis, confirmed_at, version, counterevidence_event_id,
      last_confirmation_asked_at, confirmation_state
    ) VALUES (?, NULL, ?, 'principle', ?, 'general', 'owner', 'owner', 'owner', 'candidate',
      1, 0, 0, ?, ?, ?, 'inferred', 'principle_abstraction', NULL, 1, NULL, NULL, 'none')
  `).run(principleKey, ruleText, input.polarity, at, at, expiresAt);
  const bundle = getPrincipleBundle(transaction.db, principleKey);
  if (!bundle) throw new Error("correction principle insert failed");
  insertPrincipleVersion(transaction.db, {
    bundle,
    version: 1,
    status: "candidate",
    confirmedAt: null,
    expiresAt,
    evidenceEventIds: [],
    effectiveFrom: at,
    changeReason: "principle_created",
  });
  return { status: "ready", principleKey };
}

export function addCorrectionPrincipleMembers(
  transaction: CorrectionStoreTransaction,
  input: {
    principleKey: string;
    memberBundleKeys: readonly string[];
    attachedAt: string;
    attachSource: CorrectionPrincipleAttachSource;
  },
): number {
  if (getCorrectionPrinciplesMode() === "off" || !hasCorrectionPrinciplesSchema(transaction.db)) return 0;
  assertPrincipleKey(input.principleKey);
  const attachedAt = toIso(parseAt(input.attachedAt));
  if (input.memberBundleKeys.length === 0) throw new Error("correction principle requires members");
  const principle = getPrincipleBundle(transaction.db, input.principleKey);
  if (!principle) throw new Error("correction principle was not found");
  if (principle.status !== "candidate" && principle.status !== "confirmed") {
    throw new Error("inactive correction principle cannot accept members");
  }

  const memberKeys = [...new Set(input.memberBundleKeys)];
  if (memberKeys.includes(input.principleKey)) throw new Error("correction principle cannot contain itself");
  const memberRows = memberKeys.map((memberKey) => {
    const row = transaction.db.prepare(`
      SELECT bundle_key, status, visibility, polarity, intensity
      FROM owner_correction_bundles WHERE bundle_key = ?
    `).get(memberKey) as {
      bundle_key: string;
      status: string;
      visibility: string;
      polarity: string;
      intensity: number;
    } | undefined;
    if (!row) throw new Error("correction principle member was not found");
    if (row.bundle_key.startsWith(PRINCIPLE_PREFIX)) throw new Error("correction principle cannot contain another principle");
    if (row.status !== "candidate" && row.status !== "confirmed") {
      throw new Error("inactive correction bundle cannot join a principle");
    }
    if (row.visibility !== "owner" || row.polarity !== principle.polarity) {
      throw new Error("correction principle members must share owner visibility and polarity");
    }
    return row;
  });

  const insertMember = transaction.db.prepare(`
    INSERT OR IGNORE INTO owner_correction_principle_members (
      principle_key, member_key, attached_at, attach_source
    ) VALUES (?, ?, ?, ?)
  `);
  let addedCount = 0;
  for (const memberKey of memberKeys) {
    addedCount += Number(insertMember.run(
      input.principleKey,
      memberKey,
      attachedAt,
      input.attachSource,
    ).changes === 1);
  }
  if (addedCount === 0) return 0;

  const evidence = summarizeOrEmpty(transaction.db, input.principleKey, attachedAt);
  const firstSeenAt = evidence.firstAt as string;
  const latestSeenAt = evidence.latestAt as string;
  const intensity = Math.max(principle.intensity, ...memberRows.map((row) => row.intensity));
  const expiresAt = toIso(parseAt(latestSeenAt) + INFERRED_TTL_MS);
  if (principle.status === "candidate") {
    transaction.db.prepare(`
      UPDATE owner_correction_bundles SET intensity = ?, occurrence_count = ?, session_count = ?,
        first_seen_at = ?, last_seen_at = ?, expires_at = ?
      WHERE bundle_key = ?
    `).run(intensity, evidence.evidenceCount, evidence.sessionCount, firstSeenAt, latestSeenAt, expiresAt, input.principleKey);
    return addedCount;
  }

  const version = principle.version + 1;
  transaction.db.prepare(`
    UPDATE owner_correction_bundles SET intensity = ?, occurrence_count = ?, session_count = ?,
      first_seen_at = ?, last_seen_at = ?, expires_at = ?, version = ?
    WHERE bundle_key = ?
  `).run(intensity, evidence.evidenceCount, evidence.sessionCount, firstSeenAt, latestSeenAt, expiresAt, version, input.principleKey);
  const updated = getPrincipleBundle(transaction.db, input.principleKey);
  if (!updated) throw new Error("correction principle disappeared after member attachment");
  insertPrincipleVersion(transaction.db, {
    bundle: updated,
    version,
    status: "confirmed",
    confirmedAt: updated.confirmed_at,
    expiresAt,
    evidenceEventIds: evidence.eventIds,
    effectiveFrom: attachedAt,
    changeReason: "principle_member_added",
  });
  return addedCount;
}

export function getCorrectionPrincipleEvidence(
  db: Pick<Database.Database, "prepare">,
  principleKey: string,
): CorrectionPrincipleEvidence {
  if (getCorrectionPrinciplesMode() === "off" || !hasCorrectionPrinciplesSchema(db)) {
    return { evidenceCount: 0, sessionCount: 0, eventIds: [], firstAt: null, latestAt: null };
  }
  assertPrincipleKey(principleKey);
  return readPrincipleEvidence(db, principleKey);
}

export function shouldConfirmCorrectionPrinciple(
  db: Pick<Database.Database, "prepare">,
  principleKey: string,
): boolean {
  if (getCorrectionPrinciplesMode() === "off" || !hasCorrectionPrinciplesSchema(db)) return false;
  assertPrincipleKey(principleKey);
  const principle = getPrincipleBundle(db, principleKey);
  if (!principle || principle.status !== "candidate") return false;
  const evidence = readPrincipleEvidence(db, principleKey);
  return evidence.sessionCount >= 2;
}

export function confirmCorrectionPrinciple(
  transaction: CorrectionStoreTransaction,
  input: { principleKey: string; at: string },
): CorrectionStoreResult | null {
  if (getCorrectionPrinciplesMode() !== "on" || !hasCorrectionPrinciplesSchema(transaction.db)) return null;
  assertPrincipleKey(input.principleKey);
  const at = toIso(parseAt(input.at));
  const principle = getPrincipleBundle(transaction.db, input.principleKey);
  if (!principle) throw new Error("correction principle was not found");
  if (principle.status === "confirmed") {
    return {
      bundleKey: principle.bundle_key,
      status: principle.status,
      occurrenceCount: principle.occurrence_count,
      sessionCount: principle.session_count,
      intensity: principle.intensity,
      version: principle.version,
      memoryId: principle.memory_id,
    };
  }
  if (principle.status !== "candidate" || !shouldConfirmCorrectionPrinciple(transaction.db, input.principleKey)) {
    return null;
  }
  const evidence = summarizeOrEmpty(transaction.db, input.principleKey, at);
  const latestEvidenceAt = evidence.latestAt as string;
  const expiresAt = toIso(parseAt(latestEvidenceAt) + INFERRED_TTL_MS);
  const saved = transaction.save({
    category: "dont",
    title: `owner-correction:${principle.bundle_key}`,
    content: principle.rule_text,
    tags: ["owner_correction", "principle"],
    project: "owner",
    scope: "owner",
    intensity: principle.intensity,
  });
  const version = principle.version + 1;
  transaction.db.prepare(`
    UPDATE owner_correction_bundles SET memory_id = ?, status = 'confirmed', occurrence_count = ?,
      session_count = ?, last_seen_at = ?, expires_at = ?, confirmed_at = ?, version = ?
    WHERE bundle_key = ?
  `).run(
    saved.id,
    evidence.evidenceCount,
    evidence.sessionCount,
    latestEvidenceAt,
    expiresAt,
    at,
    version,
    input.principleKey,
  );
  const confirmed = getPrincipleBundle(transaction.db, input.principleKey);
  if (!confirmed) throw new Error("correction principle disappeared after confirmation");
  insertPrincipleVersion(transaction.db, {
    bundle: confirmed,
    version,
    status: "confirmed",
    confirmedAt: at,
    expiresAt,
    evidenceEventIds: evidence.eventIds,
    effectiveFrom: at,
    changeReason: "principle_confirmed",
  });
  return {
    bundleKey: confirmed.bundle_key,
    status: confirmed.status,
    occurrenceCount: confirmed.occurrence_count,
    sessionCount: confirmed.session_count,
    intensity: confirmed.intensity,
    version: confirmed.version,
    memoryId: confirmed.memory_id,
  };
}

export function confirmEligibleCorrectionPrinciples(
  transaction: CorrectionStoreTransaction,
  at: string,
): string[] {
  if (getCorrectionPrinciplesMode() !== "on" || !hasCorrectionPrinciplesSchema(transaction.db)) return [];
  const effectiveAt = toIso(parseAt(at));
  const candidates = transaction.db.prepare(`
    SELECT bundle_key FROM owner_correction_bundles
    WHERE bundle_key LIKE 'pr:v1:%' AND status = 'candidate' AND visibility = 'owner'
      AND (expires_at IS NULL OR julianday(expires_at) > julianday(?))
    ORDER BY bundle_key
  `).all(effectiveAt) as Array<{ bundle_key: string }>;
  const confirmedKeys: string[] = [];
  for (const candidate of candidates) {
    const confirmed = confirmCorrectionPrinciple(transaction, {
      principleKey: candidate.bundle_key,
      at: effectiveAt,
    });
    if (confirmed?.status === "confirmed") confirmedKeys.push(candidate.bundle_key);
  }
  return confirmedKeys;
}

export function cancelCorrectionPrinciple(
  transaction: CorrectionStoreTransaction,
  input: { principleKey: string; eventId: string; at: string },
): CorrectionStoreResult | null {
  if (getCorrectionPrinciplesMode() !== "on" || !hasCorrectionPrinciplesSchema(transaction.db)) return null;
  assertPrincipleKey(input.principleKey);
  return cancelCorrectionBundle(transaction, {
    bundleKey: input.principleKey,
    eventId: input.eventId,
    at: input.at,
  });
}

interface AbstractionBundleRow {
  bundle_key: string;
  rule_text: string;
  topic_key: string;
  polarity: string;
  status: string;
  visibility: string;
  conditions: string;
  event_id: string;
  session_id_hash: string;
  observed_at: string;
  raw_text_hash: string;
}

interface AbstractionPrincipleRow {
  principle_key: string;
  rule_text: string;
  polarity: string;
  status: string;
}

interface AbstractionMembershipRow {
  principle_key: string;
  member_key: string;
}

interface ExistingPrincipleCandidate {
  principleKey: string;
  ruleText: string;
  polarity: string;
  status: string;
  members: CorrectionPrincipleAbstractionCandidate[];
}

interface PrincipleGroupDraft extends Omit<CorrectionPrincipleAbstractionGroup, "groupId"> {
  sortKey: string;
}

function normalizedAbstractionText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
}

function distinctAbstractionEvidence(
  candidates: readonly CorrectionPrincipleAbstractionCandidate[],
): CorrectionPrincipleAbstractionEvidence[] {
  const evidence = candidates.flatMap((candidate) => candidate.evidence)
    .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt)
      || left.sessionIdHash.localeCompare(right.sessionIdHash)
      || left.eventId.localeCompare(right.eventId));
  const uniqueEvidence: CorrectionPrincipleAbstractionEvidence[] = [];
  const seen = new Set<string>();
  for (const item of evidence) {
    const minute = Math.floor(parseAt(item.observedAt) / 60_000);
    const key = `${minute}:${item.rawTextHash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueEvidence.push(item);
  }
  return uniqueEvidence;
}

function distinctAbstractionSessionCount(
  candidates: readonly CorrectionPrincipleAbstractionCandidate[],
): number {
  return new Set(distinctAbstractionEvidence(candidates).map((item) => item.sessionIdHash)).size;
}

function sharesRequiredValuesKey(
  left: CorrectionPrincipleAbstractionCandidate,
  right: CorrectionPrincipleAbstractionCandidate,
): boolean {
  const rightKeys = new Set(right.requiredValuesKeys);
  return left.requiredValuesKeys.some((key) => rightKeys.has(key));
}

function abstractionCandidatesMatch(
  left: CorrectionPrincipleAbstractionCandidate,
  right: CorrectionPrincipleAbstractionCandidate,
): boolean {
  return left.polarity === right.polarity
    && (diceCoefficient(left.ruleText, right.ruleText) >= ABSTRACTION_DICE_THRESHOLD
      || sharesRequiredValuesKey(left, right));
}

function createAbstractionDraft(
  kind: CorrectionPrincipleAttachSource,
  principleKey: string | null,
  principleRuleText: string | null,
  memberCandidates: readonly CorrectionPrincipleAbstractionCandidate[],
  evidenceCandidates: readonly CorrectionPrincipleAbstractionCandidate[],
): PrincipleGroupDraft {
  const items: CorrectionPrincipleAbstractionGroupItem[] = [];
  if (principleKey !== null && principleRuleText !== null) {
    items.push({ id: 1, bundleKey: principleKey, ruleText: principleRuleText });
  }
  const firstMemberId = items.length + 1;
  for (const [index, member] of memberCandidates.entries()) {
    items.push({ id: firstMemberId + index, bundleKey: member.bundleKey, ruleText: member.ruleText });
  }
  const memberBundleKeys = memberCandidates.map((candidate) => candidate.bundleKey);
  const sortKey = `${kind}:${principleKey ?? memberBundleKeys.join(",")}`;
  return {
    kind,
    principleKey,
    memberBundleKeys,
    distinctSessionCount: distinctAbstractionSessionCount(evidenceCandidates),
    items,
    sortKey,
  };
}

function chunkAbstractionCandidates(
  candidates: readonly CorrectionPrincipleAbstractionCandidate[],
  maximumSize: number,
): CorrectionPrincipleAbstractionCandidate[][] {
  const groupCount = Math.ceil(candidates.length / maximumSize);
  if (groupCount === 0) return [];
  const baseSize = Math.floor(candidates.length / groupCount);
  const extraCount = candidates.length % groupCount;
  const chunks: CorrectionPrincipleAbstractionCandidate[][] = [];
  let offset = 0;
  for (let index = 0; index < groupCount; index += 1) {
    const chunkSize = baseSize + Number(index < extraCount);
    chunks.push(candidates.slice(offset, offset + chunkSize));
    offset += chunkSize;
  }
  return chunks;
}

function eligibleAbstractionCandidate(candidate: CorrectionPrincipleAbstractionCandidate): boolean {
  return !candidate.bundleKey.startsWith(PRINCIPLE_PREFIX)
    && (candidate.status === "candidate" || candidate.status === "confirmed")
    && candidate.visibility === "owner"
    && OWNER_VISIBLE_TOPICS.has(candidate.topicKey)
    && (candidate.polarity === "positive" || candidate.polarity === "negative")
    && candidate.evidence.length > 0;
}

function createCorrectionPrincipleGroupDrafts(
  allCandidates: readonly CorrectionPrincipleAbstractionCandidate[],
  existingPrinciples: readonly ExistingPrincipleCandidate[],
  attachedMemberKeys: ReadonlySet<string>,
): PrincipleGroupDraft[] {
  const candidates = allCandidates.filter(eligibleAbstractionCandidate);
  const pending = candidates.filter((candidate) => !attachedMemberKeys.has(candidate.bundleKey));
  const assigned = new Set<string>();
  const drafts: PrincipleGroupDraft[] = [];
  const principles = [...existingPrinciples]
    .filter((principle) => (principle.status === "candidate" || principle.status === "confirmed")
      && (principle.polarity === "positive" || principle.polarity === "negative"))
    .sort((left, right) => Number(right.status === "confirmed") - Number(left.status === "confirmed")
      || right.members.length - left.members.length
      || left.principleKey.localeCompare(right.principleKey));

  for (const principle of principles) {
    const referenceCandidates = principle.members.filter(eligibleAbstractionCandidate);
    const matchedCandidates = pending.filter((candidate) => !assigned.has(candidate.bundleKey)
      && candidate.polarity === principle.polarity
      && (diceCoefficient(candidate.ruleText, principle.ruleText) >= ABSTRACTION_DICE_THRESHOLD
        || referenceCandidates.some((reference) => abstractionCandidatesMatch(candidate, reference))));
    const orderedMatches = [...matchedCandidates].sort((left, right) =>
      distinctAbstractionSessionCount([right]) - distinctAbstractionSessionCount([left])
      || left.bundleKey.localeCompare(right.bundleKey));
    for (const chunk of chunkAbstractionCandidates(orderedMatches, ABSTRACTION_MEMBER_LIMIT - 1)) {
      if (chunk.length === 0) continue;
      for (const candidate of chunk) assigned.add(candidate.bundleKey);
      drafts.push(createAbstractionDraft(
        "later_attach",
        principle.principleKey,
        principle.ruleText,
        chunk,
        [...referenceCandidates, ...chunk],
      ));
    }
  }

  const unassigned = pending.filter((candidate) => !assigned.has(candidate.bundleKey));
  const parent = unassigned.map((_candidate, index) => index);
  const findRoot = (index: number): number => {
    if (parent[index] !== index) parent[index] = findRoot(parent[index]);
    return parent[index];
  };
  const union = (left: number, right: number): void => {
    const leftRoot = findRoot(left);
    const rightRoot = findRoot(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };
  for (let left = 0; left < unassigned.length; left += 1) {
    for (let right = left + 1; right < unassigned.length; right += 1) {
      if (abstractionCandidatesMatch(unassigned[left], unassigned[right])) union(left, right);
    }
  }

  const components = new Map<number, CorrectionPrincipleAbstractionCandidate[]>();
  for (let index = 0; index < unassigned.length; index += 1) {
    const root = findRoot(index);
    const component = components.get(root) ?? [];
    component.push(unassigned[index]);
    components.set(root, component);
  }
  for (const component of components.values()) {
    const orderedComponent = [...component].sort((left, right) => left.bundleKey.localeCompare(right.bundleKey));
    for (const chunk of chunkAbstractionCandidates(orderedComponent, ABSTRACTION_MEMBER_LIMIT)) {
      if (chunk.length < 2) continue;
      const sessionCount = distinctAbstractionSessionCount(chunk);
      const ruleVariants = new Set(chunk.map((candidate) => normalizedAbstractionText(candidate.ruleText)));
      if (sessionCount < ABSTRACTION_MIN_SESSIONS || ruleVariants.size < 2) continue;
      drafts.push(createAbstractionDraft("cluster", null, null, chunk, chunk));
    }
  }

  return drafts.sort((left, right) => right.distinctSessionCount - left.distinctSessionCount
    || right.memberBundleKeys.length - left.memberBundleKeys.length
    || left.sortKey.localeCompare(right.sortKey));
}

export function buildCorrectionPrincipleAbstractionGroups(
  db: Pick<Database.Database, "prepare">,
  at: string,
): CorrectionPrincipleAbstractionGroup[] {
  if (!hasCorrectionPrinciplesSchema(db)) throw new Error("correction principle abstraction requires schema version 13");
  const effectiveAt = toIso(parseAt(at));
  const topics = [...OWNER_VISIBLE_TOPICS];
  const rows = db.prepare(`
    SELECT bundle.bundle_key, bundle.rule_text, bundle.topic_key, bundle.polarity, bundle.status,
      bundle.visibility, evidence.conditions, event.event_id, event.session_id_hash,
      event.observed_at, event.raw_text_hash
    FROM owner_correction_bundles AS bundle
    JOIN owner_correction_evidence AS evidence ON evidence.bundle_key = bundle.bundle_key
    JOIN owner_correction_events AS event ON event.event_id = evidence.event_id
    WHERE bundle.bundle_key NOT LIKE 'pr:v1:%'
      AND bundle.status IN ('candidate','confirmed')
      AND bundle.visibility = 'owner'
      AND bundle.topic_key IN (${topics.map(() => "?").join(",")})
      AND (bundle.expires_at IS NULL OR julianday(bundle.expires_at) > julianday(?))
      AND julianday(event.available_at) <= julianday(?)
    ORDER BY bundle.bundle_key, event.observed_at, event.event_id
  `).all(...topics, effectiveAt, effectiveAt) as AbstractionBundleRow[];
  const candidatesByKey = new Map<string, CorrectionPrincipleAbstractionCandidate>();
  for (const row of rows) {
    const candidate = candidatesByKey.get(row.bundle_key) ?? {
      bundleKey: row.bundle_key,
      ruleText: row.rule_text,
      topicKey: row.topic_key,
      polarity: row.polarity,
      status: row.status,
      visibility: row.visibility,
      requiredValuesKeys: [],
      evidence: [],
    };
    const parsedRule = parseCorrectionRuleInput(row.conditions);
    if (parsedRule) {
      const requiredValuesKey = correctionRequiredValuesKey(parsedRule);
      if (requiredValuesKey !== "{}" && !candidate.requiredValuesKeys.includes(requiredValuesKey)) {
        candidate.requiredValuesKeys.push(requiredValuesKey);
      }
    }
    candidate.evidence.push({
      eventId: row.event_id,
      sessionIdHash: row.session_id_hash,
      observedAt: row.observed_at,
      rawTextHash: row.raw_text_hash,
    });
    candidatesByKey.set(row.bundle_key, candidate);
  }

  const principleRows = db.prepare(`
    SELECT bundle_key AS principle_key, rule_text, polarity, status
    FROM owner_correction_bundles
    WHERE bundle_key LIKE 'pr:v1:%' AND status IN ('candidate','confirmed')
      AND visibility = 'owner'
      AND (expires_at IS NULL OR julianday(expires_at) > julianday(?))
    ORDER BY bundle_key
  `).all(effectiveAt) as AbstractionPrincipleRow[];
  const memberships = db.prepare(`
    SELECT member.principle_key, member.member_key
    FROM owner_correction_principle_members AS member
    JOIN owner_correction_bundles AS principle ON principle.bundle_key = member.principle_key
    WHERE principle.status IN ('candidate','confirmed')
      AND principle.visibility = 'owner'
      AND (principle.expires_at IS NULL OR julianday(principle.expires_at) > julianday(?))
    ORDER BY member.principle_key, member.member_key
  `).all(effectiveAt) as AbstractionMembershipRow[];
  const membershipsByPrinciple = new Map<string, string[]>();
  const attachedMemberKeys = new Set<string>();
  for (const row of memberships) {
    const memberKeys = membershipsByPrinciple.get(row.principle_key) ?? [];
    memberKeys.push(row.member_key);
    membershipsByPrinciple.set(row.principle_key, memberKeys);
    attachedMemberKeys.add(row.member_key);
  }
  const existingPrinciples = principleRows.map((row) => ({
    principleKey: row.principle_key,
    ruleText: row.rule_text,
    polarity: row.polarity,
    status: row.status,
    members: (membershipsByPrinciple.get(row.principle_key) ?? [])
      .map((memberKey) => candidatesByKey.get(memberKey))
      .filter((candidate): candidate is CorrectionPrincipleAbstractionCandidate => candidate !== undefined),
  }));
  const drafts = createCorrectionPrincipleGroupDrafts(
    [...candidatesByKey.values()],
    existingPrinciples,
    attachedMemberKeys,
  ).slice(0, ABSTRACTION_GROUP_LIMIT);
  return drafts.map((draft, index) => ({
    groupId: `g-${String(index + 1).padStart(4, "0")}`,
    kind: draft.kind,
    principleKey: draft.principleKey,
    memberBundleKeys: draft.memberBundleKeys,
    distinctSessionCount: draft.distinctSessionCount,
    items: draft.items,
  }));
}

function classifyAbstractionPolarity(value: string): "positive" | "negative" | null {
  const hasNegative = NEGATIVE_POLARITY.test(value);
  const hasPositive = POSITIVE_POLARITY.test(value);
  if (hasNegative === hasPositive) return null;
  return hasNegative ? "negative" : "positive";
}

function rejectAbstraction(reason: CorrectionPrincipleAbstractionGuardReason): CorrectionPrincipleAbstractionGuardResult {
  return { accepted: false, reason, principle: null };
}

export function guardCorrectionPrincipleAbstraction(
  group: CorrectionPrincipleAbstractionGroup,
  output: CorrectionPrincipleAbstractionOutput,
  expectedPolarity: "positive" | "negative",
): CorrectionPrincipleAbstractionGuardResult {
  if (output.verdict === "none") return rejectAbstraction("none");
  if (output.odd_ids.length > 0) return rejectAbstraction("mixed_intents");
  const principle = output.principle.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (principle.length === 0) return rejectAbstraction("empty_principle");
  if (Array.from(principle).length > 120) return rejectAbstraction("principle_too_long");

  const sourceTexts = group.items.map((item) => normalizedAbstractionText(item.ruleText));
  const contentWords = Array.from(principle.matchAll(/[\p{Script=Han}\p{Script=Katakana}A-Za-z0-9]{2,}/gu), (match) => match[0]);
  if (contentWords.some((word) => !sourceTexts.some((text) => text.includes(normalizedAbstractionText(word))))) {
    return rejectAbstraction("unsupported_term");
  }

  const polarity = classifyAbstractionPolarity(principle);
  if (polarity === null) return rejectAbstraction("polarity_ambiguous");
  if (polarity !== expectedPolarity) return rejectAbstraction("polarity_mismatch");
  return { accepted: true, reason: null, principle };
}
