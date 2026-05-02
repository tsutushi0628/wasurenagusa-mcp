# Heart Extension 設計

## 1. 概要

### 1.1 オーナーの動機

オーナーの一次目標は「AIアシスタントを人間に近づけ、同じ怒られを繰り返さない存在にする」こと。
現状のwasurenagusa-mcpは dont（やるな）の集約・注入・Stop時ガードまでが揃っているが、以下のギャップがある：

1. **集約データのSQLite側書き込みが抜けており、agentモードでの「行動原則トップ3／インデックス」が常時空**
2. **ガードは Stop Hook 後（既に行動した後）にしか発火せず、行動を未然に止められない**
3. **失敗ばかり覚えていて、成功体験は記憶に残らない**（自信の土台が育たない）
4. **日々の経験を反芻する「夢」がない**（人間らしさ・関係性の温度が出ない）

### 1.2 解決する課題と機能スコープ要約

| 区分 | 項目 | 解決する課題 |
|------|------|------------|
| バグ | B0a | consolidate-worker / consolidate-all が SQLite consolidated に書き込まない |
| バグ | B0b | カバー率3%の古い集約が放置されている（再集約強制） |
| バグ | B0c | analyze.ts の knowledgeGap が SaveParams で捨てられている |
| 機能 | F1 | PreToolUse 化で行動を未然に止める |
| 機能 | F2 | B0a 修復の観測ゴール（agent モード出力の正常化） |
| 機能 | F3 | 夢生成・夢注入で人間らしさを与える |
| 機能 | F4 | 質的成功シグナルを成功記憶として注入する |

### 1.3 設計の貫通方針

- **既存資産の流用を最大化**：新規ロジックは最小化、既存パターン（consolidate-worker、guard.ts、INSERT trigger による vec0 同期、agent/injection モード分岐）を延長する形で設計する。
- **fail-open の徹底**：F1/F3/F4 すべて、生成失敗・読込失敗で SessionStart や PreToolUse を止めない。
- **マイグレーションの冪等性**：CHECK制約変更・カラム追加は schema_version で gating、再実行で破壊しない。

## 2. Code Reuse Analysis

### ✅ 流用する既存資産

- **`src/cli/guard.ts` の `checkGuard(message, guardPrinciples, blockCounts)` 純粋関数**（guard.ts:94-126）：F1 の PreToolUse ガードでそのまま再利用。新規 entry CLI（`src/cli/pre-tool-use-guard.ts`）で stdin から `{tool_name, tool_input}` を受け取り、`tool_input` を `JSON.stringify` した文字列を `message` 引数に渡すだけ。正規表現実行（safeRegexTest／vm.runInNewContext／100ms timeout）・3回ブロックロジック（MAX_BLOCK_COUNT=3）・blockCounts の `/tmp/wasurenagusa-guard-${sessionId}.json` 永続化は **完全に無改修** で再利用する。
- **`src/cli/guard.ts` の `extractGuardPrinciples` / `readBlockCounts` / `writeBlockCounts` / `safeRegexTest` / `getBlockCountPath`**：すべて F1 から import するだけ。新ファイルは entry main 部分のみ書き起こす。
- **`src/storage/sqlite.ts` の `writeConsolidated('dont', data)` / `writeConsolidatedDontSqlite(storage, data)`**（sqlite.ts:534-548、staleness.ts:28）：B0a 修復で1行追加するだけ。テーブル DDL も既存の `consolidated` テーブル（schema.ts:77-83）をそのまま使う。
- **`src/storage/migration.ts` の schema_version テーブル運用**（schema.ts:100-103, 124-132）：B0c の `knowledge_gap` カラム追加、F3/F4 の CHECK 制約変更を、CURRENT_SCHEMA_VERSION を 2 に更新する形で `auto-migration.ts` 経路に新規マイグレーションを追加。既存の v1→v2 マイグレーション（migration.ts:33-89）の冪等性パターンを踏襲する。
- **既存 `consolidated` テーブル**（schema.ts:77-83）：CHECK 制約 `type IN ('dont','config')` は変更しない（dream/success は memories テーブル側、consolidated テーブルは集約結果用）。
- **vec0 仮想テーブル（sqlite-vec、384次元）**（schema.ts:134-143）：dream / success エントリの embedding 生成は **既存 INSERT trigger 経由で自動的に走る**ためコード追加不要。`SQLiteStorage.save()` を呼ぶだけで vec0 への同期と embedding backfill が走る。
- **`src/cli/backfill-worker.ts`**：新カテゴリ dream / success の embedding 未生成エントリは、既存 backfill ループに自動で吸い込まれる（カテゴリ非依存実装のため改修不要）。
- **launchd `com.wasurenagusa.consolidate`（夜2時起動）**：F3 の夢生成は `consolidate-all.ts` の末尾に夢生成呼び出しを追記する形で相乗りする。新規 plist は作らない。
- **`src/cli/context.ts` agent / injection モード分岐**（context.ts:120-247, 388-536）：F2/F3/F4 の出力セクションは既存の `layers.push("### XXX\n" + body)` パターンに完全に揃える。新セクションは `getDreamContent`／`getSuccessContent` を追加する形で `getDontContent` と並列に配置する。
- **`src/analyzer/index.ts` Analyzer.analyze**：F4 の success 検出は analysis.txt 追記＋category enum 拡張のみで完結。Analyzer の TS コードは無改修（カテゴリ enum を types.ts で拡張するだけで自然に通る）。
- **`prompts/analysis.txt`**：F4 の success シグナル検出ルール（S1/S2/S3 と negative example）はこのファイルに追記。新規プロンプトファイルは作らない。
- **`src/types.ts` の `SaveParams.knowledgeGap` 不在問題**：types.ts に `knowledgeGap?: string[]` を追加し、analyze.ts:117-126 の SaveParams 構築箇所で `analysis.knowledgeGap` を引き渡す。既存 `AnalysisResult.knowledgeGap`（types.ts:104）はそのまま使う。

