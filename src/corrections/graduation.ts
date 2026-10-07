import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { CORRECTION_PRINCIPLES_SCHEMA_VERSION } from "../storage/correction-schema.js";
import { getSchemaVersion } from "../storage/schema.js";
import type { SQLiteStorage } from "../storage/sqlite.js";
import { hasCorrectionComplianceCheckerForPrinciple } from "./compliance.js";
import { parseCorrectionRuleInput } from "./rule-template.js";
import { getStrengthBaseIntensity } from "./strength.js";
import { readEnvironmentMode } from "./environment-mode.js";

const MINIMUM_CONFIRMATION_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PRINCIPLE_PREFIX = "pr:v1:";
const JEV_AGENT_TYPES = Array.from({ length: 38 }, (_value, index) => `a${String(index + 1).padStart(2, "0")}`);
const TOPIC_TRIGGERS: Record<string, readonly string[]> = {
  tone: ["口調", "文体", "敬体", "常体", "敬語"],
  response_policy: ["質問", "回答", "返答", "待機"],
  document_delivery: ["文書", "文章", "本文", "全文", "提示", "文案", "報告", "資料"],
  expression_policy: ["言葉", "用語", "略号", "略語", "比喩"],
  summary_constraints: ["要約", "字数", "文字数", "長さ"],
  design_components: ["デザイン", "部品", "フォント", "css"],
  verification: ["検証", "確認", "出典", "原本"],
  delegation_roles: ["設計", "実装", "作業", "委譲"],
  storage_location: ["保存", "配置", "一時", "成果物"],
  model_routing: ["モデル", "経路", "担当", "利用枠"],
  unknown: [],
  principle: [],
};
const NEGATIVE_EXCLUSION_MARKERS = ["ただし", "例外", "以外", "を除く"] as const;
const SECRET_VALUE = /(?:\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{20,}\b|\bsk-[A-Za-z0-9]{20,}\b|\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_-]{20,}\b|\bBearer\s+\S+|-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b)/iu;
const PATH_VALUE = /(?:^|[\s"'(])(?:\/|~\/|\.\.?\/|[A-Za-z]:[\\/])[^\s"')]+|\b[\p{L}\p{N}_.-]+[\\/][\p{L}\p{N}_.\\/-]+|\.[A-Za-z0-9_-]{1,12}(?:\s|$)/u;
const UNSAFE_PROPOSAL_TEXT = /[\u0000-\u001f\u007f]|https?:\/\/|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu;

export type GraduationMode = "off" | "on";
export type GraduationDelivery = "scene" | "always";

export interface CorrectionGraduationEvidence {
  sessions: number;
  days: number;
  injected_sessions: number;
  failures_after_injection: number;
  violations: number;
}

export interface CorrectionGraduationEntry {
  principle_key: string;
  rule_text: string;
  topic_key: string;
  delivery: GraduationDelivery;
  triggers: string[];
  exclude_patterns: string[];
  types: string[];
  evidence: CorrectionGraduationEvidence;
}

export interface CorrectionGraduationProposal {
  schema: 1;
  generated_at: string;
  source_head: string;
  principles: CorrectionGraduationEntry[];
}

export interface CorrectionGraduationProposalOptions {
  at: string;
  sourceHead: string;
}

export type CorrectionGraduationProposalWriter = (proposal: CorrectionGraduationProposal) => void;

interface GraduationBundleRow {
  bundle_key: string;
  memory_id: string | null;
  rule_text: string;
  topic_key: string;
  visibility: "owner" | "project";
  status: "candidate" | "confirmed" | "expired" | "rejected" | "disputed";
  intensity: number;
  lifetime_kind: "explicit_continuing" | "inferred" | "task" | "routing";
  confirmed_at: string | null;
  expires_at: string | null;
}

interface GraduationSourceRow {
  bundle_key: string;
  rule_text: string;
  topic_key: string;
  conditions: string;
  polarity: "positive" | "negative";
}

interface SettledEventRow {
  at: string;
  basis: string;
}

interface SettledEvidence {
  at: string;
  sessions: number;
  days: number;
}

interface GraduationHistoryRow {
  bundle_key: string;
  graduated_at: string;
  revoked_at: string | null;
}

interface RevokedGraduationRow {
  bundle_key: string;
  graduated_at: string;
}

function canonicalTime(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("correction graduation time must be valid");
  return new Date(parsed).toISOString();
}

function validateSourceHead(value: string): void {
  if (!/^[0-9a-f]{7,64}$/iu.test(value)) throw new Error("correction graduation source head must be a git hash");
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function isSafeProposalText(value: string): boolean {
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length === 0 || PATH_VALUE.test(normalized) || SECRET_VALUE.test(normalized)) return false;
  return !UNSAFE_PROPOSAL_TEXT.test(normalized);
}

function assertGraduationTables(db: Pick<Database.Database, "prepare">): void {
  const requiredTables = [
    "owner_correction_graduations",
    "owner_correction_strength_events",
    "owner_correction_principle_members",
  ];
  const placeholders = requiredTables.map(() => "?").join(", ");
  const result = db.prepare(`
    SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})
  `).get(...requiredTables) as { count: number };
  if (result.count !== requiredTables.length) throw new Error("schema version 13 is missing owner correction graduation tables");
}

function principleMemberEligibilitySql(): string {
  return `
    AND (
      bundle.bundle_key NOT LIKE 'pr:v1:%'
      OR EXISTS (
        SELECT 1 FROM owner_correction_principle_members AS attached
        WHERE attached.principle_key = bundle.bundle_key
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM owner_correction_principle_members AS member
      JOIN owner_correction_bundles AS memberBundle ON memberBundle.bundle_key = member.member_key
      JOIN owner_correction_versions AS memberVersion
        ON memberVersion.bundle_key = memberBundle.bundle_key AND memberVersion.version = memberBundle.version
        WHERE member.principle_key = bundle.bundle_key
        AND (
          memberBundle.status NOT IN ('candidate','confirmed')
          OR memberVersion.status NOT IN ('candidate','confirmed')
          OR memberBundle.visibility <> 'owner' OR memberVersion.visibility <> 'owner'
          OR memberBundle.lifetime_kind NOT IN ('explicit_continuing','inferred')
          OR memberVersion.lifetime_kind NOT IN ('explicit_continuing','inferred')
          OR memberBundle.topic_key = 'model_routing'
        )
    )
  `;
}

export function resolveGraduationMode(raw: string | undefined): GraduationMode {
  return readEnvironmentMode({
    name: "WASURENAGUSA_GRADUATION",
    value: raw,
    acceptedValues: ["off", "on"],
    defaultValue: "off",
    invalidValue: "off",
    lowercase: true,
  });
}

export function isCorrectionGraduationEnabled(): boolean {
  return resolveGraduationMode(process.env.WASURENAGUSA_GRADUATION) === "on";
}

function readEvidenceSources(db: Pick<Database.Database, "prepare">, bundleKey: string): GraduationSourceRow[] {
  const sourceKeys = bundleKey.startsWith(PRINCIPLE_PREFIX)
    ? (db.prepare(`
        SELECT member_key FROM owner_correction_principle_members
        WHERE principle_key = ? ORDER BY member_key
      `).all(bundleKey) as Array<{ member_key: string }>).map((row) => row.member_key)
    : [bundleKey];
  const keys = uniqueSorted([...sourceKeys, bundleKey]);
  if (keys.length === 0) throw new Error("correction graduation source bundles are missing");
  const placeholders = keys.map(() => "?").join(", ");
  return db.prepare(`
    SELECT bundle.bundle_key, version.rule_text, bundle.topic_key, version.conditions, version.polarity
    FROM owner_correction_bundles AS bundle
    JOIN owner_correction_versions AS version
      ON version.bundle_key = bundle.bundle_key AND version.version = bundle.version
    WHERE bundle.bundle_key IN (${placeholders})
    ORDER BY bundle.bundle_key
  `).all(...keys) as GraduationSourceRow[];
}

function parseSettledEvidence(value: string): Omit<SettledEvidence, "at"> | null {
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("correction graduation settled evidence must be an object");
  }
  const record = parsed as Record<string, unknown>;
  if (record.signal !== "settled") return null;
  if (!Number.isSafeInteger(record.sessionCount) || !Number.isSafeInteger(record.dayCount)) {
    throw new Error("correction graduation settled evidence is incomplete");
  }
  const sessions = record.sessionCount as number;
  const days = record.dayCount as number;
  if (sessions < 5 || days < 3) return null;
  return { sessions, days };
}

function readLatestSettledEvidence(
  db: Pick<Database.Database, "prepare">,
  bundleKey: string,
  at: string,
  confirmedAt: string,
): SettledEvidence | null {
  const events = db.prepare(`
    SELECT at, basis FROM owner_correction_strength_events
    WHERE bundle_key = ? AND reason = 'manual' AND julianday(at) <= julianday(?)
    ORDER BY at DESC
  `).all(bundleKey, at) as SettledEventRow[];
  for (const event of events) {
    const evidence = parseSettledEvidence(event.basis);
    if (!evidence) continue;
    if (Date.parse(event.at) < Date.parse(confirmedAt)) continue;
    const laterFailure = db.prepare(`
      SELECT 1 AS present FROM owner_correction_strength_events
      WHERE bundle_key = ? AND reason = 'failure'
        AND julianday(at) > julianday(?) AND julianday(at) <= julianday(?)
      LIMIT 1
    `).get(bundleKey, event.at, at);
    if (laterFailure) continue;
    const laterEvidence = hasEvidenceAfter(db, bundleKey, event.at, at);
    if (laterEvidence) continue;
    return { at: event.at, ...evidence };
  }
  return null;
}

function hasEvidenceAfter(
  db: Pick<Database.Database, "prepare">,
  bundleKey: string,
  after: string,
  through: string,
): boolean {
  return Boolean(db.prepare(`
    SELECT 1 AS present
    FROM owner_correction_evidence AS evidence
    JOIN owner_correction_events AS event ON event.event_id = evidence.event_id
    WHERE julianday(event.observed_at) > julianday(?) AND julianday(event.observed_at) <= julianday(?)
      AND (
        evidence.bundle_key = ?
        OR EXISTS (
          SELECT 1 FROM owner_correction_principle_members AS member
          WHERE member.principle_key = ? AND member.member_key = evidence.bundle_key
        )
      )
    LIMIT 1
  `).get(after, through, bundleKey, bundleKey));
}

function readGraduationBundles(
  db: Pick<Database.Database, "prepare">,
  at: string,
): GraduationBundleRow[] {
  const minimumConfirmationAt = new Date(Date.parse(at) - MINIMUM_CONFIRMATION_AGE_MS).toISOString();
  return db.prepare(`
    SELECT bundle.bundle_key, bundle.memory_id, currentVersion.rule_text, bundle.topic_key, bundle.visibility,
      bundle.status, bundle.intensity, bundle.lifetime_kind, bundle.confirmed_at, bundle.expires_at
    FROM owner_correction_bundles AS bundle
    JOIN owner_correction_versions AS currentVersion
      ON currentVersion.bundle_key = bundle.bundle_key AND currentVersion.version = bundle.version
    JOIN memories AS memory ON memory.id = bundle.memory_id
    WHERE bundle.status = 'confirmed' AND memory.state = 'active' AND memory.category = 'dont'
      AND bundle.visibility = 'owner'
      AND bundle.lifetime_kind IN ('explicit_continuing','inferred')
      AND bundle.topic_key <> 'model_routing'
      AND currentVersion.status = 'confirmed' AND currentVersion.visibility = 'owner'
      AND currentVersion.lifetime_kind IN ('explicit_continuing','inferred')
      AND bundle.confirmed_at IS NOT NULL
      AND julianday(bundle.confirmed_at) <= julianday(?)
      AND (bundle.expires_at IS NULL OR julianday(bundle.expires_at) > julianday(?))
      ${principleMemberEligibilitySql()}
    ORDER BY bundle.bundle_key
  `).all(minimumConfirmationAt, at) as GraduationBundleRow[];
}

function validateBundleForProposal(bundle: GraduationBundleRow): void {
  if (!/^(?:pr:v1|oc:v1|oc:v2):[0-9a-f]{64}$/iu.test(bundle.bundle_key)) {
    throw new Error("correction graduation bundle key is invalid");
  }
  if (!Object.hasOwn(TOPIC_TRIGGERS, bundle.topic_key)) {
    throw new Error("correction graduation topic is unsupported");
  }
  if (!isSafeProposalText(bundle.rule_text)) throw new Error("correction graduation rule text contains an unsafe value");
}

function deriveEntry(
  db: Pick<Database.Database, "prepare">,
  bundle: GraduationBundleRow,
  settled: SettledEvidence,
): CorrectionGraduationEntry {
  validateBundleForProposal(bundle);
  const sources = readEvidenceSources(db, bundle.bundle_key);
  const triggers = [...TOPIC_TRIGGERS[bundle.topic_key]];
  const excludePatterns: string[] = [];
  for (const source of sources) {
    if (bundle.topic_key === "principle" && source.bundle_key !== bundle.bundle_key) {
      const sourceTopicTriggers = TOPIC_TRIGGERS[source.topic_key];
      if (sourceTopicTriggers === undefined) throw new Error("correction graduation source topic is unsupported");
      triggers.push(...sourceTopicTriggers);
    }
    if (source.polarity === "negative") {
      for (const marker of NEGATIVE_EXCLUSION_MARKERS) {
        if (source.rule_text.includes(marker)) excludePatterns.push(marker);
      }
    }
    const parsedConditions: unknown = JSON.parse(source.conditions);
    let requiredValues: Record<string, string>;
    if (Array.isArray(parsedConditions) && parsedConditions.length === 0) {
      requiredValues = {};
    } else {
      const input = parseCorrectionRuleInput(source.conditions);
      if (!input) throw new Error("correction graduation source conditions are invalid");
      requiredValues = input.requiredValues;
    }
    for (const value of Object.values(requiredValues)) {
      const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
      if (isSafeProposalText(normalized) && Array.from(normalized).length <= 40) triggers.push(normalized);
    }
  }
  const sortedTriggers = uniqueSorted(triggers.filter(isSafeProposalText));
  const sortedExclusions = uniqueSorted(excludePatterns.filter(isSafeProposalText));
  return {
    principle_key: bundle.bundle_key,
    rule_text: bundle.rule_text,
    topic_key: bundle.topic_key,
    delivery: sortedTriggers.length > 0 ? "scene" : "always",
    triggers: sortedTriggers,
    exclude_patterns: sortedExclusions,
    types: [...JEV_AGENT_TYPES],
    evidence: {
      sessions: settled.sessions,
      days: settled.days,
      injected_sessions: settled.sessions,
      failures_after_injection: 0,
      violations: 0,
    },
  };
}

function revokeGraduationsWithNewEvidence(
  db: Pick<Database.Database, "prepare">,
  at: string,
): void {
  const rows = db.prepare(`
    SELECT graduation.bundle_key, graduation.graduated_at
    FROM owner_correction_graduations AS graduation
    WHERE graduation.revoked_at IS NULL AND julianday(graduation.graduated_at) < julianday(?)
      AND EXISTS (
        SELECT 1
        FROM owner_correction_evidence AS evidence
        JOIN owner_correction_events AS event ON event.event_id = evidence.event_id
        WHERE julianday(event.observed_at) > julianday(graduation.graduated_at)
          AND julianday(event.observed_at) <= julianday(?)
          AND (
            evidence.bundle_key = graduation.bundle_key
            OR EXISTS (
              SELECT 1 FROM owner_correction_principle_members AS member
              WHERE member.principle_key = graduation.bundle_key AND member.member_key = evidence.bundle_key
            )
          )
      )
    ORDER BY graduation.bundle_key, graduation.graduated_at
  `).all(at, at) as RevokedGraduationRow[];
  if (rows.length === 0) return;

  const changedBundles = new Map<string, number>();
  for (const row of rows) {
    const changed = db.prepare(`
      UPDATE owner_correction_graduations
      SET revoked_at = ?, revoke_reason = 'new_evidence'
      WHERE bundle_key = ? AND graduated_at = ? AND revoked_at IS NULL
    `).run(at, row.bundle_key, row.graduated_at).changes;
    if (changed === 1) {
      const previousCount = changedBundles.get(row.bundle_key);
      if (previousCount === undefined) changedBundles.set(row.bundle_key, 1);
      else changedBundles.set(row.bundle_key, previousCount + 1);
    }
  }
  for (const [bundleKey, graduationCount] of changedBundles) {
    increaseStrengthAfterRevocation(db, bundleKey, at, graduationCount);
  }
}

function increaseStrengthAfterRevocation(
  db: Pick<Database.Database, "prepare">,
  bundleKey: string,
  at: string,
  graduationCount: number,
): void {
  const bundle = db.prepare(`
    SELECT intensity, memory_id, first_seen_at FROM owner_correction_bundles WHERE bundle_key = ?
  `).get(bundleKey) as { intensity: number; memory_id: string | null; first_seen_at: string } | undefined;
  if (!bundle) throw new Error("graduated correction bundle was not found during revocation");
  const existingEvent = db.prepare(`
    SELECT 1 AS present FROM owner_correction_strength_events
    WHERE bundle_key = ? AND at = ? AND reason = 'graduation_revoke'
  `).get(bundleKey, at);
  if (existingEvent) return;

  const baseIntensity = getStrengthBaseIntensity(db, {
    bundleKey,
    firstSeenAt: bundle.first_seen_at,
    intensity: bundle.intensity,
  });
  const priorCorrections = db.prepare(`
    SELECT COALESCE(SUM(delta), 0) AS delta FROM owner_correction_strength_events
    WHERE bundle_key = ? AND at >= ?
  `).get(bundleKey, bundle.first_seen_at) as { delta: number };
  const nextIntensity = Math.max(1, Math.min(5, baseIntensity + priorCorrections.delta + 1));
  db.prepare(`
    INSERT INTO owner_correction_strength_events (
      bundle_key, at, from_intensity, to_intensity, delta, reason, basis
    ) VALUES (?, ?, ?, ?, ?, 'graduation_revoke', ?)
  `).run(bundleKey, at, bundle.intensity, nextIntensity, 1, JSON.stringify({
    signal: "graduation_revoke",
    graduationCount,
    baseIntensity,
  }));
  db.prepare("UPDATE owner_correction_bundles SET intensity = ? WHERE bundle_key = ?")
    .run(nextIntensity, bundleKey);
  if (bundle.memory_id !== null) {
    db.prepare("UPDATE memories SET intensity = ? WHERE id = ?").run(nextIntensity, bundle.memory_id);
  }
}

function readGraduationHistory(
  db: Pick<Database.Database, "prepare">,
  at: string,
): GraduationHistoryRow[] {
  return db.prepare(`
    SELECT bundle_key, graduated_at, revoked_at FROM owner_correction_graduations
    WHERE julianday(graduated_at) <= julianday(?)
    ORDER BY bundle_key, graduated_at
  `).all(at) as GraduationHistoryRow[];
}

function buildProposal(
  db: Pick<Database.Database, "prepare">,
  input: CorrectionGraduationProposalOptions,
  writeProposal: CorrectionGraduationProposalWriter | undefined,
): CorrectionGraduationProposal {
  const at = canonicalTime(input.at);
  validateSourceHead(input.sourceHead);
  revokeGraduationsWithNewEvidence(db, at);
  const history = readGraduationHistory(db, at);
  const activeKeys = new Set(history.filter((row) => row.revoked_at === null).map((row) => row.bundle_key));
  const previouslyGraduatedKeys = new Set(history.map((row) => row.bundle_key));
  const entries: CorrectionGraduationEntry[] = [];
  const newGraduationKeys: string[] = [];
  for (const bundle of readGraduationBundles(db, at)) {
    if (bundle.confirmed_at === null) continue;
    if (bundle.bundle_key.startsWith(PRINCIPLE_PREFIX)
      && !hasCorrectionComplianceCheckerForPrinciple(db as Database.Database, bundle.bundle_key)) continue;
    const settled = readLatestSettledEvidence(db, bundle.bundle_key, at, bundle.confirmed_at);
    if (!settled) continue;
    const isActive = activeKeys.has(bundle.bundle_key);
    if (!isActive && previouslyGraduatedKeys.has(bundle.bundle_key)) continue;
    entries.push(deriveEntry(db, bundle, settled));
    if (!isActive) newGraduationKeys.push(bundle.bundle_key);
  }
  entries.sort((left, right) => compareText(left.principle_key, right.principle_key));
  const proposal: CorrectionGraduationProposal = {
    schema: 1,
    generated_at: at,
    source_head: input.sourceHead.toLowerCase(),
    principles: entries,
  };
  const proposalHash = createHash("sha256").update(JSON.stringify(proposal), "utf8").digest("hex");
  if (writeProposal !== undefined) writeProposal(proposal);
  for (const bundleKey of newGraduationKeys) {
    db.prepare(`
      INSERT INTO owner_correction_graduations (bundle_key, graduated_at, proposal_hash, revoked_at, revoke_reason)
      VALUES (?, ?, ?, NULL, NULL)
    `).run(bundleKey, at, proposalHash);
  }
  return proposal;
}

export function createCorrectionGraduationProposal(
  storage: Pick<SQLiteStorage, "runCorrectionTransaction">,
  input: CorrectionGraduationProposalOptions,
  writeProposal?: CorrectionGraduationProposalWriter,
): CorrectionGraduationProposal | null {
  if (!isCorrectionGraduationEnabled()) return null;
  const at = canonicalTime(input.at);
  return storage.runCorrectionTransaction(({ db }) => {
    if (getSchemaVersion(db as unknown as Database.Database) < CORRECTION_PRINCIPLES_SCHEMA_VERSION) return null;
    assertGraduationTables(db as unknown as Database.Database);
    return buildProposal(db as unknown as Database.Database, { ...input, at }, writeProposal);
  });
}

export function getActiveCorrectionGraduationKeys(
  storage: Pick<SQLiteStorage, "runCorrectionTransaction">,
  value: string,
  knowledgePath: string | undefined = process.env.WASURENAGUSA_JEV_KNOWLEDGE_PATH,
  mode: GraduationMode = resolveGraduationMode(process.env.WASURENAGUSA_GRADUATION),
): ReadonlySet<string> {
  if (mode !== "on") return new Set();
  const at = canonicalTime(value);
  return storage.runCorrectionTransaction(({ db }) => {
    if (getSchemaVersion(db as unknown as Database.Database) < CORRECTION_PRINCIPLES_SCHEMA_VERSION) return new Set<string>();
    assertGraduationTables(db as unknown as Database.Database);
    revokeGraduationsWithNewEvidence(db as unknown as Database.Database, at);
    let reflectedPrincipleKeys = new Set<string>();
    if (knowledgePath !== undefined && knowledgePath.trim() !== "") {
      const parsed: unknown = JSON.parse(readFileSync(knowledgePath, "utf8"));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("correction graduation Jev knowledge file must be an object");
      }
      const knowledge = parsed as Record<string, unknown>;
      if (knowledge.version !== 1 || !Array.isArray(knowledge.cards)) {
        throw new Error("correction graduation Jev knowledge file is invalid");
      }
      reflectedPrincipleKeys = new Set<string>();
      for (const card of knowledge.cards) {
        if (card === null || typeof card !== "object" || Array.isArray(card)) {
          throw new Error("correction graduation Jev knowledge card is invalid");
        }
        const evidenceIds = (card as Record<string, unknown>).evidence_ids;
        if (evidenceIds === undefined) continue;
        if (!Array.isArray(evidenceIds) || evidenceIds.some((evidenceId) => typeof evidenceId !== "string")) {
          throw new Error("correction graduation Jev knowledge evidence IDs are invalid");
        }
        for (const evidenceId of evidenceIds) reflectedPrincipleKeys.add(evidenceId);
      }
    }
    if (reflectedPrincipleKeys.size === 0) return new Set<string>();
    const rows = db.prepare(`
      SELECT graduation.bundle_key
      FROM owner_correction_graduations AS graduation
      JOIN owner_correction_bundles AS bundle ON bundle.bundle_key = graduation.bundle_key
      JOIN owner_correction_versions AS currentVersion
        ON currentVersion.bundle_key = bundle.bundle_key AND currentVersion.version = bundle.version
      WHERE graduation.revoked_at IS NULL AND julianday(graduation.graduated_at) <= julianday(?)
        AND bundle.status = 'confirmed' AND bundle.visibility = 'owner'
        AND bundle.lifetime_kind IN ('explicit_continuing','inferred')
        AND bundle.topic_key <> 'model_routing'
        AND currentVersion.status = 'confirmed' AND currentVersion.visibility = 'owner'
        AND currentVersion.lifetime_kind IN ('explicit_continuing','inferred')
        ${principleMemberEligibilitySql()}
      ORDER BY graduation.bundle_key
    `).all(at) as Array<{ bundle_key: string }>;
    return new Set(rows.filter((row) => reflectedPrincipleKeys.has(row.bundle_key)).map((row) => row.bundle_key));
  });
}
