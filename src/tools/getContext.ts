import { basename } from "path";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { MarkdownStorage } from "../storage/index.js";

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
  const storage = new MarkdownStorage(projectRoot);
  const currentProject = basename(projectRoot);
  const result = await storage.getContext(currentProject);

  return JSON.stringify(result, null, 2);
}
