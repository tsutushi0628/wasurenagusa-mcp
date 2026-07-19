# 引継資料: A1移行原子性の根治とB2/B4検索評価基盤の出荷（2026-07-20）

## セッション起点（当初要求原文引用・WHY/WHAT/HOW）

当初引継要求（前セッション `handoff-20260719-recall-unarchive-ship.md` の「次セッションへの引継指示」を継承・転記・上書き禁止）:

> 本セッションの差分は全てローカルコミット・push・publish済み。次セッション開始時に追加のpush判断は不要で、そのまま残作業に着手できる。
> 優先順（上が高い）:
> 1. **A1（backfillマイグレーションのatomicity欠陥）**（最優先）
> 2. **B2（融合重み／RRF並べ替えの底上げ）**
> 3. **B4（時間減衰ランキング調整）**

復帰時に再確認すべき起点（前セッション末尾状態）:

- **着手前3手順**: ①`.claude/CLAUDE.local.md` を読む ②該当場面の正本refs（本件はLLM設計・pre-push・confidentiality）を着手前に読む ③前引継書（`handoff-20260719`）と健全性監査本体（`health-audit-20260719.md`）で背景の一次情報を再確認する。
- **ブランチ状態**: `main`。前セッション終了時点で `git status` clean・未push差分なし・タグ `release-2026-07-19`（`2ffc4c1`）。派生ブランチは作らずmain直コミット運用（CLAUDE.md行動原則8）。
- **積み残し3件**: A1（移行の原子性欠陥）・B2（融合重み底上げ）・B4（時間減衰調整）。いずれも前夜は「設計判断／評価土台を要する」として保留していた重い改善。

今セッションのオーナー指示（夜間完遂）:

> 寝るので、A1／B2／B4を朝までに正しい手法で完遂しておいて。引継書はコミットしてPushしていい。

これは前夜保留した3件を、正しい評価土台を作った上で夜間に完遂し、引継書の出荷まで含めて自走する指示。

### WHY
記憶ストアは日々の意思決定支援基盤。移行失敗時のサイレントな記憶欠損（A1）は業務価値を直接毀損する。検索順序の質（B2/B4）は想起の的中率に直結するが、順序を測る土台がないまま係数をいじると劣化を検知できない。

### WHAT
A1は移行の原子性欠陥を根治する。B2/B4は「まず本番実順を測れる評価基盤を作り、その上で後方互換のチューニングseamを用意し、事前登録した合格線を越えた係数だけを適用する」土台整備に絞る。

### HOW
A1とB2/B4基盤を独立した2コミットに分割（またがりファイルはハンク単位stage）。B2/B4は係数を動かす前に評価基盤を先に敷き、10候補を事前登録バーで測定し、越えなければ係数を据え置く（p-hacking回避）。QA緑・identity gate緑・recall gate PASSを確認してpush。publishはdry-runのみでオーナー判断に委ねる。

## 概要（達成したこと・なぜやったか）

前夜保留のA1（移行原子性）を根治し、B2/B4は「本番実順を評価できる基盤＋後方互換のチューニングseam＋事前登録バー」を整備した。A1は前夜の仮説（version昇格がbackfill前にコミットされhappy-pathで欠損する）を実測で**訂正**した上で、真の欠陥（throw後に残る偽の完了マーカー）を根治している。B2/B4は基盤のみを出荷し、測定の結果どの係数候補もバーを越えなかったため係数は意図的に据え置いた（挙動中立）。全差分はorigin mainへpush済み。npm publishはdry-runのみで未公開・版数据え置き、公開判断はオーナー保留。

## 要求 × 現状

| 要求項目（前夜引継の優先3件） | 現状 |
|---|---|
| A1: 移行マイグレーションの原子性欠陥の根治 | **充足（出荷済み・A1コミット `75de7c4`）**。initializeSchema再設計＋末尾調停＋トランザクション原子性ガードで根治。根因は実測で訂正済み。 |
| B2: 融合重み／RRF並べ替えの底上げ | **基盤充足・係数据え置き（B2/B4基盤コミット `2333209`）**。後方互換seam＋本番実順評価基盤を敷いた上で10候補を測定、バー未達のため係数不変（挙動中立）。真の底上げは大規模Golden Set待ち。 |
| B4: 時間減衰ランキング調整 | **基盤充足・係数据え置き＋spec矛盾解消（同 `2333209`）**。now注入をseam化、順序メトリクスを記録専用で計測、spec内部矛盾（順序非依存ゲート）をSUPERSEDEDバナーと設計note追記で解消。減衰係数は不変。 |

