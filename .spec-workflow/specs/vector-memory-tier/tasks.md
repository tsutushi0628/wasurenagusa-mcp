# Tasks Document - Vector Memory Tier

- [x] 1. コサイン距離計算ユーティリティ作成
  - File: src/vector/cosine-distance.ts, src/vector/cosine-distance.test.ts
  - コサイン距離計算関数を実装（純粋関数、依存なし）
  - テスト: 既知ベクトルペアで距離計算の正確性を検証（同一ベクトル=0, 直交=1, 逆向き=2）
  - Purpose: ベクトル検索の基礎演算。他モジュールより先に確立する
  - _Requirements: REQ-2_
  - _Prompt: Role: TypeScript Developer specializing in numerical computation | Task: Implement cosine distance function for 768-dimensional vectors. cosineDistance(a, b) returns 0 for identical, 1 for orthogonal, 2 for opposite vectors. Include edge case handling for zero vectors. Write comprehensive tests with known vector pairs | Restrictions: Pure function, no external dependencies. Do not use ternary operators or || assignment. Errors must throw, not return fallback values | Success: All tests pass including edge cases. Function handles Float64 precision correctly_

- [x] 2. MemoryTier定数・関数作成
  - File: src/vector/memory-tier.ts, src/vector/memory-tier.test.ts
  - 記憶層の閾値定義（short=0.2, medium=0.45, long=0.7）
  - filterByTier()関数、shouldPromoteToCritical()関数を実装
  - テスト: 各閾値でのフィルタリング、昇格判定の正確性
  - Purpose: ビジネスロジックを純粋関数として確立
  - _Requirements: REQ-3, REQ-4_
  - _Prompt: Role: TypeScript Developer | Task: Define TierName type ("short"/"medium"/"long"), TIER_THRESHOLDS constant, CRITICAL_PROMOTION_THRESHOLD=5 constant. Implement filterByTier(results, tier) and shouldPromoteToCritical(accessCount). Write tests covering all tier boundaries and promotion edge cases | Restrictions: Pure functions only, no side effects, no external dependencies | Success: All boundary conditions tested (exactly at threshold, just above, just below)_

- [x] 3. VectorStoreデータモデル・CRUD実装
  - File: src/vector/vector-store.ts, src/vector/vector-store.test.ts
  - VectorStoreData/VectorEntry型定義
  - vectors.jsonの読み書き（load/save）
  - upsert(), delete(), getEntryCount() メソッド
  - テスト: tmpディレクトリ上の実ファイルでCRUD操作を検証
  - Purpose: ベクトルデータの永続化層を確立
  - _Requirements: REQ-1, REQ-5_
  - _Prompt: Role: TypeScript Developer specializing in file-based storage | Task: Implement VectorStore class with vectors.json persistence. VectorStoreData has version:1 and entries:Record<string,VectorEntry>. Implement upsert (create/update), delete (by ids), getEntryCount. File path: {memoryPath}/vectors.json. Handle missing/corrupted file by initializing empty store. Use fs/promises for all I/O | Restrictions: No file locking needed. Do not use fallback values - if file is corrupted, re-initialize and log to stderr. No ternary operators | Success: CRUD operations work on real tmp files. Corrupted file recovery tested_

- [x] 4. VectorStore検索メソッド実装
  - File: src/vector/vector-store.ts（task 3の続き）, src/vector/vector-store.test.ts
  - search()メソッド: ブルートフォースコサイン距離計算 + 閾値フィルタ + ソート
  - incrementAccessCount()メソッド: 検索ヒット時のアクセスカウント更新
  - getEntriesWithoutEmbedding()メソッド: バックフィル対象の特定
  - テスト: 既知のembeddingで検索精度・ソート順・アクセスカウント増加を検証
  - Purpose: ベクトル検索機能を確立
  - _Leverage: src/vector/cosine-distance.ts_
  - _Requirements: REQ-2, REQ-4, REQ-5_
  - _Prompt: Role: TypeScript Developer | Task: Add search(queryEmbedding, threshold, limit) to VectorStore. Brute-force cosine distance against all entries, filter by threshold, sort by distance ascending, return top N. Add incrementAccessCount(ids) to bump access counts and persist. Add getEntriesWithoutEmbedding(allIds) that returns ids not in vectors.json | Restrictions: search must return VectorSearchResult[] with id, distance, accessCount. Do not shuffle results (deterministic order by distance) | Success: Search returns correct results sorted by distance. Access count increments persist across load/save cycles_

