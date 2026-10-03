import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { join } from "path";
import { tmpdir } from "os";
import { pathToFileURL } from "url";
import * as ts from "typescript";
import { isDirectRun, isMainModule } from "./cli-entry.js";

describe("CLI entry detection", () => {
  let tmpDir: string;
  let realFile: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-cli-entry-test-"));
    realFile = join(tmpDir, "cli.js");
    writeFileSync(realFile, "process.exit(0);\n");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("matches an existing module path", () => {
    expect(isDirectRun(realFile, pathToFileURL(realFile).href)).toBe(true);
  });

  it("matches a symlink to the module", () => {
    const symlinkPath = join(tmpDir, "cli-bin.js");
    symlinkSync(realFile, symlinkPath);

    expect(isDirectRun(symlinkPath, pathToFileURL(realFile).href)).toBe(true);
  });

  it("rejects a different existing file", () => {
    const otherFile = join(tmpDir, "other.js");
    writeFileSync(otherFile, "process.exit(0);\n");

    expect(isDirectRun(otherFile, pathToFileURL(realFile).href)).toBe(false);
  });

  it("returns false when argv1 is undefined", () => {
    expect(isDirectRun(undefined, pathToFileURL(realFile).href)).toBe(false);
  });

  it("uses raw path equality when realpath fails and the paths match", () => {
    const missingPath = join(tmpDir, "missing.js");

    expect(isDirectRun(missingPath, pathToFileURL(missingPath).href)).toBe(true);
  });

  it("rejects raw path inequality when realpath fails", () => {
    const missingPathA = join(tmpDir, "missing-a.js");
    const missingPathB = join(tmpDir, "missing-b.js");

    expect(isDirectRun(missingPathA, pathToFileURL(missingPathB).href)).toBe(false);
  });

  it("keeps isMainModule fail-open behavior when realpath fails", () => {
    const missingPath = join(tmpDir, "missing-main.js");
    const originalArgv1 = process.argv[1];
    process.argv[1] = missingPath;
    try {
      expect(isMainModule(pathToFileURL(missingPath).href)).toBe(true);
    } finally {
      process.argv[1] = originalArgv1;
    }
  });
});

describe("analyze CLI entry wiring", () => {
  it("sets isCliEntry through the shared helper", () => {
    const source = readFileSync(new URL("../cli/analyze.ts", import.meta.url), "utf-8");

    expect(source).toContain('import { isDirectRun } from "../utils/cli-entry.js";');
    expect(source).toMatch(
      /const isCliEntry = isDirectRun\(process\.argv\[1\], import\.meta\.url\);\s*if \(isCliEntry\) \{/,
    );
  });
});

describe("symlink CLI execution", () => {
  it("runs main through node <symlink> using the shared CLI entry helper", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-cli-symlink-test-"));
    try {
      const helperSource = readFileSync(new URL("./cli-entry.ts", import.meta.url), "utf-8");
      const helper = ts.transpileModule(helperSource, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
      }).outputText;
      const helperPath = join(tmpDir, "cli-entry.mjs");
      const realCliPath = join(tmpDir, "analyze-like-cli.mjs");
      const symlinkPath = join(tmpDir, "analyze-bin.mjs");
      const markerPath = join(tmpDir, "main-ran.txt");
      writeFileSync(helperPath, helper);
      writeFileSync(
        realCliPath,
        [
          'import { writeFileSync } from "node:fs";',
          'import { isDirectRun } from "./cli-entry.mjs";',
          "const isCliEntry = isDirectRun(process.argv[1], import.meta.url);",
          "if (isCliEntry) {",
          '  writeFileSync(process.env.MAIN_MARKER, "main");',
          "}",
          "",
        ].join("\n"),
      );
      symlinkSync(realCliPath, symlinkPath);

      const result = spawnSync(process.execPath, [symlinkPath], {
        encoding: "utf-8",
        env: { ...process.env, MAIN_MARKER: markerPath },
      });

      expect(result.status).toBe(0);
      expect(existsSync(markerPath)).toBe(true);
      expect(readFileSync(markerPath, "utf-8")).toBe("main");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
