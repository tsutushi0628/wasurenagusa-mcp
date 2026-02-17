import { loadPrompt } from "../analyzer/prompt-loader.js";
import { createGeminiModel } from "../analyzer/gemini-client.js";
import type { CommandGenerationInput, ProjectMeta } from "../types.js";

export class CommandGenerator {
  async generate(input: CommandGenerationInput): Promise<string> {
    const template = await loadPrompt("task-command.txt");
    const prompt = this.replaceVariables(template, input);

    const model = createGeminiModel();
    const result = await model.generateContent(prompt);
    const text = result.response.text();
    return text.trim();
  }

  private replaceVariables(template: string, input: CommandGenerationInput): string {
    const metaSummary = this.buildMetaSummary(input.projectMeta);

    return template
      .replace(/\{why\}/g, input.task.why)
      .replace(/\{what\}/g, input.task.what)
      .replace(/\{done\}/g, input.task.done)
      .replace(/\{project_name\}/g, input.task.project)
      .replace(/\{project_path\}/g, input.task.projectPath)
      .replace(/\{project_meta\}/g, metaSummary)
      .replace(/\{owner_profile\}/g, input.ownerProfile ?? "（未設定）")
      .replace(/\{retry_count\}/g, String(input.task.retryCount))
      .replace(/\{previous_evaluations\}/g, this.buildPreviousEvaluations(input));
  }

  private buildMetaSummary(meta: ProjectMeta): string {
    return [
      `フェーズ: ${meta.phase}`,
      `品質方針: ${meta.qualityPolicy}`,
      `テスト期待値: ${meta.testExpectation}`,
      `コード品質: ${meta.codeQuality}`,
      `技術的負債許容度: ${meta.debtTolerance}`,
      `AI自律度: ${meta.aiAutonomy}`,
      `ターゲット: ${meta.targetAudience}`,
      `成功指標: ${meta.successMetric}`,
      `エスカレーション条件: ${meta.escalationTriggers.join(", ")}`,
    ].join("\n");
  }

  private buildPreviousEvaluations(input: CommandGenerationInput): string {
    if (input.task.evaluationHistory.length === 0) {
      return "なし（初回実行）";
    }
    return input.task.evaluationHistory
      .map((e, i) => {
        let line = `[試行${i + 1}] ${e.result}: ${e.reason}`;
        if (e.suggestion) {
          line += ` → 提案: ${e.suggestion}`;
        }
        return line;
      })
      .join("\n");
  }
}
