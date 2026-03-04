import { SchedulerTask } from "../types.js";
import { loadPrompt } from "../analyzer/prompt-loader.js";
import { escapePromptVariable } from "../utils/prompt-escape.js";

const DEFAULT_CHANGE_PROMPT = `プロジェクト {project_name} ({project_path}) で変更がありました。
変更ファイル:
{changed_files}
Specドキュメント (Steering: {steering_path}, Specs: {specs_paths}) を確認し、乖離があれば更新してください。`;

const DEFAULT_ROTATION_PROMPT = `プロジェクト {project_name} ({project_path}) のSpecドキュメントを定期チェックしてください。
Specドキュメント (Steering: {steering_path}, Specs: {specs_paths}) とコードベースを照合し、乖離があれば更新してください。`;

export class PromptBuilder {
  async buildChangeBasedPrompt(task: SchedulerTask): Promise<string> {
    let template: string;
    try {
      template = await loadPrompt("spec-update.txt");
    } catch {
      template = DEFAULT_CHANGE_PROMPT;
    }
    return this.replaceVariables(template, task);
  }

  async buildRotationPrompt(task: SchedulerTask): Promise<string> {
    let template: string;
    try {
      template = await loadPrompt("spec-rotation.txt");
    } catch {
      template = DEFAULT_ROTATION_PROMPT;
    }
    return this.replaceVariables(template, task);
  }

  private replaceVariables(template: string, task: SchedulerTask): string {
    const changedFilesList = (task.changedFiles ?? [])
      .map((f) => `- ${f}`)
      .join("\n");
    const specsList = task.specPaths.specs.join(", ");

    return template
      .replace(/\{project_name\}/g, escapePromptVariable(task.project))
      .replace(/\{project_path\}/g, escapePromptVariable(task.projectPath))
      .replace(/\{changed_files\}/g, escapePromptVariable(changedFilesList))
      .replace(/\{steering_path\}/g, escapePromptVariable(task.specPaths.steering))
      .replace(/\{specs_paths\}/g, escapePromptVariable(specsList));
  }
}
