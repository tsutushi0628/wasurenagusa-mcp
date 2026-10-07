import { createHash } from "crypto";
import { realpathSync } from "fs";
import { dirname } from "path";
import Database from "better-sqlite3";
import type { MemoryCategory, ProjectConfidence } from "../types.js";
import { backupBeforeMigration, migrateV10ToV11, migrateV11ToV12 } from "../storage/migration.js";
import {
  CORRECTION_COMPLIANCE_SCHEMA_VERSION,
  CORRECTION_PRINCIPLES_SCHEMA_VERSION,
  CORRECTION_PRINCIPLES_TABLE_NAMES,
  CORRECTION_SCHEMA_VERSION,
  CORRECTION_TABLE_NAMES,
} from "../storage/correction-schema.js";
import { SQLiteStorage } from "../storage/sqlite.js";
import { computeContentHash } from "../storage/content-hash.js";
import { CURRENT_SCHEMA_VERSION, getSchemaVersion } from "../storage/schema.js";
import { detectOwnerCorrections, type CorrectionCandidate } from "./detector.js";
import { extractOwnerEvent } from "./events.js";
import {
  correctionConditionKey,
  correctionRequiredValuesKey,
  parseCorrectionRuleInput,
  renderPlainCorrectionRule,
  serializeCorrectionRuleInput,
} from "./rule-template.js";

const CORRECTION_TABLES = [
  "owner_correction_events",
  "owner_correction_evidence",
  "owner_correction_pending",
  "owner_correction_bundles",
  "owner_correction_versions",
  "owner_correction_sessions",
  "owner_correction_injections",
  "owner_correction_imports",
];

const CORRECTION_COMPLIANCE_TABLES = [
  ...CORRECTION_TABLES,
  "owner_correction_violations",
];

const MEMORY_COLUMNS = [
  "id",
  "timestamp",
  "category",
  "title",
  "content",
  "tags",
  "project",
  "scope",
  "intensity",
  "knowledge_gap",
  "positive_action",
  "scenario",
  "why_core",
  "predicted_factors",
  "actual_factors",
  "prediction_error",
  "prediction_delta",
  "deleted_at",
  "state",
  "project_confidence",
  "content_hash",
  "last_read_at",
  "created_at",
  "updated_at",
] as const;

type ImportedMemory = {
  id: string;
  timestamp: string;
  category: MemoryCategory;
  title: string;
  content: string;
  tags: string;
  project: string | null;
  scope: string | null;
  intensity: number | null;
  knowledge_gap: string | null;
  positive_action: string | null;
  scenario: string | null;
  why_core: string | null;
  predicted_factors: string | null;
  actual_factors: string | null;
  prediction_error: number | null;
  prediction_delta: string | null;
  deleted_at: string | null;
  state: "active" | "archived" | "deleted";
  project_confidence: ProjectConfidence;
  content_hash: string | null;
  last_read_at: string | null;
  created_at: string;
  updated_at: string;
};

export type CorrectionImportSummary = {
  sourceCount: number;
  skippedCount: number;
  addedCount: number;
  duplicateCount: number;
  alreadyImportedCount: number;
  idCollisionCount: number;
  generatedCandidates: 0;
  expiryChanges: 0;
  migrationRequired: boolean;
};

export type CorrectionImportOptions = {
  sourcePath: string;
  targetPath: string;
  apply?: boolean;
  importedAt?: string;
};

export type CorrectionMigrationSummary = {
  schemaVersion: number;
  ddlCount: number;
};

export type RuleTextBackfillExample = {
  sourceCommand: string;
  beforeRuleText: string;
  afterRuleText: string;
  beforePolarity: string;
  afterPolarity: string;
};

export type RuleTextBackfillSummary = {
  schemaVersion: number;
  candidateCount: number;
  fillCount: number;
  unfilledCount: number;
  polarityChangedCount: number;
  reasons: Record<string, number>;
  examples: RuleTextBackfillExample[];
  backupCreated: boolean;
};

export class CorrectionImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorrectionImportError";
  }
}

type BackfillBundleRow = {
  bundle_key: string;
  version: number;
  topic_key: string;
  polarity: string;
  condition_key: string;
  last_seen_at: string;
  rule_text: string;
  version_rule_text: string | null;
  conditions: string | null;
  version_condition_key: string | null;
  version_polarity: string | null;
  version_status: string | null;
};