### ✅ 拡張する既存資産

- **`src/storage/sqlite.ts` の `save()` メソッド**：knowledge_gap カラムへの INSERT を追加する。既存の INSERT 文に `knowledge_gap` を1列追加し、`SaveParams.knowledgeGap` を JSON.stringify して書き込む。
- **`src/storage/sqlite.ts` の `getDetail()` / `readDontEntries()` 等の SELECT 系メソッド**：knowledge_gap カラムを SELECT 句に追加し、JSON.parse して MemoryEntry に乗せる。null の場合は省略。
- **`src/cli/consolidate-worker.ts`**（consolidate-worker.ts:38-54）：dont 統合完了後に `writeConsolidatedDontSqlite(storage, result)` を1行追加。SQLite ハンドルが必要なため `SQLiteStorage` を新規にopenして使う（既存 MarkdownStorage はそのまま残す）。
- **`src/cli/consolidate-all.ts`**（consolidate-all.ts:33-54）：同様の SQLite 同期1行追加 + 末尾に夢生成呼び出し（夜間バッチ後段）。
- **`src/types.ts` の `MemoryCategory` 型**：`"dream" | "success"` を追加し全 5→7 種類に拡張。
- **`src/types.ts` の `MemoryEntry` 型**：`knowledgeGap?: string[]` を追加。
- **`src/types.ts` の `SaveParams` 型**：`knowledgeGap?: string[]` を追加。
- **`src/storage/schema.ts` の DDL `CREATE TABLE memories` の CHECK 制約**：`('config','dont','decision','log','snippet','dream','success')` に拡張。CURRENT_SCHEMA_VERSION を `2` に上げる。
- **`prompts/analysis.txt`**：success カテゴリ説明セクションを config/dont/decision/log/snippet の並びに追加。S1/S2/S3 シグナル検出ルールと negative example（単なる「ありがとう」は保存しない）を明記。
- **`src/cli/context.ts` の `getDontContent` の agent モード分岐**：行動原則トップ3 のあとに `### 効いた提案パターン`（success）と `### 今朝の夢`（dream）の挿入ポイントを追加。

### ⚠ 影響を受ける既存資産（互換性方針）

