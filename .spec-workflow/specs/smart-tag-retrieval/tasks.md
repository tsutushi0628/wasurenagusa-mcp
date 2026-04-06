# Tasks Document - Smart Tag Retrieval

## Phase 0: データモデル基盤

- [x] 1. WeightedTag型定義とタグパースユーティリティのテスト作成
  - File: `src/vector/weighted-tag.test.ts`
  - WeightedTag型のパース（"rate-limit:0.9" -> {tag, weight}）、フォーマット（{tag, weight} -> "rate-limit:0.9"）、後方互換（重みなし "Gemini" -> weight 1.0）、clamp(0.0, 1.0)のテストを作成
  - Purpose: タグの重み付き表現の正確な変換を保証する
  - _Requirements: REQ-1.2, REQ-1.3, design.md Component 4_
  - _Prompt: Role: TypeScript Developer specializing in TDD and data transformation | Task: Create unit tests for WeightedTag parsing/formatting. Test cases: (1) "tag:0.8" -> {tag:"tag", weight:0.8}, (2) "Gemini" -> {tag:"Gemini", weight:1.0} (backward compat), (3) weight clamp to [0.0, 1.0], (4) round-trip parse->format->parse, (5) empty/malformed input handling. Use Vitest. | Restrictions: Tests only, no implementation. Follow project's Vitest config. | Success: All test cases defined, covering happy path, backward compatibility, and edge cases_

- [x] 2. WeightedTag型定義とパース/フォーマットユーティリティの実装
  - File: `src/vector/weighted-tag.ts`, `src/types.ts`
  - WeightedTag interfaceをtypes.tsに追加。parseWeightedTag(), formatWeightedTag(), parseWeightedTags(), formatWeightedTags()を実装
  - Purpose: タグの重み付き表現をシステム全体で統一的に扱えるようにする
  - _Leverage: `src/types.ts`（既存型定義）, `src/storage/parser.ts`（タグパースの現行実装）_
  - _Requirements: REQ-1.2, design.md Data Models_
  - _Prompt: Role: TypeScript Developer | Task: (1) Add WeightedTag interface to types.ts: {tag: string, weight: number}. (2) Create src/vector/weighted-tag.ts with: parseWeightedTag("tag:0.8") -> {tag, weight}, formatWeightedTag({tag, weight}) -> "tag:0.8", parseWeightedTags(tags: string[]) -> WeightedTag[], formatWeightedTags(wt: WeightedTag[]) -> string[]. Backward compat: "Gemini" (no colon) -> weight 1.0. Clamp weight to [0.0, 1.0]. | Restrictions: Pure functions, no side effects. ESM imports with .js extension. | Success: Task 1 tests pass. Types compile without errors_

- [x] 3. parser.tsのタグパースを重み付き対応に拡張するテスト作成
  - File: `src/storage/parser-weighted-tag.test.ts`
  - 既存のタグ形式 "Gemini, API" と新形式 "Gemini:0.3, rate-limit:0.9" の両方をパースするテストを作成
  - Purpose: Markdownファイルからの読み込み時に重み付きタグが正しくパースされることを保証
  - _Leverage: `src/storage/parser.ts`（現行パーサー）_
  - _Requirements: REQ-1.2, design.md Component 4 後方互換性_
  - _Prompt: Role: QA Engineer | Task: Create tests for parser.ts weighted tag parsing. Test: (1) Legacy format "- **tags**: Gemini, API" parses as ["Gemini", "API"] (string[], backward compat), (2) New format "- **tags**: Gemini:0.3, rate-limit:0.9" parses as ["Gemini:0.3", "rate-limit:0.9"] (string[], weight preserved in string), (3) Mixed format works. The parser stores tags as string[] — weight extraction happens downstream via weighted-tag.ts. | Restrictions: Vitest. Do not modify parser.ts yet. | Success: Tests define expected behavior for both tag formats_

