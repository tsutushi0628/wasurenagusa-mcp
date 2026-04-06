# Tasks: storage-engine-v2

## フェーズ1: 基盤（SQLiteスキーマ + ローカルembedding）

### TASK-001: SQLiteスキーマ定義ファイル作成
- **対象**: `src/storage/schema.ts`（新規作成）
- **内容**: DDL定数（memories, memories_fts, vectors, vector_metadata, stash, consolidated, themes, session_topics, schema_version）、initializeSchema関数、getSchemaVersion関数を実装
- **完了条件**: `initializeSchema(db)`を呼ぶと全テーブルが作成され、`getSchemaVersion(db)`がCURRENT_SCHEMA_VERSIONを返す
- **テスト**: 一時ディレクトリにDBファイルを作成し、全テーブルの存在とカラム定義を検証

### TASK-002: SQLiteStorage基本クラス（コンストラクタ + initialize）
- **対象**: `src/storage/sqlite.ts`（新規作成）
- **内容**: SQLiteStorageクラスのコンストラクタ（better-sqlite3でDBオープン、WAL/busy_timeout設定）、initialize()でschema.tsのinitializeSchemaを呼び出し
- **完了条件**: `new SQLiteStorage(dbPath).initialize()`でmemory.dbが作成され、WALモードが有効
- **テスト**: DBファイル作成→PRAGMA journal_mode確認→PRAGMA busy_timeout確認

### TASK-003: SQLiteStorage.save実装
- **対象**: `src/storage/sqlite.ts`のsaveメソッド
- **内容**: INSERT INTO memoriesの実装。ID生成（既存のタイムスタンプベース）、JSTタイムスタンプ生成、replaceId指定時のUPDATE。FTS5はトリガーで自動同期
- **完了条件**: `storage.save(params)`でmemoriesテーブルにレコードが挿入され、SaveResultが返る
- **テスト**: save→SELECT確認、replaceId指定時のUPDATE確認

### TASK-004: SQLiteStorage.search実装（キーワード検索）
- **対象**: `src/storage/sqlite.ts`のsearchメソッド（FTS5部分）
- **内容**: FTS5 MATCH検索、project/scopeフィルタ、timestamp DESC ORDER BY、LIMIT。MemoryIndexEntry配列への変換
- **完了条件**: `storage.search({ query: "テスト" })`でFTS5ヒットしたエントリの軽量インデックスが返る
- **テスト**: save×3→search→件数・ソート順・フィルタ結果の検証

### TASK-005: SQLiteStorage.getDetail実装
- **対象**: `src/storage/sqlite.ts`のgetDetailメソッド
- **内容**: SELECT * FROM memories WHERE id IN (?)。見つからないIDはnotFoundに振り分け
- **完了条件**: `storage.getDetail({ ids: [...] })`で該当エントリのフル内容が返る
- **テスト**: save×2→getDetail(片方存在+片方不在)→entries/notFoundの検証

### TASK-006: SQLiteStorage.getContext実装
- **対象**: `src/storage/sqlite.ts`のgetContextメソッド
- **内容**: config/dontカテゴリのエントリをprojectフィルタ付きで取得。configはdeduplicateConfigEntries相当のロジックを適用
- **完了条件**: `storage.getContext("myProject")`でconfig/dontのフォーマット済みテキストが返る
- **テスト**: config×3+dont×2を保存→getContext→フォーマット結果の検証

### TASK-007: SQLiteStorage.delete実装
- **対象**: `src/storage/sqlite.ts`のdeleteメソッド
- **内容**: DELETE FROM memories WHERE id IN (?)。FTS5はトリガーで自動同期。vector_metadataはON DELETE CASCADEで連動。vectorsテーブルからも明示削除（sqlite-vecは外部コンテンツ非対応のため）
- **完了条件**: `storage.delete({ ids: [...] })`で該当エントリとベクトルが削除される
- **テスト**: save+upsertVector→delete→SELECT確認（memories, vectors両方消えている）

### TASK-008: SQLiteStorage.updateIntensity実装
- **対象**: `src/storage/sqlite.ts`のupdateIntensityメソッド
- **内容**: UPDATE memories SET intensity = ?, updated_at = datetime('now') WHERE id = ?。存在しない場合はthrow Error
- **完了条件**: `storage.updateIntensity(id, 5)`でintensityが更新される
- **テスト**: save→updateIntensity→SELECT確認

