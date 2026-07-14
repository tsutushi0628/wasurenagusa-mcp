import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { handleMemorySearch } from "./search.js";
import { handleMemoryGetDetail } from "./getDetail.js";
import { tmpdir } from "os";
import { join, basename } from "path";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, existsSync } from "fs";

// TASK-OL-09: ツール層統合テスト（operation-logging）
// LocalEmbeddingとSQLiteStorageをモックしてoperationログの記録を検証する

const mockStorageSearch = vi.fn().mockReturnValue({ results: [], totalCount: 0 });
const mockStorageSearchHybrid = vi.fn().mockReturnValue({ results: [], totalCount: 0 });
const mockStorageSearchVectors = vi.fn().mockReturnValue([]);
const mockStorageIncrementAccessCount = vi.fn();
const mockStorageGetVectorMetadata = vi.fn().mockReturnValue(new Map());
const mockStorageGetDetail = vi.fn().mockReturnValue({ entries: [] });
const mockStorageSave = vi.fn();
const mockStorageInitialize = vi.fn();
const mockStorageClose = vi.fn();

vi.mock("../storage/sqlite.js", () => {
  class MockSQLiteStorage {
    constructor(_dbPath: string) {}
    initialize = mockStorageInitialize;
    search = mockStorageSearch;
    searchHybrid = mockStorageSearchHybrid;
    searchVectors = mockStorageSearchVectors;
    incrementAccessCount = mockStorageIncrementAccessCount;
    getVectorMetadata = mockStorageGetVectorMetadata;
    getDetail = mockStorageGetDetail;
    save = mockStorageSave;
    markLastRead = vi.fn();
    close = mockStorageClose;
  }
  return { SQLiteStorage: MockSQLiteStorage };
});

vi.mock("../storage/index.js", () => {
  class MockSQLiteStorage {
    constructor(_dbPath: string) {}
    initialize = mockStorageInitialize;
    getDetail = mockStorageGetDetail;
    incrementAccessCount = mockStorageIncrementAccessCount;
    markLastRead = vi.fn();
    close = mockStorageClose;
  }
  return { SQLiteStorage: MockSQLiteStorage };
});

vi.mock("../vector/local-embedding.js", () => {
  class MockLocalEmbedding {
    constructor(_modelDir: string) {}
    initialize = vi.fn().mockResolvedValue(undefined);
    embed = vi.fn().mockResolvedValue(new Array(384).fill(0));
    isAvailable = vi.fn().mockReturnValue(false);
  }
  return { LocalEmbedding: MockLocalEmbedding };
});

vi.mock("../vector/memory-tier.js", () => ({
  TIER_THRESHOLDS: { critical: 0.3, medium: 0.6, archive: 0.9 },
  shouldPromoteToCritical: vi.fn().mockReturnValue(false),
}));

// getMemoryPath は実際の実装を使う（projectRoot/.wasurenagusa を返す）
// configのsqliteFileとmodelsDirのみモック
vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return {
    ...actual,
    config: {
      ...actual.config,
      sqliteFile: "memory.db",
      modelsDir: "models",
    },
  };
});

const MEMORY_DIR = ".wasurenagusa";

describe("handleMemorySearch - operationログ統合", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "wasurenagusa-search-log-test-"));
    mkdirSync(join(projectRoot, MEMORY_DIR), { recursive: true });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("handleMemorySearchを呼ぶとoperationログが1件追記される", async () => {
    await handleMemorySearch({ query: "test" }, projectRoot);

    const logsDir = join(projectRoot, MEMORY_DIR, "logs");
    // fire-and-forgetなので書き込み完了をポーリングで待つ（固定sleepより速く・確実に検出する）
    let files: string[] = [];
    await vi.waitFor(() => {
      expect(existsSync(logsDir)).toBe(true);
      files = readdirSync(logsDir).filter(f => f.startsWith("operation-"));
      expect(files.length).toBe(1);
    });

    const content = readFileSync(join(logsDir, files[0]), "utf-8").trim();
    const lines = content.split("\n").filter(Boolean);
    expect(lines.length).toBe(1);

    const entry = JSON.parse(lines[0]);
    expect(entry.operation_type).toBe("search");
    expect(entry.query).toBe("test");
    expect(entry.project).toBe(basename(projectRoot));
    expect(entry.session_id).toBeTruthy();
    expect(typeof entry.hit_count).toBe("number");
    expect(typeof entry.duration_ms).toBe("number");
  });

  it("ログ書き込みが失敗してもhandleMemorySearchの返却値は正常（fire-and-forget保証）", async () => {
    const fsMod = await import("fs");
    vi.spyOn(fsMod.promises, "appendFile").mockRejectedValue(new Error("disk full"));
    vi.spyOn(fsMod.promises, "mkdir").mockResolvedValue(undefined);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await handleMemorySearch({ query: "test" }, projectRoot);
    const parsed = JSON.parse(result);

    expect(parsed).toHaveProperty("results");
    expect(Array.isArray(parsed.results)).toBe(true);
  });

  it("handleMemorySearchを呼ぶと可観測性カウンタ（search_total・search_zero_hit）が記録される（タスク0.9、R-M1）", async () => {
    // mockStorageSearch は既定で {results: [], totalCount: 0}（ゼロヒット）を返す
    await handleMemorySearch({ query: "test" }, projectRoot);

    const logsDir = join(projectRoot, MEMORY_DIR, "logs");
    // fire-and-forgetなので書き込み完了をポーリングで待つ
    let totalEntry: { value: number } | undefined;
    let zeroHitEntry: { value: number } | undefined;
    await vi.waitFor(() => {
      const files = readdirSync(logsDir).filter(f => f.startsWith("counters-"));
      expect(files.length).toBe(1);
      const content = readFileSync(join(logsDir, files[0]), "utf-8").trim();
      const entries = content.split("\n").filter(Boolean).map(l => JSON.parse(l));
      totalEntry = entries.find(e => e.metric === "search_total");
      zeroHitEntry = entries.find(e => e.metric === "search_zero_hit");
      expect(totalEntry).toBeDefined();
      expect(zeroHitEntry).toBeDefined();
    });

    expect(totalEntry?.value).toBe(1);
    expect(zeroHitEntry?.value).toBe(1);
  });
});

