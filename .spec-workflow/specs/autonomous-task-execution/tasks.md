# Tasks: Autonomous Task Execution System

## Phase 1: 基盤（型定義・共通モジュール）

### Task 1.1: 型定義の追加
- [ ] `src/types.ts`に以下の型を追加:
  - `AutonomousTaskStatus` (union type)
  - `AutonomousTask` (interface)
  - `EvaluationEntry` (interface)
  - `EvaluatorResult` (interface)
  - `ProjectMeta` (interface)
  - `HumanActionItem` (interface)
  - `TaskSubmitParams` (interface)
  - `TaskStatusResponse` (interface)
  - `CommandGenerationInput` (interface)
  - `EvaluationInput` (interface)
  - `ProjectInitQuestion` (interface)
  - `ProjectInitOutput` (interface)
- **Files:** `src/types.ts`
- **Req:** Req-1, Req-4, Req-7

### Task 1.2: Gemini Client Helper
- [ ] `src/analyzer/gemini-client.ts`を新規作成
  - `createGeminiModel(): GenerativeModel` — APIキー取得+モデル生成
  - 既存`src/analyzer/gemini.ts`のコンストラクタロジックを関数として抽出
- **Files:** `src/analyzer/gemini-client.ts`
- **Req:** NFR (DRY)

### Task 1.3: Autonomous Default Options
- [ ] `src/autonomous/constants.ts`を新規作成
  - `AUTONOMOUS_DEFAULT_OPTIONS`: maxTurns=100, timeoutMs=1800000, allowedTools=["Edit","Write","Read","Glob","Grep","Bash","TodoWrite"]
- **Files:** `src/autonomous/constants.ts`
- **Req:** Req-2

## Phase 2: コアモジュール

### Task 2.1: TaskStore
- [ ] `src/autonomous/task-store.ts`を新規作成
  - `submit(params)`: UUID付与、重複チェック（同一project+what+status=pendingで拒否）、status=pending、priority=0
  - `dequeue()`: priority昇順→createdAt昇順で最優先pendingタスクを取得、status→in-progress
  - `markCompleted(taskId)`: status=completed、completedAt設定
  - `markFailed(taskId, error)`: status=failed、error記録
  - `markHumanRequired(taskId, reason)`: status=human-required、reason記録
  - `incrementRetry(taskId)`: retryCount++、status→pending
  - `resolveAction(taskId, action)`: retry→pending / complete→completed / cancel→cancelled
  - `getStatus()`: サマリ集計+直近20件
  - `getHumanRequiredTasks()`: human-requiredタスク一覧
  - `addEvaluation(taskId, entry)`: 評価履歴追加
  - `recoverInProgress()`: 起動時in-progress→failed復旧
  - 永続化: `~/.wasurenagusa/scheduler/autonomous-tasks.json`
- **Files:** `src/autonomous/task-store.ts`
- **Req:** Req-1, Req-5, Req-6, Req-8

### Task 2.2: CommandGenerator
- [ ] `src/autonomous/command-generator.ts`を新規作成
  - `generate(input: CommandGenerationInput): Promise<string>`
  - loadPrompt("task-command.txt")でテンプレート読み込み
  - テンプレート変数置換: {why}, {what}, {done}, {project_name}, {project_path}, {project_meta}
  - Gemini APIで命令文生成
  - 「作業完了時にサマリを最後に出力せよ」指示を含む命令文を返却
- **Files:** `src/autonomous/command-generator.ts`
- **Req:** Req-2, Req-9

### Task 2.3: TaskEvaluator
- [ ] `src/autonomous/evaluator.ts`を新規作成
  - `evaluate(input: EvaluationInput): Promise<EvaluatorResult>`
  - loadPrompt("task-evaluation.txt")でテンプレート読み込み
  - テンプレート変数置換: {done}, {execution_output}, {exit_code}, {duration_ms}, {project_meta}
  - Gemini APIで評価実行、JSON解析してEvaluatorResult返却
  - stdout上限: `executionOutput.slice(-50000)`で末尾50,000文字に制限
  - 不正JSON時はエラーthrow
- **Files:** `src/autonomous/evaluator.ts`
- **Req:** Req-3, Req-9

### Task 2.4: ProjectInitializer
- [ ] `src/autonomous/project-initializer.ts`を新規作成
  - `generateQuestions(projectName, initialInfo?): Promise<ProjectInitOutput>` — Geminiで質問リスト生成
  - `saveProjectMeta(projectName, answers): Promise<ProjectMeta>` — 回答→ProjectMetaに変換して保存
  - `loadProjectMeta(projectName): Promise<ProjectMeta | null>` — meta.json読み込み
  - `updateProjectMeta(projectName, updates): Promise<ProjectMeta>` — PDCA更新
  - 保存先: `~/.wasurenagusa/scheduler/projects/{project-name}/meta.json`
  - ProjectMeta未設定時のデフォルト値定義