- [x] 4. formatter.tsのタグ出力を重み付き対応にするテスト作成と実装
  - File: `src/storage/formatter-weighted-tag.test.ts`, `src/storage/formatter.ts`
  - tags配列に "tag:weight" 形式の文字列が含まれる場合、そのまま出力されることを確認するテスト。formatterは既に `entry.tags.join(", ")` で出力しているため、変更不要の可能性が高いが、テストで確認する
  - Purpose: 重み付きタグの永続化がフォーマッターで正しく行われることを保証
  - _Leverage: `src/storage/formatter.ts`（現行フォーマッター, L7-9）_
  - _Requirements: REQ-1.2, design.md Component 4_
  - _Prompt: Role: QA Engineer | Task: Create test for formatter.ts confirming weighted tags are preserved. Test: formatEntry with tags=["Gemini:0.3", "rate-limit:0.9"] outputs "- **tags**: Gemini:0.3, rate-limit:0.9". Current formatter joins with ", " so this should work as-is. Verify and document. | Restrictions: Vitest. Minimal changes to formatter.ts (likely none needed). | Success: Test confirms weighted tags round-trip through formatter correctly_

## Phase 1: SearchScorer（pure function）

- [x] 5. SearchScorer freshness計算のテスト作成
  - File: `src/vector/search-scorer.test.ts`
  - freshness = max(0.7, e^(-0.693 * daysSinceLastAccess / halfLifeDays)) の計算精度テスト。0日=1.0, 14日(半減期)=~0.85, 30日以上=0.7(下限)
  - Purpose: 時間経過による記憶の鮮度計算が正確であることを保証
  - _Requirements: REQ-3.1, REQ-3.2_
  - _Prompt: Role: TypeScript Developer specializing in numerical computation | Task: Create Vitest tests for SearchScorer.freshness(). Cases: (1) daysSinceLastAccess=0 -> 1.0, (2) daysSinceLastAccess=14 (=halfLifeDays) -> ~0.85 (e^-0.693 * 14/14 = e^-0.693 = 0.5, but max(0.7, 0.5) = 0.7... wait, recalculate: 14/14=1, e^(-0.693)=0.5, max(0.7, 0.5)=0.7), (3) daysSinceLastAccess=1 -> ~0.952, (4) daysSinceLastAccess=100 -> 0.7 (floor), (5) custom halfLifeDays=7. Use toBeCloseTo for float comparison. | Restrictions: Tests only. | Success: All freshness edge cases covered with correct expected values_

- [x] 6. SearchScorer tagWeightScore計算のテスト作成
  - File: `src/vector/search-scorer.test.ts`（Task 5に追記）
  - tagWeightScore = matchedTagWeights.length > 0 ? 1.0 + sum(matchedTagWeights) / maxPossibleScore : 1.0 のテスト
  - Purpose: タグの重みに基づくスコア計算が正確であることを保証
  - _Requirements: REQ-4.1, REQ-4.2, REQ-4.4_
  - _Prompt: Role: TypeScript Developer | Task: Add tagWeightScore tests to search-scorer.test.ts. Cases: (1) empty matchedTagWeights -> 1.0 (no penalty), (2) single tag weight [0.9] -> 1.0 + 0.9/maxPossible, (3) multiple tags [0.9, 0.5, 0.3] -> sum/maxPossible boost, (4) all tags weight 1.0 -> maximum boost. Note: maxPossibleScore needs to be defined in design — likely sum of all tag weights in the entry or a fixed cap. | Restrictions: Tests only. | Success: tagWeightScore calculation tested for empty, single, multiple, and max cases_

- [x] 7. SearchScorer accessBoost計算のテスト作成
  - File: `src/vector/search-scorer.test.ts`（Task 5に追記）
  - accessBoost = min(1.2, 1.0 + accessCount * 0.04) のテスト。accessCount=0->1.0, 3->1.12, 5->1.20(上限)
  - Purpose: アクセス頻度に基づく連続的なスコア補正が正確であることを保証
  - _Requirements: REQ-5.1, REQ-5.3_
  - _Prompt: Role: TypeScript Developer | Task: Add accessBoost tests. Cases: (1) accessCount=0 -> 1.0, (2) accessCount=1 -> 1.04, (3) accessCount=3 -> 1.12, (4) accessCount=5 -> 1.20 (cap), (5) accessCount=100 -> 1.20 (cap). | Restrictions: Tests only. | Success: accessBoost linear growth with cap at 1.2 verified_

