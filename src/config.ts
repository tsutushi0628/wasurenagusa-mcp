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
  // 遠隔埋め込みモデル名の単一真実源は src/vector/embedding-service.ts の EMBEDDING_MODEL
  // （旧 embeddingModel 設定はどこからも参照されない死設定だったため除去済み）
  embeddingDimensions: 768,
  backfillBatchSize: 20,

  // Storage Engine v2 設定
  sqliteFile: "memory.db",
  // 埋め込みモデル名の単一真実源は src/vector/local-embedding.ts の DEFAULT_MODEL
  // （旧 localEmbeddingModel 設定はどこからも参照されない死設定だったため除去済み）
  localEmbeddingDimensions: 384,
  modelsDir: "models",
  stashDefaultTtlHours: 24,
};

export function getMemoryPath(projectRoot: string): string {
  return resolve(projectRoot, config.memoryDir);
}

/**
 * 埋め込みモデルのキャッシュ先を解決する（タスク1.13、R-B8）。
 *
 * 環境変数 WASURENAGUSA_MODEL_CACHE_DIR が設定されていれば、複数ストア（プロジェクト）間で
 * 共有する1箇所のディレクトリを返す（7ストアぶんの重複ダウンロード=522MB相当を1箇所へ集約）。
 * 未設定（または空文字）のときは従来どおりプロジェクトごとの memoryPath 配下
 * （config.modelsDir）を返し、既存の動作を変えない。
 */
export function getModelsDir(memoryPath: string): string {
  const sharedDir = process.env.WASURENAGUSA_MODEL_CACHE_DIR;
  if (sharedDir && sharedDir.length > 0) {
    return sharedDir;
  }
  return join(memoryPath, config.modelsDir);
}
