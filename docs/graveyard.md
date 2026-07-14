# graveyard: 死機能の記録（タスク4.8）

物理削除した死機能の死因を記録する。将来の再発明防止が目的。復活する場合は「蘇生」ではなく、この記録を読んだ上で再建後アーキテクチャ上に新規設計すること。

## 予測誤差ループ（保留・削除見送り）

- 対象: `src/vector/prediction-error.ts` ほか（`predictedFactors`/`actualFactors`/`predictionError`/`predictionDelta` の一式）
- 判断記録（物理削除の方針そのもの）: `.spec-workflow/specs/memory-redesign/Implementation Logs/task-0.0-prediction-error-loop-decision.md`
- 削除前ゲート再実測（2026-07-14）: `firebase-kit` の記憶ストアで実データ2件を検出（他5ストアは0件）。ゲート条件「1件でも存在したら削除を保留しオーナーへエスカレーション」に抵触したため、**本タスクでは削除を実行しない**。コードは現状のまま稼働状態を維持する。
- 設計意図の要約（`docs/spec-prediction-error-loop.md`参照）: 探索前に「効くと見立てた変数」と探索後に「実際効いた変数」の差分（Jaccard距離、コード側で算出・LLM不使用）を学習信号にし、`getContext` の世界モデルブロックと検索スコアの加点に使う。v1は手動／明示API経由のみで完結させる設計（Stop hook自動捕捉はv2でスコープ外）。
- 次アクション: オーナーが実データ2件の扱い（温存継続／エクスポートして手動レビュー後に削除／別途正式運用に格上げ）を裁定してから、タスク4.8を再実行するか判断する。

## UserPromptSubmit空回り配線

- 対象: `src/cli/context.ts` の `handleUserPromptSubmit()` と、それを呼ぶだけの分岐
- 死因: 関数本体が空（コメントのみ）で、呼び出しても何も起きない配線だった。UserPromptSubmitの記憶想起はプロジェクト側のhooksが担う設計に既に移行済みで、このCLI側の分岐は何もしないことを確認するだけの死んだ迂回路だった。
- 対応: 分岐は残すが（UserPromptSubmit受信時に早期returnする必要があるため）、意味のない関数呼び出しの間接層を削除し、コメントで「何もしない」ことを明示。挙動は完全に不変（元々何も出力していない）。

## Phase 0で遮断済みのv1経路（consolidate-worker / retag-worker / staleness v1判定）

- 対象1: `src/cli/consolidate-worker.ts`（+ `consolidate-worker.test.ts`）— detachedプロセスとしてspawnされ、MarkdownStorage（v1）経由でdont/config統合を実行し `consolidated-dont.json` 等（v1資産）へ書き込むワーカー。
- 対象2: `src/cli/retag-worker.ts`（+ `retag-worker.test.ts`）— detachedプロセスとしてspawnされ、MarkdownStorage（v1）経由で過去エントリを再タグ付けするワーカー。
- 対象3: `src/consolidator/staleness.ts` のv1互換ブロック（`isConsolidationStale`/`readConsolidatedDont`/`writeConsolidatedDont`/`isConfigConsolidationStale`/`readConsolidatedConfig`/`writeConsolidatedConfig`/`readDontSummary`/`writeDontSummary`、ファイルベースのmtime比較による鮮度判定）+ `staleness.test.ts`。
- 死因: タスク0.6（R-A3）で、SessionStart/save経路からのspawn呼び出しは既に物理遮断済み（`src/cli/context.ts`・`src/tools/save.ts` にspawn呼び出しコード自体が存在しない）。ワーカーファイル本体・v1鮮度判定関数は、遮断後は呼び出し元を持たない孤立コードとして残っていた。依存監査（import参照）で両ワーカーへの参照が自身のテストのみであること、v1鮮度判定関数への参照が `consolidate-worker.ts` と自身のテストのみであることを確認済み。
- 復活条件: v1（Markdownストレージ）を正本に戻す設計変更を行う場合のみ。SQLiteStorage（v2）が正本である現行設計では復活の必要性なし。
- 参考: SQLiteStorage経由のv2鮮度判定（`isConsolidationStaleSqlite`等）とテーマ登録（`storage.addThemes`）は生きたまま維持。

## `src/tools/save.ts` の `replaceId` デッドコード

- 対象: `handleMemorySave`（`memory_save` MCPツールのハンドラ）内の「`params.replaceId` 指定時に古いベクトルを削除する」分岐。
- 死因: `memorySaveTool.inputSchema.properties` に `replaceId` が公開されておらず、このハンドラが組み立てる `SaveParams` オブジェクトも `replaceId` を一切設定していなかった。従って `if (params.replaceId)` は `handleMemorySave` 経由では恒久的に真にならない、到達不能な分岐だった。
- 注意: `replaceId` 自体は生きた機能。`src/cli/analyze.ts`（重複検出→置換）が `storage.save()` を直接呼ぶ別経路で使っており、`src/storage/markdown.ts`・`src/storage/sqlite.ts` の置換ロジック・型定義（`SaveParams.replaceId`）はすべて維持。削除したのはMCPツールハンドラ内の死んだ迂回コードのみ。
