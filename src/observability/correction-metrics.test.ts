import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  CORRECTION_HOOK_EVENT_KINDS,
  CORRECTION_REASON_CODES,
  recordCorrectionLlmCall,
  recordCorrectionMetric,
  recordCorrectionViolationMetric,
  rotateCorrectionMetrics,
} from "./correction-metrics.js";

const jstMidnightUtc = new Date("2026-10-02T15:00:00.000Z");
const zeroStageDurationsMs = {
  stdin: 0,
  position: 0,
  detect: 0,
  store: 0,
  retrieve: 0,
  render: 0,
  write: 0,
};

describe("observability/correction-metrics", () => {
  let tmpDir: string;
  let memoryPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-correction-metrics-test-"));
    memoryPath = join(tmpDir, ".wasurenagusa");
    mkdirSync(memoryPath, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("0件を含む時間・token・欠落数をJST日別JSONLへ記録し、256 bytes以内にする", async () => {
    const result = await recordCorrectionMetric(memoryPath, {
      eventKind: "UserPromptSubmit",
      durationMs: 0,
      tokens: 0,
      missingCount: 0,
      stageDurationsMs: zeroStageDurationsMs,
      eventIdHash: "a".repeat(64),
      detectorVersion: "v1.0",
      reasonCode: "ledger_unknown",
    }, jstMidnightUtc);

    expect(result).toBe("recorded");
    const filePath = join(memoryPath, "logs", "correction-metrics", "UserPromptSubmit-2026-10-03.jsonl");
    const line = readFileSync(filePath, "utf-8");
    const entry = JSON.parse(line);

    expect(entry).toEqual({
      ts: "2026-10-03T00:00:00.000+09:00",
      k: "sample",
      ms: 0,
      tok: 0,
      miss: 0,
      st: [0, 0, 0, 0, 0, 0, 0],
      hash: "a".repeat(64),
      v: "v1.0",
      reason_code: "ledger_unknown",
    });
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(256);
    expect(line).not.toMatch(/prompt|secret/i);
    expect(line).not.toContain(memoryPath);

    await expect(recordCorrectionMetric(memoryPath, {
      eventKind: "Stop",
      durationMs: Number.MAX_SAFE_INTEGER,
      tokens: Number.MAX_SAFE_INTEGER,
      missingCount: Number.MAX_SAFE_INTEGER,
      eventIdHash: "b".repeat(64),
      detectorVersion: "v999999999999.99",
      reasonCode: "always_not_emitted",
    }, jstMidnightUtc)).resolves.toBe("recorded");
    const maximumLine = readFileSync(join(memoryPath, "logs", "correction-metrics", "Stop-2026-10-03.jsonl"), "utf-8");
    expect(Buffer.byteLength(maximumLine)).toBeLessThanOrEqual(256);
  });

  it("違反数をk=violationで記録し、本文を出力しない", async () => {
    await expect(recordCorrectionViolationMetric(memoryPath, jstMidnightUtc)).resolves.toBe("recorded");

    const filePath = join(memoryPath, "logs", "correction-metrics", "Stop-2026-10-03.jsonl");
    const line = readFileSync(filePath, "utf-8");
    expect(JSON.parse(line)).toEqual({
      ts: "2026-10-03T00:00:00.000+09:00",
      k: "violation",
    });
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(256);
  });

  it("抽象化のCodex呼び出しを本文なしの専用カウンタへ1件記録する", async () => {
    await recordCorrectionLlmCall(memoryPath, jstMidnightUtc);

    const countersPath = join(memoryPath, "logs", "counters-2026-10-03.jsonl");
    const entries = readFileSync(countersPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
    expect(entries).toEqual([{
      ts: "2026-10-03T00:00:00.000+09:00",
      metric: "correction_llm_call",
      value: 1,
    }]);
  });

  it("設計書にある理由コードを許可する", async () => {
    expect(CORRECTION_REASON_CODES).toContain("automated_prompt");
    for (const reasonCode of CORRECTION_REASON_CODES) {
      await expect(recordCorrectionMetric(memoryPath, {
        eventKind: "Stop",
        durationMs: 1,
        tokens: 0,
        missingCount: 0,
        reasonCode,
      }, jstMidnightUtc)).resolves.toBe("recorded");
    }

    const filePath = join(memoryPath, "logs", "correction-metrics", "Stop-2026-10-03.jsonl");
    const reasons = readFileSync(filePath, "utf-8").trim().split("\n").map((line) => JSON.parse(line).reason_code);
    expect(reasons).toEqual(CORRECTION_REASON_CODES);
  });

  it("UserPromptSubmitとSessionStartは段別時間を必須にし、7段を短いst配列で保存する", async () => {
    await expect(recordCorrectionMetric(memoryPath, {
      eventKind: "UserPromptSubmit",
      durationMs: 12,
      tokens: 3,
      missingCount: 1,
    }, jstMidnightUtc)).rejects.toThrow();

    await expect(recordCorrectionMetric(memoryPath, {
      eventKind: "SessionStart",
      durationMs: 12,
      tokens: 3,
      missingCount: 1,
      stageDurationsMs: {
        stdin: 1,
        position: 2,
        detect: 3,
        store: 4,
        retrieve: 5,
        render: 6,
        write: 7,
      },
    }, jstMidnightUtc)).resolves.toBe("recorded");

    const line = readFileSync(join(memoryPath, "logs", "correction-metrics", "SessionStart-2026-10-03.jsonl"), "utf-8");
    const entry = JSON.parse(line);
    expect(entry.st).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(entry).toMatchObject({ ms: 12, tok: 3, miss: 1 });
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(256);

    await expect(recordCorrectionMetric(memoryPath, {
      eventKind: "UserPromptSubmit",
      durationMs: 3500,
      tokens: 5000,
      missingCount: 999,
      stageDurationsMs: {
        stdin: 3500,
        position: 3500,
        detect: 3500,
        store: 3500,
        retrieve: 3500,
        render: 3500,
        write: 3500,
      },
      eventIdHash: "b".repeat(64),
      detectorVersion: "v999999999999.99",
      reasonCode: "automated_prompt",
    }, jstMidnightUtc)).resolves.toBe("recorded");
    const maximumStageLine = readFileSync(
      join(memoryPath, "logs", "correction-metrics", "UserPromptSubmit-2026-10-03.jsonl"),
      "utf-8",
    ).trim().split("\n")[0];
    expect(Buffer.byteLength(maximumStageLine)).toBeLessThanOrEqual(256);
  });

  it("4種のhookイベントを別々のJST日別JSONLへ保存する", async () => {
    for (const eventKind of CORRECTION_HOOK_EVENT_KINDS) {
      await expect(recordCorrectionMetric(memoryPath, {
        eventKind,
        durationMs: 0,
        tokens: 0,
        missingCount: 0,
        ...(eventKind === "SessionStart" || eventKind === "UserPromptSubmit"
          ? { stageDurationsMs: zeroStageDurationsMs }
          : {}),
      }, jstMidnightUtc)).resolves.toBe("recorded");
    }

    for (const eventKind of CORRECTION_HOOK_EVENT_KINDS) {
      expect(existsSync(join(memoryPath, "logs", "correction-metrics", `${eventKind}-2026-10-03.jsonl`))).toBe(true);
    }
  });

  it("未知の本文フィールドとID以外の文字列を拒否し、入力値を出力しない", async () => {
    await expect(recordCorrectionMetric(memoryPath, {
      eventKind: "UserPromptSubmit",
      durationMs: 1,
      tokens: 0,
      missingCount: 0,
      body: "synthetic private utterance",
    } as never, jstMidnightUtc)).rejects.toThrow();

    await expect(recordCorrectionMetric(memoryPath, {
      eventKind: "UserPromptSubmit",
      durationMs: 1,
      tokens: 0,
      missingCount: 0,
      eventIdHash: "synthetic-private-path",
    }, jstMidnightUtc)).rejects.toThrow();

    await expect(recordCorrectionMetric(memoryPath, {
      eventKind: "UserPromptSubmit",
      durationMs: 1,
      tokens: 0,
      missingCount: 0,
      detectorVersion: "synthetic secret value",
    }, jstMidnightUtc)).rejects.toThrow();

    expect(existsSync(join(memoryPath, "logs", "correction-metrics"))).toBe(false);
  });

  it("書き込み失敗は1行で記録し、保存先の絶対パスをstderrへ出さない", async () => {
    const logsPath = join(memoryPath, "logs");
    mkdirSync(logsPath, { recursive: true });
    writeFileSync(join(logsPath, "correction-metrics"), "synthetic blocker");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(recordCorrectionMetric(memoryPath, {
      eventKind: "Stop",
      durationMs: 0,
      tokens: 0,
      missingCount: 0,
    }, jstMidnightUtc)).resolves.toBe("failed");

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(memoryPath);
    errorSpy.mockRestore();
  });

  it("イベント種別ごとに日1000標本で止め、超過を省略数として記録する", async () => {
    const input = {
      eventKind: "UserPromptSubmit" as const,
      durationMs: 0,
      tokens: 0,
      missingCount: 0,
      stageDurationsMs: zeroStageDurationsMs,
    };

    for (let index = 0; index < 1000; index++) {
      await expect(recordCorrectionMetric(memoryPath, input, jstMidnightUtc)).resolves.toBe("recorded");
    }

    const overflowResults = await Promise.all([
      recordCorrectionMetric(memoryPath, input, jstMidnightUtc),
      recordCorrectionMetric(memoryPath, input, jstMidnightUtc),
    ]);
    expect(overflowResults).toEqual(["omitted", "omitted"]);
    await expect(recordCorrectionMetric(memoryPath, {
      ...input,
      eventKind: "Stop",
    }, jstMidnightUtc)).resolves.toBe("recorded");
    await expect(recordCorrectionMetric(memoryPath, input, new Date("2026-10-03T15:00:00.000Z"))).resolves.toBe("recorded");

    const firstDayPath = join(memoryPath, "logs", "correction-metrics", "UserPromptSubmit-2026-10-03.jsonl");
    const entries = readFileSync(firstDayPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
    expect(entries.filter((entry) => entry.k === "sample")).toHaveLength(1000);
    expect(entries.filter((entry) => entry.k === "omitted")).toEqual([
      {
        ts: "2026-10-03T00:00:00.000+09:00",
        k: "omitted",
        total_count: 1001,
        omitted_count: 1,
      },
      {
        ts: "2026-10-03T00:00:00.000+09:00",
        k: "omitted",
        total_count: 1002,
        omitted_count: 2,
      },
    ]);
    for (const entry of entries.filter((item) => item.k === "omitted")) {
      expect(entry).not.toHaveProperty("ms");
      expect(entry).not.toHaveProperty("tok");
      expect(entry).not.toHaveProperty("miss");
    }
  });

  it("30日より古い専用ログだけを回転し、隣接ログを残す", async () => {
    const metricsDir = join(memoryPath, "logs", "correction-metrics");
    mkdirSync(metricsDir, { recursive: true });
    const expiredPath = join(metricsDir, "SessionStart-2026-09-03.jsonl");
    const retainedPath = join(metricsDir, "SessionStart-2026-09-04.jsonl");
    const unrelatedPath = join(metricsDir, "notes.jsonl");
    const countersPath = join(memoryPath, "logs", "counters-2026-09-03.jsonl");
    writeFileSync(expiredPath, "{}\n");
    writeFileSync(retainedPath, "{}\n");
    writeFileSync(unrelatedPath, "{}\n");
    writeFileSync(countersPath, "{}\n");

    await expect(rotateCorrectionMetrics(memoryPath, new Date("2026-10-03T15:00:00.000Z"))).resolves.toBe(1);

    expect(existsSync(expiredPath)).toBe(false);
    expect(existsSync(retainedPath)).toBe(true);
    expect(existsSync(unrelatedPath)).toBe(true);
    expect(existsSync(countersPath)).toBe(true);
  });
});
