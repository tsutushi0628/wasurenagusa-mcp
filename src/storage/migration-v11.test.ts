import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";
import { initializeCorrectionSchema } from "./correction-schema.js";
import { migrateV10ToV11 } from "./migration.js";
import { getSchemaVersion, initializeSchema } from "./schema.js";
import { SQLiteStorage } from "./sqlite.js";

const correctionTableNames = [
  "owner_correction_events",
  "owner_correction_evidence",
  "owner_correction_pending",
  "owner_correction_bundles",
  "owner_correction_versions",
  "owner_correction_sessions",
  "owner_correction_injections",
  "owner_correction_imports",
];

function tableNames(db: Database.Database): string[] {
  return (db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as Array<{ name: string }>).map((row) => row.name);
}

function correctionDefinitions(db: Database.Database): Array<{ type: string; name: string; tbl_name: string; sql: string | null }> {
  return db.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name LIKE 'owner_correction_%' OR tbl_name LIKE 'owner_correction_%' ORDER BY type, name",
  ).all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
}

function insertMemory(db: Database.Database): void {
  db.prepare(
    "INSERT INTO memories (id, timestamp, category, title, content, tags, project, scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("fixture-memory", "2026-01-01T00:00:00Z", "dont", "fixture", "synthetic", "[]", "fixture-project", "project");
}

describe("v10からv11への専用移行", () => {
  let tmpDir: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-migration-v11-test-"));
    dbPath = join(tmpDir, "memory.db");
    db = new Database(dbPath);
    initializeSchema(db);
  });

  afterEach(() => {
    if (db.open) {
      db.close();
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("移行後の8表構造を明示初期化と一致させる", () => {
    insertMemory(db);
    const memoryBefore = db.prepare("SELECT * FROM memories WHERE id = ?").get("fixture-memory");
    const oldTables = tableNames(db);

    migrateV10ToV11(db);

    expect(getSchemaVersion(db)).toBe(11);
    expect(tableNames(db).filter((name) => name.startsWith("owner_correction_")).sort())
      .toEqual(correctionTableNames.slice().sort());
    expect(db.prepare("SELECT * FROM memories WHERE id = ?").get("fixture-memory")).toEqual(memoryBefore);
    expect(tableNames(db).filter((name) => !name.startsWith("owner_correction_"))).toEqual(oldTables);

    const newDb = new Database(join(tmpDir, "new.db"));
    try {
      initializeSchema(newDb);
      initializeCorrectionSchema(newDb);
      expect(correctionDefinitions(db)).toEqual(correctionDefinitions(newDb));
      expect(getSchemaVersion(newDb)).toBe(11);
    } finally {
      newDb.close();
    }
  });

  it("再実行時はDDLも版更新も0差分", () => {
    migrateV10ToV11(db);
    const definitionsBefore = correctionDefinitions(db);
    const versionsBefore = db.prepare("SELECT version, applied_at FROM schema_version ORDER BY version").all();
    const changesBefore = (db.prepare("SELECT total_changes() AS changes").get() as { changes: number }).changes;

    migrateV10ToV11(db);

    const changesAfter = (db.prepare("SELECT total_changes() AS changes").get() as { changes: number }).changes;
    expect(changesAfter - changesBefore).toBe(0);
    expect(correctionDefinitions(db)).toEqual(definitionsBefore);
    expect(db.prepare("SELECT version, applied_at FROM schema_version ORDER BY version").all()).toEqual(versionsBefore);
  });

  it("DDL途中の失敗で新規表とv11版更新をrollbackする", () => {
    insertMemory(db);
    const memoryBefore = db.prepare("SELECT * FROM memories WHERE id = ?").get("fixture-memory");
    db.exec("CREATE TABLE owner_correction_pending (receipt_id TEXT PRIMARY KEY)");

    expect(() => migrateV10ToV11(db)).toThrow();

    expect(getSchemaVersion(db)).toBe(10);
    expect(tableNames(db)).not.toContain("owner_correction_events");
    expect(tableNames(db)).not.toContain("owner_correction_evidence");
    expect(tableNames(db)).toContain("owner_correction_pending");
    expect(db.prepare("SELECT * FROM memories WHERE id = ?").get("fixture-memory")).toEqual(memoryBefore);
  });

  it("通常のSQLiteStorage.initializeは既存v10を移行しない", () => {
    insertMemory(db);
    db.close();

    const storage = new SQLiteStorage(dbPath);
    storage.initialize();
    storage.close();
    db = new Database(dbPath);

    expect(getSchemaVersion(db)).toBe(10);
    expect(tableNames(db).filter((name) => name.startsWith("owner_correction_"))).toEqual([]);
    expect(db.prepare("SELECT * FROM memories WHERE id = ?").get("fixture-memory")).toMatchObject({
      id: "fixture-memory",
      content: "synthetic",
    });
  });

  it("通常のSQLiteStorage.initializeは明示済みv11を再利用する", () => {
    insertMemory(db);
    migrateV10ToV11(db);
    const definitionsBefore = correctionDefinitions(db);
    db.close();

    const storage = new SQLiteStorage(dbPath);
    storage.initialize();
    storage.close();
    db = new Database(dbPath);

    expect(getSchemaVersion(db)).toBe(11);
    expect(correctionDefinitions(db)).toEqual(definitionsBefore);
    expect(db.prepare("SELECT * FROM memories WHERE id = ?").get("fixture-memory")).toMatchObject({
      id: "fixture-memory",
      content: "synthetic",
    });
  });
});
