import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { SQLiteStorage } from "../storage/index.js";
import { GetDetailParams } from "../types.js";
import { config, getMemoryPath } from "../config.js";
import { join, basename } from "path";
import { logOperation, resolveParentSessionId, generateGetDetailSessionId, generateJstTimestamp } from "../utils/operation-logger.js";

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
  const startTime = Date.now();
  const memoryPath = getMemoryPath(projectRoot);
  const dbPath = join(memoryPath, config.sqliteFile);
  const storage = new SQLiteStorage(dbPath);
  const project = basename(projectRoot);

  try {
    storage.initialize();

    const params: GetDetailParams = {
      ids: args.ids as string[]
    };

    const result = storage.getDetail(params);

    // アクセスカウント更新（再浮上メカニズム）
    const foundIds = result.entries.map(e => e.id);
    if (foundIds.length > 0) {
      storage.incrementAccessCount(foundIds);
      // 埋め込み非依存の最終読取時刻を刻む（get_detail はフル内容を返す唯一の明示的取得経路）。
      // 忘却 dry-run が参照時刻の一次シグナルとして使う（last_read_at 専用・順位付けに不干渉）。
      storage.markLastRead(foundIds);
    }

    const resultJson = JSON.stringify(result, null, 2);
    const requestedIds = params.ids;
    const parentSessionId = resolveParentSessionId(project, requestedIds);
    void logOperation({ ts: generateJstTimestamp(), operation_type: "get_detail", session_id: generateGetDetailSessionId(), parent_session_id: parentSessionId, requested_ids: requestedIds, found_count: foundIds.length, project, duration_ms: Date.now() - startTime }, memoryPath).catch(() => {});
    return resultJson;
  } finally {
    storage.close();
  }
}