- [x] 5. EmbeddingService実装
  - File: src/vector/embedding-service.ts, src/vector/embedding-service.test.ts
  - @google/generative-aiを使用したGemini gemini-embedding-001呼び出し
  - embed(text): 単一テキスト→768次元ベクトル
  - embedBatch(texts): 逐次実行での複数テキスト変換
  - isAvailable(): APIキー設定有無の判定
  - テスト: @google/generative-aiをモックしてembed/embedBatchの入出力を検証
  - Purpose: 外部API依存を1箇所に集約
  - _Requirements: REQ-1_
  - _Prompt: Role: TypeScript Developer with API integration expertise | Task: Implement EmbeddingService using @google/generative-ai (GoogleGenerativeAI class, NOT @google/genai). Model: gemini-embedding-001, 768 dimensions. Constructor takes apiKey. isAvailable() checks apiKey existence. embed() calls embedContent and returns values array. embedBatch() calls embed() sequentially. Reference: existing project EmbeddingService pattern but adapted for @google/generative-ai | Restrictions: Do not add new dependencies. Use existing @google/generative-ai package. Throw on API failure (no fallback). No ternary operators | Success: Mock tests verify correct API call parameters. isAvailable returns false when apiKey is empty_

- [x] 6. memory_saveハンドラへのembedding生成統合
  - File: src/tools/memory-save.ts（既存ファイル修正）
  - memory_save成功後にEmbeddingService.embed() + VectorStore.upsert()を呼び出す
  - replaceId指定時は旧embeddingを削除してから新規upsert
  - embedding生成失敗時はエラーをstderrに出力し、メモリ保存結果はそのまま返却
  - テスト: 保存成功時のembedding生成呼び出し、API失敗時の保存成功を検証
  - Purpose: 保存パイプラインにembedding生成を組み込む
  - _Leverage: src/vector/embedding-service.ts, src/vector/vector-store.ts, src/storage/markdown.ts_
  - _Requirements: REQ-1_
  - _Prompt: Role: TypeScript Developer | Task: After successful MarkdownStorage.save(), call EmbeddingService.embed(title + " " + content) and VectorStore.upsert(id, embedding). If replaceId was specified, call VectorStore.delete([replaceId]) before upsert. Wrap embedding logic in try/catch - on failure, console.error and return original save result. Check EmbeddingService.isAvailable() before attempting | Restrictions: Do not modify MarkdownStorage. Do not change the tool's public interface. Embedding failure must not affect save result | Success: Save with embedding works. Save without API key works (skip). Save with API failure works (save succeeds, embedding missing)_

- [x] 7. memory_searchハンドラへのベクトル検索統合
  - File: src/tools/memory-search.ts（既存ファイル修正）
  - キーワード検索と並行してベクトル検索を実行
  - 結果をマージ（和集合、重複排除はIDベース）
  - ベクトル検索ヒット時はアクセスカウントをインクリメント
  - アクセスカウント閾値超過時にcritical昇格（MarkdownStorageの該当エントリを更新）
  - テスト: マージロジック、アクセスカウント更新、昇格トリガーを検証
  - Purpose: 既存検索に意味検索を追加
  - _Leverage: src/vector/embedding-service.ts, src/vector/vector-store.ts, src/vector/memory-tier.ts_
  - _Requirements: REQ-2, REQ-3, REQ-4_
  - _Prompt: Role: TypeScript Developer | Task: In memory_search handler, after keyword search, perform vector search if EmbeddingService.isAvailable(). Embed query, search VectorStore with medium tier threshold (0.45). Merge results: keyword results + vector-only results (deduplicate by id). For vector hits, call incrementAccessCount. Check shouldPromoteToCritical for each hit - if true, update MarkdownStorage entry importance to "critical". Add "semantic" flag to hint when vector results are included | Restrictions: Do not change SearchParams or SearchResult interfaces. Vector search failure should not affect keyword results. Do not use ternary operators | Success: Mixed search returns both keyword and semantic results. Promotion triggers correctly at threshold_

- [x] 8. memory_deleteハンドラへのベクトル削除統合
  - File: src/tools/memory-delete.ts（既存ファイル修正）
  - memory_delete成功後にVectorStore.delete()で対応ベクトルを削除
  - VectorStore削除失敗時はstderrにエラー出力（メモリ削除結果には影響しない）
  - テスト: 削除時のベクトル同期削除を検証
  - Purpose: データ整合性の維持
  - _Leverage: src/vector/vector-store.ts_
  - _Requirements: REQ-1_
  - _Prompt: Role: TypeScript Developer | Task: After successful MarkdownStorage.delete(), call VectorStore.delete(deletedIds). Wrap in try/catch - on failure, console.error only. Do not modify delete result | Restrictions: Do not change DeleteResult interface. VectorStore failure must not affect delete result | Success: Delete removes both markdown entry and vector. VectorStore failure doesn't break delete_

