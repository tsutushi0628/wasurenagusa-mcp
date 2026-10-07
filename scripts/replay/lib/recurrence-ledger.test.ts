import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyRecurrenceCandidates, DEFAULT_RECURRENCE_LEDGER_PATH, readRecurrenceLedger } from "./recurrence-ledger.mjs";
import { parseReplayArguments } from "../simulate.mjs";

const scratchRoot = join(process.cwd(), ".tmp", "fd31f1b6-ac90-4336-a1e7-260faaa28f1e", "tests");
const scratchDirectories: string[] = [];

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function createLedgerFile(rows: Array<Record<string, string>>): string {
  mkdirSync(scratchRoot, { recursive: true });
  const directory = mkdtempSync(join(scratchRoot, "recurrence-ledger-"));
  scratchDirectories.push(directory);
  const filePath = join(directory, "recurrence-ledger.jsonl");
  writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
  return filePath;
}

afterEach(() => {
  for (const directory of scratchDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("再発台帳", () => {
  it("指定された既定台帳の場所を使う", () => {
    expect(DEFAULT_RECURRENCE_LEDGER_PATH).toBe(".wasurenagusa/reports/ledger/recurrence-ledger.jsonl");
  });

  it("x・eを分母から除外し、klass別件数と台帳sha256を返す", async () => {
    const candidates = [
      { eventId: "event-a", sessionHash: hash("session-a"), bundleLabel: "B2" },
      { eventId: "event-x", sessionHash: hash("session-x"), bundleLabel: "B2" },
      { eventId: "event-e", sessionHash: hash("session-e"), bundleLabel: "B1" },
      { eventId: "event-c", sessionHash: hash("session-c"), bundleLabel: "B3" },
    ];
    const rows = [
      { event_hash: hash("event-a"), session_hash: hash("session-a"), theme_label: "B2", recurrence: "yes", intent_id: "intent-a", klass: "a" },
      { event_hash: hash("event-x"), session_hash: hash("session-x"), theme_label: "B2", recurrence: "no", intent_id: "intent-x", klass: "x" },
      { event_hash: hash("event-e"), session_hash: hash("session-e"), theme_label: "B1", recurrence: "no", intent_id: "intent-e", klass: "e" },
      { event_hash: hash("event-c"), session_hash: hash("session-c"), theme_label: "B3", recurrence: "no", intent_id: "intent-c", klass: "c" },
    ];
    const ledgerPath = createLedgerFile(rows);

    const ledger = await readRecurrenceLedger(ledgerPath);
    const result = classifyRecurrenceCandidates(candidates, ledger);

    expect(result.denominatorCandidates.map((row) => row.eventId)).toEqual(["event-a"]);
    expect(result.summary).toMatchObject({
      candidateCount: 4,
      denominatorCount: 1,
      excludedCount: 3,
      klassCounts: { a: 1, c: 1, e: 1, x: 1, b: 0, d: 0 },
      denominatorByClass: { a: 1, c: 0, e: 0, x: 0, b: 0, d: 0 },
      excludedByClass: { a: 0, c: 1, e: 1, x: 1, b: 0, d: 0 },
      ledgerSha256: hash(rows.map((row) => JSON.stringify(row)).join("\n") + "\n"),
    });
    expect(result.summary.ledgerSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("候補イベントの台帳行が欠けたら未整備として失敗する", async () => {
    const candidates = [
      { eventId: "event-present", sessionHash: hash("session-present"), bundleLabel: "B2" },
      { eventId: "event-missing", sessionHash: hash("session-missing"), bundleLabel: "B2" },
    ];
    const ledgerPath = createLedgerFile([
      { event_hash: hash("event-present"), session_hash: hash("session-present"), theme_label: "B2", recurrence: "yes", intent_id: "intent-present", klass: "a" },
    ]);

    const ledger = await readRecurrenceLedger(ledgerPath);

    expect(() => classifyRecurrenceCandidates(candidates, ledger)).toThrow("recurrence ledger is incomplete");
  });

  it("重複行とe類のrecurrence=yesを拒否する", async () => {
    const row = { event_hash: hash("event-a"), session_hash: hash("session-a"), theme_label: "B2", recurrence: "yes", intent_id: "intent-a", klass: "a" };
    const duplicatePath = createLedgerFile([row, row]);
    await expect(readRecurrenceLedger(duplicatePath)).rejects.toThrow("duplicate recurrence ledger row");

    const invalidEClassPath = createLedgerFile([
      { ...row, recurrence: "yes", klass: "e" },
    ]);
    await expect(readRecurrenceLedger(invalidEClassPath)).rejects.toThrow("klass e must have recurrence no");

    const rawTextPath = createLedgerFile([
      { ...row, text: "synthetic raw text" },
    ]);
    await expect(readRecurrenceLedger(rawTextPath)).rejects.toThrow("invalid recurrence ledger fields");
  });

  it("online再生で台帳ファイルを指定でき、他modeでは拒否する", () => {
    const commonArgs = ["--manifest", "manifest.json", "--compiled-root", ".tmp/build", "--scratch", ".tmp/online"];
    expect(parseReplayArguments([
      "--mode", "online", ...commonArgs, "--until", "2026-10-01", "--recurrence-ledger", ".wasurenagusa/ledger.jsonl",
    ])).toMatchObject({ recurrenceLedgerPath: ".wasurenagusa/ledger.jsonl" });
    expect(() => parseReplayArguments([
      "--mode", "cold", ...commonArgs, "--split", "tune", "--recurrence-ledger", ".wasurenagusa/ledger.jsonl",
    ])).toThrow("--recurrence-ledger is only valid in online mode");
  });
});
