# Design Document: Autonomous Task Execution System

## Overview

wasurenagusa-mcpに自律型AIタスク実行システムを追加する。人間が投入したWHY/WHAT/DONE/PROJECTの4項目から、Geminiで命令文を生成し、Claude Code CLIで実行し、Geminiで評価するパイプラインを構築する。

既存の`src/scheduler/`は改修せず、新規`src/autonomous/`ディレクトリに機能を配置。`Executor`（Claude CLI呼び出し）と`loadPrompt`（プロンプト読み込み）のみ既存モジュールを再利用する。

## Steering Document Alignment

### Technical Standards (tech.md)
- TypeScript 5.x + ESM（NodeNext）、既存パターン踏襲
- LLM API: Genkit経由マルチプロバイダー（Gemini/OpenAI/Anthropic）
- STDIO Transport（MCPツール）
- プロンプト外部化（`prompts/`ディレクトリ）
- テスト: Vitest

### Project Structure (structure.md)
- `src/autonomous/`に新規モジュール配置（既存`src/scheduler/`と並列）
- ツールファイルは`src/tools/`に追加（既存パターン: ツール定義+ハンドラー関数）
- 型定義は`src/types.ts`に追加
- プロンプトは`prompts/`に追加
- ファイル名: camelCase.ts、クラス: PascalCase、関数: camelCase

## Code Reuse Analysis

### Existing Components to Leverage
- **`Executor`** (`src/scheduler/executor.ts`): `spawnClaude()`と`buildCleanEnv()`をそのまま再利用。`runSpecUpdate()`を参考に自律タスク用のメソッドを新クラスで実装
- **`loadPrompt()`** (`src/analyzer/prompt-loader.ts`): 外部プロンプトファイルの読み込み
- **`PromptBuilder.replaceVariables()`パターン** (`src/scheduler/prompt-builder.ts`): `{variable_name}`形式のテンプレート変数置換
- **MCPツール定義パターン** (`src/tools/*.ts`): Tool定義 + ハンドラー関数の構造

### Integration Points
- **`cli/spec-update.ts`**: スケジューラーのメインループから自律タスクキューも確認するよう拡張
- **`src/index.ts`**: 新規4ツールをMCPサーバーに登録
- **`~/.wasurenagusa/scheduler/`**: 自律タスクデータの永続化先

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Claude Code (MCP Client)                 │
│  ┌──────────────┐  ┌────────────────────────────────────┐   │
│  │ Hooks Engine  │  │          MCP Client                │   │
│  └──────┬───────┘  └──────────────┬─────────────────────┘   │
└─────────┼──────────────────────────┼────────────────────────┘
          │ type: "command"          │ STDIO
          ▼                          ▼
┌─────────────────────────────────────────────────────────────┐
│                    wasurenagusa-mcp                           │
│                                                              │
│  ┌── MCPツール ──────────────────────────────────────────┐  │
│  │ 既存5ツール + 新規4ツール                              │  │
│  │ task_submit / task_status / task_action_list /         │  │
│  │ project_init                                           │  │
│  └────────────────────────────┬──────────────────────────┘  │
│                               │                              │
│  ┌── autonomous/ ─────────────▼──────────────────────────┐  │
│  │ TaskStore        → autonomous-tasks.json              │  │
│  │ CommandGenerator → Gemini命令文生成                     │  │
│  │ TaskEvaluator    → Gemini評価                          │  │
│  │ ProjectInitializer → meta.json管理                     │  │
│  │ ActionList       → 人間アクションリスト                 │  │
│  └────────────────────────────┬──────────────────────────┘  │
│                               │                              │
│  ┌── scheduler/ (既存) ───────┼──────────────────────────┐  │
│  │ Executor ← CLI実行共有     │                           │  │
│  │ TaskQueue (Spec更新用)     │                           │  │
│  │ PromptBuilder             │                           │  │
│  │ ChangeLogger              │                           │  │
│  └────────────────────────────┘                           │  │
│                                                              │
│  ┌── analyzer/ (既存) ───────────────────────────────────┐  │
│  │ loadPrompt() ← プロンプト読み込み共有                   │  │
│  │ createGenerateTextFn() ← LLM初期化共有 【llm/provider】│  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
          │
          │ claude -p (spawnClaude)
          ▼
