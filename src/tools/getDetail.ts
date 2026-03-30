import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { MarkdownStorage } from "../storage/index.js";
import { GetDetailParams } from "../types.js";
import { VectorStore } from "../vector/vector-store.js";
import { getMemoryPath } from "../config.js";

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

  // アクセスカウント更新（再浮上メカニズム）
  const foundIds = result.entries.map(e => e.id);
  if (foundIds.length > 0) {
    try {
      const memoryPath = getMemoryPath(projectRoot);
      const vectorStore = new VectorStore(memoryPath);
      await vectorStore.incrementAccessCount(foundIds);
    } catch (error) {
      console.error("[getDetail] アクセスカウント更新失敗:", error);
    }
  }

  return JSON.stringify(result, null, 2);
}
