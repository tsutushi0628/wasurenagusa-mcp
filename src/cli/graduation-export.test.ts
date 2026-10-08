import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeCorrectionSchema } from "../storage/correction-schema.js";
import { migrateV11ToV12, migrateV12ToV13 } from "../storage/migration.js";
import { SQLiteStorage } from "../storage/sqlite.js";
import { parseGraduationExportArguments, runGraduationExportCli } from "./graduation-export.js";

describe("graduation export CLI", () => {
  let tempDir: string;
  let memoryPath: string;
  let outputPath: string;
  let previousMode: string | undefined;
  let previousLoopMode: string | undefined;
  let previousMemoryPath: string | undefined;
  let previousImportCommand: string | undefined;
  let previousImportOutput: string | undefined;

  beforeEach(() => {
    previousMode = process.env.WASURENAGUSA_GRADUATION;
    previousLoopMode = process.env.WASURENAGUSA_CORRECTION_LOOP;
    previousMemoryPath = process.env.WASURENAGUSA_MEMORY_PATH;
    previousImportCommand = process.env.WASURENAGUSA_JEV_IMPORT_CMD;
    previousImportOutput = process.env.WASURENAGUSA_JEV_IMPORT_OUT;
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
    if (previousImportCommand === undefined) delete process.env.WASURENAGUSA_JEV_IMPORT_CMD;
    else process.env.WASURENAGUSA_JEV_IMPORT_CMD = previousImportCommand;
    if (previousImportOutput === undefined) delete process.env.WASURENAGUSA_JEV_IMPORT_OUT;
    else process.env.WASURENAGUSA_JEV_IMPORT_OUT = previousImportOutput;
  });

  function migrateToV13(): void {
    const db = new Database(join(memoryPath, "memory.db"));
    migrateV12ToV13(db);
    db.close();
  }

  function writeImporter(source: string): string {
    const importerPath = join(tempDir, "synthetic-jev-import.cjs");
    writeFileSync(importerPath, source, "utf8");
    return importerPath;
  }

  function graduationCount(): number {
    const db = new Database(join(memoryPath, "memory.db"), { readonly: true });
    const row = db.prepare("SELECT COUNT(*) AS count FROM owner_correction_graduations").get() as { count: number };
    db.close();
    return row.count;
  }

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

  it("onは提案を書いた後にJev取込を実行する", () => {
    process.env.WASURENAGUSA_GRADUATION = "on";
    migrateToV13();
    const importerPath = writeImporter([
      'const { readFileSync, writeFileSync } = require("node:fs");',
      'const graduationPath = process.argv[process.argv.indexOf("--graduation") + 1];',
      'const outputPath = process.argv[process.argv.indexOf("--out") + 1];',
      'if (!graduationPath || !outputPath) process.exit(8);',
      'JSON.parse(readFileSync(graduationPath, "utf8"));',
      'writeFileSync(outputPath, JSON.stringify({ version: 1, cards: [] }));',
    ].join("\n"));
    process.env.WASURENAGUSA_JEV_IMPORT_CMD = `${process.execPath} ${importerPath}`;
    process.env.WASURENAGUSA_JEV_IMPORT_OUT = join(tempDir, "jev-knowledge.graduated.json");

    const result = runGraduationExportCli(["--out", outputPath]);

    expect(result).toMatchObject({ mode: "on", status: "written", importStatus: "imported" });
    expect(existsSync(process.env.WASURENAGUSA_JEV_IMPORT_OUT)).toBe(true);
    expect(graduationCount()).toBe(0);
  });

  it("取込失敗はstderrへ理由を出し、反映記録を作らない", () => {
    process.env.WASURENAGUSA_GRADUATION = "on";
    migrateToV13();
    const importerPath = writeImporter([
      'process.stderr.write("synthetic importer failure");',
      "process.exit(7);",
    ].join("\n"));
    process.env.WASURENAGUSA_JEV_IMPORT_CMD = `${process.execPath} ${importerPath}`;
    process.env.WASURENAGUSA_JEV_IMPORT_OUT = join(tempDir, "jev-knowledge.graduated.json");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const result = runGraduationExportCli(["--out", outputPath]);

    expect(result).toMatchObject({ mode: "on", status: "written", importStatus: "failed" });
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("synthetic importer failure"));
    expect(graduationCount()).toBe(0);
    stderrSpy.mockRestore();
  });

  it("取込コマンド未設定では反映記録を作らない", () => {
    process.env.WASURENAGUSA_GRADUATION = "on";
    migrateToV13();
    delete process.env.WASURENAGUSA_JEV_IMPORT_CMD;
    process.env.WASURENAGUSA_JEV_IMPORT_OUT = join(tempDir, "jev-knowledge.graduated.json");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const result = runGraduationExportCli(["--out", outputPath]);

    expect(result).toMatchObject({ mode: "on", status: "written", importStatus: "not_configured" });
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("WASURENAGUSA_JEV_IMPORT_CMD is not configured"));
    expect(existsSync(process.env.WASURENAGUSA_JEV_IMPORT_OUT)).toBe(false);
    expect(graduationCount()).toBe(0);
    stderrSpy.mockRestore();
  });

  it("shadowは提案だけを書き、取込を呼ばない", () => {
    process.env.WASURENAGUSA_GRADUATION = "shadow";
    migrateToV13();
    const importerPath = writeImporter("process.exit(7);");
    process.env.WASURENAGUSA_JEV_IMPORT_CMD = `${process.execPath} ${importerPath}`;
    process.env.WASURENAGUSA_JEV_IMPORT_OUT = join(tempDir, "jev-knowledge.graduated.json");

    const result = runGraduationExportCli(["--out", outputPath]);

    expect(result).toMatchObject({ mode: "shadow", status: "written", importStatus: "shadow" });
    expect(existsSync(outputPath)).toBe(true);
    expect(existsSync(process.env.WASURENAGUSA_JEV_IMPORT_OUT)).toBe(false);
    expect(graduationCount()).toBe(0);
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
