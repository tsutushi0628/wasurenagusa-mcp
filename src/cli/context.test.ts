import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Readable } from "stream";

import { estimateTokens, getDreamContent, getSuccessContent, main } from "./context.js";
import { SQLiteStorage } from "../storage/sqlite.js";
import { initializeSchema } from "../storage/schema.js";
import type { MemoryCategory } from "../types.js";
import * as configModule from "../config.js";
import { config } from "../config.js";

describe("context.ts: SessionStartの記憶索引", () => {
  let tmpDir: string;
  let projectRoot: string;
  let storage: SQLiteStorage;
  let originalStdin: PropertyDescriptor | undefined;
  let entries: Array<{ id: string; title: string; category: MemoryCategory; project: string | null }>;

  beforeEach(() => {
    const temporaryRoot = join(process.cwd(), ".tmp");
    mkdirSync(temporaryRoot, { recursive: true });
    tmpDir = mkdtempSync(join(temporaryRoot, "context-index-"));
    projectRoot = join(tmpDir, "myproject");
    const memoryPath = join(projectRoot, ".wasurenagusa");
    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    mkdirSync(memoryPath, { recursive: true });
    writeFileSync(join(memoryPath, "owner-profile.md"), "");
    storage = new SQLiteStorage(join(memoryPath, config.sqliteFile));
    initializeSchema(storage.connection);
    vi.spyOn(configModule, "getMemoryPath").mockReturnValue(memoryPath);
    vi.stubEnv("WASURENAGUSA_CORRECTION_LOOP", "off");
    vi.stubEnv("WASURENAGUSA_INJECTION_TOKEN_BUDGET", undefined);
    originalStdin = Object.getOwnPropertyDescriptor(process, "stdin");

    entries = [];
    const remainingCategories: MemoryCategory[] = ["dont", "log", "config", "dream", "success", "dont"];
    const insert = storage.connection.prepare(
      "INSERT INTO memories (id, timestamp, category, title, content, tags, project, last_read_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (let index = 0; index < 60; index++) {
      let category: MemoryCategory;
      let project: string | null = "myproject";
      if (index < 3) {
        category = "decision";
      } else if (index < 7) {
        if (index % 2 === 0) {
          category = "config";
        } else {
          category = "snippet";
        }
      } else if (index < 12) {
        project = "otherproject";
        if (index % 2 === 0) {
          category = "snippet";
        } else {
          category = "decision";
        }
      } else if (index < 17) {
        category = remainingCategories[(index - 12) % remainingCategories.length];
        project = "otherproject";
      } else if (index < 21) {
        if (index % 2 === 0) {
          category = "snippet";
        } else {
          category = "decision";
        }
        if (index === 17 || index === 20) {
          project = null;
        } else {
          project = "unknown";
        }
      } else {
        category = remainingCategories[(index - 12) % remainingCategories.length];
        if (index < 26) {
          if (index % 2 === 0) {
            project = "unknown";
          } else {
            project = null;
          }
          if (index === 23) category = "config";
        }
      }

      const entry = {
        id: `synthetic-memory-${String(index).padStart(2, "0")}`,
        title: `合成記憶${String(index).padStart(2, "0")}`,
        category,
        project,
      };
      entries.push(entry);
      let readIndex = index;
      if (index === 6) readIndex = 5;
      let lastReadAt: string | null = new Date(Date.UTC(2020, 0, 1, 0, readIndex)).toISOString();
      if ([0, 3, 7, 12].includes(index)) lastReadAt = null;
      const timestamp = new Date(Date.UTC(2019, 0, 1, 0, 60 - index)).toISOString();
      insert.run(entry.id, timestamp, category, entry.title, `synthetic body ${index}`, "[]", project, lastReadAt);
    }
  });

  afterEach(() => {
    if (originalStdin) Object.defineProperty(process, "stdin", originalStdin);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function runSessionStart(): Promise<string> {
    Object.defineProperty(process, "stdin", {
      value: Readable.from([Buffer.from(JSON.stringify({
        session_id: "synthetic-index-session",
        cwd: projectRoot,
        hook_event_name: "SessionStart",
        source: "startup",
      }), "utf-8")]),
      configurable: true,
    });
    const chunks: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((
      (chunk: string | Uint8Array, ...args: unknown[]): boolean => {
        if (typeof chunk === "string") {
          chunks.push(chunk);
        } else {
          chunks.push(Buffer.from(chunk).toString("utf8"));
        }
        const callback = args.find((argument) => typeof argument === "function") as (() => void) | undefined;
        if (callback) callback();
        return true;
      }
    ) as typeof process.stdout.write);
    try {
      expect(await main()).toBe("emitted");
      expect(stdoutSpy).toHaveBeenCalledOnce();
      return chunks.join("");
    } finally {
      stdoutSpy.mockRestore();
    }
  }

  it("2案件と案件未所属の全7種類60件から20件を①案件decision→②案件snippet/config→③未所属decision/snippet→④その他の順に注入する", async () => {
    const output = await runSessionStart();
    const indexLines = output.split("\n").filter((line) => /^\[[a-z]+\] /.test(line));
    const expectedIndices = [2, 1, 0, 56, 50, 44, 38, 32, 26, 5, 6, 4, 3, 20, 19, 18, 17, 59, 58, 57];

    expect(indexLines).toHaveLength(20);
    expect(indexLines).toEqual(expectedIndices.map((index) => {
      const entry = entries[index];
      return `[${entry.category}] ${entry.title} (${entry.id})`;
    }));
    expect(output).not.toContain("synthetic body");
  });

  it("案件decisionが0件なら②のsnippet/configから始まる", async () => {
    storage.connection.prepare("UPDATE memories SET category = 'dont' WHERE project = ? AND category = 'decision'")
      .run("myproject");

    const output = await runSessionStart();
    const indexLines = output.split("\n").filter((line) => /^\[[a-z]+\] /.test(line));
    const expectedIndices = [56, 50, 44, 38, 32, 26, 5, 6, 4, 3, 20, 19, 18, 17, 59, 58, 57, 55, 54, 53];

    expect(indexLines).toHaveLength(20);
    expect(indexLines).toEqual(expectedIndices.map((index) => {
      const entry = entries[index];
      return `[${entry.category}] ${entry.title} (${entry.id})`;
    }));
  });

  it("他案件のdecisionとsnippetとconfigは最近読まれていても索引に出さない", async () => {
    storage.connection.prepare("UPDATE memories SET last_read_at = '2099-01-01T00:00:00.000Z' WHERE project = ?")
      .run("otherproject");

    const output = await runSessionStart();
    const indexLines = output.split("\n").filter((line) => /^\[[a-z]+\] /.test(line));
    const allEntries = storage.getMinimalIndexEntries("myproject", entries.length);
    const otherEntries = entries.filter((entry) => entry.project === "otherproject");

    expect(otherEntries.map((entry) => entry.category)).toEqual(expect.arrayContaining(["decision", "snippet", "config"]));
    expect(indexLines).toHaveLength(20);
    expect(allEntries).toHaveLength(50);
    for (const entry of otherEntries) {
      expect(indexLines.join("\n")).not.toContain(entry.id);
      expect(allEntries.map((indexEntry) => indexEntry.id)).not.toContain(entry.id);
    }
  });

  it("案件指定がなければNULLとunknownのdecisionとsnippetを先に並べて未所属の記憶だけ返す", () => {
    const indexEntries = storage.getMinimalIndexEntries(undefined, entries.length);
    const expectedIndices = [20, 19, 18, 17, 25, 24, 23, 22, 21];

    expect(indexEntries).toEqual(expectedIndices.map((index) => {
      const { id, title, category } = entries[index];
      return { id, title, category };
    }));
  });

  it("記憶インデックスの見出しとメモリ活用ルールの全文を維持する", async () => {
    const output = await runSessionStart();

    expect(output.split("\n")[0]).toBe("## 記憶インデックス（詳細はサブエージェント経由で memory_get_detail を使用）");
    expect(output.slice(output.indexOf("## メモリ活用ルール"))).toBe([
      "## メモリ活用ルール",
      "- 詳細が必要な場合はサブエージェントに memory_search / memory_get_detail を委譲すること",
      "- メインコンテキストに記憶の生データを持ち込まない",
      "- 「覚えろ」と言われたら memory_save で保存すること（MEMORY.mdへの書き込み禁止）",
    ].join("\n"));
  });

  it("同じ60件のDBで開始時の注入全体のトークン概算が変更前の50件索引より少ない", async () => {
    const legacyEntries = storage.connection.prepare(
      "SELECT id, title, category FROM memories WHERE state = 'active' AND (project IS NULL OR project = 'unknown' OR project = ?) ORDER BY last_read_at IS NULL, last_read_at DESC, timestamp DESC LIMIT ?",
    ).all("myproject", 50) as ReturnType<SQLiteStorage["getMinimalIndexEntries"]>;
    expect(legacyEntries).toHaveLength(50);
    const legacyIndexSpy = vi.spyOn(SQLiteStorage.prototype, "getMinimalIndexEntries").mockReturnValue(legacyEntries);
    const legacyOutput = await runSessionStart();
    legacyIndexSpy.mockRestore();

    const output = await runSessionStart();

    expect(legacyOutput.split("\n").filter((line) => /^\[[a-z]+\] /.test(line))).toHaveLength(50);
    expect(output.split("\n").filter((line) => /^\[[a-z]+\] /.test(line))).toHaveLength(20);
    expect(estimateTokens(output)).toBeLessThan(estimateTokens(legacyOutput));
  });
});

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

describe("context.ts: hook失敗時のstderr", () => {
  let originalStdin: PropertyDescriptor | undefined;

  afterEach(() => {
    if (originalStdin) Object.defineProperty(process, "stdin", originalStdin);
    vi.restoreAllMocks();
  });

  it("例外名とメッセージ先頭200字を1行で出力する", async () => {
    const privatePrompt = "PRIVATE_MEMORY_BODY_DO_NOT_LOG";
    const errorMessage = `${"api_"}key=PRIVATE_SECRET_VALUE\u2028\u2029${"x".repeat(300)}`;
    const openExistingForHook = vi.spyOn(SQLiteStorage, "openExistingForHook").mockImplementation(() => {
      const error = new TypeError(errorMessage);
      error.stack = `${error.name}: ${error.message}\n${privatePrompt}`;
      throw error;
    });
    originalStdin = Object.getOwnPropertyDescriptor(process, "stdin");
    Object.defineProperty(process, "stdin", {
      value: Readable.from([Buffer.from(JSON.stringify({
        session_id: "synthetic-hook-session",
        cwd: process.cwd(),
        hook_event_name: "UserPromptSubmit",
        prompt: privatePrompt,
      }), "utf-8")]),
      configurable: true,
    });
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await main()).toBe("failed");

    expect(openExistingForHook).toHaveBeenCalledOnce();
    expect(stderrSpy).toHaveBeenCalledOnce();
    const diagnostic = stderrSpy.mock.calls[0][0] as string;
    expect(diagnostic).toBe(`[context] hook failed: TypeError: =[REDACTED]  ${"x".repeat(187)}`);
    expect(diagnostic).not.toContain("PRIVATE_SECRET_VALUE");
    expect(diagnostic).not.toContain(privatePrompt);
    expect(diagnostic).not.toContain("\n");
  });

  it("U+2028 で区切られた秘密鍵の本文を出力しない", async () => {
    const keyBody = "MIIEpAFAKEKEYBODYDONOTLOG";
    const errorMessage = `-----BEGIN RSA ${"PRIVATE"} KEY-----\u2028${keyBody}\u2028-----END RSA ${"PRIVATE"} KEY-----`;
    const openExistingForHook = vi.spyOn(SQLiteStorage, "openExistingForHook").mockImplementation(() => {
      throw new Error(errorMessage);
    });
    originalStdin = Object.getOwnPropertyDescriptor(process, "stdin");
    Object.defineProperty(process, "stdin", {
      value: Readable.from([Buffer.from(JSON.stringify({
        session_id: "synthetic-hook-session",
        cwd: process.cwd(),
        hook_event_name: "UserPromptSubmit",
        prompt: "synthetic prompt",
      }), "utf-8")]),
      configurable: true,
    });
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await main()).toBe("failed");

    expect(openExistingForHook).toHaveBeenCalledOnce();
    const diagnostic = stderrSpy.mock.calls[0][0] as string;
    expect(diagnostic).not.toContain(keyBody);
    expect(diagnostic).not.toContain("\n");
  });

  it("空メッセージの例外は例外名をメッセージとして出力する", async () => {
    const openExistingForHook = vi.spyOn(SQLiteStorage, "openExistingForHook").mockImplementation(() => {
      throw new Error("");
    });
    originalStdin = Object.getOwnPropertyDescriptor(process, "stdin");
    Object.defineProperty(process, "stdin", {
      value: Readable.from([Buffer.from(JSON.stringify({
        session_id: "synthetic-hook-session",
        cwd: process.cwd(),
        hook_event_name: "UserPromptSubmit",
        prompt: "",
      }), "utf-8")]),
      configurable: true,
    });
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await main()).toBe("failed");

    expect(openExistingForHook).toHaveBeenCalledOnce();
    expect(stderrSpy).toHaveBeenCalledWith("[context] hook failed: Error: Error");
  });

  it("直接起動時の複数行の未捕捉例外は本文を省略する", async () => {
    const originalArgv1 = process.argv[1];
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const closeError = new Error(`${"api_"}key=PRIVATE_CLOSE_SECRET\nPRIVATE_CLOSE_ERROR_TAIL_DO_NOT_LOG`);
    originalStdin = Object.getOwnPropertyDescriptor(process, "stdin");
    Object.defineProperty(process, "stdin", {
      value: Readable.from([Buffer.from(JSON.stringify({
        session_id: "synthetic-hook-session",
        cwd: process.cwd(),
        hook_event_name: "UserPromptSubmit",
        prompt: "",
      }), "utf-8")]),
      configurable: true,
    });
    vi.resetModules();
    process.argv[1] = join(process.cwd(), "src/cli/context.ts");

    try {
      const { SQLiteStorage: directRunSQLiteStorage } = await import("../storage/index.js");
      const openExistingForHook = vi.spyOn(directRunSQLiteStorage, "openExistingForHook").mockReturnValue({
        supportsCorrectionHooks: false,
        close: () => {
          throw closeError;
        },
      } as unknown as SQLiteStorage);

      await import("./context.js");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(openExistingForHook).toHaveBeenCalledOnce();
      expect(stderrSpy).toHaveBeenCalledOnce();
      expect(stderrSpy).toHaveBeenCalledWith("[context] hook failed: Error: multiline error message omitted");
      const diagnostic = stderrSpy.mock.calls[0][0] as string;
      expect(diagnostic).not.toContain("PRIVATE_CLOSE_SECRET");
      expect(diagnostic).not.toContain("PRIVATE_CLOSE_ERROR_TAIL_DO_NOT_LOG");
      expect(diagnostic).not.toContain("\n");
    } finally {
      process.argv[1] = originalArgv1;
      vi.restoreAllMocks();
      vi.resetModules();
    }
  });
});
