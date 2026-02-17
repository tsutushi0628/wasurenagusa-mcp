import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { MarkdownStorage } from "../storage/index.js";
import { GetDetailParams } from "../types.js";

export const memoryGetDetailTool: Tool = {
  name: "memory_get_detail",
  description: `memory_search で取得したIDを指定して、メモリのフル詳細を取得する。
複数IDを一括指定可能。必要なものだけ取得してトークンを節約すること。`,
  inputSchema: {
    type: "object",
    properties: {
      ids: {
        type: "array",
        items: { type: "string" },
        description: "取得したいメモリエントリのID配列"
      }
    },
    required: ["ids"]
  }
};

export async function handleMemoryGetDetail(
  args: Record<string, unknown>,
  projectRoot: string
): Promise<string> {
  const storage = new MarkdownStorage(projectRoot);

  const params: GetDetailParams = {
    ids: args.ids as string[]
  };

  const result = await storage.getDetail(params);

  return JSON.stringify(result, null, 2);
}
