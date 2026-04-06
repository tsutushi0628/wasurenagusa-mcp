import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { SQLiteStorage } from "../storage/sqlite.js";
import { StashParams } from "../types.js";
import { config, getMemoryPath } from "../config.js";
import { join } from "path";

export const memoryStashTool: Tool = {
  name: "memory_stash",
  description: `ファイル全文やコードブロックを短期退避する。
コンテキストウインドウから大きなテキストを退避し、後で memory_restore で復元できる。
デフォルト24時間で自動期限切れ。要約のみ返却されるため、コンテキストを節約できる。`,
  inputSchema: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "退避するテキスト（ファイル全文、コードブロック等）",
      },
      filePath: {
        type: "string",
        description: "元ファイルパス（オプション）",
      },
      fileType: {
        type: "string",
        description: "ファイル拡張子（オプション。例: ts, py, md）",
      },
      ttlHours: {
        type: "number",
        description: "有効期限（時間）。デフォルト24時間",
      },
    },
    required: ["content"],
  },
};

export function handleMemoryStash(
  args: Record<string, unknown>,
  projectRoot: string,
): string {
  const memoryPath = getMemoryPath(projectRoot);
  const dbPath = join(memoryPath, config.sqliteFile);
  const storage = new SQLiteStorage(dbPath);

  try {
    storage.initialize();

    const params: StashParams = {
      content: args.content as string,
      filePath: args.filePath as string | undefined,
      fileType: args.fileType as string | undefined,
      ttlHours: args.ttlHours as number | undefined,
    };

    const result = storage.stash(params);
    return JSON.stringify(result, null, 2);
  } finally {
    storage.close();
  }
}
