# Technology Stack

## Related Documents

- **[docs/spec.md](../../docs/spec.md)** - 完全実装仕様書（技術詳細・コード例含む）
- **[product.md](./product.md)** - プロダクト概要

## Project Type

MCPサーバー（Model Context Protocol Server）- Claude Codeの機能を拡張するローカル実行型CLIツール

## Core Technologies

### Primary Language(s)
- **Language**: TypeScript 5.x
- **Runtime**: Node.js 20.x（ES2022ターゲット）
- **Module System**: ESM（NodeNext）

### Key Dependencies/Libraries

| ライブラリ | バージョン | 用途 |
|-----------|-----------|------|
| **@modelcontextprotocol/sdk** | ^1.0.0 | MCPサーバー実装の基盤 |
| **@google/generative-ai** | ^0.21.0 | Gemini API呼び出し（自動判定） |
| **dotenv** | ^16.4.0 | 環境変数管理 |

### Application Architecture

**自律動作型 STDIO-based MCP Server Architecture**

```
┌────────────────────────────────────────────────────────────────┐
│                      Claude Code                               │
│  ┌──────────────────┐  ┌────────────────────────────────────┐  │
│  │    Hooks Engine  │  │         MCP Client                 │  │
│  │  - SessionStart  │  │                                    │  │
│  │  - Stop          │  │                                    │  │
│  └────────┬─────────┘  └──────────────┬─────────────────────┘  │
└───────────┼───────────────────────────┼────────────────────────┘
            │ type: "command"           │ STDIO
            ▼                           ▼
┌────────────────────────────────────────────────────────────────┐
│                    wasurenagusa-mcp                            │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │   CLI Scripts（Hooks用）                                │   │
│  │  【自動】wasurenagusa-context ← SessionStart Hook       │   │
│  │  【自動】wasurenagusa-analyze ← Stop Hook               │   │
│  ├─────────────────────────────────────────────────────────┤   │
│  │   MCP Tool Handlers（9ツール）                            │   │
│  │  【AI自律】memory_get_context← コンテキスト取得          │   │
│  │  【手動】memory_save       ← オプション                  │   │
│  │  【AI自律】memory_search   ← AIが必要時に呼び出し        │   │
│  │  【AI自律】memory_get_detail← AIが必要時に呼び出し       │   │
│  │  【手動】memory_delete     ← エントリ削除                │   │
│  │  【手動】task_submit       ← 自律タスク投入              │   │
│  │  【手動】task_status       ← タスク状態確認              │   │
│  │  【手動】task_action_list  ← 人間アクションリスト        │   │
│  │  【手動】project_init      ← プロジェクト初期設定        │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              │                                 │
│  ┌───────────────────────────▼─────────────────────────────┐   │
│  │   Storage Layer (Markdown Files)                        │   │
│  │   .wasurenagusa/ (シンボリックリンク集約)                │   │
│  └───────────────────────────┬─────────────────────────────┘   │
│                              │                                 │
│  ┌───────────────────────────▼─────────────────────────────┐   │
│  │   Analyzer (Gemini API)                                 │   │
│  │   会話分析・カテゴリ判定・リトライ検出                    │   │
│  └─────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────┘
```

**自律動作フロー**:
```
[セッション開始]
    ↓ SessionStart Hook（type: "command"）
wasurenagusa-context → config全文 + dont（統合版） + オーナープロフィール + 能動検索指示を標準出力 → コンテキスト注入
    ↓
[会話中: AIが「あ、この話はbackendだな」と判断]
    ↓ AIが自律的にMCPツール呼び出し
memory_search(project="yakusoku", scope="backend") → memory_get_detail(id)
    ↓
[Claude応答完了]
    ↓ Stop Hook（type: "command"）
wasurenagusa-analyze → transcript.jsonl分析 → Gemini判定 → project/scope自動付与で保存
                     → git diffでファイル名取得 → 変更ログに記録
```

**Spec自動更新フロー**:
```
[5時間5分サイクル] cron/systemd timer
    ↓
wasurenagusa-spec-update
    ↓
タスクキュー確認
    ├─ 変更ログありのプロジェクト → claude -p "Spec更新プロンプト"
    ├─ 変更ログなし＆古いSpecあり → claude -p "ローテーション更新プロンプト"
    └─ やることなし → claude -p "ping"
    ↓
実行ログ記録 → タスク完了マーク
```

