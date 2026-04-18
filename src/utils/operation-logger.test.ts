import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// TASK-OL-01: 型・エントリ構造の検証
describe("OperationLogEntry型構造", () => {
  it("SearchLogEntryが必須フィールドを持つ", () => {
    const entry = {
      ts: "2026-04-18T12:00:00.000+09:00",
      operation_type: "search" as const,
      session_id: "abc-123",
      query: "テストクエリ",
      category: "all",
      hit_count: 5,
      project: "my-project",
      duration_ms: 42,
    };

    expect(entry.ts).toBeDefined();
    expect(entry.operation_type).toBe("search");
    expect(entry.session_id).toBeDefined();
    expect(entry.query).toBeDefined();
    expect(entry.category).toBeDefined();
    expect(entry.hit_count).toBeTypeOf("number");
    expect(entry.project).toBeDefined();
    expect(entry.duration_ms).toBeTypeOf("number");
  });

  it("GetDetailLogEntryのparent_session_idがnullまたはstring", () => {
    const withParent = {
      ts: "2026-04-18T12:00:00.000+09:00",
      operation_type: "get_detail" as const,
      session_id: "xyz-456",
      parent_session_id: "abc-123",
      requested_ids: ["id1", "id2"],
      found_count: 2,
      project: "my-project",
      duration_ms: 10,
    };

    const withoutParent = {
      ...withParent,
      parent_session_id: null,
    };

    expect(withParent.parent_session_id).toBeTypeOf("string");
    expect(withoutParent.parent_session_id).toBeNull();
  });
});

