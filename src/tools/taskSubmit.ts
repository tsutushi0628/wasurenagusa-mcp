import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { TaskStore } from "../autonomous/task-store.js";
import { ProjectInitializer } from "../autonomous/project-initializer.js";
import { homedir } from "os";
import { join } from "path";

const SCHEDULER_DIR = join(homedir(), ".wasurenagusa", "scheduler");

export const taskSubmitTool: Tool = {
  name: "task_submit",
  description: `自律タスクを投入する。AIが24/365で自動実行し、完了条件を満たすまでリトライする。

投入する4項目:
- why: なぜやるか（背景・目的）
- what: どんな体験/行動変容を与えたいか
- done: 完了条件（機械検証可能な基準。例: "npx tsc通過 + vitest全パス"）
- project: プロジェクト名`,
  inputSchema: {
    type: "object",
    properties: {
      why: {
        type: "string",
        description: "なぜやるか（背景・目的）",
      },
      what: {
        type: "string",
        description: "どんな体験/行動変容を与えたいか",
      },
      done: {
        type: "string",
        description: "完了条件（機械検証可能な基準）",
      },
      project: {
        type: "string",
        description: "プロジェクト名",
      },
    },
    required: ["why", "what", "done", "project"],
  },
};

export async function handleTaskSubmit(
  args: Record<string, unknown>,
): Promise<string> {
  const why = args.why as string;
  const what = args.what as string;
  const done = args.done as string;
  const project = args.project as string;

  if (!why || !what || !done || !project) {
    return JSON.stringify({ error: "why, what, done, project は全て必須です" });
  }

  const store = new TaskStore(SCHEDULER_DIR);
  const initializer = new ProjectInitializer(SCHEDULER_DIR);

  // プロジェクトメタからprojectPathを取得
  const meta = await initializer.loadProjectMeta(project);
  let projectPath = "";
  if (meta) {
    projectPath = meta.projectPath;
  }

  if (!projectPath) {
    return JSON.stringify({
      error: `プロジェクト "${project}" のメタ情報が見つかりません。先に project_init でプロジェクトを登録してください。`,
    });
  }

  try {
    const task = await store.submit({ why, what, done, project }, projectPath);
    return JSON.stringify({
      success: true,
      taskId: task.id,
      message: `タスク "${what}" を投入しました。スケジューラーが自動的に実行します。`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return JSON.stringify({ error: message });
  }
}
