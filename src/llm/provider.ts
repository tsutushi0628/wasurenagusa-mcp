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
  anthropic: "claude-haiku-5-5",
};

// 各社の REST API を fetch で直接呼ぶ（2026-10 に Genkit から置き換え）。
// Genkit は OpenTelemetry 1.25 系に固定しており、直った版のない脆弱性が残るため。
// 送る中身は Genkit 経由のときと同じにしている（Gemini は v1beta、Anthropic の max_tokens は Genkit の既定値 4096）。
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_API_VERSION = "2023-06-01";
const ANTHROPIC_MAX_OUTPUT_TOKENS = 4096;

type FetchFn = typeof fetch;

let fetchImpl: FetchFn = (...args) => fetch(...args);

function requireAnyApiKey(): void {
  if (!config.geminiApiKey && !config.openaiApiKey && !config.anthropicApiKey) {
    throw new Error(
      "No LLM API key configured. Set one of: GEMINI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY"
    );
  }
}

function requireKey(key: string | undefined, envName: string): string {
  if (!key) {
    throw new Error(`${envName} is not set`);
  }
  return key;
}

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`LLM API request failed: ${response.status} ${response.statusText} ${detail.slice(0, 500)}`);
  }
  return response.json();
}

interface GeminiGenerateResponse {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
}

async function generateWithGemini(model: string, prompt: string): Promise<string> {
  const apiKey = requireKey(config.geminiApiKey, "GEMINI_API_KEY");
  const json = (await postJson(
    `${GEMINI_BASE_URL}/models/${encodeURIComponent(model)}:generateContent`,
    { "x-goog-api-key": apiKey },
    { contents: [{ role: "user", parts: [{ text: prompt }] }] }
  )) as GeminiGenerateResponse;
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((part) => !part.thought)
    .map((part) => part.text ?? "")
    .join("");
}

interface OpenAIChatResponse {
  choices?: { message?: { content?: string | null } }[];
}

async function generateWithOpenAI(model: string, prompt: string): Promise<string> {
  const apiKey = requireKey(config.openaiApiKey, "OPENAI_API_KEY");
  const json = (await postJson(
    OPENAI_CHAT_URL,
    { Authorization: `Bearer ${apiKey}` },
    { model, messages: [{ role: "user", content: prompt }] }
  )) as OpenAIChatResponse;
  return json.choices?.[0]?.message?.content ?? "";
}

interface AnthropicMessagesResponse {
  content?: { type: string; text?: string }[];
}

async function generateWithAnthropic(model: string, prompt: string): Promise<string> {
  const apiKey = requireKey(config.anthropicApiKey, "ANTHROPIC_API_KEY");
  const json = (await postJson(
    ANTHROPIC_MESSAGES_URL,
    { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_API_VERSION },
    {
      model,
      max_tokens: ANTHROPIC_MAX_OUTPUT_TOKENS,
      messages: [{ role: "user", content: prompt }],
    }
  )) as AnthropicMessagesResponse;
  return (json.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

export function createGenerateTextFn(): GenerateTextFn {
  requireAnyApiKey();
  const provider = config.llmProvider;
  const modelName = config.llmModel;

  if (provider === "openai") {
    const model = modelName ?? DEFAULT_MODELS.openai;
    return (prompt: string) => generateWithOpenAI(model, prompt);
  }
  if (provider === "anthropic") {
    const model = modelName ?? DEFAULT_MODELS.anthropic;
    return (prompt: string) => generateWithAnthropic(model, prompt);
  }
  const model = modelName ?? DEFAULT_MODELS.gemini;
  return (prompt: string) => generateWithGemini(model, prompt);
}

interface GeminiEmbedResponse {
  embedding?: { values?: number[] };
}

/**
 * 遠隔埋め込み（Gemini embedding API）呼び出しを提供する。
 * 埋め込みはGeminiのみ提供（LLM本文のプロバイダ選択とは独立。geminiApiKey未設定時は
 * 呼び出し時にthrowする）。
 */
export function createEmbedTextFn(): EmbedTextFn {
  requireAnyApiKey();

  return async (text: string, taskType: EmbedTaskType): Promise<number[]> => {
    const apiKey = requireKey(config.geminiApiKey, "GEMINI_API_KEY");
    const json = (await postJson(
      `${GEMINI_BASE_URL}/models/${DEFAULT_EMBEDDING_MODEL}:embedContent`,
      { "x-goog-api-key": apiKey },
      { taskType, content: { role: "user", parts: [{ text }] } }
    )) as GeminiEmbedResponse;
    const values = json.embedding?.values;
    if (!Array.isArray(values)) {
      throw new Error("Gemini embedding API returned no embedding values");
    }
    return values;
  };
}

/** テスト用: キャッシュをリセット（直接呼び出しになりキャッシュは持たないが、呼び出し側との互換のため残す） */
export function resetLLMCache(): void {
  fetchImpl = (...args) => fetch(...args);
}

/** テスト用: fetch を差し替える */
export function setFetchForTesting(fn: FetchFn): void {
  fetchImpl = fn;
}
