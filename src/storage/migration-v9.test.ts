import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";
import { getSchemaVersion } from "./schema.js";
import { migrateV8ToV9 } from "./migration.js";

// v8相当スキーマ（last_read_at あり・lineage/principles 無し）を直接作る。
// 版数注記: design.md は lineage/principles を「v7新設」と規定していたが、実コードでは
// v7=content_hash（wave1事故の是正）・v8=last_read_at（忘却実退避）が既に版数を占有済みのため、
// 系譜と昇格の土台は migrateV8ToV9 として実装する（テーブル定義・制約は design.md 通り）。
function createV8Schema(db: Database.Database): void {
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
    INSERT INTO schema_version (version) VALUES (8);
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

describe("migrateV8ToV9（lineage・principles 新設）", () => {
  let tmpDir: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-migration-v9-test-"));
    mkdirSync(tmpDir, { recursive: true });
    dbPath = join(tmpDir, "memory.db");
    db = new Database(dbPath);
    createV8Schema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("lineage と principles テーブルが design.md の定義どおり作られる", () => {
    expect(tableNames(db)).not.toContain("lineage");
    expect(tableNames(db)).not.toContain("principles");

    migrateV8ToV9(db, tmpDir);

    expect(tableNames(db)).toContain("lineage");
    expect(tableNames(db)).toContain("principles");

    expect(columnNames(db, "lineage").sort()).toEqual(
      ["id", "child_id", "parent_id", "relation", "created_at"].sort(),
    );
    expect(columnNames(db, "principles").sort()).toEqual(
      [
        "id",
        "text",
        "origin_tier",
        "evidence_ids",
        "valid_until",
        "state",
        "approved_at",
        "created_at",
      ].sort(),
    );
  });

  it("schema_version が 9 になる", () => {
    expect(getSchemaVersion(db)).toBe(8);
    migrateV8ToV9(db, tmpDir);
    expect(getSchemaVersion(db)).toBe(9);
  });

  it("lineage の relation は merged_from / supersedes に CHECK 制約で限定される", () => {
    migrateV8ToV9(db, tmpDir);
    const insert = db.prepare(
      "INSERT INTO lineage (id, child_id, parent_id, relation, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
    );
    expect(() => insert.run("l1", "c1", "p1", "merged_from")).not.toThrow();
    expect(() => insert.run("l2", "c2", "p2", "supersedes")).not.toThrow();
    expect(() => insert.run("l3", "c3", "p3", "invalid_relation")).toThrow();
  });

  it("lineage の必須列（child_id / parent_id / relation）欠落行が拒否される", () => {
    migrateV8ToV9(db, tmpDir);
    // child_id を NULL にする（NOT NULL 違反）
    expect(() =>
      db
        .prepare("INSERT INTO lineage (id, child_id, parent_id, relation, created_at) VALUES (?, ?, ?, ?, ?)")
        .run("l4", null, "p4", "merged_from", "2026-01-01"),
    ).toThrow();
  });

  it("principles の state / origin_tier は CHECK 制約で限定される", () => {
    migrateV8ToV9(db, tmpDir);
    const insert = db.prepare(
      `INSERT INTO principles (id, text, origin_tier, evidence_ids, valid_until, state, approved_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    );
    expect(() =>
      insert.run("pr1", "text", "owner_confirmed", "[]", "2099-01-01", "proposed", null),
    ).not.toThrow();
    expect(() =>
      insert.run("pr2", "text", "bad_tier", "[]", "2099-01-01", "proposed", null),
    ).toThrow();
    expect(() =>
      insert.run("pr3", "text", "agent_observed", "[]", "2099-01-01", "bad_state", null),
    ).toThrow();
  });

  it("principles の必須列（evidence_ids / valid_until）欠落行が拒否される", () => {
    migrateV8ToV9(db, tmpDir);
    expect(() =>
      db
        .prepare(
          `INSERT INTO principles (id, text, origin_tier, evidence_ids, valid_until, state, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("pr4", "text", "owner_confirmed", null, "2099-01-01", "proposed", "2026-01-01"),
    ).toThrow();
  });

  it("移行前バックアップが走る（migration-backups にファイルが生成される）", () => {
    migrateV8ToV9(db, tmpDir);
    const backupDir = join(tmpDir, "migration-backups");
    expect(existsSync(backupDir)).toBe(true);
    const backups = readdirSync(backupDir).filter((f) => f.startsWith("pre-v9-migration-"));
    expect(backups.length).toBeGreaterThanOrEqual(1);
  });

  it("再実行しても破壊しない（テーブル存在チェックでスキップ・2回目は no-op）", () => {
    migrateV8ToV9(db, tmpDir);
    db.prepare(
      "INSERT INTO principles (id, text, origin_tier, evidence_ids, valid_until, state, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))",
    ).run("keep", "t", "owner_confirmed", "[]", "2099-01-01", "approved");

    expect(() => migrateV8ToV9(db, tmpDir)).not.toThrow();
    expect(getSchemaVersion(db)).toBe(9);
    const cnt = (
      db.prepare("SELECT COUNT(*) as c FROM principles WHERE id = 'keep'").get() as { c: number }
    ).c;
    expect(cnt).toBe(1);
  });

  it("既存 memories 行は移行で一切変化しない（新テーブル追加のみ）", () => {
    db.prepare(
      "INSERT INTO memories (id, timestamp, category, title, content, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("m1", "2026-01-01T00:00:00+09:00", "log", "t", "c", "active", "2026-01-01 00:00:00", "2026-01-02 00:00:00");
    const before = db.prepare("SELECT * FROM memories WHERE id = 'm1'").get();

    migrateV8ToV9(db, tmpDir);

    const after = db.prepare("SELECT * FROM memories WHERE id = 'm1'").get();
    expect(after).toEqual(before);
  });
});