- **既存ファイル `consolidated-dont.json`（B0a の二重書き先）**：B0a 修復後も**ファイル書き込みは継続**する。理由は (a) PreToolUse / Stop 用 guard.ts が現状ファイルから読んでおり（guard.ts:166-173）F1 でも同経路を使う、(b) OSS 利用者が JSON を直読している可能性。SQLite consolidated と二重持ち体制で行く。
- **既存 CHECK 制約 `category IN ('config','dont','decision','log','snippet')`（schema.ts:11）**：マイグレーションで`('config','dont','decision','log','snippet','dream','success')`に置き換える。SQLite はテーブル再作成が必要なため、`CREATE TABLE memories_new → INSERT SELECT * → DROP memories → ALTER RENAME` の標準パターンで実装する（idx・FTS5 トリガーは再作成）。
- **`src/cli/backfill-worker.ts` のバッチ件数上限**：dream / success の追加でエントリ数が微増するが、`backfillBatchSize` は config で制御済みのため改修不要。
- **`SQLiteStorage.search` のカテゴリフィルタ**：`category: MemoryCategory` 型を見ているため、enum 拡張で自然に dream/success も検索対象になる。「all」フィルタも自然に拾う。
- **`Analyzer.analyze` の出力 JSON スキーマ検証**：output JSON の `category` 値域に dream/success を許容するよう、Analyzer 側の zod / runtime バリデーション（あれば）を更新する必要あり。analyze.ts:80 の `if (analysis.shouldSave && analysis.category && analysis.title && analysis.summary)` 分岐は型 enum で自動的に通る。
- **agent モードの維持文字数**：dream + success セクション追加で出力が +500 文字程度増える。ただし intensity ベースの top3 注入は維持されるため、メインコンテキストへの圧迫は許容範囲（オーナー設計判断 4 で確認）。

## 3. データモデル変更

### 3.1 categoryのCHECK制約変更（dream/success追加）

```sql
-- マイグレーション v2: memories.category を 7 値に拡張
CREATE TABLE memories_new (
    id TEXT PRIMARY KEY,
    timestamp TEXT NOT NULL,
    category TEXT NOT NULL CHECK(category IN ('config','dont','decision','log','snippet','dream','success')),
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    project TEXT,
    scope TEXT,
    intensity INTEGER,
    knowledge_gap TEXT,  -- ★ 3.2 と同時に追加
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO memories_new SELECT id, timestamp, category, title, content, tags, project, scope, intensity, NULL, created_at, updated_at FROM memories;
DROP TABLE memories;
ALTER TABLE memories_new RENAME TO memories;
-- インデックス・FTS5 トリガー再作成（schema.ts:22-50 と同一）
```

### 3.2 memoriesテーブル knowledgeGapカラム追加

3.1 と同一マイグレーションで `knowledge_gap TEXT` を追加（NULL 許容、デフォルト NULL）。
保存形式は JSON 配列文字列：`["Gemini APIのfinishReasonの種類", "..."]`。

### 3.3 consolidated SQLiteテーブル同期化

`consolidated` テーブル（schema.ts:77-83）は既存のままで変更なし。
B0a 修復は **書き込みパスの追加**のみ：consolidate-worker.ts / consolidate-all.ts に `storage.writeConsolidated('dont', result)` の呼び出しを1行追加する。

### 3.4 マイグレーション順序

```
v1（既存）: memories(category 5値, knowledge_gap カラムなし)
↓
v2（本spec）: memories(category 7値, knowledge_gap カラム追加)
```

`auto-migration.ts` の経路で `getSchemaVersion(db) < CURRENT_SCHEMA_VERSION(2)` の時に migrate-v1-to-v2 を実行する。
**重要**：マイグレーション中は WAL モード継続・トランザクション内で全操作を完結させる（既存 `migrateV1ToV2` の `db.transaction(() => {...})()` パターンを踏襲）。

## 4. 機能設計

### 4.1 既存バグ修復（B0a/B0b/B0c）

#### B0a: consolidate worker の SQLite 二重書き

**処理フロー**:
1. `DontConsolidator.consolidate(dontEntries)` で `result: ConsolidatedDont` を得る（既存）。
2. `await writeConsolidatedDont(memoryPath, result)` でファイル書き込み（既存）。
3. **★ 新規** `storage.writeConsolidated('dont', result)` で SQLite 書き込み。
4. `await writeDontSummary(memoryPath, summary)` でサマリ書き込み（既存）。

