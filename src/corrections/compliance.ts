import type Database from "better-sqlite3";
import { getSchemaVersion } from "../storage/schema.js";
import {
  CORRECTION_COMPLIANCE_SCHEMA_VERSION,
  CORRECTION_PRINCIPLES_SCHEMA_VERSION,
} from "../storage/correction-schema.js";
import { SQLiteStorage } from "../storage/sqlite.js";
import { removeQuotedAndInjectedContent } from "./events.js";
import { getCorrectionComplianceMode } from "./environment-mode.js";
import { correctionConditionKey, parseCorrectionRuleInput } from "./rule-template.js";

export type ComplianceChecker = "tone" | "document_delivery" | "expression_policy";
const PRINCIPLE_PREFIX = "pr:v1:";

export interface ComplianceRule {
  bundleKey: string;
  version: number;
  topicKey: string;
  ruleText: string;
  polarity: "positive" | "negative";
}

export interface ComplianceViolation {
  bundleKey: string;
  version: number;
  checker: ComplianceChecker;
}

export interface ComplianceAssessment extends ComplianceViolation {
  outcome: "violation" | "compliant" | "unproven";
}

export interface TranscriptRecordLike {
  byteOffset: number;
  byteEndOffset: number;
  entry: unknown;
}

interface RuleRow {
  bundle_key: string;
  injection_version: number;
  current_version: number;
  topic_key: string;
  rule_text: string;
  polarity: "positive" | "negative";
}

interface PrincipleSourceRuleRow {
  topic_key: string;
  rule_text: string;
  polarity: string;
  condition_key: string;
  conditions: string;
}

interface CorrectionVersionRow {
  version: number;
  rule_text: string;
  body_hash: string;
  conditions: string;
  condition_key: string;
  polarity: string;
  visibility: string;
  status: string;
  confirmed_at: string | null;
  lifetime_kind: string;
  continuation_basis: string;
  evidence_event_ids: string;
}

export interface EffectiveVersionRow extends CorrectionVersionRow {
  bundle_key: string;
  topic_key: string;
  expires_at: string | null;
  effective_from: string;
}

export interface PrincipleMemberVersionRow extends EffectiveVersionRow {
  principle_key: string;
  member_key: string;
  attached_at: string;
}

export interface EffectiveCheckerRuleSnapshot {
  schemaVersion: number;
  versions: EffectiveVersionRow[];
  principleMembers: PrincipleMemberVersionRow[];
}

interface VersionActivationState {
  status: string;
  confirmed_at: string | null;
  expires_at: string | null;
  effective_from: string;
}

function evidenceEventIds(row: CorrectionVersionRow): string[] {
  const value: unknown = JSON.parse(row.evidence_event_ids);
  if (!Array.isArray(value) || value.some((eventId) => typeof eventId !== "string")) {
    throw new Error("correction version evidence list is invalid");
  }
  return value;
}

function sameRuleMeaning(left: CorrectionVersionRow, right: CorrectionVersionRow): boolean {
  return left.rule_text === right.rule_text && left.body_hash === right.body_hash &&
    left.conditions === right.conditions && left.condition_key === right.condition_key &&
    left.polarity === right.polarity && left.visibility === right.visibility &&
    left.confirmed_at === right.confirmed_at && left.lifetime_kind === right.lifetime_kind &&
    left.continuation_basis === right.continuation_basis;
}

