import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

// SCHEDULER_DIRをモックで置換
let testSchedulerDir: string;
vi.mock("os", async () => {
  const actual = await vi.importActual("os");
  return {
    ...actual,
    homedir: () => testSchedulerDir,
  };
});

describe("handleTaskSubmit", () => {
  beforeEach(async () => {
    testSchedulerDir = await mkdtemp(join(tmpdir(), "wasurenagusa-tool-submit-"));
  });

  afterEach(async () => {
    await rm(testSchedulerDir, { recursive: true, force: true });
  });

  it("必須パラメータ欠落でエラーを返す", async () => {
    const { handleTaskSubmit } = await import("./taskSubmit.js");
    const result = await handleTaskSubmit({ why: "test", what: "test" });
    const parsed = JSON.parse(result);
    expect(parsed.error).toBeDefined();
  });

  it("プロジェクトメタ未登録でエラーを返す", async () => {
    const { handleTaskSubmit } = await import("./taskSubmit.js");
    const result = await handleTaskSubmit({
      why: "テスト",
      what: "テストタスク",
      done: "テスト通過",
      project: "nonexistent-project",
    });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("メタ情報が見つかりません");
  });
});
