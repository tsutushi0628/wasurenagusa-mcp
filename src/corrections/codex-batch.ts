import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { recordCorrectionLlmCall } from "../observability/correction-metrics.js";

const MINIMUM_REMAINING_QUOTA_PCT = 30;
const QUOTA_TIMEOUT_MS = 10_000;
const QUOTA_MAX_BUFFER_BYTES = 64 * 1024;
const CODEX_TIMEOUT_MS = 20 * 60 * 1000;
const CODEX_KILL_GRACE_MS = 5_000;
const CODEX_STDERR_MAX_BYTES = 2 * 1024;
const RUN_ID_PATTERN = /^[A-Za-z0-9._-]{1,80}$/u;

export interface CodexAbstractionBatchInput {
  prompt: string;
  memoryPath: string;
  runId: string;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface CodexAbstractionBatchResult {
  status: "called" | "skipped" | "failed";
  calls: 0 | 1;
  output: string | null;
  skippedReason: string | null;
  quotaBeforePct: number | null;
  quotaAfterPct: number | null;
  failureReason: string | null;
}

interface QuotaSnapshot {
  status: "available" | "unknown" | "reached";
  remainingPct: number | null;
  usedPct: number | null;
  failureReason: string | null;
}

interface CodexInvocationResult {
  status: "succeeded" | "failed" | "timeout";
  stderrTail: string;
}

function sanitizedChildEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowedKeys = [
    "PATH",
    "HOME",
    "CODEX_HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "TERM",
    "NO_COLOR",
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
  ];
  const result: NodeJS.ProcessEnv = {};
  for (const key of allowedKeys) {
    const value = env[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findRemainingPercent(value: unknown): number | null {
  if (!isRecord(value)) return null;
  const remainingEntry = Object.entries(value).find(([key, entry]) =>
    /remaining.*(?:pct|percent|percentage)|(?:pct|percent|percentage).*remaining/iu.test(key)
      && typeof entry === "number");
  if (remainingEntry) {
    const percent = remainingEntry[1] as number;
    return Number.isFinite(percent) && percent >= 0 && percent <= 100 ? percent : null;
  }
  for (const entry of Object.values(value)) {
    if (Array.isArray(entry)) {
      for (const nested of entry) {
        const percent = findRemainingPercent(nested);
        if (percent !== null) return percent;
      }
      continue;
    }
    const percent = findRemainingPercent(entry);
    if (percent !== null) return percent;
  }
  const remaining = value.remaining;
  const limit = value.limit;
  if (typeof remaining === "number" && typeof limit === "number" && limit > 0) {
    const percent = (remaining / limit) * 100;
    return Number.isFinite(percent) && percent >= 0 && percent <= 100 ? percent : null;
  }
  return null;
}

function findUsedPercent(value: unknown): number | null {
  if (!isRecord(value)) return null;
  const usedEntry = Object.entries(value).find(([key, entry]) =>
    /used.*(?:pct|percent|percentage)|(?:pct|percent|percentage).*used/iu.test(key)
      && typeof entry === "number");
  if (usedEntry) {
    const percent = usedEntry[1] as number;
    return Number.isFinite(percent) && percent >= 0 && percent <= 100 ? percent : null;
  }
  for (const entry of Object.values(value)) {
    if (Array.isArray(entry)) {
      for (const nested of entry) {
        const percent = findUsedPercent(nested);
        if (percent !== null) return percent;
      }
      continue;
    }
    const percent = findUsedPercent(entry);
    if (percent !== null) return percent;
  }
  return null;
}

function hasQuotaStatus(value: unknown, status: string): boolean {
  if (!isRecord(value)) return false;
  for (const [key, entry] of Object.entries(value)) {
    if ((key === "status" || key === "state") && entry === status) return true;
    if (Array.isArray(entry)) {
      if (entry.some((nested) => hasQuotaStatus(nested, status))) return true;
    } else if (hasQuotaStatus(entry, status)) {
      return true;
    }
  }
  return false;
}

function hasReachedQuota(value: unknown): boolean {
  if (!isRecord(value)) return false;
  for (const [key, entry] of Object.entries(value)) {
    if ((key === "reached" || key === "quota_reached") && entry === true) return true;
    if (Array.isArray(entry)) {
      if (entry.some(hasReachedQuota)) return true;
    } else if (hasReachedQuota(entry)) {
      return true;
    }
  }
  return false;
}

function readQuotaSnapshot(env: NodeJS.ProcessEnv): QuotaSnapshot {
  const quotaCommand = env.WASURENAGUSA_CODEX_QUOTA_CMD?.trim();
  if (!quotaCommand) {
    return { status: "unknown", remainingPct: null, usedPct: null, failureReason: "quota_command_missing" };
  }
  if (!isAbsolute(quotaCommand)) {
    return { status: "unknown", remainingPct: null, usedPct: null, failureReason: "quota_command_failed" };
  }
  const isPythonScript = quotaCommand.toLowerCase().endsWith(".py");
  const quotaProgram = isPythonScript ? "python3" : quotaCommand;
  const quotaArguments = isPythonScript ? [quotaCommand, "--json"] : ["--json"];
  let output: string;
  try {
    output = execFileSync(quotaProgram, quotaArguments, {
      encoding: "utf8",
      timeout: QUOTA_TIMEOUT_MS,
      maxBuffer: QUOTA_MAX_BUFFER_BYTES,
      env: sanitizedChildEnvironment(env),
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return { status: "unknown", remainingPct: null, usedPct: null, failureReason: "quota_command_failed" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return { status: "unknown", remainingPct: null, usedPct: null, failureReason: "quota_command_failed" };
  }
  if (hasQuotaStatus(parsed, "unknown")) {
    return { status: "unknown", remainingPct: null, usedPct: null, failureReason: "quota_unknown" };
  }
  const remainingPct = findRemainingPercent(parsed);
  const usedPct = findUsedPercent(parsed) ?? (remainingPct === null ? null : 100 - remainingPct);
  if (hasReachedQuota(parsed) || hasQuotaStatus(parsed, "reached")) {
    return { status: "reached", remainingPct, usedPct, failureReason: "quota_reached" };
  }
  if (remainingPct === null) {
    return { status: "unknown", remainingPct: null, usedPct, failureReason: "quota_unknown" };
  }
  if (remainingPct < MINIMUM_REMAINING_QUOTA_PCT) {
    return { status: "available", remainingPct, usedPct, failureReason: "quota_below_threshold" };
  }
  return { status: "available", remainingPct, usedPct, failureReason: null };
}

function skippedResult(snapshot: QuotaSnapshot): CodexAbstractionBatchResult {
  return {
    status: "skipped",
    calls: 0,
    output: null,
    skippedReason: snapshot.failureReason ?? "quota_unknown",
    quotaBeforePct: snapshot.usedPct,
    quotaAfterPct: null,
    failureReason: null,
  };
}

async function invokeCodex(
  codexPath: string,
  prompt: string,
  workDirectory: string,
  outputPath: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<CodexInvocationResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    let stderrTail = Buffer.alloc(0);
    const child = spawn(codexPath, [
      "exec",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "-C",
      workDirectory,
      "-o",
      outputPath,
      "-",
    ], {
      cwd: workDirectory,
      env: sanitizedChildEnvironment(env),
      stdio: ["pipe", "ignore", "pipe"],
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (chunk.length >= CODEX_STDERR_MAX_BYTES) {
        stderrTail = Buffer.from(chunk.subarray(-CODEX_STDERR_MAX_BYTES));
        return;
      }
      const retainedBytes = Math.min(stderrTail.length, CODEX_STDERR_MAX_BYTES - chunk.length);
      stderrTail = Buffer.concat([
        stderrTail.subarray(stderrTail.length - retainedBytes),
        chunk,
      ], retainedBytes + chunk.length);
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), CODEX_KILL_GRACE_MS);
    }, timeoutMs);
    const finish = (status: CodexInvocationResult["status"]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer !== undefined) clearTimeout(killTimer);
      resolve({ status, stderrTail: stderrTail.toString("utf8").trim() });
    };
    child.once("error", () => finish("failed"));
    child.once("close", (code) => {
      if (timedOut) {
        finish("timeout");
        return;
      }
      finish(code === 0 ? "succeeded" : "failed");
    });
    child.stdin.end(prompt, "utf8");
  });
}

function codexFailureReason(invocation: CodexInvocationResult): string {
  const reason = invocation.status === "timeout" ? "codex_timeout" : "codex_execution_failed";
  if (invocation.stderrTail === "") return reason;
  return `${reason}: ${invocation.stderrTail}`;
}

export async function runCodexAbstractionBatch(
  input: CodexAbstractionBatchInput,
): Promise<CodexAbstractionBatchResult> {
  if (!RUN_ID_PATTERN.test(input.runId)) throw new Error("correction abstraction run id is invalid");
  const env = input.env ?? process.env;
  const codexPath = env.WASURENAGUSA_CODEX_BIN?.trim();
  if (!codexPath || !isAbsolute(codexPath)) {
    return {
      status: "failed",
      calls: 0,
      output: null,
      skippedReason: null,
      quotaBeforePct: null,
      quotaAfterPct: null,
      failureReason: "codex_binary_missing",
    };
  }

  const quotaBefore = readQuotaSnapshot(env);
  if (quotaBefore.status !== "available" || quotaBefore.failureReason !== null) {
    return skippedResult(quotaBefore);
  }

  const workDirectory = join(input.memoryPath, "tmp", "abstraction", input.runId);
  const outputPath = join(workDirectory, "output.txt");
  try {
    await mkdir(join(input.memoryPath, "tmp", "abstraction"), { recursive: true, mode: 0o700 });
    await mkdir(workDirectory, { mode: 0o700 });
  } catch {
    return {
      status: "failed",
      calls: 0,
      output: null,
      skippedReason: null,
      quotaBeforePct: quotaBefore.usedPct,
      quotaAfterPct: null,
      failureReason: "codex_workspace_failed",
    };
  }

  const at = input.now ?? new Date();
  await recordCorrectionLlmCall(input.memoryPath, at);
  const invocation = await invokeCodex(
    codexPath,
    input.prompt,
    workDirectory,
    outputPath,
    env,
    input.timeoutMs ?? CODEX_TIMEOUT_MS,
  );
  const quotaAfter = readQuotaSnapshot(env);
  if (invocation.status !== "succeeded") {
    return {
      status: "failed",
      calls: 1,
      output: null,
      skippedReason: null,
      quotaBeforePct: quotaBefore.usedPct,
      quotaAfterPct: quotaAfter.usedPct,
      failureReason: codexFailureReason(invocation),
    };
  }

  try {
    const output = await readFile(outputPath, "utf8");
    return {
      status: "called",
      calls: 1,
      output,
      skippedReason: null,
      quotaBeforePct: quotaBefore.usedPct,
      quotaAfterPct: quotaAfter.usedPct,
      failureReason: null,
    };
  } catch {
    return {
      status: "failed",
      calls: 1,
      output: null,
      skippedReason: null,
      quotaBeforePct: quotaBefore.usedPct,
      quotaAfterPct: quotaAfter.usedPct,
      failureReason: "codex_output_missing",
    };
  }
}