- [x] 8. SearchScorer.score() 複合スコアのテスト作成
  - File: `src/vector/search-scorer.test.ts`（Task 5に追記）
  - finalScore = vectorSimilarity * tagWeightScore * freshness * accessBoost の複合テスト
  - Purpose: 全要素を掛け合わせた最終スコアが意図通りに動作することを保証
  - _Requirements: REQ-4.3_
  - _Prompt: Role: TypeScript Developer | Task: Add composite score() tests. Cases: (1) All neutral (vectorSim=1.0, no tags, 0 days, 0 access) -> 1.0, (2) High relevance + fresh + frequent access -> high score, (3) Low relevance + old + no access -> low score, (4) Old but highly relevant entry still ranks well (freshness floor 0.7 * high vectorSim), (5) Vector-only hit (no tag match) uses tagWeightScore=1.0 per REQ-4.4. | Restrictions: Tests only. | Success: Complex scoring scenarios verified, especially REQ-3.4 (old but relevant) and REQ-4.4 (vector-only)_

- [x] 9. SearchScorer実装
  - File: `src/vector/search-scorer.ts`
  - SearchScorer class with static score() method. Pure function, no external dependencies
  - Purpose: 検索結果のランキングに必要な複合スコアを算出する
  - _Leverage: なし（新規。design.md Component 2のインターフェース定義に従う）_
  - _Requirements: REQ-3, REQ-4, REQ-5_
  - _Prompt: Role: TypeScript Developer | Task: Implement SearchScorer in src/vector/search-scorer.ts. Static method score({vectorSimilarity, matchedTagWeights, daysSinceLastAccess, accessCount, halfLifeDays=14}): number. Formulas: freshness=max(0.7, e^(-0.693*days/halfLife)), tagWeightScore=matchedTagWeights.length>0 ? 1.0+sum(weights)/maxPossibleScore : 1.0, accessBoost=min(1.2, 1.0+accessCount*0.04), finalScore=vectorSimilarity*tagWeightScore*freshness*accessBoost. | Restrictions: Pure function. No imports except types. ESM .js extension. | Success: All Task 5-8 tests pass_

## Phase 2: TagEnricher（Gemini API連携）

- [x] 10. TagEnricherのテスト作成
  - File: `src/vector/tag-enricher.test.ts`
  - Gemini APIレスポンスのパース、エラー時のフォールバック（元タグをweight 1.0で返却）、新テーマ検出ロジックのテスト
  - Purpose: タグ拡張のコア動作とエラー耐性を保証
  - _Requirements: REQ-1.1, REQ-1.2, REQ-1.4, REQ-2.1_
  - _Prompt: Role: QA Engineer | Task: Create tests for TagEnricher. (1) enrich() returns WeightedTag[] with weights in [0.0, 1.0], (2) tags count is 7-15, (3) On Gemini API error, returns original tags with weight 1.0 (graceful degradation per REQ-1.4), (4) newThemes contains tags with weight >= 0.5 that are not in existing theme set, (5) Gemini response JSON parsing: valid JSON -> parsed, invalid JSON -> fallback. Mock Gemini API calls. | Restrictions: Vitest. Mock @google/generative-ai. | Success: Happy path, error fallback, and theme detection tested_

- [x] 11. TagEnricher実装
  - File: `src/vector/tag-enricher.ts`
  - Gemini APIを使ったタグ拡張+重み付け。EmbeddingServiceのAPI呼び出しパターンを踏襲
  - Purpose: 保存時にAIが自動的にタグを拡張し重み付けする
  - _Leverage: `src/vector/embedding-service.ts`（Gemini API呼び出しパターン, L1-2: GoogleGenerativeAI import, L22-29: model.generateContent的なパターン）, `src/config.ts`（geminiApiKey）_
  - _Requirements: REQ-1.1, REQ-1.2, REQ-1.3_
  - _Prompt: Role: TypeScript Developer | Task: Implement TagEnricher class in src/vector/tag-enricher.ts. Constructor takes apiKey. Method: async enrich(title, content, existingTags) -> {tags: WeightedTag[], newThemes: string[]}. Use @google/generative-ai directly (NOT genkit, per tech.md). Prompt instructs Gemini to generate 7-15 tags with weights: specific facts/names -> 0.8-1.0, technical concepts -> 0.5-0.7, generic categories -> 0.2-0.4, synonyms -> lower than original. Output JSON [{tag, weight}]. On error: return existingTags with weight 1.0. newThemes = tags with weight >= 0.5 not in provided existingThemes. | Restrictions: Follow EmbeddingService pattern. ESM. Error -> fallback, no throw. | Success: Task 10 tests pass_