┌─────────────────────────────────────────────────────────────┐
│         Claude Code @ 各プロジェクト                          │
│         Agent Teams実行 → stdout返却                         │
└─────────────────────────────────────────────────────────────┘
```

### Modular Design Principles
- **Single File Responsibility**: 各ファイルは1つの明確な責務（TaskStore=永続化、CommandGenerator=命令文生成、TaskEvaluator=評価）
- **既存モジュール非破壊**: `src/scheduler/`の既存ファイルは改修しない。`Executor`は共有利用
- **LLM初期化共通化**: `createGenerateTextFn()`ヘルパー関数を`src/llm/provider.ts`に配置し、既存Analyzerと新クラスで共有
- **プロンプト外部化**: 3つのプロンプトを`prompts/`に配置、`loadPrompt()`で読み込み

## Components and Interfaces

### 1. TaskStore (`src/autonomous/task-store.ts`)
- **Purpose:** 自律タスクのCRUD操作と永続化
- **Interfaces:**
  - `submit(params: TaskSubmitParams, projectPath: string): Promise<AutonomousTask>` — タスク投入（重複チェック付き）
  - `dequeue(): Promise<AutonomousTask | null>` — 最優先タスクを取得（status→in-progress）
  - `markCompleted(taskId: string): Promise<void>`
  - `markFailed(taskId: string, error: string): Promise<void>`
  - `markHumanRequired(taskId: string, reason: string): Promise<void>`
  - `incrementRetry(taskId: string): Promise<AutonomousTask>` — retryCount++、pendingに戻す
  - `resolveAction(taskId: string, action: "retry" | "complete" | "cancel"): Promise<void>`
  - `getStatus(): Promise<TaskStatusResponse>`
  - `getHumanRequiredTasks(): Promise<AutonomousTask[]>`
  - `addEvaluation(taskId: string, entry: EvaluationEntry): Promise<void>`
  - `setGeneratedCommand(taskId: string, command: string): Promise<void>` — 生成された命令文を保存
  - `recoverInProgress(): Promise<number>` — 起動時にstatus=in-progressのタスクをfailedに復旧、復旧件数を返却
- **Dependencies:** `fs/promises`（JSON読み書き）、`types.ts`
- **Storage:** `~/.wasurenagusa/scheduler/autonomous-tasks.json`

### 2. CommandGenerator (`src/autonomous/command-generator.ts`)
- **Purpose:** WHY/WHAT/DONE + ProjectMetaからClaude Code向け命令文を生成
- **Interfaces:**
  - `generate(input: CommandGenerationInput): Promise<string>` — Geminiで命令文生成
- **Dependencies:** `analyzer/prompt-loader.ts`（loadPrompt）、`llm/provider.ts`（createGenerateTextFn）
- **Prompt:** `prompts/task-command.txt`

### 3. TaskEvaluator (`src/autonomous/evaluator.ts`)
- **Purpose:** Claude CLI実行結果をDone条件に照らして評価
- **Interfaces:**
  - `evaluate(input: EvaluationInput): Promise<EvaluatorResult>` — OK/NG/human-required判定
- **Dependencies:** `analyzer/prompt-loader.ts`、`llm/provider.ts`
- **Prompt:** `prompts/task-evaluation.txt`
- **Note:** retryCount閾値（3回→human-required）のロジックはこのクラスの外（オーケストレーター側）で制御

### 4. ProjectInitializer (`src/autonomous/project-initializer.ts`)
- **Purpose:** プロジェクト初期設定の質問生成と結果永続化
- **Interfaces:**
  - `generateQuestions(projectName: string, initialInfo?: string): Promise<ProjectInitOutput>` — Geminiで質問リスト生成
  - `saveProjectMeta(projectName: string, projectPath: string, answers: Record<string, string>): Promise<ProjectMeta>` — 回答をProjectMetaに変換して保存
  - `loadProjectMeta(projectName: string): Promise<ProjectMeta | null>` — メタ情報読み込み
  - `loadProjectMetaOrDefault(projectName: string, projectPath: string): Promise<ProjectMeta>` — メタ情報読み込み（未設定時はデフォルト値を返却）
  - `updateProjectMeta(projectName: string, updates: Partial<ProjectMeta>): Promise<ProjectMeta>` — PDCA更新
- **Dependencies:** `analyzer/prompt-loader.ts`、`llm/provider.ts`、`fs/promises`
- **Prompt:** `prompts/project-initialize.txt`
- **Storage:** `~/.wasurenagusa/scheduler/projects/{project-name}/meta.json`

### 5. ActionList (`src/autonomous/action-list.ts`)
- **Purpose:** 人間アクションリストの管理
- **Interfaces:**
  - `add(item: HumanActionItem): Promise<void>`
  - `getAll(): Promise<HumanActionItem[]>` — プロジェクト別グルーピング
  - `resolve(taskId: string): Promise<void>` — アクションリストから削除
- **Dependencies:** `fs/promises`
- **Storage:** `~/.wasurenagusa/scheduler/action-list.json`

### 6. SlackNotifier (`src/autonomous/notifier.ts`)
- **Purpose:** サイクルサマリー通知・人間エスカレーション時のSlack通知
- **Interfaces:**
  - `notifyCycleSummary(summary: CycleSummary): Promise<void>` — 1サイクルの全タスク結果を1通に集約して通知
  - `notifyHumanRequired(project, taskWhat, reason, suggestion?): Promise<void>` — 即時通知（人間判断が必要）
  - `notifyRetryLimitReached(project, taskWhat, reason, retryCount, maxRetry): Promise<void>` — 即時通知（リトライ上限到達）
  - `notifyDailySummary(summary: DailySummary): Promise<void>` — 日次レポート
- **Dependencies:** `config.ts`（slackWebhookUrl）
- **Note:** `SLACK_WEBHOOK_URL`未設定時はスキップ（オプション機能）。個別タスクの完了/失敗通知は廃止し、`notifyCycleSummary`でサイクル単位の統合通知に統一

### 7. ProjectScanner (`src/autonomous/project-scanner.ts`)
- **Purpose:** ~/projects/配下のプロジェクトを自動検出
- **Interfaces:**
  - `scanProjects(): Promise<ProjectEntry[]>` — ディレクトリ走査でプロジェクト一覧を返却
- **Dependencies:** `fs/promises`、`types.ts`（ProjectEntry）
- **Note:** subProjectParents設定でサブプロジェクト持ちの親ディレクトリにも対応

### 8. TaskMarkdownAdapter (`src/autonomous/task-markdown.ts`)
- **Purpose:** tasks.md形式でのタスク投入・管理（人間がMarkdownファイルを直接編集してタスク投入可能）
- **Interfaces:**
  - `readTasks(): Promise<MarkdownTask[]>` — tasks.mdから全タスクをパース
  - `readPendingTasks(): Promise<MarkdownTask[]>` — pendingタスクだけ抽出（スケジューラー用）
  - `updateStatus(what: string, project: string, status: AutonomousTaskStatus, extra?: { error?: string; reason?: string }): Promise<boolean>` — ステータス書き戻し
  - `static toSubmitParams(task: MarkdownTask): TaskSubmitParams` — MarkdownTaskをTaskSubmitParams形式に変換（TaskStore連携用）
  - `updateProjectList(projects: ProjectEntry[]): Promise<boolean>` — tasks.mdのプロジェクト一覧コメントブロックを動的更新
- **Dependencies:** `fs/promises`、`types.ts`

### 9. Owner Profile (`src/utils/owner-profile.ts`)
- **Purpose:** オーナー（開発者）のプロフィール管理。自律タスク実行時の命令文・評価に文脈として渡される
- **Interfaces:**
  - `ensureOwnerProfileExists(memoryPath: string): Promise<void>` — テンプレート自動配置
  - `loadOwnerProfile(memoryPath: string): Promise<string | null>` — プロフィール読み込み
- **Dependencies:** `fs/promises`、`analyzer/prompt-loader.ts`
- **Template:** `prompts/owner-profile-template.md`

### 10. LLM Provider (`src/llm/provider.ts`)
- **Purpose:** LLMプロバイダー抽象化（DRY原則、マルチプロバイダー対応）
- **Interfaces:**
  - `createGenerateTextFn(): GenerateTextFn` — Genkit経由でLLMテキスト生成関数を返却
  - `resetLLMCache(): void` — テスト用キャッシュリセット
- **Dependencies:** `genkit`、`@genkit-ai/google-genai`、`@genkit-ai/anthropic`、`@genkit-ai/compat-oai`、`config.ts`
- **Note:** Gemini/OpenAI/Anthropicを統一APIで切り替え可能。`LLM_PROVIDER`/`LLM_MODEL`環境変数で制御

### 11. MCPツール（4つ新規）

**task_submit** (`src/tools/taskSubmit.ts`)
- MCP Tool定義 + `handleTaskSubmit(args, projectRoot)` ハンドラー
- → `TaskStore.submit()`に委譲

**task_status** (`src/tools/taskStatus.ts`)
- MCP Tool定義 + `handleTaskStatus(args, projectRoot)` ハンドラー
- → `TaskStore.getStatus()`に委譲

**task_action_list** (`src/tools/taskActionList.ts`)
- MCP Tool定義 + `handleTaskActionList(args, projectRoot)` ハンドラー
- → `TaskStore.getHumanRequiredTasks()`に委譲、プロジェクト別グルーピング

**project_init** (`src/tools/projectInit.ts`)
- MCP Tool定義 + `handleProjectInit(args, projectRoot)` ハンドラー
- → `ProjectInitializer.generateQuestions()` or `saveProjectMeta()`に委譲
- フラット方式: 1回の呼び出しで全パラメータを受け付ける（ステートレス）

### 12. スケジューラー拡張（`cli/spec-update.ts` 改修）
- 既存のrunCommand()に自律タスクキュー確認を追加
- 全タスクを並列数制限付き実行: 自律タスク全件 + Spec更新タスク全件をdequeueし、`maxConcurrentTasks`（デフォルト3）で並列数を制限して実行。タスクなしの場合のみpingを送信
- タスクバリデーション: 実行前にwhy/what/done/projectの空チェックとテンプレート文面検知、projectPathの存在確認を実施。不正なタスクはfailedとしてスキップ
- 自律タスクのオーケストレーション: dequeue → バリデーション → CommandGenerator → Executor → TaskEvaluator → 結果反映
- アイドル判定: `last-session.json`の最終セッション終了時刻から`idleThresholdMinutes`分以上経過していない場合はタスク実行をスキップしpingのみ送信
- tasks.md同期: `TaskMarkdownAdapter`でtasks.mdのpendingタスクをTaskStoreに自動取り込み。タスク完了/失敗時にtasks.mdのステータスも更新
- プロジェクトスキャン: `ProjectScanner`で~/projects/配下のプロジェクトを自動検出し、tasks.mdのプロジェクトリストを更新

## Data Models

### AutonomousTask
```typescript
export type AutonomousTaskStatus =
  | "pending"
  | "in-progress"
  | "completed"
  | "failed"
  | "human-required"
  | "cancelled";

