# wasurenagusa-mcp 完全実装仕様書 v2

## 概要

Claude Codeのコンテキスト問題を解決するMCPサーバー。
会話中の重要情報を自動保存し、必要時に自動で引き出す。

### 解決する課題
1. 毎回同じミスをする（API URL間違い、ポート間違い、ログ読まない等）
2. 決定事項を忘れる
3. やったことを覚えていない
4. ユーザーが何に怒っているか理解しない
5. セッションが長くなるとコンテキストが膨張してパフォーマンス劣化する
6. よく使うコマンド・クエリを毎回探す

### 設計思想
- **自律自動が基本、手動はオプション**: ユーザーは何もしなくても記憶が蓄積・活用される
- **コンテキストを圧迫しない軽量設計**
- **段階的開示（Progressive Disclosure）**: 検索時はタイトル+タグのみ返し、必要な項目だけフル取得
- LLM（Gemini）で自動判定、トリガーワード不要
- Hooks連携で完全自動化（SessionStart/Stop）
- ローカル実行でセットアップ簡単

### 自律動作アーキテクチャ

```
[セッション開始]
      ↓ SessionStart Hook（type: "command"）
wasurenagusa-context スクリプト実行
  → config.md + dont.md を直接読み込み
  → stdout出力 → Claudeのコンテキストに自動注入
      ↓
[会話中]
      ↓
[Claude応答完了時]
      ↓ Stop Hook（type: "command"）
wasurenagusa-analyze スクリプト実行
  → transcript.jsonl から会話履歴取得
  → Geminiで分析 → 必要なら自動保存
      ↓
[情報が必要な時: AIが自律判断]
Layer 1: memory_search（軽量インデックス）
  → ID, タイトル, カテゴリ, タグのみ返す（~50-80 tokens/件）
      ↓ 必要なIDを選別
Layer 2: memory_get_detail（フル詳細）
  → 指定IDの全内容を返す（~300-500 tokens/件）
```

**自動化フロー**:
1. セッション開始 → SessionStart Hook → config/dontがコンテキストに注入
2. 会話終了時 → Stop Hook → 会話をGemini分析 → 重要情報は自動保存
3. 検索が必要な時 → AIが`memory_search` → `memory_get_detail`を自律呼び出し

**従来方式との比較:**
- 従来: 検索で10件ヒット → 全内容返す → ~5,000 tokens消費
- 段階的開示: 10件のインデックス返す → 必要な2件だけ詳細取得 → ~1,400 tokens消費
- **約70-90%のトークン削減**

---

## 技術スタック

- 言語: TypeScript
- MCP SDK: @modelcontextprotocol/sdk
- トランスポート: STDIO（ローカル実行）
- ストレージ: Markdownファイル
- 外部API: Google Gemini API（gemini-3-flash-preview）

---

## ディレクトリ構造

```
wasurenagusa-mcp/
├── src/
│   ├── index.ts              # MCPサーバーエントリポイント
│   ├── types.ts              # 型定義
│   ├── config.ts             # 設定管理
│   ├── cli/
│   │   ├── context.ts        # wasurenagusa-context CLI（SessionStart Hook用）
│   │   └── analyze.ts        # wasurenagusa-analyze CLI（Stop Hook用）
│   ├── tools/
│   │   ├── index.ts          # ツール定義のエクスポート
│   │   ├── save.ts           # memory_save ツール（手動保存用）
│   │   ├── search.ts         # memory_search ツール（軽量インデックス返却）
│   │   ├── getDetail.ts      # memory_get_detail ツール（フル詳細返却）
│   │   ├── getContext.ts     # memory_get_context ツール（AIから呼び出し可能）
│   │   └── delete.ts         # memory_delete ツール（エントリ削除）
│   ├── storage/
│   │   ├── index.ts          # ストレージインターフェース
│   │   ├── markdown.ts       # Markdownストレージ本体
│   │   ├── parser.ts         # Markdownパース処理
│   │   └── formatter.ts      # Markdownフォーマット処理
│   ├── analyzer/
│   │   ├── index.ts              # Gemini連携エクスポート
│   │   ├── gemini.ts             # Gemini API呼び出し・判定
│   │   ├── prompt-loader.ts      # プロンプトファイル読み込み
│   │   └── conversation-meta.ts  # 会話メタ情報計算（諦め検知用）
│   └── utils/
│       └── projectRoot.ts    # .git探索によるプロジェクトルート検出
├── prompts/
│   ├── analysis.txt          # Gemini分析プロンプト（外部化）
│   └── duplicate-check.txt   # 重複チェックプロンプト（外部化）
├── docs/
│   └── spec.md               # 完全実装仕様書
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
└── README.md
```

---

## メモリ保存先構造

### プロジェクトルート探索

`.git` ディレクトリを上位に向かって探索し、最初に見つかった場所をプロジェクトルートとする。
見つからない場合は `process.cwd()` をフォールバックとして使用。

### プロジェクト固有メモリ

プロジェクトルートに `.wasurenagusa/` を作成:

```
プロジェクトルート/（.git探索で特定）
└── .wasurenagusa/
    ├── config.md       # 設定情報（API URL、ポート、認証等）
    ├── dont.md         # やってはいけないこと（怒りリスト）
    ├── decisions.md    # 決定事項
    ├── snippets.md     # よく使うコマンド・クエリ
    └── logs/
        └── YYYY-MM-DD.md  # 日付別ログ
```

### グローバルメモリ

ユーザーホームディレクトリに `~/.wasurenagusa/global/` を作成:

```
~/.wasurenagusa/
└── global/
    ├── config.md       # グローバル設定（全プロジェクト共通）
    └── dont.md         # グローバルdont（全プロジェクト共通）
```

`memory_get_context` はプロジェクト固有とグローバル両方を読み込んでマージする。

---

