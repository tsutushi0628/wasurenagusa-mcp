# Requirements Document: Spec Auto-Update

## Introduction

Wasurenagusa MCPに「Spec自動更新」機能を追加する。日中の開発作業で蓄積されるコードとドキュメントの乖離を、Claude Code CLIのヘッドレスモード（`claude -p`）を活用して自動的に解消する。5時間レート制限ウィンドウの空き時間（主に深夜帯）を有効活用し、開発者が寝ている間にSpecドキュメントを最新化する。

## Alignment with Product Vision

[product.md](../../steering/product.md)の核心理念「**ユーザーは何もしなくていい**」を拡張する機能。

既存のWasurenagusaが「AIの会話記憶」を自動化しているのと同様に、本機能は「ドキュメント保守」を自動化する。どちらも「開発者が面倒くさがることを自律的に処理する」というプロダクトビジョンに合致する。

Product Principleの「自律自動が基本、手動はオプション」「Hooks連携で完全自動化」を、cron/systemd timerによるバッチ実行に拡張する。

## Requirements

### Requirement 1: 変更ログ記録

**User Story:** As a 開発者, I want セッション終了時に変更されたファイルが自動記録される, so that 後でどのSpecを更新すべきか判断できる

#### Acceptance Criteria

1. WHEN wasurenagusa-analyze（Stop Hook）が実行される THEN システム SHALL `git diff HEAD --name-only` でコミット済み＋ステージング済み＋未ステージングの全変更ファイル名を取得し、`~/.wasurenagusa/scheduler/change-log.json` に追記する
2. IF .gitディレクトリが存在しない THEN システム SHALL 変更ログ記録をスキップしエラーなく終了する
3. WHEN 変更ログに記録する THEN システム SHALL タイムスタンプ（ISO 8601 JST）、プロジェクト名、プロジェクト絶対パス、変更ファイル名一覧（プロジェクトルートからの相対パス）、Specドキュメントパスを含める
4. WHEN 変更ファイルがゼロ件（読み取り専用セッション） THEN システム SHALL 変更ログへの記録をスキップする
5. WHEN `git diff HEAD --name-only` が失敗する（初回コミット前等） THEN システム SHALL フォールバックとして `git status --porcelain` から変更ファイル名を抽出する

### Requirement 2: タスクキュー管理

**User Story:** As a スケジューラ, I want 更新タスクを優先度付きで管理できる, so that 限られたサイクルで最も重要なタスクから処理できる

#### Acceptance Criteria

1. WHEN 変更ログにエントリが存在する THEN システム SHALL 変更ベースタスクを生成しキューに追加する（優先度: 高）
2. WHEN 変更ログが空 AND Specドキュメントの最終更新日が閾値（デフォルト7日）を超えたプロジェクトがある THEN システム SHALL ローテーションタスクを最終更新が古い順に生成しキューに追加する（優先度: 低）
3. WHEN タスクを実行する THEN システム SHALL キューから優先度が最も高いタスクを1つだけ取り出して実行する
4. WHEN タスクが正常完了 THEN システム SHALL タスクを完了済みとしてマークし、変更ベースの場合は対応する変更ログエントリを消費済みにする
5. WHEN タスクが失敗 THEN システム SHALL タスクを失敗としてマークし、失敗理由を実行ログに記録する

### Requirement 3: Claude Code CLI実行

**User Story:** As a スケジューラ, I want Claude Code CLIをヘッドレスモードで呼び出してSpecを更新できる, so that 人間の介入なしにドキュメントが更新される

#### Acceptance Criteria

1. WHEN 変更ベースタスクを実行する THEN システム SHALL プロジェクトパスの変更ファイル情報とSpecパスを含むプロンプトを組み立て、`claude -p --max-turns 50 --allowedTools "Edit,Write,Read,Glob,Grep"` で実行する
2. WHEN ローテーションタスクを実行する THEN システム SHALL プロジェクトパスとSpecパスを含むローテーション用プロンプトを組み立て、`claude -p --max-turns 50 --allowedTools "Edit,Write,Read,Glob,Grep"` で実行する
3. WHEN Claude Code CLIの実行が完了 THEN システム SHALL 終了コード、stdout、stderr、実行時間を `~/.wasurenagusa/scheduler/logs/YYYY-MM-DD.json` に記録する
4. IF `claude` コマンドがPATHに存在しない THEN システム SHALL エラーメッセージを標準エラー出力に表示して終了コード1で終了する（クラッシュしない）
5. WHEN プロンプトを組み立てる THEN システム SHALL `prompts/spec-update.txt` および `prompts/spec-rotation.txt` からテンプレートを読み込む
6. WHEN Claude Code CLI実行中に `--max-turns` に到達した THEN システム SHALL タスクを部分完了としてマークし、次サイクルで継続しない（新規タスクとして再生成される）

### Requirement 4: Keep-Alive

**User Story:** As a 開発者, I want タスクがない場合でも5時間ウィンドウが回転する, so that 翌朝の作業開始時にリセット直後の状態になる

#### Acceptance Criteria