export interface AutonomousTask {
  id: string;                           // UUID
  why: string;                          // なぜやるか
  what: string;                         // どんな体験/行動変容を与えたいか
  done: string;                         // 完了条件（機械検証可能な基準）
  project: string;                      // プロジェクト名
  projectPath: string;                  // プロジェクト絶対パス
  status: AutonomousTaskStatus;
  priority: number;                     // 0=人間投入, 1=change-based, 2=rotation
  retryCount: number;                   // 差し戻し回数（上限3）
  createdAt: string;                    // ISO 8601 JST
  completedAt?: string;
  generatedCommand?: string;            // 生成された命令文（デバッグ用）
  evaluationHistory: EvaluationEntry[]; // 評価履歴
  humanRequiredReason?: string;         // human-requiredの理由
  timeoutMs?: number;                   // タスク固有のタイムアウト（デフォルト1800000=30分）
  maxTurns?: number;                    // タスク固有のmaxTurns（デフォルト100）
  allowedTools?: string[];              // タスク固有のallowedTools
}
```

### EvaluationEntry
```typescript
export interface EvaluationEntry {
  timestamp: string;
  result: "ok" | "ng" | "human-required";
  reason: string;
  suggestion?: string;
  executionDurationMs: number;
}
```

### EvaluatorResult
```typescript
export interface EvaluatorResult {
  verdict: "ok" | "ng" | "human-required";
  reason: string;
  suggestion?: string;
}
```

### ProjectMeta
```typescript
export interface ProjectMeta {
  project: string;
  projectPath: string;
  phase: "startup" | "growth" | "stable";
  qualityPolicy: "speed_first" | "balanced" | "quality_first";
  testExpectation: "minimal" | "standard" | "thorough";
  codeQuality: "pragmatic" | "balanced" | "strict";
  debtTolerance: "accept" | "moderate" | "zero_tolerance";
  aiAutonomy: "narrow" | "moderate" | "wide";
  escalationTriggers: string[];         // cost_impact, user_facing, architecture等
  targetAudience: string;               // b2b_enterprise, b2c_consumer等
  successMetric: string;                // revenue, user_engagement等
  createdAt: string;
  updatedAt: string;
}
```

### HumanActionItem
```typescript
export interface HumanActionItem {
  taskId: string;
  project: string;
  what: string;
  reason: string;
  suggestion?: string;
  createdAt: string;
  source: "evaluation" | "retry-limit";
}
```

### TaskSubmitParams / TaskStatusResponse
```typescript
export interface TaskSubmitParams {
  why: string;
  what: string;
  done: string;
  project: string;
}

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
```

### ProjectInitOutput
```typescript
export interface ProjectInitQuestion {
  key: string;                          // "phase", "qualityPolicy"等
  question: string;                     // 質問文
  options: string[];                    // 選択肢
}

