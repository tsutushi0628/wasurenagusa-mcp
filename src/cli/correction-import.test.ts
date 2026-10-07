import Database from "better-sqlite3";
import { createHash } from "crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCorrectionImportCli } from "./correction-import.js";
import { detectOwnerCorrections } from "../corrections/detector.js";
import { extractOwnerEvent } from "../corrections/events.js";
import { correctionConditionKey, serializeCorrectionRuleInput, type CorrectionRuleInput } from "../corrections/rule-template.js";
import { migrateV10ToV11, migrateV11ToV12 } from "../storage/migration.js";
import { initializeSchema } from "../storage/schema.js";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function createDatabase(path: string): void {
  const db = new Database(path);
  initializeSchema(db);
  db.close();
}

function seedEmptyCandidate(
  db: Database.Database,
  bundleKey: string,
  commandText: string,
  options: {
    includeCommandText?: boolean;
    conditions?: string;
    plainCommandEligible?: boolean;
    detectorVersion?: string;
  } = {},
): void {
  const event = extractOwnerEvent({
    type: "user",
    origin: { kind: "human" },
    sessionId: "synthetic-session",
    message: { content: commandText },
  });
  const candidate = event ? detectOwnerCorrections(event)[0] : undefined;
  if (!candidate) throw new Error("synthetic correction candidate was not detected");
  const oldRuleInput: CorrectionRuleInput = {
    ...candidate.ruleInput,
    polarity: "positive",
    directive: false,
    plainCommandEligible: options.plainCommandEligible ?? false,
  };
  if (options.includeCommandText === false) delete oldRuleInput.commandText;
  const conditions = options.conditions ?? serializeCorrectionRuleInput(oldRuleInput);
  const at = "2026-10-07T00:00:00.000Z";
  const eventId = `${bundleKey}-event`;
  const conditionKey = correctionConditionKey(oldRuleInput);

  db.prepare(`
    INSERT INTO owner_correction_events (
      event_id, session_id_hash, source_uuid_hash, human_ordinal, observed_at, available_at, source_kind,
      excerpt, previous_action, action_first_locator_hash, action_last_locator_hash, project, scope,
      raw_text_hash, source_locator_hash, processed_at
    ) VALUES (?, 'synthetic-session-hash', NULL, 1, ?, ?, 'user', ?, '', NULL, NULL, 'synthetic',
      'synthetic', 'synthetic-hash', 'synthetic-locator', ?)
  `).run(eventId, at, at, commandText.slice(0, 120), at);
  db.prepare(`
    INSERT INTO owner_correction_bundles (
      bundle_key, memory_id, rule_text, topic_key, polarity, condition_key, project, scope, visibility,
      status, intensity, occurrence_count, session_count, first_seen_at, last_seen_at, expires_at,
      lifetime_kind, continuation_basis, confirmed_at, version, counterevidence_event_id,
      last_confirmation_asked_at, confirmation_state
    ) VALUES (?, NULL, '', ?, 'positive', ?, 'synthetic', 'synthetic', 'project', 'candidate', 1, 1, 1,
      ?, ?, NULL, ?, ?, NULL, 1, NULL, NULL, 'none')
  `).run(
    bundleKey,
    candidate.topicKey,
    conditionKey,
    at,
    at,
    candidate.lifetimeKind,
    oldRuleInput.continuationBasis,
  );
  db.prepare(`
    INSERT INTO owner_correction_versions (
      bundle_key, version, rule_text, body_hash, conditions, condition_key, polarity, visibility, status,
      confirmed_at, expires_at, lifetime_kind, continuation_basis, evidence_event_ids, effective_from,
      change_reason
    ) VALUES (?, 1, '', ?, ?, ?, 'positive', 'project', 'candidate', NULL, NULL, ?, ?, ?, ?, 'synthetic')
  `).run(
    bundleKey,
    sha256(""),
    conditions,
    conditionKey,
    candidate.lifetimeKind,
    oldRuleInput.continuationBasis,
    JSON.stringify([eventId]),
    at,
  );
  db.prepare(`
    INSERT INTO owner_correction_evidence (
      event_id, bundle_key, source, score, detector_version, conditions, polarity
    ) VALUES (?, ?, 'utterance_detection', ?, ?, ?, 'positive')
  `).run(eventId, bundleKey, candidate.score, options.detectorVersion ?? "owner-correction-v4", conditions);
}

