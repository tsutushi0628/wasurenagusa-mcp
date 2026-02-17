import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

let testSchedulerDir: string;
vi.mock("os", async () => {
  const actual = await vi.importActual("os");
  return {
    ...actual,
    homedir: () => testSchedulerDir,
  };
});

describe("handleTaskStatus", () => {
  beforeEach(async () => {
    testSchedulerDir = await mkdtemp(join(tmpdir(), "wasurenagusa-tool-status-"));
  });

  afterEach(async () => {
    await rm(testSchedulerDir, { recursive: true, force: true });
  });

  it("タスクが無い場合、全て0のサマリを返す", async () => {
    const { handleTaskStatus } = await import("./taskStatus.js");
    const result = await handleTaskStatus({});
    const parsed = JSON.parse(result);

    expect(parsed.summary.pending).toBe(0);
    expect(parsed.summary.completed).toBe(0);
    expect(parsed.recentTasks).toEqual([]);
  });
});