export interface ProjectInitOutput {
  questions: ProjectInitQuestion[];
}
```

### CommandGenerationInput / EvaluationInput
```typescript
export interface CommandGenerationInput {
  task: AutonomousTask;
  projectMeta: ProjectMeta;
  ownerProfile?: string;          // オーナープロフィール（自動読み込み）
}

export interface EvaluationInput {
  task: AutonomousTask;
  projectMeta: ProjectMeta;
  ownerProfile?: string;          // オーナープロフィール（自動読み込み）
  executionOutput: string;        // stdout（上限50,000文字）
  executionExitCode: number;
  executionDurationMs: number;
}

export interface ProjectEntry {
  name: string;        // プロジェクト名（例: "my-project" or "my-org/sub-project"）
  path: string;        // 絶対パス
  type: "standalone" | "subproject";
}
```

### CycleTaskResult / CycleSummary (`src/autonomous/notifier.ts`)
```typescript
export interface CycleTaskResult {
  project: string;
  taskType: "autonomous" | "change-based" | "rotation";
  description: string;       // autonomous: task.what, spec: "spec更新"
  summary?: string;          // 成功時のサマリー（Spec更新のstdout先頭等）
  exitCode: number;
  durationMs: number;
  failReason?: string;       // 失敗時のみ
}

