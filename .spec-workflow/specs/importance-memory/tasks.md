# Tasks: 記憶の強弱システム（importance field）

- [x] 1. 型定義にimportanceフィールドを追加
  - File: src/types.ts
  - `MemoryEntry`, `MemoryIndexEntry`, `SaveParams`, `AnalysisResult` に `importance?: "critical" | "normal"` を追加
  - Purpose: 全コンポーネントの基盤となる型安全性を確立
  - _Requirements: 1, 2, 5_
  - _Prompt: Role: TypeScript Developer | Task: src/types.tsの4つのインターフェース（MemoryEntry, MemoryIndexEntry, SaveParams, AnalysisResult）にimportanceオプショナルフィールドを追加する。型は "critical" | "normal" のユニオンリテラル型 | Restrictions: 既存フィールドを変更しない。optionalで追加し後方互換性を維持する | Success: npx tsc が通る_

- [x] 2. storage/formatter.ts にimportance出力を追加 + テスト
  - File: src/storage/formatter.ts, src/storage/formatter.test.ts
  - `formatEntry()` で `entry.importance === "critical"` の場合のみ `- **importance**: critical` 行を出力する。scopeStrの後、tagsStrの前に配置
  - テスト: importance: "critical" のエントリ → importance行あり / importance: "normal" → importance行なし / importance: undefined → importance行なし
  - Purpose: criticalエントリのみMarkdownに記録し、ファイルサイズを抑えつつ後方互換性を維持
  - _Requirements: 5.1_
  - _Prompt: Role: Backend Developer | Task: formatEntry()にimportance出力を追加。criticalの場合のみ `- **importance**: critical` を出力。テストも追加 | Restrictions: "normal"やundefinedでは行を出力しない。既存のフォーマット順序を崩さない | Success: テスト全パス + npx tsc通過_

- [x] 3. storage/parser.ts にimportanceパースを追加 + テスト
  - File: src/storage/parser.ts, src/storage/markdown.test.ts (パーサーテストはmarkdown.test.ts内)
  - `parseMarkdown()` のメタデータパース部に `- **importance**:` 行のハンドリングを追加
  - 検出時: MemoryEntry に importance フィールドをセット
  - 未検出時: importance は undefined のまま（既存エントリとの後方互換性）
  - テスト: importance行ありのMarkdown → importance取得可 / importance行なし → undefined
  - Purpose: Markdownから永続化されたimportance情報を復元する
  - _Leverage: src/storage/parser.ts の既存メタデータパースパターン（scope, project等）_
  - _Requirements: 5.2, 5.3_
  - _Prompt: Role: Backend Developer | Task: parseMarkdown()にimportanceメタデータ行のパースを追加。`- **importance**:` パターンに一致する行を検出し、MemoryEntryのimportanceフィールドにセットする | Restrictions: 既存のパースロジックを壊さない。未検出時はundefined（デフォルトnormal扱いは呼び出し側の責務） | Success: テスト全パス_

- [x] 4. MarkdownStorage.save() にimportance反映を追加
  - File: src/storage/markdown.ts
  - `save()` メソッドでMemoryEntry構築時に `params.importance` をセット
  - `search()` メソッドの `MemoryIndexEntry` マッピングに `importance` を追加
  - テスト: importance付きで保存 → readCategory → importance取得可（既存テストファイルに追加）
  - Purpose: 保存・検索の両方でimportanceを正しく伝播する
  - _Leverage: src/storage/markdown.ts の既存save/searchパターン_
  - _Requirements: 2.3, 5.4_
  - _Prompt: Role: Backend Developer | Task: MarkdownStorage.save()でSaveParams.importanceをMemoryEntryに渡す。search()でMemoryIndexEntryにimportanceを含める | Restrictions: replaceEntry()でもimportanceを保持すること。既存のテストを壊さない | Success: テスト全パス + importance付き保存→検索の往復テスト成功_

- [x] 5. memory_saveツールにimportanceパラメータを追加
  - File: src/tools/save.ts
  - `memorySaveTool.inputSchema.properties` に `importance` パラメータ追加（enum: ["critical", "normal"]）
  - `handleMemorySave()` で `args.importance` を `SaveParams.importance` に渡す
  - Purpose: ユーザーが手動でimportanceを指定できるようにする
  - _Requirements: 2.1, 2.2_
  - _Prompt: Role: Backend Developer | Task: memorySaveToolのinputSchemaにimportanceオプショナルパラメータを追加し、handleMemorySaveでSaveParamsに渡す | Restrictions: デフォルト値の設定はしない（undefinedのまま渡し、downstream側でnormal扱い） | Success: npx tsc通過_

