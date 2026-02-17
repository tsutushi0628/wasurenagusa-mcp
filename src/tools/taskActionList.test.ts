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

describe("handleTaskActionList", () => {
  beforeEach(async () => {
    testSchedulerDir = await mkdtemp(join(tmpdir(), "wasurenagusa-tool-action-"));
  });

  afterEach(async () => {
    await rm(testSchedulerDir, { recursive: true, force: true });
  });

  it("mode=listで空リストを返す", async () => {
    const { handleTaskActionList } = await import("./taskActionList.js");
    const result = await handleTaskActionList({ mode: "list" });
    const parsed = JSON.parse(result);
    expect(parsed.items).toEqual([]);
  });

  it("mode=resolveでtaskId未指定のエラーを返す", async () => {
    const { handleTaskActionList } = await import("./taskActionList.js");
    const result = await handleTaskActionList({ mode: "resolve" });
    const parsed = JSON.parse(result);
    expect(parsed.error).toBeDefined();
  });

  it("mode=resolveで無効なactionのエラーを返す", async () => {
    const { handleTaskActionList } = await import("./taskActionList.js");
    const result = await handleTaskActionList({
      mode: "resolve",
      taskId: "test-id",
      action: "invalid",
    });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("無効なaction");
  });
});