type BackfillEvidenceRow = {
  event_id: string;
  conditions: string;
  detector_version: string;
  session_id_hash: string;
  observed_at: string;
};

type RuleTextBackfillPlan = {
  bundleKey: string;
  version: number;
  conditionKey: string;
  sourceCommand: string;
  ruleText: string;
  writeRequired: boolean;
  beforeRuleText: string;
  beforePolarity: string;
  candidate: CorrectionCandidate;
  evidence: Array<{
    eventId: string;
    sourceCommand: string;
    detectorVersion: string;
    sessionIdHash: string;
    observedAt: string;
    candidate: CorrectionCandidate;
  }>;
};

function resolveExistingPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    throw new CorrectionImportError("source or target database is unavailable");
  }
}

function openDatabase(path: string, readonly: boolean): Database.Database {
  try {
    return new Database(path, { fileMustExist: true, readonly });
  } catch {
    throw new CorrectionImportError("source or target database is unavailable");
  }
}

function tableCount(db: Database.Database, names: string[]): number {
  const placeholders = names.map(() => "?").join(", ");
  const row = db.prepare(
    `SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`,
  ).get(...names) as { count: number };
  return row.count;
}

function validateMemoryTable(db: Database.Database): void {
  const columns = new Set((db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>).map((row) => row.name));
  if (columns.size === 0 || MEMORY_COLUMNS.some((column) => !columns.has(column))) {
    throw new CorrectionImportError("database memories schema is unsupported");
  }
}

function validateMemoryDatabase(db: Database.Database, allowV11: boolean): number {
  const version = getSchemaVersion(db);
  if (version !== CURRENT_SCHEMA_VERSION && (!allowV11 || version !== CORRECTION_SCHEMA_VERSION)) {
    throw new CorrectionImportError("database schema version is unsupported");
  }
  validateMemoryTable(db);
  return version;
}

function validateCorrectionSchema(db: Database.Database, version: number): void {
  const count = tableCount(db, CORRECTION_TABLES);
  if (version === CORRECTION_SCHEMA_VERSION && count !== CORRECTION_TABLES.length) {
    throw new CorrectionImportError("schema version 11 is missing owner correction tables");
  }
  if (version === CURRENT_SCHEMA_VERSION && count !== 0) {
    throw new CorrectionImportError("version 10 database has partial owner correction tables");
  }
}

function readImportMemories(db: Database.Database): ImportedMemory[] {
  const columns = MEMORY_COLUMNS.join(", ");
  return db.prepare(`SELECT ${columns} FROM memories ORDER BY id`).all() as ImportedMemory[];
}

function memoryContentHash(memory: ImportedMemory): string {
  return memory.content_hash ?? computeContentHash({
    project: memory.project ?? undefined,
    scope: memory.scope ?? undefined,
    category: memory.category,
    title: memory.title,
    content: memory.content,
  });
}

function sourceRowHash(memory: ImportedMemory): string {
  const values = MEMORY_COLUMNS.map((column) => memory[column]);
  return createHash("sha256").update(JSON.stringify(values), "utf8").digest("hex");
}

function sourceStoreHash(sourceRealPath: string): string {
  return createHash("sha256").update(sourceRealPath, "utf8").digest("hex");
}

function validateRuleTextBackfillSchema(db: Database.Database): number {
  validateMemoryTable(db);
  const version = getSchemaVersion(db);
  if (version < CORRECTION_SCHEMA_VERSION || version > CORRECTION_PRINCIPLES_SCHEMA_VERSION) {
    throw new CorrectionImportError("rule text backfill requires correction schema version 11 through 13");
  }
  const requiredTables = [...CORRECTION_TABLES];
  if (version >= CORRECTION_COMPLIANCE_SCHEMA_VERSION) requiredTables.push("owner_correction_violations");
  if (version >= CORRECTION_PRINCIPLES_SCHEMA_VERSION) requiredTables.push(...CORRECTION_PRINCIPLES_TABLE_NAMES);
  if (tableCount(db, requiredTables) !== requiredTables.length) {
    throw new CorrectionImportError("correction database schema is incomplete");
  }
  return version;
}

