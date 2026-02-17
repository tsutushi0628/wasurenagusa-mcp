# Tasks: project-scope-memory

- [x]1. 型定義にproject/scope追加
  - File: src/types.ts
  - MemoryEntry, MemoryIndexEntry, SaveParams, SearchParams, AnalysisResultにproject/scopeフィールド追加
  - MemoryScope型を新規定義
  - Purpose: 全モジュール共通の型基盤を先に確立
  - _Leverage: 既存の型定義をそのまま拡張_
  - _Requirements: R1, R2, R5_
  - _Prompt: Role: TypeScript Developer | Task: src/types.tsの既存インターフェース（MemoryEntry, MemoryIndexEntry, SaveParams, SearchParams, AnalysisResult）にproject?: stringとscope?: stringをオプショナルで追加。MemoryScope型を新規定義。既存フィールドは一切変更しない | Restrictions: 後方互換性を維持、既存フィールドの削除・変更禁止 | Success: tscでコンパイルエラーなし、既存コードが型変更で壊れない_

- [x]2. Markdownフォーマッタにproject/scope出力追加
  - File: src/storage/formatter.ts
  - formatEntry()でproject/scopeメタデータ行を出力（存在する場合のみ）
  - Purpose: 保存時にproject/scopeがMarkdownに記録されるようにする
  - _Leverage: 既存のformatEntry()関数を拡張_
  - _Requirements: R1_
  - _Prompt: Role: TypeScript Developer | Task: src/storage/formatter.tsのformatEntry()を修正し、entry.projectが存在する場合は`- **project**: ${entry.project}`行を、entry.scopeが存在する場合は`- **scope**: ${entry.scope}`行をcategory行の後に出力 | Restrictions: project/scopeがundefinedの場合は行を出力しない（後方互換性）、既存のメタデータ行順序を保持 | Success: project/scopeありのエントリで正しいMarkdown出力、なしのエントリで既存と同一出力_

- [x]3. Markdownパーサーにproject/scopeパース追加
  - File: src/storage/parser.ts
  - parseMarkdown()で`- **project**:`と`- **scope**:`行を認識
  - Purpose: 保存済みエントリからproject/scopeを復元できるようにする
  - _Leverage: 既存のparseMarkdown()関数を拡張_
  - _Requirements: R1, R5_
  - _Prompt: Role: TypeScript Developer | Task: src/storage/parser.tsのparseMarkdown()に`- **project**:`と`- **scope**:`行のパース処理を追加。既存のid/timestamp/tags/content行パースと同じパターンで実装 | Restrictions: project/scope行がない既存エントリでもパースエラーにならないこと | Success: project/scopeあり/なし両方のMarkdownを正しくパースできる_

- [x]4. MarkdownStorage.save()にproject/scope反映
  - File: src/storage/markdown.ts
  - save()メソッドでSaveParamsのproject/scopeをMemoryEntryに設定
  - Purpose: 保存時にproject/scopeがエントリに含まれるようにする
  - _Leverage: 既存のsave()メソッドを拡張_
  - _Requirements: R1_
  - _Prompt: Role: TypeScript Developer | Task: src/storage/markdown.tsのsave()メソッドで、MemoryEntry構築時にparams.projectとparams.scopeを設定する | Restrictions: 最小限の変更のみ、既存のsaveロジック（ID生成・タイムスタンプ・ファイル書き込み）は変更しない | Success: SaveParamsにproject/scopeを渡すと、保存されたMarkdownにproject/scope行が含まれる_