## 実装した内容

### A1: 移行の原子性欠陥の根治（A1コミット `75de7c4`）

- **initializeSchema再設計**: 新規DBは全形DDL＋version刻印を単一トランザクションで実施。既存DBパスは `CREATE ... IF NOT EXISTS` のみで `schema_version` に一切触れない。
- **非トランザクションな早期version昇格を除去**。
- **initialize() 末尾調停**: `getSchemaVersion() < CURRENT` かつマイグレーション成功後に限りCURRENTを刻印。`migrate*` は失敗をTHROWで通知し、末尾刻印行の手前で伝播する。したがってマイグレーション失敗が偽の「完了済み」マーカーを残さない。
- **根因の実測訂正**: マイグレーションは `pragma_table_info`／`sqlite_master` によるカラム有無ゲート（version-gatedではない）。ゆえに前夜仮説の「早期昇格によるhappy-path欠損」は起きていなかった。真の欠陥はthrow後に残る偽マーカーだった。

A1テスト:
- 新規 `src/e2e/migration-atomicity.e2e.test.ts`（ファイルバックの実 `SQLiteStorage.initialize()`）: ①失敗→回復で偽マーカーが残らない ②単一実行の原子性でversionが移行前のまま＋行が無傷 ③新規DBはbackfillなしでCURRENTに到達。
- pre-pushレビューの指摘対応: `migration-atomicity.e2e.test.ts` のT2はカラム欠如アサーションが空虚（対象関数を丸ごとmockでthrowさせていた）でコメントが「rollback確認」と過大主張していた。**修正済み**: コメントを実際に検証している内容へ正確化し、`migration-v8.test.ts` に**真正のトランザクション原子性ガード**を追加。実 `migrateV7ToV8` を走らせ、ALTER後のbackfill UPDATEにのみ注入した例外（`db.exec` spy）でALTERがロールバックされること（カラム不在）＋versionが7のままを確認。
- 非空虚の実証（mutation probe）: `migrateV7ToV8` の `db.transaction` ラッパを外すとガードがRED、戻すと（`migration.ts` はバイト同一・`git diff` 空）GREEN。
- バックエンド等価の実測: ガードはファイルバックDB上で稼働（本番＝ファイルバック、A1 e2eもファイルバック）。独立のファイルバックprobeで wrapped⇒カラム不在＋version7 / unwrapped⇒カラム存在 を再現。SQLiteのトランザクショナルDDLロールバックはストレージバックエンド非依存で分岐なし。

### B2/B4: 検索ランキング評価基盤（B2/B4基盤コミット `2333209`）

- **バイト同一のチューニングseam**: `searchHybrid` に末尾optional引数 `SearchFusionTuning` を追加、`computeRrfScores` の `listWeights` は既定1、now注入は行ループ内に維持。tuningを渡さない本番呼び出しは従来とバイト同一（identity gate緑）。
- **本番実順の評価ハーネス** `scripts/gates/eval-order.ts`: `searchHybrid().results` を直接読む。旧 `eval-golden` 経路はベクトル距離で再ソートし `rrfScore`／`timeDecay` を捨てていたため融合順を測れなかった。
- **A/B比較器** `compare-order.ts`: advisory（非ブロッキング）・母集団ガード付き・exit 2/1/0。
- **順序検証テスト**: `sqlite-search-relevance` の順序テスト＋order-diagnosticのfixture/test。いずれも本番実順で評価。
- **順序メトリクスは記録専用**: rank-precision／MRR／nDCGを記録のみとし、検索の合否権威は `recall@5 > 0.568` を唯一の基準として維持（現状 `recall@5 = 0.622`）。
- **測定実施**: 事前登録バー（MRR +0.02フロア／recall・nDCG非減少／回帰なし）に対し10候補を測定。**該当ゼロのため係数は意図的に不変**（基盤のみ出荷・p-hackingしない）。
- **Golden Setの限界**: 52クエリ（37ヒット）を約12,113件の実検索から採取。信頼できるセンチネルだが積極チューニングには薄い（1クエリでMRRが約0.027動く）。実利得の正直な次の一手は、係数再チューニング前に**代表性のある大規模Golden Set**を作ること。
- **spec整合**: `smart-tag-retrieval` REQ-3に日付入りSUPERSEDEDバナー（順序意図は保持、機構をmemory-redesignの時間減衰 H=90 に統一）。`memory-redesign` の design.md に「recall@5は順序非依存であり係数変更はeval-orderハーネスで順序メトリクス非回帰を示すこと（recall@5は合否の唯一基準のまま）」を追記。これでB4のspec矛盾を解消。