**レイヤー構成**:
1. **Hooks Layer**: Claude Code Hooksによる自動実行トリガー
2. **Transport Layer**: STDIO（標準入出力）でMCPプロトコル通信
3. **Tool Layer**: MCPツール定義とハンドラー
4. **Storage Layer**: Markdownファイルの読み書き
5. **Analyzer Layer**: Gemini APIによる自動判定・リトライ検出
6. **Consolidator Layer**: dontエントリのGemini統合（多数のdont→少数の行動原則に集約）
7. **Scheduler Layer**: cron/systemd timerによるバッチ実行（Spec自動更新・Keep-Alive）
8. **Autonomous Layer**: 自律タスク実行（タスクストア、命令文生成、評価者、プロジェクト初期設定、Slack通知）

### Data Storage

- **Primary storage**: Markdownファイル（`.wasurenagusa/` ディレクトリ）
- **Caching**: なし（ファイル直接読み込み）
- **Data formats**: Markdown（構造化メタデータ付き）

**ストレージ構造**:
```
共通管理リポジトリ（例: firebase-kit）
└── .wasurenagusa/              # 実体はここに1つだけ
    ├── config.md               # 設定情報（全プロジェクト集約）
    ├── dont.md                 # やってはいけないこと（全プロジェクト集約）
    ├── consolidated-dont.json  # dont統合キャッシュ（Geminiで原則化した結果）
    ├── decisions.md            # 決定事項（全プロジェクト集約）
    ├── snippets.md             # よく使うコマンド・クエリ（全プロジェクト集約）
    ├── owner-profile.md        # オーナープロフィール（自律タスクの文脈に使用）
    └── logs/
        └── YYYY-MM-DD.md      # 日付別ログ

各プロジェクト/
└── .wasurenagusa -> ../firebase-kit/.wasurenagusa  # シンボリックリンク
```

各エントリには `project` と `scope` フィールドが付与され、どのプロジェクトのどの領域の知識かを識別できる。
フィルタリングにより「このプロジェクトのバックエンドの知識」等を動的に取得可能。

### External Integrations

| 統合先 | プロトコル | 認証方式 | 用途 |
|--------|-----------|---------|------|
| **Claude Code** | MCP over STDIO | なし（ローカル） | ツール呼び出し |
| **Claude Code Hooks** | SessionStart/Stop (type: "command") | なし（ローカル） | 自律動作トリガー |
| **Claude Code CLI** | `claude -p` (ヘッドレス) | なし（ローカル） | Spec自動更新・自律タスク実行・Keep-Alive |
| **Google Gemini API** | HTTPS/REST | API Key | 会話分析・自動判定・リトライ検出 |
| **OS Scheduler** | cron (Linux) / launchd (macOS) | なし | 5h5mサイクル実行 |
| **Slack Webhook** | HTTPS POST | Webhook URL | サイクルサマリー/人間エスカレーション/リトライ上限到達/デイリーサマリーの通知 |

## Development Environment

### Build & Development Tools

- **Build System**: TypeScript Compiler (`tsc`)
- **Package Management**: npm
- **Development workflow**: `ts-node --esm` for development, `tsc` for production build

### Code Quality Tools

- **Static Analysis**: TypeScript strict mode
- **Formatting**: Prettier（推奨）
- **Testing Framework**: Vitest ^4.0.18
- **Documentation**: README.md + inline JSDoc

### Version Control & Collaboration

- **VCS**: Git
- **Branching Strategy**: trunk-based（main直接）
- **Code Review Process**: なし（個人プロジェクト）

## Deployment & Distribution

- **Target Platform(s)**: ローカル（macOS, Linux, Windows with Node.js）
- **Distribution Method**: npm install（ローカル）または claude mcp add
- **Installation Requirements**: Node.js 20.x, npm, Gemini API Key
- **Update Mechanism**: git pull + npm install + npm run build

**Claude Code登録コマンド**:
```bash
claude mcp add wasurenagusa node /path/to/wasurenagusa-mcp/dist/index.js
```

## Technical Requirements & Constraints

### Performance Requirements

