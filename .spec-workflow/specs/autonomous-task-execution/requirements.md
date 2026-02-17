# Requirements: Autonomous Task Execution System

## Introduction

wasurenagusa-mcpを拡張し、Claude Codeが24/365で自律的にタスクを処理し続ける仕組みを構築する。人間（しんたろう）はWHY/WHATだけ書き、HOW（設計・実装・評価）はAIが自律的に完結する。

既存のScheduler基盤（TaskQueue, Executor, PromptBuilder, ChangeLogger）を拡張し、「Spec自動更新」から「汎用的な自律タスク実行」へ進化させる。

## Alignment with Product Vision

wasurenagusaの本質は「AIが自律的にうまく動くための基盤」。
- 既存: 記憶管理（過去の失敗を繰り返さない）、コンテキスト注入（毎回ゼロから始めない）
- 追加: タスク管理（何をやるべきか知っている）、評価（やったことが正しいか判断できる）、人間アクションリスト（自分で判断できないことを仕分けられる）

すべて「AIの自律性を高める」という同一スコープ内であり、記憶・タスク・評価を同じコンテキストで管理する方が自然。product.mdのFuture Visionに記載された「タスクタイプ拡張」の実現。

## Requirements

### Req-1: 人間タスク投入

**User Story:** 開発者として、WHY/WHAT/DONE/PROJECTの4項目だけ書いてタスクを投入したい。HOWの設計・実装はAIに任せたい。

#### Acceptance Criteria

1. WHEN 人間がタスクを投入する THEN システム SHALL WHY（なぜやるか）、WHAT（どんな体験/行動変容を与えたいか）、DONE（完了条件）、PROJECT（対象プロジェクト）の4フィールドを受け付ける
2. WHEN タスクが投入される THEN システム SHALL タスクにUUIDを付与し、status=pendingでキューに追加する
3. WHEN タスクが投入される THEN システム SHALL 優先度を付与する（人間投入タスク: priority=0、change-based: priority=1、rotation: priority=2）
4. IF 同一PROJECTに同一WHATのpendingタスクが既に存在する THEN システム SHALL 重複として追加を拒否し、既存タスクIDを返却する

### Req-2: Gemini命令文生成

**User Story:** 開発者として、タスクのWHY/WHAT/DONEから自動的にClaude Code向けの具体的指示文が生成されてほしい。

#### Acceptance Criteria

1. WHEN pendingタスクが実行される THEN システム SHALL Geminiを使ってWHY/WHAT/DONEとプロジェクトメタ情報から、Claude Code向けの具体的な命令文を生成する
2. WHEN 命令文を生成する THEN システム SHALL プロジェクトのメタ情報（フェーズ、品質方針、判断基準）をコンテキストとして含める
3. WHEN 命令文を生成する THEN システム SHALL Agent Teamsの起動指示（PdM/architect/tech-lead/QA等のチーム構成）を命令文に含める
4. WHEN 命令文を生成する THEN システム SHALL プロジェクトのCLAUDE.mdとCLAUDE.local.mdの遵守指示を含める

### Req-3: 評価者エージェント

**User Story:** 開発者として、タスクの実行結果をAIが自動的にDone条件に照らして評価し、OK/NG/人間エスカレーションを判断してほしい。

#### Acceptance Criteria

1. WHEN タスク実行が完了する THEN システム SHALL Geminiを使ってDone条件に照らした機械的評価を行い、OK/NG/human-requiredを判定する
2. WHEN 評価がNG THEN システム SHALL 差し戻し理由を付けてタスクをpendingに戻し、retryCountをインクリメントする
3. IF retryCountが3に達した THEN システム SHALL タスクをhuman-requiredステータスに変更し、人間アクションリストに追加する
4. WHEN 評価がOK THEN システム SHALL タスクをcompletedに変更する
5. WHEN 評価者が「事業判断が必要」「顧客ヒアリングが必要」「経営判断が絡む」と判断する THEN システム SHALL タスクをhuman-requiredに変更する
6. WHEN 評価を行う THEN システム SHALL プロジェクトのメタ情報（フェーズ、品質方針）に照らした品質基準で評価する

