import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { basename } from "path";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { MarkdownStorage } from "../storage/index.js";
import { SaveParams, MemoryCategory } from "../types.js";
import { EmbeddingService } from "../vector/embedding-service.js";
import { VectorStore } from "../vector/vector-store.js";
import { TagEnricher } from "../vector/tag-enricher.js";
import { formatWeightedTags } from "../vector/weighted-tag.js";
import { ThemeRegistry } from "../vector/theme-registry.js";
import { config, getMemoryPath } from "../config.js";

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
      intensity: {
        type: "number",
        description: "怒られ度（オプション、1〜10の整数）。1=提案, 2=軽い注意, 3=明確な指摘, 4=強い不満, 5=激怒・諦め。6以上は手動ピン留め用（数値が大きいほどcontext注入で優先される）。指定時はLLM自動判定より優先される"
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

function spawnRetagWorker(newThemes: string[], projectRoot: string): void {
  const scriptPath = fileURLToPath(new URL("../cli/retag-worker.js", import.meta.url));
  const child = spawn(process.execPath, [scriptPath, JSON.stringify(newThemes), projectRoot], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}

export async function handleMemorySave(
  args: Record<string, unknown>,
  projectRoot: string
): Promise<string> {
  const storage = new MarkdownStorage(projectRoot);

  let intensity: number | undefined;
  if (args.intensity !== undefined && args.intensity !== null) {
    const raw = Number(args.intensity);
    if (!isNaN(raw)) {
      const rounded = Math.round(raw);
      intensity = Math.min(10, Math.max(1, rounded));
    }
  }

  const params: SaveParams = {
    category: args.category as MemoryCategory,
    title: args.title as string,
    content: args.content as string,
    tags: normalizeTags(args.tags),
    project: basename(projectRoot),
    scope: args.scope as string | undefined,
    intensity,
  };

  const embeddingService = new EmbeddingService(config.geminiApiKey);
  const apiAvailable = embeddingService.isAvailable();

  // Phase 1: タグ拡張 + Embedding生成を並列実行（APIキーがある場合のみ）
  let embedding: number[] | null = null;
  if (apiAvailable) {
    const tagEnricher = new TagEnricher(config.geminiApiKey);
    const textToEmbed = params.title + " " + params.content;

    const [enrichResult, embeddingResult] = await Promise.allSettled([
      tagEnricher.enrich(params.title, params.content, params.tags ?? [], []),
      embeddingService.embed(textToEmbed),
    ]);

    // タグ拡張結果を適用
    if (enrichResult.status === "fulfilled") {
      params.tags = formatWeightedTags(enrichResult.value.tags);

      // Phase 2: 新テーマ検出 → RetagWorker spawn（非同期・非ブロッキング）
      if (enrichResult.value.newThemes.length > 0) {
        try {
          const memoryPath = getMemoryPath(projectRoot);
          const themeRegistry = new ThemeRegistry(memoryPath);
          const trulyNewThemes: string[] = [];
          for (const theme of enrichResult.value.newThemes) {
            if (await themeRegistry.isNewTheme(theme)) {
              trulyNewThemes.push(theme);
            }
          }
          if (trulyNewThemes.length > 0) {
            await themeRegistry.addThemes(trulyNewThemes);
            spawnRetagWorker(trulyNewThemes, projectRoot);
          }
        } catch (error) {
          console.error("[save] テーマ登録失敗:", error);
        }
      }
    }
    // enrichment失敗時はparams.tagsは元のまま

    if (embeddingResult.status === "fulfilled") {
      embedding = embeddingResult.value;
    } else {
      console.error("[vector] embedding生成失敗:", embeddingResult.reason);
    }
  }

  // 保存（enriched tagsで）
  const result = await storage.save(params);

  // Embedding upsert
  if (embedding) {
    try {
      const memoryPath = getMemoryPath(projectRoot);
      if (params.replaceId) {
        const vectorStore = new VectorStore(memoryPath);
        await vectorStore.delete([params.replaceId]);
      }
      const vectorStore = new VectorStore(memoryPath);
      await vectorStore.upsert(result.id, embedding);
    } catch (error) {
      console.error("[vector] embedding保存失敗:", error);
    }
  }

  return JSON.stringify(result, null, 2);
}
