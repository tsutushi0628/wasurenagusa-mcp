import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { TaskStore } from "../autonomous/task-store.js";
import { homedir } from "os";
import { join } from "path";

const SCHEDULER_DIR = join(homedir(), ".wasurenagusa", "scheduler");

export const taskStatusTool: Tool = {
  name: "task_status",
  description: `自律タスクの状態サマリを返す。pending/in-progress/completed/failed/human-required/cancelledの件数と直近20件のタスク一覧を表示。`,
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "プロジェクト名でフィルタ（省略時は全プロジェクト）",
      },
    },
  },
};

export async function handleTaskStatus(
  args: Record<string, unknown>,
): Promise<string> {
  const store = new TaskStore(SCHEDULER_DIR);
  const status = await store.getStatus();

  const project = args.project as string | undefined;
  if (project) {
    status.recentTasks = status.recentTasks.filter((t) => t.project === project);
  }

  return JSON.stringify(status, null, 2);
}
