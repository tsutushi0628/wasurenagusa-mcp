# Tasks: operation-logging

## 実装粒度ルール

1タスク = 1ファイル × 1関数/コンポーネント以内。テスト→実装→リファクタの順。

## 設計上の重要判断

service-blueprint「session_idはMCPサーバー起動時に1つ」案を変更する。これでは全リクエストが同じ`session_id`になり、searchとgetDetailの連鎖判定（`parent_session_id`）が意味をなさない。

**正しい設計**: 各searchリクエストに固有の`session_id`を生成し、モジュールスコープの`lastSearch`変数に記録。getDetailはそこを参照して`parent_session_id`を決定。

---

## TASK-OL-01: OperationLoggerのテスト（型・エントリ構造）

**ファイル**: `src/utils/operation-logger.test.ts`（新規）  
**関数**: ログエントリ型の構造検証

### What

- `SearchLogEntry`型のオブジェクトが必須フィールドを持つことをコンパイル時に確認
- `GetDetailLogEntry.parent_session_id`がnull or stringになることを確認
- テスト: 両エントリ型を組み立て、フィールドが期待通りかアサート

### Done

- vitestが型エラーなく通る

---

## TASK-OL-02: OperationLoggerのテスト（ファイル書き込み）

**ファイル**: `src/utils/operation-logger.test.ts`（追記）  
**関数**: `logOperation()`

### What

- `logOperation`を呼ぶと、一時ディレクトリの`logs/operation-YYYY-MM-DD.jsonl`に1行追記される
- ログディレクトリが存在しない場合、自動作成されてから書き込まれる
- 書き込まれた内容が正しいJSONLである（`JSON.parse`できる）

### Done

- vitestでテストが通る
- テスト後に一時ディレクトリを削除する

---

## TASK-OL-03: OperationLoggerのテスト（エラー耐性）

**ファイル**: `src/utils/operation-logger.test.ts`（追記）  
**関数**: `logOperation()` — 書き込み失敗時

### What

- `fs.appendFile`を失敗させたとき、`logOperation`がthrowしないことを確認
- 失敗時に`console.error`が呼ばれることを確認（spy）
- 100msタイムアウト: 50msの遅延appendFileに対してタイムアウトが機能することを確認

### Done

- vitestでテストが通る

---

## TASK-OL-04: operation-loggerモジュールの実装

**ファイル**: `src/utils/operation-logger.ts`（新規）  
**関数**: `logOperation(entry, memoryPath)`

### What

- `SearchLogEntry | GetDetailLogEntry`を受け取りJSONL追記
- ログパス: `{memoryPath}/logs/operation-YYYY-MM-DD.jsonl`（JST日付）
- ディレクトリ自動作成: `fs.promises.mkdir({ recursive: true })`
- 100msタイムアウト: `Promise.race([appendFile, timeoutPromise])`
- エラー時: `console.error`、例外を外に出さない（Promiseをrejectしない）

### Done

- TASK-OL-02, TASK-OL-03のテストが通る

---

## TASK-OL-05: session_idキャッシュとparent_session_id判定のテスト

**ファイル**: `src/utils/operation-logger.test.ts`（追記）  
**関数**: `setLastSearch()`, `resolveParentSessionId()`

### What

- searchの後5分以内かつID積集合あり → `parent_session_id`にsearch session_idが入る
- searchの後5分超え → `parent_session_id`がnull
- requestedIdsとresultIdsに積集合なし → `parent_session_id`がnull
- 異なるproject → キャッシュが混在しない（projectキーで分離）

### Done

- vitestでテストが通る

---

## TASK-OL-06: session_idキャッシュの実装

**ファイル**: `src/utils/operation-logger.ts`（追記）  
**関数**: `setLastSearch(project, sessionId, resultIds)`, `resolveParentSessionId(project, requestedIds)`

### What

- モジュールスコープ: `Map<project, { sessionId: string; timestamp: number; resultIds: string[] }>`
- `setLastSearch`: searchログ記録時にキャッシュを更新
- `resolveParentSessionId`: 5分以内 AND ID積集合1件以上 → sessionId返却, それ以外 → null
- WINDOW = 5分（300000ms）

### Done

- TASK-OL-05のテストが通る

---

## TASK-OL-07: handleMemorySearchへのログ呼び出し追加

**ファイル**: `src/tools/search.ts`（変更）  
**関数**: `handleMemorySearch`

### What

- 処理開始時に`startTime = Date.now()`
- returnの直前に: `void logOperation(searchEntry, memoryPath).catch(() => {})` および `setLastSearch(project, sessionId, resultIds)`
- 変更行数: 5行以内
- 既存の返却値・型に変更なし

### Done

- 既存テストが引き続き通る（regressionなし）
- 型エラーなし

---

## TASK-OL-08: handleMemoryGetDetailへのログ呼び出し追加

**ファイル**: `src/tools/getDetail.ts`（変更）  
**関数**: `handleMemoryGetDetail`

### What

- 処理開始時に`startTime = Date.now()`
- returnの直前に: `void logOperation(getDetailEntry, memoryPath).catch(() => {})`
- `parent_session_id`は`resolveParentSessionId(project, requestedIds)`で取得
- 変更行数: 5行以内

### Done

- 既存テストが引き続き通る（regressionなし）
- 型エラーなし

---

## 実装順序

```
TASK-OL-01 → TASK-OL-02 → TASK-OL-03 (テスト3本)
  ↓
TASK-OL-04 (logOperation実装)
  ↓
TASK-OL-05 (キャッシュテスト)
  ↓
TASK-OL-06 (キャッシュ実装)
  ↓
TASK-OL-07 → TASK-OL-08 (ツール層追加)
```

## 設計成果物

| ファイル | 内容 |
|---------|------|
| `requirements.md` | 機能要件・非機能要件 |
| `service-blueprint.md` | サービスブループリント・フロー |
| `design.md` | アーキテクチャ設計・Code Reuse Analysis |
| `tasks.md` | このファイル |
