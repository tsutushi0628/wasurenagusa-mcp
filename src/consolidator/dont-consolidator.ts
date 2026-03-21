import { ConsolidatedDont, MemoryEntry } from "../types.js";
import { loadPrompt } from "../analyzer/prompt-loader.js";
import { escapePromptVariable } from "../utils/prompt-escape.js";
import { GenerateTextFn, createGenerateTextFn } from "../llm/provider.js";
import { formatConsolidatedDont } from "./formatter.js";

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
        .map(e => `- id: ${e.id} | title: ${e.title} | intensity: ${e.intensity ?? 2} | content: ${e.content}`)
        .join("\n");

      const prompt = template.replace("{{dontEntries}}", escapePromptVariable(entriesList));

      const text = await this.generateText(prompt);

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]);

      // エントリをIDでルックアップできるMapを構築
      const entryMap = new Map<string, MemoryEntry>();
      for (const entry of entries) {
        entryMap.set(entry.id, entry);
      }

      // 各principleにscore, maxIntensityを算出
      for (const principle of parsed.principles) {
        const sourceIds: string[] = principle.sourceIds;
        let maxIntensity = 2;
        for (const sourceId of sourceIds) {
          const sourceEntry = entryMap.get(sourceId);
          if (!sourceEntry) {
            continue;
          }
          const entryIntensity = sourceEntry.intensity ?? 2;
          if (entryIntensity > maxIntensity) {
            maxIntensity = entryIntensity;
          }
        }
        principle.maxIntensity = maxIntensity;
        principle.score = principle.sourceCount * maxIntensity;
      }

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

  async generateSummary(consolidated: ConsolidatedDont): Promise<string> {
    const formatted = formatConsolidatedDont(consolidated);

    const prompt = `以下の行動原則を500字程度の日本語で要約してください。オーナーが何を重視し、何を禁止しているかが一読でわかるように。

${escapePromptVariable(formatted)}`;

    const text = await this.generateText(prompt);
    return text.trim();
  }
}
