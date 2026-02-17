import { loadPrompt } from "../analyzer/prompt-loader.js";
import { createGeminiModel } from "../analyzer/gemini-client.js";
import { MAX_STDOUT_LENGTH } from "./constants.js";
import type { EvaluationInput, EvaluatorResult, ProjectMeta } from "../types.js";

export class TaskEvaluator {
  async evaluate(input: EvaluationInput): Promise<EvaluatorResult> {
    const template = await loadPrompt("task-evaluation.txt");
    const truncatedOutput = input.executionOutput.slice(-MAX_STDOUT_LENGTH);
    const prompt = this.replaceVariables(template, input, truncatedOutput);

    const model = createGeminiModel();
    const result = await model.generateContent(prompt);
    const text = result.response.text();

    return this.parseResult(text);
  }

  private replaceVariables(
    template: string,
    input: EvaluationInput,
    truncatedOutput: string,
  ): string {
    const metaSummary = this.buildMetaSummary(input.projectMeta);

    return template
      .replace(/\{done\}/g, input.task.done)
      .replace(/\{execution_output\}/g, truncatedOutput)
      .replace(/\{exit_code\}/g, String(input.executionExitCode))
      .replace(/\{duration_ms\}/g, String(input.executionDurationMs))
      .replace(/\{project_meta\}/g, metaSummary)
      .replace(/\{owner_profile\}/g, input.ownerProfile ?? "（未設定）")
      .replace(/\{what\}/g, input.task.what)
      .replace(/\{why\}/g, input.task.why);
  }

  private buildMetaSummary(meta: ProjectMeta): string {
    return [
      `フェーズ: ${meta.phase}`,
      `品質方針: ${meta.qualityPolicy}`,
      `テスト期待値: ${meta.testExpectation}`,
      `コード品質: ${meta.codeQuality}`,
      `AI自律度: ${meta.aiAutonomy}`,
    ].join("\n");
  }

  private parseResult(text: string): EvaluatorResult {
    // JSON部分を抽出（コードブロックで囲まれている場合も対応）
    const jsonMatch = text.match(/\{[\s\S]*?"verdict"[\s\S]*?\}/);
    if (!jsonMatch) {
      throw new Error(`Failed to parse evaluator response as JSON: ${text.slice(0, 200)}`);
    }

    const parsed = JSON.parse(jsonMatch[0]) as EvaluatorResult;

    // verdict値のバリデーション
    const validVerdicts = ["ok", "ng", "human-required"];
    if (!validVerdicts.includes(parsed.verdict)) {
      throw new Error(`Invalid verdict value: ${parsed.verdict}`);
    }

    if (!parsed.reason) {
      throw new Error("Evaluator response missing 'reason' field");
    }

    return {
      verdict: parsed.verdict,
      reason: parsed.reason,
      suggestion: parsed.suggestion,
    };
  }
}