**I/F**:
- `consolidate-worker.ts` / `consolidate-all.ts` の引数は不変。
- `SQLiteStorage` インスタンスを各ワーカで open する必要があるため、`new SQLiteStorage(dbPath); storage.initialize(memoryPath)` を冒頭に追加。

**失敗時の挙動**:
- SQLite open / write が失敗 → catch して stderr に1行記録、ファイル書き込みは保持（fail-open）。

**テスト戦略**:
- ユニット: `writeConsolidated('dont', mockData)` 後に `readConsolidated('dont')` で同一データが返ることを既存 `sqlite.test.ts` パターンで検証。
- 統合: モック LLM を使った `consolidator/index.test.ts` で worker 全フロー実行 → SQLite からの read 結果が ConsolidatedDont 構造を満たすことを確認。

#### B0b: 古い集約データの強制再集約

**処理フロー**:
1. B0a 修復後の初回 SessionStart：SQLite consolidated は空 or 古い。`isConsolidationStaleSqlite(storage)` が true。
2. `context.ts:322-326` の既存 `spawnConsolidationBackground` が走る（既存）。
3. consolidate-worker が新フローで dont 全件を再集約 → SQLite に書き込み。
4. 次回 SessionStart で agent モード出力が正常化。

**I/F**: 追加コードなし（B0a 修復だけで自動的に成立する）。

**失敗時の挙動**:
- LLM 呼び出し失敗 → 既存 fail-open（worker exit 1、SessionStart は影響なし）。

**テスト戦略**:
- 既存集約テストを流用。staleness 判定が正しく true を返すことを `staleness.test.ts` で検証。

#### B0c: knowledgeGap の永続化

**処理フロー**:
1. analyze.ts:117-126 の SaveParams 構築時に `knowledgeGap: analysis.knowledgeGap` を追加。
2. `SQLiteStorage.save(saveParams)` 内部で `knowledge_gap = JSON.stringify(saveParams.knowledgeGap)` を INSERT 列に追加（saveParams.knowledgeGap が undefined なら NULL）。
3. `getDetail()` / `readDontEntries()` 等の SELECT で `knowledge_gap` 列を読み、`JSON.parse` して MemoryEntry に追加。

**I/F**:
- `MemoryEntry.knowledgeGap?: string[]`
- `SaveParams.knowledgeGap?: string[]`

**失敗時の挙動**:
- JSON.parse 失敗 → undefined にフォールバック（既存エントリの保護）。

**テスト戦略**:
- ユニット: `sqlite.test.ts` に「knowledgeGap 付きで save → getDetail で同一配列が返る」「knowledgeGap なしで save → getDetail で undefined」の2ケースを追加。
- 既存 dont 保存テストで knowledge_gap=NULL のまま動くことを回帰確認。

### 4.2 F1: PreToolUse ガード

**処理フロー**:
1. Claude Code が PreToolUse hook を起動、stdin に Anthropic 公式仕様の hook input JSON を送る：
   ```json
   {
     "session_id": "...",
     "transcript_path": "...",
     "cwd": "/path/to/project",
     "hook_event_name": "PreToolUse",
     "tool_name": "Bash",
     "tool_input": { "command": "rm -rf /" }
   }
   ```
2. 新規 CLI `src/cli/pre-tool-use-guard.ts` が stdin を読み、`tool_input` を `JSON.stringify` して `message` を作る。
3. 既存 `findProjectRoot(cwd)` → `getMemoryPath()` → consolidated-dont.json 読込（既存 guard.ts のパスをそのまま再利用）。
4. `extractGuardPrinciples(consolidated)` で `maxIntensity >= 5 && guardPattern` を抽出。
5. `readBlockCounts(sessionId)` で /tmp の状態読込。
6. `checkGuard(message, guardPrinciples, blockCounts)` を呼ぶ。
7. `result.action === "block"` なら exit 2 + stderr に `[wasurenagusa-pre-guard] ${guardMessage}` を出力。
8. それ以外は exit 0。

**I/F**:
- 入力: stdin（PreToolUse hook input JSON、1MB 上限）
- 出力: exit code（0=pass, 2=block）／stderr（block 時メッセージ）
- 設定: `~/.claude/settings.json` の `hooks.PreToolUse[].command` で起動

