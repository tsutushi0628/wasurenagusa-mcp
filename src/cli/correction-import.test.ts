import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCorrectionImportCli } from "./correction-import.js";
import { migrateV10ToV11 } from "../storage/migration.js";
import { initializeSchema } from "../storage/schema.js";

function createDatabase(path: string): void {
  const db = new Database(path);
  initializeSchema(db);
  db.close();
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

  it("migrationモードとsource指定を同時に受け付けない", () => {
    expect(runCorrectionImportCli(["--migrate-v11", "--source", sourcePath, "--apply"], targetPath).exitCode).toBe(2);
  });
});
