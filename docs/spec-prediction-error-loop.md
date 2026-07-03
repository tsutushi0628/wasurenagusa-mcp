# 予測誤差ループ（Prediction-Error Loop）実装spec

## 1. 背景と目的

記憶ストアは現状「結果（何が起きたか・なぜダメか）」しか持たない。探索（タスク実行）の前後で「着手前に効くと見立てた変数」と「実際に効いた変数」を取り、その**差分**を世界モデル更新の信号にする。差分が大きい記憶ほど「見立てが外れた＝学ぶべき点」であり、次セッションで優先的に surface する。

これは「知識を増やす」のでも「探索を増やす」のでもなく、「世界の認知（何が重要か）の精度」を上げるための仕組み。当面は手動／明示API経由で完全に回る形（v1）を作る。Stop hook での自動捕捉は v2（本specのスコープ外、最終節参照）。

## 2. データモデル（追加フィールド）

メモリ1件に optional で4フィールドを足す。既存フィールドは一切変えない。

| フィールド | 型 | 意味 |
|---|---|---|
| `predictedFactors` | `string[]`（最大3） | 着手前に「この問題で効く」と見立てた変数 |
| `actualFactors` | `string[]` | 終了後に実際効いた変数 |
| `predictionError` | `number`（0〜1） | 予測と実測の差分スカラ。**コードで自動算出**（後述） |
| `predictionDelta` | `string`（任意・30〜80字） | 差分の核心を人間可読1行で。任意入力 |

SQLite列名（snake_case）: `predicted_factors TEXT`, `actual_factors TEXT`, `prediction_error REAL`, `prediction_delta TEXT`。配列2つはJSON文字列で格納（`tags`/`knowledge_gap`と同じ）。

## 3. 確定済み設計判断（実装中に再検討しない）

1. **`predictionError` は `intensity` に相乗りさせず独立スカラとする。** `intensity` は「叱責の強さ」で、`angerHistory`（intensity≥4）/ critical昇格（intensity=5）/ dont統合 が全て参照している。相乗りさせると予測誤差案件が既存の再発防止ロジックに混入する。独立スカラなら既存挙動はゼロ影響。

2. **差分計算はコード側で完結（LLM不使用）。** `predictedFactors` と `actualFactors` の集合非一致度（Jaccard距離）で算出する。`refs/llm-design.md`原則「分岐・集計・厳密判定はコード側、LLMは曖昧判断のみ」に従う。差分の意味解釈をLLMに投げる設計は v1では採らない。

3. **「②世界モデルへの昇格」＝ `getContext`（SessionStart注入）の新ブロック。** `consolidated`テーブルに新type（worldmodel）を足す案はCHECK制約のテーブル再作成マイグレーションを伴うため v1では採らない。`getContext` が「予測が大きく外れた上位N件」を返すだけで「世界モデルが毎セッションsurfaceされて育つ」は成立する。

4. **`predictedFactors`/`actualFactors`/`predictionDelta` を embedding 対象テキストに混ぜない。** `save.ts` の `textToEmbed = params.title + " " + params.content`（L167）は変えない。予測を混ぜると検索ベクトルが変質する。

5. **後方互換は前例（`positive_action` v2→v3、`scenario`/`why_core` v3→v4）の `ALTER TABLE ADD COLUMN`（冪等）パターンを完全踏襲する。** 既存DB・既存エントリ（新列NULL）は無害に読める設計を死守する。

## 4. 変更箇所（前例を引用しながら）

### 4-1. `src/types.ts`
- `MemoryEntry`（L17-31）の末尾に4フィールドを optional 追加。コメントで「予測誤差ループ用」と明記。
- `MemoryIndexEntry`（L34-46）に `predictionError?: number` と `predictionDelta?: string` を追加（検索結果一覧で差分大を表面化するため。`whyCore`等が索引に載っているのと同型）。
- `SaveParams`（L49-62）に4フィールド optional 追加。
- `ContextResult`（L103-106）に `worldModelUpdates?: string` を追加。

### 4-2. `src/storage/schema.ts`
- `DDL` の `memories` テーブル定義（L7-23）、`why_core TEXT`（L20）の直後・`created_at`（L21）の前に4列追加:
  ```
  predicted_factors TEXT,
  actual_factors TEXT,
  prediction_error REAL,
  prediction_delta TEXT,
  ```