export interface CycleSummary {
  results: CycleTaskResult[];
  totalDurationMs: number;
  completedAt: string;        // ISO 8601
}
```

### DailySummary (`src/autonomous/notifier.ts`)
```typescript
export interface DailySummary {
  completed: number;
  failed: number;
  humanRequired: number;
  pending: number;
  date: string;               // "YYYY-MM-DD"
}
```

## Data Flow

```
[人間] task_submit MCP呼び出し
  │ { why, what, done, project }
  ▼
TaskStore.submit()
  │ UUID付与、重複チェック、status=pending、priority=0
  │ → autonomous-tasks.json に永続化
  ▼
[スケジューラー] cli/spec-update.ts (cron実行)
  │ 1. TaskStore.dequeue() で自律タスクを全件取得
  │ 2. TaskQueue.dequeue() でSpec更新タスクを全件取得
  │ 3. 全タスクをmaxConcurrentTasks制限付きで並列実行
  │ 4. タスクなしの場合のみping
  ▼
validateAutonomousTask(task)
  │ why/what/done/projectの空チェック、テンプレート文面検知、projectPath存在確認
  ├── invalid → TaskStore.markFailed(taskId, reason) → スキップ
  └── valid ↓
  ▼
ProjectInitializer.loadProjectMetaOrDefault(task.project, task.projectPath)
  │ meta.json読み込み（未設定時はデフォルト値）
  ▼
