---
schema_version: 1
verified_at: 2026-10-04T00:00:00Z
verified_head: b25d316
source_worklog: handoff-20260720-a1-atomicity-b2b4-foundation-shipped.md
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
- 焦点: オーナーが同じ注意を二度言わなくて済む「訂正の検出・保存・注入ループ」を実装し、2026-10-04 に本番反映（`647c9bd`・`b25d316`、npm 未公開）。中央ストアは schema v11、毎発話の注入を有効化。
- 次の一手: 実際の会話で訂正の候補・確定の溜まり方を観察し、誤確定があれば `WASURENAGUSA_CORRECTION_LOOP=off` で止めて直す。
- 残作業: (a) 過去会話の再生では言い直しの 2 割弱（学習用 13/70）に効き、未見 30 session では 0/29。分からない言葉・確認しろ・要約の型・モデル指定は未対応（設計書 `docs/spec-owner-correction-loop.md` 節 11）。(b) `src/cli/spec-update.ts` の unhandled rejection は既知。
- オーナー未回答: 今の効き目で足りるか、改修を続けるか。忘却の自動アーカイブ安全網欠如への対処方針（2026-07-19 から未回答）。

## 5. 制約と注意事項
- 本番DBの書き換え（忘却バックフィルの遡及処理等）はオーナー承認必須。
- 依存関係管理はpnpm専用。`preinstall`でnpm/yarn installを拒否する（`cfea62d`でpnpm共有ストアへ移行）。
- 検索は日本語2文字漢字語のキーワード検索に構造的弱点あり。
- マルチプロセス下の同時マイグレーションは非対応。単一プロセス起動時移行が前提。
- `src/cli/spec-update.ts`のunhandled rejectionで`npm test`がexit 1になる（実テスト失敗ではない）。

## 6. 根拠となる最近の記録
- [handoff-20260720-a1-atomicity-b2b4-foundation-shipped](findings/handoff-20260720-a1-atomicity-b2b4-foundation-shipped.md)
- [worklog-20261004-owner-correction-loop](findings/worklog-20261004-owner-correction-loop.md)