## 完全実装コード

### package.json

```json
{
  "name": "wasurenagusa-mcp",
  "version": "0.3.0",
  "type": "module",
  "main": "dist/index.js",
  "bin": {
    "wasurenagusa-mcp": "./dist/index.js",
    "wasurenagusa-context": "./dist/cli/context.js",
    "wasurenagusa-analyze": "./dist/cli/analyze.js"
  },
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "npx ts-node --esm src/index.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "@google/generative-ai": "^0.21.0",
    "dotenv": "^16.4.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.0.0",
    "ts-node": "^10.9.0"
  }
}
```

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### .env.example

```
GEMINI_API_KEY=your_gemini_api_key_here
MEMORY_DIR=.wasurenagusa
```

### src/types.ts

```typescript
// メモリのカテゴリ
export type MemoryCategory = "config" | "dont" | "decision" | "log" | "snippet";

// メモリエントリ（フル）
export interface MemoryEntry {
  id: string;            // ユニークID（タイムスタンプベース）
  timestamp: string;
  category: MemoryCategory;
  content: string;
  tags: string[];
  title: string;         // 内容の要約（1行）
}

// メモリエントリ（軽量インデックス - 段階的開示Layer 1用）
export interface MemoryIndexEntry {
  id: string;
  timestamp: string;
  category: MemoryCategory;
  title: string;         // 要約のみ。フル内容は含まない
  tags: string[];
}

// 保存パラメータ
export interface SaveParams {
  category: MemoryCategory;
  content: string;
  title: string;         // 必須: 1行の要約タイトル
  tags?: string[];
}

// 保存結果
export interface SaveResult {
  success: boolean;
  id: string;
  path: string;
  message: string;
}

// 検索パラメータ
export interface SearchParams {
  query: string;
  category?: MemoryCategory | "all";
  limit?: number;
}

// 検索結果（軽量インデックス）
export interface SearchResult {
  results: MemoryIndexEntry[];   // タイトル+タグのみ
  totalCount: number;
  hint: string;                  // 「memory_get_detail で詳細を取得できます」のガイド
}

// 詳細取得パラメータ
export interface GetDetailParams {
  ids: string[];                 // 取得したいエントリのID配列
}

// 詳細取得結果
export interface GetDetailResult {
  entries: MemoryEntry[];        // フル内容
  notFound: string[];            // 見つからなかったID
}

// コンテキスト取得結果
export interface ContextResult {
  config: string;
  dont: string;
}

// Gemini分析結果
export interface AnalysisResult {
  shouldSave: boolean;
  category: MemoryCategory | null;  // "config" | "dont" | "decision" | "log" | "snippet"
  title: string | null;
  summary: string | null;
  tags: string[];
  reason: string;
}

// Gemini分析入力
export interface AnalysisInput {
  conversationLog: string;
  latestMessage: string;
}

// CLI分析用（Stop Hook用）
export interface AnalyzeParams {
  transcriptPath: string;
}

// CLI分析結果（Stop Hook用）
export interface AnalyzeResult {
  analyzed: boolean;
  saved: boolean;
  saveResult?: SaveResult;
  analysis: AnalysisResult;
}
```

### src/config.ts

```typescript
import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";
import { homedir } from "os";

dotenvConfig();

export const config = {
  // Gemini API設定
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  geminiModel: "gemini-3-flash-preview",
  
  // メモリディレクトリ（プロジェクトルートからの相対パス）
  memoryDir: process.env.MEMORY_DIR || ".wasurenagusa",
  
  // 検索デフォルト
  defaultSearchLimit: 20,
  
  // カテゴリとファイルのマッピング
  categoryFiles: {
    config: "config.md",
    dont: "dont.md",
    decision: "decisions.md",
    log: "logs",  // logsはディレクトリ
    snippet: "snippets.md"
  } as const
};

export function getMemoryPath(projectRoot: string): string {
  return resolve(projectRoot, config.memoryDir);
}

export function getGlobalMemoryPath(): string {
  return resolve(homedir(), ".wasurenagusa", "global");
}
```

### src/utils/projectRoot.ts

```typescript
import { existsSync } from "fs";
import { dirname, join, resolve } from "path";

/**
 * .git ディレクトリを上位に向かって探索し、プロジェクトルートを特定する。
 * 見つからない場合は process.cwd() をフォールバックとして使用。
 */
export function findProjectRoot(startDir?: string): string {
  let currentDir = startDir ? resolve(startDir) : process.cwd();
  const root = resolve("/");

  while (currentDir !== root) {
    const gitPath = join(currentDir, ".git");
    if (existsSync(gitPath)) {
      return currentDir;
    }
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  // .gitが見つからない場合はprocess.cwd()にフォールバック
  return process.cwd();
}
```

### src/storage/index.ts

```typescript
export { MarkdownStorage } from "./markdown.js";
```

### src/storage/parser.ts

```typescript
import { MemoryCategory, MemoryEntry } from "../types.js";

/**
 * MarkdownコンテンツをパースしてMemoryEntry配列に変換する
 */
export function parseMarkdown(content: string, category: MemoryCategory): MemoryEntry[] {
  const entries: MemoryEntry[] = [];

  // ## で始まるセクションを分割
  const sections = content.split(/^## /gm).filter(s => s.trim());

  for (const section of sections) {
    const lines = section.split("\n");
    const title = lines[0]?.trim() || "";

    // ヘッダー行（ファイル先頭の # Config Memory 等）をスキップ
    if (!title || title.startsWith("#")) {
      continue;
    }

    let id = "";
    let timestamp = "";
    let tags: string[] = [];
    let entryContent = "";

    for (const line of lines.slice(1)) {
      const trimmed = line.trim();
      if (trimmed.startsWith("- **id**:")) {
        id = trimmed.replace("- **id**:", "").trim();
      } else if (trimmed.startsWith("- **timestamp**:")) {
        timestamp = trimmed.replace("- **timestamp**:", "").trim();
      } else if (trimmed.startsWith("- **tags**:")) {
        tags = trimmed.replace("- **tags**:", "").trim().split(",").map(t => t.trim()).filter(Boolean);
      } else if (trimmed.startsWith("- **content**:")) {
        entryContent = trimmed.replace("- **content**:", "").trim();
      }
    }

    // id か timestamp がないエントリはスキップ
    if (!id || !timestamp) {
      continue;
    }

    if (entryContent) {
      entries.push({
        id,
        timestamp,
        category,
        content: entryContent,
        title,
        tags
      });
    }
  }

  return entries;
}
```

