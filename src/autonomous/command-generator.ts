import { loadPrompt } from "../analyzer/prompt-loader.js";
import { createGenerateTextFn, type GenerateTextFn } from "../llm/provider.js";
import { escapePromptVariable } from "../utils/prompt-escape.js";
import type { CommandGenerationInput, ProjectMeta } from "../types.js";

export class CommandGenerator {
  private generateText: GenerateTextFn;

  constructor() {
    this.generateText = createGenerateTextFn();
  }

  async generate(input: CommandGenerationInput): Promise<string> {
    const template = await loadPrompt("task-command.txt");
    const prompt = this.replaceVariables(template, input);

    const text = await this.generateText(prompt);
    return text.trim();
  }

  private replaceVariables(template: string, input: CommandGenerationInput): string {
    const metaSummary = this.buildMetaSummary(input.projectMeta);

    return template
      .replace(/\{why\}/g, escapePromptVariable(input.task.why))
      .replace(/\{what\}/g, escapePromptVariable(input.task.what))
      .replace(/\{done\}/g, escapePromptVariable(input.task.done))
      .replace(/\{project_name\}/g, escapePromptVariable(input.task.project))
      .replace(/\{project_path\}/g, escapePromptVariable(input.task.projectPath))
      .replace(/\{project_meta\}/g, escapePromptVariable(metaSummary))
      .replace(/\{owner_profile\}/g, escapePromptVariable(input.ownerProfile ?? "（未設定）"))
      .replace(/\{retry_count\}/g, String(input.task.retryCount))
      .replace(/\{previous_evaluations\}/g, escapePromptVariable(this.buildPreviousEvaluations(input)));
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