- [x] 12. TagEnricher用プロンプト外部化
  - File: `prompts/tag-enrichment.txt`
  - タグ拡張プロンプトをprompts/ディレクトリに外部化（prompt-loader.tsで読み込み）
  - Purpose: プロンプト改善時にTypeScriptリビルド不要にする（tech.md Decision 10に準拠）
  - _Leverage: `src/analyzer/prompt-loader.ts`, `prompts/`（既存プロンプトファイル群）_
  - _Requirements: tech.md Decision 10_
  - _Prompt: Role: TypeScript Developer | Task: (1) Create prompts/tag-enrichment.txt with the tag enrichment prompt template. Include placeholders for title, content, existingTags. (2) Update TagEnricher to load prompt via prompt-loader.ts instead of inline string. | Restrictions: Follow existing prompt externalization pattern (analysis.txt, duplicate-check.txt etc). | Success: TagEnricher loads prompt from file, prompt changes don't require rebuild_

## Phase 3: save.tsへのタグ拡張統合

- [x] 13. save.tsタグ拡張統合のテスト作成
  - File: `src/tools/save-tag-enrichment.test.ts`
  - memory_save時にembedding生成と並列でTagEnricher.enrich()が呼ばれること、エラー時にフォールバックで元タグが保存されることのテスト
  - Purpose: タグ拡張が保存フローに正しく統合されていることを保証
  - _Leverage: `src/tools/save.ts`（L99-117: 現行embedding生成フロー）_
  - _Requirements: REQ-1.1, REQ-1.4_
  - _Prompt: Role: QA Engineer | Task: Create integration test for save.ts tag enrichment. (1) When Gemini API available, embedding and tag enrichment run in parallel (Promise.all), (2) Enriched weighted tags are saved (tags field contains "tag:weight" strings), (3) On TagEnricher error, original tags are saved as-is (no enrichment, no failure), (4) When API key unavailable, no enrichment attempted. Mock EmbeddingService and TagEnricher. | Restrictions: Vitest. Mock external services. | Success: Parallel execution, weighted tag persistence, and error fallback verified_

- [x] 14. save.tsにTagEnricher統合を実装
  - File: `src/tools/save.ts`
  - embedding生成（L99-117）と並列でTagEnricher.enrich()を実行。enriched tagsを "tag:weight" 形式でparams.tagsに設定してからstorage.save()に渡す
  - Purpose: memory_save時に自動的にタグが拡張・重み付けされる
  - _Leverage: `src/tools/save.ts`（L99-117: Promise.all化する対象）, `src/vector/tag-enricher.ts`（Task 11）, `src/vector/weighted-tag.ts`（Task 2: formatWeightedTags）_
  - _Requirements: REQ-1.1, REQ-1.4, REQ-1.5_
  - _Prompt: Role: TypeScript Developer | Task: Modify save.ts to run TagEnricher.enrich() in parallel with embedding generation. Steps: (1) Move embedding and tag enrichment into Promise.all, (2) If enrichment succeeds, replace params.tags with formatWeightedTags(enrichedTags), (3) If enrichment fails, keep original tags (stderr log, no throw), (4) Save with enriched tags, then upsert embedding. Key change: enrichment happens BEFORE storage.save() so weighted tags are persisted. Restructure the flow: enrich+embed in parallel -> save with enriched tags -> upsert vector. | Restrictions: Don't break existing save flow. Error in enrichment must not block save. | Success: Task 13 tests pass. Existing save tests still pass_

## Phase 4: search.tsへのスコアリング統合