- `CURRENT_SCHEMA_VERSION`（L3）を `4` → `5`。
- FTS5（L31-54）は触らない（title/content/tagsのみ同期で正しい）。

### 4-3. `src/storage/migration.ts`
- `migrateV3ToV4`（L268-287）を**雛形にして** `migrateV4ToV5` を新設:
  - 冪等チェック: `pragma_table_info('memories')` に `predicted_factors` が在ればreturn。
  - `db.transaction` 内で `ALTER TABLE memories ADD COLUMN` を4回（predicted_factors TEXT / actual_factors TEXT / prediction_error REAL / prediction_delta TEXT）。
  - `schema_version` に `5` を `INSERT OR REPLACE`。
- 注意: `migrateV1ToV2` のテーブル再作成式（`memories_new` の DDL と INSERT SELECT, L182-205）には新列を**足さない**（positive_action等も足していない既知の限界に揃える。v1からの移行は別系統）。

### 4-4. `src/storage/sqlite.ts`
- `initialize()`（L43-75）の `migrateV3ToV4(this.db)` 呼び出し（L64）の直後、`deleted_at` ALTER（L68）の前に `if (memoriesTableExists) { migrateV4ToV5(this.db); }` を追加。import も追加。
- `save()`（L103-154）:
  - 値の準備: `predicted_factors`/`actual_factors` は `params.xxx !== undefined ? JSON.stringify(params.xxx) : null`（`knowledgeGap` L108 と同じパターン）。`prediction_error` は `params.predictionError ?? null`、`prediction_delta` は `params.predictionDelta ?? null`。
  - INSERT文（L138-141）: 列リストに4列、プレースホルダを13→17個、`insertStmt.run`（L142-146）の引数に4つ追加。**列数・プレースホルダ数・run引数数の3つが一致していることを実装後に必ず数えて確認**（沈黙バグの最頻発点）。
  - UPDATE文（L116-128）にも同じ4列を追加（`updateStmt.run` 引数の順序・`WHERE id = ?` の位置に注意）。
- `MemoryRow` interface（L857-873）に4列追加: `predicted_factors: string | null;` 等。
- `rowToEntry()`（L783-812）に4フィールドのNULL handling追加（`positive_action` L802-804、`knowledge_gap` のJSON.parse try/catch L795-801 を踏襲）。配列2つはJSON.parse（失敗時は省略）、`prediction_error` は数値、`prediction_delta` は文字列。
- **新メソッド `listHighErrorEntries(minError: number, limit: number)`** を `listHighIntensityDonts`（L707-766）を雛形に新設:
  - SQL: `SELECT id, timestamp, category, title, tags, project, scope, prediction_error, prediction_delta FROM memories WHERE prediction_error IS NOT NULL AND prediction_error >= ? AND deleted_at IS NULL ORDER BY prediction_error DESC, timestamp DESC LIMIT ?`
  - 返却は軽量（id/title/predictionError/predictionDelta 等）。
- `getContext()`（L446-460）に worldModelブロックを追加:
  - `const worldModelEntries = this.listHighErrorEntries(WORLD_MODEL_MIN_ERROR, WORLD_MODEL_LIMIT);`
  - 整形して `worldModelUpdates` として `ContextResult` に含める（dont/configと並べる）。
  - 定数 `WORLD_MODEL_MIN_ERROR`（初期値0.5）と `WORLD_MODEL_LIMIT`（初期値3、dreamのSEED_LIMIT=3に倣う）をファイル先頭に定義（マジックナンバー禁止）。

### 4-5. `src/vector/prediction-error.ts`（新規）
- `export function computePredictionError(predicted: string[], actual: string[]): number | undefined`
  - 各要素を `trim().toLowerCase()` で正規化し、空要素を除去。
  - どちらかが空配列なら `undefined`（差分計算不能 → 保存しない）。
  - Jaccard距離: `1 - (交差集合サイズ / 和集合サイズ)`。0=完全一致（見立て的中）、1=全外し。
  - 戻り値は0〜1。小数第3位で丸め。
- 純粋関数（I/O無し・LLM無し）。

