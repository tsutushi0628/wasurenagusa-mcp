# Tasks Document: Spec Auto-Update

- [x] 1. 型定義の追加
  - File: src/types.ts
  - Scheduler関連のインターフェース（ChangeLogEntry, SchedulerTask, SpecPaths, ProjectConfig, SchedulerConfig, ExecutionResult）を追加
  - 既存の型定義ファイルに追記
  - Purpose: 全Schedulerモジュールの型安全性を確立
  - _Leverage: src/types.ts（既存パターン）_
  - _Requirements: 1, 2, 3, 4, 5, 6_
  - _Prompt: Implement the task for spec spec-auto-update, first run spec-workflow-guide to get the workflow guide then implement the task: Role: TypeScript Developer | Task: src/types.tsにScheduler関連のインターフェースを追加する。design.mdのComponents and Interfacesセクションに記載された全インターフェース（ChangeLogEntry, SchedulerTask, SpecPaths, ProjectConfig, SchedulerConfig, ExecutionResult, TaskType, TaskStatus）を定義する | Restrictions: 既存の型定義を変更しない。ESM import/exportパターンに従う | Success: 全インターフェースが定義され、tscでエラーなくコンパイルできる。tasks.mdで[-]にマークし、完了後に[x]にマークしlog-implementationを実行する_

- [x] 2. ChangeLoggerの実装（TDD）
  - File: src/scheduler/change-logger.ts, src/scheduler/change-logger.test.ts
  - テスト先行: git diffモック、JSONファイル読み書き、エッジケース（変更なし、.gitなし）のテストを先に書く
  - 実装: gitで変更ファイル名を取得し、~/.wasurenagusa/scheduler/change-log.jsonに追記
  - Purpose: セッション中の変更ファイルを検出・記録する
  - _Leverage: src/utils/projectRoot.ts, child_process_
  - _Requirements: 1_
  - _Prompt: Implement the task for spec spec-auto-update, first run spec-workflow-guide to get the workflow guide then implement the task: Role: TypeScript TDD Developer | Task: まずsrc/scheduler/change-logger.test.tsにChangeLoggerのテストを書く（git diffモック、JSON読み書き、変更なしケース、.gitなしケース）。次にsrc/scheduler/change-logger.tsにChangeLoggerクラスを実装する。design.mdのComponent 1の仕様に従う。git diff --name-onlyで変更ファイル名を取得し、~/.wasurenagusa/scheduler/change-log.jsonに追記する | Restrictions: TDD必須（テスト先行）。child_processはexecFileを使用。git diffの実行はモック可能にする。ESM import(.js拡張子) | Success: 全テストがパスする。vitest runで確認。tasks.mdで[-]にマークし、完了後に[x]にマークしlog-implementationを実行する_

- [x] 3. TaskQueueの実装（TDD）
  - File: src/scheduler/task-queue.ts, src/scheduler/task-queue.test.ts
  - テスト先行: キュー操作、優先度ソート、空キュー、タスク状態遷移のテストを先に書く
  - 実装: 優先度付きタスクキュー。変更ベース（priority:1）> ローテーション（priority:2）> ping（priority:3）
  - Purpose: Spec更新タスクを優先度管理する
  - _Leverage: crypto（UUID）, fs/promises_
  - _Requirements: 2_
  - _Prompt: Implement the task for spec spec-auto-update, first run spec-workflow-guide to get the workflow guide then implement the task: Role: TypeScript TDD Developer | Task: まずsrc/scheduler/task-queue.test.tsにTaskQueueのテストを書く（buildQueue、dequeue優先度順、markComplete、markFailed、空キュー、重複タスク防止）。次にsrc/scheduler/task-queue.tsにTaskQueueクラスを実装する。design.mdのComponent 2の仕様に従う | Restrictions: TDD必須。JSONファイルベースの永続化。crypto.randomUUIDでID生成。ESM import(.js拡張子) | Success: 全テストがパスする。vitest runで確認。tasks.mdで[-]にマークし、完了後に[x]にマークしlog-implementationを実行する_

