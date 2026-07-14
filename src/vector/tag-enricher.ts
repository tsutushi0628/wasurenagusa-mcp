import { WeightedTag } from "../types.js";
import { loadPrompt } from "../analyzer/prompt-loader.js";
import { createGenerateTextFn, DEFAULT_MODELS } from "../llm/provider.js";
import { increment } from "../observability/counters.js";

// リポジトリ標準のGemini世代（src/llm/provider.ts の既定）に揃える。
// 単一真実源は provider.ts の DEFAULT_MODELS.gemini（タスク3.15でGenkit経路へ統合）。
export const TAG_MODEL = DEFAULT_MODELS.gemini;

export interface EnrichResult {
  tags: WeightedTag[];
  newThemes: string[];
}

export class TagEnricher {
  private apiKey: string;
  private memoryPath: string;

  constructor(apiKey: string, memoryPath: string) {
    this.apiKey = apiKey;
    this.memoryPath = memoryPath;
  }

  isAvailable(): boolean {
    return this.apiKey.length > 0;
  }

  async enrich(
    title: string,
    content: string,
    existingTags: string[],
    existingThemes: string[],
  ): Promise<EnrichResult> {
    try {
      const promptTemplate = await loadPrompt("tag-enrichment.txt");
      const prompt = promptTemplate
        .replace("{{title}}", title)
        .replace("{{content}}", content)
        .replace("{{existingTags}}", existingTags.join(", "));

      const generateText = createGenerateTextFn();
      const text = await generateText(prompt);

      const parsed = this.parseResponse(text);
      if (!parsed) {
        return this.fallback(existingTags);
      }

      const tags = parsed.map((item) => ({
        tag: item.tag,
        weight: Math.min(1.0, Math.max(0.0, item.weight)),
      }));

      const themeSet = new Set(existingThemes);
      const newThemes = tags
        .filter((t) => t.weight >= 0.5 && !themeSet.has(t.tag))
        .map((t) => t.tag);

      return { tags, newThemes };
    } catch (error) {
      console.error("[tag-enricher] タグ拡張失敗:", error);
      await increment(this.memoryPath, "tag_enrich_failure_count", 1);
      return this.fallback(existingTags);
    }
  }

  private parseResponse(
    text: string,
  ): Array<{ tag: string; weight: number }> | null {
    try {
      // Remove markdown code block wrapping if present
      const cleaned = text.replace(/```json?\s*/g, "").replace(/```\s*/g, "").trim();
      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) {
        return null;
      }
      for (const item of parsed) {
        if (typeof item.tag !== "string" || typeof item.weight !== "number") {
          return null;
        }
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private fallback(existingTags: string[]): EnrichResult {
    return {
      tags: existingTags.map((tag) => ({ tag, weight: 1.0 })),
      newThemes: [],
    };
  }
}
