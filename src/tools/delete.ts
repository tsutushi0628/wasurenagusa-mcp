import { join } from "path";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { SQLiteStorage } from "../storage/index.js";
import { config, getMemoryPath } from "../config.js";

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
  const memoryPath = getMemoryPath(projectRoot);
  const dbPath = join(memoryPath, config.sqliteFile);
  const storage = new SQLiteStorage(dbPath);

  try {
    storage.initialize();

    const ids = args.ids as string[];
    const result = storage.delete({ ids });

    // ベクトル削除（SQLiteStorage統合済み）
    if (result.deleted.length > 0) {
      storage.deleteVectors(result.deleted);
    }

    return JSON.stringify(result, null, 2);
  } finally {
    storage.close();
  }
}