- [x] 4. PromptBuilderの実装（TDD）
  - File: src/scheduler/prompt-builder.ts, src/scheduler/prompt-builder.test.ts
  - テスト先行: テンプレート変数置換、change-based/rotationの各プロンプト生成テスト
  - 実装: prompts/spec-update.txt, prompts/spec-rotation.txtからテンプレート読み込み、変数埋め込み
  - Purpose: Claude Code CLI用のプロンプトを組み立てる
  - _Leverage: src/analyzer/prompt-loader.ts_
  - _Requirements: 3.5_
  - _Prompt: Implement the task for spec spec-auto-update, first run spec-workflow-guide to get the workflow guide then implement the task: Role: TypeScript TDD Developer | Task: まずsrc/scheduler/prompt-builder.test.tsにPromptBuilderのテストを書く（変更ベースプロンプト生成、ローテーションプロンプト生成、テンプレート変数置換）。次にsrc/scheduler/prompt-builder.tsにPromptBuilderクラスを実装する。既存のloadPrompt()（src/analyzer/prompt-loader.ts）を再利用してテンプレートを読み込む。prompts/spec-update.txtとprompts/spec-rotation.txtも作成する | Restrictions: TDD必須。既存のprompt-loader.tsを再利用。テンプレートは{variable}形式の単純置換。ESM import(.js拡張子) | Success: 全テストがパスし、プロンプトテンプレートファイルが作成されている。vitest runで確認。tasks.mdで[-]にマークし、完了後に[x]にマークしlog-implementationを実行する_

- [x] 5. Executorの実装（TDD）
  - File: src/scheduler/executor.ts, src/scheduler/executor.test.ts
  - テスト先行: claude CLI実行モック、タイムアウト、exitCode処理、isClaudeAvailableのテスト
  - 実装: child_process.execFileでclaude -pを実行。タイムアウト・エラーハンドリング
  - Purpose: Claude Code CLIのヘッドレス実行を管理する
  - _Leverage: child_process_
  - _Requirements: 3, 4_
  - _Prompt: Implement the task for spec spec-auto-update, first run spec-workflow-guide to get the workflow guide then implement the task: Role: TypeScript TDD Developer | Task: まずsrc/scheduler/executor.test.tsにExecutorのテストを書く（claude -p実行モック、タイムアウト処理、exitCode処理、ping実行、isClaudeAvailableチェック）。次にsrc/scheduler/executor.tsにExecutorクラスを実装する。design.mdのComponent 3の仕様に従う | Restrictions: TDD必須。child_process.execFileを使用。実際のclaude CLIは呼ばない（テストではモック）。タイムアウトはAbortControllerで制御。ESM import(.js拡張子) | Success: 全テストがパスする。vitest runで確認。tasks.mdで[-]にマークし、完了後に[x]にマークしlog-implementationを実行する_

- [x] 6. analyze.tsへのChangeLogger統合
  - File: src/cli/analyze.ts
  - 既存のmain()関数の末尾に変更ログ記録を追加
  - git diffで変更ファイル名を取得 → ChangeLoggerで記録
  - Purpose: Stop Hookに変更ログ記録を相乗りさせる
  - _Leverage: src/scheduler/change-logger.ts, src/cli/analyze.ts_
  - _Requirements: 1_
  - _Prompt: Implement the task for spec spec-auto-update, first run spec-workflow-guide to get the workflow guide then implement the task: Role: TypeScript Developer | Task: src/cli/analyze.tsのmain()関数の末尾（メモリ保存処理の後）に、ChangeLoggerを使った変更ログ記録を追加する。HookInputのcwdからプロジェクトルートを取得し、ChangeLogger.recordChanges()を呼び出す。エラーが発生しても既存のanalyze処理には影響させない（try-catchで包む） | Restrictions: 既存の分析・保存ロジックは一切変更しない。変更ログ記録の失敗は握りつぶす（既存機能を壊さない）。ESM import(.js拡張子) | Success: 既存テストが引き続きパスする。analyze.tsの変更が最小限。tasks.mdで[-]にマークし、完了後に[x]にマークしlog-implementationを実行する_

