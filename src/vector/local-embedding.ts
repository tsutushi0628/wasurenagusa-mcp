import { pipeline, env, type FeatureExtractionPipeline } from "@huggingface/transformers";

export const EMBEDDING_DIMENSIONS = 384;
// 多言語モデル（日本語含む意味検索の自己検索実測: top5 72.0%→92.7%、圏外8.7%→2.0%）。
// 次元は384のまま変わらない（旧 Xenova/all-MiniLM-L6-v2 と同じベクトル表の器を使い続けられる）。
export const DEFAULT_MODEL = "Xenova/multilingual-e5-small";

// e5系モデルは非対称プレフィックスが前提（intfloat/multilingual-e5-smallモデルカード準拠）。
// 文書側（保存対象）は "passage: "、検索クエリ側は "query: " を付与しないと類似度分布が機能しない。
export type EmbedUsage = "passage" | "query";

export function buildPrefixedText(text: string, usage: EmbedUsage): string {
  const prefix = usage === "query" ? "query: " : "passage: ";
  return prefix + text;
}

export class LocalEmbedding {
  private extractor: FeatureExtractionPipeline | null = null;
  private readonly modelDir: string;
  private readonly modelName: string;

  constructor(modelDir: string, modelName: string = DEFAULT_MODEL) {
    this.modelDir = modelDir;
    this.modelName = modelName;
  }

  async initialize(): Promise<void> {
    // キャッシュディレクトリをmodelDirに設定
    env.cacheDir = this.modelDir;
    env.allowRemoteModels = true;

    this.extractor = await pipeline(
      "feature-extraction",
      this.modelName,
      { dtype: "fp32" },
    ) as FeatureExtractionPipeline;
  }

  isAvailable(): boolean {
    return this.extractor !== null;
  }

  async embed(text: string, usage: EmbedUsage): Promise<number[]> {
    if (!text) {
      throw new Error("embed: text must not be empty");
    }
    if (!this.extractor) {
      throw new Error("LocalEmbedding not initialized. Call initialize() first.");
    }

    const output = await this.extractor(buildPrefixedText(text, usage), {
      pooling: "mean",
      normalize: true,
    });

    return Array.from(output.data as Float32Array);
  }

  async embedBatch(texts: string[], usage: EmbedUsage): Promise<number[][]> {
    if (texts.length === 0) {
      throw new Error("embedBatch: texts must not be empty");
    }
    if (!this.extractor) {
      throw new Error("LocalEmbedding not initialized. Call initialize() first.");
    }

    const prefixedTexts = texts.map((t) => buildPrefixedText(t, usage));
    const output = await this.extractor(prefixedTexts, {
      pooling: "mean",
      normalize: true,
    });

    // バッチ出力: [batchSize, dimensions] の2Dテンソル
    const data = output.data as Float32Array;
    const dimensions = EMBEDDING_DIMENSIONS;
    const results: number[][] = [];

    for (let i = 0; i < texts.length; i++) {
      const start = i * dimensions;
      const end = start + dimensions;
      results.push(Array.from(data.slice(start, end)));
    }

    return results;
  }
}