1. WHEN タスクキューが空 AND ローテーション対象もない THEN システム SHALL `claude -p "ping"` を実行してウィンドウを回転させる
2. WHEN ping実行 THEN システム SHALL 実行日時を実行ログに記録する

### Requirement 5: スケジューラCLIエントリポイント

**User Story:** As a 開発者, I want `wasurenagusa-spec-update` コマンドを実行するだけでSpec更新が走る, so that cron/systemd timerから簡単に呼び出せる

#### Acceptance Criteria

1. WHEN `wasurenagusa-spec-update` を実行する THEN システム SHALL ロックファイル（`~/.wasurenagusa/scheduler/.lock`）の取得を試み、成功した場合のみタスクキューを確認し、タスクがあれば実行、なければKeep-Aliveを実行する
2. IF ロックファイルが既に存在する（別プロセスが実行中） THEN システム SHALL 「別プロセスが実行中」のメッセージを出力して終了コード0で終了する
3. WHEN 実行完了（正常・異常問わず） THEN システム SHALL ロックファイルを削除し、実行結果サマリを標準出力に表示する
4. WHEN 実行が完了 THEN システム SHALL 実行ログを `~/.wasurenagusa/scheduler/logs/YYYY-MM-DD.json` に記録する
5. IF 設定ファイルが存在しない THEN システム SHALL デフォルト設定（ローテーション閾値7日、タスクタイムアウト10分、pingタイムアウト30秒）で動作する

### Requirement 6: プロジェクト設定

**User Story:** As a 開発者, I want プロジェクトごとにSpecパスを設定できる, so that 異なるプロジェクト構成に対応できる

#### Acceptance Criteria

1. WHEN プロジェクトを登録する THEN システム SHALL プロジェクト名、パス、Specドキュメントパスを `~/.wasurenagusa/scheduler/config.json` に保存する
2. IF Specパスが未設定のプロジェクト THEN システム SHALL `.spec-workflow/steering/` をデフォルトパスとして使用する
3. WHEN 変更ログにまだ登録されていないプロジェクトの変更が記録される THEN システム SHALL 自動的にプロジェクトを登録する

## Assumptions

1. **Keep-Aliveの前提**: `claude -p "ping"` の実行により5時間ウィンドウが開始（リセット）される。この動作はClaude Code CLIの現在の仕様に基づく。仕様変更時はKeep-Alive機構の見直しが必要
2. **Weekly Limit**: 5時間ウィンドウの回転とは別にweekly上限が存在する。本機能はweekly上限の範囲内で動作し、上限超過時はClaude CLIが非ゼロ終了コードを返すことを期待する
3. **Claude Code CLI**: `claude` コマンドがユーザーのPATHに存在し、認証済み（Pro/Max plan）であること
4. **git管理**: 対象プロジェクトがgitリポジトリであること（変更検出の前提）
5. **spec-workflow形式**: 対象プロジェクトが `.spec-workflow/` ディレクトリ構造を持つこと（Specパスのデフォルト値の前提）

## Scope Boundaries

本バージョンのスコープ:
- 変更ログ記録（Stop Hook統合）
- タスクキュー（変更ベース + ローテーション + ping）
- Claude Code CLI実行（ヘッドレス）
- 基本的なCLI（--run, --status, --setup）

将来スコープ（本バージョンでは実装しない）:
- プロジェクトの手動追加/削除CLI（`--add-project`, `--remove-project`）
- Spec更新以外のタスクタイプ（セキュリティ監査、コードレビュー等）
- マルチプロジェクト並行実行
- Web UI / Dashboard

## Non-Functional Requirements

### Code Architecture and Modularity
- **Single Responsibility Principle**: 変更ログ記録、タスクキュー管理、CLI実行、プロンプト組み立ては各々独立したモジュール
- **Modular Design**: `src/scheduler/` ディレクトリに新規モジュールを配置。既存コードへの影響を最小化
- **Dependency Management**: 既存の `config.ts`, `utils/projectRoot.ts`, `analyzer/prompt-loader.ts` を再利用
- **Clear Interfaces**: 各モジュールはTypeScriptインターフェースで契約を定義

### Performance
- 変更ログ記録（Stop Hook追加分）: < 500ms（git diff + JSON書き込み）
- タスクキュー操作: < 100ms（JSONファイル読み書き）
- CLI呼び出しタイムアウト: 10分（Spec更新タスク）、30秒（ping）

### Security
- 変更ログ・タスクキュー・実行ログはローカルファイル（`~/.wasurenagusa/scheduler/`）に保存
- Claude Code CLIの認証はユーザーの既存セッションに依存
- 機密情報（APIキー等）はログに記録しない

### Reliability
- Claude Code CLI実行失敗時はクラッシュせず、エラーログを記録して次サイクルに持ち越し
- 変更ログJSONが壊れた場合はバックアップから復元、または空の状態から再開
- 同時実行防止: ロックファイル（`~/.wasurenagusa/scheduler/.lock`）で排他制御

### Usability
- `wasurenagusa-spec-update --setup` でcron/launchd設定の対話的セットアップ
- `wasurenagusa-spec-update --status` で現在のキュー状態・最終実行結果を表示
- `wasurenagusa-spec-update --run` で即座に1タスク実行（手動トリガー）