### src/storage/formatter.ts

```typescript
import { MemoryEntry } from "../types.js";

/**
 * MemoryEntryをMarkdown形式にフォーマットする
 */
export function formatEntry(entry: MemoryEntry): string {
  const tagsStr = entry.tags.length > 0
    ? `- **tags**: ${entry.tags.join(", ")}\n`
    : "";

  return `## ${entry.title}

- **id**: ${entry.id}
- **timestamp**: ${entry.timestamp}
- **category**: ${entry.category}
${tagsStr}- **content**: ${entry.content}

---

`;
}

/**
 * ファイルのヘッダーを生成する
 */
export function getFileHeader(filename: string): string {
  const headers: Record<string, string> = {
    "config.md": "# Config Memory\n\nAPI URL、ポート、認証情報など、毎回参照すべき設定情報。\n\n---\n\n",
    "dont.md": "# Don't Memory\n\nやってはいけないこと、過去のミス、ユーザーが怒ったポイント。\n\n---\n\n",
    "decisions.md": "# Decisions Memory\n\n決定事項、採用した方針、技術選定の理由。\n\n---\n\n",
    "snippets.md": "# Snippets Memory\n\nよく使うコマンド、クエリ、便利スクリプト。\n\n---\n\n"
  };
  return headers[filename] || "";
}
```

### src/storage/markdown.ts

```typescript
import { mkdir, readFile, writeFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import {
  MemoryCategory,
  MemoryEntry,
  MemoryIndexEntry,
  SaveParams,
  SaveResult,
  SearchParams,
  SearchResult,
  GetDetailParams,
  GetDetailResult,
  ContextResult
} from "../types.js";
import { config, getMemoryPath, getGlobalMemoryPath } from "../config.js";
import { parseMarkdown } from "./parser.js";
import { formatEntry, getFileHeader } from "./formatter.js";

export class MarkdownStorage {
  private memoryPath: string;

  constructor(projectRoot: string) {
    this.memoryPath = getMemoryPath(projectRoot);
  }

  private generateId(): string {
    const timestamp = Date.now().toString(36);
    const random = randomBytes(2).toString("hex");
    return `${timestamp}-${random}`;
  }

  async initialize(): Promise<void> {
    if (!existsSync(this.memoryPath)) {
      await mkdir(this.memoryPath, { recursive: true });
    }

    const logsPath = join(this.memoryPath, "logs");
    if (!existsSync(logsPath)) {
      await mkdir(logsPath, { recursive: true });
    }

    const files = ["config.md", "dont.md", "decisions.md", "snippets.md"];
    for (const file of files) {
      const filePath = join(this.memoryPath, file);
      if (!existsSync(filePath)) {
        const header = getFileHeader(file);
        await writeFile(filePath, header, "utf-8");
      }
    }
  }

  async save(params: SaveParams): Promise<SaveResult> {
    try {
      await this.initialize();

      const id = this.generateId();
      const timestamp = new Date().toISOString();
      const entry: MemoryEntry = {
        id,
        timestamp,
        category: params.category,
        content: params.content,
        title: params.title,
        tags: params.tags || []
      };

      const formatted = formatEntry(entry);
      const filePath = this.getFilePath(params.category, timestamp);

      let existingContent = "";
      if (existsSync(filePath)) {
        existingContent = await readFile(filePath, "utf-8");
      } else if (params.category === "log") {
        existingContent = `# Log: ${timestamp.split("T")[0]}\n\n---\n\n`;
      }

      await writeFile(filePath, existingContent + formatted, "utf-8");

      return { success: true, id, path: filePath, message: `Saved to ${params.category} (id: ${id})` };
    } catch (error) {
      return { success: false, id: "", path: "", message: `Failed to save: ${error}` };
    }
  }

  async search(params: SearchParams): Promise<SearchResult> {
    await this.initialize();

    const categories: MemoryCategory[] =
      params.category === "all" || !params.category
        ? ["config", "dont", "decision", "log", "snippet"]
        : [params.category];

    const allEntries: MemoryEntry[] = [];
    for (const category of categories) {
      const entries = await this.readCategory(category);
      allEntries.push(...entries);
    }

    const query = params.query.toLowerCase();
    const filtered = allEntries.filter(entry =>
      entry.title.toLowerCase().includes(query) ||
      entry.content.toLowerCase().includes(query) ||
      entry.tags.some(tag => tag.toLowerCase().includes(query))
    );

    filtered.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    const limit = params.limit || config.defaultSearchLimit;
    const limited = filtered.slice(0, limit);

    const indexEntries: MemoryIndexEntry[] = limited.map(entry => ({
      id: entry.id, timestamp: entry.timestamp, category: entry.category, title: entry.title, tags: entry.tags
    }));

    return {
      results: indexEntries,
      totalCount: filtered.length,
      hint: indexEntries.length > 0
        ? "詳細が必要なエントリのIDを memory_get_detail に渡してください。"
        : "該当するメモリが見つかりませんでした。"
    };
  }

  async getDetail(params: GetDetailParams): Promise<GetDetailResult> {
    await this.initialize();

    const allCategories: MemoryCategory[] = ["config", "dont", "decision", "log", "snippet"];
    const allEntries: MemoryEntry[] = [];
    for (const category of allCategories) {
      const entries = await this.readCategory(category);
      allEntries.push(...entries);
    }

    const entryMap = new Map(allEntries.map(e => [e.id, e]));
    const found: MemoryEntry[] = [];
    const notFound: string[] = [];

    for (const id of params.ids) {
      const entry = entryMap.get(id);
      if (entry) { found.push(entry); } else { notFound.push(id); }
    }

    return { entries: found, notFound };
  }

  async getContext(): Promise<ContextResult> {
    await this.initialize();

    // プロジェクト固有メモリ
    const projectConfig = await this.readFileIfExists(join(this.memoryPath, "config.md"));
    const projectDont = await this.readFileIfExists(join(this.memoryPath, "dont.md"));

    // グローバルメモリ
    const globalPath = getGlobalMemoryPath();
    const globalConfig = await this.readFileIfExists(join(globalPath, "config.md"));
    const globalDont = await this.readFileIfExists(join(globalPath, "dont.md"));

    return {
      config: this.mergeContent("Config", globalConfig, projectConfig),
      dont: this.mergeContent("Don't", globalDont, projectDont)
    };
  }

  private async readFileIfExists(filePath: string): Promise<string> {
    return existsSync(filePath) ? await readFile(filePath, "utf-8") : "";
  }

  private mergeContent(label: string, global: string, project: string): string {
    const parts: string[] = [];
    if (global.trim()) { parts.push(`## Global ${label}\n\n${global.trim()}`); }
    if (project.trim()) { parts.push(`## Project ${label}\n\n${project.trim()}`); }
    return parts.join("\n\n---\n\n");
  }

  private async readCategory(category: MemoryCategory): Promise<MemoryEntry[]> {
    if (category === "log") {
      const logsPath = join(this.memoryPath, "logs");
      if (!existsSync(logsPath)) { return []; }
      const files = await readdir(logsPath);
      const entries: MemoryEntry[] = [];
      for (const file of files) {
        if (file.endsWith(".md")) {
          const content = await readFile(join(logsPath, file), "utf-8");
          entries.push(...parseMarkdown(content, category));
        }
      }
      return entries;
    }
    const filePath = join(this.memoryPath, config.categoryFiles[category]);
    if (!existsSync(filePath)) { return []; }
    const content = await readFile(filePath, "utf-8");
    return parseMarkdown(content, category);
  }

  private getFilePath(category: MemoryCategory, timestamp: string): string {
    if (category === "log") {
      const date = timestamp.split("T")[0];
      return join(this.memoryPath, "logs", `${date}.md`);
    }
    return join(this.memoryPath, config.categoryFiles[category]);
  }
}
```

### src/analyzer/index.ts

```typescript
export { GeminiAnalyzer } from "./gemini.js";
```

### src/analyzer/gemini.ts

```typescript
import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "../config.js";
import { AnalysisResult, AnalysisInput } from "../types.js";

