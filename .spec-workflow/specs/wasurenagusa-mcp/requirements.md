# Requirements Document: wasurenagusa-mcp

## Introduction

wasurenagusa-mcpは、Claude Codeのコンテキスト問題を解決する**自律動作型**MCPサーバーである。

**核心理念: ユーザーは何もしなくていい**

Hooks連携による完全自動化で、会話中の重要情報を自動保存し、セッション開始時に自動注入する。手動操作は完全にオプション。

### 解決する課題
- 毎回同じミスをする（API URL間違い、ポート間違い等）
- 決定事項を忘れる
- ユーザーの怒りを学習しない
- コンテキスト膨張によるパフォーマンス劣化

## Alignment with Product Vision

[product.md](../../steering/product.md) に記載の通り：

1. **自律自動が基本、手動はオプション** → Hooks連携で完全自動化
2. **コンテキストを圧迫しない軽量設計** → 段階的開示アーキテクチャ
3. **ローカル完結** → STDIOトランスポート、Markdownストレージ
4. **AI自身の失敗も学習** → リトライパターン検出

## Requirements

### REQ-1: SessionStart Hookによるコンテキスト自動注入

**User Story:** Claude Codeユーザーとして、セッション開始時にプロジェクトのconfig/dontが自動で注入されてほしい。毎回手動で呼び出すのは面倒だから。

#### Acceptance Criteria

1. WHEN SessionStart Hookが発火 THEN wasurenagusa-context CLIが実行される SHALL
2. WHEN wasurenagusa-contextが実行 THEN 標準入力からHook入力（JSON）を読み取る SHALL
3. WHEN Hook入力にcwdフィールドがある THEN そのcwdからプロジェクトルートを探索する SHALL
4. WHEN プロジェクトルートが特定 THEN `.wasurenagusa/config.md`と`.wasurenagusa/dont.md`を読み込む SHALL
5. WHEN グローバル設定が存在 THEN `~/.wasurenagusa/global/config.md`と`~/.wasurenagusa/global/dont.md`も読み込む SHALL
6. WHEN 読み込み完了 THEN 整形されたMarkdownを標準出力に出力する SHALL
7. IF config.mdまたはdont.mdが存在しない THEN エラーなくスキップする SHALL

### REQ-2: Stop Hookによる会話自動分析・保存

**User Story:** Claude Codeユーザーとして、会話が終わるたびに重要情報が自動保存されてほしい。手動で保存なんてしない、めんどくさいから。

#### Acceptance Criteria

1. WHEN Stop Hookが発火 THEN wasurenagusa-analyze CLIが実行される SHALL
2. WHEN wasurenagusa-analyzeが実行 THEN 標準入力からHook入力（JSON）を読み取る SHALL
3. WHEN Hook入力にtranscript_pathがある THEN そのファイルから会話履歴を読み込む SHALL
4. WHEN 会話履歴がある THEN Gemini APIに分析を依頼する SHALL
5. WHEN Geminiが「保存すべき情報あり」と判定 THEN 適切なカテゴリに自動保存する SHALL
6. IF Geminiが「保存不要」と判定 THEN 何もせずに終了する SHALL
7. IF GEMINI_API_KEY未設定 THEN エラーなくスキップする SHALL
8. IF stop_hook_active が true THEN 何もせずに終了する SHALL（無限ループ防止）

### REQ-3: Geminiによる会話分析・カテゴリ判定

**User Story:** システムとして、会話内容からユーザーの怒り、決定事項、設定情報、AIのリトライパターンを自動検出したい。

#### Acceptance Criteria

1. WHEN 会話がGeminiに送信 THEN 以下のトリガーを検出する SHALL：
   - ユーザーの怒り（「なんで」「何度言えば」「さっき言った」等）
   - 明示的指示（「覚えておいて」「これ忘れないで」等）
   - 設定情報（ポート、URL、環境変数等）
   - 決定事項（技術選定、命名規則等）
   - AIリトライ（同じAPIを3回以上実行、同じエラー3回以上）
2. WHEN トリガー検出 THEN 適切なカテゴリ（config/dont/decision/log/snippet）を判定する SHALL
3. WHEN カテゴリ判定完了 THEN JSON形式でレスポンスを返す SHALL
4. IF トリガー未検出 THEN `shouldSave: false`を返す SHALL

### REQ-4: memory_get_context ツール（AI自律呼び出し）

**User Story:** AIアシスタントとして、必要な時にプロジェクトのコンテキストを取得したい。

#### Acceptance Criteria

1. WHEN memory_get_contextが呼び出し THEN config + dontを返す SHALL
2. WHEN プロジェクトルート特定 THEN プロジェクト固有 + グローバルの両方を読み込む SHALL
3. WHEN 読み込み完了 THEN 整形されたMarkdown形式で返す SHALL

