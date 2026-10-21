import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCorrectionImportCli } from "../cli/correction-import.js";
import { migrateV10ToV11, migrateV11ToV12, migrateV12ToV13, migrateV13ToV14 } from "./migration.js";
import { getSchemaVersion, initializeSchema } from "./schema.js";

describe("owner correction pending output migration", () => {
  it("previews v14 without writes and adds output metadata without changing existing rows", () => {
    const database = new Database(":memory:");
    try {
      initializeSchema(database);
      migrateV10ToV11(database);
      migrateV11ToV12(database);
      expect(() => migrateV13ToV14(database)).toThrow();
      migrateV12ToV13(database);
      database.prepare(`
        INSERT INTO owner_correction_pending (
          receipt_id, session_id_hash, received_at, last_confirmed_ordinal, raw_text_hash, extracted_candidates
        ) VALUES ('synthetic-receipt', 'synthetic-session', '2026-10-03T00:00:00.000Z', 0, 'synthetic-hash', '[]')
      `).run();
      const before = database.prepare("SELECT * FROM owner_correction_pending").get() as Record<string, unknown>;
      expect(migrateV13ToV14(database, false)).toEqual({ schemaVersion: 13, ddlCount: 1 });
      expect(getSchemaVersion(database)).toBe(13);
      expect(database.prepare("SELECT * FROM owner_correction_pending").get()).toEqual(before);
      expect(migrateV13ToV14(database)).toEqual({ schemaVersion: 14, ddlCount: 1 });
      expect(database.prepare("SELECT * FROM owner_correction_pending").get()).toEqual({ ...before, output_ledger: null });
      expect(() => database.prepare("UPDATE owner_correction_pending SET output_ledger = 'invalid-json'").run()).toThrow();
      expect(() => migrateV13ToV14(database)).toThrow();
    } finally {
      database.close();
    }
  });

  it("exposes the v14 preview and explicit apply through the migration CLI", () => {
    const temporaryRoot = join(process.cwd(), ".tmp");
    mkdirSync(temporaryRoot, { recursive: true });
    const directory = mkdtempSync(join(temporaryRoot, "migration-v14-"));
    const databasePath = join(directory, "memory.db");
    try {
      const database = new Database(databasePath);
      initializeSchema(database);
      migrateV10ToV11(database);
      migrateV11ToV12(database);
      migrateV12ToV13(database);
      database.close();
      const before = readFileSync(databasePath);
      expect(runCorrectionImportCli(["--migrate-v14"], databasePath)).toMatchObject({
        exitCode: 0, stdout: expect.stringContaining("schema=13 ddl=1"), stderr: "",
      });
      expect(readFileSync(databasePath)).toEqual(before);
      expect(runCorrectionImportCli(["--migrate-v14", "--apply"], databasePath)).toMatchObject({
        exitCode: 0, stdout: expect.stringContaining("schema=14 ddl=1"), stderr: "",
      });
      expect(runCorrectionImportCli(["--migrate-v14", "--migrate-v13"], databasePath).exitCode).toBe(2);
      expect(runCorrectionImportCli(["--migrate-v14", "--source", databasePath], databasePath).exitCode).toBe(2);
      expect(runCorrectionImportCli(["--migrate-v14", "--migrate-v14"], databasePath).exitCode).toBe(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
