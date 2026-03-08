import { describe, it, expect, vi, beforeEach } from "vitest";
import { CommandGenerator } from "./command-generator.js";
import type { CommandGenerationInput, AutonomousTask, ProjectMeta } from "../types.js";

const mockGenerateText = vi.fn();
vi.mock("../llm/provider.js", () => ({
  createGenerateTextFn: vi.fn(() => mockGenerateText),
}));

// loadPromptモック
vi.mock("../analyzer/prompt-loader.js", () => ({
  loadPrompt: vi.fn().mockResolvedValue(
    "WHY: {why}\nWHAT: {what}\nDONE: {done}\nPROJECT: {project_name}\nPATH: {project_path}\nMETA: {project_meta}\nRETRY: {retry_count}\nPREV: {previous_evaluations}",
  ),
}));

describe("CommandGenerator", () => {
  beforeEach(() => {
    mockGenerateText.mockReset();
  });

  const makeTask = (): AutonomousTask => ({
    id: "test-id",
    why: "テスト目的",
    what: "テストタスク",
    done: "テスト完了条件",
    project: "test-project",
    projectPath: "/tmp/test-project",
    status: "in-progress",
    priority: 0,
    retryCount: 0,
    createdAt: new Date().toISOString(),
    evaluationHistory: [],
  });

  const makeMeta = (): ProjectMeta => ({
    project: "test-project",
    projectPath: "/tmp/test-project",
    phase: "startup",
    qualityPolicy: "balanced",
    testExpectation: "standard",
    codeQuality: "balanced",
    debtTolerance: "moderate",
    aiAutonomy: "moderate",
    escalationTriggers: ["cost_impact"],
    targetAudience: "b2c_consumer",
    successMetric: "user_engagement",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  it("正常に命令文を生成する", async () => {
    mockGenerateText.mockResolvedValue("生成された命令文テキスト");

    const generator = new CommandGenerator();
    const result = await generator.generate({
      task: makeTask(),
      projectMeta: makeMeta(),
    });

    expect(result).toBe("生成された命令文テキスト");
  });

  it("テンプレート変数が正しく置換されてLLMに渡される", async () => {
    mockGenerateText.mockResolvedValue("結果");

    const generator = new CommandGenerator();
    const task = makeTask();
    task.retryCount = 2;
    task.evaluationHistory = [
      {
        timestamp: "2026-01-01T00:00:00Z",
        result: "ng",
        reason: "テスト失敗",
        executionDurationMs: 3000,
      },
    ];

    await generator.generate({ task, projectMeta: makeMeta() });

    const calledPrompt = mockGenerateText.mock.calls[0][0] as string;
    expect(calledPrompt).toContain("テスト目的");
    expect(calledPrompt).toContain("テストタスク");
    expect(calledPrompt).toContain("テスト完了条件");
    expect(calledPrompt).toContain("test-project");
    expect(calledPrompt).toContain("/tmp/test-project");
    expect(calledPrompt).toContain("2"); // retry_count
    expect(calledPrompt).toContain("テスト失敗"); // previous evaluation
  });

  it("初回実行時はprevious_evaluationsが「なし（初回実行）」になる", async () => {
    mockGenerateText.mockResolvedValue("結果");

    const generator = new CommandGenerator();
    await generator.generate({ task: makeTask(), projectMeta: makeMeta() });

    const calledPrompt = mockGenerateText.mock.calls[0][0] as string;
    expect(calledPrompt).toContain("なし（初回実行）");
  });
});
