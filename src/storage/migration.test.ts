import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";
import { initializeSchema, getSchemaVersion } from "./schema.js";
import { migrateV1ToV2, migrateV1ToV2_categoryAndKnowledgeGap, migrateV4ToV5 } from "./migration.js";

function createV1Files(memoryPath: string): void {
  // config.md
  writeFileSync(
    join(memoryPath, "config.md"),
    `# Config Memory

API URL、ポート、認証情報など、毎回参照すべき設定情報。

---

## ポート番号設定

- **id**: m1abc-0001
- **timestamp**: 2026-01-15T10:30:00+09:00
- **category**: config
- **project**: my-project
- **scope**: backend
- **tags**: port, config
- **content**: フロントエンドはポート3000、バックエンドはポート5001を使用

---

## API設定

- **id**: m1abc-0002
- **timestamp**: 2026-02-01T14:00:00+09:00
- **category**: config
- **tags**: api
- **content**: APIエンドポイントはhttps://api.example.com/v2

---

`,
  );

  // dont.md
  writeFileSync(
    join(memoryPath, "dont.md"),
    `# Don't Memory

やってはいけないこと、過去のミス、ユーザーが怒ったポイント。

---

## 本番DBに直接接続禁止

- **id**: m1abc-0003
- **timestamp**: 2026-01-20T09:00:00+09:00
- **category**: dont
- **project**: my-project
- **intensity**: 5
- **tags**: db, production
- **content**: 本番DBに直接接続してはいけない。必ずエミュレータを使う。

---

`,
  );

  // decisions.md
  writeFileSync(
    join(memoryPath, "decisions.md"),
    `# Decisions Memory

決定事項、採用した方針、技術選定の理由。

---

## React 19採用決定

- **id**: m1abc-0004
- **timestamp**: 2026-03-01T11:00:00+09:00
- **category**: decision
- **tags**: react, frontend
- **content**: React 19を採用。Server Componentsは使わない方針。

---

`,
  );

  // snippets.md
  writeFileSync(
    join(memoryPath, "snippets.md"),
    `# Snippets Memory

よく使うコマンド、クエリ、便利スクリプト。

---

## デプロイコマンド

- **id**: m1abc-0005
- **timestamp**: 2026-02-15T16:00:00+09:00
- **category**: snippet
- **scope**: infra
- **tags**: deploy, command
- **content**: firebase deploy --only functions

---

`,
  );

  // logs/
  const logsDir = join(memoryPath, "logs");
  mkdirSync(logsDir, { recursive: true });

  writeFileSync(
    join(logsDir, "2026-04-01.md"),
    `# Log: 2026-04-01

---

## デバッグセッション

- **id**: m1abc-0006
- **timestamp**: 2026-04-01T15:30:00+09:00
- **category**: log
- **project**: my-project
- **tags**: debug
- **content**: CSRFトークン問題をデバッグした。原因はクッキーのSameSite属性。

---

## レビュー実施

- **id**: m1abc-0007
- **timestamp**: 2026-04-01T17:00:00+09:00
- **category**: log
- **tags**: review
- **content**: PR #42のコードレビューを実施

---

`,
  );
}

function createVectorsJson(memoryPath: string): void {
  const vectorsData = {
    version: 1,
    entries: {
      "m1abc-0001": {
        embedding: Array.from({ length: 768 }, (_, i) => i * 0.001),
        accessCount: 5,
        createdAt: "2026-01-15T10:30:00+09:00",
        lastAccessedAt: "2026-04-01T10:00:00+09:00",
      },
      "m1abc-0003": {
        embedding: Array.from({ length: 768 }, (_, i) => i * 0.002),
        accessCount: 10,
        createdAt: "2026-01-20T09:00:00+09:00",
        lastAccessedAt: "2026-04-05T08:00:00+09:00",
      },
      "m1abc-9999": {
        // 存在しないエントリのベクトル（スキップされるべき）
        embedding: Array.from({ length: 768 }, () => 0),
        accessCount: 1,
        createdAt: "2026-01-01T00:00:00+09:00",
        lastAccessedAt: "2026-01-01T00:00:00+09:00",
      },
    },
  };
  writeFileSync(
    join(memoryPath, "vectors.json"),
    JSON.stringify(vectorsData),
  );
}