| 指標 | 目標値 | 備考 |
|------|--------|------|
| **memory_search応答時間** | < 100ms | ファイル数100以下想定 |
| **memory_get_context応答時間** | < 50ms | 2ファイル読み込み |
| **Gemini判定応答時間** | < 2s | 非同期実行で体感影響なし |
| **トークン消費量（検索）** | 50-80 tokens/件 | インデックスのみ返却 |
| **トークン消費量（詳細）** | 300-500 tokens/件 | フル内容 |
| **変更ログ記録（Stop Hook追加分）** | < 500ms | git diff + JSON書き込み |
| **タスクキュー操作** | < 100ms | JSONファイル読み書き |
| **Spec更新タスクタイムアウト** | 600,000ms (10分) | Claude CLI実行の上限 |
| **自律タスクタイムアウト** | 1,800,000ms (30分) | 人間投入タスクは長め |
| **タスク投入（task_submit）** | < 100ms | JSONファイル書き込み |
| **命令文生成（Gemini）** | < 5s | Gemini API呼び出し |
| **評価者判定（Gemini）** | < 5s | Gemini API呼び出し |
| **pingタイムアウト** | 30,000ms (30秒) | Keep-Alive最小リクエスト |

### Compatibility Requirements

- **Platform Support**: macOS, Linux, Windows（Node.js動作環境）
- **Node.js Version**: 20.x 以上
- **MCP SDK Version**: 1.0.0 以上

### Security & Compliance

- **Security Requirements**:
  - Gemini APIキーは環境変数経由（.envファイル）
  - 機密情報（パスワード、APIキー値）は保存しない
  - ローカル実行のみ、ネットワーク露出なし（Slack Webhook通知はオプション、アウトバウンドのみ）
- **Compliance Standards**: なし（個人ツール）
- **Threat Model**:
  - `.wasurenagusa/` に機密情報が含まれる可能性 → .gitignore推奨

### Scalability & Reliability

- **Expected Load**: 1ユーザー、1プロジェクトあたり数百エントリ
- **Availability Requirements**: なし（ローカルツール）
- **Growth Projections**: 将来的にSQLite移行で数千エントリ対応可能

## Technical Decisions & Rationale

### Decision Log

1. **自律動作を基本設計として採用**
   - **理由**: ユーザーに手動操作を強いると使われなくなる。面倒くさいから。
   - **実装**: Hooks連携（SessionStart/Stop）でCLIスクリプトを自動実行
   - **トレードオフ**: Hooks設定が必要（初回のみ）

2. **Hooks連携アーキテクチャ**
   - **理由**: Claude Code Hooksを活用して完全自動化を実現
   - **SessionStart**: wasurenagusa-context実行 → config/dont自動注入
   - **Stop**: wasurenagusa-analyze実行 → 会話分析・自動保存
   - **注意**: Hooksは `type: "command"` でシェルコマンドを実行。MCPツール直接呼び出しは不可
   - **トレードオフ**: Hooksが使えない環境では手動操作が必要

3. **Markdownストレージ採用**
   - **理由**: 人間が読みやすい、git管理可能、セットアップ不要
   - **代替案**: SQLite、JSON
   - **トレードオフ**: 検索性能は劣るが、数百件なら十分

4. **STDIO Transport採用**
   - **理由**: ローカル実行でセットアップ最小、セキュリティリスク低
   - **代替案**: HTTP Transport
   - **トレードオフ**: リモートアクセス不可（将来拡張可能）

5. **「必要な時に思い出す」アーキテクチャ**
   - **理由**: コンテキストウィンドウの効率的活用
   - **実装**: SessionStart時はconfig全文+dont（統合版）+オーナープロフィールを注入。AIが必要に応じてmemory_search → memory_get_detailで動的取得
   - **トレードオフ**: AIが適切に検索する判断力が必要（ただしdont/configは事前注入で安全）

6. **Gemini API採用（会話分析）**
   - **理由**: 高速（gemini-3-flash-preview）、コスト効率、日本語対応
   - **代替案**: OpenAI、ローカルLLM、ルールベース
   - **トレードオフ**: 外部API依存

7. **プロジェクトルート探索（.git基準）**
   - **理由**: Claude Codeがサブディレクトリから実行される場合に対応
   - **フォールバック**: .gitが見つからない場合はprocess.cwd()を使用

8. **シンボリックリンク集約 + project/scopeフィールド**
   - **理由**: 複数プロジェクトの知識を1箇所に集約し、横断的な知識活用を実現
   - **実装**: 共通リポジトリに`.wasurenagusa/`実体を配置。各プロジェクトからシンボリックリンク。各エントリにproject/scopeを自動付与
   - **旧方式**: `~/.wasurenagusa/global/` は廃止

