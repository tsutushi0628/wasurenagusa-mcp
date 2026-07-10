import { basename, join } from "path";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { SQLiteStorage } from "../storage/sqlite.js";
import { SaveParams, MemoryCategory } from "../types.js";
import { LocalEmbedding } from "../vector/local-embedding.js";
import { TagEnricher } from "../vector/tag-enricher.js";
import { formatWeightedTags } from "../vector/weighted-tag.js";
import { computePredictionError } from "../vector/prediction-error.js";
import { config, getMemoryPath, getModelsDir } from "../config.js";

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
      project: {
        type: "string",
        description: "この記憶の実作業プロジェクト名（省略時は起動プロジェクト名。別プロジェクト作業中は必ずそのプロジェクト名を渡す）"
      },
      scope: {
        type: "string",
        description: "スコープ（オプション）。推奨候補: frontend, backend, infra, design, spec, ai, general。自由入力も可"
      },
      intensity: {
        type: "number",
        description: "怒られ度（オプション、1〜10の整数）。1=提案, 2=軽い注意, 3=明確な指摘, 4=強い不満, 5=激怒・諦め。6以上は手動ピン留め用（数値が大きいほどcontext注入で優先される）。指定時はLLM自動判定より優先される"
      },
      positiveAction: {
        type: "string",
        description: "category=dont 時に推奨。この記憶から導かれる「次に取るべき自律行動」を肯定形で1行（30〜80字）。否定形は使わない"
      },
      scenario: {
        type: "string",
        description: "category=dont 時に推奨。何が起きたかの事象を1行（40〜80字）。いつ・どこで・何をしたかを具体的に記述"
      },
      whyCore: {
        type: "string",
        description: "category=dont 時に推奨。なぜその行動がダメなのかの核心を1行（30〜80字）。根本的な問題構造を記述"
      },
      predictedFactors: {
        type: "array",
        items: { type: "string" },
        description: "着手前に『この問題で効く』と見立てた変数（最大3）。後で actualFactors と突合して予測誤差を自動算出する"
      },
      actualFactors: {
        type: "array",
        items: { type: "string" },
        description: "終了後に実際効いた変数。predictedFactors と両方あると predictionError が自動計算される"
      },
      predictionDelta: {
        type: "string",
        description: "予測と実測の差分の核心を1行（任意、30〜80字）"
      }
    },
    required: ["category", "title", "content"]
  }
};