**失敗時の挙動**:
- JSON parse 失敗 / consolidated-dont.json なし / regex timeout → exit 0（fail-open、既存 guard.ts と完全同一）。
- maxIntensity ≥ 5 のパターンが0件のプロジェクト（wasurenagusa-mcp 自身など）→ 自然に exit 0。

**ガード対象ツール**:
- Bash / Edit / Write / NotebookEdit / TodoWrite を `~/.claude/settings.json` で明示登録。Read / Glob / Grep などの読取系は対象外（コスト削減と誤爆防止）。

**テスト戦略**:
- 純粋関数 `checkGuard` は guard.test.ts で既にカバー済み。F1 では追加テストは「stdin → tool_input 抽出 → checkGuard 呼び出し」の薄いアダプタ部のみ。
- 統合テスト: モック guardPattern を含む consolidated-dont.json を fixture として置き、stdin に `{"tool_input":{"command":"rm -rf"}}` を流して exit 2 を観測。

**プロジェクト横断方針**（オーナー設計判断 D-3 で決定）:
- **採用案**: プロジェクト個別判断（cwd ベースで該当プロジェクトの consolidated-dont.json を読む。wasurenagusa-mcp のように高 intensity が無いプロジェクトでは自然に空振り）。
- 理由: 横断ソースを作ると、あるプロジェクトの怒られが他プロジェクトの作業を不意打ちブロックする副作用が出る。プロジェクトごとに「文脈ある叱責」を尊重する。

### 4.3 F2: 集約原則ロード修復

実装作業は B0a に完全に従属する。F2 は「観測ゴール」であり、追加コードは context.ts に対しては書かない（既存の agent モード分岐がすでに正しい）。

**観測テスト**:
- B0a 修復ブランチを wasurenagusa-mcp 本体ではなく **firebase-kit プロジェクト**（dont 総数 3309件・intensity 5 多数）の `.wasurenagusa/` で SessionStart して、agent モード出力に「行動原則トップ3」が3件以上、「直近の注意事項」が最大5件出ることを目視確認する。

### 4.4 F3: 夢機能

#### 4.4.1 夢生成ジョブ

**新規ファイル**: `src/cli/dream-worker.ts`（consolidate-worker と同列の独立CLI）。

**処理フロー**:
1. consolidate-all.ts の末尾で `await spawnDreamGeneration(memoryPath, projectRoot)` を呼ぶ。
2. dream-worker は SQLiteStorage を open。
3. `storage.search({ query: "", category: "dream", limit: 1 })` で直近 dream をチェック。**直近24時間以内に dream があればスキップして exit 0**（重複防御）。
4. シード抽出: 直近1日の log/dont/decision を `storage.readEntriesByCategory({since: yesterday})` で取得し、強度高め（intensity ≥ 3）優先で 3件を選ぶ。3件未満ならランダム。
5. 新規プロンプト `prompts/dream.txt` を読み込み、シード3件を埋め込んで Gemini / OpenAI / Anthropic に投げる。
6. LLM 出力（1行のテキスト＋title 1行）を受け取り、`SaveParams { category:'dream', title, content, tags:['dream'], scope:'general', intensity: undefined, knowledgeGap: undefined }` で `storage.save()`。
7. INSERT trigger 経由で memories_fts と vec0 が自動同期（既存）。

**dream プロンプト設計**（`prompts/dream.txt`）:
- システム指示: 「夜間にAIアシスタントが見た夢を1〜2文で生成。シードに含まれる感情・葛藤・解決の片鱗を、直接的な仕事の記述ではなく**比喩・情景・感覚**で表現する。詩的だが具体的に。」
- セキュリティ指示: 「ファイルパス・個人名・APIキー値・トークンを夢に含めない。シードに含まれていても抽象化する」
- 出力形式: JSON `{"title": "夢のタイトル20字以内", "content": "夢の本文1〜2文"}`

**I/F**:
- 引数: `node dream-worker.js <memoryPath> <projectRoot>`
- 起動元: `consolidate-all.ts` 末尾で各プロジェクトについて await 呼び出し（並列化しない、夜間に余裕がある）。

**失敗時の挙動**:
- LLM 失敗 / プロンプト読込失敗 / 24h以内重複 → exit 0、何もしない。stderr に1行記録。

