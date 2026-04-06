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
});