function findCurrentCandidate(
  commandText: string,
  original: NonNullable<ReturnType<typeof parseCorrectionRuleInput>>,
  expectedConditionKey: string,
): CorrectionCandidate | undefined {
  const event = extractOwnerEvent({
    type: "user",
    origin: { kind: "human" },
    sessionId: "rule-text-backfill",
    message: { content: commandText },
  });
  if (!event) return undefined;
  return detectOwnerCorrections(event).find((candidate) => (
    candidate.topicKey === original.topicKey
    && candidate.actionKey === original.actionKey
    && correctionConditionKey(candidate.ruleInput) === expectedConditionKey
    && candidate.lifetimeKind === original.lifetimeKind
    && candidate.ruleInput.continuationBasis === original.continuationBasis
    && correctionRequiredValuesKey(candidate.ruleInput) === correctionRequiredValuesKey(original)
  ));
}

function parsedCommandInput(conditions: string): NonNullable<ReturnType<typeof parseCorrectionRuleInput>> | null {
  return parseCorrectionRuleInput(conditions);
}

function incrementReason(reasons: Record<string, number>, reason: string): void {
  reasons[reason] = (reasons[reason] ?? 0) + 1;
}

function detectorMajorVersion(version: string): number {
  const match = version.match(/(?:^|[-.])v(\d+)(?:$|[-.])/iu);
  if (!match) return 0;
  const majorVersion = Number(match[1]);
  return Number.isSafeInteger(majorVersion) ? majorVersion : 0;
}

function selectPlainRuleText(
  evidence: RuleTextBackfillPlan["evidence"],
  currentEventAt: string,
): { ruleText?: string; sourceCommand?: string; reason?: string } {
  const renderablePlainEvidence = evidence.filter((item) => (
    !item.candidate.ruleText
    && item.candidate.ruleInput.plainCommandEligible
    && renderPlainCorrectionRule(item.candidate.ruleInput).length > 0
  ));
  if (renderablePlainEvidence.length === 0) return { reason: "generated_rule_empty" };
  const supportedEvidence = renderablePlainEvidence.filter((item) => detectorMajorVersion(item.detectorVersion) >= 3);
  if (supportedEvidence.length === 0) return { reason: "plain_command_requires_detector_v3" };
  const currentTime = Date.parse(currentEventAt);
  if (!Number.isFinite(currentTime)) return { reason: "invalid_last_seen_at" };
  const cutoff = currentTime - 30 * 24 * 60 * 60 * 1000;
  const windowEvidence = supportedEvidence.filter((item) => {
    const eventTime = Date.parse(item.observedAt);
    return Number.isFinite(eventTime) && eventTime >= cutoff && eventTime <= currentTime;
  });
  if (windowEvidence.length === 0) {
    const hasValidEventTime = supportedEvidence.some((item) => Number.isFinite(Date.parse(item.observedAt)));
    return { reason: hasValidEventTime ? "plain_command_outside_evidence_window" : "invalid_evidence_time" };
  }
  const uniqueRows = new Map<string, {
    eventId: string;
    commandText: string;
    ruleText: string;
    sessionIdHash: string;
    observedAt: string;
  }>();
  for (const item of windowEvidence) {
    const commandText = item.sourceCommand;
    const ruleText = renderPlainCorrectionRule(item.candidate.ruleInput);
    const eventTime = Date.parse(item.observedAt);
    if (!ruleText || !Number.isFinite(eventTime) || eventTime < cutoff || eventTime > currentTime) continue;
    const minute = Math.floor(eventTime / 60000);
    const key = JSON.stringify([minute, commandText]);
    if (!uniqueRows.has(key)) {
      uniqueRows.set(key, {
        eventId: item.eventId,
        commandText,
        ruleText,
        sessionIdHash: item.sessionIdHash,
        observedAt: item.observedAt,
      });
    }
  }
  const rows = Array.from(uniqueRows.values()).sort((left, right) => (
    Date.parse(left.observedAt) - Date.parse(right.observedAt) || left.eventId.localeCompare(right.eventId)
  ));
  const variants = new Map<string, { ruleText: string; commandText: string; sessions: Set<string> }>();
  for (const row of rows) {
    const variant = variants.get(row.commandText) ?? {
      ruleText: row.ruleText,
      commandText: row.commandText,
      sessions: new Set<string>(),
    };
    variant.sessions.add(row.sessionIdHash);
    variants.set(row.commandText, variant);
  }
  const allVariants = Array.from(variants.values());
  const repeatedVariants = allVariants.filter((variant) => variant.sessions.size >= 2);
  const candidates = repeatedVariants.length > 0 ? repeatedVariants : allVariants;
  candidates.sort((left, right) => (
    Array.from(left.ruleText).length - Array.from(right.ruleText).length
    || left.ruleText.localeCompare(right.ruleText)
  ));
  const selected = candidates[0];
  if (!selected) {
    const hasValidEventTime = supportedEvidence.some((item) => Number.isFinite(Date.parse(item.observedAt)));
    return { reason: hasValidEventTime ? "generated_rule_empty" : "invalid_evidence_time" };
  }
  return { ruleText: selected.ruleText, sourceCommand: selected.commandText };
}

