import { basename } from "path";
import { join } from "path";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { SQLiteStorage } from "../storage/index.js";
import { config, getMemoryPath } from "../config.js";

export const memoryGetContextTool: Tool = {
  name: "memory_get_context",
  description: `config（設定情報）とdont（やってはいけないこと）を一括取得する。
通常はSessionStart Hookで自動注入されるため、手動で呼ぶ必要は少ない。
セッション途中でコンテキストを再確認したい場合に使用。`,
  inputSchema: {
    type: "object",
    properties: {},
    required: []
  }
};

export async function handleMemoryGetContext(
  _args: Record<string, unknown>,
  projectRoot: string
): Promise<string> {
  const memoryPath = getMemoryPath(projectRoot);
  const dbPath = join(memoryPath, config.sqliteFile);
  const storage = new SQLiteStorage(dbPath);

  try {
    storage.initialize();
    const currentProject = basename(projectRoot);
    const result = storage.getContext(currentProject);

    return JSON.stringify(result, null, 2);
  } finally {
    storage.close();
  }
}