CommandGenerator.generate({ task, projectMeta })
  │ loadPrompt("task-command.txt")
  │ → Gemini API → 命令文生成
  │ task.generatedCommand に保存
  ▼
// AUTONOMOUS_DEFAULT_OPTIONS (src/autonomous/constants.ts)
// maxTurns: 100, timeoutMs: 1800000 (30min)
// allowedTools: ["Edit","Write","Read","Glob","Grep","Bash","TodoWrite"]
Executor.runSpecUpdate(command, task.projectPath, {
  maxTurns: AUTONOMOUS_DEFAULT_OPTIONS.maxTurns,
  allowedTools: AUTONOMOUS_DEFAULT_OPTIONS.allowedTools,
  timeoutMs: AUTONOMOUS_DEFAULT_OPTIONS.timeoutMs
})
  │ claude -p "{命令文}" でClaude Code実行
  │ stdout/stderr/exitCode/durationMs を取得
  ▼
[exitCode判定]
  ├── exitCode !== 0 → TaskStore.markFailed(taskId, "Exit code: {exitCode}")
  │
  └── exitCode === 0 →
      ▼
      TaskEvaluator.evaluate({ task, projectMeta, executionOutput, ... })
        │ loadPrompt("task-evaluation.txt")
        │ → Gemini API → { verdict, reason, suggestion }
        ▼
      [verdict判定]
        ├── "ok" → TaskStore.markCompleted(taskId)
        │
        ├── "ng" → TaskStore.incrementRetry(taskId)
        │          retryCount >= 3 ?
        │          ├── Yes → TaskStore.markHumanRequired(taskId, reason)
        │          │         ActionList.add(...)
        │          └── No  → status=pending (次サイクルで再実行)
        │
        └── "human-required" → TaskStore.markHumanRequired(taskId, reason)
                               ActionList.add(...)

---
[人間] task_action_list で確認 → 対応を決定
  │
  ▼
TaskStore.resolveAction(taskId, action)
  ├── "retry"    → status=pending（retryCount据え置き、次サイクルで再実行）
  ├── "complete" → status=completed（人間が手動で解決済み）
  └── "cancel"   → status=cancelled（対応不要と判断）
  いずれも → ActionList.resolve(taskId) でリストから除去
