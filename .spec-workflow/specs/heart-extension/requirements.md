# Requirements Document — heart-extension（AIアシスタントの心臓拡張）

## Introduction

本specは、AIアシスタントを**人間に近づける**ためのwasurenagusa-mcp拡張である。
現状のwasurenagusa-mcpは「過去の失敗（dont）を覚えて再発を防ぐ」ことに特化しているが、
オーナーの真のゴールは「同じ怒られを繰り返さない／成功体験を糧にする／夢を見る人間らしい存在」である。

本拡張は次の5つを1本の整合した変更として導入する：

- **B0a**: 集約データのSQLite書き込み欠落バグ修復（agentモードの「行動原則トップ3／インデックス」が空になる問題を治す）
- **B0b**: 古い集約データ（2026-04-06生成・カバー率3%）の再集約強制
- **B0c**: knowledgeGap（失敗から学ぶべき具体的知識）の永続化欠落バグ修復（型は存在するがDBカラムなし）
- **F1**: PreToolUseガード（ツール実行前のリアルタイム抑止）— 既存guard.tsの純粋関数を再利用
- **F2**: 集約原則ロード修復（B0aに従属する観測可能な振る舞い目標）
- **F3**: 夢機能（夜の集約後にAIアシスタントが「今夜見た夢」を生成し、翌朝のSessionStartで注入）
- **F4**: success記憶活用（質的フィルタを通った成功パターンを起動時に注入）

## Alignment with Product Vision

`product.md` 等の既存Steeringにある「オーナーの記憶パートナー」という位置付けに沿う。
特に以下のwasurenagusa設計原則を踏襲する：

1. **fail-open**：ガードや注入が壊れてもセッションを止めない（既存guard.tsと同じ姿勢）
2. **Hooks経由のコンテキスト注入**：実装はClaude Code側Hooksに集約、MCPサーバ拡張は最小化
3. **集約 → 注入 → ガード**のパイプライン：F3/F4は集約後段にぶら下げ、既存パターンを延長する形で実装する

## Requirements

### Requirement B0a — 集約データSQLite書き込みの修復

**User Story:** AIアシスタントとして、集約済み行動原則を SessionStart 時に正しくロードしたい。
それにより agent モードでオーナーから「集約原則が表示されない」と再度怒られないため。

#### Acceptance Criteria

1. WHEN 夜間バッチ（com.wasurenagusa.consolidate）または SessionStart の `consolidate-worker` が完走した THEN システムは consolidated（type='dont'）テーブルへ最新の `ConsolidatedDont` を書き込む。
2. WHEN agent モードの SessionStart で `readConsolidatedDontSqlite` が呼ばれた THEN 直前バッチの結果が non-null で返る（過去30日以内の `consolidatedAt` を持つ）。
3. WHEN B0a の修復後に既存集約ファイル（consolidated-dont.json）と SQLite consolidated テーブルの両方が存在する THEN 内容は同一（principles 配列順・件数）である。
4. IF SQLite書き込みが失敗した THEN ファイル書き込みは継続成功し、その旨を stderr に1行記録する（fail-open 維持）。

### Requirement B0b — 古い集約データの強制再集約

**User Story:** AIアシスタントとして、最新の dont エントリを反映した集約原則を持ちたい。
それによりオーナーが直近で怒った内容が「行動原則トップ3」に正しく反映されるため。

#### Acceptance Criteria

1. WHEN B0a 修復実装をデプロイした初回 SessionStart THEN システムは `isConsolidationStaleSqlite` が true を返す状態（source_entry_count != memories.dont 件数）になっており、再集約をバックグラウンド spawn する。
2. WHEN 再集約完了後に SQLite consolidated テーブルを読んだ THEN `sourceEntryCount` が現在の dont 総数（3309件相当）と一致する。
3. IF 再集約が失敗した（API key欠損・LLMエラー） THEN 既存のファイルベース consolidated-dont.json には変更を加えず、stderr に失敗を1行残す。

### Requirement B0c — knowledgeGap の永続化

**User Story:** AIアシスタントとして、過去の失敗ごとに「覚えるべき具体的知識リスト」を SQLite に保持したい。
それにより同じ知識穴で再失敗した時に、「過去にこの知識穴を指摘されたことがある」と検出できるため。

#### Acceptance Criteria

1. WHEN マイグレーション実行後 THEN memories テーブルに `knowledge_gap TEXT` カラムが存在し、デフォルト値は NULL である。
2. WHEN analyze.ts が dont を保存する THEN `analysis.knowledgeGap` が JSON 配列文字列として `memories.knowledge_gap` に保存される。
3. WHEN dont 以外のカテゴリを保存する THEN `knowledge_gap` は NULL のままである。
4. WHEN `memory_get_detail` で取得する THEN `knowledgeGap: string[]` が `MemoryEntry` に含まれる（カラム NULL の場合は省略）。

