import type Database from "better-sqlite3";
import { getSchemaVersion } from "../storage/schema.js";
import {
  CORRECTION_COMPLIANCE_SCHEMA_VERSION,
} from "../storage/correction-schema.js";
import { SQLiteStorage } from "../storage/sqlite.js";
import { removeQuotedAndInjectedContent } from "./events.js";

export type ComplianceChecker = "tone" | "document_delivery" | "expression_policy";

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

export interface TranscriptRecordLike {
  byteOffset: number;
  byteEndOffset: number;
  entry: unknown;
}

interface RuleRow {
  bundle_key: string;
  version: number;
  topic_key: string;
  rule_text: string;
  polarity: "positive" | "negative";
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
  return env.WASURENAGUSA_CORRECTION_COMPLIANCE?.trim().toLowerCase() !== "off";
}

function hasToneRule(rule: ComplianceRule): boolean {
  return rule.topicKey === "tone" && rule.polarity === "positive" && /常体/u.test(rule.ruleText);
}

function hasFullTextRule(rule: ComplianceRule): boolean {
  return rule.topicKey === "document_delivery" && rule.polarity === "positive" && /全文/u.test(rule.ruleText);
}

function hasAbbreviationRule(rule: ComplianceRule): boolean {
  return rule.topicKey === "expression_policy" && rule.polarity === "negative" && /略号/u.test(rule.ruleText);
}

function politeEndingSentenceCount(text: string): number {
  const sentences = text.split(/(?<=[。！？!?])|\n+/u);
  return sentences.filter((sentence) =>
    /(?:です|ます|でした|ました|ません)[。！？!?]?$/u.test(sentence.trim()),
  ).length;
}

export function findCorrectionComplianceViolations(
  assistantTextValue: string,
  rules: readonly ComplianceRule[],
): ComplianceViolation[] {
  const assistantText = removeQuotedAndInjectedContent(assistantTextValue);
  const violations: ComplianceViolation[] = [];
  const seen = new Set<string>();
  const addViolation = (rule: ComplianceRule, checker: ComplianceChecker): void => {
    const key = rule.bundleKey + ":" + rule.version + ":" + checker;
    if (seen.has(key)) return;
    seen.add(key);
    violations.push({ bundleKey: rule.bundleKey, version: rule.version, checker });
  };

  for (const rule of rules) {
    if (hasToneRule(rule) && politeEndingSentenceCount(assistantText) >= 2) {
      addViolation(rule, "tone");
    }
    if (hasFullTextRule(rule) && /（略）|（中略）|以下略|…省略/u.test(assistantText)) {
      addViolation(rule, "document_delivery");
    }
    if (hasAbbreviationRule(rule) && /[A-Z]\d+/u.test(assistantText)) {
      addViolation(rule, "expression_policy");
    }
  }

  return violations;
}

function readInjectedConfirmedRules(
  db: Database.Database,
  sessionIdHash: string,
): ComplianceRule[] {
  const schemaVersion = getSchemaVersion(db);
  if (schemaVersion < CORRECTION_COMPLIANCE_SCHEMA_VERSION) return [];
  const rows = db.prepare(`
    SELECT DISTINCT injection.bundle_key, injection.version, bundle.topic_key, version.rule_text, version.polarity
    FROM owner_correction_injections AS injection
    JOIN owner_correction_bundles AS bundle
      ON bundle.bundle_key = injection.bundle_key
    JOIN owner_correction_versions AS version
      ON version.bundle_key = injection.bundle_key AND version.version = injection.version
    WHERE injection.session_id_hash = ?
      AND injection.body_included = 1
      AND injection.stdout_status = 'emitted'
      AND bundle.status = 'confirmed'
      AND bundle.version = injection.version
      AND version.status = 'confirmed'
  `).all(sessionIdHash) as RuleRow[];
  return rows.map((row) => ({
    bundleKey: row.bundle_key,
    version: row.version,
    topicKey: row.topic_key,
    ruleText: row.rule_text,
    polarity: row.polarity,
  }));
}

export function persistCorrectionComplianceViolations(
  storage: SQLiteStorage,
  input: {
    sessionIdHash: string;
    humanOrdinal: number;
    assistantText: string;
    detectedAt: string;
  },
): ComplianceViolation[] {
  if (!isCorrectionComplianceEnabled() || input.assistantText.trim().length === 0) return [];
  if (!Number.isSafeInteger(input.humanOrdinal) || input.humanOrdinal < 0) {
    throw new Error("compliance human ordinal is invalid");
  }

  return storage.runCorrectionTransaction(({ db }) => {
    const rules = readInjectedConfirmedRules(db as unknown as Database.Database, input.sessionIdHash);
    const violations = findCorrectionComplianceViolations(input.assistantText, rules);
    if (violations.length === 0) return [];

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
