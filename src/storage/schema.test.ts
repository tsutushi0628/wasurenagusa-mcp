import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { initializeSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION } from "./schema.js";

describe("schema", () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-test-"));
    db = new Database(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("initializeSchemaで全テーブルが作成される", () => {
    initializeSchema(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain("memories");
    expect(tableNames).toContain("vector_metadata");
    expect(tableNames).toContain("stash");
    expect(tableNames).toContain("consolidated");
    expect(tableNames).toContain("themes");
    expect(tableNames).toContain("session_topics");
    expect(tableNames).toContain("schema_version");
  });

  it("FTS5仮想テーブルが作成される", () => {
    initializeSchema(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'")
      .all();
    expect(tables.length).toBe(1);
  });

  it("FTS5同期トリガーが作成される", () => {
    initializeSchema(db);

    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name")
      .all() as { name: string }[];
    const triggerNames = triggers.map((t) => t.name);

    expect(triggerNames).toContain("memories_ai");
    expect(triggerNames).toContain("memories_ad");
    expect(triggerNames).toContain("memories_au");
  });

  it("WALモードが有効化される", () => {
    initializeSchema(db);

    const result = db.pragma("journal_mode") as { journal_mode: string }[];
    expect(result[0].journal_mode).toBe("wal");
  });

  it("busy_timeoutが5000msに設定される", () => {
    initializeSchema(db);

    const result = db.pragma("busy_timeout") as { timeout: number }[];
    expect(result[0].timeout).toBe(5000);
  });

  it("foreign_keysが有効化される", () => {
    initializeSchema(db);

    const result = db.pragma("foreign_keys") as { foreign_keys: number }[];
    expect(result[0].foreign_keys).toBe(1);
  });

  it("getSchemaVersionがCURRENT_SCHEMA_VERSIONを返す", () => {
    initializeSchema(db);

    const version = getSchemaVersion(db);
    expect(version).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("initializeSchemaは冪等（2回実行してもエラーにならない）", () => {
    initializeSchema(db);
    initializeSchema(db);

    const version = getSchemaVersion(db);
    expect(version).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("memoriesテーブルのカラム定義が正しい", () => {
    initializeSchema(db);

    const columns = db.prepare("PRAGMA table_info(memories)").all() as {
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }[];
    const columnMap = new Map(columns.map((c) => [c.name, c]));

    expect(columnMap.get("id")?.pk).toBe(1);
    expect(columnMap.get("timestamp")?.notnull).toBe(1);
    expect(columnMap.get("category")?.notnull).toBe(1);
    expect(columnMap.get("title")?.notnull).toBe(1);
    expect(columnMap.get("content")?.notnull).toBe(1);
    expect(columnMap.get("tags")?.notnull).toBe(1);
    expect(columnMap.get("project")?.notnull).toBe(0);
    expect(columnMap.get("scope")?.notnull).toBe(0);
    expect(columnMap.get("intensity")?.notnull).toBe(0);
  });

  it("schema_version未作成時にgetSchemaVersionが0を返す", () => {
    const version = getSchemaVersion(db);
    expect(version).toBe(0);
  });

  it("インデックスが作成される", () => {
    initializeSchema(db);

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name")
      .all() as { name: string }[];
    const indexNames = indexes.map((i) => i.name);

    expect(indexNames).toContain("idx_memories_category");
    expect(indexNames).toContain("idx_memories_project");
    expect(indexNames).toContain("idx_memories_timestamp");
    expect(indexNames).toContain("idx_stash_expires");
  });
});
