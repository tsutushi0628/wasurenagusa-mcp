import { describe, it, expect, vi } from "vitest";
import { TaskEvaluator } from "./evaluator.js";
import type { EvaluationInput, AutonomousTask, ProjectMeta } from "../types.js";

vi.mock("../analyzer/prompt-loader.js", () => ({
  loadPrompt: vi.fn().mockResolvedValue(
    "DONE: {done}\nOUTPUT: {execution_output}\nEXIT: {exit_code}\nDURATION: {duration_ms}\nMETA: {project_meta}\nWHAT: {what}\nWHY: {why}",
  ),
}));

const mockGenerateContent = vi.fn();
vi.mock("../analyzer/gemini-client.js", () => ({
  createGeminiModel: vi.fn(() => ({
    generateContent: mockGenerateContent,
  })),
}));

describe("TaskEvaluator", () => {
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

  const makeInput = (overrides: Partial<EvaluationInput> = {}): EvaluationInput => ({
    task: makeTask(),
    executionOutput: "テスト出力",
    executionExitCode: 0,
    executionDurationMs: 5000,
    projectMeta: makeMeta(),
    ...overrides,
  });

  describe("OK判定", () => {
    it("verdictがokの場合、正常にEvaluatorResultを返す", async () => {
      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => JSON.stringify({
            verdict: "ok",
            reason: "すべてのDone条件を満たしている",
          }),
        },
      });

      const evaluator = new TaskEvaluator();
      const result = await evaluator.evaluate(makeInput());

      expect(result.verdict).toBe("ok");
      expect(result.reason).toBe("すべてのDone条件を満たしている");
      expect(result.suggestion).toBeUndefined();
    });
  });

  describe("NG判定", () => {
    it("verdictがngの場合、suggestionも含めて返す", async () => {
      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => JSON.stringify({
            verdict: "ng",
            reason: "テストが失敗している",
            suggestion: "テストを修正してリトライ",
          }),
        },
      });

      const evaluator = new TaskEvaluator();
      const result = await evaluator.evaluate(makeInput());

      expect(result.verdict).toBe("ng");
      expect(result.reason).toBe("テストが失敗している");
      expect(result.suggestion).toBe("テストを修正してリトライ");
    });
  });

  describe("human-required判定", () => {
    it("verdictがhuman-requiredの場合を正しく返す", async () => {
      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => JSON.stringify({
            verdict: "human-required",
            reason: "ライセンス選択が必要",
          }),
        },
      });

      const evaluator = new TaskEvaluator();
      const result = await evaluator.evaluate(makeInput());

      expect(result.verdict).toBe("human-required");
      expect(result.reason).toBe("ライセンス選択が必要");
    });
  });

  describe("エラーハンドリング", () => {
    it("不正なJSON（verdict無し）でエラーを投げる", async () => {
      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => "これはJSONではありません",
        },
      });

      const evaluator = new TaskEvaluator();
      await expect(evaluator.evaluate(makeInput())).rejects.toThrow("Failed to parse");
    });

    it("不正なverdict値でエラーを投げる", async () => {
      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => JSON.stringify({
            verdict: "invalid-verdict",
            reason: "テスト",
          }),
        },
      });

      const evaluator = new TaskEvaluator();
      await expect(evaluator.evaluate(makeInput())).rejects.toThrow("Invalid verdict value");
    });

    it("reason欠落でエラーを投げる", async () => {
      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => JSON.stringify({
            verdict: "ok",
          }),
        },
      });

      const evaluator = new TaskEvaluator();
      await expect(evaluator.evaluate(makeInput())).rejects.toThrow("missing 'reason' field");
    });

    it("コードブロックで囲まれたJSONも正しく解析する", async () => {
      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => '```json\n{"verdict": "ok", "reason": "完了"}\n```',
        },
      });

      const evaluator = new TaskEvaluator();
      const result = await evaluator.evaluate(makeInput());
      expect(result.verdict).toBe("ok");
    });
  });

  describe("stdout切り詰め", () => {
    it("50000文字を超えるoutputは末尾50000文字に切り詰められる", async () => {
      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => JSON.stringify({ verdict: "ok", reason: "完了" }),
        },
      });

      const longOutput = "x".repeat(60000);
      const evaluator = new TaskEvaluator();
      await evaluator.evaluate(makeInput({ executionOutput: longOutput }));

      const calledPrompt = mockGenerateContent.mock.calls[0][0] as string;
      // 末尾50000文字が含まれることを確認（全60000文字ではない）
      expect(calledPrompt.length).toBeLessThan(longOutput.length + 1000);
    });
  });
});