const ANALYSIS_PROMPT = `あなたは会話ログを分析し、永続的に保存すべき重要情報を抽出するアシスタントです。

## あなたの役割
Claude Codeとユーザーの会話から、以下のカテゴリに該当する情報を検出してください：

### カテゴリ定義

1. **config** - 設定情報
   - API URL、エンドポイント
   - ポート番号
   - 認証情報、トークンの場所
   - 環境変数名
   - ファイルパス、ディレクトリ構造
   - 例：「本番APIは https://api.example.com」「ポートは3000固定」

2. **dont** - やってはいけないこと
   - ユーザーが怒っているポイント
   - 過去のミス、バグの原因
   - 使ってはいけないライブラリ・手法
   - AIのリトライパターン（下記参照）
   - 「ログを読め」「〜するな」等の指示
   - 例：「毎回同じミスするな」「このライブラリは使わないで」「ログ確認してから質問して」

3. **decision** - 決定事項
   - 技術選定の結論
   - アーキテクチャの決定
   - 命名規則、コーディング規約
   - 「〜に決めた」「〜でいく」「〜を採用」
   - 例：「Firestoreを使う」「camelCaseで統一」「Reactでいく」

4. **log** - 作業ログ
   - 実装完了した機能
   - 解決したエラーとその方法
   - 試行錯誤の結果
   - 例：「認証機能を実装した」「CORSエラーはプロキシで解決」

5. **snippet** - よく使うコマンド・クエリ
   - テストAPIコマンド
   - DBクエリのテンプレート
   - 便利なワンライナー
   - curl/httpieコマンド例
   - 例：「ユーザー一覧取得: curl http://localhost:3000/api/users」

## AIリトライパターン検出（重要）

以下のパターンを検出したら、**必ず dont に分類**し、「正しいやり方」を記録する：

1. **API多重実行**: 同じAPIエンドポイントを短時間に3回以上実行している
   - 例: POST /api/users を連続で叩いている → 「正しいエンドポイントは〜」
2. **DBクエリ多重発行**: 同じクエリを短時間に3回以上発行している
   - 例: SELECT * FROM users WHERE... を繰り返している
3. **エラー繰り返し**: 同じエラーが3回以上発生している
   - 例: "Cannot read property 'x' of undefined" が連発 → 「nullチェックを忘れずに」
4. **ファイル多重編集**: 同じファイルを短時間に5回以上編集している
   - 例: src/index.ts を何度も書き換えている → 「変更前に設計を確認」

## 入力
- conversationLog: 会話の履歴
- latestMessage: 最新のメッセージ

## 出力形式
以下のJSON形式で出力してください。他の文字は一切出力しないこと：

{
  "shouldSave": true または false,
  "category": "config" | "dont" | "decision" | "log" | "snippet" | null,
  "title": "1行の要約タイトル（20文字以内推奨）。保存不要ならnull",
  "summary": "保存すべき内容を1-2行で要約。保存不要ならnull",
  "tags": ["検索用タグ", "最大5個"],
  "reason": "判断理由を簡潔に"
}

## 判断基準
- 一般的な会話、挨拶、質問のみは保存不要（shouldSave: false）
- 曖昧な情報より、具体的・確定的な情報を優先
- ユーザーの感情（怒り、不満）は重要なシグナル → dont に分類
- AIのリトライパターンは重要なシグナル → dont に「正しいやり方」を記録
- 同じ内容の重複は避けるが、更新情報は保存

## titleの書き方ルール
- 検索しやすい具体的な名詞を含める
- 例: 「本番API URLの指定」「ログ未読への怒り」「Firestore採用決定」「CORS解決: プロキシ利用」「API多重実行: 正しいエンドポイント」
- 曖昧な「設定について」「決定事項」等は避ける

## 注意
- 機密情報（パスワード、APIキーの値そのもの）は保存しない
- 「APIキーは.envに入れる」のような場所の情報はOK
`;

