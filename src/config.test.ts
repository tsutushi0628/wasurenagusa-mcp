import { describe, it, expect, vi, afterEach } from "vitest";
import { config as dotenvConfig } from "dotenv";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { resolveWindowDaysEnv } from "./config.js";
import { resolveHookStore } from "./storage/resolve-store.js";

vi.mock("dotenv", async (importOriginal) => {
  const actual = await importOriginal<typeof import("dotenv")>();
  return { ...actual, config: vi.fn(() => ({ parsed: undefined })) };
});

/**
 * env から窓日数を読む際の Number.isFinite ガードの業務要件を固定する。
 *
 * 業務要件:
 *  - 非数（"abc" など parseInt が NaN になる値）は既定値へフォールバックし warn を出す。
 *    非数のまま下流に流れると忘却 dry-run が沈黙停止したりログ回転が throw する事故になる。
 *  - 0 以下は「無効化」を意味する既存仕様（<=0=無効化）なので、既定へ置換せずそのまま通す
 *    （warn もしない）。配布パッケージで環境変数の意味を黙って変えないため。
 *  - 正の整数はそのまま採用する。
 *  - 未設定（undefined / 空文字）は正常系なので既定値を返し warn しない。
 */
describe("resolveWindowDaysEnv（窓日数の env ガード）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(dotenvConfig).mockReset();
    vi.resetModules();
  });

  it("非数入力は既定値へフォールバックし warn を1行出す", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveWindowDaysEnv("abc", 90, "FORGETTING_WINDOW_DAYS")).toBe(90);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("0・負値はそのまま通す（下流の <=0=無効化 という既存仕様を壊さない）・warnしない", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // 0 = 無効化（forgettingWindowDays<=0=忘却無効・logRetentionDays<=0=ログ回転無効）を保存。
    // 既定へ静かに置換しない（配布パッケージで環境変数の意味を変えないため）。
    expect(resolveWindowDaysEnv("0", 90, "FORGETTING_WINDOW_DAYS")).toBe(0);
    expect(resolveWindowDaysEnv("-5", 30, "LOG_RETENTION_DAYS")).toBe(-5);
    expect(warn).not.toHaveBeenCalled();
  });

  it("正の整数はそのまま採用する", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveWindowDaysEnv("120", 90, "FORGETTING_WINDOW_DAYS")).toBe(120);
    expect(warn).not.toHaveBeenCalled();
  });

  it("未設定（undefined / 空文字）は既定値を返し warn しない（正常系）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveWindowDaysEnv(undefined, 30, "LOG_RETENTION_DAYS")).toBe(30);
    expect(resolveWindowDaysEnv("", 30, "LOG_RETENTION_DAYS")).toBe(30);
    expect(resolveWindowDaysEnv("   ", 30, "LOG_RETENTION_DAYS")).toBe(30);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([undefined, "./project-store", join(tmpdir(), "central-store")])(
    "MCP getMemoryPathとhook resolverが同じ保存先を返す（MEMORY_DIR=%s）",
    async (memoryDir) => {
      const previousMemoryDir = process.env.MEMORY_DIR;
      const homeDir = mkdtempSync(join(tmpdir(), "wasurenagusa-config-home-"));
      if (memoryDir === undefined) {
        delete process.env.MEMORY_DIR;
        mkdirSync(join(homeDir, ".wasurenagusa"), { recursive: true });
        writeFileSync(join(homeDir, ".wasurenagusa", ".env"), "MEMORY_DIR=home-store\n");
      } else {
        process.env.MEMORY_DIR = memoryDir;
      }
      vi.resetModules();

      try {
        const { getMemoryPath } = await import("./config.js");
        const projectRoot = join(tmpdir(), "wasurenagusa-config-project");
        // MCP と hook の一致だけを見る。パッケージ直下 .env の有無は実行環境で変わるため、
        // 優先順そのもの（環境変数 > パッケージ .env > ホーム .env）は resolve-store.test.ts の偽パッケージで検証する
        const expectedStore = resolveHookStore(projectRoot, import.meta.url, memoryDir, homeDir);
        expect(getMemoryPath(projectRoot, homeDir)).toBe(expectedStore);
        expect(resolveHookStore(projectRoot, import.meta.url, memoryDir, homeDir)).toBe(expectedStore);
      } finally {
        rmSync(homeDir, { recursive: true, force: true });
        if (previousMemoryDir === undefined) {
          delete process.env.MEMORY_DIR;
        } else {
          process.env.MEMORY_DIR = previousMemoryDir;
        }
      }
    },
  );

  it("dotenvで他の設定を読みつつMEMORY_DIRはprocess.envへ混入させない", async () => {
    const previousMemoryDir = process.env.MEMORY_DIR;
    const testEnvKey = "T3_CONFIG_DOTENV_TEST";
    const previousTestEnv = process.env[testEnvKey];
    delete process.env.MEMORY_DIR;
    delete process.env[testEnvKey];
    vi.mocked(dotenvConfig).mockImplementation((options) => {
      const parsed = {
        MEMORY_DIR: join(tmpdir(), "dotenv-central-store"),
        [testEnvKey]: "loaded-from-dotenv",
      };
      const processEnv = options?.processEnv;
      if (processEnv === undefined) {
        throw new Error("Expected config to receive processEnv");
      }
      for (const [key, value] of Object.entries(parsed)) {
        if (processEnv[key] === undefined) {
          processEnv[key] = value;
        }
      }
      return { parsed };
    });
    vi.resetModules();

    try {
      const { config: loadedConfig } = await import("./config.js");
      expect(process.env.MEMORY_DIR).toBeUndefined();
      expect(process.env[testEnvKey]).toBe("loaded-from-dotenv");
      expect(loadedConfig.memoryDir).toBe(".wasurenagusa");
    } finally {
      if (previousMemoryDir === undefined) {
        delete process.env.MEMORY_DIR;
      } else {
        process.env.MEMORY_DIR = previousMemoryDir;
      }
      if (previousTestEnv === undefined) {
        delete process.env[testEnvKey];
      } else {
        process.env[testEnvKey] = previousTestEnv;
      }
    }
  });
});
