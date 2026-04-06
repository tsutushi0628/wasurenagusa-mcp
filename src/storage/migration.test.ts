import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";
import { initializeSchema } from "./schema.js";
import { migrateV1ToV2 } from "./migration.js";

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
