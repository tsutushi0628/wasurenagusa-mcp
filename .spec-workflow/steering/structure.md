# Project Structure

## Related Documents

- **[docs/spec.md](../../docs/spec.md)** - 完全実装仕様書（技術詳細・コード例含む）
- **[product.md](./product.md)** - プロダクト概要
- **[tech.md](./tech.md)** - 技術スタック

## Directory Organization

```
wasurenagusa-mcp/
├── src/
│   ├── index.ts              # MCPサーバーエントリポイント
│   ├── types.ts              # 型定義
│   ├── config.ts             # 設定管理
│   ├── cli/
│   │   ├── context.ts        # wasurenagusa-context CLI【SessionStart/UserPromptSubmit/PreCompact Hook用】
│   │   ├── analyze.ts        # wasurenagusa-analyze CLI【Stop Hook用】
│   │   ├── spec-update.ts    # wasurenagusa-spec-update CLI【cron/systemd timer用】
│   │   ├── consolidate-worker.ts # dont統合バックグラウンドワーカー（context.tsからspawn）
│   │   ├── consolidate-all.ts   # wasurenagusa-consolidate-all CLI【全アクティブプロジェクトの統合実行】
│   │   ├── backfill-worker.ts   # wasurenagusa-backfill CLI【ベクトル埋め込みバックフィル】
│   │   ├── scheduler-setup.ts   # wasurenagusa-scheduler CLI【夜間統合スケジューラのinstall/uninstall】
│   │   ├── guard.ts             # wasurenagusa-guard CLI【Stop Hook用】intensity 5ルール強制チェック
│   │   ├── rebuild.ts           # wasurenagusa-rebuild CLI【メンテナンス用】メモリデータの修復・重複除去
│   │   └── transcript-reader.ts # トランスクリプトJSONLパーサー（テスト可能な独立モジュール）
│   ├── tools/
│   │   ├── index.ts          # ツール定義のエクスポート
│   │   ├── getContext.ts     # memory_get_context ツール【AI自律呼び出し】
│   │   ├── save.ts           # memory_save ツール【手動】オプション
│   │   ├── search.ts         # memory_search ツール【AI自律】軽量インデックス返却
│   │   ├── getDetail.ts      # memory_get_detail ツール【AI自律】フル詳細返却
│   │   ├── delete.ts         # memory_delete ツール【手動】エントリ削除
│   │   ├── taskSubmit.ts     # task_submit ツール【自律タスク投入】
│   │   ├── taskStatus.ts     # task_status ツール【自律タスク状態確認】
│   │   ├── taskActionList.ts # task_action_list ツール【人間アクションリスト】
│   │   ├── projectInit.ts    # project_init ツール【プロジェクト初期設定】
│   │   └── updateIntensity.ts # memory_update_intensity ツール【手動】重要度変更
│   ├── storage/
│   │   ├── index.ts          # ストレージインターフェース
│   │   ├── markdown.ts       # Markdown読み書き実装
│   │   ├── parser.ts         # Markdownパーサー（MemoryEntry配列に変換）
│   │   └── formatter.ts      # MemoryEntryのMarkdownフォーマッター
│   ├── analyzer/
│   │   ├── index.ts              # Gemini連携エクスポート
│   │   ├── gemini.ts             # LLM呼び出し・判定（genkit経由）
│   │   ├── prompt-loader.ts      # プロンプトファイル読み込み
│   │   └── conversation-meta.ts  # 会話メタ情報計算（諦め検知用）
│   ├── consolidator/
│   │   ├── index.ts              # 統合モジュールエクスポート
│   │   ├── dont-consolidator.ts  # dontエントリのLLM統合（原則化）
│   │   ├── config-consolidator.ts # configエントリのLLM統合（テーマ化）
│   │   ├── staleness.ts          # 統合キャッシュの鮮度チェック・読み書き
│   │   └── formatter.ts          # 統合結果のMarkdownフォーマッター
│   ├── scheduler/
│   │   ├── change-logger.ts      # 変更ログ記録（git diff → JSON）
│   │   ├── task-queue.ts         # タスクキュー管理（優先度付き）
│   │   ├── executor.ts           # Claude Code CLI呼び出し実行
│   │   └── prompt-builder.ts     # Spec更新プロンプト組み立て
│   ├── autonomous/
│   │   ├── constants.ts          # 自律タスクデフォルト設定（maxTurns, timeoutMs等）
│   │   ├── task-store.ts         # 自律タスクのCRUD・永続化
│   │   ├── command-generator.ts  # Gemini命令文生成
│   │   ├── evaluator.ts          # Gemini評価（OK/NG/human-required判定）
│   │   ├── project-initializer.ts # プロジェクト初期設定・メタ情報管理
│   │   ├── action-list.ts        # 人間アクションリスト管理
│   │   ├── notifier.ts           # Slack通知（サイクルサマリー/人間エスカレーション/リトライ上限到達/デイリーサマリー）
│   │   ├── project-scanner.ts    # ~/projects/配下のプロジェクト自動検出
│   │   └── task-markdown.ts      # tasks.mdパーサー＆ライター
│   ├── llm/
│   │   └── provider.ts           # マルチLLMプロバイダー（genkit経由、Gemini/OpenAI/Anthropic切替）
│   ├── vector/
│   │   ├── embedding-service.ts  # Gemini Embedding生成（768次元）
│   │   ├── vector-store.ts       # ベクトルデータストア（vectors.json、ブルートフォース検索）
│   │   ├── memory-tier.ts        # 記憶階層フィルタリング（短期≤0.2/中期≤0.45/長期≤0.7）
│   │   └── cosine-distance.ts    # コサイン距離計算
│   ├── active-projects.ts        # アクティブプロジェクト追跡（上位5プロジェクト）
│   └── utils/
│       ├── projectRoot.ts    # .git探索ロジック
│       ├── owner-profile.ts  # オーナープロフィール管理（自動配置・読み込み）
│       ├── zombie-reaper.ts  # ゾンビプロセス自動掃除（孤児化防止）+ 兄弟MCPプロセス巻き添え終了
│       ├── prompt-escape.ts  # プロンプトエスケープユーティリティ
│       ├── sanitize-error.ts # エラーサニタイズユーティリティ
│       └── validate-webhook-url.ts # Webhook URL検証
├── prompts/
│   ├── analysis.txt              # LLM分析プロンプト（外部化）
│   ├── duplicate-check.txt       # 重複チェックプロンプト（外部化）
│   ├── consolidate.txt           # dont統合プロンプト（外部化）
│   ├── consolidate-config.txt    # config統合プロンプト（外部化）
│   ├── spec-update.txt           # Spec更新プロンプトテンプレート
│   ├── spec-rotation.txt         # ローテーション更新プロンプトテンプレート
│   ├── task-command.txt          # 自律タスク命令文生成プロンプト
│   ├── task-evaluation.txt       # 自律タスク評価プロンプト
│   ├── project-initialize.txt    # プロジェクト初期設定プロンプト
│   └── owner-profile-template.md # オーナープロフィールテンプレート
├── dist/                     # ビルド出力
├── docs/
│   └── spec.md               # 完全実装仕様書
├── .spec-workflow/           # Spec Workflowドキュメント
│   ├── steering/
│   │   ├── product.md
│   │   ├── tech.md
│   │   └── structure.md
│   └── specs/
│       ├── wasurenagusa-mcp/        # コアMCP機能
│       ├── project-scope-memory/    # project/scope拡張
│       ├── spec-auto-update/        # Spec自動更新
│       ├── autonomous-task-execution/ # 自律タスク実行
│       ├── importance-memory/       # intensity（重要度）記憶
│       └── vector-memory-tier/      # ベクトル記憶階層
├── package.json
├── tsconfig.json
├── vitest.config.ts          # Vitestテスト設定
├── .env.example
├── .gitignore
└── README.md
```

