import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { SQLiteStorage } from "../storage/sqlite.js";
import { config, getMemoryPath } from "../config.js";
import { join } from "path";

export const memoryRestoreTool: Tool = {
  name: "memory_restore",
  description: `memory_stash で退避したテキストを復元する。
IDを指定すると、退避されたフル内容を返す。
TTL（デフォルト24時間）を超過したエントリは復元不可。`,
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "memory_stash で返されたID",
      },
    },
    required: ["id"],
  },
};

export function handleMemoryRestore(
  args: Record<string, unknown>,
  projectRoot: string,
): string {
  const memoryPath = getMemoryPath(projectRoot);
  const dbPath = join(memoryPath, config.sqliteFile);
  const storage = new SQLiteStorage(dbPath);

  try {
    storage.initialize();

    const id = args.id as string;
    const result = storage.restore(id);

    // 期限切れstashのクリーンアップも実行
    storage.cleanExpiredStash();

    return JSON.stringify(result, null, 2);
  } finally {
    storage.close();
  }
}
