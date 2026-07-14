import { config as dotenvConfig } from "dotenv";
import { dirname, resolve, join } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { validateWebhookUrl } from "./utils/validate-webhook-url.js";
import { DEFAULT_NIGHTLY_CAP } from "./consolidator/batch-cap.js";

// __dirnameベースで.envを探す（CWDに依存しない）
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// プロジェクトローカルの.envを優先、なければグローバルの~/.wasurenagusa/.envをフォールバック
dotenvConfig({ path: resolve(__dirname, "../.env") });
dotenvConfig({ path: join(homedir(), ".wasurenagusa", ".env") });

/**
 * env から「窓の日数」を読む（Number.isFinite ガード付き）。
 *
 * 非数（parseInt が NaN になる値）だけを誤設定として既定値へフォールバックし warn を1行出す。
 * 非数のまま下流に流れると事故になるため、設定境界で吸収する:
 *  - forgettingWindowDays が NaN だと忘却 dry-run の SQL 修飾子 '-NaN days' が不正になり
 *    候補が常に0件＝「忘却が沈黙停止」する（欠陥に気づけない）。
 *  - logRetentionDays が NaN だと Date 演算が Invalid Date になりログ回転が throw する。
 * 0 以下は「無効化」を意味する既存仕様（forgetting-sweep の windowDays<=0=忘却無効・
 * markdown の retentionDays<=0=ログ回転無効）なので、既定へ置換せずそのまま下流へ通す。
 * 配布パッケージで環境変数の意味を黙って変えないため（0以下は warn もしない）。
 * 未設定（undefined / 空文字）は正常系なので warn せず既定値を返す。
 *
 * 注: maxEntriesPerCategory は「窓日数」ではなく件数上限で、cap-sweep が <=0 を
 * 「上限無効（退避しない）」として第一級にサポートするため、この関数の対象外とする。
 */
export function resolveWindowDaysEnv(
  raw: string | undefined,
  defaultValue: number,
  envName: string,
): number {
  if (raw === undefined || raw.trim() === "") {
    return defaultValue;
  }
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    console.warn(
      `[config] ${envName} が非数です（${JSON.stringify(raw)}）。既定値 ${defaultValue} 日を使用します。`,
    );
    return defaultValue;
  }
  // 0 以下は下流の「<=0=無効化」既存仕様を保存するためそのまま通す（既定に置換しない）。
  return parsed;
}

/**
 * 真偽値の環境変数を解決する。未設定（undefined / 空文字）は defaultValue を返す。
 * 明示無効の語（false / 0 / off / no、大小文字無視）だけを false とし、それ以外の設定値は true とみなす
 * （「何か設定したら有効」に倒す既定安全側。実退避のような破壊的既定 ON を明示語でのみ落とすため）。
 */
export function resolveBoolEnv(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined || raw.trim() === "") {
    return defaultValue;
  }
  return !/^(false|0|off|no)$/i.test(raw.trim());
}

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
  logRetentionDays: resolveWindowDaysEnv(process.env.LOG_RETENTION_DAYS, 30, "LOG_RETENTION_DAYS"),

  // カテゴリ別エントリ上限（超過分は自動アーカイブ）
  maxEntriesPerCategory: parseInt(process.env.MAX_ENTRIES_PER_CATEGORY || "100", 10),

  // 忘却（長期未参照）判定の窓（日数）。参照時刻 COALESCE(last_read_at, updated_at) が
  // この日数より古い active 行を忘却 dry-run の候補にする（実退避はまだ行わない・読み取り専用）。
  // cap 閾値と同性質のプロダクト判断点。既定 90 日は暫定で、環境変数 FORGETTING_WINDOW_DAYS で上書き可。
  // 非数（NaN すり抜け）は既定へフォールバックし忘却の沈黙停止を防ぐ。0以下は下流で「忘却無効」
  // として弾く既存仕様を保存する（resolveWindowDaysEnv 参照）。
  forgettingWindowDays: resolveWindowDaysEnv(process.env.FORGETTING_WINDOW_DAYS, 90, "FORGETTING_WINDOW_DAYS"),

  // 忘却の実退避（archive）を実発動するか。true のとき夜間オーケストレータ（consolidate-all の main）が
  // 忘却窓より古い長期未参照の active 行を state='archived' へ論理退避する（物理削除はしない・可逆）。
  // 既定 true（オーナー裁定 2026-07-14「90日しきい値で実発動」）。FORGETTING_APPLY=false/0/off/no で無効化し
  // 測定（dry-run レポート）のみに戻せる。夜間の測定関数 consolidateProject 自体は常に write-zero を保つ設計で、
  // 退避はこのフラグで制御される apply 経路（applyForgettingForProject）に分離してある。
  forgettingApply: resolveBoolEnv(process.env.FORGETTING_APPLY, true),

  // 忘却の実退避における1晩あたりの退避上限（batch-cap）。夜間バッチが1回で退避できる件数の天井で、
  // 超過分は今晩は退避せず翌晩へ持ち越す。初回夜間バッチが全プロジェクトの長期未参照記憶を無制限に
  // 一括退避する暴走を防ぐ（rank3）。既定は batch-cap の DEFAULT_NIGHTLY_CAP。環境変数
  // FORGETTING_NIGHTLY_CAP で上書き可。0以下は「今晩は退避しない」を意味する（capClusters の約束）ため
  // 既定へ置換せずそのまま通す（resolveWindowDaysEnv と同性質の閾値）。
  forgettingNightlyCap: resolveWindowDaysEnv(
    process.env.FORGETTING_NIGHTLY_CAP,
    DEFAULT_NIGHTLY_CAP,
    "FORGETTING_NIGHTLY_CAP",
  ),

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