export function isEvidenceOnlyVersionContinuity(
  db: Database.Database,
  bundleKey: string,
  fromVersion: number,
  toVersion: number,
): boolean {
  if (toVersion < fromVersion) return false;
  const versions = db.prepare(`
    SELECT version, rule_text, body_hash, conditions, condition_key, polarity, visibility,
      status, confirmed_at, lifetime_kind, continuation_basis, evidence_event_ids
    FROM owner_correction_versions
    WHERE bundle_key = ? AND version >= ? AND version <= ?
    ORDER BY version
  `).all(bundleKey, fromVersion, toVersion) as CorrectionVersionRow[];
  if (versions.length !== toVersion - fromVersion + 1 || versions[0]?.version !== fromVersion) return false;
  if (versions.some((version) => version.status !== "confirmed")) return false;
  for (let index = 1; index < versions.length; index += 1) {
    const previous = versions[index - 1];
    const current = versions[index];
    if (!sameRuleMeaning(previous, current)) return false;
    const previousEvidence = evidenceEventIds(previous);
    const currentEvidence = evidenceEventIds(current);
    if (currentEvidence.length <= previousEvidence.length) return false;
    const currentEvidenceSet = new Set(currentEvidence);
    if (!previousEvidence.every((eventId) => currentEvidenceSet.has(eventId))) return false;
  }
  return true;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isHumanPrompt(entry: Record<string, unknown>): boolean {
  if (entry.isSidechain === true) return false;
  const origin = asRecord(entry.origin);
  const isHuman = origin?.kind === "human";
  if (entry.type === "user") {
    const message = asRecord(entry.message);
    return isHuman && entry.isMeta !== true && message?.isMeta !== true && entry.promptSource !== "system";
  }
  if (entry.type === "attachment") {
    const attachment = asRecord(entry.attachment);
    const attachmentOrigin = asRecord(attachment?.origin);
    return attachment?.type === "queued_command" &&
      attachment.commandMode === "prompt" &&
      (isHuman || attachmentOrigin?.kind === "human");
  }
  return false;
}

function isAssistant(entry: Record<string, unknown>): boolean {
  if (entry.isSidechain === true || entry.type !== "assistant") return false;
  const message = asRecord(entry.message);
  return message?.isMeta !== true && (message?.role === undefined || message.role === "assistant");
}

function assistantText(entry: Record<string, unknown>): string {
  const message = asRecord(entry.message);
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(asRecord)
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part?.text as string)
    .join("\n");
}

export function getLatestAssistantText(records: readonly TranscriptRecordLike[]): string {
  let latestHumanEndOffset = -1;
  for (const record of records) {
    const entry = asRecord(record.entry);
    if (entry && isHumanPrompt(entry)) latestHumanEndOffset = Math.max(latestHumanEndOffset, record.byteEndOffset);
  }
  const latestAssistant = records
    .filter((record) => record.byteOffset >= latestHumanEndOffset)
    .map((record) => asRecord(record.entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null && isAssistant(entry))
    .map(assistantText)
    .filter((text) => text.trim().length > 0)
    .at(-1);
  return latestAssistant ?? "";
}

export function isCorrectionComplianceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return getCorrectionComplianceMode(env) === "on";
}

type ComplianceRuleDescriptor = Pick<ComplianceRule, "topicKey" | "ruleText" | "polarity">;

function hasToneRule(rule: ComplianceRuleDescriptor): boolean {
  return rule.topicKey === "tone" && rule.polarity === "positive" && /常体/u.test(rule.ruleText);
}

function hasFullTextRule(rule: ComplianceRuleDescriptor): boolean {
  return rule.topicKey === "document_delivery" && rule.polarity === "positive" && /全文/u.test(rule.ruleText);
}

function hasAbbreviationRule(rule: ComplianceRuleDescriptor): boolean {
  return rule.topicKey === "expression_policy" && rule.polarity === "negative" && /略号/u.test(rule.ruleText);
}

function hasComplianceChecker(rule: ComplianceRuleDescriptor): boolean {
  return getComplianceChecker(rule) !== null;
}

export function getComplianceChecker(rule: ComplianceRuleDescriptor): ComplianceChecker | null {
  if (hasToneRule(rule)) return "tone";
  if (hasFullTextRule(rule)) return "document_delivery";
  if (hasAbbreviationRule(rule)) return "expression_policy";
  return null;
}

function hasSupportedPrincipleSourceCondition(row: PrincipleSourceRuleRow): boolean {
  const supportedConditionKeys = new Set(["general", "continuing"]);
  if (row.topic_key === "tone") supportedConditionKeys.add("audience:owner");
  const conditionKeys = row.condition_key.split(";").map((conditionKey) => conditionKey.trim());
  if (conditionKeys.length === 0 || conditionKeys.some((conditionKey) => !supportedConditionKeys.has(conditionKey))) {
    return false;
  }

  const parsedRule = parseCorrectionRuleInput(row.conditions);
  if (parsedRule !== null) {
    return parsedRule.topicKey === row.topic_key
      && parsedRule.polarity === row.polarity
      && correctionConditionKey(parsedRule) === row.condition_key
      && parsedRule.conditions.length === 0;
  }
  const legacyConditions: unknown = JSON.parse(row.conditions);
  return Array.isArray(legacyConditions) && legacyConditions.length === 0;
}

