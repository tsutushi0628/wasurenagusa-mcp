# Design: project-scope-memory

## Overview

既存のwasurenagusa-mcpの記憶構造に `project` と `scope` フィールドを追加し、シンボリックリンクで集約された `.wasurenagusa/` ディレクトリ内で複数プロジェクトの知識を識別・フィルタリング可能にする。また、SessionStart時のコンテキスト注入を最小化し、AIが必要な時に動的に記憶を取得する体験を実現する。

## Steering Document Alignment

### Technical Standards (tech.md)

- **TypeScript ESM + Node.js 18以上** の既存パターンに従う
- **STDIO Transport** のMCPサーバー構成は変更なし
- **Markdownストレージ** のフォーマットを拡張（project/scopeフィールド追加）
- **Gemini分析プロンプト** にscope判定を追加

### Project Structure (structure.md)

- 新規ファイルの追加なし。既存ファイルの拡張のみ
- `src/types.ts` に型追加
- `src/storage/formatter.ts`, `src/storage/parser.ts` にフィールド追加
- `src/storage/markdown.ts` のメソッド修正
- `src/cli/context.ts`, `src/cli/analyze.ts` のロジック修正
- `src/analyzer/gemini.ts` のプロンプト修正
- `src/tools/save.ts`, `src/tools/search.ts`, `src/tools/getContext.ts` のスキーマ・ハンドラ修正

## Code Reuse Analysis

### Existing Components to Leverage

- **MarkdownStorage**: 既存のsave/search/getContext/readCategoryメソッドをそのまま拡張。新規クラス不要
- **parseMarkdown / formatEntry**: 既存のMarkdownパース・フォーマットロジックにproject/scope対応を追加
- **Analyzer**: 既存のanalyze()メソッドとANALYSIS_PROMPTを拡張してscope判定を追加
- **findProjectRoot**: プロジェクトルート探索はそのまま利用

### Integration Points

- **MCPツールスキーマ**: memory_save, memory_search のinputSchemaにproject/scopeパラメータ追加
- **Markdown形式**: エントリのメタデータ行にproject/scope追加。後方互換性を維持
- **SessionStart CLI**: 出力形式をdont全件+config全文（タイトル+内容）に変更
- **Stop Hook CLI**: Gemini分析結果にscopeを追加し、cwdからprojectを自動取得して保存

## Architecture

変更はすべて既存モジュール内の拡張。レイヤー構成は変わらない。

```
変更の影響範囲:

src/types.ts ────────────────── 型定義にproject/scope追加
    ↓
src/storage/formatter.ts ────── formatEntryにproject/scope出力追加
src/storage/parser.ts ──────── parseMarkdownにproject/scopeパース追加
    ↓
src/storage/markdown.ts ─────── save/search/getContext修正
    ↓
src/tools/save.ts ──────────── scopeパラメータ追加
src/tools/search.ts ────────── project/scopeフィルタ追加
src/tools/getContext.ts ─────── 出力形式変更（dont全件+configタイトル一覧）
    ↓
src/cli/context.ts ──────────── SessionStart出力変更
src/cli/analyze.ts ──────────── project/scope付与して保存
    ↓
src/analyzer/gemini.ts ──────── ANALYSIS_PROMPTにscope判定追加
src/config.ts ───────────────── getGlobalMemoryPath()廃止
```

## Components and Interfaces

### C1: 型定義の拡張（src/types.ts）

- **Purpose:** MemoryEntry/MemoryIndexEntry/SaveParams/SearchParams/AnalysisResultにproject/scopeフィールドを追加
- **変更箇所:**
  - `MemoryEntry` に `project?: string` と `scope?: string` を追加
  - `MemoryIndexEntry` に `project?: string` と `scope?: string` を追加
  - `SaveParams` に `project?: string` と `scope?: string` を追加
  - `SearchParams` に `project?: string` と `scope?: string` を追加
  - `AnalysisResult` に `scope?: string` を追加
  - 新しい型 `MemoryScope` を追加

### C2: Markdownフォーマッタの拡張（src/storage/formatter.ts）

- **Purpose:** エントリ出力にproject/scopeメタデータ行を追加
- **変更箇所:** `formatEntry()` 関数
- **変更内容:** project/scopeが存在する場合のみメタデータ行を出力
- **出力例:**
  ```markdown
  ## API URLの指定

  - **id**: ml9qhrd9-63ad
  - **timestamp**: 2026-02-06T17:32:13.389+09:00
  - **category**: config
  - **project**: yakusoku
  - **scope**: backend
  - **tags**: API, URL, config
  - **content**: APIのベースURLは https://api.example.com/v1

  ---
  ```

### C3: Markdownパーサーの拡張（src/storage/parser.ts）