- [x] 15. search.tsスコアリング統合のテスト作成
  - File: `src/tools/search-scoring.test.ts`
  - SearchScorerによるスコア計算がsearch結果のソート順に反映されること、freshness・tagWeight・accessBoostが複合的に作用することのテスト
  - Purpose: 検索結果のランキングがスコアリングに基づいて最適化されていることを保証
  - _Leverage: `src/tools/search.ts`（L59-138: 現行検索+ベクトルマージフロー）_
  - _Requirements: REQ-3.3, REQ-4.3_
  - _Prompt: Role: QA Engineer | Task: Create test for search.ts scoring integration. (1) Results are sorted by composite score (not just timestamp), (2) Recent entry with moderate relevance ranks above old entry with same relevance, (3) Old entry with high relevance can still rank above recent low-relevance entry (REQ-3.4), (4) Frequently accessed entries get accessBoost, (5) Vector-only hits (no tag match) use tagWeightScore=1.0. Mock MarkdownStorage, VectorStore, EmbeddingService. | Restrictions: Vitest. | Success: Scoring-based sort order verified for all ranking scenarios_

- [x] 16. VectorStoreにlastAccessedAt取得メソッド追加
  - File: `src/vector/vector-store.ts`
  - getEntryMetadata(ids: string[]) -> Map<string, {lastAccessedAt: string, accessCount: number}> を追加。freshness計算に必要
  - Purpose: SearchScorerにfreshness・accessBoost計算用のデータを提供する
  - _Leverage: `src/vector/vector-store.ts`（L5-11: VectorEntry既存フィールドにlastAccessedAt, accessCountが既にある）_
  - _Requirements: REQ-3.1, REQ-5.1_
  - _Prompt: Role: TypeScript Developer | Task: Add getEntryMetadata(ids: string[]) to VectorStore. Returns Map<id, {lastAccessedAt, accessCount}> for the given IDs. Reads from existing VectorEntry fields (no schema change needed). Add test in src/vector/vector-store-metadata.test.ts. | Restrictions: Read-only method. Don't modify existing methods. | Success: Metadata retrieval works for existing, missing, and mixed ID sets_

- [x] 17. search.tsにSearchScorer統合を実装
  - File: `src/tools/search.ts`
  - ベクトル検索+キーワード検索の結果マージ後に、SearchScorer.score()で再ランキング
  - Purpose: 検索結果がfreshness・タグ重み・アクセス頻度を考慮した順序で返される
  - _Leverage: `src/tools/search.ts`（L59-138）, `src/vector/search-scorer.ts`（Task 9）, `src/vector/vector-store.ts`（Task 16: getEntryMetadata）, `src/vector/weighted-tag.ts`（Task 2: parseWeightedTags）_
  - _Requirements: REQ-3, REQ-4, REQ-5_
  - _Prompt: Role: TypeScript Developer | Task: Modify search.ts to apply SearchScorer after merging keyword+vector results. Steps: (1) After merging, collect all result IDs, (2) Call vectorStore.getEntryMetadata(ids) to get lastAccessedAt and accessCount, (3) For each result, compute daysSinceLastAccess from lastAccessedAt, (4) Parse tags via parseWeightedTags to get weights, (5) Match query keywords against tags to get matchedTagWeights, (6) Get vectorSimilarity from vector search distance (convert: similarity = 1 - distance), (7) Call SearchScorer.score() for each result, (8) Sort results by score descending. Replace current timestamp-only sort. | Restrictions: Graceful degradation if VectorStore unavailable. Don't break existing search flow. | Success: Task 15 tests pass. Results sorted by composite score_

## Phase 5: lastAccessedAt更新（再浮上）

- [x] 18. memory_search/memory_get_detailでのlastAccessedAt更新テスト
  - File: `src/vector/access-tracking.test.ts`
  - memory_searchまたはmemory_get_detailでアクセスされたエントリのlastAccessedAtが更新されること、freshnessがリセットされることのテスト
  - Purpose: アクセスによる記憶の再浮上メカニズムが正しく動作することを保証
  - _Leverage: `src/vector/vector-store.ts`（L92-105: incrementAccessCount既存実装。lastAccessedAtも更新済み）_
  - _Requirements: REQ-3.3_
  - _Prompt: Role: QA Engineer | Task: Create test confirming lastAccessedAt is updated on search/getDetail access. (1) After memory_search, accessed entries' lastAccessedAt is updated to now, (2) After memory_get_detail, same update occurs, (3) Freshness recalculation after access yields higher value (re-surfacing). Note: incrementAccessCount in vector-store.ts already updates lastAccessedAt (L100). Verify this is called in both search.ts and getDetail.ts. | Restrictions: Vitest. | Success: Access-triggered re-surfacing mechanism verified_

