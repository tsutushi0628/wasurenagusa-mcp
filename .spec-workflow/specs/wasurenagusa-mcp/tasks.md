# Tasks Document: wasurenagusa-mcp

**参照ドキュメント**: [spec.md](../../../docs/spec.md) | [requirements.md](./requirements.md) | [design.md](./design.md)

---

## Phase 1: 基盤層

- [x] 1.1 型定義の作成
  - **File**: `src/types.ts`
  - **内容**: MemoryCategory, MemoryEntry, SaveParams, SearchParams, GetDetailParams, AnalysisResult等の全型定義
  - **参照**: [spec.md#src/types.ts](../../../docs/spec.md) のコード
  - **完了条件**: `tsc --noEmit` でエラーなし
  - _Requirements: 全REQ共通_

- [x] 1.2 設定管理の作成
  - **File**: `src/config.ts`
  - **内容**: memoryDir, globalDir等の設定定数
  - **参照**: [spec.md#src/config.ts](../../../docs/spec.md) のコード
  - **完了条件**: config.memoryDir が ".wasurenagusa" を返す
  - _Requirements: REQ-9, REQ-10_

- [x] 1.3 プロジェクトルート探索ユーティリティの作成
  - **File**: `src/utils/projectRoot.ts`
  - **内容**: findProjectRoot関数（.git探索、cwdフォールバック）
  - **参照**: [spec.md#src/utils/projectRoot.ts](../../../docs/spec.md) のコード
  - **完了条件**: .gitがあるディレクトリを正しく返す、なければcwdを返す
  - _Requirements: REQ-8_

---

## Phase 2: ストレージ層

- [x] 2.1 MarkdownStorageクラスの作成（基本構造）
  - **File**: `src/storage/markdown.ts`
  - **内容**: クラス定義、コンストラクタ、private memoryPath
  - **参照**: [spec.md#src/storage/markdown.ts](../../../docs/spec.md) のコード
  - **完了条件**: `new MarkdownStorage(projectRoot)` でインスタンス化可能
  - _Requirements: REQ-9_

- [x] 2.2 MarkdownStorage.save メソッド実装
  - **File**: `src/storage/markdown.ts`
  - **内容**: カテゴリ別ファイルへの追記、UUID生成、Markdown形式整形
  - **参照**: [spec.md#src/storage/markdown.ts](../../../docs/spec.md) の save メソッド
  - **完了条件**: config.mdにエントリが正しく追記される
  - _Requirements: REQ-5_

- [x] 2.3 MarkdownStorage.search メソッド実装
  - **File**: `src/storage/markdown.ts`
  - **内容**: 全カテゴリ検索、軽量インデックス返却（ID,title,category,tagsのみ）
  - **参照**: [spec.md#src/storage/markdown.ts](../../../docs/spec.md) の search メソッド
  - **完了条件**: 検索結果にcontentが含まれない、50-80 tokens/件相当
  - _Requirements: REQ-6_

- [x] 2.4 MarkdownStorage.getDetail メソッド実装
  - **File**: `src/storage/markdown.ts`
  - **内容**: ID指定でフル詳細取得、複数ID一括取得対応
  - **参照**: [spec.md#src/storage/markdown.ts](../../../docs/spec.md) の getDetail メソッド
  - **完了条件**: 指定IDのフルcontent含む詳細が返る
  - _Requirements: REQ-7_

- [x] 2.5 MarkdownStorage.getContext メソッド実装
  - **File**: `src/storage/markdown.ts`
  - **内容**: config.md + dont.md の読み込み（プロジェクト+グローバル両方）
  - **参照**: [spec.md#src/storage/markdown.ts](../../../docs/spec.md) の getContext メソッド
  - **完了条件**: プロジェクト固有とグローバル両方のconfig/dontが取得できる
  - _Requirements: REQ-4, REQ-10_

- [x] 2.6 storage/index.ts エクスポート作成
  - **File**: `src/storage/index.ts`
  - **内容**: MarkdownStorageのre-export
  - **完了条件**: `import { MarkdownStorage } from "./storage/index.js"` が動作
  - _Requirements: 全REQ共通_

---

## Phase 3: 分析層

- [x] 3.1 GeminiAnalyzerクラスの作成
  - **File**: `src/analyzer/gemini.ts`
  - **内容**: Gemini API呼び出し、ANALYSIS_PROMPTによる判定、JSON応答パース
  - **参照**: [spec.md#src/analyzer/gemini.ts](../../../docs/spec.md) のコード
  - **完了条件**: analyze()がAnalysisResult型を返す
  - _Requirements: REQ-3_

- [x] 3.2 analyzer/index.ts エクスポート作成
  - **File**: `src/analyzer/index.ts`
  - **内容**: GeminiAnalyzerのre-export
  - **完了条件**: `import { GeminiAnalyzer } from "./analyzer/index.js"` が動作
  - _Requirements: REQ-3_

---

## Phase 4: MCPツール層

- [x] 4.1 memory_get_context ツール実装
  - **File**: `src/tools/getContext.ts`
  - **内容**: ツール定義（memoryGetContextTool）+ ハンドラー（handleMemoryGetContext）
  - **参照**: [spec.md#src/tools/getContext.ts](../../../docs/spec.md) のコード
  - **完了条件**: MCPツールとして登録可能、config+dontをJSON返却
  - _Requirements: REQ-4_

- [x] 4.2 memory_save ツール実装
  - **File**: `src/tools/save.ts`
  - **内容**: ツール定義（memorySaveTool）+ ハンドラー（handleMemorySave）
  - **参照**: [spec.md#src/tools/save.ts](../../../docs/spec.md) のコード
  - **完了条件**: category, title, content, tagsを受け取り保存成功
  - _Requirements: REQ-5_

- [x] 4.3 memory_search ツール実装
  - **File**: `src/tools/search.ts`
  - **内容**: ツール定義（memorySearchTool）+ ハンドラー（handleMemorySearch）
  - **参照**: [spec.md#src/tools/search.ts](../../../docs/spec.md) のコード
  - **完了条件**: query検索で軽量インデックス（ID,title,category,tags）のみ返却
  - _Requirements: REQ-6_

- [x] 4.4 memory_get_detail ツール実装
  - **File**: `src/tools/getDetail.ts`
  - **内容**: ツール定義（memoryGetDetailTool）+ ハンドラー（handleMemoryGetDetail）
  - **参照**: [spec.md#src/tools/getDetail.ts](../../../docs/spec.md) のコード
  - **完了条件**: ids配列でフル詳細を一括取得
  - _Requirements: REQ-7_

- [x] 4.5 tools/index.ts エクスポート作成
  - **File**: `src/tools/index.ts`
  - **内容**: 4ツールのre-export
  - **参照**: [spec.md#src/tools/index.ts](../../../docs/spec.md) のコード
  - **完了条件**: 全ツール定義とハンドラーがimport可能
  - _Requirements: 全REQ共通_

---

## Phase 5: CLI層（Hooks用）

- [x] 5.1 wasurenagusa-context CLI作成
  - **File**: `src/cli/context.ts`
  - **内容**: stdin JSON読み取り、cwd取得、config/dont読み込み、stdout出力
  - **参照**: [spec.md#src/cli/context.ts](../../../docs/spec.md) のコード
  - **完了条件**:
    - `echo '{"cwd":"/path"}' | node dist/cli/context.js` でMarkdown出力
    - stdin空でもprocess.cwd()フォールバック
  - _Requirements: REQ-1_

- [x] 5.2 wasurenagusa-analyze CLI作成
  - **File**: `src/cli/analyze.ts`
  - **内容**: stdin JSON読み取り、stop_hook_activeチェック、transcript読み込み、Gemini分析、保存
  - **参照**: [spec.md#src/cli/analyze.ts](../../../docs/spec.md) のコード
  - **完了条件**:
    - stop_hook_active=true で即終了
    - GEMINI_API_KEY未設定で即終了
    - 分析結果に応じて保存実行
  - _Requirements: REQ-2, REQ-3_

---

## Phase 6: MCPサーバー

- [x] 6.1 MCPサーバーエントリポイント作成
  - **File**: `src/index.ts`
  - **内容**: Server初期化、4ツール登録、CallToolRequestハンドラー、STDIO Transport接続
  - **参照**: [spec.md#src/index.ts](../../../docs/spec.md) のコード
  - **完了条件**: `node dist/index.js` でサーバー起動、stderrに "wasurenagusa-mcp server started" 出力
  - _Requirements: 全REQ共通_

---

## Phase 7: パッケージング

- [x] 7.1 package.json作成
  - **File**: `package.json`
  - **内容**: name, version, type:module, bin定義（3コマンド）, dependencies
  - **参照**: [spec.md#package.json](../../../docs/spec.md) のコード
  - **完了条件**: `npm install` 成功
  - _Requirements: 全REQ共通_

- [x] 7.2 tsconfig.json作成
  - **File**: `tsconfig.json`
  - **内容**: target:ES2022, module:NodeNext, outDir:dist, strict:true
  - **参照**: [spec.md#tsconfig.json](../../../docs/spec.md) のコード
  - **完了条件**: `npm run build` 成功、dist/以下に.jsファイル生成
  - _Requirements: 全REQ共通_

- [x] 7.3 .env.example作成
  - **File**: `.env.example`
  - **内容**: GEMINI_API_KEY=your_key_here
  - **完了条件**: ファイル存在
  - _Requirements: REQ-3_

---

## Phase 8: 統合テスト

- [x] 8.1 ビルド・起動確認
  - **作業**: npm install && npm run build && node dist/index.js
  - **完了条件**: エラーなくサーバー起動
  - _Requirements: 全REQ共通_

- [x] 8.2 MCPツール動作確認
  - **作業**: claude mcp add でサーバー登録、各ツール呼び出しテスト
  - **完了条件**:
    - memory_save で保存成功
    - memory_search で検索成功（軽量インデックスのみ）
    - memory_get_detail でフル詳細取得成功
    - memory_get_context でconfig+dont取得成功
  - _Requirements: REQ-4, REQ-5, REQ-6, REQ-7_

- [x] 8.3 CLI動作確認
  - **作業**: wasurenagusa-context / wasurenagusa-analyze の手動実行テスト
  - **完了条件**:
    - context: Markdown形式でconfig/dont出力
    - analyze: GEMINI_API_KEY設定時に分析・保存動作
  - _Requirements: REQ-1, REQ-2_

- [x] 8.4 Hooks連携確認
  - **作業**: ~/.claude/settings.json にHooks設定、Claude Code起動テスト
  - **完了条件**:
    - SessionStart時にconfig/dontがコンテキスト注入
    - Stop時に自動分析が動作（APIキー設定時）
  - _Requirements: REQ-1, REQ-2_

---

## 進捗サマリー

| Phase | 完了 | 総数 |
|-------|------|------|
| Phase 1: 基盤層 | 3 | 3 |
| Phase 2: ストレージ層 | 6 | 6 |
| Phase 3: 分析層 | 2 | 2 |
| Phase 4: MCPツール層 | 5 | 5 |
| Phase 5: CLI層 | 2 | 2 |
| Phase 6: MCPサーバー | 1 | 1 |
| Phase 7: パッケージング | 3 | 3 |
| Phase 8: 統合テスト | 4 | 4 |
| **合計** | **26** | **26** |