- **Purpose:** project/scopeメタデータ行のパース対応
- **変更箇所:** `parseMarkdown()` 関数
- **変更内容:** `- **project**:` と `- **scope**:` 行を認識してMemoryEntryに設定
- **後方互換性:** project/scopeがないエントリはundefinedのまま。パースエラーにはならない

### C4: ストレージの修正（src/storage/markdown.ts）

- **Purpose:** save/search/getContextの動作変更
- **変更箇所:**
  - `save()`: SaveParamsからproject/scopeを受け取りMemoryEntryに設定
  - `search()`: project/scopeフィルタリング追加
  - `getContext()`: グローバルパス廃止、dont全件+config全文+projectフィルタ

#### save()の変更

```typescript
// SaveParamsのproject/scopeをMemoryEntryに反映
const entry: MemoryEntry = {
  id,
  timestamp,
  category: params.category,
  content: params.content,
  title: params.title,
  tags: params.tags || [],
  project: params.project,     // 追加
  scope: params.scope           // 追加
};
```

#### search()の変更

```typescript
// 既存のqueryフィルタの後にproject/scopeフィルタを追加
let filtered = allEntries.filter(entry =>
  entry.title.toLowerCase().includes(query) ||
  entry.content.toLowerCase().includes(query) ||
  entry.tags.some(tag => tag.toLowerCase().includes(query))
);

// projectフィルタ
if (params.project) {
  filtered = filtered.filter(entry =>
    !entry.project || entry.project === params.project
  );
}

// scopeフィルタ
if (params.scope) {
  filtered = filtered.filter(entry =>
    !entry.scope || entry.scope === "general" || entry.scope === params.scope
  );
}
```

**projectフィルタのロジック**: `!entry.project`（project未指定=全プロジェクト共通）OR `entry.project === params.project`（指定プロジェクト一致）

#### getContext()の変更

```typescript
async getContext(currentProject?: string): Promise<ContextResult> {
  await this.initialize();

  // configエントリ: projectフィルタ後にタイトル+内容を返却
  const configEntries = await this.readCategory("config");
  const filteredConfig = currentProject
    ? configEntries.filter(e => !e.project || e.project === currentProject)
    : configEntries;
  const configFormatted = filteredConfig
    .map(e => `### ${e.title}\n${e.content}`)
    .join("\n\n");

  // dontエントリ: projectフィルタ後に全件の内容を返却
  const dontEntries = await this.readCategory("dont");
  const filteredDont = currentProject
    ? dontEntries.filter(e => !e.project || e.project === currentProject)
    : dontEntries;
  const dontFormatted = filteredDont.map(e => formatEntry(e)).join("");

  return {
    config: configFormatted || "（設定情報なし）",
    dont: dontFormatted || "（ルールなし）",
  };
}
```

### C5: memory_saveツールの修正（src/tools/save.ts）

- **Purpose:** scopeパラメータの追加
- **変更箇所:**
  - `memorySaveTool` のinputSchemaにscope追加
  - `handleMemorySave()` でscope + project（cwdから自動取得）をSaveParamsに設定
- **projectの取得方法:** `projectRoot` のベースディレクトリ名（`path.basename(projectRoot)`）

### C6: memory_searchツールの修正（src/tools/search.ts）

- **Purpose:** project/scopeフィルタパラメータの追加
- **変更箇所:**
  - `memorySearchTool` のinputSchemaにproject/scope追加
  - `handleMemorySearch()` でSearchParamsにproject/scope設定

### C7: memory_get_contextツールの修正（src/tools/getContext.ts）

- **Purpose:** 出力形式の変更（dont全件+config全文）
- **変更箇所:**
  - `handleMemoryGetContext()` でcurrentProject（projectRoot baseから取得）をgetContext()に渡す

### C8: SessionStart CLI修正（src/cli/context.ts）

- **Purpose:** 出力をconfig全文+dont全件+オーナープロフィールに変更、グローバルパス廃止
- **変更箇所:** `main()` 関数全体
- **変更内容:**
  - グローバルパス（`~/.wasurenagusa/global/`）の読み込みを削除
  - configはgetContext()経由でprojectフィルタ後にタイトル+内容を全文出力
  - dontはprojectフィルタ後に統合版（フォールバックで全件）出力
  - オーナープロフィール（owner-profile.md）を注入
  - 能動検索指示（memory_search利用ルール）を末尾に追加
  - 現在のprojectはcwdのベースディレクトリ名から取得

### C9: Stop Hook CLI修正（src/cli/analyze.ts）

- **Purpose:** 保存時にproject/scopeを自動付与
- **変更箇所:** `main()` 関数のsaveParams構築部分
- **変更内容:**
  - `project` はcwdのベースディレクトリ名から自動取得
  - `scope` はGemini分析結果から取得（AnalysisResultにscope追加）

### C10: Gemini分析プロンプト修正（src/analyzer/gemini.ts）

- **Purpose:** 会話分析でscopeを自動判定
- **変更箇所:** `ANALYSIS_PROMPT` 定数
- **変更内容:**
  - scope候補の説明を追加（frontend, backend, infra, design, spec, ai, general）
  - 出力JSONに`scope`フィールドを追加
  - 判定基準の説明を追加

### C11: config.ts修正

- **Purpose:** getGlobalMemoryPath()の廃止
- **変更箇所:** `getGlobalMemoryPath()` 関数を削除

## Data Models

### MemoryEntry（拡張後）

```typescript
export interface MemoryEntry {
  id: string;
  timestamp: string;
  category: MemoryCategory;
  content: string;
  tags: string[];
  title: string;
  project?: string;   // 追加: プロジェクト名（cwdのディレクトリ名）
  scope?: string;      // 追加: スコープ（frontend/backend/infra/design/spec/ai/general）
  intensity?: number;  // 追加: 怒られ度（1-10）
}
```

### MemoryIndexEntry（拡張後）

```typescript
export interface MemoryIndexEntry {
  id: string;
  timestamp: string;
  category: MemoryCategory;
  title: string;
  tags: string[];
  project?: string;   // 追加
  scope?: string;      // 追加
  intensity?: number;  // 追加
}
```

### SaveParams（拡張後）

```typescript
export interface SaveParams {
  category: MemoryCategory;
  content: string;
  title: string;
  tags?: string[];
  project?: string;   // 追加
  scope?: string;      // 追加
  replaceId?: string;  // 追加: 重複エントリの置換
  intensity?: number;  // 追加: 怒られ度（1-10）
}
```

### SearchParams（拡張後）

```typescript
export interface SearchParams {
  query: string;
  category?: MemoryCategory | "all";
  limit?: number;
  project?: string;   // 追加
  scope?: string;      // 追加
}
```

### AnalysisResult（拡張後）

```typescript
export interface AnalysisResult {
  shouldSave: boolean;
  category: MemoryCategory | null;
  title: string | null;
  summary: string | null;
  tags: string[];
  reason: string;
  scope?: string;        // 追加
  replaceId?: string;    // 追加: 重複エントリのID
  intensity?: number;    // 追加: 怒られ度（1-5、dontのみ。LLM自動判定）
  knowledgeGap?: string[]; // 追加: dontカテゴリ時の知識の穴（具体的知識項目リスト）
  sessionTopic?: string; // 追加: セッションのトピック要約
}
```

### MemoryScope（新規）

```typescript
export type MemoryScope = "frontend" | "backend" | "infra" | "design" | "spec" | "ai" | "general";
```

※ `MemoryScope`は推奨候補の型定義だが、実際のscopeフィールドはstring型（自由入力許可）。

## Markdown Format（拡張後）

### 保存フォーマット

```markdown
## タイトル

