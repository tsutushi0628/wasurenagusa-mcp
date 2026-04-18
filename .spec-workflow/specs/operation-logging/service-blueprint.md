# サービスブループリント: 操作ログ記録

## 1. 登場人物

| 役割 | 誰 | サービスとの関わり方 |
|------|-----|-------------------|
| 直接ユーザー | 記憶MCP運用者（自分たち） | ログファイルを読んで集計・分析する |
| 間接ユーザー | Claude Code（AIアシスタント） | memory_search / memory_get_detail を呼び出す側 |
| システム（ロガー） | 操作ログ記録モジュール | 各ツール呼び出しをフックしてJSONLファイルに追記 |
| システム（既存） | memory_search / memory_get_detail ハンドラ | 変更なし。ロガーを呼ぶだけ |

## 2. 時系列フロー

```
Claude Codeの1セッション（数十分〜数時間）

  AIが話題を想起
      ↓
  memory_search呼び出し  ←── [ログ記録: search, session_id=A, hit_count=5]
      ↓
  インデックス結果を見て判断
      ↓
  必要なエントリだけmemory_get_detail  ←── [ログ記録: get_detail, parent_session_id=A, found_count=2]
      ↓
  フル内容でタスク継続

  （または）
  memory_search呼び出し  ←── [ログ記録: search, session_id=B, hit_count=0]
      ↓
  ヒットなし → get_detailは呼ばれない
```

**集計で見たいもの**: セッションBのように検索だけ呼ばれてget_detailが来なかった割合 = 「ヒット率（詳細掘り下げ率）」

---

## 3. 三層サービスブループリント

### フロントステージ（AIと運用者が見える部分）

- AIは `memory_search` / `memory_get_detail` を呼ぶ。インターフェースは変わらない
- 運用者は `.wasurenagusa/logs/operation-YYYY-MM-DD.jsonl` を読んで集計する
- ログ形式はJSONL（1行1イベント）。`jq` や `grep` で処理できる

### バックステージ（AIには見えない処理）

1. `handleMemorySearch` の末尾で `logOperation("search", {...})` を非同期呼び出し
2. `handleMemoryGetDetail` の末尾で `logOperation("get_detail", {...})` を非同期呼び出し
3. `logOperation` はJSONLを `.wasurenagusa/logs/operation-YYYY-MM-DD.jsonl` に追記
4. セッションIDはプロセス起動時（MCPサーバー起動時）に1つのUUIDを生成してモジュール変数で保持
5. `get_detail` 呼び出し時は、直近 `search` のsession_idを `parent_session_id` として添付

**処理の非同期化**:
- `logOperation` は `Promise` を返すが、ハンドラ側では `await` しない（fire-and-forget）
- 書き込みは `fs.appendFile`（非同期）を使用
- 100ms タイムアウトを設けてブロックを防止

### 支援プロセス（インフラ・運用）

- ログファイルはローカルファイルシステムのみ
- 日付ローテーション（`operation-YYYY-MM-DD.jsonl`）で自動的に分割
- 古いログファイルの削除ポリシーは今バージョンのスコープ外（手動削除）
- ログのモニタリング・可視化ダッシュボードは今バージョンのスコープ外

---

## 4. 失敗フロー

| 失敗パターン | 影響範囲 | リカバリ手段 |
|------------|---------|------------|
| ログファイルへの書き込み失敗（ディスク満杯・権限不足） | ログが欠損する（検索・取得結果は正常） | エラーをconsole.errorに出力。本体処理は続行 |
| ログディレクトリが存在しない | 初回のみ発生 | `fs.mkdir({ recursive: true })` で自動作成 |
| ログ書き込みが100msを超える | タイムアウト発生、ログ欠損 | タイムアウト後に本体返却。超過はconsole.warnで記録 |
| MCPサーバーが異常終了 | セッション中の未書き込みログが消える | fs.appendFileはバッファなしで書き込む（逐次追記）ため損失は最小 |
| ログファイルが壊れる（不完全なJSON行） | 集計時にその行だけエラーになる | JSONL形式なので他行への影響なし。集計側でエラー行をスキップ |