### クリーンアップ

- 導入してしまったESM import cycleを、順序メトリクスのヘルパを新規leafモジュール `scripts/gates/eval-shared.ts` に抽出して解消。
- `bestExpectedRank` を同モジュールへ単一化（`eval-golden` は後方互換のため再export）。
- `migrateV7ToV8` 呼び出し側の陳腐化した「no backfill」コメントを修正。

## コミット一覧（main・全push済み）

| 役割 | ハッシュ | 内容 |
|---|---|---|
| A1コミット | `75de7c4` | feat(storage): 移行の原子性欠陥を根治（失敗時の偽完了マーカー阻止・末尾調停・トランザクション原子性ガード） |
| B2/B4基盤コミット | `2333209` | feat(search): 融合重み・時間減衰の後方互換チューニングseamと本番実順評価基盤を追加（係数は不変・順序メトリクスは記録のみ） |

- 2コミットの和集合が全変更集合と一致。`sqlite.ts` 内の独立した2論理変更（A1とB2/B4基盤）はハンク単位stageで分離。
- 作業ツリーclean・precommit secret guard通過・origin mainへpush済み。

## 本番稼働状況・QA

- typecheck＋build緑、全スイート実失敗0、identity gate緑、順序テスト緑、recall gate PASS（0.622 > 0.568）、原子性ガード緑かつファイルバック。
- ブランチ `main`。`git status` clean、`origin/main..HEAD` 空（未push差分なし）。
- npm publish: **dry-runのみ**（wasurenagusa cwdで実行）。同梱物清潔（223ファイル・248.2 kB）。**未公開・版数据え置き**、公開判断はオーナー保留。

## 残作業・次の一手

1. **公開判断（オーナー待ち）**: 新版へbump＋npm publishするか保留か。A1は実効ある堅牢化で公開価値あり、B2/B4は挙動中立の基盤。dry-runは清潔で準備済み。
   - **次の一手**: オーナー可否確認 → 可なら版数bump＋publish → 実インストール検証。
2. **B2/B4の実ランキング利得**: 代表性のある大規模Golden Setを構築 → A/Bハーネス再走 → 事前登録バーを越えた係数のみ適用。基盤・ハーネス・ベースラインは整備済み。
   - **次の一手**: 実検索ログからの大規模Golden Set採取設計。
3. **スコープ外・記録のみのフォローアップ**:
   - (a) WAL／ロック競合下のマルチプロセス同時移行の堅牢化は、変更していない移行フレームワーク既存の性質。実経路は単一プロセス起動時移行で、SQLiteのファイルロック＋カラム有無ゲートの冪等移行が同時試行を直列化／no-op化する。マルチプロセス配備が現実化したら別タスク。
   - (b) 既存・無関係のテストハーネスartifact: `src/cli/spec-update.ts` が `main().catch` で `process.exit(1)` するためunhandled rejectionとなり、実失敗0でも `npm test` がexit 1になる（pristine HEADで再現・2026年2月コミット由来）。テストコマンドがexit 0になるよう別途クリーンアップ推奨。

## 議論再開ポイント

- 5分で把握: 本引継書の「概要」「要求 × 現状」を読む。
- 背景の一次情報: A1の根因訂正は `src/storage/sqlite.ts`（initializeSchema・initialize末尾調停）と `src/e2e/migration-atomicity.e2e.test.ts`／`src/storage/migration-v8.test.ts`。B2/B4評価基盤は `scripts/gates/eval-order.ts`・`compare-order.ts`・`eval-shared.ts`。前提の監査経緯は `docs/findings/health-audit-20260719.md`。
