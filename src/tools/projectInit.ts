import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ProjectInitializer } from "../autonomous/project-initializer.js";
import { homedir } from "os";
import { join } from "path";

const SCHEDULER_DIR = join(homedir(), ".wasurenagusa", "scheduler");

export const projectInitTool: Tool = {
  name: "project_init",
  description: `プロジェクトの初期設定を行う。自律タスク実行のために、プロジェクトの品質基準・フェーズ・判断基準を登録する。

操作モード:
- mode="generate": 選択式の質問リストを生成
- mode="save": 回答をもとにプロジェクトメタ情報を保存`,
  inputSchema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["generate", "save"],
        description: "操作モード",
      },
      projectName: {
        type: "string",
        description: "プロジェクト名",
      },
      projectPath: {
        type: "string",
        description: "プロジェクトの絶対パス（mode=save時に必須）",
      },
      initialInfo: {
        type: "string",
        description: "プロジェクトの初期情報（mode=generate時、省略可）",
      },
      answers: {
        type: "object",
        description: "質問への回答（mode=save時に必須）。キーは質問のkey、値は選択した回答",
        additionalProperties: { type: "string" },
      },
    },
    required: ["mode", "projectName"],
  },
};

export async function handleProjectInit(
  args: Record<string, unknown>,
): Promise<string> {
  const mode = args.mode as string;
  const projectName = args.projectName as string;

  if (!mode || !projectName) {
    return JSON.stringify({ error: "mode と projectName は必須です" });
  }

  const initializer = new ProjectInitializer(SCHEDULER_DIR);

  if (mode === "generate") {
    try {
      const output = await initializer.generateQuestions(
        projectName,
        args.initialInfo as string | undefined,
      );
      return JSON.stringify(output, null, 2);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return JSON.stringify({ error: message });
    }
  }

  if (mode === "save") {
    const projectPath = args.projectPath as string;
    const answers = args.answers as Record<string, string>;

    if (!projectPath) {
      return JSON.stringify({ error: "mode=save には projectPath が必須です" });
    }
    if (!answers) {
      return JSON.stringify({ error: "mode=save には answers が必須です" });
    }

    try {
      const meta = await initializer.saveProjectMeta(projectName, projectPath, answers);
      return JSON.stringify({
        success: true,
        message: `プロジェクト "${projectName}" のメタ情報を保存しました。`,
        meta,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return JSON.stringify({ error: message });
    }
  }

  return JSON.stringify({ error: `無効なmode: ${mode}。generate/saveから選択してください` });
}
