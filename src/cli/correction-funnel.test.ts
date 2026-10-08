import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { config } from "../config.js";
import { migrateV10ToV11, migrateV11ToV12, migrateV12ToV13 } from "../storage/migration.js";
import { SQLiteStorage } from "../storage/sqlite.js";
import { parseCorrectionFunnelArguments, runCorrectionFunnelCli } from "./correction-funnel.js";

describe("correction-funnel arguments", () => {
  it("期間とJSON指定を受け取る", () => {
    expect(parseCorrectionFunnelArguments([
      "--since", "2026-10-01T00:00:00+09:00",
      "--until", "2026-10-14T23:59:59+09:00",
      "--json",
      "--memory-dir", ".tmp/synthetic-memory",
    ])).toEqual({
      since: "2026-10-01T00:00:00+09:00",
      until: "2026-10-14T23:59:59+09:00",
      memoryDirectory: ".tmp/synthetic-memory",
    });
  });

  it("必須指定と一意性を検査する", () => {
    expect(() => parseCorrectionFunnelArguments(["--since", "2026-10-01", "--until", "2026-10-02"]))
      .toThrow("--json is required");
    expect(() => parseCorrectionFunnelArguments([
      "--since", "2026-10-01", "--since", "2026-10-02", "--until", "2026-10-03", "--json",
    ])).toThrow("--since cannot be repeated");
    expect(() => parseCorrectionFunnelArguments([
      "--since", "invalid", "--until", "2026-10-03", "--json",
    ])).toThrow("--since requires an ISO timestamp");
  });

  it("通常パスの読取専用接続でWALの未確定行を読み、DBのSHA-256を変えない", () => {
    const memoryDirectory = mkdtempSync(join(process.cwd(), ".tmp", "codex-correction-funnel-cli-"));
    const dbPath = join(memoryDirectory, config.sqliteFile);
    const initialStorage = new SQLiteStorage(dbPath);
    initialStorage.initialize();
    initialStorage.close();
    const migrationDb = new Database(dbPath);
    migrateV10ToV11(migrationDb);
    migrateV11ToV12(migrationDb);
    migrateV12ToV13(migrationDb);
    migrationDb.pragma("journal_mode = WAL");
    migrationDb.pragma("wal_autocheckpoint = 0");
    migrationDb.prepare(`
      INSERT INTO owner_correction_bundles (
        bundle_key, memory_id, rule_text, topic_key, polarity, condition_key, project, scope,
        visibility, status, intensity, occurrence_count, session_count, first_seen_at, last_seen_at,
        expires_at, lifetime_kind, continuation_basis, confirmed_at, version,
        counterevidence_event_id, last_confirmation_asked_at, confirmation_state
      ) VALUES ('oc:v2:synthetic-cli', NULL, '回答は常体で書く', 'tone', 'positive', 'general',
        'synthetic', 'owner', 'owner', 'confirmed', 3, 1, 1, ?, ?, NULL,
        'explicit_continuing', 'synthetic', ?, 1, NULL, NULL, 'none')
    `).run("2026-10-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z");
    migrationDb.prepare(`
      INSERT INTO owner_correction_versions (
        bundle_key, version, rule_text, body_hash, conditions, condition_key, polarity, visibility,
        status, confirmed_at, expires_at, lifetime_kind, continuation_basis, evidence_event_ids,
        effective_from, change_reason
      ) VALUES ('oc:v2:synthetic-cli', 1, '回答は常体で書く', 'synthetic-body', '[]', 'general',
        'positive', 'owner', 'confirmed', ?, NULL, 'explicit_continuing', 'synthetic', '[]', ?, 'fixture')
    `).run("2026-10-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z");
    migrationDb.prepare(`
      INSERT INTO owner_correction_events (
        event_id, session_id_hash, human_ordinal, observed_at, available_at, source_kind, excerpt,
        previous_action, project, scope, raw_text_hash, source_locator_hash, processed_at
      ) VALUES ('synthetic-cli-event', 'synthetic-cli-session', 1, ?, ?, 'user',
        '常体の返答について確認する', '', 'synthetic', 'owner', 'raw', 'locator', ?)
    `).run("2026-10-01T00:01:00.000Z", "2026-10-01T00:01:00.000Z", "2026-10-01T00:01:00.000Z");
    const digest = () => createHash("sha256").update(readFileSync(dbPath)).digest("hex");
    const before = digest();

    try {
      expect(existsSync(`${dbPath}-wal`)).toBe(true);
      expect(runCorrectionFunnelCli([
        "--since", "2026-10-01T00:00:00Z",
        "--until", "2026-10-08T00:00:00Z",
        "--json",
        "--memory-dir", memoryDirectory,
      ]).overall.opportunities).toBe(1);
      expect(digest()).toBe(before);
    } finally {
      migrationDb.close();
      rmSync(memoryDirectory, { recursive: true, force: true });
    }
  });
});