### Req-4: プロジェクトイニシャライズ

**User Story:** 開発者として、新しいプロジェクトを登録する際に、選択式の対話でプロジェクトの判断基準・品質方針・エスカレーション基準を設定したい。

#### Acceptance Criteria

1. WHEN 新しいプロジェクトを登録する THEN システム SHALL 選択式ヒアリング（プロダクト理解・品質基準・判断基準・エスカレーション基準）を実行する
2. WHEN ヒアリングを行う THEN システム SHALL 各質問に2-4個の選択肢を提供する（自由記述ではなく選択式で人間の負荷を最小化）
3. WHEN ヒアリングが完了する THEN システム SHALL 結果をプロジェクトメタ情報として永続化する
4. WHEN 評価者が「OK」判定したが人間が「NG」と判断したケース THEN システム SHALL 判断基準をアップデートする（PDCA）
5. WHEN 評価者が「人間判断要」にしたが人間が「勝手にやって」と判断したケース THEN システム SHALL エスカレーション基準を緩和する（PDCA）

### Req-5: 内部スケジューラー

**User Story:** 開発者として、タスクを投入したら自動的に処理が始まり、24/365で待機してタスクがあれば即処理してほしい。

#### Acceptance Criteria

1. WHEN スケジューラーが起動する THEN システム SHALL 定期的にタスクキューをチェックし、pendingタスクがあればClaude Codeセッションを起動する
2. WHEN タスクキューが空 THEN システム SHALL 既存のchange-based/rotationタスクの確認を行い、なければKeep-Aliveのpingを送信する
3. WHEN Claude Codeセッションを起動する THEN システム SHALL 対象プロジェクトのディレクトリでclaude -pを実行し、生成した命令文を渡す
4. WHEN タスクが完了する THEN システム SHALL 評価者エージェントを呼び出し、結果を評価する
5. WHEN 評価完了後 THEN システム SHALL 次のpendingタスクの処理に移る（連続実行）
6. IF Claude CLIの実行がタイムアウトする THEN システム SHALL タスクをfailedにし、エラー理由を記録する

### Req-6: 人間アクションリスト

**User Story:** 開発者として、AIが「ここは人間じゃないと無理」と仕分けたタスクの一覧を確認し、朝起きてこのリストだけ見ればOKな状態にしたい。

#### Acceptance Criteria

1. WHEN タスクがhuman-requiredになる THEN システム SHALL 人間アクションリストに追加し、理由（評価者の判断理由 or 3回差し戻し）を記録する
2. WHEN 人間アクションリストを取得する THEN システム SHALL プロジェクト別にグルーピングされたリストを返却する
3. WHEN 人間がアクションリストのタスクに対応する THEN システム SHALL タスクをpendingに戻す（再実行）、completedにする（手動完了）、またはcancelledにする（取り消し）の選択肢を提供する

### Req-7: MCPツール拡張

**User Story:** 開発者として、Claude Code上でタスクの投入・確認・人間アクションリスト確認をMCPツール経由で行いたい。

#### Acceptance Criteria

1. WHEN AIまたは人間がtask_submitツールを呼び出す THEN システム SHALL WHY/WHAT/DONE/PROJECTを受け付けてタスクを登録する
2. WHEN AIまたは人間がtask_statusツールを呼び出す THEN システム SHALL 全タスクの状態サマリ（pending/in-progress/completed/failed/human-required件数）を返却する
3. WHEN AIまたは人間がtask_action_listツールを呼び出す THEN システム SHALL 人間アクションリストを返却する
4. WHEN AIまたは人間がproject_initツールを呼び出す THEN システム SHALL プロジェクトイニシャライズフローを開始する

### Req-8: タスク実行順序と永続化

**User Story:** 開発者として、タスクが予測可能な順序で処理され、データが安全に永続化されてほしい。