- [x] 7. spec-update CLIエントリポイント実装
  - File: src/cli/spec-update.ts
  - メインフロー: キュービルド → タスク取得 → 実行 → ログ記録
  - サブコマンド: --run, --status, --setup
  - ロックファイルによる排他制御
  - Purpose: cronから呼び出されるエントリポイント
  - _Leverage: 全Schedulerコンポーネント_
  - _Requirements: 5_
  - _Prompt: Implement the task for spec spec-auto-update, first run spec-workflow-guide to get the workflow guide then implement the task: Role: TypeScript Developer | Task: src/cli/spec-update.tsにwasurenagusa-spec-updateのCLIエントリポイントを実装する。process.argvで--run/--status/--setupを判定。--run: ChangeLoggerからエントリ取得 → TaskQueueでキュービルド → dequeue → PromptBuilder → Executor実行 → ログ記録。--status: キュー状態表示。--setup: launchd plist / crontab出力。ロックファイル（~/.wasurenagusa/scheduler/.lock）で排他制御。design.mdのComponent 6仕様に従う | Restrictions: ロックファイルは必須。全エラーをcatchしてクラッシュしない。ESM import(.js拡張子) | Success: --run, --status, --setupが各々動作する。tasks.mdで[-]にマークし、完了後に[x]にマークしlog-implementationを実行する_

- [x] 8. package.json更新とビルド確認
  - File: package.json
  - binフィールドにwasurenagusa-spec-updateを追加
  - tscビルドが通ることを確認
  - Purpose: CLIバイナリとして実行可能にする
  - _Leverage: package.json（既存パターン）_
  - _Requirements: 5_
  - _Prompt: Implement the task for spec spec-auto-update, first run spec-workflow-guide to get the workflow guide then implement the task: Role: TypeScript Developer | Task: package.jsonのbinフィールドに "wasurenagusa-spec-update": "./dist/cli/spec-update.js" を追加する。npm run buildを実行してtscビルドが通ることを確認する。ビルドエラーがあれば修正する | Restrictions: 既存のbin定義は変更しない。追加のみ | Success: npm run buildが成功し、dist/cli/spec-update.jsが生成される。tasks.mdで[-]にマークし、完了後に[x]にマークしlog-implementationを実行する_

- [x] 9. 結合テスト
  - File: src/scheduler/integration.test.ts
  - ChangeLogger → TaskQueue → PromptBuilder → Executor の一連フローをテスト
  - Executorはモック（実際のclaude CLIは呼ばない）
  - Purpose: コンポーネント間の結合を検証
  - _Leverage: 全Schedulerコンポーネント、vitest_
  - _Requirements: 1-6_
  - _Prompt: Implement the task for spec spec-auto-update, first run spec-workflow-guide to get the workflow guide then implement the task: Role: QA Engineer | Task: src/scheduler/integration.test.tsに結合テストを作成する。テストシナリオ: (1) 変更ログ記録 → キュービルド → タスク取得 → プロンプト生成 → 実行の一連フロー、(2) 変更ログなし → ローテーションタスク生成、(3) タスクなし → ping実行、(4) ロックファイル排他制御。Executorはvi.mockでモックする | Restrictions: 実際のclaude CLIは絶対に呼ばない。ファイルシステムはtmpディレクトリを使用。テスト後にクリーンアップ | Success: 全結合テストがパスする。vitest runで確認。tasks.mdで[-]にマークし、完了後に[x]にマークしlog-implementationを実行する_