function prepareRuleTextBackfill(db: Database.Database): {
  plans: RuleTextBackfillPlan[];
  candidateCount: number;
  reasons: Record<string, number>;
} {
  const rows = db.prepare(`
    SELECT b.bundle_key, b.version, b.topic_key, b.polarity, b.condition_key, b.last_seen_at, b.rule_text,
      v.rule_text AS version_rule_text, v.conditions, v.condition_key AS version_condition_key,
      v.polarity AS version_polarity, v.status AS version_status
    FROM owner_correction_bundles b
    LEFT JOIN owner_correction_versions v
      ON v.bundle_key = b.bundle_key AND v.version = b.version
    WHERE b.status = 'candidate' AND b.rule_text = ''
    ORDER BY b.bundle_key
  `).all() as BackfillBundleRow[];
  const reasons: Record<string, number> = {};
  const plans: RuleTextBackfillPlan[] = [];

  for (const row of rows) {
    if (row.conditions === null || row.version_rule_text === null || row.version_condition_key === null
      || row.version_polarity === null || row.version_status === null) {
      incrementReason(reasons, "missing_current_version");
      continue;
    }
    if (row.version_status !== "candidate") {
      incrementReason(reasons, "version_not_candidate");
      continue;
    }
    if (row.version_rule_text.length > 0) {
      incrementReason(reasons, "version_rule_text_not_empty");
      continue;
    }
    const original = parsedCommandInput(row.conditions);
    if (!original) {
      incrementReason(reasons, "invalid_conditions");
      continue;
    }
    const commandText = original.commandText?.trim();
    if (!commandText) {
      incrementReason(reasons, "missing_command_text");
      continue;
    }
    if (row.version_condition_key !== row.condition_key
      || correctionConditionKey(original) !== row.condition_key
      || original.topicKey !== row.topic_key
      || original.polarity !== row.version_polarity) {
      incrementReason(reasons, "stored_rule_mismatch");
      continue;
    }
    const candidate = findCurrentCandidate(commandText, original, row.condition_key);
    if (!candidate) {
      incrementReason(reasons, "detector_no_match");
      continue;
    }
    const evidenceRows = db.prepare(`
      SELECT e.event_id, e.conditions, e.detector_version, v.session_id_hash, v.observed_at
      FROM owner_correction_evidence e
      JOIN owner_correction_events v ON v.event_id = e.event_id
      WHERE e.bundle_key = ?
      ORDER BY datetime(v.observed_at), e.event_id
    `).all(row.bundle_key) as BackfillEvidenceRow[];
    if (evidenceRows.length === 0) {
      incrementReason(reasons, "no_evidence");
      continue;
    }
    const evidence: RuleTextBackfillPlan["evidence"] = [];
    let evidenceFailure: string | undefined;
    for (const evidenceRow of evidenceRows) {
      const evidenceInput = parsedCommandInput(evidenceRow.conditions);
      if (!evidenceInput) {
        evidenceFailure = "evidence_invalid_conditions";
        break;
      }
      const evidenceCommandText = evidenceInput.commandText?.trim();
      if (!evidenceCommandText) {
        evidenceFailure = "evidence_missing_command_text";
        break;
      }
      const evidenceCandidate = findCurrentCandidate(evidenceCommandText, evidenceInput, row.condition_key);
      if (!evidenceCandidate) {
        evidenceFailure = "evidence_detector_no_match";
        break;
      }
      if (evidenceCandidate.polarity !== candidate.polarity) {
        evidenceFailure = "evidence_polarity_conflict";
        break;
      }
      evidence.push({
        eventId: evidenceRow.event_id,
        sourceCommand: evidenceInput.commandText?.trim() ?? "",
        detectorVersion: evidenceRow.detector_version,
        sessionIdHash: evidenceRow.session_id_hash,
        observedAt: evidenceRow.observed_at,
        candidate: evidenceCandidate,
      });
    }
    if (evidenceFailure) {
      incrementReason(reasons, evidenceFailure);
      continue;
    }
    const selectedPlainRule = candidate.ruleText
      ? undefined
      : selectPlainRuleText(evidence, row.last_seen_at);
    const ruleText = candidate.ruleText || selectedPlainRule?.ruleText || "";
    if (!ruleText) {
      incrementReason(reasons, selectedPlainRule?.reason ?? "generated_rule_empty");
    }
    const polarityChanged = row.polarity !== candidate.polarity;

    plans.push({
      bundleKey: row.bundle_key,
      version: row.version,
      conditionKey: row.condition_key,
      sourceCommand: selectedPlainRule?.sourceCommand ?? commandText,
      ruleText,
      writeRequired: ruleText.length > 0 || polarityChanged,
      beforeRuleText: row.rule_text,
      beforePolarity: row.polarity,
      candidate,
      evidence,
    });
  }
  return { plans, candidateCount: rows.length, reasons };
}