export class GeminiAnalyzer {
  private genAI: GoogleGenerativeAI;
  private model: any;

  constructor() {
    if (!config.geminiApiKey) {
      throw new Error("GEMINI_API_KEY is not set");
    }
    this.genAI = new GoogleGenerativeAI(config.geminiApiKey);
    this.model = this.genAI.getGenerativeModel({ model: config.geminiModel });
  }

  async analyze(input: AnalysisInput): Promise<AnalysisResult> {
    try {
      const prompt = `${ANALYSIS_PROMPT}

---

## 会話ログ
${input.conversationLog}

## 最新メッセージ
${input.latestMessage}

---

上記を分析し、JSON形式で出力してください：`;

      const result = await this.model.generateContent(prompt);
      const response = result.response;
      const text = response.text();

      // JSONをパース（前後の余計な文字を除去）
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return this.defaultResult("Failed to parse JSON response");
      }

      const parsed = JSON.parse(jsonMatch[0]) as AnalysisResult;
      return parsed;

    } catch (error) {
      console.error("Gemini analysis error:", error);
      return this.defaultResult(`Analysis error: ${error}`);
    }
  }

  private defaultResult(reason: string): AnalysisResult {
    return {
      shouldSave: false,
      category: null,
      title: null,
      summary: null,
      tags: [],
      reason
    };
  }
}
```

### src/tools/index.ts

```typescript
export { memorySaveTool, handleMemorySave } from "./save.js";
export { memorySearchTool, handleMemorySearch } from "./search.js";
export { memoryGetDetailTool, handleMemoryGetDetail } from "./getDetail.js";
export { memoryGetContextTool, handleMemoryGetContext } from "./getContext.js";
```

### src/tools/save.ts

```typescript
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { MarkdownStorage } from "../storage/index.js";
import { SaveParams, MemoryCategory } from "../types.js";

export const memorySaveTool: Tool = {
  name: "memory_save",
  description: `メモリを保存する。カテゴリ:
- config: API URL、ポート、認証情報などの設定
- dont: やってはいけないこと、過去のミス、ユーザーが怒ったこと、AIのリトライパターン
- decision: 決定事項、採用した方針
- log: 実装したこと、解決したエラー
- snippet: よく使うコマンド、クエリ、便利スクリプト

titleには検索しやすい具体的な名詞を含めること。`,
  inputSchema: {
    type: "object",
    properties: {
      category: {
        type: "string",
        enum: ["config", "dont", "decision", "log", "snippet"],
        description: "メモリのカテゴリ"
      },
      title: {
        type: "string",
        description: "1行の要約タイトル（20文字以内推奨）。検索用の具体的な名詞を含める。例: 「本番API URL」「ログ未読への怒り」"
      },
      content: {
        type: "string",
        description: "保存する内容の詳細"
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "検索用タグ（オプション、最大5個）"
      }
    },
    required: ["category", "title", "content"]
  }
};

export async function handleMemorySave(
  args: Record<string, unknown>,
  projectRoot: string
): Promise<string> {
  const storage = new MarkdownStorage(projectRoot);
  
  const params: SaveParams = {
    category: args.category as MemoryCategory,
    title: args.title as string,
    content: args.content as string,
    tags: (args.tags as string[]) || []
  };

  const result = await storage.save(params);
  
  return JSON.stringify(result, null, 2);
}
```

### src/tools/search.ts

```typescript
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { MarkdownStorage } from "../storage/index.js";
import { SearchParams, MemoryCategory } from "../types.js";

export const memorySearchTool: Tool = {
  name: "memory_search",
  description: `メモリを検索する。【重要】このツールは軽量インデックス（ID, タイトル, タグ）のみを返す。
フル内容が必要な場合は、返されたIDを memory_get_detail に渡すこと。
全件の詳細を取得せず、必要なものだけ取得してトークンを節約すること。`,
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "検索クエリ（キーワード）"
      },
      category: {
        type: "string",
        enum: ["config", "dont", "decision", "log", "snippet", "all"],
        description: "検索対象カテゴリ。デフォルトはall"
      },
      limit: {
        type: "number",
        description: "最大取得件数。デフォルトは20"
      }
    },
    required: ["query"]
  }
};

export async function handleMemorySearch(
  args: Record<string, unknown>,
  projectRoot: string
): Promise<string> {
  const storage = new MarkdownStorage(projectRoot);
  
  const params: SearchParams = {
    query: args.query as string,
    category: (args.category as MemoryCategory | "all") || "all",
    limit: (args.limit as number) || 20
  };

  const result = await storage.search(params);
  
  return JSON.stringify(result, null, 2);
}
```

### src/tools/getDetail.ts

```typescript
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { MarkdownStorage } from "../storage/index.js";
import { GetDetailParams } from "../types.js";