### メモリ保存先構造（シンボリックリンク集約）

```
共通管理リポジトリ（例: firebase-kit）
└── .wasurenagusa/              # 実体はここに1つだけ
    ├── config.md               # 設定情報（全プロジェクト集約、projectフィールドで識別）
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

各エントリにはproject（プロジェクト名）とscope（frontend/backend/infra/design/spec/ai/general）が自動付与される。

### スケジューラデータ構造

```
~/.wasurenagusa/scheduler/
├── config.json           # プロジェクト一覧・スケジューラ設定
├── change-log.json       # 変更ログ（Stop Hookで記録）
├── queue.json            # タスクキュー（Spec更新用、優先度付き）
├── autonomous-tasks.json # 自律タスクキュー
├── action-list.json      # 人間アクションリスト
├── tasks.md              # タスク投入用Markdown（人間が編集）
├── last-session.json     # 最終セッション終了時刻（アイドル判定用）
├── .lock                 # 排他制御用ロックファイル
├── projects/
│   └── {project-name}/
│       └── meta.json     # プロジェクトメタ情報（フェーズ・品質方針等）
└── logs/
    └── YYYY-MM-DD.json   # 日別実行ログ
```

## Naming Conventions

### Files
- **ツール**: `camelCase.ts`（例: `getDetail.ts`, `getContext.ts`）
- **クラス/モジュール**: `camelCase.ts`（例: `markdown.ts`, `gemini.ts`）
- **型定義**: `types.ts`
- **設定**: `config.ts`
- **エントリポイント**: `index.ts`

### Code
- **クラス/インターフェース**: `PascalCase`（例: `MarkdownStorage`, `MemoryEntry`）
- **関数**: `camelCase`（例: `handleMemorySave`, `getMemoryPath`）
- **定数**: `UPPER_SNAKE_CASE`（例: `POSITIVE_PATTERNS`）
- **変数**: `camelCase`（例: `projectRoot`, `memoryPath`）
- **型エイリアス**: `PascalCase`（例: `MemoryCategory`, `SaveParams`）

### MCPツール名
- `snake_case`（MCP規約に従う）
- 例: `memory_save`, `memory_search`, `memory_get_detail`, `memory_get_context`, `memory_delete`, `memory_update_intensity`, `task_submit`, `task_status`, `task_action_list`, `project_init`

## Import Patterns

### Import Order
1. Node.js標準ライブラリ（`fs`, `path`, `crypto`等）
2. 外部依存（`@modelcontextprotocol/sdk`, `@google/generative-ai`等）
3. 内部モジュール（相対パス）

### 例
```typescript
// 1. Node.js標準
import { mkdir, readFile, writeFile } from "fs/promises";
import { join, resolve } from "path";