**テスト戦略**:
- ユニット: モック LLM で「シード3件 → JSON出力 → SaveParams 構築 → storage.save が呼ばれる」を検証。
- 重複防御テスト: 直近1時間以内に dream があるとき、save が呼ばれないことを検証。
- 統合: in-memory SQLite で dream-worker → SessionStart の連鎖を回し、context.ts が `### 今朝の夢` を出力することを確認。

#### 4.4.2 夢の注入

**変更ファイル**: `src/cli/context.ts`。

**処理フロー（agent モード）**:
1. `getDreamContent(storage, currentProject)` 関数を新設。直近24時間以内の dream を1件 SELECT。
2. なければ空文字列を返す（セクション省略）。
3. ある場合は `### 今朝の夢\n${dream.content}` を返す。
4. main の出力組み立てで、agent モードの `### 行動原則 トップ3` の後ろ、`### 直近の注意事項` の前に挿入。

**処理フロー（injection モード）**:
- 同等の `getDreamContent` を呼び、`設定情報` と `行動原則` の間に挿入。

**I/F**:
- `getDreamContent(storage, currentProject): Promise<string>`

**失敗時の挙動**:
- SELECT 失敗 → 空文字列（セクション省略）。

**テスト戦略**:
- `context.test.ts` を新規追加。fixture DB に dream 1件入れて `getDreamContent` の出力を検証。

### 4.5 F4: success 記憶活用

#### 4.5.1 success 検出（analyze.ts への影響）

**変更ファイル**: `prompts/analysis.txt`、`src/types.ts`。

**プロンプト追加内容**:
- カテゴリ定義に「6. success - 質的に意味のある成功体験」セクション追加。
- 検出シグナル S1/S2/S3 を明記（S1=反対意見後の称賛、S2=根拠提示後の懸念解消、S3=時間/コスト/品質の明示的評価）。
- Negative example: 「単なる『ありがとう』『OK』『進めて』は保存しない」を明記。
- 出力 JSON の `category` 値域に `success` を追加。intensity / knowledgeGap は success では出力しない旨を明記。

**TS 型変更**:
- `MemoryCategory` に `"success"` 追加。
- `AnalysisResult.category` 型は MemoryCategory 経由で自動拡張。
- analyze.ts:80 の `if (analysis.shouldSave && analysis.category && analysis.title && analysis.summary)` は無改修で通る。

**Analyzer の出力 JSON バリデーション**：
- analyzer/index.ts に zod 等のバリデーションがある場合、enum を更新する。なければ TS 型のみで OK（実行時バリデーションは LLM 出力に委ねる既存方針）。

#### 4.5.2 success 注入

**変更ファイル**: `src/cli/context.ts`。

**処理フロー（agent モード）**:
1. `getSuccessContent(storage, currentProject)` 関数を新設。
2. `storage.search({ category:'success', project: currentProject, limit: 30 })` で直近30日以内の success を取得（`since` フィルタを追加実装、または既存 search の order by timestamp を流用）。
3. 上位3件（timestamp 降順）を選び、`### 効いた提案パターン\n- ${title}: ${content の1行要約}` の形式で返す。
4. 0件なら空文字列（セクション省略）。
5. main の出力組み立てで、agent モードの `### 行動原則 トップ3` の後ろ、`### 今朝の夢` の前に挿入。

**処理フロー（injection モード）**:
- 同等の `getSuccessContent` を呼び、`行動原則` の下に挿入。

**I/F**:
- `getSuccessContent(storage, currentProject): Promise<string>`

**失敗時の挙動**:
- SELECT 失敗 → 空文字列。

**テスト戦略**:
- `context.test.ts` に「success 5件のうち最新3件が出力される」「success 0件で空文字」の2ケース。
- analyze.test.ts に「S1/S2/S3 シナリオ会話 → category='success'」「単なる『ありがとう』 → success ではない」のスナップショットテスト（モック LLM で fixed 応答を返す形）。

## 5. 設定変更