describe("handleMemoryGetDetail - operationログ統合", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "wasurenagusa-getdetail-log-test-"));
    mkdirSync(join(projectRoot, MEMORY_DIR), { recursive: true });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("handleMemoryGetDetailを呼ぶとoperationログが1件追記される", async () => {
    await handleMemoryGetDetail({ ids: ["nonexistent-id"] }, projectRoot);

    const logsDir = join(projectRoot, MEMORY_DIR, "logs");
    // fire-and-forgetなので書き込み完了をポーリングで待つ
    let files: string[] = [];
    await vi.waitFor(() => {
      expect(existsSync(logsDir)).toBe(true);
      files = readdirSync(logsDir).filter(f => f.startsWith("operation-"));
      expect(files.length).toBe(1);
    });

    const content = readFileSync(join(logsDir, files[0]), "utf-8").trim();
    const lines = content.split("\n").filter(Boolean);
    expect(lines.length).toBe(1);

    const entry = JSON.parse(lines[0]);
    expect(entry.operation_type).toBe("get_detail");
    expect(entry.requested_ids).toEqual(["nonexistent-id"]);
    expect(entry.project).toBe(basename(projectRoot));
    expect(entry.session_id).toBeTruthy();
    expect(typeof entry.duration_ms).toBe("number");
  });

  it("search直後のgetDetailはparent_session_idがnull（hit_count=0で積集合なし）", async () => {
    // searchを実行（モックでhit_count=0、resultIdsは空）
    await handleMemorySearch({ query: "link-test" }, projectRoot);

    const logsDir = join(projectRoot, MEMORY_DIR, "logs");
    // fire-and-forgetなのでsearchログの書き込み完了をポーリングで待つ
    await vi.waitFor(() => {
      const files = readdirSync(logsDir).filter(f => f.startsWith("operation-"));
      expect(files.length).toBe(1);
      const lines = readFileSync(join(logsDir, files[0]), "utf-8").trim().split("\n").filter(Boolean);
      expect(lines.length).toBe(1);
    });

    // getDetailを実行（requestedIdsとresultIds[]の積集合なし → parent_session_id=null）
    await handleMemoryGetDetail({ ids: ["some-id"] }, projectRoot);

    let lines: string[] = [];
    await vi.waitFor(() => {
      const files = readdirSync(logsDir).filter(f => f.startsWith("operation-"));
      lines = readFileSync(join(logsDir, files[0]), "utf-8").trim().split("\n").filter(Boolean);
      expect(lines.length).toBe(2);
    });

    const getDetailEntry = JSON.parse(lines[1]);
    expect(getDetailEntry.operation_type).toBe("get_detail");
    expect(getDetailEntry.parent_session_id).toBeNull();
  });

  it("ログ書き込みが失敗してもhandleMemoryGetDetailの返却値は正常（fire-and-forget保証）", async () => {
    const fsMod = await import("fs");
    vi.spyOn(fsMod.promises, "appendFile").mockRejectedValue(new Error("disk full"));
    vi.spyOn(fsMod.promises, "mkdir").mockResolvedValue(undefined);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await handleMemoryGetDetail({ ids: ["nonexistent"] }, projectRoot);
    const parsed = JSON.parse(result);

    expect(parsed).toHaveProperty("entries");
    expect(Array.isArray(parsed.entries)).toBe(true);
  });
});
