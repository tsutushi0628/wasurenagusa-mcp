import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { MarkdownStorage } from "../storage/index.js";
import { SearchParams, MemoryCategory } from "../types.js";

export const memorySearchTool: Tool = {
  name: "memory_search",
  description: `メモリを検索する。【重要】このツールは軽量インデックス（ID, タイトル, タグ）のみを返す。
フル内容が必要な場合は、返されたIDを memory_get_detail に渡すこと。
全件の詳細を取得せず、必要なものだけ取得してトークンを節約すること。`,
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "検索クエリ（キーワード）"
      },
      category: {
        type: "string",
        enum: ["config", "dont", "decision", "log", "snippet", "all"],
        description: "検索対象カテゴリ。デフォルトはall"
      },
      limit: {
        type: "number",
        description: "最大取得件数。デフォルトは20"
      },
      project: {
        type: "string",
        description: "プロジェクトフィルタ（オプション）。指定するとそのプロジェクト+プロジェクト未指定のエントリのみ返却"
      },
      scope: {
        type: "string",
        description: "スコープフィルタ（オプション）。指定するとそのscope+general+scope未指定のエントリのみ返却"
      }
    },
    required: ["query"]
  }
};

export async function handleMemorySearch(
  args: Record<string, unknown>,
  projectRoot: string
): Promise<string> {
  const storage = new MarkdownStorage(projectRoot);

  const params: SearchParams = {
    query: args.query as string,
    category: (args.category as MemoryCategory | "all") || "all",
    limit: (args.limit as number) || 20,
    project: args.project as string | undefined,
    scope: args.scope as string | undefined,
  };

  const result = await storage.search(params);

  return JSON.stringify(result, null, 2);
}