function applyRuleTextBackfill(db: Database.Database, plans: RuleTextBackfillPlan[]): void {
  const updateBundle = db.prepare(`
    UPDATE owner_correction_bundles
    SET rule_text = ?, polarity = ?
    WHERE bundle_key = ? AND version = ? AND status = 'candidate' AND rule_text = ''
  `);
  const updateVersion = db.prepare(`
    UPDATE owner_correction_versions
    SET rule_text = ?, body_hash = ?, conditions = ?, polarity = ?
    WHERE bundle_key = ? AND version = ? AND rule_text = ''
  `);
  const updateEvidence = db.prepare(`
    UPDATE owner_correction_evidence
    SET conditions = ?, polarity = ?
    WHERE bundle_key = ? AND event_id = ?
  `);
  const transaction = db.transaction(() => {
    for (const plan of plans) {
      if (!plan.writeRequired) continue;
      const ruleText = plan.ruleText;
      const polarity = plan.candidate.polarity;
      const conditions = serializeCorrectionRuleInput(plan.candidate.ruleInput);
      const bundleResult = updateBundle.run(ruleText, polarity, plan.bundleKey, plan.version);
      const versionResult = updateVersion.run(
        ruleText,
        createHash("sha256").update(ruleText, "utf8").digest("hex"),
        conditions,
        polarity,
        plan.bundleKey,
        plan.version,
      );
      if (bundleResult.changes !== 1 || versionResult.changes !== 1) {
        throw new CorrectionImportError("rule text backfill target changed during apply");
      }
      for (const evidence of plan.evidence) {
        const result = updateEvidence.run(
          serializeCorrectionRuleInput(evidence.candidate.ruleInput),
          evidence.candidate.polarity,
          plan.bundleKey,
          evidence.eventId,
        );
        if (result.changes !== 1) throw new CorrectionImportError("rule text backfill evidence changed during apply");
      }
    }
  });
  transaction();
}

