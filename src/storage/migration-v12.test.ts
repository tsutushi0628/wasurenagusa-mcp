import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";
import { CORRECTION_COMPLIANCE_SCHEMA_VERSION, initializeCorrectionSchema } from "./correction-schema.js";
import { migrateV10ToV11, migrateV11ToV12 } from "./migration.js";
import { getSchemaVersion, initializeSchema } from "./schema.js";
import { SQLiteStorage } from "./sqlite.js";

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return row !== undefined;
}

function indexColumns(db: Database.Database, indexName: string): string[] {
  return db.prepare(`PRAGMA index_info(${indexName})`).all()
    .map((row) => (row as { name: string }).name);
}

describe("v11からv12への専用移行", () => {
  let tmpDir: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-migration-v12-test-"));
    dbPath = join(tmpDir, "memory.db");
    db = new Database(dbPath);
    initializeSchema(db);
    migrateV10ToV11(db);
  });

  afterEach(() => {
    if (db.open) db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("専用DDLで違反表を作り、版数を12へ進める", () => {
    migrateV11ToV12(db);

    expect(getSchemaVersion(db)).toBe(CORRECTION_COMPLIANCE_SCHEMA_VERSION);
    expect(tableExists(db, "owner_correction_violations")).toBe(true);
    const columns = db.prepare("PRAGMA table_info(owner_correction_violations)").all()
      .map((row) => (row as { name: string }).name);
    expect(columns).toEqual([
      "session_id_hash",
      "human_ordinal",
      "bundle_key",
      "version",
      "checker",
      "detected_at",
    ]);
    expect(indexColumns(db, "idx_owner_correction_events_session_ordinal"))
      .toEqual(["session_id_hash", "human_ordinal"]);
  });

  it("再実行時はDDLも版数も変えない", () => {
    migrateV11ToV12(db);
    const schemaBefore = db.prepare("SELECT version, applied_at FROM schema_version ORDER BY version").all();
    const changesBefore = (db.prepare("SELECT total_changes() AS changes").get() as { changes: number }).changes;

    migrateV11ToV12(db);

    const changesAfter = (db.prepare("SELECT total_changes() AS changes").get() as { changes: number }).changes;
    expect(changesAfter - changesBefore).toBe(0);
    expect(db.prepare("SELECT version, applied_at FROM schema_version ORDER BY version").all()).toEqual(schemaBefore);
  });

  it("通常initializeはv11をv12へ進めない", () => {
    db.close();
    const storage = new SQLiteStorage(dbPath);
    storage.initialize();
    storage.close();
    db = new Database(dbPath);

    expect(getSchemaVersion(db)).toBe(11);
    expect(tableExists(db, "owner_correction_violations")).toBe(false);
    expect(indexColumns(db, "idx_owner_correction_events_session_ordinal")).toEqual([]);
    initializeCorrectionSchema(db);
    expect(tableExists(db, "owner_correction_violations")).toBe(false);
  });

  it("v12専用移行は欠けたevents indexを冪等に作り直し、indexなしの照会も通す", () => {
    migrateV11ToV12(db);
    db.exec("DROP INDEX idx_owner_correction_events_session_ordinal");

    db.prepare(`
      INSERT INTO owner_correction_events (
        event_id, session_id_hash, human_ordinal, observed_at, available_at,
        source_kind, excerpt, previous_action, project, scope, raw_text_hash,
        source_locator_hash, processed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "indexless-event", "synthetic-session-hash", 7, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z",
      "user", "合成発話", "action_unknown", "synthetic-project", "general", "synthetic-hash",
      "synthetic-locator", "2026-01-01T00:00:01.000Z",
    );
    expect(db.prepare(`
      SELECT human_ordinal FROM owner_correction_events
      WHERE session_id_hash = ? AND human_ordinal = ?
    `).get("synthetic-session-hash", 7)).toEqual({ human_ordinal: 7 });

    migrateV11ToV12(db);

    expect(indexColumns(db, "idx_owner_correction_events_session_ordinal"))
      .toEqual(["session_id_hash", "human_ordinal"]);
    expect(getSchemaVersion(db)).toBe(CORRECTION_COMPLIANCE_SCHEMA_VERSION);
  });

  it("通常initializeは明示移行済みv12を変更しない", () => {
    migrateV11ToV12(db);
    db.close();
    const storage = new SQLiteStorage(dbPath);
    storage.initialize();
    storage.close();
    db = new Database(dbPath);

    expect(getSchemaVersion(db)).toBe(12);
    expect(tableExists(db, "owner_correction_violations")).toBe(true);
  });

  it("既存の不完全な違反表で移行を止め、版数を保つ", () => {
    db.exec("CREATE TABLE owner_correction_violations (synthetic TEXT)");

    expect(() => migrateV11ToV12(db)).toThrow();

    expect(getSchemaVersion(db)).toBe(11);
    expect(db.prepare("PRAGMA table_info(owner_correction_violations)").all()).toHaveLength(1);
  });
});