// 2. 外部依存
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { GoogleGenerativeAI } from "@google/generative-ai";

// 3. 内部モジュール
import { MemoryCategory, SaveParams } from "../types.js";
import { config } from "../config.js";
```

### ESM拡張子ルール
- インポート時は `.js` 拡張子を明示（TypeScript ESMの仕様）
- 例: `import { config } from "../config.js";`

## Code Structure Patterns

### モジュール構成
```
1. インポート
2. 定数・設定
3. 型定義（必要な場合）
4. クラス/関数実装
5. エクスポート
```

### ツールファイル構成（tools/*.ts）
```typescript
// 1. インポート
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { MarkdownStorage } from "../storage/index.js";

// 2. ツール定義（MCPスキーマ）
export const memorySearchTool: Tool = {
  name: "memory_search",
  description: `記憶を検索する（軽量インデックスのみ返却）。
詳細が必要な場合は memory_get_detail を使用。`,
  inputSchema: { ... }
};

// 3. ハンドラー関数
export async function handleMemorySearch(
  args: Record<string, unknown>,
  projectRoot: string
): Promise<string> {
  // 検索実行 → インデックスのみ返却
}
```

### CLIスクリプト構成（cli/*.ts）
```typescript
#!/usr/bin/env node
// 1. インポート
import { readFile } from "fs/promises";
import { Analyzer } from "../analyzer/index.js";
import { MarkdownStorage } from "../storage/index.js";
import { findProjectRoot } from "../utils/projectRoot.js";

