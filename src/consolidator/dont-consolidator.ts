import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "../config.js";
import { ConsolidatedDont, MemoryEntry } from "../types.js";
import { loadPrompt } from "../analyzer/prompt-loader.js";
import { escapePromptVariable } from "../utils/prompt-escape.js";

type GenerateContentFn = (prompt: string) => Promise<string>;

export class DontConsolidator {
  private generateContent: GenerateContentFn;

  constructor(generateContent?: GenerateContentFn) {
    if (generateContent) {
      this.generateContent = generateContent;
    } else {
      if (!config.geminiApiKey) {
        throw new Error("GEMINI_API_KEY is not set");
      }
      const genAI = new GoogleGenerativeAI(config.geminiApiKey);
      const model = genAI.getGenerativeModel({ model: config.geminiModel });
      this.generateContent = async (prompt: string) => {
        const result = await model.generateContent(prompt);
        return result.response.text();
      };
    }
  }

  async consolidate(entries: MemoryEntry[]): Promise<ConsolidatedDont | null> {
    if (entries.length === 0) return null;

    try {
      const template = await loadPrompt("consolidate.txt");

      const entriesList = entries
        .map(e => `- id: ${e.id} | title: ${e.title} | content: ${e.content}`)
        .join("\n");

      const prompt = template.replace("{{dontEntries}}", escapePromptVariable(entriesList));

      const text = await this.generateContent(prompt);

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]);

      const now = new Date();
      const jstOffset = 9 * 60 * 60 * 1000;
      const jst = new Date(now.getTime() + jstOffset);
      const timestamp = jst.toISOString().replace("Z", "+09:00");

      return {
        principles: parsed.principles,
        consolidatedAt: timestamp,
        sourceEntryCount: entries.length,
        version: 1,
      };
    } catch {
      return null;
    }
  }
}