### REQ-5: memory_save ツール（手動・オプション）

**User Story:** ユーザーとして、明示的に何かを保存したい時だけ手動で保存できるようにしたい。

#### Acceptance Criteria

1. WHEN memory_saveが呼び出し AND categoryが指定 THEN 該当カテゴリファイルに追記する SHALL
2. WHEN categoryがconfig/dont/decision/snippet THEN 対応する.mdファイルに保存する SHALL
3. WHEN categoryがlog THEN `logs/YYYY-MM-DD.md`に保存する SHALL
4. WHEN 保存成功 THEN 保存先パスとエントリIDを返す SHALL
5. IF contentが空 THEN エラーを返す SHALL

### REQ-6: memory_search ツール（AI自律呼び出し・軽量）

**User Story:** AIアシスタントとして、軽量なインデックスで記憶を検索したい。フル内容でトークンを浪費したくない。

#### Acceptance Criteria

1. WHEN memory_searchが呼び出し THEN 全カテゴリを検索する SHALL
2. WHEN クエリにマッチ THEN タイトル + タグ + ID のみを返す SHALL（フル内容は返さない）
3. WHEN 結果がある THEN 50-80 tokens/件程度で返す SHALL
4. IF マッチなし THEN 空配列を返す SHALL

### REQ-7: memory_get_detail ツール（AI自律呼び出し・フル詳細）

**User Story:** AIアシスタントとして、必要なエントリのフル詳細を取得したい。

#### Acceptance Criteria

1. WHEN memory_get_detailがIDで呼び出し THEN 該当エントリのフル内容を返す SHALL
2. WHEN 複数IDが指定 THEN 複数エントリを一括取得する SHALL
3. IF IDが存在しない THEN エラーを含むレスポンスを返す SHALL

### REQ-8: プロジェクトルート探索

**User Story:** システムとして、任意のサブディレクトリから実行されてもプロジェクトルートを特定したい。

#### Acceptance Criteria

1. WHEN findProjectRootが呼び出し THEN .gitディレクトリを上位探索する SHALL
2. WHEN .gitが見つかる THEN その親ディレクトリをプロジェクトルートとする SHALL
3. IF .gitが見つからない THEN 引数のcwdまたはprocess.cwd()をフォールバックとする SHALL

### REQ-9: Markdownストレージ

**User Story:** システムとして、人間が読みやすくgit管理可能な形式で記憶を保存したい。

#### Acceptance Criteria

1. WHEN エントリを保存 THEN Markdownフォーマットで保存する SHALL
2. WHEN ファイルを読み込み THEN エントリをパースしてMemoryEntry型で返す SHALL
3. WHEN 保存先ディレクトリが存在しない THEN 自動作成する SHALL
4. WHEN UTF-8以外の文字がある THEN UTF-8に変換して保存する SHALL

### REQ-10: グローバル記憶

**User Story:** ユーザーとして、全プロジェクト共通のルールを一箇所で管理したい。

#### Acceptance Criteria

1. WHEN グローバル設定を保存 THEN `~/.wasurenagusa/global/`に保存する SHALL
2. WHEN memory_get_contextが呼び出し THEN プロジェクト固有 + グローバルの両方を返す SHALL
3. WHEN 同じキーが両方に存在 THEN プロジェクト固有を優先する SHALL

## Non-Functional Requirements

### Code Architecture and Modularity

- **Single Responsibility Principle**: 各ファイルは1つの責務（ツール、ストレージ、分析等）
- **Modular Design**: CLI / Tools / Storage / Analyzer の4層構成
- **Dependency Management**: 上位から下位への一方向依存
- **Clear Interfaces**: MCP Tool定義とハンドラーの分離

### Performance

| 指標 | 要件 |
|------|------|
| memory_search応答時間 | < 100ms（ファイル数100以下） |
| memory_get_context応答時間 | < 50ms |
| Gemini判定応答時間 | < 2s |
| トークン消費量（検索） | 50-80 tokens/件 |
| トークン消費量（詳細） | 300-500 tokens/件 |

### Security

- Gemini APIキーは環境変数経由（.envファイル）
- 機密情報（パスワード、APIキー値）は保存しない
- ローカル実行のみ、ネットワーク露出なし
- `.wasurenagusa/`は.gitignore推奨

### Reliability

- ファイル不在時のエラーハンドリング（スキップ）
- Gemini API障害時のフォールバック（手動保存は常に利用可能）
- 不正なMarkdownのパースエラーハンドリング

### Usability

- npm installだけで動作
- claude mcp addで簡単登録
- Hooks設定は初回のみ（以降は自動）
- 手動操作なしで記憶が蓄積