### TASK-009: SQLiteStorage.readConfigEntries / readDontEntries実装
- **対象**: `src/storage/sqlite.ts`
- **内容**: SELECT * FROM memories WHERE category = ? (AND project filter)。consolidator向けのエントリ直接読み出し
- **完了条件**: readConfigEntries/readDontEntriesがMemoryEntry[]を返す
- **テスト**: save×数件→readConfigEntries→件数・内容の検証

## フェーズ2: ベクトル検索（sqlite-vec + ローカルembedding）

### TASK-010: LocalEmbeddingクラス実装
- **対象**: `src/vector/local-embedding.ts`（新規作成）
- **内容**: Transformers.js v3の`pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')`でembedding生成。initialize()でモデルロード（初回ダウンロード）。embed()で384次元ベクトルを返す
- **完了条件**: `embedding.embed("テスト")`が384要素のnumber[]を返す
- **テスト**: embed→次元数検証、embedBatch→全件の次元数検証

### TASK-011: SQLiteStorage.upsertVector / deleteVectors実装
- **対象**: `src/storage/sqlite.ts`のベクトル操作メソッド
- **内容**: sqlite-vecのvectorsテーブルへのINSERT/DELETE。vector_metadataテーブルへの連動INSERT/DELETE
- **完了条件**: upsertVectorでベクトルが保存され、deleteVectorsで削除される
- **テスト**: upsertVector→searchVectors→ヒット確認、deleteVectors→searchVectors→ヒットなし確認

### TASK-012: SQLiteStorage.searchVectors実装
- **対象**: `src/storage/sqlite.ts`のsearchVectorsメソッド
- **内容**: sqlite-vecのKNN検索。`SELECT id, distance FROM vectors WHERE embedding MATCH ? AND k = ?`。閾値フィルタ
- **完了条件**: `searchVectors(queryEmbedding, threshold, limit)`でVectorSearchResult[]が返る
- **テスト**: upsertVector×3→searchVectors→距離順・件数の検証

### TASK-013: SQLiteStorage.incrementAccessCount / getVectorMetadata実装
- **対象**: `src/storage/sqlite.ts`
- **内容**: vector_metadataのaccess_count++とlast_accessed_at更新。getVectorMetadataでメタデータMap返却
- **完了条件**: incrementAccessCount後にaccess_countが増加し、getVectorMetadataで読み取れる
- **テスト**: upsertVector→incrementAccessCount×2→getVectorMetadata→access_count=2確認

### TASK-014: SQLiteStorage.getEntriesWithoutEmbedding実装
- **対象**: `src/storage/sqlite.ts`
- **内容**: memoriesに存在するがvectors/vector_metadataに存在しないIDを返す（backfill用）
- **完了条件**: embedding未生成のエントリIDリストが返る
- **テスト**: save×3→upsertVector×1→getEntriesWithoutEmbedding→2件のID確認

### TASK-015: search統合（FTS5 + ベクトルのハイブリッド検索）
- **対象**: `src/storage/sqlite.ts`のsearchメソッド拡張
- **内容**: FTS5結果とsearchVectors結果のIDをUNIONし、SearchScorerでランキング。既存のsearch.tsのロジックをSQLiteStorage内に移行
- **完了条件**: `storage.searchHybrid(params, queryEmbedding)`でFTS5+ベクトルのマージ結果が返る
- **テスト**: FTS5のみヒット・ベクトルのみヒット・両方ヒットの3パターンで結果検証

## フェーズ3: 退避機能 + 統合 + テーマ

### TASK-016: SQLiteStorage.stash / restore / cleanExpiredStash実装
- **対象**: `src/storage/sqlite.ts`のstash関連メソッド
- **内容**: stashテーブルへのINSERT（expires_at = datetime('now', '+N hours')）、ID指定SELECT（TTL確認付き）、期限切れ一括DELETE
- **完了条件**: stash→restore→フル内容取得。TTL超過後のrestore→expired=true
- **テスト**: stash→即restore→成功、stash(ttlHours=0)→restore→expired=true

### TASK-017: memory_stashツール定義
- **対象**: `src/tools/stash.ts`（新規作成）
- **内容**: MCPツール定義（inputSchema: content, filePath?, fileType?, ttlHours?）とハンドラー。ルールベース要約生成（先頭5行+行数+ファイルタイプ）
- **完了条件**: memory_stashツールが登録され、呼び出すとstashテーブルに保存・要約が返る
- **テスト**: handleMemoryStash呼び出し→StashResult検証

