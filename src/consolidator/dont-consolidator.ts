import { ConsolidatedDont, ConsolidatedPrinciple, MemoryEntry } from "../types.js";
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

  // クラスタ（embedding 類似度で同一テーマと判定された entries）を 1 つの principle に統合する。
  // 抽象化を禁止し、具体的事例を保持する重複排除に特化。
  async mergeCluster(entries: MemoryEntry[]): Promise<ConsolidatedPrinciple | null> {
    if (entries.length < 2) return null;
    try {
      const template = await loadPrompt("consolidate-cluster.txt");
      const entriesList = entries
        .map(e => `- id: ${e.id} | title: ${e.title} | intensity: ${e.intensity ?? 2} | content: ${e.content}`)
        .join("\n");
      const prompt = template.replace("{{clusterEntries}}", escapePromptVariable(entriesList));
      const text = await this.generateText(prompt);
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;
      const parsed = JSON.parse(jsonMatch[0]);
      if (!parsed.principle) return null;

      const principle = parsed.principle as ConsolidatedPrinciple;
      // maxIntensity を入力から再計算（LLM 出力の信頼度が低いので念のため）
      let maxIntensity = 2;
      for (const e of entries) {
        const i = e.intensity ?? 2;
        if (i > maxIntensity) maxIntensity = i;
      }
      principle.maxIntensity = maxIntensity;
      principle.score = (principle.sourceIds?.length ?? 0) * maxIntensity;
      // guardPattern/guardMessageは自動生成禁止（ガードは承認制のみ）。
      // LLM出力に含まれていても常に除去し、自動生成パターンを一切採用しない。
      delete principle.guardPattern;
      delete principle.guardMessage;
      return principle;
    } catch {
      return null;
    }
  }

  async consolidate(entries: MemoryEntry[]): Promise<ConsolidatedDont | null> {
    if (entries.length === 0) return null;

    // intensity 降順でソート（高強度ほど先に処理 → 同テーマの上位同士が同じ chunk に集まり、
    // 「同じこと言ってたら統合」が機能する）
    const sortedEntries = [...entries].sort((a, b) => (b.intensity ?? 2) - (a.intensity ?? 2));

    // 入力が大きいと LLM が網羅できず source ID の取りこぼしが発生する。
    // 1 chunk あたり最大 50 件で分割し、各 chunk を独立に集約して principles をマージする。
    const CHUNK_SIZE = 50;
    if (sortedEntries.length > CHUNK_SIZE) {
      const chunks: MemoryEntry[][] = [];
      for (let i = 0; i < sortedEntries.length; i += CHUNK_SIZE) {
        chunks.push(sortedEntries.slice(i, i + CHUNK_SIZE));
      }
      const chunkResults = await Promise.all(chunks.map(c => this.consolidateChunk(c)));
      const allPrinciples = chunkResults.flatMap(r => r?.principles ?? []);
      if (allPrinciples.length === 0) return null;
      const now = new Date();
      const jstOffset = 9 * 60 * 60 * 1000;
      const jst = new Date(now.getTime() + jstOffset);
      const timestamp = jst.toISOString().replace("Z", "+09:00");
      return {
        principles: allPrinciples,
        consolidatedAt: timestamp,
        sourceEntryCount: entries.length,
        version: 1,
      };
    }

    return this.consolidateChunk(sortedEntries);
  }

  private async consolidateChunk(entries: MemoryEntry[]): Promise<ConsolidatedDont | null> {
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

        // guardPattern/guardMessageは自動生成禁止（ガードは承認制のみ）。
        // LLM出力に含まれていても常に除去し、自動生成パターンを一切採用しない。
        delete principle.guardPattern;
        delete principle.guardMessage;
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

    const prompt = `以下の行動原則を500字程度の日本語で要約してください。オーナーが何を重視し、どう行動すべきかが一読でわかるように。

${escapePromptVariable(formatted)}`;

    const text = await this.generateText(prompt);
    return text.trim();
  }
}
