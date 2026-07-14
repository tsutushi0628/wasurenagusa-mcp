import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";
import { getSchemaVersion } from "./schema.js";
import { migrateV9ToV10 } from "./migration.js";

// v9相当スキーマ（lineage/principles あり・guards 無し）を直接作る。
// 版数注記: design.md は guards を「v8移行」と規定していたが、実コードでは v7=content_hash・
// v8=last_read_at・v9=lineage/principles が既に版数を占有済みのため、承認制ガードの土台は
// migrateV9ToV10 として実装する（テーブル定義・制約は design.md 通り）。
function createV9Schema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        category TEXT NOT NULL CHECK(category IN ('config','dont','decision','log','snippet','dream','success')),
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        project TEXT,
        scope TEXT,
        deleted_at TEXT,
        state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','archived','deleted')),
        project_confidence TEXT NOT NULL DEFAULT 'unknown' CHECK(project_confidence IN ('confirmed','inferred','unknown')),
        content_hash TEXT,
        last_read_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE lineage (
        id TEXT PRIMARY KEY,
        child_id TEXT NOT NULL,
        parent_id TEXT NOT NULL,
        relation TEXT NOT NULL CHECK (relation IN ('merged_from','supersedes')),
        created_at TEXT NOT NULL
    );
    CREATE TABLE principles (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        origin_tier TEXT NOT NULL CHECK (origin_tier IN ('owner_confirmed','agent_observed')),
        evidence_ids TEXT NOT NULL,
        valid_until TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('proposed','approved','expired','rejected')),
        approved_at TEXT,
        created_at TEXT NOT NULL
    );
    INSERT INTO schema_version (version) VALUES (9);
  `);
}

function tableNames(db: Database.Database): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
  ).map((r) => r.name);
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).map(
    (r) => r.name,
  );
}

describe("migrateV9ToV10（guards 新設・承認制ガードレジストリの土台）", () => {
  let tmpDir: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-migration-v10-test-"));
    mkdirSync(tmpDir, { recursive: true });
    dbPath = join(tmpDir, "memory.db");
    db = new Database(dbPath);
    createV9Schema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("guards テーブルが design.md の定義どおり作られる", () => {
    expect(tableNames(db)).not.toContain("guards");

    migrateV9ToV10(db, tmpDir);

    expect(tableNames(db)).toContain("guards");
    expect(columnNames(db, "guards").sort()).toEqual(
      ["id", "pattern", "source_incident_id", "approved_at", "expires_at", "state", "created_at"].sort(),
    );
  });

  it("schema_version が 10 になる", () => {
    expect(getSchemaVersion(db)).toBe(9);
    migrateV9ToV10(db, tmpDir);
    expect(getSchemaVersion(db)).toBe(10);
  });

  it("出所（source_incident_id）なしのINSERTが失敗する", () => {
    migrateV9ToV10(db, tmpDir);
    expect(() =>
      db
        .prepare(
          "INSERT INTO guards (id, pattern, expires_at, state, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
        )
        .run("g1", "pattern", "2099-01-01", "proposed"),
    ).toThrow();
  });

  it("expires_atなしのINSERTが失敗する", () => {
    migrateV9ToV10(db, tmpDir);
    expect(() =>
      db
        .prepare(
          "INSERT INTO guards (id, pattern, source_incident_id, state, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
        )
        .run("g2", "pattern", "incident-1", "proposed"),
    ).toThrow();
  });

  it("state不正値のINSERTが失敗する（CHECK制約）", () => {
    migrateV9ToV10(db, tmpDir);
    const insert = db.prepare(
      `INSERT INTO guards (id, pattern, source_incident_id, expires_at, state, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    );
    expect(() => insert.run("g3", "pattern", "incident-1", "2099-01-01", "active")).not.toThrow();
    expect(() => insert.run("g4", "pattern", "incident-1", "2099-01-01", "unknown_state")).toThrow();
  });

  it("移行前バックアップが走る（migration-backups にファイルが生成される）", () => {
    migrateV9ToV10(db, tmpDir);
    const backupDir = join(tmpDir, "migration-backups");
    expect(existsSync(backupDir)).toBe(true);
    const backups = readdirSync(backupDir).filter((f) => f.startsWith("pre-v10-migration-"));
    expect(backups.length).toBeGreaterThanOrEqual(1);
  });

  it("2回呼んでも冪等（テーブル存在チェックでスキップ・2回目は no-op）", () => {
    migrateV9ToV10(db, tmpDir);
    db.prepare(
      "INSERT INTO guards (id, pattern, source_incident_id, expires_at, state, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))",
    ).run("keep", "p", "incident-1", "2099-01-01", "active");

    expect(() => migrateV9ToV10(db, tmpDir)).not.toThrow();
    expect(getSchemaVersion(db)).toBe(10);
    const cnt = (
      db.prepare("SELECT COUNT(*) as c FROM guards WHERE id = 'keep'").get() as { c: number }
    ).c;
    expect(cnt).toBe(1);
  });

  it("既存テーブル（memories等）の中身が移行前後で変わらない", () => {
    db.prepare(
      "INSERT INTO memories (id, timestamp, category, title, content, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("m1", "2026-01-01T00:00:00+09:00", "log", "t", "c", "active", "2026-01-01 00:00:00", "2026-01-02 00:00:00");
    const before = db.prepare("SELECT * FROM memories WHERE id = 'm1'").get();

    migrateV9ToV10(db, tmpDir);

    const after = db.prepare("SELECT * FROM memories WHERE id = 'm1'").get();
    expect(after).toEqual(before);
  });
});