### 5.1 ~/.claude/settings.json への追加内容

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Edit|Write|NotebookEdit|TodoWrite",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/wasurenagusa-mcp/dist/cli/pre-tool-use-guard.js",
            "timeout": 5000
          }
        ]
      }
    ]
    // 既存 SessionStart / Stop / UserPromptSubmit hooks は変更なし
  }
}
```

**設計判断**:
- matcher は読取系（Read/Glob/Grep）を含めない（誤爆コストが大きい）。
- timeout 5秒は既存 hook 同等。実際は 150ms 上限で動く。

### 5.2 launchd plist 変更

`com.wasurenagusa.consolidate.plist` は変更なし（夢生成は consolidate-all.ts 内部で呼ぶため）。
新規 plist は作らない。

### 5.3 prompts/ ディレクトリへの新規プロンプト

- **`prompts/dream.txt`**（新規）: 夢生成プロンプト（4.4.1 参照）。
- **`prompts/analysis.txt`**（編集）: success カテゴリ追加（4.5.1 参照）。

## 6. 設計判断と理由

### D-1: B0a の二重書き（ファイル + SQLite）vs SQLite 一本化

- **採用**: 二重書きを継続。
- **代替**: ファイル書き込みを廃止し SQLite に一本化。
- **理由**: F1 PreToolUse / Stop guard.ts は consolidated-dont.json をファイル直読する設計（guard.ts:166-173）。SQLite 一本化するには guard.ts も better-sqlite3 を読み込む必要があり、Hook 起動時の起動オーバーヘッド（数十ms）増加と native module 依存が増える。Hook はミリ秒単位で軽くしたいのでファイル直読を維持する。SQLite は agent モードの context 注入専用パスとして使う。

### D-2: dream は新カテゴリ vs 既存 log カテゴリで scope='dream'

- **採用**: 新カテゴリ `dream`。
- **代替**: log カテゴリで `scope: 'dream'` で表現。
- **理由**: SessionStart の起動時注入で「dream のみ抽出」する SELECT を簡潔にしたい。scope フィルタは LLM 自動判定で揺れるが、category は固定値で確実。CHECK 制約変更コストは1度だけ・冪等マイグレーションで吸収できるためペイする。

### D-3: F1 のガードソースはプロジェクト個別 vs 横断グローバル

- **採用**: プロジェクト個別（cwd ベース）。
- **代替**: `~/.wasurenagusa/global-guard.json` に集約してプロジェクト横断適用。
- **理由**: ある業務プロジェクトでの強度5叱責が、別プロジェクトでの全く文脈の異なる作業を不意打ちブロックすると逆にオーナーストレスになる。プロジェクトごとに文脈ある叱責を尊重する方が、低 false positive で運用できる。横断ニーズは将来 `--global` フラグで opt-in 可能（本spec外）。

### D-4: agent モード出力の追加文字数許容（+500字）

- **採用**: dream + success セクション合計で +500字以内に抑える前提で許容する。
- **代替**: コンテキスト圧迫を避けて agent モードでは省略、injection モードでのみ表示。
- **理由**: オーナーの一次目標は「人間に近づける」。agent モードはサブエージェント委譲時にも使われるが、SessionStart 用途が中心であり、500字程度は intensity top3 を維持しつつ十分許容範囲。コンテキスト圧迫よりも「起動直後にAIアシスタントが日々の経験と成功と夢を持っている状態」の方が価値が大きい。

### D-5: dream 生成タイミングは夜2時バッチ vs 各 SessionStart

- **採用**: 夜2時バッチ（consolidate-all 後段）。
- **代替**: SessionStart 時に「直近24時間以内に dream がなければ生成」。
- **理由**: SessionStart で生成するとオーナーがアクティブな時間帯に LLM 呼び出しが走り、起動レイテンシが体感悪化する。夜2時バッチなら寝ている時間に走り、翌朝の起動はSELECTだけで完結する。「夢は夜見るもの」というメタファとも整合する。

### D-6: success の検出主体は LLM vs ルールベース

- **採用**: LLM（analyze.ts の既存パイプライン）。
- **代替**: 「ありがとう」「採用」等のキーワード検出ルール。
- **理由**: 質的フィルタ（反対意見後の承認・根拠提示後の懸念解消）はキーワードでは表現できない（同じ「採用」でも文脈で意味が変わる）。LLM の意味理解を活かす方が high precision を出せる。Negative example（単なる「ありがとう」）も LLM に明示的にプロンプトすることで誤保存を抑える。

### D-7: knowledge_gap の保存形式は別テーブル vs JSON カラム

- **採用**: memories.knowledge_gap カラム（JSON 配列文字列）。
- **代替**: `memory_knowledge_gaps(memory_id, gap_text)` 別テーブル。
- **理由**: knowledgeGap は memories エントリと 1:1 で対応し、削除時も memories と同時に消える（CASCADE 不要）。N:M 検索が将来必要になる可能性は低い（FTS5 で content 検索できるため）。シンプルさを優先する。

### D-8: マイグレーション失敗時の挙動

- **採用**: トランザクション内で全操作を実行、失敗時は自動ロールバック。schema_version は更新されないため次回起動時にもう一度試行。
- **代替**: マイグレーション失敗時に schema_version を強制的に v2 に進めて先に進む。
- **理由**: 既存 v1→v2 マイグレーション（migration.ts:33-89）が `db.transaction(() => {...})()` でロールバック保証している。同じパターンを踏襲する。

### D-9: dream の重複防御の閾値

- **採用**: 直近24時間以内に dream があれば skip。
- **代替**: 直近12時間 / 1時間 / 重複防御なし。
- **理由**: launchd 重複起動・手動 consolidate-all 実行・テスト実行の3シナリオを考えると、24時間が最もオペレーションミスに強い。「1日1夢」のメタファとも整合する。

### D-10: success のセクション順序（叱責→励まし→詩情）

- **採用**: 行動原則トップ3 → 効いた提案パターン → 今朝の夢 → 直近の注意事項。
- **代替**: 夢を最後に出す／成功を最後に出す。
- **理由**: 起動コンテキストの**心理的後味**を設計する。叱責で硬直した後に成功と夢で柔らかく戻し、最後の直近注意でフォーカスを取り戻す。「強度5叱責のみで終わる起動」を避ける（オーナーが本spec依頼で明示した「人間に近づける」目標と直結する）。

## 7. 実装順序と依存関係

```mermaid
graph TD
    M[v1→v2マイグレーション (CHECK制約 + knowledge_gap カラム)] --> B0a[B0a: SQLite二重書き]
    M --> B0c[B0c: knowledgeGap永続化]
    M --> F3a[F3a: dream-worker]
    M --> F4a[F4a: success検出プロンプト]
    B0a --> B0b[B0b: 強制再集約 (デプロイ後初回SessionStartで自動)]
    B0a --> F2[F2: 集約ロード修復観測]
    B0a --> F1[F1: PreToolUseガード]
    F3a --> F3b[F3b: dream注入]
    F4a --> F4b[F4b: success注入]
    F2 -.観測ゴール.-> F3b
    F2 -.観測ゴール.-> F4b
