import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { MarkdownStorage } from "../storage/index.js";

export const memoryUpdateIntensityTool: Tool = {
  name: "memory_update_intensity",
  description: `既存メモリエントリのintensity（重要度）だけを変更する。
ピン留め運用に使う: intensity 6以上を設定するとcontext注入で最優先される。
memory_searchで取得したIDを指定すること。`,
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "更新対象エントリのID"
      },
      intensity: {
        type: "number",
        description: "新しいintensity値（1〜10の整数）。6以上は手動ピン留め用"
      }
    },
    required: ["id", "intensity"]
  }
};

export async function handleMemoryUpdateIntensity(
  args: Record<string, unknown>,
  projectRoot: string
): Promise<string> {
  const storage = new MarkdownStorage(projectRoot);

  const id = args.id as string;
  const raw = Number(args.intensity);

  if (isNaN(raw)) {
    throw new Error(`Invalid intensity value: ${args.intensity}`);
  }

  const intensity = Math.min(10, Math.max(1, Math.round(raw)));

  const result = await storage.updateIntensity(id, intensity);

  return JSON.stringify({
    success: result.success,
    id: result.id,
    category: result.category,
    intensity,
    message: `Updated intensity to ${intensity} for entry ${result.id} in ${result.category}`,
  }, null, 2);
}
