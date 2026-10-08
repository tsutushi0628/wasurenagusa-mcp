import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { CORRECTION_PRINCIPLES_SCHEMA_VERSION } from "../storage/correction-schema.js";
import { getSchemaVersion } from "../storage/schema.js";
import type { SQLiteStorage } from "../storage/sqlite.js";
import { hasCorrectionComplianceCheckerForPrinciple } from "./compliance.js";
import { parseCorrectionRuleInput } from "./rule-template.js";
import { getStrengthBaseIntensity } from "./strength.js";
import { readEnvironmentMode } from "./environment-mode.js";

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
const RULE_TEXT_GENERIC_WORDS = [
  "毎回", "出力", "確認", "仕組み", "応答", "回答", "使用", "作業", "必要", "場合",
  "規則", "原則", "ルール", "適用", "方法", "内容", "条件", "対象", "処理", "対応",
  "作成", "実行", "利用", "提供", "記載", "共通", "全員",
] as const;
const RULE_TEXT_GENERIC_WORD_PATTERN = new RegExp(RULE_TEXT_GENERIC_WORDS.join("|"), "gu");
const RULE_TEXT_WORD_PATTERN = /[A-Za-z0-9]+|[\p{Script=Katakana}ー]+|[\p{Script=Han}々〆ヶ]+/gu;
const NEGATIVE_EXCLUSION_MARKERS = ["ただし", "例外", "以外", "を除く"] as const;
const SECRET_VALUE = /(?:\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{20,}\b|\bsk-[A-Za-z0-9]{20,}\b|\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_-]{20,}\b|\bBearer\s+\S+|-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b)/iu;
const PATH_VALUE = /(?:^|[\s"'(])(?:\/|~\/|\.\.?\/|[A-Za-z]:[\\/])[^\s"')]+|\b[\p{L}\p{N}_.-]+[\\/][\p{L}\p{N}_.\\/-]+|\.[A-Za-z0-9_-]{1,12}(?:\s|$)/u;
const UNSAFE_PROPOSAL_TEXT = /[\u0000-\u001f\u007f]|https?:\/\/|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu;

export type GraduationMode = "off" | "shadow" | "on";
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

interface BundleEvidenceMetrics {
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

function extractRuleTextTriggers(ruleTexts: readonly string[]): string[] {
  const triggers: string[] = [];
  for (const ruleText of ruleTexts) {
    const searchableText = ruleText.normalize("NFKC").replace(RULE_TEXT_GENERIC_WORD_PATTERN, " ");
    const words = searchableText.match(RULE_TEXT_WORD_PATTERN) ?? [];
    for (const word of words) {
      const wordLength = Array.from(word).length;
      const isAsciiWord = /^[A-Za-z0-9]+$/u.test(word) && /[A-Za-z]/u.test(word);
      const isKatakanaWord = /^[\p{Script=Katakana}ー]+$/u.test(word) && /\p{Script=Katakana}/u.test(word);
      const isKanjiWord = /^[\p{Script=Han}々〆ヶ]+$/u.test(word) && /\p{Script=Han}/u.test(word);
      const minimumLength = isKanjiWord ? 2 : 3;
      if ((!isAsciiWord && !isKatakanaWord && !isKanjiWord) || wordLength < minimumLength) continue;
      if (!isSafeProposalText(word) || triggers.includes(word)) continue;
      triggers.push(word);
      if (triggers.length === 8) return triggers;
    }
  }
  return triggers;
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
    acceptedValues: ["off", "shadow", "on"],
    defaultValue: "off",
    invalidValue: "off",
    lowercase: true,
  });
}

export function isCorrectionGraduationEnabled(): boolean {
  return resolveGraduationMode(process.env.WASURENAGUSA_GRADUATION) !== "off";
}

function readEvidenceBundleKeys(db: Pick<Database.Database, "prepare">, bundleKey: string): string[] {
  const sourceKeys = bundleKey.startsWith(PRINCIPLE_PREFIX)
    ? (db.prepare(`
        SELECT member_key FROM owner_correction_principle_members
        WHERE principle_key = ? ORDER BY member_key
      `).all(bundleKey) as Array<{ member_key: string }>).map((row) => row.member_key)
    : [bundleKey];
  return uniqueSorted([...sourceKeys, bundleKey]);
}

function readEvidenceSources(db: Pick<Database.Database, "prepare">, bundleKey: string): GraduationSourceRow[] {
  const keys = readEvidenceBundleKeys(db, bundleKey);
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

function readBundleEvidenceMetrics(
  db: Pick<Database.Database, "prepare">,
  bundleKey: string,
  at: string,
): BundleEvidenceMetrics {
  const keys = readEvidenceBundleKeys(db, bundleKey);
  const placeholders = keys.map(() => "?").join(", ");
  const metrics = db.prepare(`
    SELECT COUNT(DISTINCT event.session_id_hash) AS sessions,
      COUNT(DISTINCT date(event.observed_at)) AS days
    FROM owner_correction_evidence AS evidence
    JOIN owner_correction_events AS event ON event.event_id = evidence.event_id
    WHERE evidence.bundle_key IN (${placeholders})
      AND julianday(event.observed_at) <= julianday(?)
  `).get(...keys, at) as BundleEvidenceMetrics;
  if (metrics.sessions < 1) throw new Error("correction graduation evidence requires at least one source session");
  return metrics;
}

function readGraduationBundles(
  db: Pick<Database.Database, "prepare">,
  at: string,
): GraduationBundleRow[] {
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
  `).all(at, at) as GraduationBundleRow[];
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
  evidenceMetrics: BundleEvidenceMetrics,
): CorrectionGraduationEntry {
  validateBundleForProposal(bundle);
  const sources = readEvidenceSources(db, bundle.bundle_key);
  const orderedSources = [
    ...sources.filter((source) => source.bundle_key === bundle.bundle_key),
    ...sources.filter((source) => source.bundle_key !== bundle.bundle_key),
  ];
  const ruleTextTriggers = extractRuleTextTriggers(orderedSources.map((source) => source.rule_text));
  const fallbackTriggers: string[] = [];
  const conditionTriggers: string[] = [];
  if (ruleTextTriggers.length === 0) fallbackTriggers.push(...TOPIC_TRIGGERS[bundle.topic_key]);
  const excludePatterns: string[] = [];
  for (const source of orderedSources) {
    if (bundle.topic_key === "principle" && source.bundle_key !== bundle.bundle_key) {
      const sourceTopicTriggers = TOPIC_TRIGGERS[source.topic_key];
      if (sourceTopicTriggers === undefined) throw new Error("correction graduation source topic is unsupported");
      if (ruleTextTriggers.length === 0) fallbackTriggers.push(...sourceTopicTriggers);
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
      if (isSafeProposalText(normalized) && Array.from(normalized).length <= 40) conditionTriggers.push(normalized);
    }
  }
  const proposalTriggers = (ruleTextTriggers.length > 0
    ? ruleTextTriggers.filter(isSafeProposalText)
    : uniqueSorted([...fallbackTriggers, ...conditionTriggers].filter(isSafeProposalText))
  ).slice(0, 8);
  const sortedExclusions = uniqueSorted(excludePatterns.filter(isSafeProposalText));
  return {
    principle_key: bundle.bundle_key,
    rule_text: bundle.rule_text,
    topic_key: bundle.topic_key,
    delivery: proposalTriggers.length > 0 ? "scene" : "always",
    triggers: proposalTriggers,
    exclude_patterns: sortedExclusions,
    types: [...JEV_AGENT_TYPES],
    evidence: {
      sessions: evidenceMetrics.sessions,
      days: evidenceMetrics.days,
      injected_sessions: evidenceMetrics.sessions,
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
  mode: GraduationMode,
): CorrectionGraduationProposal {
  const at = canonicalTime(input.at);
  validateSourceHead(input.sourceHead);
  if (mode === "on") revokeGraduationsWithNewEvidence(db, at);
  const history = readGraduationHistory(db, at);
  const activeKeys = new Set(history.filter((row) => row.revoked_at === null).map((row) => row.bundle_key));
  const previouslyGraduatedKeys = new Set(history.map((row) => row.bundle_key));
  const entries: CorrectionGraduationEntry[] = [];
  for (const bundle of readGraduationBundles(db, at)) {
    if (bundle.confirmed_at === null) continue;
    if (bundle.bundle_key.startsWith(PRINCIPLE_PREFIX)
      && !hasCorrectionComplianceCheckerForPrinciple(db as Database.Database, bundle.bundle_key)) continue;
    const isActive = activeKeys.has(bundle.bundle_key);
    if (!isActive && previouslyGraduatedKeys.has(bundle.bundle_key)) continue;
    entries.push(deriveEntry(db, bundle, readBundleEvidenceMetrics(db, bundle.bundle_key, at)));
  }
  entries.sort((left, right) => compareText(left.principle_key, right.principle_key));
  const proposal: CorrectionGraduationProposal = {
    schema: 1,
    generated_at: at,
    source_head: input.sourceHead.toLowerCase(),
    principles: entries,
  };
  if (writeProposal !== undefined) writeProposal(proposal);
  return proposal;
}

export function createCorrectionGraduationProposal(
  storage: Pick<SQLiteStorage, "runCorrectionTransaction">,
  input: CorrectionGraduationProposalOptions,
  writeProposal?: CorrectionGraduationProposalWriter,
): CorrectionGraduationProposal | null {
  const mode = resolveGraduationMode(process.env.WASURENAGUSA_GRADUATION);
  if (mode === "off") return null;
  const at = canonicalTime(input.at);
  return storage.runCorrectionTransaction(({ db }) => {
    if (getSchemaVersion(db as unknown as Database.Database) < CORRECTION_PRINCIPLES_SCHEMA_VERSION) return null;
    assertGraduationTables(db as unknown as Database.Database);
    return buildProposal(db as unknown as Database.Database, { ...input, at }, writeProposal, mode);
  });
}

function defaultJevKnowledgePath(): string {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  return resolve(packageRoot, "..", "firebase-kit", ".claude", "hooks", "jev-knowledge.graduated.json");
}

function resolveJevKnowledgePath(knowledgePath: string | undefined): string | undefined {
  if (knowledgePath !== undefined && knowledgePath.trim() !== "") return knowledgePath;
  const path = defaultJevKnowledgePath();
  if (!existsSync(path)) return undefined;
  return path;
}

export function readCorrectionGraduationKnowledgeKeys(knowledgePath: string): ReadonlySet<string> {
  const parsed: unknown = JSON.parse(readFileSync(knowledgePath, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("correction graduation Jev knowledge file must be an object");
  }
  const knowledge = parsed as Record<string, unknown>;
  if (knowledge.version !== 1 || !Array.isArray(knowledge.cards)) {
    throw new Error("correction graduation Jev knowledge file is invalid");
  }
  const principleKeys = new Set<string>();
  for (const card of knowledge.cards) {
    if (card === null || typeof card !== "object" || Array.isArray(card)) {
      throw new Error("correction graduation Jev knowledge card is invalid");
    }
    const evidenceIds = (card as Record<string, unknown>).evidence_ids;
    if (evidenceIds === undefined) continue;
    if (!Array.isArray(evidenceIds) || evidenceIds.some((evidenceId) => typeof evidenceId !== "string")) {
      throw new Error("correction graduation Jev knowledge evidence IDs are invalid");
    }
    for (const evidenceId of evidenceIds) principleKeys.add(evidenceId);
  }
  return principleKeys;
}

export function recordSuccessfulCorrectionGraduationImport(
  storage: Pick<SQLiteStorage, "runCorrectionTransaction">,
  proposal: CorrectionGraduationProposal,
  knowledgePath: string,
  value: string = new Date().toISOString(),
): void {
  if (resolveGraduationMode(process.env.WASURENAGUSA_GRADUATION) !== "on") return;
  const at = canonicalTime(value);
  const knowledgeKeys = readCorrectionGraduationKnowledgeKeys(knowledgePath);
  const proposalKeys = new Set(proposal.principles
    .filter((entry) => entry.delivery === "scene" && knowledgeKeys.has(entry.principle_key))
    .map((entry) => entry.principle_key));
  const proposalHash = createHash("sha256").update(JSON.stringify(proposal), "utf8").digest("hex");
  storage.runCorrectionTransaction(({ db }) => {
    if (getSchemaVersion(db as unknown as Database.Database) < CORRECTION_PRINCIPLES_SCHEMA_VERSION) return;
    assertGraduationTables(db as unknown as Database.Database);
    revokeGraduationsWithNewEvidence(db as unknown as Database.Database, at);
    const eligibleKeys = new Set(readGraduationBundles(db as unknown as Database.Database, at)
      .filter((bundle) => !bundle.bundle_key.startsWith(PRINCIPLE_PREFIX)
        || hasCorrectionComplianceCheckerForPrinciple(db as Database.Database, bundle.bundle_key))
      .map((bundle) => bundle.bundle_key));
    const reflectedKeys = new Set([...proposalKeys].filter((bundleKey) => eligibleKeys.has(bundleKey)));
    const activeRows = db.prepare(`
      SELECT bundle_key, graduated_at FROM owner_correction_graduations
      WHERE revoked_at IS NULL AND julianday(graduated_at) <= julianday(?)
      ORDER BY bundle_key, graduated_at
    `).all(at) as RevokedGraduationRow[];
    for (const row of activeRows) {
      if (reflectedKeys.has(row.bundle_key)) continue;
      db.prepare(`
        UPDATE owner_correction_graduations
        SET revoked_at = ?, revoke_reason = 'jev_import_replaced'
        WHERE bundle_key = ? AND graduated_at = ? AND revoked_at IS NULL
      `).run(at, row.bundle_key, row.graduated_at);
    }
    const history = readGraduationHistory(db as unknown as Database.Database, at);
    const activeKeys = new Set(history.filter((row) => row.revoked_at === null).map((row) => row.bundle_key));
    const previouslyGraduatedKeys = new Set(history.map((row) => row.bundle_key));
    for (const bundleKey of reflectedKeys) {
      if (activeKeys.has(bundleKey) || previouslyGraduatedKeys.has(bundleKey)) continue;
      db.prepare(`
        INSERT INTO owner_correction_graduations (bundle_key, graduated_at, proposal_hash, revoked_at, revoke_reason)
        VALUES (?, ?, ?, NULL, NULL)
      `).run(bundleKey, at, proposalHash);
    }
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
    const resolvedKnowledgePath = resolveJevKnowledgePath(knowledgePath);
    let reflectedPrincipleKeys = new Set<string>();
    if (resolvedKnowledgePath !== undefined) {
      try {
        reflectedPrincipleKeys = new Set(readCorrectionGraduationKnowledgeKeys(resolvedKnowledgePath));
      } catch (error) {
        // Jev 側が読めないときは移したことにせず、こちらの差し込みを続ける
        process.stderr.write(`[graduation] Jev knowledge unreadable: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    if (reflectedPrincipleKeys.size === 0) return new Set<string>();
    const rows = db.prepare(`
      SELECT graduation.bundle_key
      FROM owner_correction_graduations AS graduation
      JOIN owner_correction_bundles AS bundle ON bundle.bundle_key = graduation.bundle_key
      JOIN memories AS memory ON memory.id = bundle.memory_id
      JOIN owner_correction_versions AS currentVersion
        ON currentVersion.bundle_key = bundle.bundle_key AND currentVersion.version = bundle.version
      WHERE graduation.revoked_at IS NULL AND julianday(graduation.graduated_at) <= julianday(?)
        AND bundle.status = 'confirmed' AND memory.state = 'active' AND memory.category = 'dont'
        AND bundle.visibility = 'owner'
        AND bundle.lifetime_kind IN ('explicit_continuing','inferred')
        AND bundle.topic_key <> 'model_routing'
        AND (bundle.expires_at IS NULL OR julianday(bundle.expires_at) > julianday(?))
        AND currentVersion.status = 'confirmed' AND currentVersion.visibility = 'owner'
        AND currentVersion.lifetime_kind IN ('explicit_continuing','inferred')
        AND (currentVersion.expires_at IS NULL OR julianday(currentVersion.expires_at) > julianday(?))
        ${principleMemberEligibilitySql()}
      ORDER BY graduation.bundle_key
    `).all(at, at, at) as Array<{ bundle_key: string }>;
    return new Set(rows.filter((row) => reflectedPrincipleKeys.has(row.bundle_key)).map((row) => row.bundle_key));
  });
}
