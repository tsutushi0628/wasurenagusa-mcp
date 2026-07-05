import { GoogleGenerativeAI } from "@google/generative-ai";
import { WeightedTag } from "../types.js";
import { loadPrompt } from "../analyzer/prompt-loader.js";

// リポジトリ標準のGemini世代（src/llm/provider.ts の既定）に揃える。
// 旧 gemini-2.0-flash は提供終了で404を返すことを実APIで確認済み（2026-07-05）。
// provider側だけ世代更新されたときのドリフトは tag-enricher.test.ts の一致テストが検知する。
export const TAG_MODEL = "gemini-3.1-flash-lite";

export interface EnrichResult {
  tags: WeightedTag[];
  newThemes: string[];
}

export class TagEnricher {
  private genAI: GoogleGenerativeAI;
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.genAI = new GoogleGenerativeAI(apiKey);
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

      const model = this.genAI.getGenerativeModel({ model: TAG_MODEL });
      const result = await model.generateContent(prompt);
      const text = result.response.text();

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
