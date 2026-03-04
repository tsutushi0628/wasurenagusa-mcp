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

const mockGenerateText = vi.fn();
vi.mock("../llm/provider.js", () => ({
  createGenerateTextFn: vi.fn(() => mockGenerateText),
}));

vi.mock("../analyzer/prompt-loader.js", () => ({
  loadPrompt: vi.fn().mockResolvedValue("PROJECT: {project_name}\nINFO: {initial_info}"),
}));

describe("handleProjectInit", () => {
  beforeEach(async () => {
    testSchedulerDir = await mkdtemp(join(tmpdir(), "wasurenagusa-tool-init-"));
    mockGenerateText.mockReset();
  });

  afterEach(async () => {
    await rm(testSchedulerDir, { recursive: true, force: true });
  });

  it("必須パラメータ欠落でエラーを返す", async () => {
    const { handleProjectInit } = await import("./projectInit.js");
    const result = await handleProjectInit({});
    const parsed = JSON.parse(result);
    expect(parsed.error).toBeDefined();
  });

  it("無効なmodeでエラーを返す", async () => {
    const { handleProjectInit } = await import("./projectInit.js");
    const result = await handleProjectInit({
      mode: "invalid",
      projectName: "test",
    });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("無効なmode");
  });

  it("mode=generateでLLMの質問リストを返す", async () => {
    mockGenerateText.mockResolvedValue(JSON.stringify({
      questions: [{ key: "phase", question: "フェーズは？", options: ["startup"] }],
    }));

    const { handleProjectInit } = await import("./projectInit.js");
    const result = await handleProjectInit({
      mode: "generate",
      projectName: "test-project",
    });
    const parsed = JSON.parse(result);
    expect(parsed.questions).toBeDefined();
  });

  it("mode=saveでprojectPath未指定のエラーを返す", async () => {
    const { handleProjectInit } = await import("./projectInit.js");
    const result = await handleProjectInit({
      mode: "save",
      projectName: "test",
    });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("projectPath");
  });

  it("mode=saveで正常にmetaを保存する", async () => {
    const { handleProjectInit } = await import("./projectInit.js");
    const result = await handleProjectInit({
      mode: "save",
      projectName: "test-project",
      projectPath: "/tmp/test-project",
      answers: { phase: "growth" },
    });
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.meta.phase).toBe("growth");
  });
});