```

## Error Handling

### Error Scenarios

1. **Gemini API呼び出し失敗（命令文生成/評価）**
   - **Handling:** タスクをfailedにし、エラー理由「Gemini API error: {message}」を記録。次サイクルでのリトライは行わない（人間確認が必要）
   - **User Impact:** task_statusで確認可能。永続的なAPI障害ならaction-listに表示

2. **Claude CLI実行タイムアウト**
   - **Handling:** SIGTERMでプロセス終了。タスクをfailedにし、「Execution timeout after {timeoutMs}ms」を記録
   - **User Impact:** task_statusで確認可能

3. **Claude CLI exitCode !== 0**
   - **Handling:** タスクをfailedにし、「Exit code: {exitCode}」をエラー理由として記録
   - **User Impact:** task_statusで確認可能

4. **ProjectMeta未設定状態でタスク実行**
   - **Handling:** meta.jsonが存在しない場合、デフォルトProjectMeta（phase=startup, qualityPolicy=balanced等）を使用して続行。ログに警告出力
   - **User Impact:** 品質基準がデフォルトになるが、タスクは実行される

5. **autonomous-tasks.json読み込みエラー**
   - **Handling:** 空配列として扱う（既存TaskQueueと同パターン: `src/scheduler/task-queue.ts:145`）
   - **User Impact:** データ損失の可能性。JSONファイルのバックアップは将来課題

6. **排他制御（.lockファイル）**
   - **Handling:** ロック取得失敗時はスケジューラーサイクルをスキップ（次回リトライ）
   - **User Impact:** 影響なし（次サイクルで処理される）

7. **スケジューラー起動時のin-progressタスク復旧**
   - **Handling:** 起動時にstatus=in-progressのタスクをfailedに変更（前回クラッシュの残骸）
   - **User Impact:** task_statusに表示される。必要なら人間がretry指示

8. **stdout上限超過（50,000文字超え）**
   - **Handling:** stdoutが50,000文字を超える場合、末尾50,000文字を評価者に渡す（`stdout.slice(-50000)`）。タスク完了サマリは末尾に出力されるため、末尾を優先
   - **User Impact:** 評価精度への影響は軽微

## Testing Strategy

### Unit Testing

テストファイルは各モジュールと同階層に`*.test.ts`で配置（既存パターン踏襲）。

| モジュール | テストファイル | モック方法 |
|-----------|-------------|-----------|
| `TaskStore` | `task-store.test.ts` | `mkdtemp`で一時ディレクトリ（既存TaskQueueパターン） |
| `CommandGenerator` | `command-generator.test.ts` | `vi.mock("../analyzer/gemini-client.js")`でcreateGeminiModelモック |
| `TaskEvaluator` | `evaluator.test.ts` | 同上 |
| `ProjectInitializer` | `project-initializer.test.ts` | 同上 + `mkdtemp` |
| `ActionList` | `action-list.test.ts` | `mkdtemp` |
| `SlackNotifier` | `notifier.test.ts` | `vi.stubGlobal("fetch")`でfetchモック + `vi.mock("../config.js")`でconfigモック |
| `ProjectScanner` | `project-scanner.test.ts` | `mkdtemp` |
| `TaskMarkdownAdapter` | `task-markdown.test.ts` | `mkdtemp` |

#### LLMモックパターン（共通）
`createGenerateTextFn()`をモックすることで、LLMプロバイダーの内部構造に依存しない。
```typescript
vi.mock("../llm/provider.js", () => ({
  createGenerateTextFn: vi.fn().mockReturnValue(
    vi.fn().mockResolvedValue('{"verdict":"ok","reason":"done"}')
  )
}));
```

### Key Test Cases

**TaskStore:**
- submit: 正常投入、重複拒否、UUID付与
- dequeue: priority順取得、status変更
- incrementRetry: retryCount上限判定
- markHumanRequired: ステータス変更+理由記録
- resolveAction("retry"): status=pending、retryCountリセットなし
- resolveAction("complete"): status=completed
- resolveAction("cancel"): status=cancelled

**CommandGenerator:**
- プロンプトテンプレート変数の正確な置換
- Gemini APIレスポンスの正常返却

**TaskEvaluator:**
- OK/NG/human-required各判定のJSON解析
- 不正JSONレスポンスのエラーハンドリング

**MCPツール:**
- 各ツールの入力バリデーション
- TaskStoreへの正常委譲

**project_init:**
- 全パラメータ指定で正常保存
- 既存プロジェクトの上書き更新
- 必須パラメータ欠損時のバリデーション

### Integration Testing

スケジューラーのオーケストレーションフロー（dequeue→CommandGenerator→Executor→Evaluator→結果反映）を、全モジュールモックで統合テスト。
- 正常フロー: submit → dequeue → generate → execute → evaluate(OK) → completed
- NGフロー: submit → dequeue → generate → execute → evaluate(NG) → retry → evaluate(NG) → retry → evaluate(NG) → human-required
- タイムアウトフロー: submit → dequeue → generate → execute(timeout) → failed