- **Files:** `src/autonomous/project-initializer.ts`
- **Req:** Req-4

### Task 2.5: ActionList
- [ ] `src/autonomous/action-list.ts`を新規作成
  - `add(item: HumanActionItem): Promise<void>`
  - `getAll(): Promise<HumanActionItem[]>` — プロジェクト別グルーピング
  - `resolve(taskId: string): Promise<void>` — リストから除去
  - 永続化: `~/.wasurenagusa/scheduler/action-list.json`
- **Files:** `src/autonomous/action-list.ts`
- **Req:** Req-6

## Phase 3: MCPツール

### Task 3.1: task_submit ツール
- [ ] `src/tools/taskSubmit.ts`を新規作成
  - MCP Tool定義（name, description, inputSchema）
  - `handleTaskSubmit(args)` ハンドラー
  - 入力バリデーション: why, what, done, project が必須
  - → TaskStore.submit()に委譲
  - projectPath解決: ProjectInitializer.loadProjectMeta()からpath取得
- **Files:** `src/tools/taskSubmit.ts`
- **Req:** Req-7

### Task 3.2: task_status ツール
- [ ] `src/tools/taskStatus.ts`を新規作成
  - MCP Tool定義
  - `handleTaskStatus(args)` ハンドラー
  - → TaskStore.getStatus()に委譲
  - オプション: projectフィルタ
- **Files:** `src/tools/taskStatus.ts`
- **Req:** Req-7

### Task 3.3: task_action_list ツール
- [ ] `src/tools/taskActionList.ts`を新規作成
  - MCP Tool定義
  - `handleTaskActionList(args)` ハンドラー
  - → ActionList.getAll()に委譲 + プロジェクト別グルーピング
  - resolveアクション: taskId + action("retry"|"complete"|"cancel")
  - → TaskStore.resolveAction() + ActionList.resolve()
- **Files:** `src/tools/taskActionList.ts`
- **Req:** Req-6, Req-7

### Task 3.4: project_init ツール
- [ ] `src/tools/projectInit.ts`を新規作成
  - MCP Tool定義
  - `handleProjectInit(args)` ハンドラー
  - mode="generate": ProjectInitializer.generateQuestions()
  - mode="save": ProjectInitializer.saveProjectMeta()
  - フラット方式（ステートレス）
- **Files:** `src/tools/projectInit.ts`
- **Req:** Req-4, Req-7

### Task 3.5: MCPサーバー登録
- [ ] `src/tools/index.ts`に4つのツールのエクスポートを追加
- [ ] `src/index.ts`に4つのツールを登録
  - task_submit, task_status, task_action_list, project_init
  - 既存ツール（memory_save等）と並列に追加
  - 各ツールのハンドラー呼び出し
- **Files:** `src/index.ts`
- **Req:** Req-7, Req-10

## Phase 4: スケジューラー統合

### Task 4.1: オーケストレーター
- [ ] `cli/spec-update.ts`を改修
  - runCommand()内で自律タスクキュー確認を追加
  - 処理順序: TaskStore.dequeue() → 既存TaskQueue.dequeue() → ping
  - 自律タスクのオーケストレーションフロー:
    1. TaskStore.dequeue()
    2. ProjectInitializer.loadProjectMeta()
    3. CommandGenerator.generate()
    4. Executor.runSpecUpdate() with AUTONOMOUS_DEFAULT_OPTIONS
    5. exitCode判定 (!=0 → markFailed)
    6. TaskEvaluator.evaluate() with stdout.slice(-50000)
    7. verdict判定 (ok→completed, ng→incrementRetry, human-required→markHumanRequired)
    8. retryCount >= 3 → markHumanRequired + ActionList.add()
  - 起動時: TaskStore.recoverInProgress()
- **Files:** `cli/spec-update.ts`
- **Req:** Req-2, Req-3, Req-5, Req-8, Req-9, Req-10

## Phase 5: プロンプト

### Task 5.1: 命令文生成プロンプト
- [ ] `prompts/task-command.txt`を新規作成
  - テンプレート変数: {why}, {what}, {done}, {project_name}, {project_path}, {project_meta}
  - Agent Teams起動指示
  - CLAUDE.md/CLAUDE.local.md遵守指示
  - 「作業完了時にサマリを出力せよ」指示
  - プロジェクトフェーズに応じた品質指示