### TASK-018: memory_restoreツール定義
- **対象**: `src/tools/restore.ts`（新規作成）
- **内容**: MCPツール定義（inputSchema: id）とハンドラー。SQLiteStorage.restoreを呼び出し
- **完了条件**: memory_restoreツールが登録され、呼び出すとフル内容が返る
- **テスト**: stash→restore→フル内容一致検証

### TASK-019: SQLiteStorage統合キャッシュ操作実装
- **対象**: `src/storage/sqlite.ts`のconsolidated関連メソッド
- **内容**: readConsolidated（SELECT）、writeConsolidated（UPSERT）、isConsolidationStale（memoriesの件数とconsolidatedのsource_entry_countを比較）
- **完了条件**: 統合データのread/write/鮮度チェックがSQLiteで動作する
- **テスト**: writeConsolidated→readConsolidated→一致検証、save追加後→isConsolidationStale→true

### TASK-020: SQLiteStorageテーマ操作実装
- **対象**: `src/storage/sqlite.ts`のtheme関連メソッド
- **内容**: getThemes（SELECT）、addThemes（INSERT OR IGNORE）、isNewTheme（SELECT COUNT）
- **完了条件**: テーマのCRUDがSQLiteで動作する
- **テスト**: addThemes→getThemes→含まれている、isNewTheme→true/false

### TASK-021: SQLiteStorageセッショントピック操作実装
- **対象**: `src/storage/sqlite.ts`のsession topic関連メソッド
- **内容**: getSessionTopic（SELECT）、setSessionTopic（INSERT OR REPLACE）
- **完了条件**: セッショントピックのread/writeがSQLiteで動作する
- **テスト**: setSessionTopic→getSessionTopic→一致検証

## フェーズ4: マイグレーション

### TASK-022: v1→v2マイグレーション実装
- **対象**: `src/storage/migration.ts`（新規作成）
- **内容**: v1のMarkdownStorage（parser.ts使用）で全カテゴリ読み出し→SQLiteにINSERT。vectors.json読み出し→vectorsテーブルにINSERT。全体をトランザクションで実行
- **完了条件**: v1のmdファイルとvectors.jsonの内容がSQLiteに完全移行される
- **テスト**: テスト用v1ファイル作成→migrateV1ToV2→SELECT全件→内容一致検証

### TASK-023: マイグレーション判定 + 自動実行
- **対象**: `src/storage/sqlite.ts`のneedsMigration + initialize拡張
- **内容**: memory.db未存在 AND v1のmdファイル存在 → migrateV1ToV2を自動呼び出し。冪等性（schema_versionで判定）
- **完了条件**: v1ファイルがある状態でSQLiteStorage初期化→自動マイグレーション実行→再初期化で二重実行されない
- **テスト**: v1ファイル配置→initialize→マイグレーション確認→再initialize→件数変わらず

## フェーズ5: 既存コード切り替え

### TASK-024: storage/index.ts の export切り替え
- **対象**: `src/storage/index.ts`
- **内容**: `export { MarkdownStorage }` → `export { SQLiteStorage }` + `export { MarkdownStorage }` (マイグレーション用に残す)。型エイリアスで後方互換を提供するか、各ファイルのimportを変更
- **完了条件**: `import { SQLiteStorage } from "../storage/index.js"` で利用可能
- **テスト**: ビルドが通ること

### TASK-025: tools/save.ts のSQLiteStorage切り替え
- **対象**: `src/tools/save.ts`
- **内容**: MarkdownStorage→SQLiteStorage、EmbeddingService→LocalEmbedding、VectorStore直接操作→SQLiteStorage.upsertVector に差し替え
- **完了条件**: memory_saveがSQLite経由で動作する
- **テスト**: handleMemorySave呼び出し→SQLiteに保存されている

### TASK-026: tools/search.ts のSQLiteStorage切り替え
- **対象**: `src/tools/search.ts`
- **内容**: MarkdownStorage→SQLiteStorage、EmbeddingService→LocalEmbedding、VectorStore→SQLiteStorage.searchVectors。SearchScorerのランキングロジックは維持
- **完了条件**: memory_searchがSQLite+ローカルembedding経由で動作する
- **テスト**: save→search→結果が返る

### TASK-027: tools/getDetail.ts, getContext.ts, delete.ts, updateIntensity.ts のSQLiteStorage切り替え
- **対象**: `src/tools/getDetail.ts`, `src/tools/getContext.ts`, `src/tools/delete.ts`, `src/tools/updateIntensity.ts`
- **内容**: MarkdownStorage→SQLiteStorageに差し替え
- **完了条件**: 4ツールがSQLite経由で動作する
- **テスト**: 各ツールのハンドラー呼び出し→期待結果

