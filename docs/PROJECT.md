---
schema_version: 1
verified_at: 2026-10-07T20:51:53Z
verified_head: f76a1d5
source_worklog: worklog-20261004-owner-correction-loop.md
---
# wasurenagusa-mcp

## 1. 目的と利用者
- AIコーディングエージェントに永続的な記憶を持たせるMCPサーバー。ミスを自動検知し教訓を統合、セッション開始時に文脈を注入する。
- 利用者はMCP対応クライアント（Claude Code等）を使う開発者。npmパッケージ `wasurenagusa-mcp` として配布。

## 2. 稼働状態とURL
- npm公開中。version 0.21.1（2026-07-20公開、コミット `ed8c19b`）。
- 本番URL: なし（ローカル実行のMCPサーバーで、Web上のデプロイ先を持たない）。
- 配布先: npm registry（パッケージ名 `wasurenagusa-mcp`）。

## 3. 構成マップ
- `src/`: MCPサーバー本体（analyzer、cli、consolidator、guards、injection、llm、storage、vector等）
- `scripts/`: ゲート検証、保守、評価スクリプト（gates、maintenance、spikes、verify）
- `docs/findings/`: 調査、引継記録（30本）
- `docs/`: 仕様書、ロードマップ等（spec.md、gtm-roadmap.md等）
- `prompts/`: LLM呼び出し用プロンプトテンプレート
- `.wasurenagusa/`: ランタイムデータ（記憶DB、設定、バックアップ、ログ）

## 4. 現在地
- 焦点: 訂正の検出・保存・注入ループは本番反映済み（ラウンド2 まで、schema v12、10/07 Push `f76a1d5`）。学習化ラウンド3（設計 `docs/spec-learning-round3.md`: 再生の評価基盤・強度・原則化・卒業提案・Codex 先行・G1〜G3・Astra 5回レビュー反映）は実装・QA PASS まで済み、作業ツリーに未コミット。本番は schema 12 のまま、dist 未反映。
- 次の一手: オーナーの y/n を取ってラウンド3 を本番反映（schema 13、手順は worklog `docs/findings/worklog-20261004-owner-correction-loop.md` の復帰ブロック）。反映前に `pnpm run build` を直接叩かない。反映後は 10/08〜10/21 の14日観察（H2）。
- 残作業: (a) ラウンド3 の本番反映・コミット・Push。(b) H2 の14日観察。(c) 次ラウンド＝頻出する注意1種で察する→確かめる→直すを本番で一周させる。(d) 分からない言葉・確認しろ・要約の型・モデル指定の未対応分（設計書 `docs/spec-owner-correction-loop.md` 節 11）。
- オーナー未回答: ラウンド3 の本番反映 y/n。合格基準 A8 の定義変更提案。G3 を将来 on にするか。忘却の自動アーカイブ安全網欠如への対処方針（2026-07-19 から未回答）。
## 5. 制約と注意事項
- 本番DBの書き換え（忘却バックフィルの遡及処理等）はオーナー承認必須。
- 依存関係管理はpnpm専用。`preinstall`でnpm/yarn installを拒否する（`cfea62d`でpnpm共有ストアへ移行）。
- 検索は日本語2文字漢字語のキーワード検索に構造的弱点あり。
- マルチプロセス下の同時マイグレーションは非対応。単一プロセス起動時移行が前提。
- `src/cli/spec-update.ts`のunhandled rejectionで`npm test`がexit 1になる（実テスト失敗ではない）。

## 6. 根拠となる最近の記録
- [worklog-20261004-owner-correction-loop](findings/worklog-20261004-owner-correction-loop.md)
- [handoff-20260720-a1-atomicity-b2b4-foundation-shipped](findings/handoff-20260720-a1-atomicity-b2b4-foundation-shipped.md)