- [x] 19. getDetail.tsにlastAccessedAt更新を追加
  - File: `src/tools/getDetail.ts`
  - memory_get_detail呼び出し時にVectorStoreのincrementAccessCountを呼んでlastAccessedAtを更新
  - Purpose: 詳細取得時にも記憶が再浮上する
  - _Leverage: `src/tools/getDetail.ts`, `src/vector/vector-store.ts`（L92-105: incrementAccessCount）_
  - _Requirements: REQ-3.3_
  - _Prompt: Role: TypeScript Developer | Task: Add lastAccessedAt update to getDetail.ts. After retrieving entries, call vectorStore.incrementAccessCount(foundIds) to update access metadata. Follow same pattern as search.ts (L87-89). Wrap in try/catch — failure should not affect getDetail result. | Restrictions: Non-blocking, error-tolerant. | Success: Task 18 tests pass for getDetail path_

## Phase 6: ThemeRegistry + RetagWorker（非同期バックグラウンド）

- [x] 20. ThemeRegistryのテスト作成と実装
  - File: `src/vector/theme-registry.test.ts`, `src/vector/theme-registry.ts`
  - 既知テーマ一覧の読み書き、新テーマ判定（既存テーマに含まれないかチェック）
  - Purpose: 新テーマ検出の判定基盤を提供する
  - _Leverage: `src/vector/vector-store.ts`（JSONファイル読み書きパターン）_
  - _Requirements: REQ-2.1_
  - _Prompt: Role: TypeScript Developer | Task: (1) Create ThemeRegistry class in src/vector/theme-registry.ts. Constructor takes memoryPath. Methods: getThemes() -> string[], addThemes(themes: string[]) -> void, isNewTheme(theme: string) -> boolean. Store in themes.json ({themes: string[], updatedAt: string}). (2) Create tests: add, deduplicate, isNewTheme true/false, file-not-found initialization. | Restrictions: Follow VectorStore's file I/O pattern. | Success: ThemeRegistry correctly manages theme set with persistence_

- [x] 21. RetagWorkerのテスト作成
  - File: `src/cli/retag-worker.test.ts`
  - 新テーマに関連する過去エントリのベクトル検索、TagEnricherによる再タグ付け、既存タグとのマージ（重み最大値採用）、最大20件制限のテスト
  - Purpose: バックグラウンド再タグ付けの正確性と安全性を保証
  - _Leverage: `src/cli/consolidate-worker.ts`（detachedプロセスパターン, L25-66）_
  - _Requirements: REQ-2.2, REQ-2.3, REQ-2.4_
  - _Prompt: Role: QA Engineer | Task: Create tests for RetagWorker. (1) Searches past entries by new theme vector, (2) Limits to 20 entries per run (REQ-2.3), (3) Merges new tags with existing: same tag name -> max weight, new tag -> added, (4) Does not overwrite existing tags (merge only, REQ-2.4), (5) On failure, existing tags are untouched. Mock VectorStore, TagEnricher, MarkdownStorage. | Restrictions: Vitest. | Success: Merge logic, limit, and error resilience tested_