describe("訂正記憶取込CLI", () => {
  let directory: string;
  let sourcePath: string;
  let targetPath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "correction-import-cli-"));
    sourcePath = join(directory, "source.db");
    targetPath = join(directory, "target.db");
    createDatabase(sourcePath);
    createDatabase(targetPath);
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("入力DBを指定しない引数と同一DBを拒否する", () => {
    expect(runCorrectionImportCli([], targetPath).exitCode).toBe(2);
    expect(runCorrectionImportCli(["--source", targetPath], targetPath).exitCode).toBe(1);
    expect(runCorrectionImportCli(["--source", sourcePath, "--unknown"], targetPath).exitCode).toBe(2);
  });

  it("dry-runは件数だけを出し両DBとv10版数を変えない", () => {
    const sourceDb = new Database(sourcePath);
    sourceDb.prepare(`INSERT INTO memories (id, timestamp, category, title, content, tags, state, project_confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "synthetic-cli-memory", "2025-01-02T03:04:05.000Z", "dont", "Synthetic title", "Synthetic content", "[]", "active", "unknown",
    );
    sourceDb.close();
    const sourceBefore = readFileSync(sourcePath);
    const targetBefore = readFileSync(targetPath);

    const result = runCorrectionImportCli(["--source", sourcePath], targetPath, "2026-10-03T00:00:00.000Z");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/source=1/);
    expect(result.stdout).toMatch(/add=1/);
    expect(result.stdout).toMatch(/candidate=0/);
    expect(result.stdout).toMatch(/expiry=0/);
    expect(result.stdout).not.toContain(sourcePath);
    expect(result.stdout).not.toContain("Synthetic");
    expect(readFileSync(sourcePath)).toEqual(sourceBefore);
    expect(readFileSync(targetPath)).toEqual(targetBefore);
  });

  it("v11移行のdry-runはDDLをせずapply付きだけが移行する", () => {
    const before = readFileSync(targetPath);

    const preview = runCorrectionImportCli(["--migrate-v11"], targetPath);

    expect(preview.exitCode).toBe(0);
    expect(preview.stdout).toMatch(/ddl=8/);
    expect(readFileSync(targetPath)).toEqual(before);
    const apply = runCorrectionImportCli(["--migrate-v11", "--apply"], targetPath);
    expect(apply.exitCode).toBe(0);
    expect(apply.stdout).toMatch(/schema=11/);
    const db = new Database(targetPath, { readonly: true, fileMustExist: true });
    try {
      expect(db.prepare("SELECT MAX(version) AS version FROM schema_version").get()).toEqual({ version: 11 });
    } finally {
      db.close();
    }
  });

  it("v11移行は再実行時に差分を作らない", () => {
    const migrationDb = new Database(targetPath);
    migrateV10ToV11(migrationDb);
    migrationDb.close();
    const before = readFileSync(targetPath);

    const result = runCorrectionImportCli(["--migrate-v11", "--apply"], targetPath);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/ddl=0/);
    expect(readFileSync(targetPath)).toEqual(before);
  });

  it("v12専用移行はdry-runを保ち、apply付きだけで版数を進める", () => {
    const migrationDb = new Database(targetPath);
    migrateV10ToV11(migrationDb);
    migrationDb.close();
    const before = readFileSync(targetPath);

    const preview = runCorrectionImportCli(["--migrate-v12"], targetPath);

    expect(preview.exitCode).toBe(0);
    expect(preview.stdout).toMatch(/schema=11 ddl=1/);
    expect(readFileSync(targetPath)).toEqual(before);

    const apply = runCorrectionImportCli(["--migrate-v12", "--apply"], targetPath);

    expect(apply.exitCode).toBe(0);
    expect(apply.stdout).toMatch(/schema=12 ddl=1/);
    const db = new Database(targetPath, { readonly: true, fileMustExist: true });
    try {
      expect(db.prepare("SELECT MAX(version) AS version FROM schema_version").get()).toEqual({ version: 12 });
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("owner_correction_violations")).toEqual({ name: "owner_correction_violations" });
    } finally {
      db.close();
    }
  });

  it("rule_text backfill dry-run shows counts and source-derived examples without writing", () => {
    const migrationDb = new Database(targetPath);
    migrateV10ToV11(migrationDb);
    migrateV11ToV12(migrationDb);
    seedEmptyCandidate(migrationDb, "synthetic-fill", "架空の青色試料番号を書くな。");
    seedEmptyCandidate(migrationDb, "synthetic-missing-command", "架空の青色試料番号を書くな。", { includeCommandText: false });
    seedEmptyCandidate(migrationDb, "synthetic-invalid", "架空の青色試料番号を書くな。", { conditions: "{" });
    seedEmptyCandidate(migrationDb, "synthetic-plain-fill", "今後はこの語彙では判断に迷う言葉を使うな", { plainCommandEligible: true });
    migrationDb.close();
    const before = readFileSync(targetPath);

    const result = runCorrectionImportCli(["--backfill-rule-text"], targetPath);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/candidates=4 fill=2 unfilled=2 polarity_changed=2/u);
    expect(result.stdout).toContain("missing_command_text=1");
    expect(result.stdout).toContain("invalid_conditions=1");
    expect(result.stdout).toContain('source="架空の青色試料番号を書くな。"');
    expect(result.stdout).toContain('before="" after="架空の青色試料番号を書くな。"');
    expect(result.stdout).toContain('source="今後はこの語彙では判断に迷う言葉を使うな"');
    expect(result.stdout).toContain('after="今後はこの語彙では判断に迷う言葉を使うな"');
    expect(readFileSync(targetPath)).toEqual(before);
  });

  it("rule_text backfill apply creates a pre-write backup and stays safe on schema v12", () => {
    const migrationDb = new Database(targetPath);
    migrateV10ToV11(migrationDb);
    migrateV11ToV12(migrationDb);
    seedEmptyCandidate(migrationDb, "synthetic-apply", "架空の青色試料番号を書くな。");
    seedEmptyCandidate(
      migrationDb,
      "synthetic-polarity-only",
      "今後はこの語彙では判断に迷う言葉を使うな",
      { plainCommandEligible: true, detectorVersion: "owner-correction-v2" },
    );
    migrationDb.close();

    const result = runCorrectionImportCli(["--backfill-rule-text", "--apply"], targetPath);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/apply=1 .*candidates=2 fill=1 unfilled=1 polarity_changed=2/u);
    const backupDir = join(directory, "migration-backups");
    expect(existsSync(backupDir)).toBe(true);
    const backupName = readdirSync(backupDir).find((name) => name.startsWith("pre-rule-text-backfill-") && name.endsWith(".db"));
    expect(backupName).toBeDefined();
    const backup = new Database(join(backupDir, backupName as string), { readonly: true });
    const beforeState = backup.prepare(`
      SELECT rule_text, polarity FROM owner_correction_bundles WHERE bundle_key = ?
    `).get("synthetic-apply");
    expect(beforeState).toEqual({ rule_text: "", polarity: "positive" });
    expect(backup.prepare(`
      SELECT rule_text, polarity FROM owner_correction_bundles WHERE bundle_key = ?
    `).get("synthetic-polarity-only")).toEqual({ rule_text: "", polarity: "positive" });
    backup.close();

    const db = new Database(targetPath, { readonly: true });
    try {
      expect(db.prepare(`
        SELECT rule_text, polarity FROM owner_correction_bundles WHERE bundle_key = ?
      `).get("synthetic-apply")).toEqual({ rule_text: "架空の青色試料番号を書くな。", polarity: "negative" });
      expect(db.prepare(`
        SELECT rule_text, polarity, body_hash FROM owner_correction_versions WHERE bundle_key = ? AND version = 1
      `).get("synthetic-apply")).toEqual({
        rule_text: "架空の青色試料番号を書くな。",
        polarity: "negative",
        body_hash: sha256("架空の青色試料番号を書くな。"),
      });
      expect(db.prepare(`
        SELECT polarity, conditions FROM owner_correction_evidence WHERE bundle_key = ?
      `).get("synthetic-apply")).toMatchObject({ polarity: "negative" });
      expect(db.prepare(`
        SELECT rule_text, polarity FROM owner_correction_bundles WHERE bundle_key = ?
      `).get("synthetic-polarity-only")).toEqual({ rule_text: "", polarity: "negative" });
      const polarityOnlyEvidence = db.prepare(`
        SELECT conditions, polarity FROM owner_correction_evidence WHERE bundle_key = ?
      `).get("synthetic-polarity-only") as { conditions: string; polarity: string };
      expect(polarityOnlyEvidence.polarity).toBe("negative");
      expect(JSON.parse(polarityOnlyEvidence.conditions).polarity).toBe("negative");
      expect(db.prepare("SELECT MAX(version) AS version FROM schema_version").get()).toEqual({ version: 12 });
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("owner_correction_principle_members")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("migrationモードとsource指定を同時に受け付けない", () => {
    expect(runCorrectionImportCli(["--migrate-v11", "--source", sourcePath, "--apply"], targetPath).exitCode).toBe(2);
  });
});
