import { pipeline, env, type FeatureExtractionPipeline } from "@huggingface/transformers";

export const EMBEDDING_DIMENSIONS = 384;
const DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2";

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

  async embed(text: string): Promise<number[]> {
    if (!text) {
      throw new Error("embed: text must not be empty");
    }
    if (!this.extractor) {
      throw new Error("LocalEmbedding not initialized. Call initialize() first.");
    }

    const output = await this.extractor(text, {
      pooling: "mean",
      normalize: true,
    });

    return Array.from(output.data as Float32Array);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      throw new Error("embedBatch: texts must not be empty");
    }
    if (!this.extractor) {
      throw new Error("LocalEmbedding not initialized. Call initialize() first.");
    }

    const output = await this.extractor(texts, {
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
