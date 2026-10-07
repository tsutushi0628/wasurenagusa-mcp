import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateV10ToV11, migrateV11ToV12 } from "../storage/migration.js";
import { SQLiteStorage } from "../storage/sqlite.js";

describe("strength-job CLI", () => {
  let tempDir: string;
  let memoryDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "strength-job-cli-"));
    memoryDir = join(tempDir, "memory");
    const dbPath = join(memoryDir, "memory.db");
    const initialStorage = new SQLiteStorage(dbPath);
    initialStorage.initialize();
    initialStorage.close();
    const db = new Database(dbPath);
    migrateV10ToV11(db);
    migrateV11ToV12(db);
    db.close();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("WASURENAGUSA_MEMORY_PATHだけを指定した子CLIが保存先のmemory.dbを開く", () => {
    const childEnv = {
      ...process.env,
      WASURENAGUSA_MEMORY_PATH: memoryDir,
      WASURENAGUSA_CORRECTION_LOOP: "on",
      WASURENAGUSA_STRENGTH: "on",
    };
    delete childEnv.MEMORY_DIR;

    const output = execFileSync(process.execPath, [
      "--loader",
      "ts-node/esm",
      "src/cli/strength-job.ts",
    ], {
      cwd: resolve("."),
      env: childEnv,
      encoding: "utf8",
    });

    expect(JSON.parse(output.trim())).toMatchObject({
      mode: "on",
      bundlesExamined: 0,
      eventsRecorded: 0,
    });
    const db = new Database(join(memoryDir, "memory.db"), { readonly: true });
    const version = db.prepare("SELECT MAX(version) AS version FROM schema_version").get() as { version: number };
    expect(version.version).toBe(12);
    db.close();
  });
});
