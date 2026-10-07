import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCodexAbstractionBatch } from "./codex-batch.js";

describe("codex abstraction batch", () => {
  let directory: string;
  let memoryPath: string;
  let codexPath: string;
  let quotaPath: string;
  let quotaCountPath: string;
  let quotaSequencePath: string;
  let quotaFailurePath: string;
  let argsPath: string;
  let promptPath: string;
  let outputPath: string;
  let sleepPath: string;
  let stderrPath: string;
  let exitCodePath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "wasurenagusa-codex-batch-test-"));
    memoryPath = join(directory, ".wasurenagusa");
    quotaCountPath = join(directory, "quota-count.txt");
    quotaSequencePath = join(directory, "quota-sequence.json");
    quotaFailurePath = join(directory, "quota-failure");
    argsPath = join(directory, "codex-args.json");
    promptPath = join(directory, "codex-prompt.txt");
    outputPath = join(directory, "codex-output.txt");
    sleepPath = join(directory, "codex-sleep-ms.txt");
    stderrPath = join(directory, "codex-stderr.txt");
    exitCodePath = join(directory, "codex-exit-code.txt");
    quotaPath = writeExecutable("quota-stub.mjs", `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
if (process.argv.at(-1) !== "--json") process.exit(80);
const directory = dirname(fileURLToPath(import.meta.url));
const countPath = join(directory, "quota-count.txt");
const count = existsSync(countPath) ? Number(readFileSync(countPath, "utf8")) : 0;
writeFileSync(countPath, String(count + 1));
if (existsSync(join(directory, "quota-failure"))) process.exit(1);
const sequence = JSON.parse(readFileSync(join(directory, "quota-sequence.json"), "utf8"));
process.stdout.write(JSON.stringify(sequence[Math.min(count, sequence.length - 1)]));
`);
    codexPath = writeExecutable("codex-stub.mjs", `
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const directory = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const outputIndex = args.indexOf("-o");
if (args[0] !== "exec" || outputIndex < 0 || args.at(-1) !== "-"
  || args.includes("--ephemeral") || args.includes("-m") || readdirSync(process.cwd()).length !== 0) process.exit(81);
const input = await new Promise((resolve, reject) => {
  let value = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => value += chunk);
  process.stdin.on("end", () => resolve(value));
  process.stdin.on("error", reject);
});
writeFileSync(join(directory, "codex-args.json"), JSON.stringify(args));
writeFileSync(join(directory, "codex-prompt.txt"), input);
if (existsSync(join(directory, "codex-stderr.txt"))) {
  process.stderr.write(readFileSync(join(directory, "codex-stderr.txt"), "utf8"));
  process.exit(Number(readFileSync(join(directory, "codex-exit-code.txt"), "utf8")));
}
if (existsSync(join(directory, "codex-sleep-ms.txt"))) {
  const sleepMs = Number(readFileSync(join(directory, "codex-sleep-ms.txt"), "utf8"));
  await new Promise((resolve) => setTimeout(resolve, sleepMs));
}
writeFileSync(args[outputIndex + 1], readFileSync(join(directory, "codex-output.txt"), "utf8"));
`);
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function writeExecutable(name: string, body: string): string {
    const scriptPath = join(directory, name);
    writeFileSync(scriptPath, `#!/usr/bin/env node\n${body}`, { mode: 0o700 });
    chmodSync(scriptPath, 0o700);
    return scriptPath;
  }

  function env(quotaSequence: unknown[], extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    writeFileSync(quotaSequencePath, JSON.stringify(quotaSequence));
    if (extra.STUB_QUOTA_FAILURE === "1") writeFileSync(quotaFailurePath, "synthetic failure");
    if (extra.STUB_CODEX_OUTPUT !== undefined) writeFileSync(outputPath, extra.STUB_CODEX_OUTPUT);
    if (extra.STUB_CODEX_SLEEP_MS !== undefined) writeFileSync(sleepPath, extra.STUB_CODEX_SLEEP_MS);
    if (extra.STUB_CODEX_STDERR !== undefined) writeFileSync(stderrPath, extra.STUB_CODEX_STDERR);
    if (extra.STUB_CODEX_EXIT_CODE !== undefined) writeFileSync(exitCodePath, extra.STUB_CODEX_EXIT_CODE);
    return {
      WASURENAGUSA_CODEX_BIN: codexPath,
      WASURENAGUSA_CODEX_QUOTA_CMD: quotaPath,
      PATH: process.env.PATH ?? "",
      HOME: directory,
    };
  }

  it("30%では1回だけread-only Codexを呼び、stdin・出力先・枠前後差を記録する", async () => {
    const before = { status: "ok", reached: false, remaining_pct: 30, used_percent: 70 };
    const after = { status: "ok", reached: false, remaining_pct: 27, used_percent: 73 };

    const result = await runCodexAbstractionBatch({
      prompt: "synthetic abstraction prompt",
      memoryPath,
      runId: "run-30-percent",
      now: new Date("2026-10-03T04:00:00.000Z"),
      env: env([before, after], { STUB_CODEX_OUTPUT: JSON.stringify([{ group_id: "g-0001" }]) }),
    });

    expect(result).toMatchObject({
      status: "called",
      calls: 1,
      quotaBeforePct: 70,
      quotaAfterPct: 73,
      skippedReason: null,
      failureReason: null,
    });
    const args = JSON.parse(readFileSync(argsPath, "utf8")) as string[];
    expect(args).toEqual([
      "exec", "--sandbox", "read-only", "--skip-git-repo-check", "-C",
      join(memoryPath, "tmp", "abstraction", "run-30-percent"), "-o",
      join(memoryPath, "tmp", "abstraction", "run-30-percent", "output.txt"), "-",
    ]);
    expect(readFileSync(promptPath, "utf8")).toBe("synthetic abstraction prompt");
    expect(Number(readFileSync(quotaCountPath, "utf8"))).toBe(2);
    const metricPath = join(memoryPath, "logs", "counters-2026-10-03.jsonl");
    expect(readFileSync(metricPath, "utf8")).toContain('"metric":"correction_llm_call","value":1');
  });

  it("非実行属性のPython quota scriptをpython3 --jsonで読み取る", async () => {
    const pythonQuotaPath = join(directory, "quota-stub.py");
    writeFileSync(pythonQuotaPath, `
import json
import pathlib
import sys

if sys.argv[1:] != ["--json"]:
    sys.exit(82)
sequence = json.loads(pathlib.Path(__file__).with_name("quota-sequence.json").read_text())
print(json.dumps(sequence[0]))
`);
    writeFileSync(quotaSequencePath, JSON.stringify([{ status: "ok", remaining_percent: 50, used_percent: 50 }]));

    const result = await runCodexAbstractionBatch({
      prompt: "synthetic abstraction prompt",
      memoryPath,
      runId: "python-quota-fixture",
      env: {
        ...env([{ status: "ok", remaining_percent: 50, used_percent: 50 }], {
          STUB_CODEX_OUTPUT: JSON.stringify([{ group_id: "g-0001" }]),
        }),
        WASURENAGUSA_CODEX_QUOTA_CMD: pythonQuotaPath,
      },
    });

    expect(result).toMatchObject({ status: "called", calls: 1, quotaBeforePct: 50, quotaAfterPct: 50 });
  });

  it.each([
    ["29 percent", { status: "ok", reached: false, remaining_pct: 29 }, undefined, "quota_below_threshold"],
    ["reached", { status: "ok", reached: true, remaining_pct: 80 }, undefined, "quota_reached"],
    ["reached status", { status: "reached", remaining_pct: 80 }, undefined, "quota_reached"],
    ["unknown", { status: "unknown", reached: false, remaining_pct: 80 }, undefined, "quota_unknown"],
    ["quota command failure", undefined, "1", "quota_command_failed"],
  ])("skips the Codex call for %s", async (_label, quota, fail, reason) => {
    const result = await runCodexAbstractionBatch({
      prompt: "synthetic abstraction prompt",
      memoryPath,
      runId: `skip-${String(reason)}`,
      now: new Date("2026-10-03T04:00:00.000Z"),
      env: env([quota], { ...(fail ? { STUB_QUOTA_FAILURE: fail } : {}) }),
    });

    expect(result).toMatchObject({ status: "skipped", calls: 0, skippedReason: reason });
    expect(existsSync(argsPath)).toBe(false);
    expect(existsSync(join(memoryPath, "tmp", "abstraction", `skip-${String(reason)}`))).toBe(false);
  });

  it("Codexが20分の制限を超えたら停止して1回の失敗を返す", async () => {
    const snapshot = { status: "ok", reached: false, remaining_pct: 50 };

    const result = await runCodexAbstractionBatch({
      prompt: "synthetic abstraction prompt",
      memoryPath,
      runId: "timeout-fixture",
      now: new Date("2026-10-03T04:00:00.000Z"),
      timeoutMs: 20,
      env: env([snapshot, snapshot], {
        STUB_CODEX_SLEEP_MS: "500",
        STUB_CODEX_OUTPUT: "[]",
      }),
    });

    expect(result).toMatchObject({ status: "failed", calls: 1, failureReason: "codex_timeout" });
    expect(Number(readFileSync(quotaCountPath, "utf8"))).toBe(2);
  });

  it("終了127のCodex stderr末尾を失敗理由に含め、入力や応答本文を含めない", async () => {
    const snapshot = { status: "ok", reached: false, remaining_pct: 50 };
    const diagnostic = "env: node: No such file or directory";
    const prompt = "synthetic prompt secret sentinel";
    const response = "synthetic response secret sentinel";

    const result = await runCodexAbstractionBatch({
      prompt,
      memoryPath,
      runId: "stderr-127-fixture",
      now: new Date("2026-10-03T04:00:00.000Z"),
      env: env([snapshot, snapshot], {
        STUB_CODEX_STDERR: `${"discarded diagnostic ".repeat(200)}${diagnostic}\n`,
        STUB_CODEX_EXIT_CODE: "127",
        STUB_CODEX_OUTPUT: response,
      }),
    });

    expect(result).toMatchObject({ status: "failed", calls: 1 });
    expect(result.failureReason).toContain(diagnostic);
    expect(result.failureReason).not.toContain(prompt);
    expect(result.failureReason).not.toContain(response);
    expect(result.failureReason?.length).toBeLessThanOrEqual("codex_execution_failed: ".length + 2_048);
  });
});