export const memoryGetDetailTool: Tool = {
  name: "memory_get_detail",
  description: `memory_search で取得したIDを指定して、メモリのフル詳細を取得する。
複数IDを一括指定可能。必要なものだけ取得してトークンを節約すること。`,
  inputSchema: {
    type: "object",
    properties: {
      ids: {
        type: "array",
        items: { type: "string" },
        description: "取得したいメモリエントリのID配列"
      }
    },
    required: ["ids"]
  }
};

export async function handleMemoryGetDetail(
  args: Record<string, unknown>,
  projectRoot: string
): Promise<string> {
  const storage = new MarkdownStorage(projectRoot);
  
  const params: GetDetailParams = {
    ids: args.ids as string[]
  };

  const result = await storage.getDetail(params);
  
  return JSON.stringify(result, null, 2);
}
```

### src/tools/getContext.ts

```typescript
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { MarkdownStorage } from "../storage/index.js";

export const memoryGetContextTool: Tool = {
  name: "memory_get_context",
  description: `config（設定情報）とdont（やってはいけないこと）を一括取得する。
通常はSessionStart Hookで自動注入されるため、手動で呼ぶ必要は少ない。
セッション途中でコンテキストを再確認したい場合に使用。`,
  inputSchema: {
    type: "object",
    properties: {},
    required: []
  }
};

export async function handleMemoryGetContext(
  _args: Record<string, unknown>,
  projectRoot: string
): Promise<string> {
  const storage = new MarkdownStorage(projectRoot);
  const result = await storage.getContext();

  return JSON.stringify(result, null, 2);
}
```

### src/cli/context.ts

```typescript
#!/usr/bin/env node
/**
 * wasurenagusa-context CLI
 * SessionStart Hook用: config/dontを読み込んで標準出力に出力
 *
 * 使い方: wasurenagusa-context
 * Hooks設定で呼び出される（stdoutがClaudeのコンテキストに注入される）
 *
 * Hook入力（stdin JSON）:
 * {
 *   "session_id": "...",
 *   "transcript_path": "...",
 *   "cwd": "/path/to/project",
 *   "hook_event_name": "SessionStart",
 *   "source": "startup" | "resume" | "clear" | "compact",
 *   "model": "..."
 * }
 */

import { readFile, access } from "fs/promises";
import { join, resolve } from "path";
import { homedir } from "os";
import { findProjectRoot } from "../utils/projectRoot.js";
import { config } from "../config.js";

interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  source?: string;
  model?: string;
}

