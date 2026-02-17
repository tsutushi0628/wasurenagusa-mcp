import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { Executor } from "./executor.js";

// spawn用のモックChildProcess
function createMockChild() {
  const child = new EventEmitter() as any;
  child.stdin = { end: vi.fn() };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

// child_processをモック
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
}));

import { spawn, execFile } from "node:child_process";
const mockSpawn = vi.mocked(spawn);
const mockExecFile = vi.mocked(execFile);

describe("Executor", () => {
  let executor: Executor;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = new Executor();
  });

  describe("runSpecUpdate", () => {
    it("claude -p に正しいオプションで実行される", async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child as any);

      const promise = executor.runSpecUpdate(
        "test prompt",
        "/home/user/project"
      );

      // stdout出力をシミュレート
      child.stdout.emit("data", Buffer.from("update completed"));
      child.emit("close", 0);

      const result = await promise;

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const [cmd, args, opts] = mockSpawn.mock.calls[0];
      expect(cmd).toBe("claude");
      expect(args).toContain("-p");
      expect(args).toContain("test prompt");
      expect(args).toContain("--max-turns");
      expect(args).toContain("50");
      expect(args).toContain("--allowedTools");
      expect(args).toContain("Edit,Write,Read,Glob,Grep");
      expect((opts as any).cwd).toBe("/home/user/project");

      expect(child.stdin.end).toHaveBeenCalled();
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("update completed");
      expect(result.stderr).toBe("");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("タイムアウト時にプロセスがkillされ、ExecutionResultが返る", async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child as any);

      const promise = executor.runSpecUpdate(
        "test prompt",
        "/home/user/project",
        { timeoutMs: 50 }
      );

      // タイムアウト後にcloseが呼ばれる
      await new Promise((r) => setTimeout(r, 100));
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      child.emit("close", null);

      const result = await promise;
      expect(result.exitCode).toBe(1);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("非ゼロ終了コードでもクラッシュせずExecutionResultが返る", async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child as any);

      const promise = executor.runSpecUpdate(
        "test prompt",
        "/home/user/project"
      );

      child.stdout.emit("data", Buffer.from("partial output"));
      child.stderr.emit("data", Buffer.from("error output"));
      child.emit("close", 1);

      const result = await promise;
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("partial output");
      expect(result.stderr).toBe("error output");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("ping", () => {
    it('claude -p "ping" が実行される', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child as any);

      const promise = executor.ping();

      child.stdout.emit("data", Buffer.from("pong"));
      child.emit("close", 0);

      const result = await promise;

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const [cmd, args] = mockSpawn.mock.calls[0];
      expect(cmd).toBe("claude");
      expect(args).toContain("-p");
      expect(args).toContain("ping");
      expect(args).toContain("--max-turns");
      expect(args).toContain("1");

      expect(child.stdin.end).toHaveBeenCalled();
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("pong");
    });
  });

  describe("isClaudeAvailable", () => {
    it("claudeコマンドがPATHに存在する場合trueを返す", async () => {
      mockExecFile.mockImplementation((...args: any[]) => {
        const cb = args[args.length - 1];
        if (typeof cb === "function") {
          cb(null, "/usr/local/bin/claude\n", "");
        }
        return undefined as any;
      });

      const result = await executor.isClaudeAvailable();
      expect(result).toBe(true);
    });

    it("claudeコマンドが存在しない場合falseを返す", async () => {
      mockExecFile.mockImplementation((...args: any[]) => {
        const cb = args[args.length - 1];
        if (typeof cb === "function") {
          const error = new Error("not found") as any;
          error.code = 1;
          cb(error, "", "");
        }
        return undefined as any;
      });

      const result = await executor.isClaudeAvailable();
      expect(result).toBe(false);
    });
  });
});