export function backfillCorrectionRuleText(targetPath: string, apply = false): RuleTextBackfillSummary {
  const targetRealPath = resolveExistingPath(targetPath);
  const db = openDatabase(targetRealPath, !apply);
  try {
    const schemaVersion = validateRuleTextBackfillSchema(db);
    const prepared = prepareRuleTextBackfill(db);
    const examples = prepared.plans.filter((plan) => plan.ruleText.length > 0).slice(0, 3).map((plan) => ({
      sourceCommand: plan.sourceCommand,
      beforeRuleText: plan.beforeRuleText,
      afterRuleText: plan.ruleText,
      beforePolarity: plan.beforePolarity,
      afterPolarity: plan.candidate.polarity,
    }));
    const summary: RuleTextBackfillSummary = {
      schemaVersion,
      candidateCount: prepared.candidateCount,
      fillCount: prepared.plans.filter((plan) => plan.ruleText.length > 0).length,
      unfilledCount: prepared.candidateCount - prepared.plans.filter((plan) => plan.ruleText.length > 0).length,
      polarityChangedCount: prepared.plans.filter((plan) => plan.beforePolarity !== plan.candidate.polarity).length,
      reasons: prepared.reasons,
      examples,
      backupCreated: false,
    };
    const writePlans = prepared.plans.filter((plan) => plan.writeRequired);
    if (!apply || writePlans.length === 0) return summary;
    backupBeforeMigration(db, dirname(targetRealPath), "pre-rule-text-backfill");
    applyRuleTextBackfill(db, writePlans);
    summary.backupCreated = true;
    return summary;
  } finally {
    db.close();
  }
}

function findPriorImport(
  db: Pick<Database.Database, "prepare">,
  storeHash: string,
  memory: ImportedMemory,
): { target_memory_id: string; source_content_hash: string } | undefined {
  return db.prepare(`
    SELECT target_memory_id, source_content_hash
    FROM owner_correction_imports
    WHERE source_store_hash = ? AND source_memory_id = ?
  `).get(storeHash, memory.id) as { target_memory_id: string; source_content_hash: string } | undefined;
}

function findActiveDuplicate(db: Pick<Database.Database, "prepare">, memory: ImportedMemory): { id: string } | undefined {
  return db.prepare(`
    SELECT id
    FROM memories
    WHERE state = 'active' AND category = ? AND content_hash = ? AND project IS ? AND scope IS ?
    LIMIT 1
  `).get(memory.category, memoryContentHash(memory), memory.project, memory.scope) as { id: string } | undefined;
}

function idExists(db: Pick<Database.Database, "prepare">, id: string): boolean {
  return db.prepare("SELECT id FROM memories WHERE id = ?").get(id) !== undefined;
}

function emptySummary(sourceCount: number, skippedCount: number, migrationRequired: boolean): CorrectionImportSummary {
  return {
    sourceCount,
    skippedCount,
    addedCount: 0,
    duplicateCount: 0,
    alreadyImportedCount: 0,
    idCollisionCount: 0,
    generatedCandidates: 0,
    expiryChanges: 0,
    migrationRequired,
  };
}

function processMemories(
  memories: ImportedMemory[],
  targetDb: Pick<Database.Database, "prepare">,
  storeHash: string,
  targetVersion: number,
  apply: boolean,
  importMemory?: (params: {
    sourceStoreHash: string;
    sourceMemoryId: string;
    importedAt: string;
    sourceContentHash: string;
    memory: ImportedMemory;
  }) => { targetMemoryId: string; inserted: boolean },
  importedAt = "",
): CorrectionImportSummary {
  const summary = emptySummary(memories.length, 0, targetVersion === CURRENT_SCHEMA_VERSION);

  for (const memory of memories) {
    const contentHash = sourceRowHash(memory);
    const priorImport = targetVersion === CORRECTION_SCHEMA_VERSION
      ? findPriorImport(targetDb, storeHash, memory)
      : undefined;
    if (priorImport) {
      if (priorImport.source_content_hash !== contentHash) {
        throw new CorrectionImportError("imported source content changed");
      }
      summary.alreadyImportedCount += 1;
      continue;
    }

    const duplicate = findActiveDuplicate(targetDb, memory);
    const collision = duplicate === undefined && idExists(targetDb, memory.id);
    if (!apply) {
      if (duplicate) {
        summary.duplicateCount += 1;
      } else {
        summary.addedCount += 1;
        if (collision) {
          summary.idCollisionCount += 1;
        }
      }
      continue;
    }

    if (!importMemory) {
      throw new CorrectionImportError("import transaction is unavailable");
    }
    const result = importMemory({
      sourceStoreHash: storeHash,
      sourceMemoryId: memory.id,
      importedAt,
      sourceContentHash: contentHash,
      memory,
    });
    if (result.inserted) {
      summary.addedCount += 1;
      if (collision) {
        summary.idCollisionCount += 1;
      }
    } else {
      summary.duplicateCount += 1;
    }
  }

  return summary;
}

