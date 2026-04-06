# Requirements Document: storage-engine-v2

## Introduction

wasurenagusa-mcpのストレージエンジンをマークダウンファイルベースからSQLiteベースに刷新する。外部API依存のembedding生成をローカル推論に切り替え、ファイル退避機能を新設する。

**核心理念: 外部依存ゼロ、単一ファイル完結**

### 解決する課題
- マークダウンファイルの全件走査による検索レイテンシ（O(N)）
- Gemini Embedding API依存（ネットワーク障害時にベクトル検索不能）
- vectors.jsonの全件メモリロード（エントリ増加でメモリ圧迫）
- コンテキスト窓にファイル全文が載る問題（トークン浪費）

### 維持する価値
- MCPツール10個のインターフェース（ツール名・パラメータ）は破壊的変更禁止
- Hooks CLI I/F（context.ts: stdin JSON→stdout、analyze.ts: stdin JSON→副作用）
- 3段階開示プロトコル（search→get_detail）
- `.wasurenagusa/`ディレクトリ配置

## Requirements

### REQ-V2-1: SQLiteデータベースへの移行

**User Story:** MCPサーバーとして、全記憶データを単一のSQLiteファイルに保存したい。ファイル分散管理の複雑さをなくし、トランザクション安全性を得るために。

#### Acceptance Criteria

1. WHEN サーバー初回起動 THEN `.wasurenagusa/memory.db`にSQLiteデータベースが作成される SHALL
2. WHEN memory_saveが呼ばれる THEN memoriesテーブルにエントリが挿入される SHALL
3. WHEN memory_searchが呼ばれる THEN FTS5全文検索とベクトル検索のハイブリッド結果が返る SHALL
4. WHEN memory_get_detailが呼ばれる THEN memoriesテーブルからID指定で取得する SHALL
5. WHEN memory_deleteが呼ばれる THEN memoriesテーブルとvectorsテーブルから連動削除する SHALL
6. WHEN memory_get_contextが呼ばれる THEN memoriesテーブルからconfig/dontを読み出す SHALL
7. WHEN memory_update_intensityが呼ばれる THEN memoriesテーブルのintensityカラムを更新する SHALL
8. WHEN 並行セッションから同時書込 THEN WALモード+busy_timeout(5000ms)で安全に処理する SHALL
9. WHEN DBファイルが破損 THEN エラーを上位に伝播する（握りつぶさない） SHALL

### REQ-V2-2: ローカルembedding生成

**User Story:** MCPサーバーとして、外部APIなしでembeddingを生成したい。ネットワーク障害やAPIキー未設定でもベクトル検索を利用可能にするために。

#### Acceptance Criteria

1. WHEN サーバー初回起動 THEN Transformers.jsでall-MiniLM-L6-v2モデルをロードする SHALL
2. WHEN モデル未ダウンロード THEN 初回のみ自動ダウンロードする（約80MB） SHALL
3. WHEN embedding生成が要求される THEN 384次元のベクトルを返す SHALL
4. WHEN モデルロード失敗 THEN エラーを上位に伝播し、ベクトル検索はキーワード検索にフォールバック SHALL
5. WHEN embedding生成 THEN Gemini APIキーの有無に関わらず動作する SHALL

### REQ-V2-3: ファイル退避機能（memory_stash / memory_restore）

**User Story:** AIエージェントとして、大きなファイル内容を一時的に退避し、必要なときだけ復元したい。コンテキスト窓のトークンを節約するために。

#### Acceptance Criteria

1. WHEN memory_stashが呼ばれる THEN ファイル内容をstashテーブルに保存し、要約のみ返却する SHALL
2. WHEN memory_restoreが呼ばれる THEN stashテーブルからフル内容を返却する SHALL
3. WHEN stashデータのTTL(24h)が超過 THEN 自動削除される SHALL
4. WHEN TTL超過後にrestoreが呼ばれる THEN エラーメッセージで通知する SHALL
5. WHEN 要約生成 THEN ルールベース（先頭N行+行数+ファイルタイプ）で生成する SHALL

### REQ-V2-4: v1→v2マイグレーション

**User Story:** 既存ユーザーとして、v1のマークダウンデータがv2のSQLiteに移行されてほしい。データを失いたくないから。

#### Acceptance Criteria

1. WHEN v2サーバー起動時にmemory.dbが存在しない AND v1のmdファイルが存在 THEN 自動マイグレーションを実行する SHALL
2. WHEN マイグレーション THEN 全カテゴリ（config/dont/decision/log/snippet）のエントリを移行する SHALL
3. WHEN マイグレーション THEN vectors.jsonのembeddingデータも移行する SHALL
4. WHEN マイグレーション THEN トランザクション内で実行し、失敗時はv1データが残る SHALL
5. WHEN マイグレーション成功 THEN v1ファイルはそのまま残す（手動削除は任意） SHALL
6. WHEN マイグレーション THEN 冪等であること（再実行しても二重挿入しない） SHALL

### REQ-V2-5: 統合データのSQLite移行

**User Story:** MCPサーバーとして、統合（consolidation）結果もSQLiteに保存したい。JSONファイル管理をやめて一元化するために。

#### Acceptance Criteria

1. WHEN dont統合が実行される THEN consolidatedテーブルに結果が保存される SHALL
2. WHEN config統合が実行される THEN consolidatedテーブルに結果が保存される SHALL
3. WHEN 統合の鮮度チェック THEN SQLiteのメタデータで判定する SHALL
4. WHEN context注入時に統合データが必要 THEN consolidatedテーブルから読み出す SHALL

### REQ-V2-6: テーマレジストリのSQLite移行

**User Story:** MCPサーバーとして、テーマ管理もSQLiteに統合したい。themes.jsonを別管理する必要がないから。

#### Acceptance Criteria

1. WHEN テーマが追加される THEN themesテーブルに保存される SHALL
2. WHEN 新テーマ判定 THEN themesテーブルで確認する SHALL
3. WHEN テーマ一覧取得 THEN themesテーブルから返す SHALL

### REQ-V2-7: 既存インターフェース維持

**User Story:** 既存ユーザー・エージェントとして、v2移行後も同じツール名・同じパラメータで操作したい。移行で使い方が変わるのは困るから。

#### Acceptance Criteria

1. WHEN 既存10ツールが呼ばれる THEN v1と同一のinputSchema・レスポンス形式で動作する SHALL
2. WHEN context.tsが実行される THEN v1と同一のstdin/stdoutインターフェースで動作する SHALL
3. WHEN analyze.tsが実行される THEN v1と同一のstdin→副作用インターフェースで動作する SHALL
4. WHEN 3段階開示プロトコル THEN search→get_detailの流れは維持する SHALL

## Non-Functional Requirements

### NFR-1: パフォーマンス

- memory_searchのレイテンシ: 1万エントリで500ms以内
- memory_saveのレイテンシ: embedding生成込みで2000ms以内
- サーバー起動時間（モデルロード済み）: 3000ms以内

### NFR-2: データ安全性

- SQLite WALモードによる書込中断耐性
- busy_timeout 5000msによる並行アクセス保護
- マイグレーションのトランザクション保証

### NFR-3: 外部依存

- embedding生成: 外部API依存ゼロ（ローカルモデル）
- LLM呼び出し（分析・統合・タグ拡張）: 既存通り外部API使用（変更なし）

### NFR-4: ストレージサイズ

- memory.db: 1万エントリ+384次元ベクトルで推定500MB以内
- all-MiniLM-L6-v2モデル: 約80MB