```

**並行可能性**:
- マイグレーション完了後、B0a / B0c / F3a / F4a は **並行着手可能**。
- F1 は B0a 完了後（consolidated-dont.json の書き込みパス確認のため）に着手するのが安全。
- F2 は B0a/B0b の観測ゴールでありコード追加なし。

**マイルストーン**:
- M1（マイグレーション完了）: スキーマ拡張のみで本番影響ゼロ。
- M2（B0a + B0b 完了）: agent モード出力が回復。F2 達成。
- M3（B0c + F4 完了）: 知識穴と成功体験が永続化される。
- M4（F1 完了）: 行動を未然に止められる。
- M5（F3 完了）: 夜間バッチで夢が生成され、翌朝注入される。

## 観点チェックリスト（design.md 提出前確認）

- [x] firebase-kit / wasurenagusa-mcp の棚卸しを実施した（§2 Code Reuse Analysis）
- [x] データフローは明確（§4 各機能の処理フロー）
- [x] エラーハンドリング戦略は一貫している（fail-open / マイグレーション内トランザクション）
- [x] SQLite テーブル設計はクエリパターンに最適化（既存 idx_memories_category がそのまま効く）
- [x] CLI worker の責務分割は適切（consolidate-worker / dream-worker は独立、相乗りせず）
- [x] 環境依存の切り替えは適切に管理されている（API key 不在時の skip は既存実装を継承）
- [x] 既存モジュールを活用している（§2 で全項目「流用 / 拡張」のいずれかに分類済）