export function importCorrectionMemories(options: CorrectionImportOptions): CorrectionImportSummary {
  const sourceRealPath = resolveExistingPath(options.sourcePath);
  const targetRealPath = resolveExistingPath(options.targetPath);
  if (sourceRealPath === targetRealPath) {
    throw new CorrectionImportError("source and target databases must be different files");
  }

  const sourceDb = openDatabase(sourceRealPath, true);
  let targetReadDb: Database.Database | undefined;
  let targetStorage: SQLiteStorage | undefined;
  try {
    const sourceVersion = validateMemoryDatabase(sourceDb, true);
    if (sourceVersion === CORRECTION_SCHEMA_VERSION) {
      validateCorrectionSchema(sourceDb, sourceVersion);
    }
    const memories = readImportMemories(sourceDb);
    const targetVersionDb = openDatabase(targetRealPath, true);
    targetReadDb = targetVersionDb;
    const targetVersion = validateMemoryDatabase(targetVersionDb, true);
    validateCorrectionSchema(targetVersionDb, targetVersion);
    const summary = processMemories(
      memories,
      targetVersionDb,
      sourceStoreHash(sourceRealPath),
      targetVersion,
      false,
    );
    if (!options.apply) {
      return summary;
    }
    if (targetVersion !== CORRECTION_SCHEMA_VERSION) {
      throw new CorrectionImportError("target requires --migrate-v11 --apply before import apply");
    }

    targetReadDb.close();
    targetReadDb = undefined;
    try {
      targetStorage = SQLiteStorage.openExistingForHook(targetRealPath, { mode: "correction" });
    } catch {
      throw new CorrectionImportError("target correction database is unavailable");
    }
    const importedAt = options.importedAt ?? new Date().toISOString();
    const applySummary = targetStorage.runCorrectionTransaction(({ db, importMemory }) => processMemories(
      memories,
      db,
      sourceStoreHash(sourceRealPath),
      targetVersion,
      true,
      importMemory,
      importedAt,
    ));
    return applySummary;
  } finally {
    targetStorage?.close();
    targetReadDb?.close();
    sourceDb.close();
  }
}

export function migrateCorrectionDatabase(targetPath: string, apply = false): CorrectionMigrationSummary {
  const targetRealPath = resolveExistingPath(targetPath);
  const db = openDatabase(targetRealPath, !apply);
  try {
    const version = validateMemoryDatabase(db, true);
    validateCorrectionSchema(db, version);
    if (version === CORRECTION_SCHEMA_VERSION) {
      return { schemaVersion: version, ddlCount: 0 };
    }
    if (version !== CURRENT_SCHEMA_VERSION) {
      throw new CorrectionImportError("v11 migration requires schema version 10");
    }
    if (!apply) {
      return { schemaVersion: version, ddlCount: CORRECTION_TABLES.length };
    }
    migrateV10ToV11(db);
    return { schemaVersion: getSchemaVersion(db), ddlCount: CORRECTION_TABLES.length };
  } finally {
    db.close();
  }
}

export function migrateCorrectionComplianceDatabase(targetPath: string, apply = false): CorrectionMigrationSummary {
  const targetRealPath = resolveExistingPath(targetPath);
  const db = openDatabase(targetRealPath, !apply);
  try {
    validateMemoryTable(db);
    const version = getSchemaVersion(db);
    if (version !== CORRECTION_SCHEMA_VERSION && version !== CORRECTION_COMPLIANCE_SCHEMA_VERSION) {
      throw new CorrectionImportError("v12 migration requires schema version 11");
    }
    const requiredTables = version === CORRECTION_SCHEMA_VERSION
      ? CORRECTION_TABLE_NAMES
      : CORRECTION_COMPLIANCE_TABLES;
    if (tableCount(db, requiredTables) !== requiredTables.length) {
      throw new CorrectionImportError("correction database schema is incomplete");
    }
    if (version === CORRECTION_COMPLIANCE_SCHEMA_VERSION) {
      return { schemaVersion: version, ddlCount: 0 };
    }
    if (!apply) return { schemaVersion: version, ddlCount: 1 };
    migrateV11ToV12(db);
    return { schemaVersion: getSchemaVersion(db), ddlCount: 1 };
  } finally {
    db.close();
  }
}
