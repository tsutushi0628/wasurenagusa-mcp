// メモリのカテゴリ
// 注: heart-extension spec で dream / success を追加（CHECK制約は v2 マイグレーション）。
// 後続 chunk（M5/M6）で実装される予定。本chunk1ではスキーマだけ広げる。
export type MemoryCategory = "config" | "dont" | "decision" | "log" | "snippet" | "dream" | "success";

// スコープ候補（推奨値。実際のscopeフィールドはstring型で自由入力も可）
export type MemoryScope = "frontend" | "backend" | "infra" | "design" | "spec" | "ai" | "general";

// 重み付きタグ
export interface WeightedTag {
  tag: string;       // タグ文字列
  weight: number;    // 0.0〜1.0の重み
}


// メモリエントリ（フル）
export interface MemoryEntry {
  id: string;            // ユニークID（タイムスタンプベース）
  timestamp: string;
  category: MemoryCategory;
  content: string;
  tags: string[];
  title: string;         // 内容の要約（1行）
  project?: string;      // プロジェクト名（cwdのディレクトリ名）
  scope?: string;        // スコープ（frontend/backend/infra/design/spec/ai/general等）
  intensity?: number;    // 怒られ度（1〜10）。1=提案〜5=激怒。6以上=手動ピン留め
  knowledgeGap?: string[]; // dontカテゴリ時: この失敗を防ぐために覚えておくべき具体的知識
  positiveAction?: string; // dontカテゴリ時: 次に取るべき自律行動（肯定形）
}

// メモリエントリ（軽量インデックス - 動的取得用）
export interface MemoryIndexEntry {
  id: string;
  timestamp: string;
  category: MemoryCategory;
  title: string;         // 要約のみ。フル内容は含まない
  tags: string[];
  project?: string;      // プロジェクト名
  scope?: string;        // スコープ
  intensity?: number;    // 怒られ度（1〜10）
  positiveAction?: string; // dontカテゴリ時: 次に取るべき自律行動（肯定形）
}

// 保存パラメータ
export interface SaveParams {
  category: MemoryCategory;
  content: string;
  title: string;         // 必須: 1行の要約タイトル
  tags?: string[];
  project?: string;      // プロジェクト名（自動付与）
  scope?: string;        // スコープ（Gemini自動判定 or 手動指定）
  replaceId?: string;    // 指定時: 既存エントリを置換（重複排除用）
  intensity?: number;    // 怒られ度（1〜10、手動指定 or LLM自動判定）
  knowledgeGap?: string[]; // dontカテゴリ時: 失敗を防ぐために覚えておくべき具体的知識
  positiveAction?: string; // dontカテゴリ時: 次に取るべき自律行動（肯定形）
}

// 保存結果
export interface SaveResult {
  success: boolean;
  id: string;
  path: string;
  message: string;
  knowledgeGap?: string[];  // dontカテゴリ時: この失敗を防ぐために覚えておくべき具体的知識
  positiveAction?: string;  // dontカテゴリ時: 次に取るべき自律行動（肯定形）
}

// 検索パラメータ
export interface SearchParams {
  query: string;
  category?: MemoryCategory | "all";
  limit?: number;
  project?: string;      // プロジェクトフィルタ
  scope?: string;        // スコープフィルタ
}

// 検索結果（軽量インデックス）
export interface SearchResult {
  results: MemoryIndexEntry[];   // タイトル+タグのみ
  totalCount: number;
  hint: string;                  // 「memory_get_detail で詳細を取得できます」のガイド
  angerHistory?: MemoryIndexEntry[]; // 高強度dont（intensity≥4）一覧。クエリ無関係に毎回付与される再発防止リスト
}

// 詳細取得パラメータ
export interface GetDetailParams {
  ids: string[];                 // 取得したいエントリのID配列
}

// 詳細取得結果
export interface GetDetailResult {
  entries: MemoryEntry[];        // フル内容
  notFound: string[];            // 見つからなかったID
}

// コンテキスト取得結果
export interface ContextResult {
  config: string;
  dont: string;
}

// Gemini分析結果
export interface AnalysisResult {
  shouldSave: boolean;
  category: MemoryCategory | null;  // "config" | "dont" | "decision" | "log" | "snippet"
  title: string | null;
  summary: string | null;
  tags: string[];
  reason: string;
  scope?: string;        // Geminiが判定したスコープ
  replaceId?: string;    // 重複エントリのID（置換対象）
  intensity?: number;      // LLMが判定した怒られ度（1〜10）
  knowledgeGap?: string[]; // dontカテゴリ時: この失敗を防ぐために覚えておくべき具体的知識
  positiveAction?: string; // dontカテゴリ時: 次に取るべき自律行動（肯定形）
  sessionTopic?: string;   // セッションのトピック要約（shouldSaveに関係なく毎回出力）
}

// 削除パラメータ
export interface DeleteParams {
  ids: string[];                 // 削除したいエントリのID配列
}

// 削除結果
export interface DeleteResult {
  deleted: string[];             // 削除成功したID
  notFound: string[];            // 見つからなかったID
}

