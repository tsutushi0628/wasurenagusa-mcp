import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeCorrectionSchema } from "../storage/correction-schema.js";
import { migrateV11ToV12 } from "../storage/migration.js";
import { SQLiteStorage } from "../storage/sqlite.js";
import { parseGraduationExportArguments, runGraduationExportCli } from "./graduation-export.js";

describe("graduation export CLI", () => {
  let tempDir: string;
  let memoryPath: string;
  let outputPath: string;
  let previousMode: string | undefined;
  let previousLoopMode: string | undefined;
  let previousMemoryPath: string | undefined;

  beforeEach(() => {
    previousMode = process.env.WASURENAGUSA_GRADUATION;
    previousLoopMode = process.env.WASURENAGUSA_CORRECTION_LOOP;
    previousMemoryPath = process.env.WASURENAGUSA_MEMORY_PATH;
    process.env.WASURENAGUSA_CORRECTION_LOOP = "on";
    tempDir = mkdtempSync(join(tmpdir(), "graduation-export-cli-"));
    memoryPath = join(tempDir, "memory");
    outputPath = join(tempDir, "proposal.json");
    const initialStorage = new SQLiteStorage(join(memoryPath, "memory.db"));
    initialStorage.initialize();
    initialStorage.close();
    const db = new Database(join(memoryPath, "memory.db"));
    initializeCorrectionSchema(db);
    migrateV11ToV12(db);
    db.close();
    process.env.WASURENAGUSA_MEMORY_PATH = memoryPath;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    if (previousMode === undefined) delete process.env.WASURENAGUSA_GRADUATION;
    else process.env.WASURENAGUSA_GRADUATION = previousMode;
    if (previousLoopMode === undefined) delete process.env.WASURENAGUSA_CORRECTION_LOOP;
    else process.env.WASURENAGUSA_CORRECTION_LOOP = previousLoopMode;
    if (previousMemoryPath === undefined) delete process.env.WASURENAGUSA_MEMORY_PATH;
    else process.env.WASURENAGUSA_MEMORY_PATH = previousMemoryPath;
  });

  it("accepts one output path and rejects unsupported arguments", () => {
    expect(parseGraduationExportArguments(["--out", outputPath])).toEqual({ outputPath });
    expect(() => parseGraduationExportArguments(["--out"])).toThrow("--out requires one path");
    expect(() => parseGraduationExportArguments(["--out", outputPath, "--out", outputPath]))
      .toThrow("--out cannot be repeated");
    expect(() => parseGraduationExportArguments(["--unknown"])).toThrow("unsupported graduation-export argument");
  });

  it("defaults to off and writes no file", () => {
    delete process.env.WASURENAGUSA_GRADUATION;

    const result = runGraduationExportCli(["--out", outputPath]);

    expect(result).toMatchObject({ mode: "off", status: "disabled", principleCount: 0 });
    expect(existsSync(outputPath)).toBe(false);
  });

  it("does nothing to a schema v12 database when enabled", () => {
    process.env.WASURENAGUSA_GRADUATION = "on";

    const result = runGraduationExportCli(["--out", outputPath]);

    expect(result).toMatchObject({ mode: "on", status: "schema_unavailable", principleCount: 0 });
    expect(existsSync(outputPath)).toBe(false);
    const db = new Database(join(memoryPath, "memory.db"), { readonly: true });
    const version = db.prepare("SELECT MAX(version) AS version FROM schema_version").get() as { version: number };
    expect(version.version).toBe(12);
    db.close();
  });

  it("WASURENAGUSA_MEMORY_PATHだけを指定した子CLIが保存先のmemory.dbを開く", () => {
    const childEnv = {
      ...process.env,
      WASURENAGUSA_MEMORY_PATH: memoryPath,
      WASURENAGUSA_CORRECTION_LOOP: "on",
      WASURENAGUSA_GRADUATION: "on",
    };
    delete childEnv.MEMORY_DIR;

    const output = execFileSync(process.execPath, [
      "--loader",
      "ts-node/esm",
      "src/cli/graduation-export.ts",
    ], {
      cwd: resolve("."),
      env: childEnv,
      encoding: "utf8",
    });

    expect(JSON.parse(output.trim())).toMatchObject({
      mode: "on",
      status: "schema_unavailable",
      principles: 0,
    });
  });
});
