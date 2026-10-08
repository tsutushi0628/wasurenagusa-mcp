---
schema_version: 1
verified_at: 2026-10-08T07:50:31Z
verified_head: 246ebc8
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
- 焦点: 訂正ループ（Wasurenagusa）。ラウンド3 は本番反映済み（schema 13、LOOP=on）。確定した注意を Jev カードへ移す方式（卒業）も本番 on。push 済み、0.23.0 = 246ebc8。
- 次の一手: `cd ~/projects/wasurenagusa-mcp && npm publish`（0.23.0。先にオーナーが npm login）
- 残作業: npm publish 0.23.0（ブロック原因＝このマシンが npm 未ログイン）／本番後14日の観察（10/08 12:07〜10/22、H2）／次ラウンド（設計書 `docs/spec-learning-round3.md` を起点）
- オーナー未回答: G3 を将来 on にするか。A8 の定義変更提案（参考値扱い中）。忘却の自動アーカイブ安全網の対処方針（2026-07-19 から未回答）
## 5. 制約と注意事項
- 本番DBの書き換え（忘却バックフィルの遡及処理等）はオーナー承認必須。
- 依存関係管理はpnpm専用。`preinstall`でnpm/yarn installを拒否する（`cfea62d`でpnpm共有ストアへ移行）。
- 検索は日本語2文字漢字語のキーワード検索に構造的弱点あり。
- マルチプロセス下の同時マイグレーションは非対応。単一プロセス起動時移行が前提。
- `src/cli/spec-update.ts`のunhandled rejectionで`npm test`がexit 1になる（実テスト失敗ではない）。

## 6. 根拠となる最近の記録
- [worklog-20261004-owner-correction-loop](findings/worklog-20261004-owner-correction-loop.md)
- [handoff-20260720-a1-atomicity-b2b4-foundation-shipped](findings/handoff-20260720-a1-atomicity-b2b4-foundation-shipped.md)