- [x] 9. SessionStartコンテキスト注入へのベクトル検索統合
  - File: src/cli/context.ts（既存ファイル修正）
  - 現在のconfig/dont注入に加え、ベクトル検索による短期層（distance<=0.2）の関連記憶を注入
  - 検索クエリ: cwdのプロジェクト名をクエリとして使用
  - 注入セクション: 「## 関連する記憶（自動検索）」として出力
  - テスト: ベクトル検索結果のコンテキスト注入フォーマットを検証
  - Purpose: セッション開始時に文脈に応じた記憶を自動注入
  - _Leverage: src/vector/embedding-service.ts, src/vector/vector-store.ts, src/vector/memory-tier.ts_
  - _Requirements: REQ-3_
  - _Prompt: Role: TypeScript Developer | Task: In context.ts main(), after existing config/dont injection, perform vector search with short tier threshold (0.2) using project name as query. If results found, format as "## 関連する記憶（自動検索）" section with entry titles and snippets. Retrieve full entries via MarkdownStorage.getDetail(). Limit to 5 entries max | Restrictions: Must complete within SessionStart hook timeout (5 seconds). Check EmbeddingService.isAvailable() first. Do not modify existing output sections | Success: Context output includes vector search results when available. No output change when embedding unavailable_

- [x] 10. バックフィルWorker実装
  - File: src/cli/backfill-worker.ts
  - detachedプロセスとして実行。引数: memoryPath, projectRoot
  - MarkdownStorageから全エントリID取得 → VectorStore.getEntriesWithoutEmbedding()で未処理ID特定
  - 最大20件をembedding生成 + VectorStore.upsert()
  - テスト: バックフィルロジックのユニットテスト（API/ファイルモック）
  - Purpose: 既存メモリの段階的ベクトル化
  - _Leverage: src/vector/embedding-service.ts, src/vector/vector-store.ts, src/storage/markdown.ts_
  - _Requirements: REQ-5_
  - _Prompt: Role: TypeScript Developer | Task: Create backfill-worker.ts as CLI script (same pattern as consolidate-worker.js). Args: memoryPath, projectRoot. Read all MemoryEntry ids from MarkdownStorage. Get ids without embeddings from VectorStore. Process up to 20 entries: read full entry, embed(title + " " + content), upsert. Exit when done | Restrictions: Process max 20 per run. Log progress to stderr. Exit cleanly on completion or error. No ternary operators | Success: Backfill processes correct number of entries. Idempotent (re-run skips already embedded)_

- [x] 11. context.tsへのバックフィル起動統合
  - File: src/cli/context.ts（既存ファイル修正）
  - spawnConsolidationBackgroundと同パターンでbackfill-workerをdetached spawn
  - 起動条件: EmbeddingService.isAvailable() かつ 未処理エントリが存在
  - テスト: spawn呼び出しの条件分岐を検証
  - Purpose: SessionStart時にバックフィルを自動トリガー
  - _Leverage: src/cli/backfill-worker.ts_
  - _Requirements: REQ-5_
  - _Prompt: Role: TypeScript Developer | Task: In context.ts, add spawnBackfillBackground(memoryPath, projectRoot) function following spawnConsolidationBackground pattern. Call it after consolidation check if EmbeddingService.isAvailable(). Use spawn with detached:true, stdio:"ignore", child.unref() | Restrictions: Must not block SessionStart hook. Follow exact pattern of existing spawnConsolidationBackground | Success: Backfill worker spawns correctly. No impact on SessionStart timing_

- [x] 12. config.tsへのベクトル設定項目追加
  - File: src/config.ts（既存ファイル修正）
  - vectorStoreFile: "vectors.json" を追加
  - embeddingModel: "gemini-embedding-001" を追加
  - embeddingDimensions: 768 を追加
  - backfillBatchSize: 20 を追加
  - テスト: 設定値の読み込み確認
  - Purpose: ベクトル関連の設定を一元管理
  - _Requirements: REQ-1, REQ-5_
  - _Prompt: Role: TypeScript Developer | Task: Add to config object: vectorStoreFile ("vectors.json"), embeddingModel ("gemini-embedding-001"), embeddingDimensions (768), backfillBatchSize (20). No environment variable override needed for now (hardcoded defaults) | Restrictions: Do not modify existing config entries. Add new entries at the end | Success: New config values accessible via config.vectorStoreFile etc._

- [x] 13. @google/generative-ai APIのembedding対応確認・型定義
  - File: src/vector/embedding-service.ts（task 5で作成済みファイルの調整）
  - 既存dependency @google/generative-ai (v0.24.1) のembedContent APIを確認
  - @google/genai との API差分を吸収（embedContentの呼び出し方が異なる可能性）
  - テスト: 実API呼び出しテスト（CI skip可、手動確認用）
  - Purpose: 依存追加なしでembedding機能を実現できることの確認
  - _Requirements: REQ-1_
  - _Prompt: Role: TypeScript Developer | Task: Verify @google/generative-ai v0.24.1 embedContent API. The API uses GoogleGenerativeAI class, not GoogleGenAI. Adapt EmbeddingService to use correct API: new GoogleGenerativeAI(apiKey), model.embedContent({content:{parts:[{text}]}}). Write a manual integration test (skipped in CI) that calls real Gemini API | Restrictions: Do not add @google/genai as dependency. Use existing @google/generative-ai only | Success: EmbeddingService works with @google/generative-ai API. Integration test passes with real API key_