// 2. メイン関数
async function main() {
  // Hooks からの入力を処理
  // 必要に応じてGemini分析、ストレージ保存
}

main().catch(console.error);
```

### ストレージクラス構成（storage/markdown.ts）
```typescript
// 1. インポート
import { parseMarkdown } from "./parser.js";
import { formatEntry, getFileHeader } from "./formatter.js";

// 2. クラス定義
export class MarkdownStorage {
  // プライベートフィールド
  private memoryPath: string;

  // コンストラクタ
  constructor(projectRoot: string) { ... }

  // パブリックメソッド（CRUD操作）
  async initialize(): Promise<void> { ... }
  async save(params: SaveParams): Promise<SaveResult> { ... }
  async search(params: SearchParams): Promise<SearchResult> { ... }
  async getDetail(params: GetDetailParams): Promise<GetDetailResult> { ... }
  async delete(params: DeleteParams): Promise<DeleteResult> { ... }
  async getContext(currentProject?: string): Promise<ContextResult> { ... }
  async readConfigEntries(currentProject?: string): Promise<MemoryEntry[]> { ... }
  async readDontEntries(currentProject?: string): Promise<MemoryEntry[]> { ... }
  async updateIntensity(id: string, intensity: number): Promise<{success, id, category}> { ... }
  deduplicateConfigEntries(entries: MemoryEntry[]): MemoryEntry[] { ... }