async function readFileIfExists(filePath: string): Promise<string> {
  try {
    await access(filePath);
    return await readFile(filePath, "utf-8");
  } catch {
    return "";
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function main() {
  // stdinからHook入力JSONを読み取る
  let cwd: string;
  try {
    const inputData = await readStdin();
    if (inputData.trim()) {
      const hookInput: HookInput = JSON.parse(inputData);
      cwd = hookInput.cwd;
    } else {
      // stdinが空の場合（手動実行時など）はprocess.cwd()を使用
      cwd = process.cwd();
    }
  } catch {
    // JSONパースエラーの場合もprocess.cwd()を使用
    cwd = process.cwd();
  }

  // cwdからプロジェクトルートを探索
  const projectRoot = findProjectRoot(cwd);
  const memoryPath = resolve(projectRoot, config.memoryDir);
  const globalPath = resolve(homedir(), ".wasurenagusa", "global");

  // プロジェクト固有
  const projectConfig = await readFileIfExists(join(memoryPath, "config.md"));
  const projectDont = await readFileIfExists(join(memoryPath, "dont.md"));

  // グローバル
  const globalConfig = await readFileIfExists(join(globalPath, "config.md"));
  const globalDont = await readFileIfExists(join(globalPath, "dont.md"));

  // 出力を組み立て
  const output: string[] = [];

  output.push("=== wasurenagusa メモリ ===\n");

  if (globalConfig.trim() || projectConfig.trim()) {
    output.push("## 設定情報（config）\n");
    if (globalConfig.trim()) {
      output.push("### グローバル設定\n" + globalConfig.trim() + "\n");
    }
    if (projectConfig.trim()) {
      output.push("### プロジェクト設定\n" + projectConfig.trim() + "\n");
    }
  }

  if (globalDont.trim() || projectDont.trim()) {
    output.push("## やってはいけないこと（dont）\n");
    if (globalDont.trim()) {
      output.push("### グローバルルール\n" + globalDont.trim() + "\n");
    }
    if (projectDont.trim()) {
      output.push("### プロジェクトルール\n" + projectDont.trim() + "\n");
    }
  }

  if (output.length === 1) {
    output.push("（まだメモリがありません）");
  }

  // stdoutに出力（Hooksがこれをコンテキストに注入する）
  console.log(output.join("\n"));
}

main().catch(console.error);
```

### src/cli/analyze.ts

```typescript
#!/usr/bin/env node
/**
 * wasurenagusa-analyze CLI
 * Stop Hook用: 会話を分析して重要情報を自動保存
 *
 * 使い方: wasurenagusa-analyze
 * stdinからHook入力JSONを受け取る（transcript_pathを含む）
 */

import { readFile } from "fs/promises";
import { config as dotenvConfig } from "dotenv";
import { GeminiAnalyzer } from "../analyzer/index.js";
import { MarkdownStorage } from "../storage/index.js";
import { findProjectRoot } from "../utils/projectRoot.js";
import { SaveParams } from "../types.js";

dotenvConfig();

interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  stop_hook_active?: boolean;
}

interface TranscriptEntry {
  type: string;
  message?: {
    role: string;
    content: string | Array<{ type: string; text?: string }>;
  };
}

async function readTranscript(transcriptPath: string): Promise<string> {
  const content = await readFile(transcriptPath, "utf-8");
  const lines = content.trim().split("\n");

  const messages: string[] = [];
  for (const line of lines.slice(-50)) { // 直近50行のみ
    try {
      const entry: TranscriptEntry = JSON.parse(line);
      if (entry.type === "message" && entry.message) {
        const role = entry.message.role;
        let text = "";
        if (typeof entry.message.content === "string") {
          text = entry.message.content;
        } else if (Array.isArray(entry.message.content)) {
          text = entry.message.content
            .filter(c => c.type === "text" && c.text)
            .map(c => c.text)
            .join("\n");
        }
        if (text) {
          messages.push(`[${role}]: ${text.slice(0, 500)}`);
        }
      }
    } catch {
      // JSONパースエラーは無視
    }
  }

  return messages.join("\n\n");
}

async function main() {
  // stdinからHook入力を読み取る
  let inputData = "";
  for await (const chunk of process.stdin) {
    inputData += chunk;
  }

  const hookInput: HookInput = JSON.parse(inputData);

  // 無限ループ防止: stop_hook_activeがtrueなら何もしない
  if (hookInput.stop_hook_active) {
    process.exit(0);
  }

  // Gemini APIキーがない場合はスキップ
  if (!process.env.GEMINI_API_KEY) {
    process.exit(0);
  }

  // トランスクリプトを読み込み
  const conversationLog = await readTranscript(hookInput.transcript_path);
  if (!conversationLog) {
    process.exit(0);
  }

  // Geminiで分析
  const analyzer = new GeminiAnalyzer();
  const analysis = await analyzer.analyze({
    conversationLog,
    latestMessage: conversationLog.split("\n\n").slice(-1)[0] || ""
  });

  // 保存が必要な場合
  if (analysis.shouldSave && analysis.category && analysis.title && analysis.summary) {
    const projectRoot = findProjectRoot(hookInput.cwd);
    const storage = new MarkdownStorage(projectRoot);

    const saveParams: SaveParams = {
      category: analysis.category,
      title: analysis.title,
      content: analysis.summary,
      tags: analysis.tags
    };

    const result = await storage.save(saveParams);

    // システムメッセージを出力（オプション）
    if (result.success) {
      console.log(JSON.stringify({
        systemMessage: `[wasurenagusa] ${analysis.category}に保存: ${analysis.title}`
      }));
    }
  }
}

main().catch(console.error);
```

### src/index.ts

```typescript
#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { config as dotenvConfig } from "dotenv";

import {
  memorySaveTool,
  handleMemorySave,
  memorySearchTool,
  handleMemorySearch,
  memoryGetDetailTool,
  handleMemoryGetDetail,
  memoryGetContextTool,
  handleMemoryGetContext,
} from "./tools/index.js";
import { findProjectRoot } from "./utils/projectRoot.js";

dotenvConfig();

const PROJECT_ROOT = findProjectRoot();

const server = new Server(
  {
    name: "wasurenagusa-mcp",
    version: "0.3.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ツール一覧（4ツール: 自動分析はCLIスクリプトで実行）
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      memoryGetContextTool, // AIから呼び出し可能（Hooksでも自動実行）
      memorySaveTool,       // 手動保存: オプション
      memorySearchTool,     // 軽量インデックス検索
      memoryGetDetailTool,  // フル詳細取得
    ],
  };
});

// ツール実行
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: string;

    switch (name) {
      case "memory_get_context":
        result = await handleMemoryGetContext(args || {}, PROJECT_ROOT);
        break;
      case "memory_save":
        result = await handleMemorySave(args || {}, PROJECT_ROOT);
        break;
      case "memory_search":
        result = await handleMemorySearch(args || {}, PROJECT_ROOT);
        break;
      case "memory_get_detail":
        result = await handleMemoryGetDetail(args || {}, PROJECT_ROOT);
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [
        {
          type: "text",
          text: result,
        },
      ],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: errorMessage }),
        },
      ],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("wasurenagusa-mcp server started (v0.3.0)");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
```

### README.md

```markdown
# wasurenagusa-mcp

Claude Codeのコンテキスト問題を解決する**自律動作型**MCPサーバー。
会話中の重要情報を**自動保存**し、セッション開始時に**自動注入**。
ユーザーは何もしなくてOK。

## 特徴

- **完全自動**: Hooks連携でユーザー操作不要
- **自律学習**: ユーザーの怒り、AIのリトライパターンを自動検出・記録
- **トークン節約**: 段階的開示で最大90%削減

## ツール一覧

| コンポーネント | 実行方式 | 役割 |
|----------------|----------|------|
| **wasurenagusa-context** | 自動（SessionStart Hook） | config+dont自動注入（CLIスクリプト） |
| **wasurenagusa-analyze** | 自動（Stop Hook） | 会話分析・自動保存（CLIスクリプト） |
| **memory_get_context** | AIが自律呼び出し | config+dont取得（MCPツール） |
| **memory_save** | 手動（オプション） | 明示的に保存したい時（MCPツール） |
| **memory_search** | AIが自律呼び出し | 軽量インデックス検索（MCPツール） |
| **memory_get_detail** | AIが自律呼び出し | フル詳細取得（MCPツール） |

## セットアップ

### 1. ビルド

```bash
npm install
npm run build
```

### 2. Claude Code登録（MCPサーバー）

```bash
claude mcp add wasurenagusa node /path/to/wasurenagusa-mcp/dist/index.js
```

### 3. 環境変数

`.env` ファイルを作成:

```
GEMINI_API_KEY=your_gemini_api_key_here
```

### 4. Hooks設定（重要・自動化の要）