function readPrincipleSourceComplianceRules(
  db: Database.Database,
  principleKey: string,
): Array<Omit<ComplianceRule, "bundleKey" | "version">> {
  if (getSchemaVersion(db as Database.Database) < CORRECTION_PRINCIPLES_SCHEMA_VERSION) return [];
  const rows = db.prepare(`
    SELECT source.topic_key, sourceVersion.rule_text, sourceVersion.polarity,
      sourceVersion.condition_key, sourceVersion.conditions
    FROM owner_correction_principle_members AS member
    JOIN owner_correction_bundles AS source
      ON source.bundle_key = member.member_key
    JOIN owner_correction_versions AS sourceVersion
      ON sourceVersion.bundle_key = source.bundle_key AND sourceVersion.version = source.version
    WHERE member.principle_key = ?
      AND source.status IN ('candidate','confirmed')
      AND source.visibility = 'owner'
      AND source.lifetime_kind IN ('explicit_continuing','inferred')
      AND sourceVersion.status IN ('candidate','confirmed')
      AND sourceVersion.visibility = 'owner'
      AND sourceVersion.lifetime_kind IN ('explicit_continuing','inferred')
    ORDER BY source.bundle_key
  `).all(principleKey) as PrincipleSourceRuleRow[];
  return rows.flatMap((row) => {
    if (!hasSupportedPrincipleSourceCondition(row)) return [];
    if (row.polarity !== "positive" && row.polarity !== "negative") return [];
    const rule: Omit<ComplianceRule, "bundleKey" | "version"> = {
      topicKey: row.topic_key,
      ruleText: row.rule_text,
      polarity: row.polarity,
    };
    if (!hasComplianceChecker(rule)) return [];
    return [rule];
  });
}

export function hasCorrectionComplianceCheckerForPrinciple(
  db: Database.Database,
  principleKey: string,
): boolean {
  if (!principleKey.startsWith(PRINCIPLE_PREFIX)) return false;
  return readPrincipleSourceComplianceRules(db, principleKey).length > 0;
}

function politeEndingSentenceCount(text: string): number {
  const sentences = text.split(/(?<=[。！？!?])|\n+/u);
  return sentences.filter((sentence) =>
    /(?:です|ます|でした|ました|ません)[。！？!?]?$/u.test(sentence.trim()),
  ).length;
}

function isSubstantiveJapaneseSentence(sentence: string): boolean {
  const normalized = sentence.trim();
  return normalized.length >= 8
    && /[。！？!?]$/u.test(normalized)
    && /[ぁ-んァ-ヶ一-龯]/u.test(normalized);
}

function hasSubstantiveJapaneseSentence(text: string): boolean {
  const sentences = text.split(/(?<=[。！？!?])|\n+/u);
  return sentences.some(isSubstantiveJapaneseSentence);
}

function hasPlainSentenceEvidence(text: string): boolean {
  const sentences = text.split(/(?<=[。！？!?])|\n+/u);
  return sentences.some((sentence) => {
    const normalized = sentence.trim();
    if (!isSubstantiveJapaneseSentence(normalized)) return false;
    if (/(?:です|ます|でした|ました|ません)[。！？!?]?$/u.test(normalized)) return false;
    return true;
  });
}

function hasFullTextEvidence(text: string, outputTargetText: string | undefined): boolean {
  if (outputTargetText === undefined || outputTargetText.trim().length === 0) return false;
  const sourceCharacters = Array.from(outputTargetText.normalize("NFKC").replace(/\s/gu, ""));
  const normalizedOutput = text.normalize("NFKC").replace(/\s/gu, "");
  if (sourceCharacters.length === 0 || normalizedOutput.length === 0) return false;

  const chunkSize = 40;
  let matchedCharacters = 0;
  let outputSearchOffset = 0;
  for (let offset = 0; offset < sourceCharacters.length; offset += chunkSize) {
    const chunkCharacters = sourceCharacters.slice(offset, offset + chunkSize);
    const chunk = chunkCharacters.join("");
    const matchOffset = normalizedOutput.indexOf(chunk, outputSearchOffset);
    if (matchOffset >= 0) {
      matchedCharacters += chunkCharacters.length;
      outputSearchOffset = matchOffset + chunk.length;
    }
  }

  return matchedCharacters / sourceCharacters.length >= 0.8;
}

function getComplianceOutcome(
  text: string,
  checker: ComplianceChecker,
  outputTargetText?: string,
): ComplianceAssessment["outcome"] {
  if (checker === "tone") {
    if (politeEndingSentenceCount(text) >= 2) return "violation";
    if (hasPlainSentenceEvidence(text)) return "compliant";
    return "unproven";
  }
  if (checker === "document_delivery") {
    if (/（略）|（中略）|以下略|…省略/u.test(text)) return "violation";
    if (hasFullTextEvidence(text, outputTargetText)) return "compliant";
    if (outputTargetText?.trim()) return "violation";
    return "unproven";
  }
  if (checker === "expression_policy") {
    if (/[A-Z]\d+/u.test(text)) return "violation";
    if (hasSubstantiveJapaneseSentence(text)) return "compliant";
    return "unproven";
  }
  return "unproven";
}

