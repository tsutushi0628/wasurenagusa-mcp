import { ConsolidatedConfig, MemoryEntry } from "../types.js";
import { loadPrompt } from "../analyzer/prompt-loader.js";
import { escapePromptVariable } from "../utils/prompt-escape.js";
import { GenerateTextFn, createGenerateTextFn } from "../llm/provider.js";

export class ConfigConsolidator {
  private generateText: GenerateTextFn;

  constructor(generateText?: GenerateTextFn) {
    if (generateText) {
      this.generateText = generateText;
    } else {
      this.generateText = createGenerateTextFn();
    }
  }

  async consolidate(entries: MemoryEntry[]): Promise<ConsolidatedConfig | null> {
    if (entries.length === 0) return null;

    try {
      const template = await loadPrompt("consolidate-config.txt");

      const entriesList = entries
        .map(e => `- id: ${e.id} | title: ${e.title} | content: ${e.content}`)
        .join("\n");

      const prompt = template.replace("{{configEntries}}", escapePromptVariable(entriesList));

      const text = await this.generateText(prompt);

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]);

      const now = new Date();
      const jstOffset = 9 * 60 * 60 * 1000;
      const jst = new Date(now.getTime() + jstOffset);
      const timestamp = jst.toISOString().replace("Z", "+09:00");

      return {
        summaries: parsed.summaries,
        consolidatedAt: timestamp,
        sourceEntryCount: entries.length,
        version: 1,
      };
    } catch {
      return null;
    }
  }
}
