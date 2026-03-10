import { basename } from "path";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { MarkdownStorage } from "../storage/index.js";
import { SaveParams, MemoryCategory, MemoryImportance } from "../types.js";

export const memorySaveTool: Tool = {
  name: "memory_save",
  description: `メモリを保存する。カテゴリ:
- config: API URL、ポート、認証情報などの設定
- dont: やってはいけないこと、過去のミス、ユーザーが怒ったこと、AIのリトライパターン
- decision: 決定事項、採用した方針
- log: 実装したこと、解決したエラー
- snippet: よく使うコマンド、クエリ、便利スクリプト

titleには検索しやすい具体的な名詞を含めること。`,
  inputSchema: {
    type: "object",
    properties: {
      category: {
        type: "string",
        enum: ["config", "dont", "decision", "log", "snippet"],
        description: "メモリのカテゴリ"
      },
      title: {
        type: "string",
        description: "1行の要約タイトル（20文字以内推奨）。検索用の具体的な名詞を含める。例: 「本番API URL」「ログ未読への怒り」"
      },
      content: {
        type: "string",
        description: "保存する内容の詳細"
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "検索用タグ（オプション、最大5個）"
      },
      scope: {
        type: "string",
        description: "スコープ（オプション）。推奨候補: frontend, backend, infra, design, spec, ai, general。自由入力も可"
      },
      importance: {
        type: "string",
        enum: ["critical", "normal"],
        description: "記憶の強弱（オプション）。critical: 統合から除外され永続保持される重要な記憶。normal: 通常の記憶（デフォルト）"
      }
    },
    required: ["category", "title", "content"]
  }
};

function normalizeTags(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string") {
    // JSON配列文字列 or カンマ区切り
    const trimmed = raw.trim();
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed.map(String);
      } catch {
        // パース失敗時はカンマ区切りとして処理
      }
    }
    return trimmed.split(",").map(s => s.trim()).filter(Boolean);
  }
  return [];
}

export async function handleMemorySave(
  args: Record<string, unknown>,
  projectRoot: string
): Promise<string> {
  const storage = new MarkdownStorage(projectRoot);

  const params: SaveParams = {
    category: args.category as MemoryCategory,
    title: args.title as string,
    content: args.content as string,
    tags: normalizeTags(args.tags),
    project: basename(projectRoot),
    scope: args.scope as string | undefined,
    importance: args.importance as MemoryImportance | undefined,
  };

  const result = await storage.save(params);

  return JSON.stringify(result, null, 2);
}
