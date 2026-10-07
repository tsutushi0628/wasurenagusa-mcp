import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

export const DEFAULT_RECURRENCE_LEDGER_PATH = ".wasurenagusa/reports/ledger/recurrence-ledger.jsonl";

const ROW_FIELDS = ["event_hash", "session_hash", "theme_label", "recurrence", "intent_id", "klass"];
const CLASS_NAMES = ["a", "c", "e", "x", "b", "d"];
const CLASS_NAME_SET = new Set(CLASS_NAMES);
const THEME_LABEL_PATTERN = /^B(?:[1-9]|10)$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const INTENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function hashKey(eventHash, themeLabel) {
  return `${eventHash}\u0000${themeLabel}`;
}

function parseLedgerRow(value, lineNumber) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid recurrence ledger row at line ${lineNumber}`);
  }
  const keys = Object.keys(value).sort();
  const expectedKeys = [...ROW_FIELDS].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error(`invalid recurrence ledger fields at line ${lineNumber}`);
  }
  if (typeof value.event_hash !== "string" || !HASH_PATTERN.test(value.event_hash) ||
    typeof value.session_hash !== "string" || !HASH_PATTERN.test(value.session_hash) ||
    typeof value.theme_label !== "string" || !THEME_LABEL_PATTERN.test(value.theme_label) ||
    !["yes", "no"].includes(value.recurrence) ||
    typeof value.intent_id !== "string" || !INTENT_ID_PATTERN.test(value.intent_id) ||
    typeof value.klass !== "string" || !CLASS_NAME_SET.has(value.klass)) {
    throw new Error(`invalid recurrence ledger values at line ${lineNumber}`);
  }
  if (["e", "x"].includes(value.klass) && value.recurrence !== "no") {
    throw new Error(`klass ${value.klass} must have recurrence no at line ${lineNumber}`);
  }
  return value;
}

export async function readRecurrenceLedger(filePath = DEFAULT_RECURRENCE_LEDGER_PATH) {
  const resolvedPath = resolve(filePath);
  let contents;
  try {
    contents = await readFile(resolvedPath);
  } catch (error) {
    const displayPath = relative(process.cwd(), resolvedPath) || ".";
    const message = error instanceof Error && "code" in error && error.code === "ENOENT"
      ? `recurrence ledger not found: ${displayPath}`
      : `recurrence ledger could not be read: ${displayPath}`;
    throw new Error(message, { cause: error });
  }
  const rows = new Map();
  const lines = contents.toString("utf8").split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(`invalid recurrence ledger JSON at line ${index + 1}`, { cause: error });
    }
    const row = parseLedgerRow(value, index + 1);
    const key = hashKey(row.event_hash, row.theme_label);
    if (rows.has(key)) throw new Error(`duplicate recurrence ledger row at line ${index + 1}`);
    rows.set(key, row);
  }
  return {
    rows,
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

function emptyClassCounts() {
  return Object.fromEntries(CLASS_NAMES.map((klass) => [klass, 0]));
}

export function classifyRecurrenceCandidates(candidates, ledger) {
  if (!ledger || !(ledger.rows instanceof Map) || typeof ledger.sha256 !== "string" || !HASH_PATTERN.test(ledger.sha256)) {
    throw new Error("invalid recurrence ledger");
  }
  const seenCandidates = new Set();
  const denominatorCandidates = [];
  const excludedCandidates = [];
  const klassCounts = emptyClassCounts();
  const denominatorByClass = emptyClassCounts();
  const excludedByClass = emptyClassCounts();
  for (const candidate of candidates) {
    if (typeof candidate.eventId !== "string" || candidate.eventId.length === 0 ||
      typeof candidate.sessionHash !== "string" || !HASH_PATTERN.test(candidate.sessionHash) ||
      typeof candidate.bundleLabel !== "string" || !THEME_LABEL_PATTERN.test(candidate.bundleLabel)) {
      throw new Error("invalid recurrence candidate identity");
    }
    const eventHash = createHash("sha256").update(candidate.eventId).digest("hex");
    const key = hashKey(eventHash, candidate.bundleLabel);
    if (seenCandidates.has(key)) throw new Error("duplicate recurrence candidate");
    seenCandidates.add(key);
    const ledgerRow = ledger.rows.get(key);
    if (!ledgerRow) throw new Error("recurrence ledger is incomplete");
    if (ledgerRow.session_hash !== candidate.sessionHash) throw new Error("recurrence ledger session hash mismatch");
    klassCounts[ledgerRow.klass] += 1;
    if (ledgerRow.recurrence === "yes") {
      denominatorCandidates.push(candidate);
      denominatorByClass[ledgerRow.klass] += 1;
    } else {
      excludedCandidates.push(candidate);
      excludedByClass[ledgerRow.klass] += 1;
    }
  }
  return {
    denominatorCandidates,
    excludedCandidates,
    summary: {
      candidateCount: candidates.length,
      denominatorCount: denominatorCandidates.length,
      excludedCount: excludedCandidates.length,
      klassCounts,
      denominatorByClass,
      excludedByClass,
      ledgerSha256: ledger.sha256,
    },
  };
}
