import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Readable } from "stream";

/**
 * v1書き込み経路の物理遮断（タスク0.6、R-A3）: SessionStartからのconsolidate-worker spawn遮断。
 *
 * consolidate-worker.ts は MarkdownStorage（v1）経由でdont/config統合を実行し、
 * consolidated-dont.json 等（v1資産）へ書き込む。SessionStart時にこれをdetached
 * プロセスとしてspawnする経路（src/cli/context.ts）は、v1系書き込みの実体の一つで
 * あり、恒久停止の対象となる（凍結の約束ではなくコード上の遮断）。
 *
 * 実ネットワーク呼び出しを避けるため EmbeddingService は isAvailable()=false に
 * モックする（backfill/ベクトル検索/横断検索はすべてこのフラグでガードされている
 * ため、モック後はspawnBackfillBackground等の非対象コードパスも自然に素通りする）。
 */

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));
vi.mock("child_process", () => ({
  spawn: mockSpawn,
}));

vi.mock("../vector/embedding-service.js", () => ({
  EmbeddingService: class {
    isAvailable() {
      return false;
    }
  },
}));

import { main } from "./context.js";
import { config } from "../config.js";

function stdinWith(jsonInput: string): Readable {
  const r = new Readable();
  r._read = () => {};
  r.push(Buffer.from(jsonInput, "utf-8"));
  r.push(null);
  return r;
}

describe("context.ts: v1書き込み経路の物理遮断（SessionStartからのconsolidate-worker spawn遮断）", () => {
  let tmpDir: string;
  let projectRoot: string;
  let memoryPath: string;
  let dontPath: string;
  let vectorsPath: string;
  let originalStdin: NodeJS.ReadStream;
  let originalGeminiApiKey: string;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-v1-block-test-"));
    projectRoot = join(tmpDir, "myproject");
    memoryPath = join(projectRoot, ".wasurenagusa");
    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    mkdirSync(memoryPath, { recursive: true });

    // v1資産（既存ファイル。書き換わらないことを確認する対象）
    dontPath = join(memoryPath, "dont.md");
    vectorsPath = join(memoryPath, "vectors.json");
    writeFileSync(dontPath, "# dont\n\n## 既存エントリ\nダミー\n");
    writeFileSync(vectorsPath, "[]");

    // config.geminiApiKey を強制的にtruthyにする（環境の.env有無に依存させない）。
    // spawnConsolidationBackground の実行条件は「dontStale||configStale」かつ
    // 「いずれかのLLM APIキーがある」こと。新規DB（統合キャッシュ行なし）は
    // 必ずstale=trueになるため、APIキーさえtruthyにすれば決定論的に再現できる。
    originalGeminiApiKey = config.geminiApiKey;
    config.geminiApiKey = "test-key-for-staleness-trigger";

    originalStdin = process.stdin;
    Object.defineProperty(process, "stdin", {
      value: stdinWith(JSON.stringify({ cwd: projectRoot, hook_event_name: "SessionStart" })),
      configurable: true,
    });

    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockSpawn.mockReturnValue({ unref: vi.fn() });
  });

  afterEach(() => {
    Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true });
    config.geminiApiKey = originalGeminiApiKey;
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("セッション開始処理を実行しても、consolidate-worker（v1統合系ワーカー）はspawnされない", async () => {
    await main();

    // 失敗時にprocess.env（spawnオプション経由）を含む全引数がdiffへ出力されるのを
    // 避けるため、スクリプトパスの真偽値だけを比較する（環境変数を出力に含めない）。
    const spawnedScriptPaths = mockSpawn.mock.calls.map((call) => String(call[1]?.[0] ?? ""));
    const spawnedConsolidateWorker = spawnedScriptPaths.some((p) => p.includes("consolidate-worker"));
    expect(spawnedConsolidateWorker).toBe(false);
  });

  it("セッション開始処理を実行しても、v1資産（dont.md・vectors.json）の内容は変わらない", async () => {
    const beforeDont = readFileSync(dontPath, "utf-8");
    const beforeVectors = readFileSync(vectorsPath, "utf-8");

    await main();

    expect(readFileSync(dontPath, "utf-8")).toBe(beforeDont);
    expect(readFileSync(vectorsPath, "utf-8")).toBe(beforeVectors);
  });
});
