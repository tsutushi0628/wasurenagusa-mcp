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
  // Gemini API設定
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  geminiModel: "gemini-3-flash-preview",

  // メモリディレクトリ（プロジェクトルートからの相対パス）
  memoryDir: process.env.MEMORY_DIR || ".wasurenagusa",

  // 検索デフォルト
  defaultSearchLimit: 20,

  // ログローテーション（デフォルト30日保持）
  logRetentionDays: parseInt(process.env.LOG_RETENTION_DAYS || "30", 10),

  // Slack Webhook通知（起動時にバリデーション済み）
  slackWebhookUrl: resolveSlackWebhookUrl(),

  // dont統合ファイル名
  consolidatedDontFile: "consolidated-dont.json",

  // カテゴリとファイルのマッピング
  categoryFiles: {
    config: "config.md",
    dont: "dont.md",
    decision: "decisions.md",
    log: "logs",  // logsはディレクトリ
    snippet: "snippets.md"
  } as const
};

export function getMemoryPath(projectRoot: string): string {
  return resolve(projectRoot, config.memoryDir);
}
