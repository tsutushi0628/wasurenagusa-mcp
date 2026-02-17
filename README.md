# wasurenagusa-mcp

**wasurenagusa**（忘れな草） — 「私を忘れないで」という花言葉を持つ花。

**Claude Code に記憶を与える MCP サーバー。同じミスは、もう繰り返さない。**

> 「ポートは3000って言ったよね？」「さっき決めたでしょ？」
>
> Claude Code との会話で、同じことを何度も説明した経験はありませんか。
> wasurenagusa は、AI アシスタントに「記憶」を与える MCP サーバーです。
> 設定情報、やってはいけないこと、過去の決定事項を自動で記録・自動で注入。
> あなたは普段通りに会話するだけ。裏側で LLM が会話を分析し、重要な情報を蓄積していきます。

---

## wasurenagusa が解決する3つの「忘れる」

### 1. プロジェクトの知識

Claude Code はセッションが変わるたびに、すべてを忘れる。
API の URL、ポート番号、「ログを読んでから質問して」というルール、先週決めたアーキテクチャ。

wasurenagusa は **Hooks 連携で完全自動化** されている。
セッション開始時に設定とルールが自動注入され、会話終了時に重要な情報が自動保存される。
ユーザーが手動で何かする必要は、一切ない。

### 2. ドキュメントの最新化

コードは毎日変わるのに、Spec ドキュメントは書いた日のまま放置される。
wasurenagusa は夜間にコード変更を検知し、ドキュメントを自動で更新する。

### 3. トークン枠を使い切り

Claude Code の 5 時間レート制限。寝ている間の枠は、普通なら無駄になる。
wasurenagusa のスケジューラは、アイドル時間を使ってドキュメント保守タスクを自動実行する。

---

## 仕組み

```
[セッション開始]
    │  SessionStart Hook
    ▼
wasurenagusa-context 実行
  → config + dont を自動注入（設定・ルール・過去のミス）
    │
    ▼
[会話中] ─── AIが必要に応じて memory_search → memory_get_detail を自律呼び出し
    │
    ▼
[Claude 応答完了]
    │  Stop Hook
    ▼
wasurenagusa-analyze 実行
  → Gemini で会話を自動分析
  → 重要情報を自動保存（怒り検知・リトライパターン検出含む）
  → 変更ファイルをログに記録（Spec 自動更新用）
```

**ユーザーの操作: ゼロ。**

---

## 他のメモリ MCP との違い

| | wasurenagusa | 一般的なメモリ MCP |
|---|---|---|
| 保存方式 | Gemini が会話を自動分析・自動保存 | ユーザーが手動で保存指示 |
| 注入方式 | SessionStart Hook で自動注入 | 毎回手動で読み込み指示 |
| トークン効率 | 段階的開示で 70-90% 削減 | 全件フル返却でコンテキスト圧迫 |
| 感情検知 | 怒り・悲しみ・諦めを自動検出 | なし |
| AI 自己学習 | リトライパターンを自動検出・記録 | なし |
| dont 統合 | 数十件 → 数個の原則に自動圧縮 | エントリが増え続けてノイズ化 |

---

## 主要機能

### 自動記憶（Hooks 連携）

- **SessionStart Hook**: セッション開始時に config（設定）と dont（やってはいけないこと）を自動注入
- **Stop Hook**: 会話終了時に Gemini で分析し、重要情報を自動保存

### 感情検知

ユーザーの怒り・悲しみ・失望・諦めを検知し、「❌何をした → 💡なぜダメか → ✅どうすべきか」の 3 点セットで記録。
テキストパターンだけでなく、メッセージ長の急減少やポジティブ反応の長期不在といったメタ情報でも検出する。

### AI リトライパターン検出

同じ API を 3 回以上実行、同じエラーが 3 回以上発生 ── AI 自身の失敗パターンも自動で学習し、「正しいやり方」を記録する。

### 段階的開示（トークン最適化）