describe("migrateV1ToV2", () => {
  let tmpDir: string;
  let memoryPath: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-migration-test-"));
    memoryPath = join(tmpDir, ".wasurenagusa");
    mkdirSync(memoryPath, { recursive: true });

    db = new Database(join(tmpDir, "test.db"));
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("v1の全カテゴリのエントリがSQLiteに移行される", () => {
    createV1Files(memoryPath);

    const result = migrateV1ToV2(db, memoryPath);

    expect(result.entriesCount).toBe(7); // config:2 + dont:1 + decision:1 + snippet:1 + log:2
    expect(result.vectorMetadataCount).toBe(0); // vectors.jsonなし

    // 全エントリがmemoriesテーブルに存在することを確認
    const rows = db.prepare("SELECT * FROM memories ORDER BY id").all() as Array<{
      id: string; category: string; title: string; content: string;
      tags: string; project: string | null; scope: string | null; intensity: number | null;
      timestamp: string;
    }>;
    expect(rows.length).toBe(7);

    // config エントリの検証
    const config1 = rows.find(r => r.id === "m1abc-0001");
    expect(config1).toBeDefined();
    expect(config1!.category).toBe("config");
    expect(config1!.title).toBe("ポート番号設定");
    expect(config1!.content).toBe("フロントエンドはポート3000、バックエンドはポート5001を使用");
    expect(JSON.parse(config1!.tags)).toEqual(["port", "config"]);
    expect(config1!.project).toBe("my-project");
    expect(config1!.scope).toBe("backend");
    expect(config1!.timestamp).toBe("2026-01-15T10:30:00+09:00");

    // dont エントリの検証（intensity含む）
    const dont1 = rows.find(r => r.id === "m1abc-0003");
    expect(dont1).toBeDefined();
    expect(dont1!.category).toBe("dont");
    expect(dont1!.intensity).toBe(5);
    expect(dont1!.project).toBe("my-project");

    // decision エントリの検証
    const decision = rows.find(r => r.id === "m1abc-0004");
    expect(decision).toBeDefined();
    expect(decision!.category).toBe("decision");

    // snippet エントリの検証（scope含む）
    const snippet = rows.find(r => r.id === "m1abc-0005");
    expect(snippet).toBeDefined();
    expect(snippet!.scope).toBe("infra");

    // log エントリの検証
    const log1 = rows.find(r => r.id === "m1abc-0006");
    const log2 = rows.find(r => r.id === "m1abc-0007");
    expect(log1).toBeDefined();
    expect(log2).toBeDefined();
    expect(log1!.category).toBe("log");
  });

  it("FTS5インデックスが同期される（トリガー経由）", () => {
    createV1Files(memoryPath);

    migrateV1ToV2(db, memoryPath);

    // FTS5でキーワード検索できることを確認
    const ftsRows = db.prepare(`
      SELECT m.id FROM memories m
      INNER JOIN memories_fts fts ON m.rowid = fts.rowid
      WHERE memories_fts MATCH '"ポート"'
    `).all() as Array<{ id: string }>;

    expect(ftsRows.length).toBeGreaterThanOrEqual(1);
    expect(ftsRows.some(r => r.id === "m1abc-0001")).toBe(true);
  });

  it("vectors.jsonのメタデータのみ移行される（embeddingはスキップ）", () => {
    createV1Files(memoryPath);
    createVectorsJson(memoryPath);

    const result = migrateV1ToV2(db, memoryPath);

    // memoriesに存在するエントリのメタデータのみ移行
    // m1abc-0001, m1abc-0003 は存在、m1abc-9999 は存在しないのでスキップ
    expect(result.vectorMetadataCount).toBe(2);

    // vector_metadataテーブルの検証
    const metadata = db.prepare("SELECT * FROM vector_metadata ORDER BY id").all() as Array<{
      id: string; access_count: number; created_at: string; last_accessed_at: string;
    }>;
    expect(metadata.length).toBe(2);

    const meta1 = metadata.find(m => m.id === "m1abc-0001");
    expect(meta1).toBeDefined();
    expect(meta1!.access_count).toBe(5);

    const meta3 = metadata.find(m => m.id === "m1abc-0003");
    expect(meta3).toBeDefined();
    expect(meta3!.access_count).toBe(10);
  });

  it("vectors.jsonが存在しない場合もエラーにならない", () => {
    createV1Files(memoryPath);

    const result = migrateV1ToV2(db, memoryPath);

    expect(result.entriesCount).toBe(7);
    expect(result.vectorMetadataCount).toBe(0);
  });

  it("全体がトランザクションで実行される（エラー時にロールバック）", () => {
    createV1Files(memoryPath);

    // memoriesテーブルを壊してマイグレーション失敗を引き起こす
    const brokenDb = new Database(join(tmpDir, "broken.db"));
    initializeSchema(brokenDb);
    brokenDb.exec("DROP TABLE memories");

    expect(() => migrateV1ToV2(brokenDb, memoryPath)).toThrow();

    brokenDb.close();
  });

  it("v1ファイルが空・存在しない場合は0件で完了する", () => {
    // memoryPathにファイルを作らない（空ディレクトリ）

    const result = migrateV1ToV2(db, memoryPath);

    expect(result.entriesCount).toBe(0);
    expect(result.vectorMetadataCount).toBe(0);
  });

  it("memoryPathが存在しない場合はエラーにならず0件で完了する", () => {
    const nonexistentPath = join(tmpDir, "nonexistent-dir");

    const result = migrateV1ToV2(db, nonexistentPath);

    expect(result.entriesCount).toBe(0);
    expect(result.vectorMetadataCount).toBe(0);
  });

  it("重複IDのエントリは1件だけ移行される", () => {
    writeFileSync(
      join(memoryPath, "config.md"),
      `# Config Memory

---

## 設定A

- **id**: dup-001
- **timestamp**: 2026-01-01T00:00:00+09:00
- **category**: config
- **tags**: a
- **content**: 内容A

---

## 設定B（重複ID）

- **id**: dup-001
- **timestamp**: 2026-01-02T00:00:00+09:00
- **category**: config
- **tags**: b
- **content**: 内容B

---

`,
    );

    const result = migrateV1ToV2(db, memoryPath);

    // パーサーが2件返すが、INSERT OR IGNOREで重複は無視
    expect(result.entriesCount).toBe(1);
  });
});

