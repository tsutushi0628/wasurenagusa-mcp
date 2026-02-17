import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { TaskStore } from "../autonomous/task-store.js";
import { ActionList } from "../autonomous/action-list.js";
import { homedir } from "os";
import { join } from "path";

const SCHEDULER_DIR = join(homedir(), ".wasurenagusa", "scheduler");

export const taskActionListTool: Tool = {
  name: "task_action_list",
  description: `人間アクションリストを管理する。AIが解決できなかったタスクの一覧表示と対応操作。

操作モード:
- mode="list"（デフォルト）: アクションリストを表示
- mode="resolve": タスクに対応（action: "retry"=再実行, "complete"=手動解決済み, "cancel"=対応不要）`,
  inputSchema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["list", "resolve"],
        description: "操作モード（デフォルト: list）",
      },
      taskId: {
        type: "string",
        description: "対応するタスクID（mode=resolve時に必須）",
      },
      action: {
        type: "string",
        enum: ["retry", "complete", "cancel"],
        description: "対応アクション（mode=resolve時に必須）",
      },
    },
  },
};

export async function handleTaskActionList(
  args: Record<string, unknown>,
): Promise<string> {
  const mode = (args.mode as string) ?? "list";
  const store = new TaskStore(SCHEDULER_DIR);
  const actionList = new ActionList(SCHEDULER_DIR);

  if (mode === "resolve") {
    const taskId = args.taskId as string;
    const action = args.action as "retry" | "complete" | "cancel";

    if (!taskId || !action) {
      return JSON.stringify({ error: "mode=resolve には taskId と action が必須です" });
    }

    const validActions = ["retry", "complete", "cancel"];
    if (!validActions.includes(action)) {
      return JSON.stringify({ error: `無効なaction: ${action}。retry/complete/cancelから選択してください` });
    }

    try {
      await store.resolveAction(taskId, action);
      await actionList.resolve(taskId);
      return JSON.stringify({
        success: true,
        message: `タスク ${taskId} を "${action}" で解決しました。`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return JSON.stringify({ error: message });
    }
  }

  // mode=list
  const items = await actionList.getAll();
  if (items.length === 0) {
    return JSON.stringify({
      message: "人間アクションリストは空です。全てのタスクはAIが処理済み、または対応済みです。",
      items: [],
    });
  }

  // プロジェクト別グルーピング
  const grouped: Record<string, typeof items> = {};
  for (const item of items) {
    if (!grouped[item.project]) {
      grouped[item.project] = [];
    }
    grouped[item.project].push(item);
  }

  return JSON.stringify({ items: grouped }, null, 2);
}
