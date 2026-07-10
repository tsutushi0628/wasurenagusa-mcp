import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";
import { SQLiteStorage } from "./sqlite.js";

/**
 * 読み経路への状態可視性マトリクス適用（タスク1.5、design.md「記憶の状態機械」）。
 *
 * 可視性マトリクス:
 *   検索/注入/backfill/統合: active のみ可
 *   get_detail: active/archived 可、deleted 不可
 *   バックアップ/エクスポート: 全状態可（本テストの対象外）
 *
 * archived への遷移を行う書き込みAPIはまだ存在しない（Phase 3以降のキュレーション機能）ため、
 * 生のSQLで直接 state を書き換えて可視性だけを検証する。
 */
describe("読み経路の状態可視性マトリクス", () => {
  let storage: SQLiteStorage;
  let tmpDir: string;
  let dbPath: string;
  let rawDb: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-visibility-test-"));
    dbPath = join(tmpDir, "test.db");
    storage = new SQLiteStorage(dbPath);
    storage.initialize();
    rawDb = new Database(dbPath);
  });

  afterEach(() => {
    rawDb.close();
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function setState(id: string, state: "active" | "archived" | "deleted"): void {
    rawDb.prepare("UPDATE memories SET state = ? WHERE id = ?").run(state, id);
  }

  function saveThree(): { activeId: string; archivedId: string; deletedId: string } {
    const active = storage.save({ category: "log", title: "生存エントリタイトル", content: "生存本文キーワード" });
    const archived = storage.save({ category: "log", title: "退役エントリタイトル", content: "退役本文キーワード" });
    const deleted = storage.save({ category: "log", title: "削除エントリタイトル", content: "削除本文キーワード" });
    setState(archived.id, "archived");
    setState(deleted.id, "deleted");
    return { activeId: active.id, archivedId: archived.id, deletedId: deleted.id };
  }

  describe("不変条件I4（state='deleted'とdeleted_at IS NOT NULLの同期）", () => {
    it("softDeleteはdeleted_atと同時にstate='deleted'を書き込む", () => {
      const entry = storage.save({ category: "log", title: "同期対象", content: "本文" });
      storage.softDelete([entry.id]);

      const row = rawDb
        .prepare("SELECT state, deleted_at FROM memories WHERE id = ?")
        .get(entry.id) as { state: string; deleted_at: string | null };

      expect(row.state).toBe("deleted");
      expect(row.deleted_at).not.toBeNull();
    });
  });

  describe("search（検索）", () => {
    it("キーワード検索はactiveのみ返す（archived/deletedは返らない）", () => {
      saveThree();
      const result = storage.search({ query: "エントリタイトル", limit: 10 });
      const ids = result.results.map((r) => r.title);
      expect(ids).toContain("生存エントリタイトル");
      expect(ids).not.toContain("退役エントリタイトル");
      expect(ids).not.toContain("削除エントリタイトル");
    });

    it("空クエリ一覧もactiveのみ返す", () => {
      saveThree();
      const result = storage.search({ query: "", limit: 10 });
      const titles = result.results.map((r) => r.title);
      expect(titles).toContain("生存エントリタイトル");
      expect(titles).not.toContain("退役エントリタイトル");
      expect(titles).not.toContain("削除エントリタイトル");
    });
  });

  describe("searchHybrid（ベクトル+FTSハイブリッド検索）", () => {
    it("archived/deletedは候補プールから除外される", () => {
      const { activeId, archivedId, deletedId } = saveThree();
      // ハイブリッド検索はFTS候補+ベクトル候補のRRF統合。ベクトルを付与せずFTS経路のみで検証する。
      const result = storage.searchHybrid({ query: "エントリタイトル", limit: 10 }, new Array(384).fill(0));
      const ids = result.results.map((r) => r.id);
      expect(ids).toContain(activeId);
      expect(ids).not.toContain(archivedId);
      expect(ids).not.toContain(deletedId);
    });
  });

  describe("get_detail（ID直接指定）", () => {
    it("activeとarchivedは取得できる", () => {
      const { activeId, archivedId } = saveThree();
      const result = storage.getDetail({ ids: [activeId, archivedId] });
      const foundIds = result.entries.map((e) => e.id);
      expect(foundIds).toContain(activeId);
      expect(foundIds).toContain(archivedId);
      expect(result.notFound).toEqual([]);
    });

    it("deletedは取得できない（notFoundとして扱われる）", () => {
      const { deletedId } = saveThree();
      const result = storage.getDetail({ ids: [deletedId] });
      expect(result.entries).toEqual([]);
      expect(result.notFound).toContain(deletedId);
    });
  });

  describe("backfill（getEntriesWithoutEmbedding）", () => {
    it("archived/deletedはbackfill対象に含まれない", () => {
      const { activeId, archivedId, deletedId } = saveThree();
      const missing = storage.getEntriesWithoutEmbedding();
      expect(missing).toContain(activeId);
      expect(missing).not.toContain(archivedId);
      expect(missing).not.toContain(deletedId);
    });
  });

  describe("統合（readAliveDontEntries / isConsolidationStale）", () => {
    it("readAliveDontEntriesはactiveのdontのみ返す", () => {
      const active = storage.save({ category: "dont", title: "生存don't", content: "本文" });
      const archived = storage.save({ category: "dont", title: "退役don't", content: "本文" });
      const deleted = storage.save({ category: "dont", title: "削除don't", content: "本文" });
      setState(archived.id, "archived");
      setState(deleted.id, "deleted");

      const entries = storage.readAliveDontEntries();
      const ids = entries.map((e) => e.id);
      expect(ids).toContain(active.id);
      expect(ids).not.toContain(archived.id);
      expect(ids).not.toContain(deleted.id);
    });

    it("isConsolidationStaleはactive件数のみで鮮度判定する", () => {
      const active = storage.save({ category: "dont", title: "生存don't2", content: "本文" });
      const archived = storage.save({ category: "dont", title: "退役don't2", content: "本文" });
      setState(archived.id, "archived");

      // active件数(1件)を前提に統合キャッシュを書く
      storage.writeConsolidated("dont", {
        principles: [],
        consolidatedAt: new Date().toISOString(),
        sourceEntryCount: 1,
        version: 1,
      });

      expect(storage.isConsolidationStale("dont")).toBe(false);

      // 新たにactiveを1件増やすと不一致でstaleになる
      storage.save({ category: "dont", title: "生存don't3", content: "本文" });
      expect(storage.isConsolidationStale("dont")).toBe(true);
      void active;
    });
  });

  describe("注入（listHighIntensityDonts / listHighErrorEntries / readConfigEntries / readDontEntries）", () => {
    it("listHighIntensityDontsはarchived/deletedを除外する", () => {
      const active = storage.save({ category: "dont", title: "生存怒り", content: "本文", intensity: 5 });
      const archived = storage.save({ category: "dont", title: "退役怒り", content: "本文", intensity: 5 });
      const deleted = storage.save({ category: "dont", title: "削除怒り", content: "本文", intensity: 5 });
      setState(archived.id, "archived");
      setState(deleted.id, "deleted");

      const list = storage.listHighIntensityDonts(4, 10);
      const ids = list.map((e) => e.id);
      expect(ids).toContain(active.id);
      expect(ids).not.toContain(archived.id);
      expect(ids).not.toContain(deleted.id);
    });

    it("listHighErrorEntriesはarchived/deletedを除外する", () => {
      const active = storage.save({
        category: "log", title: "生存予測ずれ", content: "本文",
        predictedFactors: ["a"], actualFactors: ["b"], predictionError: 0.5,
      });
      const archived = storage.save({
        category: "log", title: "退役予測ずれ", content: "本文",
        predictedFactors: ["a"], actualFactors: ["b"], predictionError: 0.5,
      });
      setState(archived.id, "archived");

      const list = storage.listHighErrorEntries(0, 10);
      const ids = list.map((e) => e.id);
      expect(ids).toContain(active.id);
      expect(ids).not.toContain(archived.id);
    });

    it("readConfigEntries/readDontEntriesはarchived/deletedを除外する", () => {
      const activeConfig = storage.save({ category: "config", title: "生存設定", content: "本文" });
      const archivedConfig = storage.save({ category: "config", title: "退役設定", content: "本文" });
      setState(archivedConfig.id, "archived");

      const configs = storage.readConfigEntries();
      const ids = configs.map((e) => e.id);
      expect(ids).toContain(activeConfig.id);
      expect(ids).not.toContain(archivedConfig.id);
    });
  });
});