- **Files:** `prompts/task-command.txt`
- **Req:** Req-2, Req-9

### Task 5.2: 評価者プロンプト
- [ ] `prompts/task-evaluation.txt`を新規作成
  - テンプレート変数: {done}, {execution_output}, {exit_code}, {duration_ms}, {project_meta}
  - JSON出力スキーマ: { verdict, reason, suggestion? }
  - Few-shot例: OK判定、NG判定、human-required判定、部分完了の4パターン
  - Done条件の機械的判定指示
  - 事業判断検知→human-required指示
- **Files:** `prompts/task-evaluation.txt`
- **Req:** Req-3

### Task 5.3: プロジェクトイニシャライズプロンプト
- [ ] `prompts/project-initialize.txt`を新規作成
  - テンプレート変数: {project_name}, {initial_info}
  - JSON出力スキーマ: ProjectInitOutput
  - 質問カテゴリ: フェーズ、品質方針、テスト期待値、コード品質、AI自律度等
  - 各質問に2-4選択肢
- **Files:** `prompts/project-initialize.txt`
- **Req:** Req-4

## Phase 6: テスト

### Task 6.1: TaskStoreテスト
- [ ] `src/autonomous/task-store.test.ts`を新規作成
  - submit: 正常投入、重複拒否、UUID付与
  - dequeue: priority順取得、status変更、空キュー時null
  - incrementRetry: retryCount上限判定
  - markHumanRequired: ステータス変更+理由記録
  - resolveAction: retry/complete/cancelの3パターン
  - recoverInProgress: in-progress→failed復旧
  - mkdtempで一時ディレクトリ使用
- **Files:** `src/autonomous/task-store.test.ts`
- **Req:** Req-1, Req-5, Req-6, Req-8

### Task 6.2: CommandGeneratorテスト
- [ ] `src/autonomous/command-generator.test.ts`を新規作成
  - テンプレート変数の正確な置換
  - Gemini APIレスポンスの正常返却
  - createGeminiModelモック使用
- **Files:** `src/autonomous/command-generator.test.ts`
- **Req:** Req-2

### Task 6.3: TaskEvaluatorテスト
- [ ] `src/autonomous/evaluator.test.ts`を新規作成
  - OK/NG/human-required各判定のJSON解析
  - 不正JSONレスポンスのエラーハンドリング
  - createGeminiModelモック使用
- **Files:** `src/autonomous/evaluator.test.ts`
- **Req:** Req-3

### Task 6.4: ProjectInitializerテスト
- [ ] `src/autonomous/project-initializer.test.ts`を新規作成
  - 質問リスト生成
  - ProjectMeta保存・読み込み・更新
  - デフォルトProjectMeta
  - createGeminiModelモック + mkdtemp使用
- **Files:** `src/autonomous/project-initializer.test.ts`
- **Req:** Req-4

### Task 6.5: ActionListテスト
- [ ] `src/autonomous/action-list.test.ts`を新規作成
  - add: 正常追加
  - getAll: プロジェクト別グルーピング
  - resolve: リストから除去
  - mkdtempで一時ディレクトリ使用
- **Files:** `src/autonomous/action-list.test.ts`
- **Req:** Req-6

### Task 6.6: MCPツールテスト
- [ ] 各ツールのテスト作成
  - `src/tools/taskSubmit.test.ts`: 入力バリデーション、正常委譲
  - `src/tools/taskStatus.test.ts`: 正常委譲
  - `src/tools/taskActionList.test.ts`: 正常委譲、resolveアクション
  - `src/tools/projectInit.test.ts`: generate/saveの両モード、バリデーション
- **Files:** `src/tools/taskSubmit.test.ts`, `src/tools/taskStatus.test.ts`, `src/tools/taskActionList.test.ts`, `src/tools/projectInit.test.ts`
- **Req:** Req-7

### Task 6.7: 統合テスト
- [ ] オーケストレーションの統合テスト作成
  - 正常フロー: submit → dequeue → generate → execute → evaluate(OK) → completed
  - NGフロー: 3回NG → human-required
  - タイムアウトフロー: execute(timeout) → failed
  - 全モジュールモック
- **Files:** `src/autonomous/orchestration.test.ts`
- **Req:** Req-2, Req-3, Req-5

## Phase 7: 型チェック・テスト実行

### Task 7.1: 型チェック+テスト全パス
- [ ] `npx tsc --noEmit` で型チェック通過
- [ ] `npx vitest run` でテスト全パス
- [ ] 既存テストが壊れていないことを確認
- **Req:** NFR, Req-10
