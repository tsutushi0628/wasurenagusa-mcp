import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SQLiteStorage } from "../storage/sqlite.js";
import { getSchemaVersion, CURRENT_SCHEMA_VERSION } from "../storage/schema.js";
import * as migration from "../storage/migration.js";

/**
 * A1: マイグレーションのatomicity（SQLiteStorage.initialize() のオーケストレーション経路）
 *
 * 検証する業務不変条件:
 *   - schema_version は「全スキーマ移行が throw せず完了したとき」だけ CURRENT になる。
 *     移行が途中で失敗したら version は CURRENT を騙らない（偽の「移行完了」マーカーを残さない）。
 *   - 失敗後の再起動で、列存在ゲートが未完のバックフィルを再実行し、消えていたデータが復旧して
 *     version が CURRENT に整合する。
 *   - 新規DBはバックフィルを一切走らせずに現行スキーマ + content_hash インデックス + version=CURRENT
 *     を原子確定する。
 *
 * 注入方式: 各migrateを単体呼びせず、実 SQLiteStorage.initialize() を通す（バグはオーケストレーション
 * 側にあるため）。1本のmigrate（migrateV7ToV8）だけを差し替え可能にし、必要なテストでのみ1回だけ
 * throw させて「バックフィルが失敗した」状況を実経路へ注入する。
 *
 * モック衛生: vi.mock はこのファイルのモジュールレジストリ内でのみ有効（vitest は
 * テストファイル単位でレジストリを分離するため他ファイルを汚染しない）。既定は実処理へ
 * passthrough し、throw はすべて mockImplementationOnce（1回で消費）で注入、afterEach で
 * 呼び出し履歴をクリアしてテスト間の相互汚染を避ける。各テストは固有の一時ファイルパスを使い
 * afterEach で削除する。
 */
vi.mock("../storage/migration.js", async (importActual) => {
  const actual = await importActual<typeof import("../storage/migration.js")>();
  // 既定の実装は実処理（actual）。mockImplementationOnce が消費されると自動でこの実処理へ戻る。
  return { ...actual, migrateV7ToV8: vi.fn(actual.migrateV7ToV8) };
});

function memColumns(db: Database.Database): string[] {
  return (db.prepare("PRAGMA table_info(memories)").all() as { name: string }[]).map((c) => c.name);
}

function tableExists(db: Database.Database, name: string): boolean {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name) !== undefined;
}

function indexExists(db: Database.Database, name: string): boolean {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?")
    .get(name) !== undefined;
}

function schemaVersionRowCount(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) as c FROM schema_version").get() as { c: number }).c;
}

