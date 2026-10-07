import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCorrectionImportCli } from "../cli/correction-import.js";
import {
  CORRECTION_PRINCIPLES_SCHEMA_VERSION,
} from "./correction-schema.js";
import { migrateV10ToV11, migrateV11ToV12, migrateV12ToV13 } from "./migration.js";
import { getSchemaVersion, initializeSchema } from "./schema.js";
import { SQLiteStorage } from "./sqlite.js";
import { correctionPrincipleCandidateFilter, createCorrectionPrinciple } from "../corrections/principles.js";

function tableExists(db: Database.Database, tableName: string): boolean {
  return db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) !== undefined;
}

function indexColumns(db: Database.Database, indexName: string): string[] {
  return db.prepare(`PRAGMA index_info(${indexName})`).all()
    .map((row) => (row as { name: string }).name);
}

function tableColumns(db: Database.Database, tableName: string): string[] {
  return db.prepare(`PRAGMA table_info(${tableName})`).all()
    .map((row) => (row as { name: string }).name);
}

describe("v12からv13への専用移行", () => {
  let directory: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "wasurenagusa-migration-v13-test-"));
    dbPath = join(directory, "memory.db");
    db = new Database(dbPath);
    initializeSchema(db);
    migrateV10ToV11(db);
    migrateV11ToV12(db);
  });

  afterEach(() => {
    if (db.open) db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("5表と構成員検索indexを作り、版数13と外部キーを保つ", () => {
    migrateV12ToV13(db);

    expect(getSchemaVersion(db)).toBe(CORRECTION_PRINCIPLES_SCHEMA_VERSION);
    expect(tableExists(db, "owner_correction_principle_members")).toBe(true);
    expect(tableExists(db, "owner_correction_compliance_checks")).toBe(true);
    expect(tableExists(db, "owner_correction_strength_events")).toBe(true);
    expect(tableExists(db, "owner_correction_graduations")).toBe(true);
    expect(tableExists(db, "owner_correction_abstraction_runs")).toBe(true);
    expect(tableColumns(db, "owner_correction_principle_members"))
      .toEqual(["principle_key", "member_key", "attached_at", "attach_source"]);
    expect(tableColumns(db, "owner_correction_compliance_checks")).toEqual([
      "session_id_hash", "human_ordinal", "bundle_key", "version", "checker", "is_compliant", "checked_at",
    ]);
    expect(tableColumns(db, "owner_correction_strength_events"))
      .toEqual(["bundle_key", "at", "from_intensity", "to_intensity", "delta", "reason", "basis"]);
    expect(tableColumns(db, "owner_correction_graduations"))
      .toEqual(["bundle_key", "graduated_at", "proposal_hash", "revoked_at", "revoke_reason"]);
    expect(tableColumns(db, "owner_correction_abstraction_runs")).toEqual([
      "run_id", "ran_at", "mode", "calls", "groups", "adopted", "rejected_guard", "rejected_none",
      "skipped_reason", "quota_before_pct", "quota_after_pct",
    ]);
    expect(db.prepare("PRAGMA foreign_key_list(owner_correction_principle_members)").all())
      .toHaveLength(2);
    expect(indexColumns(db, "idx_owner_correction_principle_members_member"))
      .toEqual(["member_key", "principle_key"]);
    const previousPrinciplesMode = process.env.WASURENAGUSA_PRINCIPLES;
    process.env.WASURENAGUSA_PRINCIPLES = "on";
    try {
      const exclusion = correctionPrincipleCandidateFilter(db, "2026-10-03T00:00:00.000Z", "bundle");
      const plan = db.prepare(`
        EXPLAIN QUERY PLAN
        SELECT bundle.bundle_key
        FROM owner_correction_bundles AS bundle
        WHERE 1 = 1 ${exclusion.sql}
      `).all(...exclusion.parameters) as Array<{ detail: string }>;
      expect(plan.map((row) => row.detail).join(" "))
        .toContain("idx_owner_correction_principle_members_member");
    } finally {
      if (previousPrinciplesMode === undefined) delete process.env.WASURENAGUSA_PRINCIPLES;
      else process.env.WASURENAGUSA_PRINCIPLES = previousPrinciplesMode;
    }
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
  });

  it("CLIのdry-runはDDL差分だけを表示し、apply後にschema 13へ進む", () => {
    db.close();
    const before = readFileSync(dbPath);

    const preview = runCorrectionImportCli(["--migrate-v13"], dbPath);

    expect(preview.exitCode).toBe(0);
    expect(preview.stdout).toMatch(/schema=12 ddl=6/);
    expect(preview.stdout).toContain("+ CREATE TABLE owner_correction_principle_members (");
    expect(readFileSync(dbPath)).toEqual(before);

    const apply = runCorrectionImportCli(["--migrate-v13", "--apply"], dbPath);

    expect(apply.exitCode).toBe(0);
    expect(apply.stdout).toMatch(/schema=13 ddl=6/);
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    expect(getSchemaVersion(db)).toBe(CORRECTION_PRINCIPLES_SCHEMA_VERSION);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
  });

  it("通常initializeはv12からv13へ進めない", () => {
    db.close();
    const storage = new SQLiteStorage(dbPath);
    storage.initialize();
    const previousPrinciplesMode = process.env.WASURENAGUSA_PRINCIPLES;
    process.env.WASURENAGUSA_PRINCIPLES = "shadow";
    try {
      expect(storage.runCorrectionTransaction((transaction) => createCorrectionPrinciple(transaction, {
        ruleText: "合成 原則", polarity: "negative", at: "2026-10-03T04:00:00.000Z",
      }))).toMatchObject({ status: "disabled", principleKey: null });
    } finally {
      if (previousPrinciplesMode === undefined) delete process.env.WASURENAGUSA_PRINCIPLES;
      else process.env.WASURENAGUSA_PRINCIPLES = previousPrinciplesMode;
    }
    storage.close();
    db = new Database(dbPath);

    expect(getSchemaVersion(db)).toBe(12);
    expect(tableExists(db, "owner_correction_principle_members")).toBe(false);
    expect(tableExists(db, "owner_correction_compliance_checks")).toBe(false);
    expect(tableExists(db, "owner_correction_strength_events")).toBe(false);
  });

  it("v12以外の版数では移行しない", () => {
    migrateV12ToV13(db);

    expect(() => migrateV12ToV13(db)).toThrow();
    expect(getSchemaVersion(db)).toBe(13);

    const v11Path = join(directory, "v11.db");
    const v11Db = new Database(v11Path);
    try {
      initializeSchema(v11Db);
      migrateV10ToV11(v11Db);
      expect(() => migrateV12ToV13(v11Db)).toThrow();
      expect(getSchemaVersion(v11Db)).toBe(11);
    } finally {
      v11Db.close();
    }
  });
});