- [x] 22. RetagWorker実装
  - File: `src/cli/retag-worker.ts`
  - CLIスクリプトとして実行。consolidate-workerのspawnパターンを再利用
  - Purpose: 新テーマ発見時に関連する過去エントリのタグを非同期で強化する
  - _Leverage: `src/cli/consolidate-worker.ts`（L1-70: detachedプロセスのmain関数パターン）, `src/vector/tag-enricher.ts`（Task 11）, `src/vector/vector-store.ts`, `src/storage/markdown.ts`_
  - _Requirements: REQ-2.2, REQ-2.3, REQ-2.4_
  - _Prompt: Role: TypeScript Developer | Task: Create src/cli/retag-worker.ts as detached CLI script (like consolidate-worker.ts). Args: newThemes[] (JSON), memoryPath, projectRoot. Flow: (1) For each theme, vector search past entries (medium tier), (2) Collect unique IDs, limit to 20, (3) For each entry, call TagEnricher.enrich(), (4) Merge tags: same name -> max(old.weight, new.weight), new name -> add, (5) Update via MarkdownStorage (read entry, update tags, save with replaceId). Exit cleanly. | Restrictions: Follow consolidate-worker.ts pattern. Log to stderr. | Success: Task 21 tests pass_

- [x] 23. save.tsからRetagWorkerのspawn統合
  - File: `src/tools/save.ts`
  - TagEnricher.enrich()のnewThemes検出時、ThemeRegistryで新テーマか判定し、新テーマがあればretag-workerをdetachedプロセスとしてspawn
  - Purpose: 新テーマの自動検出と過去エントリの非同期再タグ付けトリガー
  - _Leverage: `src/tools/save.ts`（Task 14で拡張済み）, `src/cli/context.ts`（consolidate-workerのspawnパターンを確認）, `src/vector/theme-registry.ts`（Task 20）_
  - _Requirements: REQ-2.1, REQ-2.5_
  - _Prompt: Role: TypeScript Developer | Task: After tag enrichment in save.ts, if newThemes is non-empty: (1) Check each theme against ThemeRegistry.isNewTheme(), (2) If new themes found, add to ThemeRegistry, (3) Spawn retag-worker.ts as detached child process (like consolidate-worker spawn pattern in context.ts). Pass JSON-encoded newThemes, memoryPath, projectRoot as args. (4) Do NOT await — fire and forget (REQ-2.5: non-blocking). | Restrictions: spawn must be detached+unref. No await on worker. | Success: New themes trigger background retag. memory_save response is not delayed_

## Phase 7: 後方互換性・E2E検証

- [x] 24. 後方互換性テスト（重みなしタグの読み込み）
  - File: `src/vector/backward-compat.test.ts`
  - 既存の重みなしMarkdownファイルを読み込んだ際、タグがweight 1.0として扱われること、検索・スコアリングが正常に動作することの統合テスト
  - Purpose: 既存データの破壊がないことを保証する
  - _Requirements: design.md Component 4 後方互換性, REQ-4.4_
  - _Prompt: Role: QA Engineer | Task: Create backward compatibility integration test. (1) Load existing markdown with legacy tags "Gemini, API" -> parseWeightedTags returns [{tag:"Gemini", weight:1.0}, {tag:"API", weight:1.0}], (2) SearchScorer works with weight 1.0 tags, (3) Searching with weighted tags finds legacy entries, (4) Mixed legacy+weighted entries sort correctly. Use real parser+scorer, mock only external APIs. | Restrictions: Vitest. Real parser/formatter/scorer. | Success: Zero breaking changes for existing data confirmed_

- [x] 25. memory_save -> memory_search E2E検証テスト
  - File: `src/e2e-smart-tag-retrieval.test.ts`
  - 保存->タグ拡張->検索->スコアリングの一連のフロー。最近保存した記憶が古い記憶より上位に来ること、アクセス頻度の高い記憶が浮上すること
  - Purpose: 全コンポーネントが統合された状態で期待通りに動作することをEnd-to-Endで検証
  - _Requirements: design.md Testing Strategy E2E_
  - _Prompt: Role: QA Automation Engineer | Task: Create E2E test covering full flow: (1) Save entry A (old) and entry B (recent) with same tags, search -> B ranks above A, (2) Access A multiple times via memory_search, search again -> A climbs ranking (re-surfacing), (3) Save entry C with specific weighted tags, search by that tag -> C ranks high due to tag weight. Mock Gemini API for tag enrichment (return predictable tags). Use real MarkdownStorage with temp directory. | Restrictions: Vitest. Temp directory for isolation. Mock only Gemini API. | Success: Freshness, access frequency, and tag weight all demonstrably affect ranking_
