# Design Document: operation-logging

## Overview

MCPツール（memory_search / memory_get_detail）の呼び出しを、既存SQLiteとは独立したJSONLファイルに非同期で記録する。ログ記録の失敗がツール本体の動作に影響しないfire-and-forget設計。

## Code Reuse Analysis

### firebase-kit棚卸し

本プロジェクトはfirebase-kitサブモジュールを持たないローカルNode.jsサービスのため、firebase-kit棚卸しは対象外。

### 既存コードベース活用可能な機能

| 機能 | ファイル | 活用方法 |
|------|---------|---------|
| JSTタイムスタンプ生成パターン | `src/storage/sqlite.ts:generateTimestamp()` | privateのため同パターンをlogWriter内で実装 |
| `getMemoryPath` | `src/config.ts:78` | ログ保存先ディレクトリの導出に使用 |
| `config.logRetentionDays` | `src/config.ts:43` | 操作ログ保持期間の設定値として参照 |
| `randomBytes`によるID生成 | `src/storage/sqlite.ts:generateId()` | session_id生成に同一パターンを使用 |

### 新規作成が必要な機能

- `src/utils/operation-log-writer.ts` — JSONL書き込み・セッションID管理
- 既存ツール層への呼び出し追加（search.ts, getDetail.ts）

## Architecture

### コンポーネント構成

```
src/utils/
└── operation-log-writer.ts   # 新規: ログ書き込み・session_id管理

src/tools/
├── search.ts                  # 変更: handleMemorySearch末尾にlog呼び出し追加（1行）
└── getDetail.ts               # 変更: handleMemoryGetDetail末尾にlog呼び出し追加（1行）

src/cli/
└── context.ts                 # 変更: 古いログファイル削除の呼び出しを追加
```

### データフロー

```
handleMemorySearch()
  ↓ 主処理完了・result確定
  ↓ return resultJson   ← レスポンスを先に返す
  ↓ [fire-and-forget] logWriter.recordSearch(...)
       ↓ session_idをメモリ上にキャッシュ
       ↓ fs.appendFile() → .wasurenagusa/logs/operation-YYYY-MM-DD.jsonl

handleMemoryGetDetail()
  ↓ 主処理完了・result確定
  ↓ return resultJson   ← レスポンスを先に返す
  ↓ [fire-and-forget] logWriter.recordGetDetail(...)
       ↓ キャッシュから直近searchのsession_idを参照
       ↓ fs.appendFile() → .wasurenagusa/logs/operation-YYYY-MM-DD.jsonl
```

**注意**: fire-and-forgetの実現方法として、`return`の前にPromiseをvoid実行してから返す。`return`後の行は実行されないため。

```typescript
// 正しい実装パターン
const resultJson = JSON.stringify(result, null, 2);
void logWriter.recordSearch({...}).catch(() => {});  // awaitしない
return resultJson;
```

### ファイル構造

```
.wasurenagusa/
└── logs/
    ├── operation-2026-04-18.jsonl
    ├── operation-2026-04-19.jsonl
    └── ...
```

## Design Details

### operation-log-writer.ts

**責務**: JSONL書き込みと、search→getDetail連鎖判定のためのsession_idキャッシュ管理

#### ログエントリ型

```typescript
interface SearchLogEntry {
  ts: string;              // ISO 8601 JST
  operation_type: "search";
  session_id: string;      // randomBytes生成のユニークID
  query: string;
  category: string;
  hit_count: number;
  project: string;
  duration_ms: number;
}

interface GetDetailLogEntry {
  ts: string;
  operation_type: "get_detail";
  session_id: string;
  parent_session_id: string | null;  // 直近5分以内のsearch session_id（連鎖元）
  requested_ids: string[];
  found_count: number;
  project: string;
  duration_ms: number;
}
```

#### session_idキャッシュ設計

- モジュールスコープのMap: `Map<project, { sessionId: string; timestamp: number; resultIds: string[] }>`
- `recordGetDetail`呼び出し時: requestedIdsとresultIdsの積集合が1件以上 AND 経過時間5分以内 → `parent_session_id`にセット
- キャッシュはプロセスメモリ上のみ（プロセス再起動でリセット、許容）

#### 書き込み設計

- `fs.promises.appendFile()` を try/catch で包む（エラーはstderrのみ）
- ログディレクトリが存在しない場合: `fs.promises.mkdir({ recursive: true })` で自動作成
- 日付ファイル名: `operation-${YYYY-MM-DD}.jsonl`（JST基準）

#### ログローテーション（古いファイル削除）

```typescript
// operation-log-writer.ts に追加するexport関数
export async function cleanOldOperationLogs(memoryPath: string, retentionDays: number): Promise<void>
```

- `logs/`ディレクトリを走査し、`operation-YYYY-MM-DD.jsonl`パターンのファイルを対象
- 日付がretentionDays日以前のファイルを削除
- 呼び出し元: `cli/context.ts`（SessionStart Hook実行時に非同期で実行）

### ツール層への侵襲最小化

`search.ts`と`getDetail.ts`のhandler関数末尾に、void起動の1行を追加するだけ。型変更なし。

```typescript
// search.ts 変更イメージ（returnの直前）
const resultJson = JSON.stringify(result, null, 2);
void recordSearch({ query: params.query, category: params.category ?? "all", hitCount: result.results.length, project: basename(projectRoot), durationMs, memoryPath }).catch(() => {});
return resultJson;
```

## スキーマ変更

既存SQLiteスキーマへの変更なし。JSONLファイルのみ追加。

## tech-lead調査結果を踏まえた設計判断

### 論点1: 操作ログテーブルをmemoriesに同居 vs 別テーブル vs 別ファイル

**判断: JSONLファイル（既存SQLiteと完全分離）**

根拠:
- requirements REQ-4-1, REQ-4-4が「既存SQLiteに書かない」を明示要件として定義済み
- memoriesにCHECK制約があり（`category IN ('config','dont','decision','log','snippet')`）、操作ログカテゴリを追加すると制約変更が必要になり侵襲度が上がる
- FTS5トリガー（`memories_ai`, `memories_ad`, `memories_au`）がすべてのINSERT/UPDATE/DELETEに反応するため、ログINSERTのたびにFTS5インデックスを更新する無駄が生じる
- ベストエフォートのログのためにWAL書き込み負荷を上げる設計は本末転倒

### 論点2: スキーマバージョンのインクリメント戦略

**判断: スキーマバージョンは変更しない**

根拠:
- 既存SQLiteには一切触らないため、スキーマバージョン（`CURRENT_SCHEMA_VERSION=1`）を上げる必要がない
- JSONLファイルはSQLiteスキーマ管理の対象外

### 論点3: ツール呼び出しごとのINSERTでWAL書き込み頻度への影響

**判断: 影響なし（SQLiteを使わないため）**

根拠:
- `fs.promises.appendFile()`はSQLiteのWALとは独立したファイルI/O
- WAL書き込み頻度への影響ゼロ

## リスク・懸念

| リスク | 対策 |
|--------|------|
| プロセス再起動でsession_idキャッシュが消える | 許容（ログ連鎖のベストエフォート） |
| 複数プロジェクトのキャッシュ混在 | projectキーでMap分離 |
| ログファイルの同時書き込み競合 | シングルプロセスモデルのためリスク低 |
| ログディレクトリが存在しない初回起動 | mkdir({ recursive: true })で自動作成 |
| vitestはjestではない | テストコードはvitest APIを使う（describe/it/expect/vi.fn等）。jest.config.*は存在しない |