function normalizeTags(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string") {
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
  const memoryPath = getMemoryPath(projectRoot);
  const dbPath = join(memoryPath, config.sqliteFile);
  const storage = new SQLiteStorage(dbPath);
  storage.initialize(memoryPath);

  let intensity: number | undefined;
  if (args.intensity !== undefined && args.intensity !== null) {
    const raw = Number(args.intensity);
    if (!isNaN(raw)) {
      const rounded = Math.round(raw);
      intensity = Math.min(10, Math.max(1, rounded));
    }
  }

  const positiveAction = args.positiveAction as string | undefined;
  if (args.category === "dont" && positiveAction !== undefined && positiveAction.trim() === "") {
    return JSON.stringify({ success: false, error: "positiveAction は空文字にできません（category=dont では必須です）" }, null, 2);
  }

  const scenario = args.scenario as string | undefined;
  const whyCore = args.whyCore as string | undefined;

  // 予測誤差ループ: 渡された見立て・実測を配列化（normalizeTags を流用）
  const predictedFactors = args.predictedFactors !== undefined ? normalizeTags(args.predictedFactors) : undefined;
  const actualFactors = args.actualFactors !== undefined ? normalizeTags(args.actualFactors) : undefined;
  const predictionDelta = args.predictionDelta as string | undefined;

  // 両方が非空なら差分を自動算出（undefined ならフィールド省略）。差分計算はコード側で完結（LLM不使用）。
  let predictionError: number | undefined;
  if (predictedFactors && predictedFactors.length > 0 && actualFactors && actualFactors.length > 0) {
    predictionError = computePredictionError(predictedFactors, actualFactors);
  }

  // project帰属（design.md禁止フォールバック#5）: 明示指定があればconfirmed、
  // 省略・空文字時はcwd由来のbasenameへ暗黙フォールバックせず、unknownを明示刻印して
  // 検索対象に残す（不明バケツをフィルタの裏に消さない。R-A4 AC3）。
  let project: string;
  let projectConfidence: "confirmed" | "unknown";
  if (typeof args.project === "string" && args.project.trim() !== "") {
    project = args.project.trim();
    projectConfidence = "confirmed";
  } else {
    project = "unknown";
    projectConfidence = "unknown";
    console.error(`[save] project省略のためunknownを明示刻印しました（起動プロジェクト: ${basename(projectRoot)}）`);
  }

  const params: SaveParams = {
    category: args.category as MemoryCategory,
    title: args.title as string,
    content: args.content as string,
    tags: normalizeTags(args.tags),
    project,
    projectConfidence,
    scope: args.scope as string | undefined,
    intensity,
    positiveAction,
    scenario,
    whyCore,
    predictedFactors,
    actualFactors,
    predictionError,
    predictionDelta,
  };

  // LocalEmbedding初期化（WASURENAGUSA_MODEL_CACHE_DIR設定時は共有キャッシュ先へ、タスク1.13）
  const modelsDir = getModelsDir(memoryPath);
  const localEmbedding = new LocalEmbedding(modelsDir);
  let embeddingAvailable = false;
  try {
    await localEmbedding.initialize();
    embeddingAvailable = localEmbedding.isAvailable();
  } catch (error) {
    console.error("[save] LocalEmbedding初期化失敗:", error);
  }

  // Phase 1: タグ拡張 + Embedding生成を並列実行
  let embedding: number[] | null = null;
  const tagEnricher = new TagEnricher(config.geminiApiKey);
  const tagEnricherAvailable = !!config.geminiApiKey;

  const promises: Promise<unknown>[] = [];

  // タグ拡張（LLMのAPIキーが必要）
  if (tagEnricherAvailable) {
    promises.push(
      tagEnricher.enrich(params.title, params.content, params.tags ?? [], []).catch((error) => {
        console.error("[save] タグ拡張失敗:", error);
        return null;
      })
    );
  } else {
    promises.push(Promise.resolve(null));
  }

  // Embedding生成（ローカル）
  if (embeddingAvailable) {
    const textToEmbed = params.title + " " + params.content;
    promises.push(
      localEmbedding.embed(textToEmbed, "passage").catch((error) => {
        console.error("[save] embedding生成失敗:", error);
        return null;
      })
    );
  } else {
    promises.push(Promise.resolve(null));
  }

  const [enrichResult, embeddingResult] = await Promise.all(promises);

  // タグ拡張結果を適用
  if (enrichResult && typeof enrichResult === "object" && "tags" in enrichResult) {
    const enriched = enrichResult as { tags: { tag: string; weight: number }[]; newThemes: string[] };
    params.tags = formatWeightedTags(enriched.tags);

    // Phase 2: 新テーマ検出 → SQLiteのthemesテーブルへ登録（v1書き込み経路のretag-worker
    // spawnは物理遮断済み。再タグ付け自体はPhase3以降で夜間統合に相乗りさせる想定）
    if (enriched.newThemes.length > 0) {
      try {
        const trulyNewThemes: string[] = [];
        for (const theme of enriched.newThemes) {
          if (storage.isNewTheme(theme)) {
            trulyNewThemes.push(theme);
          }
        }
        if (trulyNewThemes.length > 0) {
          storage.addThemes(trulyNewThemes);
        }
      } catch (error) {
        console.error("[save] テーマ登録失敗:", error);
      }
    }
  }

  if (embeddingResult && Array.isArray(embeddingResult)) {
    embedding = embeddingResult as number[];
  }

  // replaceId指定時: 古いベクトルを削除
  if (params.replaceId) {
    try {
      storage.deleteVectors([params.replaceId]);
    } catch (error) {
      console.error("[save] 旧ベクトル削除失敗:", error);
    }
  }

  // 保存
  const result = storage.save(params);

  // Embedding upsert
  if (embedding) {
    try {
      storage.upsertVector(result.id, embedding);
    } catch (error) {
      console.error("[save] embedding保存失敗:", error);
    }
  }

  storage.close();
  return JSON.stringify(result, null, 2);
}
