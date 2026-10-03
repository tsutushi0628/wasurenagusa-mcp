import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";
import { initializeCorrectionSchema } from "./correction-schema.js";
import { getSchemaVersion, initializeSchema } from "./schema.js";

const correctionTables = [
  "owner_correction_events",
  "owner_correction_evidence",
  "owner_correction_pending",
  "owner_correction_bundles",
  "owner_correction_versions",
  "owner_correction_sessions",
  "owner_correction_injections",
  "owner_correction_imports",
];

function tableNames(db: Database.Database): string[] {
  return (db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'owner_correction_%' ORDER BY name")
    .all() as Array<{ name: string }>).map((row) => row.name);
}

function foreignKeys(db: Database.Database, table: string): Array<{ table: string; from: string; to: string }> {
  return db.prepare("PRAGMA foreign_key_list(" + table + ")").all() as Array<{
    table: string;
    from: string;
    to: string;
  }>;
}

function insertEvent(db: Database.Database, eventId: string, excerpt: string, previousAction: string): void {
  db.prepare(
    "INSERT INTO owner_correction_events (event_id, session_id_hash, human_ordinal, observed_at, available_at, source_kind, excerpt, previous_action, project, scope, raw_text_hash, source_locator_hash, processed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(eventId, "session-hash", 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "user", excerpt, previousAction, "fixture", "project", "raw-hash", "locator-hash", "2026-01-01T00:00:00Z");
}

function insertBundle(db: Database.Database, bundleKey: string, ruleText: string): void {
  db.prepare(
    "INSERT INTO owner_correction_bundles (bundle_key, rule_text, topic_key, polarity, condition_key, project, scope, visibility, status, intensity, occurrence_count, session_count, first_seen_at, last_seen_at, lifetime_kind, continuation_basis, version, confirmation_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(bundleKey, ruleText, "topic", "negative", "condition", "fixture", "project", "project", "candidate", 1, 1, 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "task", "single_request", 1, "none");
}

describe("owner correction schema", () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-correction-schema-test-"));
    db = new Database(join(tmpDir, "memory.db"));
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("明示初期化で8表を作り、版を11にする", () => {
    initializeCorrectionSchema(db);

    expect(tableNames(db)).toEqual(correctionTables.slice().sort());
    expect(getSchemaVersion(db)).toBe(11);
  });

  it("発話と束を根拠表で多対多にし、発話表へbundle_keyを持たせない", () => {
    initializeCorrectionSchema(db);

    const eventColumns = db
      .prepare("PRAGMA table_info(owner_correction_events)")
      .all() as Array<{ name: string }>;
    expect(eventColumns.map((column) => column.name)).not.toContain("bundle_key");

    const evidenceColumns = db
      .prepare("PRAGMA table_info(owner_correction_evidence)")
      .all() as Array<{ name: string; pk: number }>;
    expect(evidenceColumns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name))
      .toEqual(["event_id", "bundle_key"]);
    expect(foreignKeys(db, "owner_correction_evidence").map((key) => key.table))
      .toEqual(expect.arrayContaining(["owner_correction_events", "owner_correction_bundles"]));
  });

  it("pending照合と版参照を外部キーで保つ", () => {
    initializeCorrectionSchema(db);

    expect(foreignKeys(db, "owner_correction_pending").map((key) => [key.from, key.table, key.to]))
      .toContainEqual(["matched_event_id", "owner_correction_events", "event_id"]);
    expect(foreignKeys(db, "owner_correction_versions").map((key) => [key.from, key.table, key.to]))
      .toContainEqual(["bundle_key", "owner_correction_bundles", "bundle_key"]);
    const injectionKeys = foreignKeys(db, "owner_correction_injections");
    expect(injectionKeys.map((key) => [key.from, key.table, key.to]))
      .toEqual(expect.arrayContaining([
        ["bundle_key", "owner_correction_versions", "bundle_key"],
        ["version", "owner_correction_versions", "version"],
      ]));
  });

  it("文字数上限ちょうどを受け入れ、超過を拒否する", () => {
    initializeCorrectionSchema(db);

    expect(() => insertEvent(db, "event-120", "x".repeat(120), "x".repeat(160))).not.toThrow();
    expect(() => insertEvent(db, "event-121", "x".repeat(121), "")).toThrow();
    expect(() => insertEvent(db, "event-161", "", "x".repeat(161))).toThrow();
    expect(() => insertEvent(db, "event-empty", "", "")).not.toThrow();

    expect(() => insertBundle(db, "bundle-240", "x".repeat(240))).not.toThrow();
    expect(() => insertBundle(db, "bundle-241", "x".repeat(241))).toThrow();
  });

  it("1発話あたりの根拠を3束までに制限する", () => {
    initializeCorrectionSchema(db);
    insertEvent(db, "event-1", "synthetic", "synthetic action");

    const insertEvidence = db.prepare(
      "INSERT INTO owner_correction_evidence (event_id, bundle_key, source, score, detector_version, conditions, polarity) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (let index = 1; index <= 3; index++) {
      const bundleKey = "bundle-" + index;
      insertBundle(db, bundleKey, "rule");
      expect(() => insertEvidence.run("event-1", bundleKey, "utterance_detection", 2, "v1", "[]", "negative"))
        .not.toThrow();
    }

    insertBundle(db, "bundle-4", "rule");
    expect(() => insertEvidence.run("event-1", "bundle-4", "utterance_detection", 2, "v1", "[]", "negative"))
      .toThrow();
  });
});
