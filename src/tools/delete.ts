import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { MarkdownStorage } from "../storage/index.js";
import { VectorStore } from "../vector/vector-store.js";
import { getMemoryPath } from "../config.js";

export const memoryDeleteTool: Tool = {
  name: "memory_delete",
  description: `メモリエントリを削除する。memory_searchで取得したIDを指定して削除。
複数IDを一括指定可能。カテゴリをまたいだ削除もOK。`,
  inputSchema: {
    type: "object",
    properties: {
      ids: {
        type: "array",
        items: { type: "string" },
        description: "削除したいエントリのID配列"
      }
    },
    required: ["ids"]
  }
};

export async function handleMemoryDelete(
  args: Record<string, unknown>,
  projectRoot: string
): Promise<string> {
  const storage = new MarkdownStorage(projectRoot);

  const ids = args.ids as string[];

  const result = await storage.delete({ ids });

  // ベクトル削除
  try {
    const vectorStore = new VectorStore(getMemoryPath(projectRoot));
    await vectorStore.delete(result.deleted);
  } catch (error) {
    console.error("[vector] ベクトル削除失敗:", error);
    // ベクトル削除失敗はメモリ削除結果に影響しない
  }

  return JSON.stringify(result, null, 2);
}