- [x]5. MarkdownStorage.search()にproject/scopeフィルタ追加
  - File: src/storage/markdown.ts
  - search()メソッドにprojectフィルタとscopeフィルタを追加
  - MemoryIndexEntryにもproject/scopeを含める
  - Purpose: 検索時にプロジェクト・スコープで絞り込めるようにする
  - _Leverage: 既存のsearch()メソッドを拡張_
  - _Requirements: R4_
  - _Prompt: Role: TypeScript Developer | Task: src/storage/markdown.tsのsearch()に、params.project指定時は`!entry.project || entry.project === params.project`でフィルタ、params.scope指定時は`!entry.scope || entry.scope === "general" || entry.scope === params.scope`でフィルタする処理を追加。indexEntriesにもproject/scopeを含める | Restrictions: projectフィルタ未指定時は全件対象（既存動作維持） | Success: project/scopeフィルタが正しく動作し、project未指定エントリは常に結果に含まれる_

- [x]6. MarkdownStorage.getContext()をdont全件+configタイトル一覧に変更
  - File: src/storage/markdown.ts
  - getContext()をcurrentProject引数追加、グローバルパス廃止
  - dont: projectフィルタ後に全件内容を返却
  - config: projectフィルタ後にタイトル一覧のみ返却
  - Purpose: SessionStart時のコンテキスト注入を最小化
  - _Leverage: 既存のgetContext(), readCategory(), readFileIfExists()_
  - _Requirements: R3, R4_
  - _Prompt: Role: TypeScript Developer | Task: src/storage/markdown.tsのgetContext()を修正。(1)currentProject?: string引数追加 (2)グローバルパス読み込み削除 (3)configはreadCategory("config")→projectフィルタ→タイトル一覧文字列 (4)dontはreadCategory("dont")→projectフィルタ→formatEntryで全件内容 | Restrictions: ContextResult型は変更不要（config: string, dont: stringのまま） | Success: dont全件内容+configタイトル一覧が返却される。グローバルパスへのアクセスなし_

- [x]7. config.tsからgetGlobalMemoryPath()を削除
  - File: src/config.ts
  - getGlobalMemoryPath()関数を削除
  - 参照箇所がないことを確認
  - Purpose: シンボリックリンク集約により不要になったグローバルパス関数を廃止
  - _Leverage: なし（削除のみ）_
  - _Requirements: R3_
  - _Prompt: Role: TypeScript Developer | Task: src/config.tsからgetGlobalMemoryPath()関数を削除。homedir importも不要になれば削除 | Restrictions: getMemoryPath()は残す。他のファイルでgetGlobalMemoryPathを参照していないか確認してから削除 | Success: getGlobalMemoryPath()が削除され、tscでコンパイルエラーなし_

- [x]8. memory_saveツールにscopeパラメータ追加
  - File: src/tools/save.ts
  - memorySaveTool inputSchemaにscope追加
  - handleMemorySave()でscope + project（basename(projectRoot)）をSaveParamsに設定
  - Purpose: 手動保存時にscopeを指定可能にし、projectを自動付与する
  - _Leverage: 既存のmemorySaveTool, handleMemorySave()_
  - _Requirements: R1_
  - _Prompt: Role: TypeScript Developer | Task: src/tools/save.tsの(1)memorySaveTool.inputSchemaにscope(string, optional, 候補一覧をdescriptionに記載)を追加 (2)handleMemorySave()でparams.scope = args.scope, params.project = path.basename(projectRoot)を設定 | Restrictions: scopeは完全にオプション、未指定時はundefined（"general"扱いはパーサー側） | Success: memory_saveでscope指定可能、projectが自動付与される_

- [x]9. memory_searchツールにproject/scopeフィルタ追加
  - File: src/tools/search.ts
  - memorySearchTool inputSchemaにproject/scope追加
  - handleMemorySearch()でSearchParamsにproject/scope設定
  - Purpose: 検索時にプロジェクト・スコープで絞り込み可能にする
  - _Leverage: 既存のmemorySearchTool, handleMemorySearch()_
  - _Requirements: R4_
  - _Prompt: Role: TypeScript Developer | Task: src/tools/search.tsの(1)memorySearchTool.inputSchemaにproject(string, optional)とscope(string, optional)を追加 (2)handleMemorySearch()でparams.project = args.project, params.scope = args.scopeを設定 | Restrictions: 両方オプション、未指定時はフィルタなし | Success: memory_searchでproject/scopeフィルタが使える_