// 重複チェック入力
export interface DuplicateCheckInput {
  newTitle: string;
  newContent: string;
  existingEntries: Array<{ id: string; title: string; content: string }>;
}

// 会話メタ情報（諦め検知用）
export interface ConversationMeta {
  avgUserMessageLength: number;      // 直近5ターンのユーザー平均文字数
  currentMessageLength: number;       // 最新ユーザーメッセージの文字数
  turnsSinceLastPositive: number;     // 最後にポジティブな反応からの経過ターン数
}

// Gemini分析入力
export interface AnalysisInput {
  conversationLog: string;
  latestMessage: string;
  meta?: ConversationMeta;            // 会話メタ情報（諦め検知の補助データ）
}

// 統合された行動原則
export interface ConsolidatedPrinciple {
  theme: string;            // テーマ名（5-10文字）
  rule: string;             // ❌→💡→✅形式の統合ルール
  positiveRule: string;     // 肯定形に変換された行動原則（注入用）
  tags: string[];           // memory_search用タグ
  sourceCount: number;      // 元エントリ数
  sourceIds: string[];      // 元エントリID一覧
  score: number;            // sourceCount × maxIntensity
  maxIntensity: number;     // 統合元エントリの intensity 最大値
  guardPattern?: string;    // 検出パターン（正規表現文字列）
  guardMessage?: string;    // ガード違反時にClaudeに返すメッセージ
}

// dont統合結果
export interface ConsolidatedDont {
  principles: ConsolidatedPrinciple[];
  consolidatedAt: string;   // ISO 8601 JST
  sourceEntryCount: number; // 統合元dontエントリ総数
  version: number;          // フォーマットバージョン (1)
}

// 統合された設定サマリー
export interface ConfigSummary {
  theme: string;            // テーマ名（例: "ポート番号一覧"）
  summary: string;          // 圧縮された設定情報
  tags: string[];           // memory_search用タグ
  sourceCount: number;      // 元エントリ数
  sourceIds: string[];      // 元エントリID一覧
}

// config統合結果
export interface ConsolidatedConfig {
  summaries: ConfigSummary[];
  consolidatedAt: string;   // ISO 8601 JST
  sourceEntryCount: number; // 統合元configエントリ総数
  version: number;          // フォーマットバージョン (1)
}

// CLI分析用（Stop Hook用）
export interface AnalyzeParams {
  transcriptPath: string;
}

// CLI分析結果（Stop Hook用）
export interface AnalyzeResult {
  analyzed: boolean;
  saved: boolean;
  saveResult?: SaveResult;
  analysis: AnalysisResult;
}

// ============================
// Scheduler Types (Spec Auto-Update)
// ============================

// Specドキュメントパス
export interface SpecPaths {
  steering: string;
  specs: string[];
}

// 変更ログエントリ
export interface ChangeLogEntry {
  timestamp: string;          // ISO 8601 JST
  project: string;            // プロジェクト名（ディレクトリ名）
  projectPath: string;        // プロジェクト絶対パス
  changedFiles: string[];     // 変更ファイル名一覧（相対パス）
  specPaths: SpecPaths;
}

// タスクタイプ
export type TaskType = "change-based" | "rotation" | "ping" | "autonomous";

// タスクステータス
export type TaskStatus = "pending" | "in-progress" | "completed" | "failed";

// スケジューラタスク
export interface SchedulerTask {
  id: string;                 // UUID
  type: TaskType;
  priority: number;           // 1(高) - 3(低)
  project: string;
  projectPath: string;
  specPaths: SpecPaths;
  changedFiles?: string[];    // change-basedの場合のみ
  status: TaskStatus;
  createdAt: string;
  completedAt?: string;
  error?: string;
}

// プロジェクト設定
export interface ProjectConfig {
  name: string;
  path: string;
  specPaths: SpecPaths;
  lastUpdated?: string;       // 最終Spec更新日（ISO 8601）
}

// スケジューラ設定
export interface SchedulerConfig {
  projects: ProjectConfig[];
  cycleMinutes: number;       // デフォルト: 305（5h5m）
  taskTimeoutMs: number;      // デフォルト: 600000（10分）
  pingTimeoutMs: number;      // デフォルト: 30000（30秒）
  rotationThresholdDays: number; // デフォルト: 7
  idleThresholdMinutes: number; // ユーザーアイドル判定の閾値（分）。デフォルト: 150（2.5時間）
  maxConcurrentTasks: number; // タスク並列実行上限。デフォルト: 3
  activeHourStart?: number;   // 廃止（後方互換のためoptionalで残置）
  activeHourEnd?: number;     // 廃止（後方互換のためoptionalで残置）
  subProjectParents?: string[]; // サブプロジェクト持ち親ディレクトリ名（例: ["my-org", "my-org-v2"]）
}

// プロジェクトスキャン結果
export interface ProjectEntry {
  name: string;        // "my-project" or "my-org/sub-project"
  path: string;        // 絶対パス
  type: "standalone" | "subproject";
}

// Claude CLI実行オプション
export interface ClaudeCliOptions {
  maxTurns: number;           // デフォルト: 50
  allowedTools: string[];     // デフォルト: ["Edit","Write","Read","Glob","Grep"]
  timeoutMs: number;          // デフォルト: 600000（10分）
}