### 4-6. `src/tools/save.ts`
- `memorySaveTool.inputSchema.properties`（L24-62）に optional 追加:
  - `predictedFactors`: `{ type: "array", items: { type: "string" }, description: "着手前に『この問題で効く』と見立てた変数（最大3）。後で actualFactors と突合して予測誤差を自動算出する" }`
  - `actualFactors`: `{ type: "array", items: { type: "string" }, description: "終了後に実際効いた変数。predictedFactors と両方あると predictionError が自動計算される" }`
  - `predictionDelta`: `{ type: "string", description: "予測と実測の差分の核心を1行（任意、30〜80字）" }`
  - `required` は `["category","title","content"]` のまま据え置く。
- `handleMemorySave`（L96-133）:
  - `normalizeTags`（L68-84）を流用して `predictedFactors`/`actualFactors` を配列化。
  - 両方が非空なら `computePredictionError` を呼び `predictionError` を得る（`undefined` ならフィールド省略）。
  - `params`（L122-133）に4フィールドを詰める。
  - **embedding対象テキスト（L167）は変えない。**

### 4-7. `src/vector/search-scorer.ts`
- `ScoreParams`（L1-7）に `predictionError?: number` を追加。
- `score()`（L10-32）に第5項 `errorBoost` を追加:
  - `const errorBoost = 1.0 + Math.min(0.3, (predictionError ?? 0) * 0.3);`（恒等元1.0、cap 1.3。accessBoost の 1.2 とおおむね釣り合う）。
  - 戻り式を `vectorSimilarity * tagWeightScore * freshness * accessBoost * errorBoost` に。
- `predictionError` 未指定時は `errorBoost=1.0` で既存スコア完全不変（後方互換）。

### 4-8. `src/tools/search.ts`
- スコアリングブロック（reader報告のL162-193付近）で、対象エントリの `prediction_error` を引いて `ScoreParams.predictionError` に渡す。`getDetail` の row もしくは軽量バッチ取得で引く（既存の metadata 取得と同様の最小実装でよい）。
- 既存挙動を壊さないこと（predictionError が無いエントリは恒等で素通り）。

## 5. テスト要件（業務意図を検証する）

`refs` のテスト原則（実装の途中計算を写すアサーション禁止・業務要件を検証）に従う。

1. `prediction-error.test.ts`: 完全一致→0、全外し→1、半分一致→0.5前後、空配列→undefined、大文字小文字/空白ゆれが正規化される。
2. migration: `migrateV4ToV5` を2回呼んでもエラーにならない（冪等）。v4スキーマのDBに対し4列が追加され `schema_version=5` になる。
3. 往復: `memory_save` に predictedFactors+actualFactors を渡す→`getDetail` で4フィールドが正しく復元される。predictionError がコード算出値と一致する。
4. **後方互換**: 予測4列がNULLの既存row（旧データ相当）を `rowToEntry` が例外なく読み、予測フィールドが `undefined` になる。
5. `getContext`: prediction_error が閾値超のエントリが `worldModelUpdates` に出る。閾値未満・NULLは出ない。
6. `search-scorer`: predictionError未指定でスコアが従来値と一致（恒等元）。predictionError=1でboostがcap 1.3で頭打ち。

## 6. 後方互換チェックリスト（実装後に全件確認）

- [ ] INSERT文の「列数 = プレースホルダ数 = run引数数」が一致（17で揃う）。
- [ ] UPDATE文の列順とrun引数順が一致、`WHERE id=?` が末尾。
- [ ] 既存テスト（save/search/migration/consolidate系）が全緑。
- [ ] 予測フィールド未指定の `memory_save` が従来と同一挙動（4列NULL保存）。
- [ ] embedding対象テキストに予測フィールドが混ざっていない。
- [ ] `migrateV4ToV5` が既存v4 DBに無害適用（列存在チェックで冪等）。
- [ ] `npm run build`（tsc）が通る。

## 7. スコープ外（v2: Stop hook 自動捕捉）

本specは「予測と実測を明示的に渡せば差分が算出・保存・surface・recall加点される」完全ループまで。以下は v2 として分離（v1完了後にオーナー承認の上で着手）:

- `prompts/analysis.txt` に「今セッションで効いた変数」抽出フィールドを足し、Stop hook（`cli/analyze.ts`）が前セッションの予測（`session_topics` 同様の予測キャッシュ）と自動突合して `actualFactors`/`predictionError` を充填する。
- SessionStart（`cli/context.ts`）で「次セッションで効くと予測する変数」をLLMに宣言させて予測キャッシュに保存する。
- v2はLLM出力契約の変更を伴うため、差分算出は warning 設計（throwで Stop hook を巻き込まない、`refs/llm-design.md`原則③）。
