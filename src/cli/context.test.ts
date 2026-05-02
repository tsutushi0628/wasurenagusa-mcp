import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { getDreamContent, getSuccessContent } from "./context.js";
import { SQLiteStorage } from "../storage/sqlite.js";
import { config } from "../config.js";

/**
 * heart-extension F3 / F4: context.ts の dream / success セクション組み立てを検証する。
 *
 * - getDreamContent: 直近24h以内の dream 1件 → "### 今朝の夢" + 本文
 * - getSuccessContent: 直近30日以内の success 上位3件 → "### 効いた提案パターン" + 箇条書き
 * - エントリ0件 / 期間外 / DB なし → 空文字を返す（セクション省略）
 */
describe("context.ts: getDreamContent (F3)", () => {
  let tmpDir: string;
  let projectRoot: string;
  let memoryPath: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-context-dream-test-"));
    projectRoot = join(tmpDir, "myproject");
    memoryPath = join(projectRoot, ".wasurenagusa");
    dbPath = join(memoryPath, config.sqliteFile);
    mkdirSync(memoryPath, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("直近24h以内に dream 1件 → '### 今朝の夢' を含むセクション文字列を返す", async () => {
    const storage = new SQLiteStorage(dbPath);
    storage.initialize(memoryPath);
    storage.save({
      category: "dream",
      title: "霧の中の声",
      content: "霧の道で誰かが小さく頷いてくれた気がした。",
      tags: ["dream"],
      project: "myproject",
    });

    const out = await getDreamContent(storage, "myproject");
    storage.close();

    expect(out).toContain("### 今朝の夢");
    expect(out).toContain("霧の道で誰かが小さく頷いてくれた気がした。");
  });

  it("dream エントリ 0件 → 空文字を返す（セクション省略）", async () => {
    const storage = new SQLiteStorage(dbPath);
    storage.initialize(memoryPath);

    const out = await getDreamContent(storage, "myproject");
    storage.close();

    expect(out).toBe("");
  });

  it("dream が25時間以上前 → 空文字を返す（鮮度フィルタ）", async () => {
    const storage = new SQLiteStorage(dbPath);
    storage.initialize(memoryPath);
    storage.save({
      category: "dream",
      title: "古い夢",
      content: "昔見た夢",
      tags: ["dream"],
      project: "myproject",
    });
    // タイムスタンプを直接書き換えて25時間前にする
    const oldTimestamp = new Date(Date.now() - 25 * 60 * 60 * 1000)
      .toISOString()
      .replace("Z", "+00:00");
    // SQLite に直接 UPDATE
    const dbDirect = (storage as unknown as { db: { prepare: (s: string) => { run: (...args: unknown[]) => void } } }).db;
    dbDirect.prepare("UPDATE memories SET timestamp = ? WHERE category = 'dream'").run(oldTimestamp);

    const out = await getDreamContent(storage, "myproject");
    storage.close();

    expect(out).toBe("");
  });
});

describe("context.ts: getSuccessContent (F4)", () => {
  let tmpDir: string;
  let projectRoot: string;
  let memoryPath: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-context-success-test-"));
    projectRoot = join(tmpDir, "myproject");
    memoryPath = join(projectRoot, ".wasurenagusa");
    dbPath = join(memoryPath, config.sqliteFile);
    mkdirSync(memoryPath, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("success 5件 → 上位3件で '### 効いた提案パターン' セクションを返す", async () => {
    const storage = new SQLiteStorage(dbPath);
    storage.initialize(memoryPath);

    for (let i = 1; i <= 5; i++) {
      storage.save({
        category: "success",
        title: `成功パターン${i}`,
        content: `根拠付き提案${i}が採用された`,
        tags: ["success"],
        project: "myproject",
      });
    }
    // タイムスタンプを明示的に降順で並び替え（save の generateTimestamp は秒精度なので
    // 連続saveだと同一秒に丸まりソートが安定しない。テストの安定性を確保するため直接UPDATE）
    const dbDirect = (storage as unknown as {
      db: { prepare: (s: string) => { run: (...args: unknown[]) => void } };
    }).db;
    for (let i = 1; i <= 5; i++) {
      const ts = new Date(Date.now() - (5 - i) * 60 * 1000).toISOString().replace("Z", "+00:00");
      dbDirect.prepare("UPDATE memories SET timestamp = ? WHERE title = ?").run(ts, `成功パターン${i}`);
    }

    const out = await getSuccessContent(storage, "myproject");
    storage.close();

    expect(out).toContain("### 効いた提案パターン");
    // 上位3件のみ表示（最新の3件 = 5,4,3）
    expect(out).toContain("成功パターン5");
    expect(out).toContain("成功パターン4");
    expect(out).toContain("成功パターン3");
    // 4件目以降は表示されない
    expect(out).not.toContain("成功パターン1");
  });

  it("success 0件 → 空文字を返す（セクション省略）", async () => {
    const storage = new SQLiteStorage(dbPath);
    storage.initialize(memoryPath);

    const out = await getSuccessContent(storage, "myproject");
    storage.close();

    expect(out).toBe("");
  });

  it("success が31日以上前のみ → 空文字を返す（鮮度フィルタ）", async () => {
    const storage = new SQLiteStorage(dbPath);
    storage.initialize(memoryPath);
    storage.save({
      category: "success",
      title: "古い成功",
      content: "古い成功体験",
      tags: ["success"],
      project: "myproject",
    });
    const oldTimestamp = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000)
      .toISOString()
      .replace("Z", "+00:00");
    const dbDirect = (storage as unknown as { db: { prepare: (s: string) => { run: (...args: unknown[]) => void } } }).db;
    dbDirect.prepare("UPDATE memories SET timestamp = ? WHERE category = 'success'").run(oldTimestamp);

    const out = await getSuccessContent(storage, "myproject");
    storage.close();

    expect(out).toBe("");
  });
});