  // プライベートヘルパー
  private generateId(): string { ... }
  private async replaceEntry(category, targetId, newEntry): Promise<boolean> { ... }
  private async readFileIfExists(filePath): Promise<string> { ... }
  private async readCategory(category: MemoryCategory): Promise<MemoryEntry[]> { ... }
  private getFilePath(category: MemoryCategory, timestamp: string): string { ... }
}
```

`parseMarkdown`（Markdownパーサー）と`formatEntry`/`getFileHeader`（Markdownフォーマッター）は独立した関数として`parser.ts`・`formatter.ts`に分離されている。

## Code Organization Principles

1. **Single Responsibility**: 各ファイルは1つの明確な責務を持つ
   - `tools/save.ts` → memory_saveツールのみ
   - `storage/markdown.ts` → Markdownファイル操作のみ
   - `analyzer/gemini.ts` → Gemini API連携のみ

2. **レイヤー分離**: Transport → Tool → Storage → Analyzer
   - 上位レイヤーは下位レイヤーに依存
   - 下位レイヤーは上位レイヤーを知らない

3. **依存方向**:
   ```
   index.ts (MCPエントリ)        cli/spec-update.ts (Schedulerエントリ)
       ↓                              ↓
   tools/*.ts (ツール)           scheduler/*.ts (スケジューラ)
       ↓                              ↓
   storage/markdown.ts (ストレージ)  autonomous/*.ts (自律タスク)
       ↓                              ↓
   analyzer/gemini.ts (分析)          ↓
       ↓                              ↓
   types.ts, config.ts (共通) ←────────┘
   ```

## Module Boundaries

### CLIスクリプト（Hooks連携用）

**自動実行（type: "command" で呼び出し）**
- `wasurenagusa-context` - SessionStart/UserPromptSubmit/PreCompact Hook用、config/dontを標準出力（UserPromptSubmitでは何も出力しない。記憶想起はプロジェクト側hooksに移譲）
- `wasurenagusa-analyze` - Stop Hook用、会話分析・自動保存 + 変更ファイルログ記録
- `wasurenagusa-guard` - Stop Hook用、intensity 5ルール強制チェック

### CLIスクリプト（Scheduler用）

**バッチ実行（cron/systemd timerで呼び出し）**
- `wasurenagusa-spec-update` - タスクキュー確認 → Claude Code CLI実行 or ping

### CLIスクリプト（メンテナンス用・スケジューラ用）

**手動実行**
- `wasurenagusa-rebuild` - メモリデータの修復・重複除去（破損したMarkdownファイルの再構築）
- `wasurenagusa-consolidate-all` - 全アクティブプロジェクトのdont/config統合を実行
- `wasurenagusa-scheduler` - 夜間統合スケジューラのinstall/uninstall/status（launchd/cron対応）

**Stop Hook用**
- `wasurenagusa-guard` - intensity 5ルールの強制チェック（Stop Hook連携）

**バックグラウンド（自動起動）**
- `wasurenagusa-backfill` - ベクトル埋め込みバックフィルワーカー（SessionStart時に自動spawn）

### Public API（MCPツール）

**AIが自律呼び出し**
- `memory_get_context` - コンテキスト取得
- `memory_search` - 検索（軽量インデックス）
- `memory_get_detail` - 詳細取得

**手動（オプション）**
- `memory_save` - 明示的な保存
- `memory_delete` - エントリ削除（ID指定、複数一括可）
- `memory_update_intensity` - エントリの重要度（intensity）変更

**自律タスク管理**
- `task_submit` - タスク投入（WHY/WHAT/DONE/PROJECT）
- `task_status` - タスク状態サマリ取得
- `task_action_list` - 人間アクションリスト管理
- `project_init` - プロジェクト初期設定

### Internal（外部から直接呼ばない）
- `MarkdownStorage` クラス
- `Analyzer` クラス（旧GeminiAnalyzer）
- `DontConsolidator` クラス（dontエントリのLLM統合）
- `ConfigConsolidator` クラス（configエントリのLLM統合）
- `parseMarkdown` 関数（Markdownパーサー）
- `formatEntry` / `getFileHeader` 関数（Markdownフォーマッター）
- `readTranscript` 関数（トランスクリプトJSONLパーサー）
- `findProjectRoot` 関数
- `createGenerateTextFn` 関数（マルチLLMプロバイダー初期化、genkit経由）
- `EmbeddingService` クラス（Gemini Embedding生成）
- `VectorStore` クラス（ベクトルデータストア）
- `ActiveProjectsTracker` クラス（アクティブプロジェクト追跡）
- `ChangeLogger` クラス（変更ログ記録）
- `TaskQueue` クラス（タスクキュー管理）
- `Executor` クラス（Claude Code CLI実行）
- `PromptBuilder` クラス（プロンプト組み立て）
- `TaskStore` クラス（自律タスクのCRUD・永続化）
- `CommandGenerator` クラス（自律タスク命令文生成）
- `TaskEvaluator` クラス（自律タスク評価）
- `ProjectInitializer` クラス（プロジェクト初期設定）
- `ActionList` クラス（人間アクションリスト管理）
- `SlackNotifier` クラス（Slack通知）
- `ProjectScanner` クラス（プロジェクト自動検出）
- `TaskMarkdownAdapter` クラス（tasks.mdパーサー＆ライター）
- `ensureOwnerProfileExists` / `loadOwnerProfile` 関数（オーナープロフィール管理）
- `startZombieReaper` 関数（ゾンビプロセス自動掃除：stdin close検知・親プロセス生存確認・孤児プロセスkill・兄弟MCPプロセス巻き添え終了）
- `validateWebhookUrl` 関数（Slack Webhook URLバリデーション）

## Code Size Guidelines

| 対象 | 推奨上限 | 備考 |
|------|---------|------|
| **ファイル** | 300行 | 超える場合は分割検討 |
| **関数** | 50行 | 複雑なら分割 |
| **クラス** | 200行 | メソッド数も考慮 |
| **ネスト深度** | 3階層 | 早期リターンで削減 |

## Documentation Standards

### 必須ドキュメント
- **README.md**: インストール方法、使い方、Claude Code登録コマンド
- **docs/spec.md**: 完全実装仕様書
- **.env.example**: 環境変数のサンプル

### コード内ドキュメント
- 複雑なロジックにはコメント追加
- 公開APIにはJSDoc推奨
- ただし過度なコメントは避ける（コード自体を読みやすく）

### Markdown形式
- UTF-8エンコーディング固定
- 改行はLF（Unix形式）
