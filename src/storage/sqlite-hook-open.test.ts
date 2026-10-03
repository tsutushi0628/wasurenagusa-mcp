import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "fs";
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

function createV10Database(dbPath: string): void {
  const db = new Database(dbPath);
  initializeSchema(db);
  db.prepare(
    "INSERT INTO memories (id, timestamp, category, title, content, tags, project, scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("fixture-memory", "2026-01-01T00:00:00Z", "dont", "fixture title", "synthetic body", "[]", "fixture-project", "project");
  db.close();
}

function createV11Database(dbPath: string): void {
  const db = new Database(dbPath);
  initializeSchema(db);
  initializeCorrectionSchema(db);
  db.close();
}

function createMigratedV11Database(dbPath: string): void {
  const db = new Database(dbPath);
  initializeSchema(db);
  migrateV10ToV11(db);
  db.close();
}

function schemaObjects(db: Database.Database): Array<{ type: string; name: string; tbl_name: string; sql: string | null }> {
  return db.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
  ).all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
}

describe("SQLiteStorage.openExistingForHook", () => {
  let tmpDir: string;
  let storage: SQLiteStorage | undefined;

  afterEach(() => {
    if (storage) {
      storage.close();
      storage = undefined;
    }
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  function createTempDir(): void {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-hook-open-"));
  }

  it("DB未存在なら親ディレクトリを作らず失敗する", () => {
    createTempDir();
    const missingDirectory = join(tmpDir, "missing");

    expect(() => SQLiteStorage.openExistingForHook(join(missingDirectory, "memory.db"))).toThrow();
    expect(existsSync(missingDirectory)).toBe(false);
  });

  it("v10は索引読取だけ許可し、変更・DDL・vec作成を行わない", () => {
    createTempDir();
    const dbPath = join(tmpDir, "memory.db");
    createV10Database(dbPath);
    const before = new Database(dbPath, { readonly: true });
    const schemaBefore = schemaObjects(before);
    before.close();

    expect(() => SQLiteStorage.openExistingForHook(dbPath)).toThrow();

    storage = SQLiteStorage.openExistingForHook(dbPath, { mode: "index" });
    expect(storage.getBusyTimeout()).toBe(100);
    expect(storage.getMinimalIndexEntries("fixture-project", 1)).toEqual([
      { id: "fixture-memory", title: "fixture title", category: "dont" },
    ]);
    expect(() => storage.connection.prepare("DELETE FROM memories").run()).toThrow();
    storage.close();
    storage = undefined;

    const after = new Database(dbPath, { readonly: true });
    expect(getSchemaVersion(after)).toBe(10);
    expect(schemaObjects(after)).toEqual(schemaBefore);
    expect(after.prepare("SELECT name FROM sqlite_master WHERE name = 'vectors'").all()).toEqual([]);
    expect(after.prepare("SELECT COUNT(*) AS count FROM memories").get()).toEqual({ count: 1 });
    after.close();
  });

  it("auto接続はv10を訂正処理なしの索引接続へ落とす", () => {
    createTempDir();
    const dbPath = join(tmpDir, "memory.db");
    createV10Database(dbPath);

    storage = SQLiteStorage.openExistingForHook(dbPath, { mode: "auto" });

    expect(storage.supportsCorrectionHooks).toBe(false);
    expect(storage.getBusyTimeout()).toBe(100);
    expect(storage.getMinimalIndexEntries("fixture-project", 1)).toEqual([
      { id: "fixture-memory", title: "fixture title", category: "dont" },
    ]);
    storage.close();
    storage = undefined;

    const after = new Database(dbPath, { readonly: true });
    expect(getSchemaVersion(after)).toBe(10);
    expect(after.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'owner_correction_%'").all()).toEqual([]);
    after.close();
  });

  it("auto接続は明示移行済みv11で訂正hookを使える", () => {
    createTempDir();
    const dbPath = join(tmpDir, "memory.db");
    createMigratedV11Database(dbPath);

    storage = SQLiteStorage.openExistingForHook(dbPath, { mode: "auto" });

    expect(storage.supportsCorrectionHooks).toBe(true);
    expect(storage.getBusyTimeout()).toBe(100);
    expect(getSchemaVersion(storage.connection)).toBe(11);
  });

  it("明示初期化済みv11隔離DBを100ms接続し、スキーマを変えない", () => {
    createTempDir();
    const dbPath = join(tmpDir, "memory.db");
    createV11Database(dbPath);
    const before = new Database(dbPath, { readonly: true });
    const schemaBefore = schemaObjects(before);
    expect(getSchemaVersion(before)).toBe(11);
    expect(before.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'owner_correction_%' ORDER BY name").all())
      .toEqual(correctionTableNames.slice().sort().map((name) => ({ name })));
    before.close();

    storage = SQLiteStorage.openExistingForHook(dbPath);
    expect(storage.getBusyTimeout()).toBe(100);
    expect(getSchemaVersion(storage.connection)).toBe(11);
    storage.close();
    storage = undefined;

    const after = new Database(dbPath, { readonly: true });
    expect(schemaObjects(after)).toEqual(schemaBefore);
    expect(after.prepare("SELECT name FROM sqlite_master WHERE name = 'vectors'").all()).toEqual([]);
    after.close();
  });

  it("v10から明示移行済みのDBをhook接続で再利用する", () => {
    createTempDir();
    const dbPath = join(tmpDir, "memory.db");
    createMigratedV11Database(dbPath);
    const before = new Database(dbPath, { readonly: true });
    const schemaBefore = schemaObjects(before);
    before.close();

    storage = SQLiteStorage.openExistingForHook(dbPath);
    expect(storage.getBusyTimeout()).toBe(100);
    expect(getSchemaVersion(storage.connection)).toBe(11);
    storage.close();
    storage = undefined;

    const after = new Database(dbPath, { readonly: true });
    expect(schemaObjects(after)).toEqual(schemaBefore);
    after.close();
  });

  it("v11でも必要な訂正表が欠けていれば失敗し、補修しない", () => {
    createTempDir();
    const dbPath = join(tmpDir, "memory.db");
    createV11Database(dbPath);
    const db = new Database(dbPath);
    db.exec("DROP TABLE owner_correction_imports");
    const schemaBefore = schemaObjects(db);
    db.close();

    expect(() => SQLiteStorage.openExistingForHook(dbPath)).toThrow();

    const after = new Database(dbPath, { readonly: true });
    expect(getSchemaVersion(after)).toBe(11);
    expect(schemaObjects(after)).toEqual(schemaBefore);
    after.close();
  });
});