// ============================================================
// マイグレーション v1→v2: CHECK制約拡張 + knowledge_gap カラム追加
// （heart-extension spec M1）
// ============================================================
describe("migrateV1ToV2_categoryAndKnowledgeGap", () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-migration-v2-test-"));
    db = new Database(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createV1Schema(): void {
    // 旧スキーマ（v1相当: CHECK制約 5値、knowledge_gap カラムなし）を直接作成
    db.exec(`
      CREATE TABLE memories (
          id TEXT PRIMARY KEY,
          timestamp TEXT NOT NULL,
          category TEXT NOT NULL CHECK(category IN ('config','dont','decision','log','snippet')),
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          tags TEXT NOT NULL DEFAULT '[]',
          project TEXT,
          scope TEXT,
          intensity INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_memories_category ON memories(category);
      CREATE INDEX idx_memories_project ON memories(project);
      CREATE INDEX idx_memories_timestamp ON memories(timestamp DESC);
      CREATE VIRTUAL TABLE memories_fts USING fts5(
          title, content, tags,
          content=memories,
          content_rowid=rowid,
          tokenize='trigram'
      );
      CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, title, content, tags)
          VALUES (new.rowid, new.title, new.content, new.tags);
      END;
      CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, title, content, tags)
          VALUES ('delete', old.rowid, old.title, old.content, old.tags);
      END;
      CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, title, content, tags)
          VALUES ('delete', old.rowid, old.title, old.content, old.tags);
          INSERT INTO memories_fts(rowid, title, content, tags)
          VALUES (new.rowid, new.title, new.content, new.tags);
      END;
      CREATE TABLE schema_version (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO schema_version (version) VALUES (1);
    `);
  }

  it("v1スキーマ（5値CHECK制約・knowledge_gap無し）を v2 へ移行する", () => {
    createV1Schema();

    // v1既存データを投入
    db.prepare(
      "INSERT INTO memories (id, timestamp, category, title, content, tags, intensity) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("v1-001", "2026-01-01T00:00:00+09:00", "dont", "本番DB禁止", "本番に直接接続するな", JSON.stringify(["db"]), 5);

    migrateV1ToV2_categoryAndKnowledgeGap(db);

    // 既存データが保持されている
    const row = db.prepare("SELECT * FROM memories WHERE id = ?").get("v1-001") as {
      id: string; category: string; title: string; intensity: number; knowledge_gap: string | null;
    };
    expect(row.id).toBe("v1-001");
    expect(row.category).toBe("dont");
    expect(row.intensity).toBe(5);
    expect(row.knowledge_gap).toBeNull();
  });

  it("CHECK制約に dream / success が含まれる（v2拡張）", () => {
    createV1Schema();
    migrateV1ToV2_categoryAndKnowledgeGap(db);

    // dream カテゴリで挿入できる
    expect(() => {
      db.prepare(
        "INSERT INTO memories (id, timestamp, category, title, content) VALUES (?, ?, ?, ?, ?)"
      ).run("dream-001", "2026-05-02T03:00:00+09:00", "dream", "夢タイトル", "夢の本文");
    }).not.toThrow();

    // success カテゴリで挿入できる
    expect(() => {
      db.prepare(
        "INSERT INTO memories (id, timestamp, category, title, content) VALUES (?, ?, ?, ?, ?)"
      ).run("success-001", "2026-05-02T10:00:00+09:00", "success", "成功タイトル", "成功本文");
    }).not.toThrow();

    // 不正カテゴリは弾かれる
    expect(() => {
      db.prepare(
        "INSERT INTO memories (id, timestamp, category, title, content) VALUES (?, ?, ?, ?, ?)"
      ).run("bad-001", "2026-05-02T10:00:00+09:00", "invalid", "x", "x");
    }).toThrow();
  });

  it("knowledge_gap カラムが追加され、JSON配列文字列を保存できる", () => {
    createV1Schema();
    migrateV1ToV2_categoryAndKnowledgeGap(db);

    const gapJson = JSON.stringify(["Gemini APIのfinishReason種類", "max_tokensの上限"]);
    db.prepare(
      "INSERT INTO memories (id, timestamp, category, title, content, knowledge_gap) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("kg-001", "2026-05-02T11:00:00+09:00", "dont", "知識穴あり", "失敗内容", gapJson);

    const row = db.prepare("SELECT knowledge_gap FROM memories WHERE id = ?").get("kg-001") as { knowledge_gap: string };
    expect(JSON.parse(row.knowledge_gap)).toEqual(["Gemini APIのfinishReason種類", "max_tokensの上限"]);
  });

  it("FTS5 トリガーが再作成され v2 でも全文検索が動く", () => {
    createV1Schema();
    db.prepare(
      "INSERT INTO memories (id, timestamp, category, title, content, tags) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("v1-002", "2026-01-02T00:00:00+09:00", "config", "ポート設定", "フロントは3000、バックは5001", "[]");

    migrateV1ToV2_categoryAndKnowledgeGap(db);

    // 移行後に新規挿入したエントリも FTS5 でヒットする（trigram は3文字以上必要）
    db.prepare(
      "INSERT INTO memories (id, timestamp, category, title, content, tags) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("v2-001", "2026-05-02T00:00:00+09:00", "dream", "夢のタイトル", "今夜は流れ星を見た夢", "[]");

    const ftsRows = db.prepare(`
      SELECT m.id FROM memories m
      INNER JOIN memories_fts fts ON m.rowid = fts.rowid
      WHERE memories_fts MATCH '"流れ星"'
    `).all() as { id: string }[];

    expect(ftsRows.some(r => r.id === "v2-001")).toBe(true);

    // 移行前から存在していたエントリも FTS5 でヒットする
    const ftsRowsOld = db.prepare(`
      SELECT m.id FROM memories m
      INNER JOIN memories_fts fts ON m.rowid = fts.rowid
      WHERE memories_fts MATCH '"ポート"'
    `).all() as { id: string }[];

    expect(ftsRowsOld.some(r => r.id === "v1-002")).toBe(true);
  });

  it("schema_version が 2 に更新される", () => {
    createV1Schema();
    expect(getSchemaVersion(db)).toBe(1);

    migrateV1ToV2_categoryAndKnowledgeGap(db);

    expect(getSchemaVersion(db)).toBe(2);
  });

  it("再実行しても破壊しない（冪等）", () => {
    createV1Schema();
    db.prepare(
      "INSERT INTO memories (id, timestamp, category, title, content) VALUES (?, ?, ?, ?, ?)"
    ).run("idem-001", "2026-01-01T00:00:00+09:00", "dont", "title", "content");

    migrateV1ToV2_categoryAndKnowledgeGap(db);
    // 2回目: schema_version が既に 2 なのでスキップされる
    migrateV1ToV2_categoryAndKnowledgeGap(db);

    const row = db.prepare("SELECT id FROM memories WHERE id = ?").get("idem-001") as { id: string };
    expect(row.id).toBe("idem-001");

    const count = db.prepare("SELECT COUNT(*) as count FROM memories").get() as { count: number };
    expect(count.count).toBe(1);
  });

  it("既に v2 のスキーマ（schema_version=2）には適用されない", () => {
    // v2想定: schema.ts の最新DDLで初期化（CURRENT_SCHEMA_VERSION=2 想定）
    initializeSchema(db);
    // initializeSchema 後は CURRENT_SCHEMA_VERSION（v2想定）に更新されている

    // 何かデータを入れる
    db.prepare(
      "INSERT INTO memories (id, timestamp, category, title, content, knowledge_gap) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("v2-pre-001", "2026-05-02T00:00:00+09:00", "dont", "title", "content", JSON.stringify(["x"]));

    expect(() => migrateV1ToV2_categoryAndKnowledgeGap(db)).not.toThrow();

    const row = db.prepare("SELECT knowledge_gap FROM memories WHERE id = ?").get("v2-pre-001") as { knowledge_gap: string };
    expect(JSON.parse(row.knowledge_gap)).toEqual(["x"]);
  });

  it("マイグレーション失敗時はトランザクションでロールバックされる", () => {
    createV1Schema();
    db.prepare(
      "INSERT INTO memories (id, timestamp, category, title, content) VALUES (?, ?, ?, ?, ?)"
    ).run("rb-001", "2026-01-01T00:00:00+09:00", "dont", "title", "content");

    // 故意に失敗させる：memories_new と同名のテーブルを先に作って衝突させる
    db.exec("CREATE TABLE memories_new (broken TEXT)");

    expect(() => migrateV1ToV2_categoryAndKnowledgeGap(db)).toThrow();

    // 元 memories テーブルは健在
    const row = db.prepare("SELECT id FROM memories WHERE id = ?").get("rb-001") as { id: string } | undefined;
    expect(row?.id).toBe("rb-001");
    // schema_version は v1 のまま
    expect(getSchemaVersion(db)).toBe(1);
  });
});

// ============================================================
// マイグレーション v4→v5: 予測誤差ループの4カラム追加
// ============================================================
describe("migrateV4ToV5", () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-migration-v5-test-"));
    db = new Database(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // v4相当スキーマ（予測4カラム無し）を直接作る
  function createV4Schema(): void {
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
          deleted_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE schema_version (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO schema_version (version) VALUES (4);
    `);
  }

  function columnNames(): string[] {
    return (db.prepare("PRAGMA table_info('memories')").all() as Array<{ name: string }>)
      .map((r) => r.name);
  }

  it("v4スキーマに予測4カラムが追加され schema_version=5 になる", () => {
    createV4Schema();
    expect(getSchemaVersion(db)).toBe(4);

    migrateV4ToV5(db);

    const cols = columnNames();
    expect(cols).toContain("predicted_factors");
    expect(cols).toContain("actual_factors");
    expect(cols).toContain("prediction_error");
    expect(cols).toContain("prediction_delta");
    expect(getSchemaVersion(db)).toBe(5);
  });

  it("既存v4データ（予測フィールド無し）は無害に保持される", () => {
    createV4Schema();
    db.prepare(
      "INSERT INTO memories (id, timestamp, category, title, content) VALUES (?, ?, ?, ?, ?)"
    ).run("old-001", "2026-01-01T00:00:00+09:00", "log", "旧データ", "本文");

    migrateV4ToV5(db);

    const row = db.prepare("SELECT * FROM memories WHERE id = ?").get("old-001") as {
      id: string; predicted_factors: string | null; prediction_error: number | null;
    };
    expect(row.id).toBe("old-001");
    expect(row.predicted_factors).toBeNull();
    expect(row.prediction_error).toBeNull();
  });

  it("追加後は予測4カラムに値を保存できる", () => {
    createV4Schema();
    migrateV4ToV5(db);

    db.prepare(
      "INSERT INTO memories (id, timestamp, category, title, content, predicted_factors, actual_factors, prediction_error, prediction_delta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "pe-001", "2026-06-30T00:00:00+09:00", "log", "見立てズレ", "本文",
      JSON.stringify(["auth"]), JSON.stringify(["db", "auth"]), 0.5, "認証だと思ったらDBだった"
    );

    const row = db.prepare("SELECT * FROM memories WHERE id = ?").get("pe-001") as {
      predicted_factors: string; actual_factors: string; prediction_error: number; prediction_delta: string;
    };
    expect(JSON.parse(row.predicted_factors)).toEqual(["auth"]);
    expect(JSON.parse(row.actual_factors)).toEqual(["db", "auth"]);
    expect(row.prediction_error).toBe(0.5);
    expect(row.prediction_delta).toBe("認証だと思ったらDBだった");
  });

  it("再実行しても破壊しない（冪等：カラム存在チェックで2回目はスキップ）", () => {
    createV4Schema();

    migrateV4ToV5(db);
    // 2回目を呼んでも例外を投げない（重複ALTERにならない）
    expect(() => migrateV4ToV5(db)).not.toThrow();

    const cols = columnNames();
    // カラムは重複追加されず4つのまま
    expect(cols.filter((c) => c === "predicted_factors").length).toBe(1);
    expect(getSchemaVersion(db)).toBe(5);
  });

  it("最新スキーマ（initializeSchema）には無害適用される", () => {
    initializeSchema(db);
    // 最新DDLには既に予測4カラムが含まれるため、ALTERはスキップされる
    expect(() => migrateV4ToV5(db)).not.toThrow();
    const cols = columnNames();
    expect(cols).toContain("prediction_error");
  });
});