export function assessCorrectionCompliance(
  assistantTextValue: string,
  rules: readonly ComplianceRule[],
  outputTargetText?: string,
): ComplianceAssessment[] {
  const assistantText = removeQuotedAndInjectedContent(assistantTextValue);
  const assessments: ComplianceAssessment[] = [];
  const seen = new Set<string>();

  for (const rule of rules) {
    const checker = getComplianceChecker(rule);
    if (checker === null) continue;
    const key = rule.bundleKey + ":" + rule.version + ":" + checker;
    if (seen.has(key)) continue;
    seen.add(key);
    assessments.push({
      bundleKey: rule.bundleKey,
      version: rule.version,
      checker,
      outcome: getComplianceOutcome(assistantText, checker, outputTargetText),
    });
  }

  return assessments;
}

export function findCorrectionComplianceViolations(
  assistantTextValue: string,
  rules: readonly ComplianceRule[],
  outputTargetText?: string,
): ComplianceViolation[] {
  return assessCorrectionCompliance(assistantTextValue, rules, outputTargetText)
    .filter((assessment) => assessment.outcome === "violation")
    .map(({ bundleKey, version, checker }) => ({ bundleKey, version, checker }));
}

function readInjectedConfirmedRules(
  db: Database.Database,
  sessionIdHash: string,
): ComplianceRule[] {
  const schemaVersion = getSchemaVersion(db);
  if (schemaVersion < CORRECTION_COMPLIANCE_SCHEMA_VERSION) return [];
  const rows = db.prepare(`
    SELECT DISTINCT injection.bundle_key, injection.version AS injection_version,
      bundle.version AS current_version, bundle.topic_key, version.rule_text, version.polarity
    FROM owner_correction_injections AS injection
    JOIN owner_correction_bundles AS bundle
      ON bundle.bundle_key = injection.bundle_key
    JOIN owner_correction_versions AS version
      ON version.bundle_key = injection.bundle_key AND version.version = injection.version
    JOIN owner_correction_versions AS current_version
      ON current_version.bundle_key = bundle.bundle_key AND current_version.version = bundle.version
    WHERE injection.session_id_hash = ?
      AND injection.body_included = 1
      AND injection.stdout_status = 'emitted'
      AND bundle.status = 'confirmed'
      AND version.status = 'confirmed'
      AND current_version.status = 'confirmed'
  `).all(sessionIdHash) as RuleRow[];
  const continuity = new Map<string, boolean>();
  const confirmedRows = rows.filter((row) => {
    const key = row.bundle_key + ":" + row.injection_version + ":" + row.current_version;
    if (!continuity.has(key)) {
      continuity.set(key, isEvidenceOnlyVersionContinuity(
        db,
        row.bundle_key,
        row.injection_version,
        row.current_version,
      ));
    }
    return continuity.get(key) === true;
  });
  return confirmedRows.flatMap((row) => {
    if (row.bundle_key.startsWith(PRINCIPLE_PREFIX)) {
      return readPrincipleSourceComplianceRules(db, row.bundle_key).map((sourceRule) => ({
        bundleKey: row.bundle_key,
        version: row.injection_version,
        ...sourceRule,
      }));
    }
    return [{
      bundleKey: row.bundle_key,
      version: row.injection_version,
      topicKey: row.topic_key,
      ruleText: row.rule_text,
      polarity: row.polarity,
    }];
  });
}

export function tableExists(db: Database.Database, tableName: string): boolean {
  return db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(tableName) !== undefined;
}

export function activeVersionAt<T extends VersionActivationState>(rows: readonly T[], at: string): T | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row.effective_from > at) continue;
    const next = rows[index + 1];
    if (next && next.effective_from <= at) return null;
    if (row.status === "confirmed" && row.confirmed_at !== null && row.confirmed_at <= at &&
      (row.expires_at === null || row.expires_at > at)) return row;
    return null;
  }
  return null;
}