---

## 5. 影響範囲

### 上流への影響

- `memory_search` / `memory_get_detail` のインターフェース（引数・戻り値）は変更なし
- MCPツール定義（スキーマ）変更なし
- AIから見た挙動は変わらない

### 下流への影響

- `.wasurenagusa/logs/` ディレクトリが新規作成される（既存の `.wasurenagusa/` 配下の構造変更）
- SQLiteデータには一切書き込まない

### 並行フローへの影響

- `wasurenagusa-analyze`（Stop Hook）はSQLiteに書き込むが、logsディレクトリは触らないため干渉しない
- 複数のMCPセッションが並行した場合、同一ファイルへの並行書き込みが発生する可能性がある。`fs.appendFile` は原子的でないため行が混ざるリスクがあるが、記録の完全性よりも本体処理への無影響を優先する（ベストエフォート）

---

## 6. architectへのインプット

### 実装対象

| 対象 | 変更の性質 |
|------|----------|
| `src/tools/search.ts` の `handleMemorySearch` | ログ呼び出しを追記（5行以内） |
| `src/tools/getDetail.ts` の `handleMemoryGetDetail` | ログ呼び出しを追記（5行以内） |
| `src/utils/operation-logger.ts` | 新規作成。`logOperation` 関数の実装 |

### データモデル

```typescript
type SearchLogEntry = {
  ts: string;               // ISO 8601
  operation_type: "search";
  session_id: string;       // MCPサーバー起動時に生成したUUID
  query: string;
  category: string;
  hit_count: number;
  project: string;
};

type GetDetailLogEntry = {
  ts: string;
  operation_type: "get_detail";
  session_id: string;
  parent_session_id: string | null;  // 直近searchのsession_id
  requested_ids: string[];
  found_count: number;
  project: string;
};
```

### 設計上の制約

1. `logOperation` は必ず非同期で呼び出し、`await` しないこと
2. 記憶本体のSQLiteには触らない
3. ログ書き込みエラーは `throw` せず、`console.error` で出力して吸収すること
4. セッションIDはMCPサーバープロセスに1つ。リクエストごとに変えない

### ファイル命名規則

- `src/utils/operation-logger.ts`（`_common-rules.md` のkebab-case規則に準拠）
- ログファイル: `.wasurenagusa/logs/operation-YYYY-MM-DD.jsonl`

---

## 7. 主要ユースケース

### UC-OL-1: 検索ヒット率の週次確認

**場面**: 月曜朝、運用者が先週の記憶MCPの有効性を確認したい

**操作フロー**:
```
1. 運用者が .wasurenagusa/logs/ を開く
2. 先週のJSONLファイルを選択
3. jqで集計:
   cat operation-2026-04-14.jsonl | jq -s '
     {
       search_count: [.[] | select(.operation_type=="search")] | length,
       detail_count: [.[] | select(.operation_type=="get_detail")] | length
     }
   '
4. hit_rate = detail_count / search_count で算出
```

**期待出力例**:
```json
{ "search_count": 42, "detail_count": 18 }
→ ヒット率: 42.8%
```

### UC-OL-2: クエリパターンの確認

**場面**: 「よく検索されているのにhitしないクエリ」を探して記憶の質を改善したい

**操作フロー**:
```
1. get_detailが続かないsearchのqueryを抽出:
   cat operation-*.jsonl | jq -r 'select(.operation_type=="search" and .hit_count==0) | .query'
2. 頻出パターンを確認し、記憶エントリを補充する
```

---

## 8. 非機能要件サマリ（architectへの確認事項）

| 項目 | 要件 | 理由 |
|------|------|------|
| 応答時間増加 | 10ms以内 | 本体レスポンス劣化なし |
| ログ失敗時の挙動 | 本体処理は続行 | ログは補助情報、記憶取得が最優先 |
| 外部送信 | 禁止 | ローカル完結が大原則 |
| SQLite変更 | なし | 既存データ汚染リスクゼロ |
| ログ完全性 | ベストエフォート | 欠損より遅延のほうが問題 |
