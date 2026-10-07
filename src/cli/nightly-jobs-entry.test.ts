import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateV10ToV11, migrateV11ToV12, migrateV12ToV13 } from "../storage/migration.js";
import { SQLiteStorage } from "../storage/sqlite.js";
import { formatCliErrorDetails } from "../utils/cli-entry.js";

describe("nightly CLI entries with MEMORY_DIR", () => {
  let tempDir: string;
  let compiledRoot: string;
  let memoryPath: string;
  let gitDirectory: string;

  beforeAll(() => {
    const packageRoot = resolve(".");
    tempDir = mkdtempSync(join(tmpdir(), "wasurenagusa-nightly-cli-"));
    compiledRoot = join(tempDir, "compiled");
    memoryPath = join(tempDir, "synthetic-memory");
    mkdirSync(compiledRoot, { recursive: true });
    execFileSync("pnpm", [
      "exec", "tsc", "--rootDir", ".", "--outDir", compiledRoot,
      "--declaration", "false", "--sourceMap", "false",
    ], { cwd: packageRoot, stdio: "pipe" });
    copyFileSync(join(packageRoot, "package.json"), join(compiledRoot, "package.json"));
    symlinkSync(join(packageRoot, "node_modules"), join(compiledRoot, "node_modules"), "dir");
    mkdirSync(join(compiledRoot, "prompts"), { recursive: true });
    copyFileSync(
      join(packageRoot, "prompts", "principle-abstraction.md"),
      join(compiledRoot, "prompts", "principle-abstraction.md"),
    );
    gitDirectory = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
      cwd: packageRoot,
      encoding: "utf8",
    }).trim();

    const dbPath = join(memoryPath, "memory.db");
    const initialStorage = new SQLiteStorage(dbPath);
    initialStorage.initialize();
    initialStorage.close();
    const db = new Database(dbPath);
    migrateV10ToV11(db);
    migrateV11ToV12(db);
    migrateV12ToV13(db);
    db.close();
  }, 30000);

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function runCli(
    scriptName: string,
    extraEnv: NodeJS.ProcessEnv,
    args: string[] = [],
    memoryPathOverride?: string,
  ) {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      ...(memoryPathOverride === undefined ? { MEMORY_DIR: memoryPath } : {}),
      GIT_DIR: gitDirectory,
      ...extraEnv,
    };
    if (memoryPathOverride === undefined) {
      delete env.WASURENAGUSA_MEMORY_PATH;
    } else {
      env.WASURENAGUSA_MEMORY_PATH = memoryPathOverride;
      delete env.MEMORY_DIR;
    }
    return spawnSync(
      process.execPath,
      [join(compiledRoot, "src", "cli", scriptName + ".js"), ...args],
      { cwd: compiledRoot, env, encoding: "utf8" },
    );
  }

  it("strength-job opens the synthetic memory.db through MEMORY_DIR", () => {
    const result = runCli("strength-job", {
      WASURENAGUSA_CORRECTION_LOOP: "on",
      WASURENAGUSA_STRENGTH: "shadow",
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ mode: "shadow", bundlesExamined: 0 });
    expect(existsSync(join(memoryPath, "memory.db"))).toBe(true);
  });

  it("graduation-export opens the synthetic memory.db and writes its default proposal", () => {
    const result = runCli("graduation-export", {
      WASURENAGUSA_CORRECTION_LOOP: "on",
      WASURENAGUSA_GRADUATION: "on",
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ mode: "on", status: "written", principles: 0 });
    const reportDirectory = join(memoryPath, "reports", "graduation");
    const proposalFile = readdirSync(reportDirectory).find((name) => name.startsWith("proposal-") && name.endsWith(".json"));
    expect(proposalFile).toBeDefined();
    expect(JSON.parse(readFileSync(join(reportDirectory, proposalFile as string), "utf8"))).toMatchObject({
      schema: 1,
      principles: [],
    });
  });

  it("abstract-principles safely opens the synthetic memory.db without Codex work when no groups exist", () => {
    const result = runCli("abstract-principles", {
      WASURENAGUSA_CORRECTION_LOOP: "on",
      WASURENAGUSA_PRINCIPLES: "shadow",
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "shadow",
      groups: 0,
      calls: 0,
      skippedReason: "no_eligible_groups",
    });
  });

  it("abstract-principles reports a missing prompt path and exits unsuccessfully", () => {
    const promptPath = join(compiledRoot, "prompts", "principle-abstraction.md");
    const promptContents = readFileSync(join(resolve("."), "prompts", "principle-abstraction.md"), "utf8");
    rmSync(promptPath);

    let result: ReturnType<typeof runCli>;
    try {
      result = runCli("abstract-principles", {
        WASURENAGUSA_CORRECTION_LOOP: "on",
        WASURENAGUSA_PRINCIPLES: "shadow",
      });
    } finally {
      copyFileSync(join(resolve("."), "prompts", "principle-abstraction.md"), promptPath);
    }

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("ENOENT");
    expect(result.stderr).toContain(promptPath);
    expect(result.stderr).toContain("runAbstractPrinciplesCli");
    expect(result.stderr).not.toContain(promptContents);
    expect(result.stderr.trim().split("\n")).toHaveLength(4);
  });

  it("strength-job reports the failure reason and exits unsuccessfully", () => {
    const missingMemoryPath = join(tempDir, "missing-strength-memory");

    const result = runCli(
      "strength-job",
      { WASURENAGUSA_CORRECTION_LOOP: "on", WASURENAGUSA_STRENGTH: "shadow" },
      [],
      missingMemoryPath,
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("strength-job memory store does not exist");
    expect(result.stderr).toContain("runStrengthJobCli");
    expect(result.stderr.trim().split("\n")).toHaveLength(4);
  });

  it("graduation-export reports the failure reason and exits unsuccessfully", () => {
    const missingMemoryPath = join(tempDir, "missing-graduation-memory");

    const result = runCli(
      "graduation-export",
      { WASURENAGUSA_CORRECTION_LOOP: "on", WASURENAGUSA_GRADUATION: "on" },
      [],
      missingMemoryPath,
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("graduation-export memory store does not exist");
    expect(result.stderr).toContain("runGraduationExportCli");
    expect(result.stderr.trim().split("\n")).toHaveLength(4);
  });

  it("CLI error details redact credentials and omit multiline message bodies", () => {
    const credentialDetails = formatCliErrorDetails(new Error("WASURENAGUSA_API_KEY=synthetic-secret-token"));
    expect(credentialDetails).toContain("[REDACTED]");
    expect(credentialDetails).not.toContain("synthetic-secret-token");

    const conversationDetails = formatCliErrorDetails(new Error("synthetic conversation body\nsecond line"));
    expect(conversationDetails).toContain("multiline error message omitted");
    expect(conversationDetails).not.toContain("synthetic conversation body");
    expect(conversationDetails).not.toContain("second line");
  });

  it("WASURENAGUSA_MEMORY_PATH is a directory for all three nightly CLIs", () => {
    const strengthResult = runCli(
      "strength-job",
      { WASURENAGUSA_CORRECTION_LOOP: "on", WASURENAGUSA_STRENGTH: "shadow" },
      [],
      memoryPath,
    );
    expect(strengthResult.error).toBeUndefined();
    expect(strengthResult.status).toBe(0);
    expect(JSON.parse(strengthResult.stdout)).toMatchObject({ mode: "shadow" });

    const graduationResult = runCli(
      "graduation-export",
      { WASURENAGUSA_CORRECTION_LOOP: "on", WASURENAGUSA_GRADUATION: "on" },
      [],
      memoryPath,
    );
    expect(graduationResult.error).toBeUndefined();
    expect(graduationResult.status).toBe(0);
    expect(JSON.parse(graduationResult.stdout)).toMatchObject({ mode: "on", status: "written" });
    const reportDirectory = join(memoryPath, "reports", "graduation");
    const proposalFile = readdirSync(reportDirectory).find((name) => name.startsWith("proposal-") && name.endsWith(".json"));
    expect(proposalFile).toBeDefined();
    expect(existsSync(join(reportDirectory, proposalFile as string))).toBe(true);

    const abstractionResult = runCli(
      "abstract-principles",
      { WASURENAGUSA_CORRECTION_LOOP: "on", WASURENAGUSA_PRINCIPLES: "shadow" },
      [],
      memoryPath,
    );
    expect(abstractionResult.error).toBeUndefined();
    expect(abstractionResult.status).toBe(0);
    expect(JSON.parse(abstractionResult.stdout)).toMatchObject({
      mode: "shadow",
      groups: 0,
      calls: 0,
      skippedReason: "no_eligible_groups",
    });
  });

  it("全体・個別停止を毎起動の.envから読み、停止理由で正常終了する", () => {
    const envPath = join(compiledRoot, ".env");
    const missingMemoryPath = join(tempDir, "missing-nightly-memory");
    const jobs = [
      ["strength-job", "on", "skippedReason"],
      ["graduation-export", "on", "skipped_reason"],
      ["abstract-principles", "shadow", "skippedReason"],
    ] as const;

    writeFileSync(envPath, [
      "WASURENAGUSA_CORRECTION_LOOP=off",
      "WASURENAGUSA_STRENGTH=on",
      "WASURENAGUSA_GRADUATION=on",
      "WASURENAGUSA_PRINCIPLES=shadow",
      "",
    ].join("\n"));
    for (const [scriptName, featureMode, reasonKey] of jobs) {
      const result = runCli(scriptName, {}, [], missingMemoryPath);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ mode: featureMode });
      expect(JSON.parse(result.stdout)[reasonKey]).toBe("correction_loop_off");
    }

    writeFileSync(envPath, [
      "WASURENAGUSA_CORRECTION_LOOP=on",
      "WASURENAGUSA_STRENGTH=off",
      "WASURENAGUSA_GRADUATION=off",
      "WASURENAGUSA_PRINCIPLES=off",
      "",
    ].join("\n"));
    for (const [scriptName, , reasonKey] of jobs) {
      const result = runCli(scriptName, {}, [], missingMemoryPath);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)[reasonKey]).toBe("feature_off");
    }

    writeFileSync(envPath, [
      "WASURENAGUSA_CORRECTION_LOOP=off",
      "WASURENAGUSA_PRINCIPLES=off",
      "",
    ].join("\n"));
    const overridden = runCli("abstract-principles", {
      WASURENAGUSA_CORRECTION_LOOP: "on",
      WASURENAGUSA_PRINCIPLES: "shadow",
    }, [], memoryPath);
    expect(overridden.error).toBeUndefined();
    expect(overridden.status).toBe(0);
    expect(JSON.parse(overridden.stdout)).toMatchObject({ mode: "shadow", skippedReason: "no_eligible_groups" });
  });
});
