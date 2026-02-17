import { spawn, execFile } from "node:child_process";
import { ExecutionResult, ClaudeCliOptions } from "../types.js";

const DEFAULT_OPTIONS: ClaudeCliOptions = {
  maxTurns: 50,
  allowedTools: ["Edit", "Write", "Read", "Glob", "Grep"],
  timeoutMs: 600000,
};

function buildCleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("CLAUDE")) {
      env[k] = v;
    }
  }
  return env;
}

function spawnClaude(
  args: string[],
  options: { cwd?: string; timeoutMs: number },
): Promise<ExecutionResult> {
  const start = Date.now();

  return new Promise<ExecutionResult>((resolve) => {
    const child = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: options.cwd,
      env: buildCleanEnv(),
    });

    child.stdin.end();

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      resolve({
        exitCode: killed ? 1 : (code ?? 1),
        stdout,
        stderr,
        durationMs,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      resolve({
        exitCode: 1,
        stdout,
        stderr: err.message,
        durationMs,
      });
    });
  });
}

export class Executor {
  async runSpecUpdate(
    prompt: string,
    cwd: string,
    options?: Partial<ClaudeCliOptions>
  ): Promise<ExecutionResult> {
    const merged = { ...DEFAULT_OPTIONS, ...options };
    const args = [
      "-p",
      prompt,
      "--max-turns",
      String(merged.maxTurns),
      "--allowedTools",
      merged.allowedTools.join(","),
    ];

    return spawnClaude(args, { cwd, timeoutMs: merged.timeoutMs });
  }

  async ping(timeoutMs?: number): Promise<ExecutionResult> {
    const timeout = timeoutMs ?? 30000;
    return spawnClaude(["-p", "ping", "--max-turns", "1"], { timeoutMs: timeout });
  }

  async isClaudeAvailable(): Promise<boolean> {
    const command = process.platform === "win32" ? "where" : "which";
    return new Promise<boolean>((resolve) => {
      execFile(command, ["claude"], (error) => {
        resolve(!error);
      });
    });
  }
}