検索結果はインデックス（ID・タイトル・タグ）のみ返し、必要な項目だけフル取得する 2 段階設計。
従来の全件返却と比較して **トークン消費を 70-90% 削減**。

### 重複検出

Gemini ベースのセマンティック重複検出。同じテーマの新しい情報は既存エントリを自動で置換する。

### dont 統合

dont エントリが増えすぎた場合、Gemini で 5-6 個の行動原則に自動統合。
元エントリは保持したまま、コンテキスト注入サイズを 36KB → 3-4KB に圧縮する。

### Spec 自動更新（スケジューラ）

夜間の 5 時間ウィンドウで、変更されたコードに対応する Spec ドキュメントを自動更新。
タスクがない場合は keep-alive ping でレート制限枠をリセットする。

### Owner Profile

MCP サーバー初回起動時に `.wasurenagusa/owner-profile.md` が自動生成される。
優先順位、設計方針、コミュニケーションスタイルなど 20 の質問に答えておくと、AI が自律タスク実行時にその基準で判断する。

---

## セットアップ

### 前提条件

- Node.js 18+
- Claude Code（CLI）
- Gemini API キー（[Google AI Studio](https://aistudio.google.com/) で取得）

### 1. クローンとビルド

```bash
git clone git@github.com:tsutushi0628/wasurenagusa-mcp.git
cd wasurenagusa-mcp
npm install
npm run build
```

### 2. CLI コマンドを PATH に通す

```bash
npm link
```

これで `wasurenagusa-context`、`wasurenagusa-analyze`、`wasurenagusa-spec-update` がグローバルに使えるようになる。

### 3. 環境変数の設定

```bash
cp .env.example .env
```

`.env` を編集:

```
GEMINI_API_KEY=your_gemini_api_key_here
MEMORY_DIR=.wasurenagusa
SLACK_WEBHOOK_URL=                    # オプション: Slack通知を有効にする場合
```

| 変数 | 必須 | 説明 |
|------|------|------|
| `GEMINI_API_KEY` | 必須 | Gemini API キー |
| `MEMORY_DIR` | 任意 | メモリ保存先ディレクトリ（デフォルト: `.wasurenagusa`） |
| `SLACK_WEBHOOK_URL` | 任意 | 自律タスクの完了/失敗を Slack に通知 |

### 4. Claude Code に MCP サーバーを登録

```bash
claude mcp add wasurenagusa -- node /path/to/wasurenagusa-mcp/dist/index.js
```

### 5. Hooks の設定

`~/.claude/settings.local.json`（または プロジェクトの `.claude/settings.local.json`）に以下を追加:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "wasurenagusa-context",
            "timeout": 5
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "wasurenagusa-analyze",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

### 6. 動作確認

Claude Code を起動する。初回は `.wasurenagusa/` ディレクトリが自動作成され、`owner-profile.md` のテンプレートが配置される。

```
.wasurenagusa/
├── owner-profile.md    ← 初回自動生成。編集するとAIの自律判断に反映
├── config.md           ← 会話から自動蓄積
├── dont.md             ← 会話から自動蓄積
├── decisions.md        ← 会話から自動蓄積
├── snippets.md         ← 会話から自動蓄積
└── logs/               ← 日付別ログ
```

最初の会話を終えると、Stop Hook が起動して Gemini が会話を分析し、重要情報が自動保存される。
2 回目以降のセッションでは、蓄積された情報が SessionStart Hook で自動注入される。

### 7. （オプション）プロジェクト初期設定

自律タスク機能（Spec 自動更新など）を使う場合は、Claude Code 上で `project_init` ツールを実行する。
プロジェクトの品質基準・フェーズ・判断基準を選択式で登録できる。

### 8. （オプション）Spec 自動更新スケジューラ

夜間にドキュメントを自動更新するには、cron や launchd で `wasurenagusa-spec-update` を定期実行する。

```bash
# 例: 毎日深夜1時に実行（cron）
0 1 * * * cd /path/to/your-project && wasurenagusa-spec-update
```

---

## メモリカテゴリ

| カテゴリ | 説明 | 保存先 |
|---------|------|--------|
| **config** | API URL、ポート番号、認証情報の場所 | `.wasurenagusa/config.md` |
| **dont** | やってはいけないこと、過去のミス | `.wasurenagusa/dont.md` |
| **decision** | 技術選定、アーキテクチャ決定 | `.wasurenagusa/decisions.md` |
| **log** | 実装完了、エラー解決の記録 | `.wasurenagusa/logs/YYYY-MM-DD.md` |
| **snippet** | よく使うコマンド、クエリ | `.wasurenagusa/snippets.md` |

---

## MCP ツール

| ツール名 | 実行方式 | 説明 |
|---------|---------|------|
| `memory_get_context` | AI 自律 | config + dont を一括取得 |
| `memory_search` | AI 自律 | 軽量インデックス検索（ID・タイトル・タグのみ） |
| `memory_get_detail` | AI 自律 | 指定 ID のフル詳細を取得 |
| `memory_save` | 手動（オプション） | 明示的な記憶保存 |
| `memory_delete` | 手動 | エントリ削除（ID 指定、複数一括可） |
| `task_submit` | AI 自律 | 自律タスクの投入 |
| `task_status` | AI 自律 | タスク状態の確認 |
| `task_action_list` | AI 自律 | 実行可能アクション一覧 |
| `project_init` | 手動 | プロジェクト初期設定 |

---

## CLI コマンド

| コマンド | 用途 | 呼び出し元 |
|---------|------|-----------|
| `wasurenagusa-context` | config + dont をstdoutに出力 | SessionStart Hook |
| `wasurenagusa-analyze` | 会話を Gemini 分析し自動保存 | Stop Hook |
| `wasurenagusa-spec-update` | Spec ドキュメント自動更新 | cron / systemd timer |

---

## 技術スタック

| 技術 | 用途 |
|------|------|
| TypeScript | 実装言語 |
| MCP SDK (`@modelcontextprotocol/sdk`) | MCP プロトコル |
| Gemini API (`@google/generative-ai`) | 会話分析・重複検出・dont統合 |
| Markdown | ストレージ形式 |
| STDIO | トランスポート |

---

## ディレクトリ構成

```
wasurenagusa-mcp/
├── src/
│   ├── index.ts              # MCP サーバーエントリポイント
│   ├── config.ts             # 設定管理
│   ├── types.ts              # 型定義
│   ├── cli/
│   │   ├── context.ts        # SessionStart Hook 用 CLI
│   │   ├── analyze.ts        # Stop Hook 用 CLI
│   │   └── spec-update.ts    # Spec 自動更新 CLI
│   ├── tools/                # MCP ツール定義
│   ├── storage/              # Markdown ストレージ
│   ├── analyzer/             # Gemini 連携・会話分析
│   ├── autonomous/           # 自律タスク実行
│   ├── consolidator/         # dont 統合
│   ├── scheduler/            # Spec 更新スケジューラ
│   ├── notifier/             # Slack 通知
│   └── utils/                # ユーティリティ
├── prompts/                  # Gemini プロンプト（外部化）
├── docs/
│   └── spec.md               # 完全実装仕様書
├── .env.example
├── package.json
└── tsconfig.json
```

---

## 開発

```bash
# ビルド
npm run build

# テスト
npm test

# テスト（ウォッチモード）
npm run test:watch
```

---

## 設計思想

- **自律自動が基本、手動はオプション** — ユーザーに手動操作を強いない。Hooks で完全自動化
- **コンテキストを圧迫しない軽量設計** — 段階的開示で必要な情報だけ取得
- **プロンプト外部化** — `prompts/` に Gemini プロンプトをテキストファイルとして配置。デプロイなしで改善可能
- **ローカル実行** — セットアップ簡単。外部サービスは Gemini API のみ

---

## ライセンス

MIT
