import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SQLiteStorage } from "./sqlite.js";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, rmSync } from "fs";

describe("SQLiteStorage", () => {
  let storage: SQLiteStorage;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-sqlite-test-"));
    const dbPath = join(tmpDir, "test.db");
    storage = new SQLiteStorage(dbPath);
    storage.initialize();
  });

  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // =========================
  // TASK-016: stash / restore / cleanExpiredStash
  // =========================
  describe("stash", () => {
    it("stash returns id, summary, and expiresAt", () => {
      const result = storage.stash({
        content: "line1\nline2\nline3\nline4\nline5\nline6\nline7",
        filePath: "/tmp/test.ts",
        fileType: "ts",
      });

      expect(result.id).toBeTruthy();
      expect(result.summary).toContain("line1");
      expect(result.summary).toContain("7行");
      expect(result.summary).toContain("ts");
      expect(result.expiresAt).toBeTruthy();
    });

    it("stash summary shows first 5 lines for long content", () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line${i + 1}`);
      const result = storage.stash({ content: lines.join("\n") });
      expect(result.summary).toContain("line1");
      expect(result.summary).toContain("line5");
      expect(result.summary).not.toContain("line6");
      expect(result.summary).toContain("100行");
    });

    it("stash summary shows all lines if <= 5 lines", () => {
      const result = storage.stash({ content: "a\nb\nc" });
      // 短いコンテンツは要約不要で全文表示
      expect(result.summary).toContain("a");
      expect(result.summary).toContain("c");
    });
  });

  describe("restore", () => {
    it("restore returns full content by id", () => {
      const stashResult = storage.stash({ content: "full content here" });
      const restoreResult = storage.restore(stashResult.id);

      expect(restoreResult.found).toBe(true);
      expect(restoreResult.content).toBe("full content here");
    });

    it("restore returns not found for non-existent id", () => {
      const result = storage.restore("nonexistent-id");
      expect(result.found).toBe(false);
      expect(result.content).toBeUndefined();
    });

    it("restore returns expired for TTL-exceeded stash", () => {
      // ttlHours=0 → 即座に期限切れ
      const stashResult = storage.stash({ content: "expired content", ttlHours: 0 });
      const result = storage.restore(stashResult.id);

      expect(result.found).toBe(false);
      expect(result.expired).toBe(true);
    });
  });

  describe("cleanExpiredStash", () => {
    it("removes expired stash entries", () => {
      storage.stash({ content: "expired", ttlHours: 0 });
      storage.stash({ content: "expired2", ttlHours: 0 });
      storage.stash({ content: "still valid", ttlHours: 24 });

      const cleaned = storage.cleanExpiredStash();
      expect(cleaned).toBe(2);
    });

    it("returns 0 when nothing to clean", () => {
      storage.stash({ content: "valid", ttlHours: 24 });
      const cleaned = storage.cleanExpiredStash();
      expect(cleaned).toBe(0);
    });
  });

  // =========================
  // TASK-019: consolidated (統合キャッシュ)
  // =========================
  describe("consolidated", () => {
    it("readConsolidated returns null when no data", () => {
      const result = storage.readConsolidated("dont");
      expect(result).toBeNull();
    });

    it("writeConsolidated then readConsolidated returns data", () => {
      const dontData = {
        principles: [],
        consolidatedAt: "2026-01-01T00:00:00+09:00",
        sourceEntryCount: 3,
        version: 1,
      };
      storage.writeConsolidated("dont", dontData);
      const result = storage.readConsolidated("dont");
      expect(result).toEqual(dontData);
    });

    it("writeConsolidated overwrites existing data", () => {
      const data1 = {
        principles: [],
        consolidatedAt: "2026-01-01T00:00:00+09:00",
        sourceEntryCount: 3,
        version: 1,
      };
      const data2 = {
        principles: [],
        consolidatedAt: "2026-01-02T00:00:00+09:00",
        sourceEntryCount: 5,
        version: 1,
      };
      storage.writeConsolidated("dont", data1);
      storage.writeConsolidated("dont", data2);
      const result = storage.readConsolidated("dont");
      expect(result).toEqual(data2);
    });

    it("writeConsolidated 失敗時に元データが破壊されない（fail-open 回帰）", () => {
      // 先に正しいデータを書き込む
      const original = {
        principles: [],
        consolidatedAt: "2026-01-01T00:00:00+09:00",
        sourceEntryCount: 3,
        version: 1,
      };
      storage.writeConsolidated("dont", original);

      // 不正な type で書き込みを試みる（CHECK制約で失敗）
      // SQLite側で例外が発生するが、ON CONFLICT DO UPDATE は同じ type のみ対象なので
      // 元の dont エントリは破壊されない
      expect(() => {
        storage.writeConsolidated("invalid" as "dont", {
          principles: [],
          consolidatedAt: "2026-01-99T00:00:00+09:00",
          sourceEntryCount: 999,
          version: 1,
        });
      }).toThrow();

      // 元データが残っている
      const result = storage.readConsolidated("dont");
      expect(result).toEqual(original);
    });

    it("isConsolidationStale returns true when no consolidated data", () => {
      storage.save({
        category: "dont",
        title: "test",
        content: "test content",
        tags: [],
      });
      expect(storage.isConsolidationStale("dont")).toBe(true);
    });

    it("isConsolidationStale returns true when entry count changed", () => {
      storage.save({
        category: "dont",
        title: "test1",
        content: "content1",
        tags: [],
      });
      storage.writeConsolidated("dont", {
        principles: [],
        consolidatedAt: "2026-01-01T00:00:00+09:00",
        sourceEntryCount: 1,
        version: 1,
      });
      // 追加でエントリ増加
      storage.save({
        category: "dont",
        title: "test2",
        content: "content2",
        tags: [],
      });
      expect(storage.isConsolidationStale("dont")).toBe(true);
    });

    it("isConsolidationStale returns false when entry count matches", () => {
      storage.save({
        category: "dont",
        title: "test1",
        content: "content1",
        tags: [],
      });
      storage.writeConsolidated("dont", {
        principles: [],
        consolidatedAt: "2026-01-01T00:00:00+09:00",
        sourceEntryCount: 1,
        version: 1,
      });
      expect(storage.isConsolidationStale("dont")).toBe(false);
    });
  });

  // =========================
  // TASK-020: themes
  // =========================
  describe("themes", () => {
    it("getThemes returns empty array initially", () => {
      expect(storage.getThemes()).toEqual([]);
    });

    it("addThemes adds themes", () => {
      storage.addThemes(["theme1", "theme2"]);
      const themes = storage.getThemes();
      expect(themes).toContain("theme1");
      expect(themes).toContain("theme2");
    });

    it("addThemes is idempotent (INSERT OR IGNORE)", () => {
      storage.addThemes(["theme1"]);
      storage.addThemes(["theme1", "theme2"]);
      const themes = storage.getThemes();
      expect(themes).toHaveLength(2);
    });

    it("isNewTheme returns true for unknown theme", () => {
      expect(storage.isNewTheme("new-theme")).toBe(true);
    });

    it("isNewTheme returns false for existing theme", () => {
      storage.addThemes(["existing-theme"]);
      expect(storage.isNewTheme("existing-theme")).toBe(false);
    });
  });

  // =========================
  // TASK-021: session topics
  // =========================
  describe("session topics", () => {
    it("getSessionTopic returns null for unknown project", () => {
      expect(storage.getSessionTopic("unknown")).toBeNull();
    });

    it("setSessionTopic then getSessionTopic returns topic", () => {
      storage.setSessionTopic("my-project", "Working on feature X");
      expect(storage.getSessionTopic("my-project")).toBe("Working on feature X");
    });

    it("setSessionTopic overwrites existing topic", () => {
      storage.setSessionTopic("my-project", "Old topic");
      storage.setSessionTopic("my-project", "New topic");
      expect(storage.getSessionTopic("my-project")).toBe("New topic");
    });

    it("setSessionTopic works for multiple projects", () => {
      storage.setSessionTopic("project-a", "Topic A");
      storage.setSessionTopic("project-b", "Topic B");
      expect(storage.getSessionTopic("project-a")).toBe("Topic A");
      expect(storage.getSessionTopic("project-b")).toBe("Topic B");
    });
  });

  // =========================
  // heart-extension B0c: knowledgeGap 永続化
  // =========================
  describe("knowledgeGap 永続化", () => {
    it("save with knowledgeGap → getDetail で同一配列が返る", () => {
      const saveResult = storage.save({
        category: "dont",
        title: "Gemini API失敗の原因",
        content: "max_tokens超過でstalled",
        tags: ["gemini"],
        knowledgeGap: ["Gemini APIのfinishReason種類", "max_tokensの上限値"],
      });

      const detail = storage.getDetail({ ids: [saveResult.id] });
      expect(detail.entries.length).toBe(1);
      expect(detail.entries[0].knowledgeGap).toEqual([
        "Gemini APIのfinishReason種類",
        "max_tokensの上限値",
      ]);
    });

    it("save without knowledgeGap → getDetail で undefined", () => {
      const saveResult = storage.save({
        category: "dont",
        title: "通常のdont",
        content: "no gap",
        tags: [],
      });

      const detail = storage.getDetail({ ids: [saveResult.id] });
      expect(detail.entries[0].knowledgeGap).toBeUndefined();
    });

    it("save with empty knowledgeGap → getDetail で空配列", () => {
      const saveResult = storage.save({
        category: "dont",
        title: "空配列",
        content: "empty gap",
        tags: [],
        knowledgeGap: [],
      });

      const detail = storage.getDetail({ ids: [saveResult.id] });
      expect(detail.entries[0].knowledgeGap).toEqual([]);
    });

    it("config カテゴリでの save は knowledgeGap が NULL のまま", () => {
      const saveResult = storage.save({
        category: "config",
        title: "設定",
        content: "ポート3000",
        tags: [],
      });

      const detail = storage.getDetail({ ids: [saveResult.id] });
      expect(detail.entries[0].knowledgeGap).toBeUndefined();
    });

    it("readDontEntries が knowledgeGap を含む MemoryEntry を返す", () => {
      storage.save({
        category: "dont",
        title: "knowledge付きdont",
        content: "test",
        tags: [],
        project: "myproject",
        knowledgeGap: ["仕様A", "仕様B"],
      });

      const entries = storage.readDontEntries("myproject");
      expect(entries.length).toBeGreaterThan(0);
      const found = entries.find(e => e.title === "knowledge付きdont");
      expect(found).toBeDefined();
      expect(found!.knowledgeGap).toEqual(["仕様A", "仕様B"]);
    });

    it("replaceId 経由の更新でも knowledgeGap が反映される", () => {
      const saved = storage.save({
        category: "dont",
        title: "初版",
        content: "v1",
        tags: [],
        knowledgeGap: ["旧知識"],
      });

      storage.save({
        category: "dont",
        title: "更新版",
        content: "v2",
        tags: [],
        knowledgeGap: ["新知識1", "新知識2"],
        replaceId: saved.id,
      });

      const detail = storage.getDetail({ ids: [saved.id] });
      expect(detail.entries[0].title).toBe("更新版");
      expect(detail.entries[0].knowledgeGap).toEqual(["新知識1", "新知識2"]);
    });
  });

  /**
   * heart-extension F3/F4: dream / success カテゴリの save と search が通る
   * （v2 マイグレーション後の CHECK 制約に阻まれない確認）
   */
  describe("dream / success カテゴリ (heart-extension F3/F4)", () => {
    it("category='dream' で save → search で取得できる", () => {
      const saved = storage.save({
        category: "dream",
        title: "霧の中の声",
        content: "霧の道で誰かが小さく頷いた",
        tags: ["dream"],
        project: "myproject",
      });
      expect(saved.success).toBe(true);

      const search = storage.search({ query: "", category: "dream", limit: 5 });
      expect(search.results.length).toBe(1);
      expect(search.results[0].title).toBe("霧の中の声");
    });

    it("category='success' で save → search で取得できる", () => {
      const saved = storage.save({
        category: "success",
        title: "媚び化リスク指摘で同意",
        content: "S1: 反対意見後の称賛シグナル",
        tags: ["success"],
        project: "myproject",
      });
      expect(saved.success).toBe(true);

      const search = storage.search({ query: "", category: "success", limit: 5 });
      expect(search.results.length).toBe(1);
      expect(search.results[0].title).toBe("媚び化リスク指摘で同意");
    });

    it("category='all' 検索で dream / success も含まれる", () => {
      storage.save({
        category: "dream",
        title: "夢A",
        content: "...",
        tags: [],
        project: "myproject",
      });
      storage.save({
        category: "success",
        title: "成功A",
        content: "...",
        tags: [],
        project: "myproject",
      });

      const search = storage.search({ query: "", category: "all", limit: 10 });
      const titles = search.results.map((r) => r.title);
      expect(titles).toContain("夢A");
      expect(titles).toContain("成功A");
    });
  });
});
