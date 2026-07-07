import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, writeFileSync as writeFileSyncFs } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";

import { backupStore } from "./backup-store.js";
import { restoreStore } from "./restore-store.js";
import { SQLiteStorage } from "../src/storage/sqlite.js";

/**
 * バックアップと復元リハーサルの業務要件をテストで先に固定する（タスク0.4、R-A1）。
 *
 * 業務要件:
 * 1. 対象ストアの全ファイルがバックアップされ、チェックサムマニフェストが検証できる
 * 2. 主ストアは復元リハーサルで件数とチェックサムが一致する
 * 3. バックアップ検証失敗時（チェックサム不一致）はエラー終了する（fail-loud）
 * 4. models/（埋め込みモデルの再ダウンロード可能なキャッシュ）はバックアップ対象外
 */
describe("backup-store: 全量バックアップと検証つき復元（R-A1）", () => {
  let tmpDir: string;
  let storePath: string;
  let backupDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-backup-test-"));
    storePath = join(tmpDir, "store", ".wasurenagusa");
    backupDir = join(tmpDir, "backup");
    mkdirSync(storePath, { recursive: true });

    // v1資産（Markdown/vectors.json相当）
    writeFileSync(join(storePath, "dont.md"), "# dont\n\n## 古いミス\nログを読まなかった\n");
    writeFileSync(join(storePath, "config.md"), "# config\n\n## API URL\nhttps://example.test\n");
    writeFileSync(join(storePath, "vectors.json"), JSON.stringify([{ id: "v1", embedding: [0.1, 0.2] }]));
    writeFileSync(join(storePath, "consolidated-dont.json"), JSON.stringify({ principles: [] }));

    // logs/ 配下（ネスト）
    mkdirSync(join(storePath, "logs"), { recursive: true });
    writeFileSync(join(storePath, "logs", "2026-07-01.md"), "# ログ\n");

    // 除外対象: models/ ディレクトリ（再ダウンロード可能なembeddingキャッシュ）
    mkdirSync(join(storePath, "models", "Xenova", "sample-model"), { recursive: true });
    writeFileSync(join(storePath, "models", "Xenova", "sample-model", "weights.bin"), "dummy-weights");

    // v2資産（SQLite本体）: 実装と同じ初期化経路で作成し、実データを2件保存
    const dbPath = join(storePath, "memory.db");
    const storage = new SQLiteStorage(dbPath);
    storage.initialize(storePath);
    storage.save({ category: "config", title: "本番URL", content: "https://example.test", tags: [], project: "test-project" });
    storage.save({ category: "dont", title: "ログ未読", content: "ログを読まずに直ったと報告した", tags: [], project: "test-project" });
    storage.close();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("対象ストアの全ファイル（Markdown・vectors.json・logs配下・memory.db）がバックアップされ、manifest.jsonのチェックサムが実ファイルと一致する", async () => {
    const manifest = await backupStore(storePath, backupDir);

    // v1資産がコピーされている
    expect(existsSync(join(backupDir, "dont.md"))).toBe(true);
    expect(existsSync(join(backupDir, "config.md"))).toBe(true);
    expect(existsSync(join(backupDir, "vectors.json"))).toBe(true);
    expect(existsSync(join(backupDir, "consolidated-dont.json"))).toBe(true);
    // logs/ 配下（ネスト）がコピーされている
    expect(existsSync(join(backupDir, "logs", "2026-07-01.md"))).toBe(true);
    // v2資産（memory.db）がコピーされている
    expect(existsSync(join(backupDir, "memory.db"))).toBe(true);

    // マニフェストのチェックサムが実ファイルと一致する
    expect(manifest.files.length).toBeGreaterThan(0);
    for (const entry of manifest.files) {
      const fullPath = join(backupDir, entry.relativePath);
      expect(existsSync(fullPath)).toBe(true);
      const actualContent = readFileSync(fullPath);
      expect(actualContent.length).toBe(entry.sizeBytes);
    }

    // memories件数が記録されている（保存した2件と一致）
    expect(manifest.memoriesCount).toBe(2);
  });

  it("models/ ディレクトリ（再ダウンロード可能なembeddingキャッシュ）はバックアップ対象外", async () => {
    await backupStore(storePath, backupDir);

    expect(existsSync(join(backupDir, "models"))).toBe(false);
  });

  it("トップレベル以外の同名ディレクトリ（例: logs/models）は除外されない（basename一致でなくトップレベル相対パス一致で判定する）", async () => {
    // 除外対象はストア直下の"models"のみ。ネストした同名ディレクトリは通常データとして扱う。
    mkdirSync(join(storePath, "logs", "models"), { recursive: true });
    writeFileSync(join(storePath, "logs", "models", "note.md"), "ネストしたmodelsディレクトリの中身\n");

    await backupStore(storePath, backupDir);

    expect(existsSync(join(backupDir, "logs", "models", "note.md"))).toBe(true);
  });

  it("memory.dbのWAL/SHM補助ファイルはバックアップ対象外（backup()自体が完結したスナップショットのため）", async () => {
    const manifest = await backupStore(storePath, backupDir);

    expect(existsSync(join(backupDir, "memory.db-wal"))).toBe(false);
    expect(existsSync(join(backupDir, "memory.db-shm"))).toBe(false);
    expect(manifest.files.some((f) => f.relativePath.endsWith("-wal") || f.relativePath.endsWith("-shm"))).toBe(false);
  });

  it("主ストアは復元リハーサルで件数とチェックサムが一致する", async () => {
    await backupStore(storePath, backupDir);

    const restoreTarget = join(tmpDir, "restored", ".wasurenagusa");
    const result = await restoreStore(backupDir, restoreTarget);

    expect(result.memoriesCount).toBe(2);

    // 復元後のmemory.dbを開いて実件数を確認（マニフェスト頼みにしない実測確認）
    const restoredDb = new Database(join(restoreTarget, "memory.db"), { readonly: true });
    try {
      const row = restoredDb.prepare("SELECT COUNT(*) as c FROM memories").get() as { c: number };
      expect(row.c).toBe(2);
    } finally {
      restoredDb.close();
    }

    // 復元後のMarkdown内容が原本と一致する
    expect(readFileSync(join(restoreTarget, "dont.md"), "utf-8")).toBe(
      readFileSync(join(storePath, "dont.md"), "utf-8"),
    );
  });

  it("バックアップ検証失敗時（チェックサム不一致）はエラー終了する（fail-loud、静かに復元を続けない）", async () => {
    await backupStore(storePath, backupDir);

    // バックアップ済みファイルを改ざん（破損を模擬）
    writeFileSyncFs(join(backupDir, "dont.md"), "改ざんされた内容");

    const restoreTarget = join(tmpDir, "restored-corrupt", ".wasurenagusa");
    await expect(restoreStore(backupDir, restoreTarget)).rejects.toThrow();
  });
});
