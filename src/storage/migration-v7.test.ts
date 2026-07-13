import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";
import { getSchemaVersion } from "./schema.js";
import { migrateV6ToV7 } from "./migration.js";
import { computeContentHash } from "./content-hash.js";

// v6相当スキーマ（content_hash無し）を直接作る。
// state/project_confidenceはHEAD時点で既に存在する（タスク0.0のv6ベースライン）。
function createV6Schema(db: Database.Database): void {
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
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE vector_metadata (
        id TEXT PRIMARY KEY,
        access_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_accessed_at TEXT NOT NULL DEFAULT (datetime('now')),
        embedding_model TEXT NOT NULL DEFAULT 'Xenova/multilingual-e5-small'
    );
    CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO schema_version (version) VALUES (6);
  `);
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).map(
    (r) => r.name,
  );
}

interface MemoryRow {
  id: string;
  project: string | null;
  scope: string | null;
  category: string;
  title: string;
  content: string;
  content_hash: string | null;
}

// 同一project/scope/category/title/contentの重複行をcount件、id違いのみでINSERTする
// （ハードUNIQUE制約が無いことを前提にした重複投入。既存重複下でmigrateV6ToV7が
// 落ちないことの固定化がタスク11相当の残課題）。
function insertDuplicateRows(
  db: Database.Database,
  count: number,
  idPrefix: string,
  fields: { project: string; scope: string; category: string; title: string; content: string },
): void {
  const insertStmt = db.prepare(
    "INSERT INTO memories (id, timestamp, category, title, content, project, scope) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const insertMany = db.transaction((n: number) => {
    for (let i = 0; i < n; i++) {
      insertStmt.run(
        `${idPrefix}-${String(i).padStart(4, "0")}`,
        "2026-01-01T00:00:00+09:00",
        fields.category,
        fields.title,
        fields.content,
        fields.project,
        fields.scope,
      );
    }
  });
  insertMany(count);
}

describe("migrateV6ToV7", () => {
  let tmpDir: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-migration-v7-test-"));
    mkdirSync(tmpDir, { recursive: true });
    dbPath = join(tmpDir, "memory.db");
    db = new Database(dbPath);
    createV6Schema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("memoriesにcontent_hash列が追加される", () => {
    migrateV6ToV7(db);

    const memCols = columnNames(db, "memories");
    expect(memCols).toContain("content_hash");
  });

  it("schema_versionが7になる", () => {
    expect(getSchemaVersion(db)).toBe(6);
    migrateV6ToV7(db);
    expect(getSchemaVersion(db)).toBe(7);
  });

  it("同一project/scope/category/title/contentの重複行が590件規模で存在してもthrowせず完走する", () => {
    insertDuplicateRows(db, 590, "dup", {
      project: "shared-project",
      scope: "shared-scope",
      category: "log",
      title: "重複タイトル",
      content: "重複本文",
    });

    expect(() => migrateV6ToV7(db)).not.toThrow();

    const count = (db.prepare("SELECT COUNT(*) as cnt FROM memories").get() as { cnt: number }).cnt;
    expect(count).toBe(590);
    expect(getSchemaVersion(db)).toBe(7);
  });

  it("実行後、全行のcontent_hashがcomputeContentHashと一致し、重複行同士は同一ハッシュを共有する", () => {
    insertDuplicateRows(db, 590, "dup", {
      project: "shared-project",
      scope: "shared-scope",
      category: "log",
      title: "重複タイトル",
      content: "重複本文",
    });
    // 別内容の対照行（重複ハッシュに巻き込まれていないことの確認用）
    db.prepare(
      "INSERT INTO memories (id, timestamp, category, title, content, project, scope) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("solo-001", "2026-01-01T00:00:00+09:00", "decision", "単独タイトル", "単独本文", "other-project", null);

    migrateV6ToV7(db);

    const rows = db.prepare(
      "SELECT id, project, scope, category, title, content, content_hash FROM memories",
    ).all() as MemoryRow[];

    expect(rows.length).toBe(591);

    // 全行: content_hashがcomputeContentHashの再計算結果と一致する
    for (const row of rows) {
      const expected = computeContentHash({
        project: row.project ?? undefined,
        scope: row.scope ?? undefined,
        category: row.category,
        title: row.title,
        content: row.content,
      });
      expect(row.content_hash).toBe(expected);
    }

    // 重複590件は同一ハッシュを共有する
    const dupHashes = new Set(rows.filter((r) => r.id.startsWith("dup-")).map((r) => r.content_hash));
    expect(dupHashes.size).toBe(1);

    // 対照行は重複グループとハッシュが異なる
    const soloHash = rows.find((r) => r.id === "solo-001")?.content_hash;
    const [sharedDupHash] = Array.from(dupHashes);
    expect(soloHash).not.toBe(sharedDupHash);
  });

  it("再実行しても破壊しない（列存在チェックでスキップし、二重ALTERで落ちない）", () => {
    db.prepare(
      "INSERT INTO memories (id, timestamp, category, title, content, project, scope) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("idem-001", "2026-01-01T00:00:00+09:00", "log", "タイトル", "本文", "p", "s");

    migrateV6ToV7(db);
    const firstHash = (
      db.prepare("SELECT content_hash FROM memories WHERE id = ?").get("idem-001") as {
        content_hash: string;
      }
    ).content_hash;

    expect(() => migrateV6ToV7(db)).not.toThrow();

    const memCols = columnNames(db, "memories");
    expect(memCols.filter((c) => c === "content_hash").length).toBe(1);
    expect(getSchemaVersion(db)).toBe(7);

    const secondHash = (
      db.prepare("SELECT content_hash FROM memories WHERE id = ?").get("idem-001") as {
        content_hash: string;
      }
    ).content_hash;
    expect(secondHash).toBe(firstHash);
  });
});
