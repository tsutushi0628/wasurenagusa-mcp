import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";
import { getSchemaVersion } from "./schema.js";
import { migrateV5ToV6 } from "./migration.js";

// v5相当スキーマ（state/project_confidence/embedding_model無し）を直接作る。
// 予測誤差ループの4カラムとdeleted_atはHEAD時点で既に存在する（タスク0.0のv5ベースライン）。
function createV5Schema(db: Database.Database): void {
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
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE vector_metadata (
        id TEXT PRIMARY KEY,
        access_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_accessed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO schema_version (version) VALUES (5);
  `);
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).map(
    (r) => r.name,
  );
}

describe("migrateV5ToV6", () => {
  let tmpDir: string;
  let memoryPath: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-migration-v6-test-"));
    memoryPath = join(tmpDir, ".wasurenagusa");
    dbPath = join(memoryPath, "memory.db");
    mkdirSync(memoryPath, { recursive: true });
    db = new Database(dbPath);
    createV5Schema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("memoriesにstateとproject_confidence列が追加され、vector_metadataにembedding_model列が追加される", () => {
    migrateV5ToV6(db, memoryPath);

    const memCols = columnNames(db, "memories");
    expect(memCols).toContain("state");
    expect(memCols).toContain("project_confidence");

    const vecCols = columnNames(db, "vector_metadata");
    expect(vecCols).toContain("embedding_model");
  });

  it("schema_versionが6になる", () => {
    expect(getSchemaVersion(db)).toBe(5);
    migrateV5ToV6(db, memoryPath);
    expect(getSchemaVersion(db)).toBe(6);
  });

  it("既存行のstateがdeleted_atから正しくバックフィルされる（NULL→active、非NULL→deleted）", () => {
    db.prepare(
      "INSERT INTO memories (id, timestamp, category, title, content) VALUES (?, ?, ?, ?, ?)",
    ).run("alive-001", "2026-01-01T00:00:00+09:00", "log", "生存エントリ", "本文");
    db.prepare(
      "INSERT INTO memories (id, timestamp, category, title, content, deleted_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("dead-001", "2026-01-01T00:00:00+09:00", "log", "削除済みエントリ", "本文", "2026-02-01T00:00:00+09:00");

    migrateV5ToV6(db, memoryPath);

    const rows = db.prepare("SELECT id, state FROM memories ORDER BY id").all() as Array<{
      id: string;
      state: string;
    }>;
    expect(rows.find((r) => r.id === "alive-001")?.state).toBe("active");
    expect(rows.find((r) => r.id === "dead-001")?.state).toBe("deleted");
  });

  it("project_confidenceは既定でunknownになる", () => {
    db.prepare(
      "INSERT INTO memories (id, timestamp, category, title, content) VALUES (?, ?, ?, ?, ?)",
    ).run("pc-001", "2026-01-01T00:00:00+09:00", "log", "タイトル", "本文");

    migrateV5ToV6(db, memoryPath);

    const row = db.prepare("SELECT project_confidence FROM memories WHERE id = ?").get("pc-001") as {
      project_confidence: string;
    };
    expect(row.project_confidence).toBe("unknown");
  });

  it("既存のvector_metadata行のembedding_modelが現行モデル識別子でバックフィルされる", () => {
    db.prepare(
      "INSERT INTO vector_metadata (id, access_count) VALUES (?, ?)",
    ).run("vec-001", 3);

    migrateV5ToV6(db, memoryPath);

    const row = db.prepare("SELECT embedding_model FROM vector_metadata WHERE id = ?").get("vec-001") as {
      embedding_model: string;
    };
    expect(row.embedding_model).toBeTruthy();
    expect(typeof row.embedding_model).toBe("string");
  });

  it("state列にCHECK制約があり不正値はrejectされる", () => {
    migrateV5ToV6(db, memoryPath);

    db.prepare(
      "INSERT INTO memories (id, timestamp, category, title, content) VALUES (?, ?, ?, ?, ?)",
    ).run("chk-001", "2026-01-01T00:00:00+09:00", "log", "タイトル", "本文");

    expect(() => {
      db.prepare("UPDATE memories SET state = ? WHERE id = ?").run("bogus", "chk-001");
    }).toThrow();
  });

  it("project_confidence列にCHECK制約があり不正値はrejectされる", () => {
    migrateV5ToV6(db, memoryPath);

    db.prepare(
      "INSERT INTO memories (id, timestamp, category, title, content) VALUES (?, ?, ?, ?, ?)",
    ).run("chk-002", "2026-01-01T00:00:00+09:00", "log", "タイトル", "本文");

    expect(() => {
      db.prepare("UPDATE memories SET project_confidence = ? WHERE id = ?").run("bogus", "chk-002");
    }).toThrow();
  });

  it("移行前にバックアップファイルが作られる", () => {
    migrateV5ToV6(db, memoryPath);

    const backupDir = join(memoryPath, "migration-backups");
    expect(existsSync(backupDir)).toBe(true);
    const files = readdirSync(backupDir).filter((f) => f.startsWith("pre-v6-migration-") && f.endsWith(".db"));
    expect(files.length).toBeGreaterThanOrEqual(1);
  });

  it("バックアップに失敗する場合は移行が中止される（memoryPathが書き込み不能）", () => {
    // memoryPathとして存在しないディレクトリの奥（作成不能な深さではなく、意図的に
    // ファイルをディレクトリ名に使って mkdir を失敗させる）を渡す
    const bogusMemoryPath = join(tmpDir, "not-a-directory-marker-file");
    writeFileSync(bogusMemoryPath, "not a directory");

    expect(() => migrateV5ToV6(db, bogusMemoryPath)).toThrow();

    // 移行が中止されたのでschema_versionは5のまま
    expect(getSchemaVersion(db)).toBe(5);
    const memCols = columnNames(db, "memories");
    expect(memCols).not.toContain("state");
  });

  it("再実行しても破壊しない（冪等）", () => {
    db.prepare(
      "INSERT INTO memories (id, timestamp, category, title, content) VALUES (?, ?, ?, ?, ?)",
    ).run("idem-001", "2026-01-01T00:00:00+09:00", "log", "タイトル", "本文");

    migrateV5ToV6(db, memoryPath);
    expect(() => migrateV5ToV6(db, memoryPath)).not.toThrow();

    const memCols = columnNames(db, "memories");
    expect(memCols.filter((c) => c === "state").length).toBe(1);
    expect(getSchemaVersion(db)).toBe(6);

    const row = db.prepare("SELECT id FROM memories WHERE id = ?").get("idem-001") as { id: string };
    expect(row.id).toBe("idem-001");
  });

  it("移行後も既存データが保持される", () => {
    db.prepare(
      "INSERT INTO memories (id, timestamp, category, title, content, project, intensity) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("keep-001", "2026-01-01T00:00:00+09:00", "dont", "既存タイトル", "既存本文", "my-project", 5);

    migrateV5ToV6(db, memoryPath);

    const row = db.prepare("SELECT * FROM memories WHERE id = ?").get("keep-001") as {
      title: string;
      content: string;
      project: string;
      intensity: number;
    };
    expect(row.title).toBe("既存タイトル");
    expect(row.content).toBe("既存本文");
    expect(row.project).toBe("my-project");
    expect(row.intensity).toBe(5);
  });

  it("vector_metadataがembedding_model込みで既に新規作成されていても二重ALTERで失敗しない（initializeSchemaのCREATE TABLE IF NOT EXISTS経由での先行作成を模す）", () => {
    // vector_metadataをドロップし、embedding_model列込みの最新DDL相当で再作成する
    // （initializeSchema()がmigrateV5ToV6より先に走り、vector_metadataがまだ無かった
    // ケースで新規作成される状況を再現する）。
    db.exec("DROP TABLE vector_metadata");
    db.exec(`
      CREATE TABLE vector_metadata (
          id TEXT PRIMARY KEY,
          access_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_accessed_at TEXT NOT NULL DEFAULT (datetime('now')),
          embedding_model TEXT NOT NULL DEFAULT 'Xenova/multilingual-e5-small'
      );
    `);

    expect(() => migrateV5ToV6(db, memoryPath)).not.toThrow();

    const vecCols = columnNames(db, "vector_metadata");
    expect(vecCols.filter((c) => c === "embedding_model").length).toBe(1);
    expect(getSchemaVersion(db)).toBe(6);
  });
});
