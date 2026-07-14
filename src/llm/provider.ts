import { genkit, type Genkit } from "genkit";
import { googleAI } from "@genkit-ai/google-genai";
import { openAI } from "@genkit-ai/compat-oai/openai";
import { anthropic } from "@genkit-ai/anthropic";
import { config } from "../config.js";

export type LLMProvider = "gemini" | "openai" | "anthropic";

export type GenerateTextFn = (prompt: string) => Promise<string>;

/** RETRIEVAL_QUERY=検索クエリ側、RETRIEVAL_DOCUMENT=保存対象の文書側（Gemini embedding APIのtaskType） */
export type EmbedTaskType = "RETRIEVAL_QUERY" | "RETRIEVAL_DOCUMENT";

export type EmbedTextFn = (text: string, taskType: EmbedTaskType) => Promise<number[]>;

/** 遠隔埋め込みモデル名の単一真実源（旧 src/vector/embedding-service.ts の EMBEDDING_MODEL を統合） */
export const DEFAULT_EMBEDDING_MODEL = "gemini-embedding-001";

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

/**
 * 遠隔埋め込み（Gemini embedding API）呼び出しをGenkit経由で提供する。
 * 埋め込みはGeminiのみ提供（LLM本文のプロバイダ選択とは独立。geminiApiKey未設定時は
 * getGenkitInstance()がgoogleAIプラグインを登録しないため呼び出し時にthrowする）。
 */
export function createEmbedTextFn(): EmbedTextFn {
  const ai = getGenkitInstance();
  const embedder = googleAI.embedder(DEFAULT_EMBEDDING_MODEL);

  return async (text: string, taskType: EmbedTaskType): Promise<number[]> => {
    const [result] = await ai.embed({
      embedder,
      content: text,
      options: { taskType },
    });
    return result.embedding;
  };
}

/** テスト用: キャッシュをリセット */
export function resetLLMCache(): void {
  cachedAi = null;
}