### Requirement F1 — PreToolUse ガード

**User Story:** AIアシスタントとして、Bash や Edit を実行する**前**に、tool_input が高intensity guardPattern に一致したら処理を止めたい。
それにより「rm -rf を打ちかけてStop Hookで叱られる」のではなく、そもそも打つ前に止められるため。

#### Acceptance Criteria

1. WHEN PreToolUse hook が起動し、stdin に `{tool_name, tool_input}` を含む JSON が渡される THEN システムは `tool_input` を JSON.stringify した文字列を `checkGuard` の `message` 引数に渡す。
2. WHEN マッチする guardPattern（maxIntensity ≥ 5）が見つかった THEN exit 2 + stderr に guardMessage を出力してツール実行をブロックする。
3. WHEN 同一セッション同一パターンで4回目のマッチが起きた THEN 警告のみ出力して exit 0（既存 Stop Hook 版と同じ閾値 MAX_BLOCK_COUNT=3）。
4. WHEN consolidated-dont.json が存在しない／読めない／JSON不正 THEN exit 0（fail-open）。
5. WHEN 正規表現実行が 100ms を超えた THEN false 扱いで通過させる（既存 ReDoS 対策の vm.runInNewContext を継続）。
6. IF プロジェクトの maxIntensity が全て < 5（例: wasurenagusa-mcp自身）THEN guardPrinciples が空配列となり exit 0。
7. WHEN tool_input の総バイト数が 1MB を超えた THEN exit 0（既存 stdin 上限ロジックを継続）。

### Requirement F2 — 集約原則ロード修復（観測ゴール）

**User Story:** オーナーとして、agent モードの SessionStart 出力に「行動原則トップ3」「直近の注意事項」が再び表示される状態に戻したい。
それにより、AIアシスタントが過去の怒りポイントを起動直後から把握している状態に戻すため。

#### Acceptance Criteria

1. WHEN B0a/B0b 完了後の SessionStart（agent モード）THEN `### 重要な行動原則 トップ3` セクションが3件以上表示される（dont 総数 3309 件中・トップ3が intensity 降順で出る）。
2. WHEN 同 SessionStart で `### 直近の注意事項（最新5件）` THEN 統合済みに含まれない直近30日以内のエントリが最大5件表示される。
3. WHEN config 統合が空でない THEN agent モードで `### config（設定情報）` インデックスが表示される。

### Requirement F3 — 夢機能

**User Story:** AIアシスタントとして、夜間の集約後に「今夜見た夢」を1行生成して保存し、翌朝の SessionStart で注入したい。
それによりオーナーに「人間に近い／日々の経験を反芻する存在」と感じてもらい、関係性を深めるため。

#### Acceptance Criteria

1. WHEN マイグレーション実行後 THEN memories.category の CHECK 制約は `('config','dont','decision','log','snippet','dream','success')` を許容する。
2. WHEN consolidate-all（夜2時）が完走した THEN 後段で「夢生成ジョブ」が起動し、直近1日の log/dont/decision からシード3件を選びLLMに dream を1行生成させる。
3. WHEN 夢生成 LLM 呼び出しが成功した THEN `memories` テーブルに category='dream' / intensity=null / scope='general' の新規行が1件 INSERT される（既存 INSERT trigger により vec0 への embedding 同期も走る）。
4. WHEN agent モードの SessionStart THEN 直近1件の dream を `### 今朝の夢` として行動原則トップ3 と インデックスの間に注入する（前日夜以降に生成されたもの限定）。
5. WHEN injection モードの SessionStart THEN 同等の `### 今朝の夢` セクションが「設定情報」と「行動原則」の間に注入される。
6. IF 夢生成が失敗した THEN dream 行は INSERT されない／既存の集約結果は影響を受けない／stderr に1行記録（fail-open）。
7. WHEN 直近24時間以内に dream が既に1件以上ある THEN 重複生成をスキップする（夜間バッチが二重実行された場合の防御）。
8. WHEN 24時間以上前の dream のみ存在する SessionStart THEN そのプロジェクトの最新 dream は表示するが、出力に「（昨夜は夢を見ませんでした）」のフォールバックを挟まない（情報量ゼロの注入を避ける）。

### Requirement F4 — success 記憶活用