`~/.claude/settings.json` に以下を追加:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/wasurenagusa-mcp/dist/cli/context.js"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/wasurenagusa-mcp/dist/cli/analyze.js"
          }
        ]
      }
    ]
  }
}
```

**注意**: `/path/to/wasurenagusa-mcp` を実際のインストールパスに置き換えること。
npm link した場合は `wasurenagusa-context` と `wasurenagusa-analyze` をコマンド名として使用可能。

## 動作フロー

```
[セッション開始] → SessionStart Hook → wasurenagusa-context実行
                  → config/dontが標準出力 → コンテキストに自動注入
        ↓
[会話終了時] → Stop Hook → wasurenagusa-analyze実行
             → transcript.jsonl分析 → Gemini判定 → 重要情報を自動保存
        ↓
[情報が必要な時] → AIがmemory_search → memory_get_detailを自律呼び出し
```

**ユーザーがやること = 何もない**（普通に会話するだけ）

## メモリ構造

### プロジェクト固有（.wasurenagusa/）

- `config.md` - 設定情報（毎セッション自動参照）
- `dont.md` - やってはいけないこと（毎セッション自動参照）
- `decisions.md` - 決定事項
- `snippets.md` - よく使うコマンド・クエリ
- `logs/` - 日付別ログ

### グローバル（~/.wasurenagusa/global/）

- `config.md` - 全プロジェクト共通設定
- `dont.md` - 全プロジェクト共通ルール

## 自動検出・保存されるもの

| 検出対象 | 保存先 | 例 |
|----------|--------|-----|
| ユーザーの怒り・不満 | dont | 「何度言えば...」「さっき言った」 |
| AIのリトライパターン | dont | 同じAPI3回実行、同じエラー繰り返し |
| 設定情報 | config | 「ポートは3000」「本番URLは〜」 |
| 決定事項 | decision | 「Firestoreでいく」「この設計で」 |
| 作業完了 | log | 「〜を実装した」「〜を解決」 |
| コマンド・クエリ | snippet | よく使うcurl、DBクエリ |
```

---

## Hooks設定（自律動作の要）

wasurenagusa-mcpの自律動作を実現するには、Claude CodeのHooks機能を設定する必要がある。

**重要**: Claude CodeのHooksは `type: "command"` でシェルコマンドを実行する。MCPツールを直接呼び出す `type: "tool"` は存在しない。

### ~/.claude/settings.json の設定

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/wasurenagusa-mcp/dist/cli/context.js"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/wasurenagusa-mcp/dist/cli/analyze.js"
          }
        ]
      }
    ]
  }
}
```

**注意**: `/path/to/wasurenagusa-mcp` は実際のインストールパスに置き換えること。

npm linkした場合はコマンド名で指定可能:
```json
{
  "hooks": {
    "SessionStart": [{ "matcher": "", "hooks": [{ "type": "command", "command": "wasurenagusa-context" }] }],
    "Stop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "wasurenagusa-analyze" }] }]
  }
}
```

### Hooks説明

| Hook | タイミング | 実行コマンド | 効果 |
|------|-----------|-------------|------|
| **SessionStart** | セッション開始時 | `wasurenagusa-context` | config+dontを標準出力→コンテキスト注入 |
| **Stop** | Claude応答完了時 | `wasurenagusa-analyze` | transcript.jsonl分析→重要情報自動保存 |

### 動作フロー

```
[ユーザーがClaude Codeを起動]
    ↓ SessionStart Hook 発火
wasurenagusa-context スクリプト実行
    → .wasurenagusa/config.md と dont.md を読み込み
    → 標準出力に出力
    → Claudeのコンテキストに自動注入
    ↓
[会話開始]
    ↓
[ユーザーとAIの会話...]
    ↓
[Claude応答完了（AIのターン終了）]
    ↓ Stop Hook 発火
wasurenagusa-analyze スクリプト実行
    → stdinからJSON受信（transcript_path含む）
    → transcript.jsonlから会話履歴を取得
    → Geminiが分析
    → 重要情報があれば自動保存（dont/config/decision/log/snippet）
    ↓
[会話継続...]
```

### 手動操作が不要になる理由

1. **セッション開始時**: SessionStart Hookが`wasurenagusa-context`を実行 → ユーザーは何もしなくてもconfigとdontがコンテキストに入る
2. **会話中**: Stop Hookが`wasurenagusa-analyze`を実行 → 重要情報は自動保存される
3. **検索時**: AIが必要に応じて`memory_search` → `memory_get_detail`を自律呼び出し

**ユーザーがやること = 何もない**（普通に会話するだけ）

---

## Claude Code登録コマンド

### ビルド後（推奨）
```bash
cd /path/to/wasurenagusa-mcp
npm install
npm run build
claude mcp add wasurenagusa node /path/to/wasurenagusa-mcp/dist/index.js
```

### 動作確認
```bash
claude mcp list
# wasurenagusa が表示されればOK
```

---

## 将来の拡張可能性

- **SQLiteへの移行**: 数千件規模への対応、検索性能向上
- **Embeddingによるセマンティック検索**: 類似内容の検出、重複マージ
- **HTTP Transport**: リモートアクセス、チーム共有
- **Analytics**: 保存頻度、検索パターンの可視化

---

## 注意事項

- `.wasurenagusa/` はプロジェクトごとに作成される
- `~/.wasurenagusa/global/` はユーザー全体で共有される
- `.gitignore` に追加するかはユーザー判断（機密情報含む可能性あり）
- ファイルが存在しない場合は自動作成
- エンコーディングはUTF-8固定
- `GEMINI_API_KEY` は自動判定機能に必要（手動保存は常に利用可能）
- プロジェクトルートは `.git` ディレクトリを上位探索して特定

---

この仕様に従って実装してください。
上記のコードをそのまま使用し、ファイル構造通りに配置してください。
動作するMCPサーバーを作成し、Claude Codeで登録・動作確認できる状態にしてください。