describe("E2E: マイグレーションのatomicity（initialize()経由）", () => {
  let tmpDir: string;
  let memoryPath: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-atomicity-"));
    memoryPath = join(tmpDir, ".wasurenagusa");
    dbPath = join(tmpDir, "memory.db");
    mkdirSync(memoryPath, { recursive: true });
  });

  afterEach(() => {
    // 未消費の once 実装が残っていても次テストへ持ち越さないよう履歴と実装キューをクリアする
    // （既定の passthrough 実装は vi.fn(actual) として保持されるため復元不要）。
    vi.mocked(migration.migrateV7ToV8).mockClear();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // 旧世代DBの種: 正規経路でCURRENTまで作った後、raw接続で「last_read_at 欠落・version=7」へ退行させる
  // （v7→v8 のバックフィルがまだ走っていない旧DBの模擬）。last_read_at は index/trigger/FK に
  // 参照されないため DROP は安全（SQLite 3.51 で DROP COLUMN 実機確認済み）。
  function seedDegradedToV7WithRow(): void {
    const s = new SQLiteStorage(dbPath);
    s.initialize(memoryPath);
    s.save({ category: "log", title: "種となる記憶", content: "退行後も生き残るべき本文", tags: ["seed"] });
    s.close();

    const raw = new Database(dbPath);
    raw.exec("ALTER TABLE memories DROP COLUMN last_read_at");
    raw.exec("DELETE FROM schema_version");
    raw.prepare("INSERT INTO schema_version (version) VALUES (7)").run();
    raw.close();
  }

  it("T1: バックフィルが途中で失敗しても、再起動でデータが復旧しversion=CURRENTへ到達する（偽の移行完了マーカーを残さない）", () => {
    seedDegradedToV7WithRow();

    // 1回目: v7→v8 のバックフィルを1回だけ失敗させる（実経路への注入）。
    vi.mocked(migration.migrateV7ToV8).mockImplementationOnce(() => {
      throw new Error("injected v7->v8 backfill failure (run 1)");
    });
    const s1 = new SQLiteStorage(dbPath);
    expect(() => s1.initialize(memoryPath)).toThrow(/injected/);
    s1.close();

    // 失敗した起動が version=CURRENT を先行して騙っていないこと（この検査が修正前コードでは失敗する:
    // 旧 initializeSchema はバックフィル前に version=CURRENT を別コミットしていたため）。
    const mid = new Database(dbPath);
    expect(getSchemaVersion(mid)).toBe(7);
    expect(getSchemaVersion(mid)).toBeLessThan(CURRENT_SCHEMA_VERSION);
    mid.close();

    // 2回目: mockImplementationOnce は消費済み → 実処理へ復帰。列存在ゲートが未完のバックフィルを再実行する。
    const s2 = new SQLiteStorage(dbPath);
    s2.initialize(memoryPath); // throw しない
    s2.close();

    const raw = new Database(dbPath);
    // バックフィルされたデータが正しく充填されている（消えていた最終読取時刻が復旧）。
    expect(memColumns(raw)).toContain("last_read_at");
    const nullCount = (raw.prepare(
      "SELECT COUNT(*) as c FROM memories WHERE last_read_at IS NULL"
    ).get() as { c: number }).c;
    expect(nullCount).toBe(0);
    // 種の記憶が生き残っている。
    const seed = raw.prepare("SELECT content FROM memories WHERE title = ?").get("種となる記憶") as { content: string } | undefined;
    expect(seed?.content).toBe("退行後も生き残るべき本文");
    // 全移行完了後にのみ CURRENT へ整合している。
    expect(getSchemaVersion(raw)).toBe(CURRENT_SCHEMA_VERSION);
    raw.close();
  });

  it("T2: initialize()途中でバックフィルmigrateがthrowしたら、version は移行前のまま（CURRENTを騙らない）で元行も無傷", () => {
    seedDegradedToV7WithRow();

    vi.mocked(migration.migrateV7ToV8).mockImplementationOnce(() => {
      throw new Error("injected mid-chain migration failure");
    });

    const storage = new SQLiteStorage(dbPath);
    expect(() => storage.initialize(memoryPath)).toThrow(/injected/);
    storage.close();

    const raw = new Database(dbPath);
    // 偽の「移行完了」マーカーが立っていない: version は移行前の 7 のまま（修正前は先行昇格で 10 になる）。
    expect(getSchemaVersion(raw)).toBe(7);
    // migrateV7ToV8 は本テストでは関数まるごと mock で throw に差し替えているため、内部の
    // ALTER TABLE ADD COLUMN 自体が一度も実行されない。よって last_read_at 列が無いのは構造上
    // 当然であり、これは「トランザクションのロールバック（部分適用の巻き戻し）」の証明ではない。
    // ここで確認しているのは、失敗した移行が列を作り残していないこと（＝オーケストレーション経路が
    // 失敗migrateの後段列を先行生成しない）に限られる。実 migrate のトランザクション原子性
    // （ALTER 実行後の中断で列がロールバックされるか）は migration-v8.test.ts の専用ガードで検証する。
    expect(memColumns(raw)).not.toContain("last_read_at");
    // 元の行が無傷で残っている。
    const row = raw.prepare("SELECT title, content FROM memories WHERE title = ?").get("種となる記憶") as
      | { title: string; content: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.content).toBe("退行後も生き残るべき本文");
    raw.close();
  });

  it("T3: 新規（空）DBは、バックフィルを一切走らせずに現行スキーマ + content_hash インデックス + version=CURRENT を確定する", () => {
    const storage = new SQLiteStorage(dbPath);
    storage.initialize(memoryPath);
    storage.close();

    const raw = new Database(dbPath);
    // version=CURRENT に確定している。
    expect(getSchemaVersion(raw)).toBe(CURRENT_SCHEMA_VERSION);
    // 現行スキーマの主要テーブルが揃っている。
    for (const t of ["memories", "memories_fts", "vector_metadata", "schema_version", "lineage", "principles", "guards"]) {
      expect(tableExists(raw, t)).toBe(true);
    }
    // 現行形の列（後発マイグレーション列）が DDL で作り切られている。
    expect(memColumns(raw)).toEqual(expect.arrayContaining(["content_hash", "last_read_at", "state", "project_confidence"]));
    // content_hash 複合インデックスが作られている。
    expect(indexExists(raw, "idx_memories_content_hash")).toBe(true);
    // バックフィルを走らせずに到達したこと＝各 migrate 関数が中間 version（6..9）を書いていない。
    // 新規DBは initializeSchema が version=CURRENT を単一行で原子確定するため schema_version は1行だけ。
    expect(schemaVersionRowCount(raw)).toBe(1);
    raw.close();
  });
});