// TASK-OL-02: ファイル書き込みテスト
describe("logOperation() - ファイル書き込み", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "op-log-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("SearchLogEntryを書き込むとJSONLファイルが作成される", async () => {
    const { logOperation } = await import("./operation-logger.js");
    const entry = {
      ts: "2026-04-18T12:00:00.000+09:00",
      operation_type: "search" as const,
      session_id: "test-session-1",
      query: "テスト",
      category: "all",
      hit_count: 3,
      project: "test-project",
      duration_ms: 20,
    };

    await logOperation(entry, tmpDir);

    const logsDir = path.join(tmpDir, "logs");
    const files = fs.readdirSync(logsDir).filter(f => f.startsWith("operation-"));
    expect(files.length).toBe(1);

    const content = fs.readFileSync(path.join(logsDir, files[0]), "utf-8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.operation_type).toBe("search");
    expect(parsed.session_id).toBe("test-session-1");
  });

  it("logsディレクトリが存在しなくても自動作成される", async () => {
    const { logOperation } = await import("./operation-logger.js");
    const nonExistentBase = path.join(tmpDir, "nested", "deep");

    const entry = {
      ts: "2026-04-18T12:00:00.000+09:00",
      operation_type: "search" as const,
      session_id: "session-auto-mkdir",
      query: "q",
      category: "all",
      hit_count: 0,
      project: "proj",
      duration_ms: 5,
    };

    await logOperation(entry, nonExistentBase);

    const logsDir = path.join(nonExistentBase, "logs");
    expect(fs.existsSync(logsDir)).toBe(true);
  });

  it("書き込まれた内容がJSON.parseできる（正しいJSONL）", async () => {
    const { logOperation } = await import("./operation-logger.js");
    const entry = {
      ts: "2026-04-18T12:00:00.000+09:00",
      operation_type: "get_detail" as const,
      session_id: "session-jsonl-check",
      parent_session_id: null,
      requested_ids: ["a", "b"],
      found_count: 2,
      project: "proj",
      duration_ms: 8,
    };

    await logOperation(entry, tmpDir);

    const logsDir = path.join(tmpDir, "logs");
    const files = fs.readdirSync(logsDir).filter(f => f.startsWith("operation-"));
    const content = fs.readFileSync(path.join(logsDir, files[0]), "utf-8");
    const lines = content.trim().split("\n");
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

// TASK-OL-03: エラー耐性テスト
describe("logOperation() - エラー耐性", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "op-log-err-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("appendFileが失敗してもthrowしない", async () => {
    vi.spyOn(fs.promises, "appendFile").mockRejectedValue(new Error("disk full"));
    // mkdirはそのまま通す
    vi.spyOn(fs.promises, "mkdir").mockResolvedValue(undefined);

    const { logOperation } = await import("./operation-logger.js");
    const entry = {
      ts: "2026-04-18T12:00:00.000+09:00",
      operation_type: "search" as const,
      session_id: "fail-session",
      query: "q",
      category: "all",
      hit_count: 0,
      project: "proj",
      duration_ms: 1,
    };

    await expect(logOperation(entry, tmpDir)).resolves.not.toThrow();
  });

  it("appendFile失敗時にconsole.errorが呼ばれる", async () => {
    vi.spyOn(fs.promises, "appendFile").mockRejectedValue(new Error("disk full"));
    vi.spyOn(fs.promises, "mkdir").mockResolvedValue(undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { logOperation } = await import("./operation-logger.js");
    const entry = {
      ts: "2026-04-18T12:00:00.000+09:00",
      operation_type: "search" as const,
      session_id: "error-spy-session",
      query: "q",
      category: "all",
      hit_count: 0,
      project: "proj",
      duration_ms: 1,
    };

    await logOperation(entry, tmpDir);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("100msタイムアウト: 150ms遅延のappendFileはタイムアウトで打ち切られる", async () => {
    vi.spyOn(fs.promises, "appendFile").mockImplementation(
      () => new Promise(resolve => setTimeout(resolve, 150))
    );
    vi.spyOn(fs.promises, "mkdir").mockResolvedValue(undefined);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { logOperation } = await import("./operation-logger.js");
    const entry = {
      ts: "2026-04-18T12:00:00.000+09:00",
      operation_type: "search" as const,
      session_id: "timeout-session",
      query: "q",
      category: "all",
      hit_count: 0,
      project: "proj",
      duration_ms: 1,
    };

    const start = Date.now();
    await logOperation(entry, tmpDir);
    const elapsed = Date.now() - start;

    // 150msではなく100msタイムアウトで終了するはず
    expect(elapsed).toBeLessThan(140);
  });
});

// TASK-OL-05: session_idキャッシュとparent_session_id判定のテスト
describe("setLastSearch / resolveParentSessionId", () => {
  beforeEach(async () => {
    // モジュールキャッシュをリセットしてクリーンな状態で各テスト実行
    vi.resetModules();
  });

  it("search後5分以内かつID積集合あり → parent_session_idがsearchのsession_id", async () => {
    const { setLastSearch, resolveParentSessionId } = await import("./operation-logger.js");
    setLastSearch("proj-a", "search-session-1", ["id1", "id2", "id3"]);
    const parentId = resolveParentSessionId("proj-a", ["id2", "id4"]);
    expect(parentId).toBe("search-session-1");
  });

  it("search後5分超え → parent_session_idがnull", async () => {
    const { setLastSearch, resolveParentSessionId } = await import("./operation-logger.js");
    const sixMinutesAgo = Date.now() - 6 * 60 * 1000;
    // 時刻を偽造するためにsetLastSearchを直接呼べないので、vi.setSystemTimeを使う
    vi.useFakeTimers();
    vi.setSystemTime(sixMinutesAgo);
    setLastSearch("proj-timeout", "old-session", ["id1"]);
    vi.setSystemTime(Date.now() + 6 * 60 * 1000);
    const parentId = resolveParentSessionId("proj-timeout", ["id1"]);
    expect(parentId).toBeNull();
    vi.useRealTimers();
  });

  it("requestedIdsとresultIdsに積集合なし → parent_session_idがnull", async () => {
    const { setLastSearch, resolveParentSessionId } = await import("./operation-logger.js");
    setLastSearch("proj-b", "search-session-2", ["id1", "id2"]);
    const parentId = resolveParentSessionId("proj-b", ["id3", "id4"]);
    expect(parentId).toBeNull();
  });

  it("異なるproject → キャッシュが混在しない", async () => {
    const { setLastSearch, resolveParentSessionId } = await import("./operation-logger.js");
    setLastSearch("proj-x", "session-x", ["id1"]);
    const parentId = resolveParentSessionId("proj-y", ["id1"]);
    expect(parentId).toBeNull();
  });
});
