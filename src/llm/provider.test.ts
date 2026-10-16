import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    llmProvider: "gemini" as "gemini" | "openai" | "anthropic",
    llmModel: undefined as string | undefined,
    geminiApiKey: "",
    openaiApiKey: "",
    anthropicApiKey: "",
  },
}));

vi.mock("../config.js", () => ({ config: mockConfig }));

import {
  createEmbedTextFn,
  createGenerateTextFn,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_MODELS,
  resetLLMCache,
  setFetchForTesting,
} from "./provider.js";

type Captured = { url: string; init: RequestInit };

function fakeFetch(body: unknown, status = 200): { calls: Captured[]; fn: typeof fetch } {
  const calls: Captured[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { calls, fn };
}

function headersOf(call: Captured): Record<string, string> {
  return call.init.headers as Record<string, string>;
}

describe("llm/provider（各社 REST API の直接呼び出し）", () => {
  beforeEach(() => {
    mockConfig.llmProvider = "gemini";
    mockConfig.llmModel = undefined;
    mockConfig.geminiApiKey = "";
    mockConfig.openaiApiKey = "";
    mockConfig.anthropicApiKey = "";
  });

  afterEach(() => {
    resetLLMCache();
  });

  it("API キーが一つもなければ従来どおりの文言で throw する", () => {
    expect(() => createGenerateTextFn()).toThrow(
      "No LLM API key configured. Set one of: GEMINI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY"
    );
    expect(() => createEmbedTextFn()).toThrow("No LLM API key configured");
  });

  it("Gemini: v1beta の generateContent に x-goog-api-key で送り、思考以外の text を連結して返す", async () => {
    mockConfig.geminiApiKey = "g-key";
    const { calls, fn } = fakeFetch({
      candidates: [{ content: { parts: [{ text: "考え中", thought: true }, { text: "こん" }, { text: "にちは" }] } }],
    });
    setFetchForTesting(fn);

    const text = await createGenerateTextFn()("やあ");

    expect(text).toBe("こんにちは");
    expect(calls[0].url).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_MODELS.gemini}:generateContent`
    );
    expect(headersOf(calls[0])["x-goog-api-key"]).toBe("g-key");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      contents: [{ role: "user", parts: [{ text: "やあ" }] }],
    });
  });

  it("OpenAI: chat/completions に Bearer で送り、最初の choice の本文を返す", async () => {
    mockConfig.llmProvider = "openai";
    mockConfig.llmModel = "gpt-test";
    mockConfig.openaiApiKey = "o-key";
    const { calls, fn } = fakeFetch({ choices: [{ message: { content: "ok" } }] });
    setFetchForTesting(fn);

    const text = await createGenerateTextFn()("hi");

    expect(text).toBe("ok");
    expect(calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(headersOf(calls[0]).Authorization).toBe("Bearer o-key");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      model: "gpt-test",
      messages: [{ role: "user", content: "hi" }],
    });
  });

  it("Anthropic: messages に x-api-key と版ヘッダで送り、max_tokens は 4096、text ブロックを連結して返す", async () => {
    mockConfig.llmProvider = "anthropic";
    mockConfig.anthropicApiKey = "a-key";
    const { calls, fn } = fakeFetch({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] });
    setFetchForTesting(fn);

    const text = await createGenerateTextFn()("hi");

    expect(text).toBe("ab");
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(headersOf(calls[0])["x-api-key"]).toBe("a-key");
    expect(headersOf(calls[0])["anthropic-version"]).toBe("2023-06-01");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      model: DEFAULT_MODELS.anthropic,
      max_tokens: 4096,
      messages: [{ role: "user", content: "hi" }],
    });
  });

  it("失敗応答は状態コードつきで throw する", async () => {
    mockConfig.geminiApiKey = "g-key";
    setFetchForTesting(fakeFetch({ error: "bad" }, 500).fn);

    await expect(createGenerateTextFn()("x")).rejects.toThrow("LLM API request failed: 500");
  });

  it("埋め込み: gemini-embedding-001 の embedContent に taskType つきで送り、values を返す", async () => {
    mockConfig.geminiApiKey = "g-key";
    const { calls, fn } = fakeFetch({ embedding: { values: [0.1, 0.2] } });
    setFetchForTesting(fn);

    const values = await createEmbedTextFn()("本文", "RETRIEVAL_DOCUMENT");

    expect(values).toEqual([0.1, 0.2]);
    expect(calls[0].url).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_EMBEDDING_MODEL}:embedContent`
    );
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      taskType: "RETRIEVAL_DOCUMENT",
      content: { role: "user", parts: [{ text: "本文" }] },
    });
  });

  it("埋め込み: Gemini のキーがなく他社のキーだけなら呼び出し時に throw する", async () => {
    mockConfig.openaiApiKey = "o-key";
    const embed = createEmbedTextFn();
    await expect(embed("x", "RETRIEVAL_QUERY")).rejects.toThrow("GEMINI_API_KEY is not set");
  });
});