- [x] 6. analysis.txtプロンプトにimportance判定を追加
  - File: prompts/analysis.txt
  - 出力JSONスキーマに `"importance": "critical" | "normal"` フィールドを追加
  - critical判定基準を記述：
    1. 「絶対〜するな」「二度と〜するな」等の強い禁止表現
    2. ユーザーの感情強度が非常に高い（怒り・失望のピーク）
    3. 具体的かつ反復的に同一の問題を指摘している
  - dont以外のカテゴリは常に `"normal"` と明示
  - Purpose: LLMがimportanceを適切に判定できるようにする
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_
  - _Prompt: Role: Prompt Engineer | Task: analysis.txtの出力JSONスキーマにimportanceフィールドを追加し、critical/normalの判定基準を明示する。few-shotの出力例もimportance付きに更新する | Restrictions: 既存の分析ロジック（shouldSave, category等）に影響しない。dontカテゴリ以外は常にnormal | Success: プロンプト記述が明確で、LLMが一貫した判定を出せる基準になっている_

- [x] 7. cli/analyze.ts でAnalysisResult.importanceをSaveParamsに伝播
  - File: src/cli/analyze.ts
  - `analysis.importance` を `saveParams.importance` に渡す
  - Purpose: 自動分析→保存フローでimportanceが失われないようにする
  - _Requirements: 1.1_
  - _Prompt: Role: Backend Developer | Task: analyze.tsのsaveParams構築部で analysis.importance を SaveParams.importance に渡す | Restrictions: 1行の変更のみ。importanceがundefinedでも安全 | Success: npx tsc通過_

- [x] 8. consolidate-worker.ts でcriticalエントリを統合から除外
  - File: src/cli/consolidate-worker.ts
  - dont統合セクションで、`storage.readDontEntries()` 後に `entry.importance !== "critical"` でフィルタ
  - フィルタ後のエントリが0件なら統合をスキップ
  - Purpose: criticalな具体的記憶が抽象原則に溶け込むことを防ぐ
  - _Requirements: 3.1, 3.2, 3.3_
  - _Prompt: Role: Backend Developer | Task: consolidate-worker.tsのdont統合セクションで、dontEntriesからimportance === "critical"のエントリを除外してからconsolidator.consolidate()に渡す。フィルタ後0件ならスキップ | Restrictions: DontConsolidatorクラス自体は変更しない。config統合には影響しない | Success: criticalエントリが統合入力に含まれない_

- [x] 9. context.ts を3層コンテキスト注入に拡張
  - File: src/cli/context.ts
  - `getDontContent()` を拡張して3層構造の文字列を構築する：
    - 層1: 既存の `formatConsolidatedDont()` 出力（変更なし）
    - 層2: `readDontEntries()` → importance === "critical" でフィルタ → タイトル+内容を出力
    - 層3: `readDontEntries()` → importance !== "critical" かつ timestamp が直近30日以内 かつ consolidated-dont.json の sourceIds に含まれないエントリ → タイトル+内容を出力
  - 層2/層3が空の場合はセクションごと省略
  - Purpose: 統合原則・永続的禁止・直近の鮮度の3層をバランスよく提供する
  - _Leverage: src/cli/context.ts の既存getDontContent(), src/storage/markdown.ts のreadDontEntries(), src/consolidator/staleness.ts のreadConsolidatedDont()_
  - _Requirements: 4.1, 4.2, 4.3, 4.4_
  - _Prompt: Role: Backend Developer | Task: context.tsのgetDontContent()を3層構造に拡張する。層1は既存（consolidated principles）、層2はcriticalエントリの具体的内容、層3は直近30日の未統合normalエントリ。各層にヘッダーを付与し、空の層は省略する | Restrictions: 層1の既存ロジックを壊さない。readDontEntries()は1回だけ呼ぶ（パフォーマンス）。consolidated-dont.jsonのsourceIdsを参照して「統合済み」判定する | Success: 3層が正しい順序で出力される。空の層は省略される。criticalエントリの内容が省略されずに表示される_

- [x] 10. 統合テスト: importance保存→統合除外→3層注入のE2Eテスト
  - File: src/storage/markdown.test.ts（既存テストファイルに追加）
  - テストシナリオ：
    1. importance: "critical" のdontエントリを保存
    2. importance: "normal" のdontエントリを保存
    3. readDontEntries() で両方取得し、importanceが正しく反映されていることを確認
    4. criticalフィルタ: filter(e => e.importance === "critical") で正しくフィルタリングできることを確認
  - Purpose: E2Eでimportanceの永続化とフィルタリングが正しく動作することを確認
  - _Requirements: All_
  - _Prompt: Role: QA Engineer | Task: importance機能の統合テストを作成。保存→パース→フィルタの一連の流れを検証する | Restrictions: 既存テストを壊さない。テストは独立して実行可能にする | Success: テスト全パス。importance付きエントリの往復（保存→読み込み→フィルタ）が正しく動作_
