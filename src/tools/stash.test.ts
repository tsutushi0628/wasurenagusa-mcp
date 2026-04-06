import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { handleMemoryStash } from "./stash.js";
import { handleMemoryRestore } from "./restore.js";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, mkdirSync, rmSync } from "fs";

const MEMORY_DIR = ".wasurenagusa";

describe("memory_stash / memory_restore tools", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "wasurenagusa-tool-test-"));
    mkdirSync(join(projectRoot, MEMORY_DIR), { recursive: true });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("stash returns StashResult JSON", () => {
    const result = JSON.parse(
      handleMemoryStash(
        { content: "hello world\nline2\nline3" },
        projectRoot,
      ),
    );
    expect(result.id).toBeTruthy();
    expect(result.summary).toContain("hello world");
    expect(result.expiresAt).toBeTruthy();
  });

  it("stash then restore returns full content", () => {
    const stashResult = JSON.parse(
      handleMemoryStash(
        { content: "full content for restore", filePath: "/tmp/test.ts", fileType: "ts" },
        projectRoot,
      ),
    );

    const restoreResult = JSON.parse(
      handleMemoryRestore({ id: stashResult.id }, projectRoot),
    );

    expect(restoreResult.found).toBe(true);
    expect(restoreResult.content).toBe("full content for restore");
  });

  it("restore non-existent id returns not found", () => {
    handleMemoryStash({ content: "init" }, projectRoot);

    const result = JSON.parse(
      handleMemoryRestore({ id: "nonexistent" }, projectRoot),
    );
    expect(result.found).toBe(false);
  });
});
