/**
 * tests/fixtures/mini-store/build-mini-store.test.ts
 *
 * 機構検証専用の合成ミニストア生成ヘルパー（build-mini-store.ts）の業務要件を検証する
 * （タスク0.11）。scripts/gates/g0-hemostasis.ts のPASS/FAIL実証はこのヘルパーに依存するため、
 * 依存先を先に単体で検証してから使う（CLAUDE.md「書く前に既存資産を読む」）。
 *
 * 検証する業務要件:
 * - 指定件数の合成エントリが実装コード（SQLiteStorage.save）経由でSQLiteに作られる
 * - 生存エントリにはベクトルが付与される（backfill対象から誤って外れないこと）
 * - 論理削除（tombstone）状態が指定件数だけ作られる
 * - 蘇生状態（deleted_at はあるがベクトル行が残る）が意図した件数だけ再現される
 * - guardPattern付きのconsolidated-dont.jsonをオプトインで同梱できる（guard-gen-stopped検査用）
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import Database from "better-sqlite3";
import { buildMiniStore, FIXTURE_PROJECTS } from "./build-mini-store.js";

describe("buildMiniStore", () => {
  const scratchDirs: string[] = [];

  function scratchMemoryPath(): string {
    const dir = mkdtempSync(join(tmpdir(), "g0-mini-store-test-"));
    scratchDirs.push(dir);
    return join(dir, ".wasurenagusa");
  }

  afterEach(() => {
    while (scratchDirs.length > 0) {
      const dir = scratchDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("指定件数の合成エントリがSQLiteのmemoriesへ実際に保存される", () => {
    const memoryPath = scratchMemoryPath();
    const result = buildMiniStore(memoryPath, { count: 30, softDeleteCount: 0, resurrectionCount: 0 });

    expect(result.savedCount).toBe(30);
    const db = new Database(result.dbPath, { readonly: true });
    try {
      const row = db.prepare("SELECT COUNT(*) as c FROM memories").get() as { c: number };
      expect(row.c).toBe(30);
      // 架空プロジェクト名のみが使われている（実在プロジェクトと衝突しない）
      const projects = db.prepare("SELECT DISTINCT project FROM memories").all() as { project: string }[];
      for (const p of projects) {
        expect(FIXTURE_PROJECTS).toContain(p.project);
      }
    } finally {
      db.close();
    }
  });

  it("count=1000以上を指定するとG0の前提アサート(1,000件以上)を満たす件数が作られる", () => {
    const memoryPath = scratchMemoryPath();
    const result = buildMiniStore(memoryPath, { count: 1000, softDeleteCount: 0, resurrectionCount: 0 });
    expect(result.savedCount).toBe(1000);

    const db = new Database(result.dbPath, { readonly: true });
    try {
      const row = db.prepare("SELECT COUNT(*) as c FROM memories").get() as { c: number };
      expect(row.c).toBeGreaterThanOrEqual(1000);
    } finally {
      db.close();
    }
  });

  it("生存エントリにはベクトルが付与される", () => {
    const memoryPath = scratchMemoryPath();
    const result = buildMiniStore(memoryPath, { count: 10, softDeleteCount: 0, resurrectionCount: 0 });

    // vectors は vec0 仮想テーブル（sqlite-vec拡張のロードが要る）のため、拡張ロード不要な
    // vector_metadata（通常テーブル）で代理検証する。upsertVector/deleteVectors は両テーブルを
    // 常に同期させる実装（src/storage/sqlite.ts）のため、件数は一致する。
    const db = new Database(result.dbPath, { readonly: true });
    try {
      const vectorMetaCount = db.prepare("SELECT COUNT(*) as c FROM vector_metadata").get() as { c: number };
      expect(vectorMetaCount.c).toBe(10);
    } finally {
      db.close();
    }
  });

  it("softDeleteCountで指定した件数だけ論理削除(tombstone)状態が作られる", () => {
    const memoryPath = scratchMemoryPath();
    const result = buildMiniStore(memoryPath, { count: 10, softDeleteCount: 3, resurrectionCount: 0 });

    expect(result.softDeletedIds).toHaveLength(3);
    const db = new Database(result.dbPath, { readonly: true });
    try {
      const row = db.prepare("SELECT COUNT(*) as c FROM memories WHERE deleted_at IS NOT NULL").get() as { c: number };
      expect(row.c).toBe(3);
    } finally {
      db.close();
    }
  });

  it("resurrectionCountで指定した件数だけ蘇生状態(deleted済みだがベクトル行が残る)が再現される", () => {
    const memoryPath = scratchMemoryPath();
    const result = buildMiniStore(memoryPath, { count: 10, softDeleteCount: 3, resurrectionCount: 2 });

    expect(result.resurrectedVectorIds).toHaveLength(2);
    // vectors は vec0 仮想テーブルのため、拡張ロード不要な vector_metadata で代理検証する
    // （upsertVector/deleteVectors は両テーブルを常に同期させる実装）。
    const db = new Database(result.dbPath, { readonly: true });
    try {
      for (const id of result.resurrectedVectorIds) {
        const vec = db.prepare("SELECT id FROM vector_metadata WHERE id = ?").get(id);
        expect(vec, `蘇生対象 ${id} はベクトル行が残っているはず`).toBeDefined();
      }
      // 蘇生対象ではない残りの論理削除エントリはベクトルが清算済み
      const cleanedIds = result.softDeletedIds.filter((id) => !result.resurrectedVectorIds.includes(id));
      for (const id of cleanedIds) {
        const vec = db.prepare("SELECT id FROM vector_metadata WHERE id = ?").get(id);
        expect(vec, `清算済み ${id} はベクトル行が残っていないはず`).toBeUndefined();
      }
    } finally {
      db.close();
    }
  });

  it("seedGuardPattern指定時のみguardPattern付きconsolidated-dont.jsonが同梱される", () => {
    const memoryPathWithout = scratchMemoryPath();
    const withoutResult = buildMiniStore(memoryPathWithout, { count: 5 });
    expect(withoutResult.guardPatternFile).toBeUndefined();
    expect(existsSync(join(memoryPathWithout, "consolidated-dont.json"))).toBe(false);

    const memoryPathWith = scratchMemoryPath();
    const withResult = buildMiniStore(memoryPathWith, { count: 5, seedGuardPattern: true });
    expect(withResult.guardPatternFile).toBeDefined();
    const raw = readFileSync(withResult.guardPatternFile as string, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.principles).toHaveLength(1);
    expect(parsed.principles[0].guardPattern).toBe("FIXTURE_GUARD_TRIGGER");
  });
});
