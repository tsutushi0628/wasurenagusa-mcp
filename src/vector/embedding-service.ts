import { createEmbedTextFn, DEFAULT_EMBEDDING_MODEL } from "../llm/provider.js";
import { increment } from "../observability/counters.js";

// 遠隔埋め込みモデル名の単一真実源は src/llm/provider.ts の DEFAULT_EMBEDDING_MODEL
// （タスク3.15でGenkit経路へ統合。旧ローカル定数 EMBEDDING_MODEL は撤去）。
export const EMBEDDING_MODEL = DEFAULT_EMBEDDING_MODEL;
export const EMBEDDING_DIMENSIONS = 768;

export class EmbeddingService {
  private apiKey: string;
  private memoryPath: string;

  constructor(apiKey: string, memoryPath: string) {
    this.apiKey = apiKey;
    this.memoryPath = memoryPath;
  }

  isAvailable(): boolean {
    if (this.apiKey.length === 0) {
      return false;
    }
    return true;
  }

  async embed(text: string): Promise<number[]> {
    try {
      const embedText = createEmbedTextFn();
      // taskTypeは従来どおり常時RETRIEVAL_DOCUMENT固定（クエリ/文書の非対称は
      // タスク3.15④で判定済みの既知の設計課題。挙動は変更せず現状維持）。
      return await embedText(text, "RETRIEVAL_DOCUMENT");
    } catch (error) {
      console.error("[embedding-service] 埋め込み失敗:", error);
      await increment(this.memoryPath, "embedding_failure_count", 1);
      throw error;
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (const text of texts) {
      const embedding = await this.embed(text);
      results.push(embedding);
    }
    return results;
  }
}
