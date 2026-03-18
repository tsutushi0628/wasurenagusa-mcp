import { GoogleGenerativeAI, TaskType } from "@google/generative-ai";

const EMBEDDING_MODEL = "gemini-embedding-001";
export const EMBEDDING_DIMENSIONS = 768;

export class EmbeddingService {
  private genAI: GoogleGenerativeAI;
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.genAI = new GoogleGenerativeAI(apiKey);
  }

  isAvailable(): boolean {
    if (this.apiKey.length === 0) {
      return false;
    }
    return true;
  }

  async embed(text: string): Promise<number[]> {
    const model = this.genAI.getGenerativeModel({ model: EMBEDDING_MODEL });
    const result = await model.embedContent({
      content: { parts: [{ text }], role: "user" },
      taskType: TaskType.RETRIEVAL_DOCUMENT,
    });
    return result.embedding.values;
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