function activePrincipleMemberVersionAt(
  rows: readonly PrincipleMemberVersionRow[],
  at: string,
): PrincipleMemberVersionRow | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row.effective_from > at) continue;
    const next = rows[index + 1];
    if (next && next.effective_from <= at) return null;
    if (row.status !== "candidate" && row.status !== "confirmed") return null;
    if (row.status === "confirmed" && (row.confirmed_at === null || row.confirmed_at > at)) return null;
    if (row.expires_at !== null && row.expires_at <= at) return null;
    return row;
  }
  return null;
}

export function readEffectiveCheckerRuleSnapshot(db: Database.Database): EffectiveCheckerRuleSnapshot {
  const schemaVersion = getSchemaVersion(db);
  if (!tableExists(db, "owner_correction_versions")) {
    return { schemaVersion, versions: [], principleMembers: [] };
  }
  const versions = db.prepare(`
    SELECT version.bundle_key, bundle.topic_key, version.version, version.rule_text,
      version.body_hash, version.conditions, version.condition_key, version.polarity,
      version.visibility, version.status, version.confirmed_at, version.expires_at,
      version.lifetime_kind, version.continuation_basis, version.evidence_event_ids,
      version.effective_from
    FROM owner_correction_versions AS version
    JOIN owner_correction_bundles AS bundle ON bundle.bundle_key = version.bundle_key
    ORDER BY version.bundle_key, version.version
  `).all() as EffectiveVersionRow[];
  const principleMembers = tableExists(db, "owner_correction_principle_members")
    ? db.prepare(`
      SELECT member.principle_key, member.member_key, member.attached_at,
        source.topic_key, sourceVersion.bundle_key, sourceVersion.version, sourceVersion.rule_text,
        sourceVersion.body_hash, sourceVersion.conditions, sourceVersion.condition_key,
        sourceVersion.polarity, sourceVersion.visibility, sourceVersion.status,
        sourceVersion.confirmed_at, sourceVersion.expires_at, sourceVersion.lifetime_kind,
        sourceVersion.continuation_basis, sourceVersion.evidence_event_ids, sourceVersion.effective_from
      FROM owner_correction_principle_members AS member
      JOIN owner_correction_bundles AS source ON source.bundle_key = member.member_key
      JOIN owner_correction_versions AS sourceVersion
        ON sourceVersion.bundle_key = source.bundle_key
      ORDER BY member.principle_key, member.member_key, sourceVersion.version
    `).all() as PrincipleMemberVersionRow[]
    : [];
  return { schemaVersion, versions, principleMembers };
}

export function createEffectiveCheckerRuleReader(
  snapshot: EffectiveCheckerRuleSnapshot,
): (at: string) => ComplianceRule[] {
  const versionsByBundle = new Map<string, EffectiveVersionRow[]>();
  for (const version of snapshot.versions) {
    const bundleVersions = versionsByBundle.get(version.bundle_key) ?? [];
    bundleVersions.push(version);
    versionsByBundle.set(version.bundle_key, bundleVersions);
  }
  const memberVersionsByPrinciple = new Map<string, Map<string, PrincipleMemberVersionRow[]>>();
  for (const member of snapshot.principleMembers) {
    const membersByKey = memberVersionsByPrinciple.get(member.principle_key) ?? new Map<string, PrincipleMemberVersionRow[]>();
    const rows = membersByKey.get(member.member_key) ?? [];
    rows.push(member);
    membersByKey.set(member.member_key, rows);
    memberVersionsByPrinciple.set(member.principle_key, membersByKey);
  }

  return (at: string) => {
    if (snapshot.schemaVersion < CORRECTION_COMPLIANCE_SCHEMA_VERSION) return [];
    const activeVersions = new Map<string, EffectiveVersionRow>();
    for (const [bundleKey, bundleVersions] of versionsByBundle) {
      const activeVersion = activeVersionAt(bundleVersions, at);
      if (activeVersion) activeVersions.set(bundleKey, activeVersion);
    }

    const rules: ComplianceRule[] = [];
    const membersFoldedIntoPrinciples = new Set<string>();
    for (const [principleKey, members] of memberVersionsByPrinciple) {
      const principleVersion = activeVersions.get(principleKey);
      if (!principleVersion || !principleKey.startsWith(PRINCIPLE_PREFIX)) continue;
      for (const [memberKey, memberRows] of members) {
        if (!memberRows.some((member) => member.attached_at <= at)) continue;
        const activeMember = activePrincipleMemberVersionAt(memberRows, at);
        membersFoldedIntoPrinciples.add(memberKey);
        if (!activeMember || activeMember.visibility !== "owner" ||
          !["explicit_continuing", "inferred"].includes(activeMember.lifetime_kind)) continue;
        const sourceRule: PrincipleSourceRuleRow = {
          topic_key: activeMember.topic_key,
          rule_text: activeMember.rule_text,
          polarity: activeMember.polarity,
          condition_key: activeMember.condition_key,
          conditions: activeMember.conditions,
        };
        if (!hasSupportedPrincipleSourceCondition(sourceRule) ||
          (activeMember.polarity !== "positive" && activeMember.polarity !== "negative")) continue;
        const rule: ComplianceRule = {
          bundleKey: principleKey,
          version: principleVersion.version,
          topicKey: activeMember.topic_key,
          ruleText: activeMember.rule_text,
          polarity: activeMember.polarity,
        };
        if (getComplianceChecker(rule) !== null) rules.push(rule);
      }
    }

    for (const [bundleKey, version] of activeVersions) {
      if (bundleKey.startsWith(PRINCIPLE_PREFIX) || membersFoldedIntoPrinciples.has(bundleKey)) continue;
      const rule: ComplianceRule = {
        bundleKey,
        version: version.version,
        topicKey: version.topic_key,
        ruleText: version.rule_text,
        polarity: version.polarity as ComplianceRule["polarity"],
      };
      if (getComplianceChecker(rule) !== null) rules.push(rule);
    }
    return rules;
  };
}

