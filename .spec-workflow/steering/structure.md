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
│   │   ├── context.ts        # wasurenagusa-context CLI【SessionStart Hook用】
│   │   ├── analyze.ts        # wasurenagusa-analyze CLI【Stop Hook用】
│   │   ├── spec-update.ts    # wasurenagusa-spec-update CLI【cron/systemd timer用】
│   │   └── transcript-reader.ts # トランスクリプトJSONLパーサー（テスト可能な独立モジュール）
│   ├── tools/
│   │   ├── index.ts          # ツール定義のエクスポート
│   │   ├── getContext.ts     # memory_get_context ツール【AI自律呼び出し】
│   │   ├── save.ts           # memory_save ツール【手動】オプション
│   │   ├── search.ts         # memory_search ツール【AI自律】軽量インデックス返却
│   │   ├── getDetail.ts      # memory_get_detail ツール【AI自律】フル詳細返却
│   │   └── delete.ts         # memory_delete ツール【手動】エントリ削除
│   ├── storage/
│   │   ├── index.ts          # ストレージインターフェース
│   │   ├── markdown.ts       # Markdown読み書き実装
│   │   ├── parser.ts         # Markdownパーサー（MemoryEntry配列に変換）
│   │   └── formatter.ts      # MemoryEntryのMarkdownフォーマッター
│   ├── analyzer/
│   │   ├── index.ts              # Gemini連携エクスポート
│   │   ├── gemini.ts             # Gemini API呼び出し・判定
│   │   ├── prompt-loader.ts      # プロンプトファイル読み込み
│   │   └── conversation-meta.ts  # 会話メタ情報計算（諦め検知用）
│   ├── consolidator/
│   │   ├── index.ts              # 統合モジュールエクスポート
│   │   ├── dont-consolidator.ts  # dontエントリのGemini統合（原則化）
│   │   ├── staleness.ts          # 統合キャッシュの鮮度チェック・読み書き
│   │   └── formatter.ts          # 統合結果のMarkdownフォーマッター
│   ├── scheduler/
│   │   ├── change-logger.ts      # 変更ログ記録（git diff → JSON）
│   │   ├── task-queue.ts         # タスクキュー管理（優先度付き）
│   │   ├── executor.ts           # Claude Code CLI呼び出し実行
│   │   └── prompt-builder.ts     # Spec更新プロンプト組み立て
│   └── utils/
│       └── projectRoot.ts    # .git探索ロジック
├── prompts/
│   ├── analysis.txt          # Gemini分析プロンプト（外部化）
│   ├── duplicate-check.txt   # 重複チェックプロンプト（外部化）
│   ├── consolidate.txt       # dont統合プロンプト（外部化）
│   ├── spec-update.txt       # Spec更新プロンプトテンプレート
│   └── spec-rotation.txt     # ローテーション更新プロンプトテンプレート
├── dist/                     # ビルド出力
├── docs/
│   └── spec.md               # 完全実装仕様書
├── .spec-workflow/           # Spec Workflowドキュメント
│   └── steering/
│       ├── product.md
│       ├── tech.md
│       └── structure.md
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
├── queue.json            # タスクキュー（優先度付き）
├── .lock                 # 排他制御用ロックファイル
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
- 例: `memory_save`, `memory_search`, `memory_get_detail`, `memory_get_context`, `memory_delete`

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
import { GeminiAnalyzer } from "../analyzer/index.js";
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
// 2. クラス定義
export class MarkdownStorage {
  // プライベートフィールド
  private memoryPath: string;

  // コンストラクタ
  constructor(projectRoot: string) { ... }

  // パブリックメソッド（CRUD操作）
  async save(params: SaveParams): Promise<SaveResult> { ... }
  async search(params: SearchParams): Promise<SearchResult> { ... }
  async getDetail(params: GetDetailParams): Promise<GetDetailResult> { ... }
  async getContext(): Promise<ContextResult> { ... }

  // プライベートヘルパー
  private async readCategory(category: MemoryCategory): Promise<MemoryEntry[]> { ... }
  private formatEntry(entry: MemoryEntry): string { ... }
  private parseMarkdown(content: string, category: MemoryCategory): MemoryEntry[] { ... }
}
```

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
   storage/markdown.ts (ストレージ)    ↓
       ↓                              ↓
   analyzer/gemini.ts (分析)          ↓
       ↓                              ↓
   types.ts, config.ts (共通) ←────────┘
   ```

## Module Boundaries

### CLIスクリプト（Hooks連携用）

**自動実行（type: "command" で呼び出し）**
- `wasurenagusa-context` - SessionStart Hook用、config/dontを標準出力
- `wasurenagusa-analyze` - Stop Hook用、会話分析・自動保存 + 変更ファイルログ記録

### CLIスクリプト（Scheduler用）

**バッチ実行（cron/systemd timerで呼び出し）**
- `wasurenagusa-spec-update` - タスクキュー確認 → Claude Code CLI実行 or ping

### Public API（MCPツール）

**AIが自律呼び出し**
- `memory_get_context` - コンテキスト取得
- `memory_search` - 検索（軽量インデックス）
- `memory_get_detail` - 詳細取得

**手動（オプション）**
- `memory_save` - 明示的な保存
- `memory_delete` - エントリ削除（ID指定、複数一括可）

### Internal（外部から直接呼ばない）
- `MarkdownStorage` クラス
- `GeminiAnalyzer` クラス
- `DontConsolidator` クラス（dontエントリのGemini統合）
- `parseMarkdown` 関数（Markdownパーサー）
- `formatEntry` / `getFileHeader` 関数（Markdownフォーマッター）
- `readTranscript` 関数（トランスクリプトJSONLパーサー）
- `findProjectRoot` 関数
- `ChangeLogger` クラス（変更ログ記録）
- `TaskQueue` クラス（タスクキュー管理）
- `SpecUpdateExecutor` クラス（Claude Code CLI実行）
- `PromptBuilder` クラス（プロンプト組み立て）

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