### TASK-028: tools/index.ts にstash/restoreツール登録
- **対象**: `src/tools/index.ts`
- **内容**: memoryStashTool, memoryRestoreTool をimportしてツール一覧に追加
- **完了条件**: MCPサーバーのツール一覧にmemory_stash, memory_restoreが含まれる
- **テスト**: ツール定義配列の長さが12（10+2）

### TASK-029: cli/context.ts のSQLiteStorage切り替え
- **対象**: `src/cli/context.ts`
- **内容**: MarkdownStorage→SQLiteStorage。統合データ読み出しもSQLite経由に変更
- **完了条件**: wasurenagusa-contextがSQLite経由でcontext注入する
- **テスト**: CLI実行→stdout出力にconfig/dont内容が含まれる

### TASK-030: cli/analyze.ts のSQLiteStorage切り替え
- **対象**: `src/cli/analyze.ts`
- **内容**: MarkdownStorage→SQLiteStorage。保存・embedding・セッショントピック保存をSQLite経由に変更
- **完了条件**: wasurenagusa-analyzeがSQLite経由で自動保存する
- **テスト**: CLI実行→SQLiteにエントリが追加される

### TASK-031: consolidator/staleness.ts のSQLiteStorage切り替え
- **対象**: `src/consolidator/staleness.ts`
- **内容**: ファイルstat比較→SQLiteStorage.isConsolidationStale呼び出しに変更。readConsolidatedDont/writeConsolidatedDont等もSQLiteStorage経由に
- **完了条件**: 統合鮮度チェックがSQLiteメタデータで動作する
- **テスト**: isConsolidationStale→期待結果

### TASK-032: vector/theme-registry.ts のSQLiteバックエンド切り替え
- **対象**: `src/vector/theme-registry.ts`
- **内容**: themes.json読み書き→SQLiteStorage.getThemes/addThemes/isNewTheme呼び出しに変更
- **完了条件**: テーマレジストリがSQLite経由で動作する
- **テスト**: addThemes→getThemes→含まれている

### TASK-033: cli/backfill-worker.ts のSQLiteStorage切り替え
- **対象**: `src/cli/backfill-worker.ts`
- **内容**: VectorStore→SQLiteStorage.upsertVector、EmbeddingService→LocalEmbedding に差し替え
- **完了条件**: backfillワーカーがSQLite+ローカルembedding経由で動作する
- **テスト**: 未embedding エントリがある状態でbackfill実行→vectorsテーブルに追加される

### TASK-034: types.ts にv2型定義追加
- **対象**: `src/types.ts`
- **内容**: StashParams, StashResult, RestoreResult の型定義を追加
- **完了条件**: 新型がexportされビルドが通る
- **テスト**: tscビルド成功

### TASK-035: config.ts のv2設定追加
- **対象**: `src/config.ts`
- **内容**: sqliteFile ('memory.db'), embeddingModelName ('Xenova/all-MiniLM-L6-v2'), embeddingDimensions (384), modelsDir ('models'), stashDefaultTtlHours (24) を追加
- **完了条件**: config.sqliteFile等が参照可能
- **テスト**: config値の存在確認

### TASK-036: package.json 依存追加
- **対象**: `package.json`
- **内容**: dependencies に better-sqlite3, sqlite-vec, @huggingface/transformers を追加。devDependencies に @types/better-sqlite3 を追加
- **完了条件**: `npm install` が成功し、importが解決する
- **テスト**: npm install → tscビルド成功

## フェーズ6: 統合テスト + クリーンアップ

### TASK-037: E2E統合テスト（save→search→getDetail→delete フロー）
- **対象**: 新規テストファイル
- **内容**: SQLiteStorage + LocalEmbedding を組み合わせた一連のフロー検証
- **完了条件**: save→search（FTS5+ベクトル）→getDetail→delete の全フローがパスする
- **テスト**: テスト自体が成果物

### TASK-038: E2E統合テスト（stash→restore フロー）
- **対象**: 新規テストファイル
- **内容**: stash→restore→TTL超過restore の一連フロー検証
- **完了条件**: 退避・復元・TTL超過の全パターンがパスする
- **テスト**: テスト自体が成果物

### TASK-039: E2E統合テスト（マイグレーション フロー）
- **対象**: 新規テストファイル
- **内容**: v1テストデータ作成→マイグレーション→SQLiteからの読み出し検証
- **完了条件**: v1の全データがSQLiteに正確に移行される
- **テスト**: テスト自体が成果物