export function readEffectiveCheckerRules(db: Database.Database, at: string): ComplianceRule[] {
  return createEffectiveCheckerRuleReader(readEffectiveCheckerRuleSnapshot(db))(at);
}

export function persistCorrectionComplianceViolations(
  storage: SQLiteStorage,
  input: {
    sessionIdHash: string;
    humanOrdinal: number;
    assistantText: string;
    outputTargetText?: string;
    detectedAt: string;
    persistViolations?: boolean;
  },
): ComplianceViolation[] {
  if (!isCorrectionComplianceEnabled() || input.assistantText.trim().length === 0) return [];
  if (!Number.isSafeInteger(input.humanOrdinal) || input.humanOrdinal < 0) {
    throw new Error("compliance human ordinal is invalid");
  }

  return storage.runCorrectionTransaction(({ db }) => {
    const injectedRules = readInjectedConfirmedRules(db as unknown as Database.Database, input.sessionIdHash);
    const violationAssessments = assessCorrectionCompliance(input.assistantText, injectedRules, input.outputTargetText);
    const violations = violationAssessments
      .filter((assessment) => assessment.outcome === "violation")
      .map(({ bundleKey, version, checker }) => ({ bundleKey, version, checker }));
    const checksTableExists = db.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'owner_correction_compliance_checks'",
    ).get();
    if (checksTableExists) {
      const checkRules = readEffectiveCheckerRules(db as unknown as Database.Database, input.detectedAt);
      const assessments = assessCorrectionCompliance(input.assistantText, checkRules, input.outputTargetText);
      const assessmentByKey = new Map(assessments.map((assessment) => [
        assessment.bundleKey + ":" + assessment.version + ":" + assessment.checker,
        assessment,
      ]));
      const checkKeys = new Set<string>();
      const insertCheck = db.prepare(`
        INSERT OR IGNORE INTO owner_correction_compliance_checks (
          session_id_hash, human_ordinal, bundle_key, version, checker, is_compliant, checked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const rule of checkRules) {
        const checker = getComplianceChecker(rule);
        if (checker === null) continue;
        const checkKey = rule.bundleKey + ":" + rule.version + ":" + checker;
        if (checkKeys.has(checkKey)) continue;
        checkKeys.add(checkKey);
        const assessment = assessmentByKey.get(checkKey);
        if (!assessment || assessment.outcome === "unproven") continue;
        insertCheck.run(
          input.sessionIdHash,
          input.humanOrdinal,
          rule.bundleKey,
          rule.version,
          checker,
          Number(assessment.outcome === "compliant"),
          input.detectedAt,
        );
      }
    }
    if (input.persistViolations === false || violations.length === 0) return [];

    const insert = db.prepare(`
      INSERT OR IGNORE INTO owner_correction_violations (
        session_id_hash, human_ordinal, bundle_key, version, checker, detected_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const inserted: ComplianceViolation[] = [];
    for (const violation of violations) {
      const result = insert.run(
        input.sessionIdHash,
        input.humanOrdinal,
        violation.bundleKey,
        violation.version,
        violation.checker,
        input.detectedAt,
      );
      if (result.changes > 0) inserted.push(violation);
    }
    return inserted;
  });
}