- [x]10. memory_get_contextツールにprojectフィルタ追加
  - File: src/tools/getContext.ts
  - handleMemoryGetContext()でcurrentProject（basename(projectRoot)）をgetContext()に渡す
  - Purpose: MCPツール経由でもprojectフィルタが効くようにする
  - _Leverage: 既存のhandleMemoryGetContext()_
  - _Requirements: R3_
  - _Prompt: Role: TypeScript Developer | Task: src/tools/getContext.tsのhandleMemoryGetContext()でconst currentProject = path.basename(projectRoot)を取得し、storage.getContext(currentProject)に渡す | Restrictions: 最小限の変更のみ | Success: MCPツール経由でもprojectフィルタが動作する_

- [x]11. SessionStart CLI（context.ts）をdont全件+configタイトル一覧に変更
  - File: src/cli/context.ts
  - グローバルパス読み込みを削除
  - configはparseMarkdown後にprojectフィルタ→タイトル一覧のみ出力
  - dontはprojectフィルタ後に全件出力
  - currentProjectはcwdのbasename
  - Purpose: SessionStart Hookの出力を最小化
  - _Leverage: parseMarkdown, formatEntry（storage/から import）_
  - _Requirements: R3_
  - _Prompt: Role: TypeScript Developer | Task: src/cli/context.tsのmain()を修正。(1)グローバルパス(homedir/.wasurenagusa/global/)の読み込みを全て削除 (2)currentProject = path.basename(cwd)で取得 (3)config.mdをparseMarkdownでパース→projectフィルタ→タイトルとIDの一覧のみ出力 (4)dont.mdをparseMarkdownでパース→projectフィルタ→全件内容出力 | Restrictions: homedir importも不要になれば削除 | Success: SessionStart時にdont全件+configタイトル一覧のみ出力。トークン消費が削減される_

- [x]12. Geminiプロンプトにscope判定追加
  - File: src/analyzer/gemini.ts
  - ANALYSIS_PROMPTにscope候補の説明と判定基準を追加
  - 出力JSONにscopeフィールドを追加
  - Purpose: Stop Hook時にGeminiがscopeを自動判定できるようにする
  - _Leverage: 既存のANALYSIS_PROMPT_
  - _Requirements: R1, R2_
  - _Prompt: Role: Prompt Engineer | Task: src/analyzer/gemini.tsのANALYSIS_PROMPTに(1)scope候補の定義（frontend/backend/infra/design/spec/ai/general）と各候補の判定基準を追加 (2)出力JSONフォーマットにscope(string)を追加 (3)判定に迷う場合は"general"を指定する旨を追記 | Restrictions: 既存のカテゴリ判定ロジックは変更しない | Success: Geminiがscopeを正しく判定し、AnalysisResult.scopeに値が入る_

- [x]13. Stop Hook CLI（analyze.ts）にproject/scope付与を追加
  - File: src/cli/analyze.ts
  - 保存時にproject（cwdのbasename）とscope（Gemini分析結果）をSaveParamsに設定
  - Purpose: 自動保存時にproject/scopeが自動付与されるようにする
  - _Leverage: 既存のmain()のsaveParams構築部分_
  - _Requirements: R1_
  - _Prompt: Role: TypeScript Developer | Task: src/cli/analyze.tsのmain()で、saveParams構築時にproject: path.basename(projectRoot)とscope: analysis.scopeを追加 | Restrictions: 最小限の変更のみ | Success: Stop Hook経由の自動保存でproject/scopeがエントリに含まれる_

- [x]14. ビルド確認
  - tscでコンパイルエラーがないことを確認
  - Purpose: 全変更の整合性確認
  - _Requirements: All_
  - _Prompt: Role: TypeScript Developer | Task: npm run buildを実行し、コンパイルエラーがないことを確認。エラーがあれば修正 | Restrictions: ロジックの変更は行わない、型エラーの修正のみ | Success: tscが正常終了する_