9. **AIリトライ検出**
   - **理由**: ユーザーの怒りだけでなく、AI自身の失敗パターンも学習
   - **実装**: Gemini判定プロンプトにリトライパターン検出を組み込み

10. **プロンプト外部化**
    - **理由**: プロンプト改善の度にTypeScriptリビルド＋デプロイが必要だった
    - **実装**: `prompts/`ディレクトリにテキストファイルとして管理。`prompt-loader.ts`で実行時に読み込み
    - **効果**: プロンプト変更のみならデプロイ不要

11. **Geminiベース重複検出**
    - **理由**: 同じテーマのdontエントリが複数蓄積するとコンテキスト汚染になる
    - **実装**: 保存前に同カテゴリの既存エントリとGeminiでセマンティック比較。重複発見時は`replaceId`で既存エントリを置換
    - **トレードオフ**: Gemini APIコール2回になる（分析+重複チェック）

12. **会話メタ情報による諦め検知**
    - **理由**: テキストパターンマッチだけでは「沈黙の諦め」を検知できない
    - **実装**: `conversation-meta.ts`でメッセージ長の平均・現在値・ポジティブ反応経過ターンを計算し、Geminiに数値として渡す
    - **判定ルール**: currentLength < avgLength * 0.5 → 諦めシグナル候補

13. **変更ログはファイル名のみ記録**
    - **理由**: diffの中身はClaude Code CLIが実行時に読めばいい。ログは軽量に
    - **実装**: Stop Hook（wasurenagusa-analyze）でgit diffの`--name-only`相当を取得し、JSONファイルに追記
    - **トレードオフ**: サマリがないため、Claude CLIが毎回ファイルを読む必要がある

14. **並列数制限付き全タスク実行（キュー方式）**
    - **理由**: 1サイクル1タスクではタスク消化が遅い。並列数を制限すれば安全に複数タスクを処理できる
    - **実装**: 自律タスク全件 + Spec更新タスク全件をdequeueし、`maxConcurrentTasks`（デフォルト3）で並列数を制限して実行。タスクなしの場合のみping
    - **代替案**: 1サイクル1タスク（旧方式）→ タスク消化が遅い（1日最大4-5タスク）で却下
    - **トレードオフ**: 並列実行時のトークン消費量が増える。ただし`maxConcurrentTasks`で制御可能

15. **Keep-Aliveはpingのみ**
    - **理由**: タスクがない時に無理に仕事を作る必要はない。ウィンドウ回転が目的
    - **実装**: `claude -p "ping"` で最小限のリクエスト送信
    - **根拠**: Anthropic公式ドキュメントがリセットタイミングの計画的活用を示唆

16. **変更ログ記録をStop Hookに相乗り**
    - **理由**: 新しいMCPツールを追加するより、既存のwasurenagusa-analyzeに統合する方がシンプル
    - **実装**: analyze CLI内でgit diff取得 → 変更ログJSONに追記
    - **トレードオフ**: analyze CLIの責務が増える

## Known Limitations

| 制限事項 | 影響 | 対応策 |
|----------|------|--------|
| **Hooks設定が必要** | 自動化にはHooks設定が必要 | 初回設定のみ。設定なしでも手動利用可 |
| **Markdown検索の性能** | 数千件で遅延の可能性 | 将来SQLite移行 |
| ~~**重複検出なし**~~ | ~~同じ内容が複数保存される~~ | v0.3.0でGeminiベース重複検出を実装済み |
| **ローカル実行のみ** | チーム共有が困難 | 将来HTTP Transport |
| **.gitがないプロジェクト** | プロジェクトルート検出不可 | process.cwd()フォールバック |
| **Gemini API依存** | APIキーなし/オフライン時は自動分析不可 | 手動保存(memory_save)は常に利用可能 |
| **Claude Code CLI必須** | Spec自動更新にはclaude CLIがPATHに必要 | CLI未設定時はスケジューラを無効化 |
| **Weekly Limit** | 5hウィンドウは回せてもweekly上限あり | 実タスク優先、ping最小化で対応 |
| **OS Scheduler設定** | cron/launchdの初期設定が必要 | セットアップスクリプト提供 |
