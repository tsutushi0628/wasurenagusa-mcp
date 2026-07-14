import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { SQLiteStorage, GET_CONTEXT_MAX_ENTRIES, GET_CONTEXT_MAX_CHARS } from "./sqlite.js";
import { config } from "../config.js";

/**
 * memory_get_context（storage.getContext）の件数・分量上限を検証する（タスク4.4・R-C3）。
 * 監査D6の事故（LIMITなしの全件読みで1呼び出し69万字ダンプ）の根治対象。
 * 「返却が上限以下」「上限で切られたことが黙って切り捨てられず応答に明示される」を
 * 業務要件として検証する（実装の途中計算の写しではなく、この2点をアサートする）。
 */
describe("SQLiteStorage.getContext: 件数と分量の上限（タスク4.4）", () => {
  let tmpDir: string;
  let projectRoot: string;
  let memoryPath: string;
  let dbPath: string;
  let storage: SQLiteStorage;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-get-context-cap-test-"));
    projectRoot = join(tmpDir, "myproject");
    memoryPath = join(projectRoot, ".wasurenagusa");
    dbPath = join(memoryPath, config.sqliteFile);
    mkdirSync(memoryPath, { recursive: true });
    storage = new SQLiteStorage(dbPath);
    storage.initialize(memoryPath);
  });

  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("上限件数を下回るときは truncated=false で全件そのまま返る", () => {
    for (let i = 0; i < 3; i++) {
      storage.save({
        category: "config",
        title: `設定${i}`,
        content: "内容",
        tags: [],
        project: "myproject",
      });
    }

    const result = storage.getContext("myproject");

    expect(result.truncated).toBeFalsy();
    expect(result.config).toContain("設定0");
    expect(result.config).toContain("設定2");
    expect(result.config).not.toContain("上限により省略");
  });

  it("config件数が上限を超えるとき、返却件数は上限以下でtruncated=trueが明示される", () => {
    const total = GET_CONTEXT_MAX_ENTRIES + 20;
    for (let i = 0; i < total; i++) {
      storage.save({
        category: "config",
        title: `設定${i}`,
        content: "内容",
        tags: [],
        project: "myproject",
      });
    }

    const result = storage.getContext("myproject");

    expect(result.truncated).toBe(true);
    expect(result.config).toContain("上限により省略");
    // 全件の本文がそのまま流れ込んでいない（黙った全件ダンプになっていない）ことを、
    // 上限を超える識別子が含まれないことで検証する。
    // 取得順はtimestamp降順（新しい順）のため、最も古い（=最初に保存した）設定0が
    // 上限カットの対象になる。
    expect(result.config).not.toContain("設定0");
  });

  it("1件あたりの本文が巨大なとき、文字数上限で切られてtruncated=trueが明示される", () => {
    const hugeContent = "あ".repeat(GET_CONTEXT_MAX_CHARS * 2);
    storage.save({
      category: "dont",
      title: "巨大エントリ",
      content: hugeContent,
      tags: [],
      project: "myproject",
    });

    const result = storage.getContext("myproject");

    expect(result.truncated).toBe(true);
    expect(result.dont.length).toBeLessThan(hugeContent.length);
    expect(result.dont).toContain("上限により省略");
  });
});
