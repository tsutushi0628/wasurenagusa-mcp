# Requirements Document: 操作ログ記録

## Introduction

記憶MCPの「検索→詳細取得」の行動連鎖を操作ログとして記録し、「検索して詳細まで掘った率（ヒット率）」を定量評価できるようにする機能。

利用者は記憶MCP運用者（自分たち）であり、本番エンドユーザー向けではない。ログの保存先はローカルのみ（外部送信なし）。

## Alignment with Product Vision

product.md 26番「Analytics: 保存頻度、検索パターン、学習効果の可視化」として将来拡張に挙げられている。本機能はその最初の一歩となる。

トークン削減の効果測定（「検索後に詳細取得が必要だったか」の比率）を可視化することで、記憶設計の改善サイクルを回す土台を作る。

## Requirements

### REQ-1: 検索操作のログ記録

**User Story:** 記憶MCP運用者として、`memory_search` が呼ばれた履歴を記録してほしい。後から「いつ・どんなクエリで・何件ヒットしたか」を集計したいから。

#### Acceptance Criteria

1. WHEN `memory_search` が呼び出された THEN 呼び出し日時・クエリ・カテゴリ・ヒット件数をログに記録する SHALL
2. WHEN ログ記録処理が失敗した THEN `memory_search` 本来の返却値には影響しない SHALL（ログ失敗で検索が壊れてはならない）
3. WHEN ログを記録する THEN 呼び出し元のプロジェクトルートに紐づくローカルファイルに保存する SHALL
4. IF 記録先ディレクトリが存在しない THEN 自動作成して記録を続行する SHALL

### REQ-2: 詳細取得操作のログ記録

**User Story:** 記憶MCP運用者として、`memory_get_detail` が呼ばれた履歴を記録してほしい。「検索後に詳細まで掘り下げたか」の追跡に使いたいから。

#### Acceptance Criteria

1. WHEN `memory_get_detail` が呼び出された THEN 呼び出し日時・要求IDリスト・取得成功件数をログに記録する SHALL
2. WHEN ログ記録処理が失敗した THEN `memory_get_detail` 本来の返却値には影響しない SHALL
3. WHEN ログを記録する THEN `memory_search` のログと同一ファイルに追記する SHALL

### REQ-3: ヒット率の集計可能なログ形式

**User Story:** 記憶MCP運用者として、「検索して詳細まで掘った率」をログファイルから集計できてほしい。外部ツール（jq・スプレッドシート等）で処理できる形式が望ましい。

#### Acceptance Criteria

1. WHEN ログを記録する THEN 1行1イベントのJSONL形式（JSON Lines）で書き込む SHALL
2. WHEN ログを読み返す THEN `operation_type`（"search" / "get_detail"）フィールドで操作種別を識別できる SHALL
3. WHEN `memory_search` のログを記録する THEN `session_id` フィールドを含める SHALL（同一セッション内の「search→get_detail」の紐付けを可能にするため）
4. WHEN `memory_get_detail` のログを記録する THEN 同一セッションの直近 `memory_search` の `session_id` を `parent_session_id` として含める SHALL

### REQ-4: 既存データ・パフォーマンスへの無影響保証

**User Story:** 記憶MCP運用者として、ログ記録の追加によって記憶本体のデータや応答時間に影響が出てほしくない。

#### Acceptance Criteria

1. WHEN ログを書き込む THEN 既存の `.wasurenagusa/` 配下のSQLiteデータには一切書き込まない SHALL
2. WHEN ログを書き込む THEN 同期ファイルI/Oを避け、非同期で書き込む SHALL（本体レスポンスをブロックしない）
3. IF ログ書き込みに100ms以上かかる THEN ログ処理をタイムアウトさせ、本体処理を優先する SHALL
4. WHEN ログを書き込む THEN 記憶本体のSQLite（`.wasurenagusa/*.db`）とは別ファイルに保存する SHALL

## Non-Functional Requirements

### ログ保存先

- パス: `.wasurenagusa/logs/operation-YYYY-MM-DD.jsonl`（日付ローテーション）
- 文字コード: UTF-8
- 外部送信: 禁止（ローカル完結）

### ログエントリ構造

```json
{
  "ts": "2026-04-18T10:00:00.000Z",
  "operation_type": "search",
  "session_id": "uuid-v4",
  "query": "検索クエリ",
  "category": "all",
  "hit_count": 5,
  "project": "my-project"
}
```

```json
{
  "ts": "2026-04-18T10:00:05.000Z",
  "operation_type": "get_detail",
  "session_id": "uuid-v4",
  "parent_session_id": "uuid-v4-of-search",
  "requested_ids": ["id1", "id2"],
  "found_count": 2,
  "project": "my-project"
}
```

### パフォーマンス

- ログ記録による応答時間増加: 目標 10ms 以内
- ログ記録失敗時は本体処理に影響しない（fire-and-forget）

### 信頼性

- ログはベストエフォートで記録（ログ欠損は許容、検索・取得結果の欠損は許容しない）
- ログファイルが壊れても記憶MCPの起動・動作に影響しない

### セキュリティ

- ログに記憶エントリの本文（content）は含めない（クエリ文字列・IDのみ）
- ローカルファイルシステムのみに保存