// CLI実行結果
export interface ExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

// 実行ログエントリ
export interface ExecutionLogEntry {
  timestamp: string;
  taskId: string;
  type: TaskType;
  project: string;
  exitCode: number;
  durationMs: number;
  summary?: string;
  error?: string;
}

// ============================
// Autonomous Task Types
// ============================

// 自律タスクのステータス
export type AutonomousTaskStatus =
  | "pending"
  | "in-progress"
  | "completed"
  | "failed"
  | "human-required"
  | "cancelled";

// 自律タスク
export interface AutonomousTask {
  id: string;
  why: string;
  what: string;
  done: string;
  project: string;
  projectPath: string;
  status: AutonomousTaskStatus;
  priority: number;
  retryCount: number;
  createdAt: string;
  completedAt?: string;
  generatedCommand?: string;
  evaluationHistory: EvaluationEntry[];
  humanRequiredReason?: string;
  timeoutMs?: number;
  maxTurns?: number;
  allowedTools?: string[];
}

// 評価履歴エントリ
export interface EvaluationEntry {
  timestamp: string;
  result: "ok" | "ng" | "human-required";
  reason: string;
  suggestion?: string;
  executionDurationMs: number;
}

// 評価者の判定結果
export interface EvaluatorResult {
  verdict: "ok" | "ng" | "human-required";
  reason: string;
  suggestion?: string;
}

// プロジェクトメタ情報
export interface ProjectMeta {
  project: string;
  projectPath: string;
  phase: "startup" | "growth" | "stable";
  qualityPolicy: "speed_first" | "balanced" | "quality_first";
  testExpectation: "minimal" | "standard" | "thorough";
  codeQuality: "pragmatic" | "balanced" | "strict";
  debtTolerance: "accept" | "moderate" | "zero_tolerance";
  aiAutonomy: "narrow" | "moderate" | "wide";
  escalationTriggers: string[];
  targetAudience: string;
  successMetric: string;
  createdAt: string;
  updatedAt: string;
}

// 人間アクションアイテム
export interface HumanActionItem {
  taskId: string;
  project: string;
  what: string;
  reason: string;
  suggestion?: string;
  createdAt: string;
  source: "evaluation" | "retry-limit";
}

// タスク投入パラメータ
export interface TaskSubmitParams {
  why: string;
  what: string;
  done: string;
  project: string;
}

// タスクステータスレスポンス
export interface TaskStatusResponse {
  summary: {
    pending: number;
    inProgress: number;
    completed: number;
    failed: number;
    humanRequired: number;
    cancelled: number;
  };
  recentTasks: Array<{
    id: string;
    what: string;
    project: string;
    status: AutonomousTaskStatus;
    createdAt: string;
  }>;
}

// 命令文生成入力
export interface CommandGenerationInput {
  task: AutonomousTask;
  projectMeta: ProjectMeta;
  ownerProfile?: string;
}

// 評価入力
export interface EvaluationInput {
  task: AutonomousTask;
  projectMeta: ProjectMeta;
  ownerProfile?: string;
  executionOutput: string;
  executionExitCode: number;
  executionDurationMs: number;
}

// プロジェクト初期化の質問
export interface ProjectInitQuestion {
  key: string;
  question: string;
  options: string[];
}

// プロジェクト初期化出力
export interface ProjectInitOutput {
  questions: ProjectInitQuestion[];
}

// アクティブプロジェクト（最近作業したプロジェクト）
export interface ActiveProject {
  name: string;              // プロジェクト名（ディレクトリ名）
  path: string;              // プロジェクト絶対パス
  lastSessionAt: string;     // 最終セッション終了時刻（ISO 8601 JST）
  sessionTopic: string;      // 直前セッションのトピック要約
}

// アクティブプロジェクトデータ
export interface ActiveProjectsData {
  projects: ActiveProject[];
  maxActiveProjects: number; // デフォルト: 5
  updatedAt: string;         // 最終更新時刻（ISO 8601 JST）
}


// ============================
// Storage Engine v2 Types
// ============================

// Stash（短期退避）保存パラメータ
export interface StashParams {
  content: string;           // 退避するファイル全文
  filePath?: string;         // 元ファイルパス（オプション）
  fileType?: string;         // ファイル拡張子（オプション）
  sessionId?: string;        // セッションID（オプション）
  ttlHours?: number;         // TTL時間（デフォルト24）
}

// Stash保存結果
export interface StashResult {
  id: string;
  summary: string;           // ルールベース要約
  expiresAt: string;         // 有効期限（ISO 8601）
}

// Stash復元結果
export interface RestoreResult {
  found: boolean;
  content?: string;          // フル内容（found=true時）
  expired?: boolean;         // TTL超過で見つからなかった場合true
  message: string;
}

// StashEntry（DB行に対応）
export interface StashEntry {
  id: string;
  content: string;
  summary: string;
  filePath?: string;
  fileType?: string;
  lineCount?: number;
  sessionId?: string;
  createdAt: string;
  expiresAt: string;
}
