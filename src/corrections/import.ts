import { createHash } from "crypto";
import { realpathSync } from "fs";
import Database from "better-sqlite3";
import type { MemoryCategory, ProjectConfidence } from "../types.js";
import { migrateV10ToV11, migrateV11ToV12 } from "../storage/migration.js";
import {
  CORRECTION_COMPLIANCE_SCHEMA_VERSION,
  CORRECTION_SCHEMA_VERSION,
  CORRECTION_TABLE_NAMES,
} from "../storage/correction-schema.js";
import { SQLiteStorage } from "../storage/sqlite.js";
import { computeContentHash } from "../storage/content-hash.js";
import { CURRENT_SCHEMA_VERSION, getSchemaVersion } from "../storage/schema.js";

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

export class CorrectionImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorrectionImportError";
  }
}

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
