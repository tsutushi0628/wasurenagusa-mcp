import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SQLiteStorage } from "./sqlite.js";
import type { MemoryCategory } from "../types.js";

function createMinimalV1Files(memoryPath: string): void {
  writeFileSync(
    join(memoryPath, "config.md"),
    `# Config Memory

---

## テスト設定

- **id**: auto-001
- **timestamp**: 2026-01-01T00:00:00+09:00
- **category**: config
- **tags**: test
- **content**: 自動マイグレーションテスト用エントリ

---

`,
  );

  writeFileSync(
    join(memoryPath, "dont.md"),
    `# Don't Memory

---

## テスト禁止事項

- **id**: auto-002
- **timestamp**: 2026-01-02T00:00:00+09:00
- **category**: dont
- **intensity**: 3
- **tags**: test
- **content**: テスト用dont

---

`,
  );
}

describe("TASK-023: マイグレーション自動判定", () => {
  let tmpDir: string;
  let memoryPath: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-auto-migration-"));
    memoryPath = join(tmpDir, ".wasurenagusa");
    dbPath = join(tmpDir, "memory.db");
    mkdirSync(memoryPath, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("DB未存在 + v1ファイル存在 → 自動マイグレーション実行", () => {
    createMinimalV1Files(memoryPath);
    expect(existsSync(dbPath)).toBe(false);

    const storage = new SQLiteStorage(dbPath);
    storage.initialize(memoryPath);

    // マイグレーションされたエントリが存在する
    const detail = storage.getDetail({ ids: ["auto-001", "auto-002"] });
    expect(detail.entries.length).toBe(2);
    expect(detail.entries.find(e => e.id === "auto-001")!.category).toBe("config");
    expect(detail.entries.find(e => e.id === "auto-002")!.category).toBe("dont");

    storage.close();
  });

  it("再initializeで二重マイグレーションされない（冪等性）", () => {
    createMinimalV1Files(memoryPath);

    const storage = new SQLiteStorage(dbPath);
    storage.initialize(memoryPath);

    // 1回目: 2件マイグレーション
    const search1 = storage.search({ query: "" });
    expect(search1.totalCount).toBe(2);

    storage.close();

    // 2回目: 同じDBで再initialize
    const storage2 = new SQLiteStorage(dbPath);
    storage2.initialize(memoryPath);

    const search2 = storage2.search({ query: "" });
    expect(search2.totalCount).toBe(2); // 件数が増えていない

    storage2.close();
  });

  it("v1ファイルなし → マイグレーションスキップ", () => {
    // memoryPathは空ディレクトリ（v1ファイルなし）
    const storage = new SQLiteStorage(dbPath);
    storage.initialize(memoryPath);

    const search = storage.search({ query: "" });
    expect(search.totalCount).toBe(0);

    storage.close();
  });

  it("memoryPath未指定 → マイグレーションスキップ（通常初期化のみ）", () => {
    createMinimalV1Files(memoryPath);

    const storage = new SQLiteStorage(dbPath);
    storage.initialize(); // memoryPathなし

    const search = storage.search({ query: "" });
    expect(search.totalCount).toBe(0);

    storage.close();
  });

  it("DB既存 + v1ファイル存在 → マイグレーションスキップ", () => {
    // 先にDBを作成（空のスキーマのみ）
    const storage1 = new SQLiteStorage(dbPath);
    storage1.initialize();
    // 手動で1件保存してDB既存を示す
    storage1.save({ category: "config", title: "既存", content: "既存エントリ" });
    storage1.close();

    // v1ファイルを配置
    createMinimalV1Files(memoryPath);

    // 再度initialize（DB既存なのでマイグレーション不要）
    const storage2 = new SQLiteStorage(dbPath);
    storage2.initialize(memoryPath);

    const search = storage2.search({ query: "" });
    // 既存の1件のみ、v1からの2件はマイグレーションされない
    expect(search.totalCount).toBe(1);

    storage2.close();
  });

  it("needsMigration() がDB状態を正しく判定する", () => {
    createMinimalV1Files(memoryPath);

    // DB新規: needsMigration = true（v1ファイル存在時）
    const storage = new SQLiteStorage(dbPath);
    storage.initialize(memoryPath);
    // 初期化後はマイグレーション済みなので false
    expect(storage.needsMigration(memoryPath)).toBe(false);

    storage.close();
  });

  it("v1スキーマDB（schema_version=1）を SQLiteStorage.initialize で v2 に自動移行する", async () => {
    // v1スキーマで DB を直接作成（CHECK制約 5値、knowledge_gap 無し、schema_version=1）
    const Database = (await import("better-sqlite3")).default;
    const rawDb = new Database(dbPath);
    rawDb.exec(`
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
      CREATE TABLE schema_version (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO schema_version (version) VALUES (1);
    `);
    rawDb.prepare(
      "INSERT INTO memories (id, timestamp, category, title, content) VALUES (?, ?, ?, ?, ?)"
    ).run("v1-pre-001", "2026-01-01T00:00:00+09:00", "dont", "v1既存", "v1で保存された");
    rawDb.close();

    // SQLiteStorage.initialize を通して自動移行
    const storage = new SQLiteStorage(dbPath);
    storage.initialize();

    // dream カテゴリで保存できる（CHECK制約が拡張済み）
    const dreamSave = storage.save({
      category: "dream" as MemoryCategory,
      title: "今夜の夢",
      content: "星空を歩いた",
    });
    expect(dreamSave.success).toBe(true);

    // success カテゴリで保存できる
    const successSave = storage.save({
      category: "success" as MemoryCategory,
      title: "効いた提案",
      content: "根拠ある反対意見が承認された",
    });
    expect(successSave.success).toBe(true);

    // v1 既存データが残っている
    const detail = storage.getDetail({ ids: ["v1-pre-001"] });
    expect(detail.entries.length).toBe(1);
    expect(detail.entries[0].category).toBe("dont");

    storage.close();
  });
});
