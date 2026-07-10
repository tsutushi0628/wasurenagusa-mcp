import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SQLiteStorage } from "./sqlite.js";

/**
 * project='unknown'（タスク1.10、design.md禁止フォールバック#5）の検索可視性（R-A4 AC3）。
 *
 * project省略時はcwd由来のbasenameへ暗黙フォールバックせずunknownを明示刻印する
 * （save.ts側で対応済み）。本テストは、その結果生じる project='unknown' 行が
 * project絞り込み検索の裏に消えず、既定で検索対象に残ることをストレージ層で検証する
 * （旧実装のNULLパーミッシブ挙動と同じ扱いにする）。
 */
describe("project='unknown'エントリの検索可視性（R-A4 AC3）", () => {
  let storage: SQLiteStorage;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-unknown-visibility-test-"));
    storage = new SQLiteStorage(join(tmpDir, "test.db"));
    storage.initialize();
  });

  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("search: project絞り込み検索でもproject='unknown'エントリはヒットする", () => {
    const unknownEntry = storage.save({
      category: "log",
      title: "帰属不明エントリタイトル",
      content: "本文キーワード",
      project: "unknown",
    });
    storage.save({
      category: "log",
      title: "他プロジェクトエントリタイトル",
      content: "本文キーワード",
      project: "other-project",
    });

    const result = storage.search({ query: "本文キーワード", project: "my-project", limit: 10 });
    const ids = result.results.map((r) => r.id);
    expect(ids).toContain(unknownEntry.id);
  });

  it("searchHybrid: project絞り込み検索でもproject='unknown'エントリはヒットする", () => {
    const unknownEntry = storage.save({
      category: "log",
      title: "ハイブリッド帰属不明タイトル",
      content: "本文キーワード",
      project: "unknown",
    });

    const result = storage.searchHybrid(
      { query: "ハイブリッド帰属不明タイトル", project: "my-project", limit: 10 },
      new Array(384).fill(0),
    );
    const ids = result.results.map((r) => r.id);
    expect(ids).toContain(unknownEntry.id);
  });

  it("readConfigEntries: project絞り込みでもproject='unknown'エントリは含まれる（注入経路）", () => {
    const unknownEntry = storage.save({
      category: "config",
      title: "帰属不明設定",
      content: "本文",
      project: "unknown",
    });

    const entries = storage.readConfigEntries("my-project");
    const ids = entries.map((e) => e.id);
    expect(ids).toContain(unknownEntry.id);
  });

  it("readAliveDontEntries: project絞り込みでもproject='unknown'エントリは含まれる（統合経路）", () => {
    const unknownEntry = storage.save({
      category: "dont",
      title: "帰属不明don't",
      content: "本文",
      project: "unknown",
    });

    const entries = storage.readAliveDontEntries("my-project");
    const ids = entries.map((e) => e.id);
    expect(ids).toContain(unknownEntry.id);
  });
});
