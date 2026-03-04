import { ConsolidatedDont, MemoryEntry } from "../types.js";
import { loadPrompt } from "../analyzer/prompt-loader.js";
import { escapePromptVariable } from "../utils/prompt-escape.js";
import { GenerateTextFn, createGenerateTextFn } from "../llm/provider.js";

export class DontConsolidator {
  private generateText: GenerateTextFn;

  constructor(generateText?: GenerateTextFn) {
    if (generateText) {
      this.generateText = generateText;
    } else {
      this.generateText = createGenerateTextFn();
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

      const text = await this.generateText(prompt);

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
