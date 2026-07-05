import { genkit, type Genkit } from "genkit";
import { googleAI } from "@genkit-ai/google-genai";
import { openAI } from "@genkit-ai/compat-oai/openai";
import { anthropic } from "@genkit-ai/anthropic";
import { config } from "../config.js";

export type LLMProvider = "gemini" | "openai" | "anthropic";

export type GenerateTextFn = (prompt: string) => Promise<string>;

export const DEFAULT_MODELS: Record<LLMProvider, string> = {
  gemini: "gemini-3.1-flash-lite",
  openai: "gpt-5-nano",
  anthropic: "claude-haiku-4-5-20251001",
};

let cachedAi: Genkit | null = null;

function getGenkitInstance(): Genkit {
  if (cachedAi) {
    return cachedAi;
  }

  const plugins = [];

  if (config.geminiApiKey) {
    plugins.push(googleAI({ apiKey: config.geminiApiKey }));
  }
  if (config.openaiApiKey) {
    plugins.push(openAI({ apiKey: config.openaiApiKey }));
  }
  if (config.anthropicApiKey) {
    plugins.push(anthropic({ apiKey: config.anthropicApiKey }));
  }

  if (plugins.length === 0) {
    throw new Error(
      "No LLM API key configured. Set one of: GEMINI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY"
    );
  }

  cachedAi = genkit({ plugins });
  return cachedAi;
}

function resolveModel(ai: Genkit): ReturnType<typeof googleAI.model> {
  const provider = config.llmProvider;
  const modelName = config.llmModel;

  if (provider === "openai") {
    return openAI.model(modelName ?? DEFAULT_MODELS.openai);
  }
  if (provider === "anthropic") {
    return anthropic.model(modelName ?? DEFAULT_MODELS.anthropic);
  }
  return googleAI.model(modelName ?? DEFAULT_MODELS.gemini);
}

export function createGenerateTextFn(): GenerateTextFn {
  const ai = getGenkitInstance();
  const model = resolveModel(ai);

  return async (prompt: string): Promise<string> => {
    const response = await ai.generate({ model, prompt });
    return response.text;
  };
}

/** テスト用: キャッシュをリセット */
export function resetLLMCache(): void {
  cachedAi = null;
}
