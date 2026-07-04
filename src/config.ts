import { config as dotenvConfig } from "dotenv";
import { dirname, resolve, join } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { validateWebhookUrl } from "./utils/validate-webhook-url.js";

// __dirnameベースで.envを探す（CWDに依存しない）
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// プロジェクトローカルの.envを優先、なければグローバルの~/.wasurenagusa/.envをフォールバック
dotenvConfig({ path: resolve(__dirname, "../.env") });
dotenvConfig({ path: join(homedir(), ".wasurenagusa", ".env") });

// Slack Webhook URLのバリデーション（起動時に実行）
function resolveSlackWebhookUrl(): string {
  const raw = process.env.SLACK_WEBHOOK_URL ?? "";
  const result = validateWebhookUrl(raw);
  if (result.valid) {
    return result.url;
  }
  console.error(`[config] Invalid SLACK_WEBHOOK_URL: ${result.reason}. Webhook disabled.`);
  return "";
}

export const config = {
  // LLMプロバイダ設定（gemini | openai | anthropic）
  llmProvider: (process.env.LLM_PROVIDER || "gemini") as "gemini" | "openai" | "anthropic",
  llmModel: process.env.LLM_MODEL || undefined,

  // 各プロバイダのAPIキー
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",

  // メモリディレクトリ（プロジェクトルートからの相対パス）
  memoryDir: process.env.MEMORY_DIR || ".wasurenagusa",

  // 検索デフォルト
  defaultSearchLimit: 5,

  // ログローテーション（デフォルト30日保持）
  logRetentionDays: parseInt(process.env.LOG_RETENTION_DAYS || "30", 10),

  // カテゴリ別エントリ上限（超過分は自動アーカイブ）
  maxEntriesPerCategory: parseInt(process.env.MAX_ENTRIES_PER_CATEGORY || "100", 10),

  // Slack Webhook通知（起動時にバリデーション済み）
  slackWebhookUrl: resolveSlackWebhookUrl(),

  // 統合ファイル名
  consolidatedDontFile: "consolidated-dont.json",
  consolidatedConfigFile: "consolidated-config.json",

  // カテゴリとファイルのマッピング
  // 注: dream / success は SQLiteStorage 専用カテゴリだが、型整合のため
  // ファイル名を宣言しておく（MarkdownStorage 側からは呼ばれない想定）。
  categoryFiles: {
    config: "config.md",
    dont: "dont.md",
    decision: "decisions.md",
    log: "logs",  // logsはディレクトリ
    snippet: "snippets.md",
    dream: "dreams.md",
    success: "successes.md",
  } as const,

  // ベクトル記憶層設定
  vectorStoreFile: "vectors.json",
  embeddingModel: "gemini-embedding-001",
  embeddingDimensions: 768,
  backfillBatchSize: 20,

  // Storage Engine v2 設定
  sqliteFile: "memory.db",
  // 多言語モデル（日本語の意味検索精度が英語専用モデルより大幅に高い。次元384は不変）
  localEmbeddingModel: "Xenova/multilingual-e5-small",
  localEmbeddingDimensions: 384,
  modelsDir: "models",
  stashDefaultTtlHours: 24,
};

export function getMemoryPath(projectRoot: string): string {
  return resolve(projectRoot, config.memoryDir);
}
