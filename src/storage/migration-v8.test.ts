import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";
import { getSchemaVersion } from "./schema.js";
import { migrateV7ToV8 } from "./migration.js";

// v7相当スキーマ（content_hash あり・last_read_at 無し）を直接作る。
function createV7Schema(db: Database.Database): void {
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
        intensity INTEGER,
        knowledge_gap TEXT,
        positive_action TEXT,
        scenario TEXT,
        why_core TEXT,
        predicted_factors TEXT,
        actual_factors TEXT,
        prediction_error REAL,
        prediction_delta TEXT,
        deleted_at TEXT,
        state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','archived','deleted')),
        project_confidence TEXT NOT NULL DEFAULT 'unknown' CHECK(project_confidence IN ('confirmed','inferred','unknown')),
        content_hash TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO schema_version (version) VALUES (7);
  `);
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).map(
    (r) => r.name,
  );
}

interface MemoryRow {
  id: string;
  timestamp: string;
  category: string;
  title: string;
  content: string;
  state: string;
  content_hash: string | null;
  last_read_at: string | null;
  created_at: string;
  updated_at: string;
}

function seedRow(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO memories (id, timestamp, category, title, content, state, content_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    "2026-01-01T00:00:00+09:00",
    "log",
    `title-${id}`,
    `content-${id}`,
    "active",
    `hash-${id}`,
    "2026-01-01 00:00:00",
    "2026-01-02 00:00:00",
  );
}

describe("migrateV7ToV8", () => {
  let tmpDir: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-migration-v8-test-"));
    mkdirSync(tmpDir, { recursive: true });
    dbPath = join(tmpDir, "memory.db");
    db = new Database(dbPath);
    createV7Schema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("memoriesにlast_read_at列が追加される", () => {
    expect(columnNames(db, "memories")).not.toContain("last_read_at");
    migrateV7ToV8(db);
    expect(columnNames(db, "memories")).toContain("last_read_at");
  });

  it("schema_versionが8になる", () => {
    expect(getSchemaVersion(db)).toBe(7);
    migrateV7ToV8(db);
    expect(getSchemaVersion(db)).toBe(8);
  });

  it("既存行のlast_read_atは移行時刻でバックフィルされる（一括退避の構造的排除・rank1）", () => {
    seedRow(db, "a");
    seedRow(db, "b");

    migrateV7ToV8(db);

    const rows = db.prepare("SELECT id, last_read_at, updated_at FROM memories ORDER BY id").all() as {
      id: string;
      last_read_at: string | null;
      updated_at: string;
    }[];
    expect(rows.length).toBe(2);
    for (const r of rows) {
      // NULL のまま残さず、移行時刻を最終読取時刻の起点に置く（updated_at より新しい＝忘却窓の内側）。
      expect(r.last_read_at).not.toBeNull();
      expect(r.last_read_at! >= r.updated_at).toBe(true);
    }
  });

  it("last_read_at以外の既存カラム値は一切変化しない", () => {
    seedRow(db, "a");
    const before = db.prepare("SELECT * FROM memories WHERE id = 'a'").get() as MemoryRow;

    migrateV7ToV8(db);

    const after = db.prepare("SELECT * FROM memories WHERE id = 'a'").get() as MemoryRow;
    // last_read_at は新設列（移行時刻でバックフィルされる）なので比較対象から外し、
    // それ以外の全カラムが不変であることを確認する
    const { last_read_at: _beforeLra, ...beforeRest } = before;
    const { last_read_at: afterLra, ...afterRest } = after;
    expect(afterRest).toEqual(beforeRest);
    expect(afterLra).not.toBeNull();
  });

  it("再実行しても破壊しない（列存在チェックでスキップし、二重ALTERで落ちない・2回目はno-op）", () => {
    seedRow(db, "idem");
    migrateV7ToV8(db);

    // 1回目適用後に last_read_at を手で刻み、2回目実行がその値を潰さない（no-op）ことを確認する
    db.prepare("UPDATE memories SET last_read_at = '2026-05-05 12:00:00' WHERE id = 'idem'").run();

    expect(() => migrateV7ToV8(db)).not.toThrow();

    const cols = columnNames(db, "memories");
    expect(cols.filter((c) => c === "last_read_at").length).toBe(1);
    expect(getSchemaVersion(db)).toBe(8);

    const lra = (
      db.prepare("SELECT last_read_at FROM memories WHERE id = 'idem'").get() as {
        last_read_at: string;
      }
    ).last_read_at;
    expect(lra).toBe("2026-05-05 12:00:00");
  });
});
