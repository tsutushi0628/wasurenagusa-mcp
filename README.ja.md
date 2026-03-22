# wasurenagusa-mcp

**wasurenagusa**（忘れな草） — 「私を忘れないで」という花言葉を持つ花。

**Claude Code に記憶を与える MCP サーバー。同じミスは、もう繰り返さない。**

> 「ポートは3000って言ったよね？」「さっき決めたでしょ？」
>
> Claude Code との会話で、同じことを何度も説明した経験はありませんか。
> wasurenagusa は、AI アシスタントに「記憶」を与える MCP サーバーです。
> 設定情報、やってはいけないこと、過去の決定事項を自動で記録・自動で注入。
> あなたは普段通りに会話するだけ。裏側で LLM が会話を分析し、重要な情報を蓄積していきます。

wasurenagusa はただ記憶するだけでなく、**学習する**。

1. **ミスを自動検出** — リトライパターン、ユーザーのフラストレーション、繰り返しの失敗を捕捉
2. **教訓を原則に蒸留** — LLM が数百件の生エントリを少数の実行可能なルールに圧縮
3. **否定形を肯定形に変換** — 各原則に `positiveRule` を生成。「〜するな」を「〜する」に変換。LLM は否定形指示より肯定形指示の遵守率が高いことが研究で示されている（[Pink Elephant 問題](https://arxiv.org/abs/2404.15154)）
4. **設定をテーマ別に圧縮** — LLM が散在する設定を一貫したサマリーにグループ化（ポート・パス等の事実は保持）
5. **必要なものだけ注入** — 統合された知見 + アクティブな設定のみ。テンプレートの肥大化も重複もなし
6. **ベクトル検索による意味記憶** — Gemini embedding で短期/中期/長期の記憶層を横断する意味ベース検索。頻繁にアクセスされる記憶は自動的に最高強度に昇格

**Claude Code Hooks で完全自動化 — セットアップ後の設定はゼロ。**

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
wasurenagusa のスケジューラは、アイドル時間を使って自律タスクを自動実行する。
Spec ドキュメントの更新、リファクタリング、テスト追加 ── `task_submit` で投入したタスクを Claude が 24/365 で処理し、LLM が完了条件を評価してリトライまでやる。

---

## 仕組み

```
[セッション開始]
    │  SessionStart Hook
    ▼
wasurenagusa-context 実行
  → 統合データの鮮度チェック（dont + config）
  → 古ければバックグラウンドで LLM 圧縮ワーカーを起動（非ブロッキング）
  → Embedding バックフィルワーカーをバックグラウンド起動（非ブロッキング）
  → 統合済み config + 行動原則（层1）+ critical 永続エントリ（层2）+ 直近 30 日エントリ（层3）+ Owner Profile を注入
  → ベクトル検索で意味的に関連する短期記憶を注入（层4）
  → 他のアクティブプロジェクトからクロスプロジェクトベクトル検索で関連記憶を注入（层5）
  → カスタマイズ済みの設定のみ注入（デフォルト値は除外）
    │
    ▼
[会話中] ─── AIが必要に応じて memory_search → memory_get_detail を自律呼び出し
         ─── memory_save 時に Gemini で 768 次元ベクトルを自動生成
         ─── memory_search でキーワード + ベクトル意味検索を統合
         ─── アクセスカウント蓄積 → 閾値超過で critical 自動昇格
    │
    ▼
[Claude 応答完了]
    │  Stop Hook
    ▼
wasurenagusa-analyze 実行
  → LLM で会話を自動分析
  → ミス・フラストレーション・リトライパターンを検出
  → 学んだ教訓を自動保存
  → 保存前に既存エントリとの重複を排除
  → アクティブプロジェクトトラッカーを更新（直近5プロジェクト）
```

**ユーザーの操作: ゼロ。**

---

## 実績

作者が 8 つの本番プロジェクトで日常的に使用した結果（プロジェクト間の記憶共有あり）:

```
1,581 件の dont エントリ  →  プロジェクトあたり 5-9 原則  (LLM 統合)
  各原則に positiveRule   →  肯定形のみで注入             (Pink Elephant 対策)
29 件の config エントリ   →  4-5 テーマ別サマリー         (LLM 統合)
21,800 文字の生データ     →  6,200 文字の注入データ       (71% 削減)
```

---

## 他のメモリ MCP との違い

| | wasurenagusa | claude-mem | mcp-memory-service | CLAUDE.md |
|---|---|---|---|---|
| ミス自動検出 | あり（リトライ + 感情） | なし | なし | なし |
| LLM 自動統合 | あり（dont→原則, config→テーマ） | なし | あり（減衰ベース） | なし |
| ベクトル意味検索 | あり（Gemini embedding, 768次元） | なし | あり（ChromaDB） | なし |
| 記憶層（短期/中期/長期） | あり（コサイン距離閾値） | なし | なし | なし |
| critical 自動昇格 | あり（アクセス回数ベース） | なし | なし | なし |
| Hooks で完全自動化 | あり | あり | なし | なし |
| 人間が読める保存形式 | あり（Markdown + JSON ベクトル） | なし（SQLite） | なし（ChromaDB） | あり |
| マルチ LLM 対応 | Gemini / OpenAI / Anthropic | Claude のみ | ローカル埋め込み | N/A |
| トークン効率的な取得 | あり（index→detail, 70-90%削減） | あり（3層） | N/A | なし |
| クロスプロジェクト記憶 | あり（直近5プロジェクト） | なし | なし | なし |
| ライセンス | MIT | AGPL-3.0 | Apache-2.0 | N/A |

---

## 出力モード（Output Mode）

SessionStart Hook の出力形式をプロジェクトごとに切り替えられます。`.wasurenagusa/config.json` で設定します。

| モード | 説明 | 推奨環境 |
|--------|------|----------|
| **injection**（デフォルト） | 記憶の全文をセッション開始時に注入 | サブエージェント非対応環境（Cursor、Windsurf 等） |
| **agent** | タイトルインデックスのみ注入。詳細はサブエージェント経由で `memory_get_detail` を使って取得 | Claude Code + Agent Teams |

### 設定方法

プロジェクトの `.wasurenagusa/config.json` に `outputMode` を追加:

```json
{
  "outputMode": "agent"
}
```

ファイルが存在しない場合や `outputMode` が未設定の場合は `"injection"`（完全な後方互換性）。

### agent モード利用時の推奨 CLAUDE.md ルール

```markdown
- 記憶操作はサブエージェント経由で読み書きする（memory_search / memory_get_detail / memory_save）
- メインコンテキストに記憶の生データを持ち込まない
```

---

## 主要機能

### 自動記憶（Hooks 連携）

- **SessionStart Hook**: セッション開始時に config（設定）と dont（やってはいけないこと）を自動注入
- **Stop Hook**: 会話終了時に LLM で分析し、重要情報を自動保存

### 感情検知

ユーザーの怒り・悲しみ・失望・諦めを検知し、「❌何をした → 💡なぜダメか → ✅どうすべきか」の 3 点セットで記録。
テキストパターンだけでなく、メッセージ長の急減少やポジティブ反応の長期不在といったメタ情報でも検出する。

### AI リトライパターン検出

同じ API を 3 回以上実行、同じエラーが 3 回以上発生 ── AI 自身の失敗パターンも自動で学習し、「正しいやり方」を記録する。

### 段階的開示（トークン最適化）

検索結果はインデックス（ID・タイトル・タグ）のみ返し、必要な項目だけフル取得する 2 段階設計。
従来の全件返却と比較して **トークン消費を 70-90% 削減**。

### 重複検出

LLM ベースのセマンティック重複検出。同じテーマの新しい情報は既存エントリを自動で置換する。

### ベクトル記憶層（Vector Memory Tiers）

生物の記憶を模倣した、Gemini embedding による意味検索システム。すべての記憶が 768 次元ベクトルに変換され、キーワードでは見つからない「意味的に近い記憶」を呼び起こせる。

**コサイン距離による 3 層アーキテクチャ:**

| 記憶層 | 閾値 | 用途 |
|--------|------|------|
| **短期（short）** | ≤ 0.2 | 高関連 — セッション開始時に自動注入 |
| **中期（medium）** | ≤ 0.45 | 文脈関連 — `memory_search` 時に浮上 |
| **長期（long）** | ≤ 0.7 | 緩い関連 — 検索可能だが能動的には表示されない |

**自動昇格:** ベクトル検索でヒットするたびにアクセスカウントが +1。5 回を超えると自動的に `importance: "critical"` に昇格し、毎セッション永続注入される。長期に眠っていた記憶も、関連性によって「揺り起こされ」、繰り返しアクセスされることで critical に昇格する。

**仕組み:**

```
memory_save
  → テキスト → Gemini gemini-embedding-001 → 768次元ベクトル → vectors.json

memory_search "認証の設定"
  → キーワード検索（既存）              ─┐
  → クエリ埋め込み → コサイン距離検索    ─┤→ マージ・重複排除 → 結果
                                          └→ アクセスカウント++
                                             → 閾値超過で critical 昇格

SessionStart Hook
  → プロジェクト名を埋め込み → 短期層検索 → 関連記憶を注入
  → バックフィルワーカー起動（1回最大20件、非ブロッキング）
```

**依存追加ゼロ** — 既存の `@google/generative-ai` パッケージを使用。ベクトルは `vectors.json` にローカル保存（ブルートフォース検索、1,000 エントリで約 6MB）。外部 DB 不要。

**グレースフルデグラデーション** — `GEMINI_API_KEY` がなければ従来通りキーワード検索のみで動作。API キーを設定した瞬間からベクトル機能が自動的に有効になる。

### クロスプロジェクト記憶

wasurenagusa は直近で使用した上位 5 プロジェクトを自動追跡し、それらの記憶から関連コンテキストを横断検索する。

**仕組み:**

1. **Stop Hook** がセッションごとに `~/.wasurenagusa/scheduler/active-projects.json` を更新
2. **SessionStart** で他のアクティブプロジェクトのベクトルストアを検索（短期層 ≤ 0.2、高関連のみ）
3. **`memory_search`** で `project: "active"` を指定すると、全アクティブプロジェクトを横断検索（キーワード + ベクトル）

**例:** `project-a` で作業中、以前 `project-b` で認証について議論していた場合。`project-a` のセッション開始時にトピックが関連していれば、wasurenagusa が `project-b` の認証に関する記憶を自動的に浮上させる。

設定不要 — 2 つ以上のプロジェクトを使用した時点で自動的に機能する。

### LLM 統合（Consolidation）

メモリエントリが蓄積されると、LLM が自動的にコンパクトなサマリーに圧縮する:

- **dont エントリ** → 5-9 個の行動原則にスコアリング（`sourceCount × maxIntensity`）。各原則は `rule`（❌→💡→✅形式）と `positiveRule`（肯定形のみ）の両方を持つ。注入時は `positiveRule` を優先使用 — [Pink Elephant問題](https://arxiv.org/abs/2404.15154)の研究に基づく。
- **config エントリ** → 4-5 個のテーマ別サマリーに統合（例: 29 件 → 5 テーマ。ポート・パス・URL 等の事実情報は保持）

統合はセッション開始時にバックグラウンドで非同期実行され、遅延は発生しない。結果は JSON にキャッシュされ、次回セッションから利用される。ファイル更新日時とエントリ数で staleness を検出する。

元エントリは常に保持。統合版がセッション開始時に注入され、元データは `memory_search` で随時検索可能。

#### 肯定形変換（Positive Rule Conversion）

統合された各原則は2つの形式を保持する:

| フィールド | 形式 | 用途 |
|-----------|------|------|
| `rule` | ❌ 問題行動 → 💡 理由 → ✅ 正しい行動 | `memory_get_detail` での詳細確認 |
| `positiveRule` | 肯定形のみの行動指示（「〜する」「〜を使う」） | LLMコンテキストへの注入 |

**なぜ？** LLMのAttention機構は否定文中の概念も活性化してしまう — 「innerHTMLを使うな」は「innerHTML」を活性化する。肯定形指示（「textContentを使う」）は望ましい行動のみを活性化する。ユーザーの生のフィードバック（`dont.md`）はそのまま保持し、変換は統合レイヤーでのみ行う。

#### 記憶の強弱（importance）

dont エントリには強弱をつけられる:

| importance | 意味 | 統合 | 注入 |
|-----------|------|------|------|
| `critical` | 強い禁止・激怒・反復指摘など | **除外（永続保持）** | 毎回具体的に注入 |
| `normal` | 通常の学習記録 | 統合対象 | 統合原則として注入 |

`memory_save` で手動指定可能。自動保存時は LLM が感情強度と表現の強さから判定する。

### 自律タスク実行

`task_submit` でタスクを投入すると、スケジューラが Claude CLI をサブプロセスとして起動し自動実行する。
LLM が実行結果を完了条件と照合し、未達ならリトライする。Spec 更新、リファクタリング、テスト追加など汎用的に使える。

### Spec 自動更新（スケジューラ）

自律タスクの代表的なユースケース。夜間の 5 時間ウィンドウで、変更されたコードに対応する Spec ドキュメントを自動更新。
タスクがない場合は keep-alive ping でレート制限枠をリセットする。

### Owner Profile

MCP サーバー初回起動時に `.wasurenagusa/owner-profile.md` が自動生成される。
優先順位、設計方針、コミュニケーションスタイルなど 20 の質問に答えておくと、AI が自律タスク実行時にその基準で判断する。

実際にカスタマイズしたセクションのみが注入される。デフォルトのままの選択肢・空欄のテーブル行・テンプレート文は自動除外され、注入を最小限に保つ。

### 自動アーカイブ

各メモリカテゴリにはエントリ上限（デフォルト: 100）がある。超過すると古いエントリがアーカイブファイル（`*-archive.md`）に自動移動される。ログは別途 30 日ローテーション。データは削除されず、アクティブな検索パスから外れるだけ。

---

## セットアップ

### 前提条件

- Node.js 18+
- Claude Code（CLI）
- API キー: [Gemini](https://aistudio.google.com/) / [OpenAI](https://platform.openai.com/) / [Anthropic](https://console.anthropic.com/) のいずれか

### 1. インストール

```bash
npm install -g wasurenagusa-mcp
```

ソースからビルドする場合:

```bash
git clone https://github.com/tsutushi0628/wasurenagusa-mcp.git
cd wasurenagusa-mcp
npm install && npm run build
npm link
```

> `npm run build` で CLI エントリポイントに `chmod +x` が自動適用される。手動での権限設定は不要。

### 2. 環境変数の設定

`~/.wasurenagusa/.env` を作成:

```bash
# 以下のいずれか1つの API キーを設定
GEMINI_API_KEY=your-key-here
# OPENAI_API_KEY=your-key-here
# ANTHROPIC_API_KEY=your-key-here
```

| 変数 | 必須 | 説明 |
|------|------|------|
| `GEMINI_API_KEY` | 3つのうち1つ | Google Gemini API キー |
| `OPENAI_API_KEY` | 3つのうち1つ | OpenAI API キー |
| `ANTHROPIC_API_KEY` | 3つのうち1つ | Anthropic API キー |
| `LLM_PROVIDER` | 任意 | `gemini`（デフォルト）, `openai`, `anthropic` |
| `LLM_MODEL` | 任意 | プロバイダのデフォルトモデルを上書き |
| `MEMORY_DIR` | 任意 | メモリ保存先ディレクトリ（デフォルト: `.wasurenagusa`） |
| `MAX_ENTRIES_PER_CATEGORY` | 任意 | カテゴリ別エントリ上限（デフォルト: `100`） |
| `LOG_RETENTION_DAYS` | 任意 | ログ保持日数（デフォルト: `30`） |
| `SLACK_WEBHOOK_URL` | 任意 | 自律タスクの完了/失敗を Slack に通知 |

### 3. Claude Code に MCP サーバーを登録

```bash
claude mcp add wasurenagusa -- wasurenagusa-mcp
```

### 4. Hooks の設定

> **⚠️ 必須** — このステップを省略すると、メモリはセッション開始時に注入されない。セットアップで最も見落とされやすい手順。

`~/.claude/settings.json`（または hooks を別ファイルで管理したい場合は `settings.local.json`）に以下を追加:

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
    ],
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "wasurenagusa-context",
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

### 5. 動作確認

Claude Code を起動する。初回は `.wasurenagusa/` ディレクトリが自動作成され、`owner-profile.md` のテンプレートが配置される。

```
.wasurenagusa/
├── owner-profile.md    ← 初回自動生成。編集するとAIの自律判断に反映
├── config.md           ← 会話から自動蓄積
├── dont.md             ← 会話から自動蓄積
├── decisions.md        ← 会話から自動蓄積
├── snippets.md         ← 会話から自動蓄積
├── vectors.json        ← 768次元ベクトルインデックス（自動生成）
└── logs/               ← 日付別ログ
```

最初の会話を終えると、Stop Hook が起動して LLM が会話を分析し、重要情報が自動保存される。
2 回目以降のセッションでは、蓄積された情報が SessionStart Hook で自動注入される。

> **重要**: `.wasurenagusa/` にはプロジェクト固有の記憶データが保存される。あなたのプロジェクトの `.gitignore` に追加しておくこと。
>
> ```bash
> echo '.wasurenagusa/' >> .gitignore
> ```

### 6. （オプション）プロジェクト初期設定

自律タスク機能（Spec 自動更新など）を使う場合は、Claude Code 上で `project_init` ツールを実行する。
プロジェクトの品質基準・フェーズ・判断基準を選択式で登録できる。

### 7. （オプション）Spec 自動更新スケジューラ

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
| `memory_search` | AI 自律 | 軽量インデックス検索（ID・タイトル・タグのみ）。`project: "active"` でクロスプロジェクト検索 |
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
| `wasurenagusa-context` | config + dont + ベクトル関連記憶をstdoutに出力 | SessionStart Hook / PreCompact Hook |
| `wasurenagusa-analyze` | 会話を LLM 分析し自動保存 | Stop Hook |
| `wasurenagusa-backfill` | ベクトル未生成エントリの embedding を生成 | バックグラウンド（自動起動） |
| `wasurenagusa-rebuild` | 壊れたメモリデータの修復（重複排除・ログ再配置） | 手動 |
| `wasurenagusa-spec-update` | Spec ドキュメント自動更新 | cron / systemd timer |

---

## 現在の制限事項

- **Claude Code 専用** — Hook ベースの自動注入は Claude Code が必要。MCP サーバー自体は MCP 対応クライアントで動作するが、自動注入は行われない。

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
- **コンテキスト効率** — LLM 統合 + スマートフィルタリングで注入データ 71% 削減。2段階取得（index→detail）でオンデマンド消費もさらに削減
- **人間が読めるストレージ** — すべてのメモリは Markdown で保存。DB 不要、ベンダーロックインなし
- **プロンプト外部化** — `prompts/` に LLM プロンプトをテキストファイルとして配置。リビルドなしで改善可能

---

## ライセンス

MIT

---

[English README](./README.md)

---

## Support

[![Ko-fi](https://img.shields.io/badge/Ko--fi-support-FF5E5B?style=flat&logo=ko-fi)](https://ko-fi.com/tsutushi0628)
