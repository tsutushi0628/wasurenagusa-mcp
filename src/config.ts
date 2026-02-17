import { config as dotenvConfig } from "dotenv";
import { dirname, resolve, join } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

// __dirnameベースで.envを探す（CWDに依存しない）
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// プロジェクトローカルの.envを優先、なければグローバルの~/.wasurenagusa/.envをフォールバック
dotenvConfig({ path: resolve(__dirname, "../.env") });
dotenvConfig({ path: join(homedir(), ".wasurenagusa", ".env") });

export const config = {
  // Gemini API設定
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  geminiModel: "gemini-3-flash-preview",

  // メモリディレクトリ（プロジェクトルートからの相対パス）
  memoryDir: process.env.MEMORY_DIR || ".wasurenagusa",

  // 検索デフォルト
  defaultSearchLimit: 20,

  // Slack Webhook通知
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL ?? "",

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
