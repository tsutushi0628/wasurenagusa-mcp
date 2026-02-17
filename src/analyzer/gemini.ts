import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "../config.js";
import { AnalysisResult, AnalysisInput, DuplicateCheckInput } from "../types.js";
import { loadPrompt } from "./prompt-loader.js";

export class GeminiAnalyzer {
  private genAI: GoogleGenerativeAI;
  private model: any;

  constructor() {
    if (!config.geminiApiKey) {
      throw new Error("GEMINI_API_KEY is not set");
    }
    this.genAI = new GoogleGenerativeAI(config.geminiApiKey);
    this.model = this.genAI.getGenerativeModel({ model: config.geminiModel });
  }

  async analyze(input: AnalysisInput): Promise<AnalysisResult> {
    try {
      const analysisPrompt = await loadPrompt("analysis.txt");

      let metaSection = "";
      if (input.meta) {
        metaSection = `
## 会話メタ情報
- avgUserMessageLength（直近5ターン平均文字数）: ${input.meta.avgUserMessageLength}
- currentMessageLength（最新メッセージ文字数）: ${input.meta.currentMessageLength}
- turnsSinceLastPositive（最後のポジティブ反応からの経過ターン数）: ${input.meta.turnsSinceLastPositive}
`;
      }

      const prompt = `${analysisPrompt}

---
${metaSection}
## 会話ログ
${input.conversationLog}

## 最新メッセージ
${input.latestMessage}

---

上記を分析し、JSON形式で出力してください：`;

      const result = await this.model.generateContent(prompt);
      const response = result.response;
      const text = response.text();

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return this.defaultResult("Failed to parse JSON response");
      }

      const parsed = JSON.parse(jsonMatch[0]) as AnalysisResult;
      return parsed;

    } catch (error) {
      console.error("Gemini analysis error:", error);
      return this.defaultResult(`Analysis error: ${error}`);
    }
  }

  async checkDuplicate(input: DuplicateCheckInput): Promise<string | null> {
    if (input.existingEntries.length === 0) { return null; }

    try {
      const template = await loadPrompt("duplicate-check.txt");

      const entriesList = input.existingEntries
        .map(e => `- id: ${e.id} | title: ${e.title} | content: ${e.content}`)
        .join("\n");

      const prompt = template
        .replace("{{newTitle}}", input.newTitle)
        .replace("{{newContent}}", input.newContent)
        .replace("{{existingEntries}}", entriesList);

      const result = await this.model.generateContent(prompt);
      const text = result.response.text();

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) { return null; }

      const parsed = JSON.parse(jsonMatch[0]);
      return parsed.replaceId || null;

    } catch {
      return null;
    }
  }

  private defaultResult(reason: string): AnalysisResult {
    return {
      shouldSave: false,
      category: null,
      title: null,
      summary: null,
      tags: [],
      reason
    };
  }
}