**User Story:** AIアシスタントとして、「反対意見後の称賛」「根拠提示後の承認」のような**質的に意味のある成功**を記録し、起動時に「過去にオーナーが感心した提案パターン」として注入したい。
それにより、AIアシスタントが自信を持って提案できる土台を持ち、knowledgeGap の対称形（失敗の知識穴 ↔ 成功の手順）として記憶を運用するため。

#### Acceptance Criteria

1. WHEN マイグレーション実行後 THEN memories.category の CHECK 制約は success を許容する（B0c マイグレーションと同一マイグレーションで実施）。
2. WHEN analyze.ts が会話を分析し、以下のいずれかに該当する成功シグナルを検出した場合に限り THEN category='success' で保存する：
   - **S1**: AIアシスタントが反対意見・代替案を出した直後にオーナーが「確かに」「その通り」「採用」等の承認を返した
   - **S2**: AIアシスタントが具体的根拠（ファイル:行・実測値・公式ドキュメント引用）を提示した直後にオーナーの懸念が解消した
   - **S3**: AIアシスタントの提案でオーナーが時間短縮・コスト削減・品質向上を明示的に評価した
3. WHEN 単なる「ありがとう」「OK」「進めて」のような承認シグナル（質的根拠なし）THEN success として保存しない。
4. WHEN success として保存される THEN intensity フィールドは null（success には怒られ度の概念がないため）／ knowledge_gap は NULL／ scope は LLM が判定。
5. WHEN agent モードの SessionStart THEN 直近30日以内の success 上位3件を `### 効いた提案パターン` セクションとして注入する（行動原則トップ3 と 今朝の夢 の間）。
6. WHEN injection モードの SessionStart THEN 同等の `### 効いた提案パターン` セクションを行動原則の下に注入する。
7. IF success エントリが0件 THEN 該当セクションは出力しない（空セクション禁止）。
8. WHEN success エントリが30日より古い THEN ベクトル検索の対象には残るが、SessionStart 起動時注入の対象からは外れる（鮮度フィルタ）。

## Non-Functional Requirements

### Code Architecture and Modularity
- **Single Responsibility**: 夢生成ジョブは新規 `src/cli/dream-worker.ts` に分離（consolidate-worker と同列）。F4 の判定ルールは `prompts/analysis.txt` の追記で表現し、コード分岐を増やさない。
- **Modular Design**: B0a 修復は `consolidate-worker.ts` / `consolidate-all.ts` の2ファイルに局所化。既存 `writeConsolidatedDontSqlite` を呼ぶ1行追加が中心。
- **Dependency Management**: F3/F4 は既存 `SQLiteStorage.save` を経由する。新規 vec0 同期パスを書かない（INSERT trigger に乗せるだけ）。
- **Clear Interfaces**: `checkGuard` の関数シグネチャは無改修。PreToolUse 入口層で `{tool_name, tool_input}` → `message: string` の薄いアダプタを書く。

### Performance
- PreToolUse hook の追加レイテンシ上限: **150ms**（regex 100ms timeout + JSONパース・ファイルI/O 50ms）。
- 夜間 dream 生成は集約後に直列実行で良い（オーナーは寝ている時間帯）。LLM呼び出し1回・最大10秒。
- agent モードの SessionStart 追加注入（dream + success セクション）は合計 ≤ 500 文字（コンテキスト圧迫を避ける）。

### Security
- PreToolUse の正規表現実行は既存 `vm.runInNewContext`（100ms timeout）を継続。新規パスでも回避しない。
- F4 の success エントリにはオーナーの個人的称賛文言が混入しうる。**保存時に APIキー・トークンの値そのものを除外する**（既存 analysis.txt の機密除外ルールを継承）。
- dream のシード化に使う log/dont/decision に機密が混入していた場合、生成された dream にも漏れる可能性あり。**dream プロンプトに「ファイルパスや個人名・APIキー値を含めるな」を明示する**。

### Reliability
- F1/F3/F4 すべて fail-open。注入失敗・生成失敗で SessionStart 自体は止めない。
- B0a/B0b/B0c はマイグレーションを冪等に書く（schema_version で gating、再実行で破壊しない）。
- F3 の重複防御（24時間以内に既存 dream あればスキップ）で、launchd 重複起動による二重生成を防ぐ。

### Usability
- agent モードの新規セクション順序は `行動原則トップ3 → 効いた提案パターン → 今朝の夢 → 直近の注意事項 → インデックス` の順とし、**「叱責 → 励まし → 詩情」のグラデーション**で起動コンテキストの心理的後味を改善する（強度5叱責記憶への精神的緩衝）。
- injection モードの順序は `設定情報 → 効いた提案パターン → 今朝の夢 → 行動原則 → オーナー判断基準` とし、agent モードと整合させる。