- **id**: ml9qhrd9-63ad
- **timestamp**: 2026-02-06T17:32:13.389+09:00
- **category**: config
- **project**: yakusoku
- **scope**: backend
- **intensity**: 3
- **tags**: API, URL, config
- **content**: 内容テキスト

---
```

### 後方互換性

- project/scope行がない既存エントリもパース可能
- project未指定 → 全プロジェクト共通として扱う
- scope未指定 → "general"として扱う

## Error Handling

### Error Scenarios

1. **Geminiがscope判定に失敗**
   - **Handling:** scopeをundefined（= "general"扱い）にフォールバック
   - **User Impact:** なし（エントリは正常に保存される）

2. **既存エントリにproject/scopeがない**
   - **Handling:** parseMarkdownでundefinedのまま返却。フィルタ時は「全プロジェクト共通」として扱い、常に結果に含める
   - **User Impact:** なし（既存データはそのまま動作）

3. **projectフィルタ指定時に一致エントリがない**
   - **Handling:** 空の結果を返却（エラーにはしない）
   - **User Impact:** 検索結果が0件になるだけ

## Testing Strategy

### Unit Testing

- `parseMarkdown()`: project/scopeあり/なしのMarkdownをパースできること
- `formatEntry()`: project/scopeあり/なしのエントリを正しくフォーマットできること
- `search()`: project/scopeフィルタが正しく動作すること
  - projectフィルタ: 指定プロジェクト + project未指定エントリのみ返却
  - scopeフィルタ: 指定scope + general + scope未指定エントリのみ返却
- `getContext()`: dont全件 + config全文（タイトル+内容）が返却されること

### Integration Testing

- Stop Hook → Gemini分析 → project/scope付きで保存 → search で取得できること
- SessionStart → dont全件 + config全文（タイトル+内容）が出力されること

### End-to-End Testing

- 既存の `.wasurenagusa/` ファイルがproject/scope追加後も正常に読み込めること（後方互換性）
- 新規保存 → 検索 → 詳細取得の一連の流れでproject/scopeが保持されること