#### Acceptance Criteria

1. WHEN 複数のpendingタスクがある THEN システム SHALL priority昇順（0→1→2）、同一priorityならcreatedAt昇順（古い順）で実行する
2. WHEN タスクデータを永続化する THEN システム SHALL 自律タスクは`autonomous-tasks.json`に、既存Spec更新タスクは`queue.json`に分離して保存する
3. WHEN プロジェクトメタ情報を永続化する THEN システム SHALL `~/.wasurenagusa/scheduler/projects/{project-name}/meta.json`に保存する
4. WHEN タスクがcancelledになる THEN システム SHALL ステータスをcancelledに変更し、以降の処理対象から除外する

### Req-9: Claude CLI出力の評価連携

**User Story:** 開発者として、Claude CLIの実行結果が確実に評価者に渡され、構造化されていなくても適切に評価されてほしい。

#### Acceptance Criteria

1. WHEN Claude CLIが実行完了する THEN システム SHALL stdout全文（上限50,000文字）を評価者に渡す
2. WHEN Claude CLIがexitCode=0で完了する THEN システム SHALL 評価者に判定を委任する（exitCode=0でもNG判定あり得る）
3. WHEN Claude CLIがexitCode!=0で完了する THEN システム SHALL タスクをfailedにし、stderrをエラー理由として記録する
4. WHEN 命令文を生成する THEN システム SHALL 「作業完了時に実施内容のサマリを最後に出力せよ」の指示を含める

### Req-10: 既存機能との共存

**User Story:** 開発者として、新しい自律タスク実行機能が既存のメモリ管理・Spec自動更新機能と干渉しないでほしい。

#### Acceptance Criteria

1. WHEN 自律タスクが実行される THEN システム SHALL 既存のmemory_save/search/get_detail/delete/get_contextツールに影響を与えない
2. WHEN スケジューラーがタスクを選択する THEN システム SHALL 自律タスクキューと既存Spec更新キューの両方を確認し、優先度で統合的に処理する
3. WHEN SessionStart/Stop Hookが実行される THEN システム SHALL 既存のwasurenagusa-context/wasurenagusa-analyzeの動作を維持する

## Non-Functional Requirements

### Code Architecture and Modularity
- **新規`src/autonomous/`ディレクトリ**: 既存`src/scheduler/`は変更せず、自律タスク機能は独立ディレクトリに配置。ExecutorとloadPromptのみ既存モジュールを再利用
- **Single Responsibility**: 評価者(evaluator.ts)、命令文生成(command-generator.ts)、イニシャライズ(initializer.ts)、スケジューラー(scheduler.ts)は独立ファイル
- **プロンプト外部化**: 評価・命令文生成のプロンプトは`prompts/`ディレクトリに配置（既存パターンに従う）
- **型安全**: 新しい型定義はすべて`src/types.ts`に追加

### Performance
- タスク投入（task_submit）: < 100ms
- 命令文生成（Gemini）: < 5s
- 評価者判定（Gemini）: < 5s
- スケジューラーチェック間隔: 設定可能（デフォルト5分）
- Claude CLI実行タイムアウト: 設定可能（デフォルト30分、人間投入タスクは長め）

### Security
- プロジェクトメタ情報にAPIキー等の機密情報を含めない
- Gemini APIキーは既存の環境変数（GEMINI_API_KEY）を使用
- Claude CLI実行時の環境変数は既存のbuildCleanEnv()を使用

### Reliability
- スケジューラーのクラッシュリカバリ: in-progressタスクは次回起動時にfailedに変更
- 排他制御: 既存の.lockファイル機構を使用（複数スケジューラーの同時起動を防止）
- 差し戻し上限: 3回（human-requiredにエスカレーション）

### Usability
- MCPツールの説明文は日本語で、使い方が直感的に分かること
- プロジェクトイニシャライズは選択式で、人間の負荷を最小化
- 人間アクションリストは朝一で見て即理解できるフォーマット
