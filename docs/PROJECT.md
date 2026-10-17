---
schema_version: 1
verified_at: 2026-10-17T21:58:50Z
verified_head: 031aac5
source_worklog: worklog-20261018-vuln-fix.md
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
- 焦点: 訂正ループ（Wasurenagusa）。依存の脆弱性対応で OpenTelemetry を外し、Genkit をやめて各社 API を直接呼ぶ（3c965f7）。Anthropic 既定モデルは最新 Haiku 5.5
- 次の一手: `cd ~/projects/wasurenagusa-mcp && npm publish --otp <6桁>`（0.23.0）。ブロック原因＝npm の2段階認証が無効（共有欄の記載）
- 残作業: 未コミットの docs/PROJECT.md の確認（オーナー y/n）／翌晩の卒業処理の結果確認／次ラウンド（設計書 docs/spec-learning-round3.md）
- オーナー未回答: 忘却の自動アーカイブ安全網の対処方針（2026-07-19 から未回答）
## 5. 制約と注意事項
- 本番DBの書き換え（忘却バックフィルの遡及処理等）はオーナー承認必須。
- 依存関係管理はpnpm専用。`preinstall`でnpm/yarn installを拒否する（`cfea62d`でpnpm共有ストアへ移行）。
- 検索は日本語2文字漢字語のキーワード検索に構造的弱点あり。
- マルチプロセス下の同時マイグレーションは非対応。単一プロセス起動時移行が前提。
- `src/cli/spec-update.ts`のunhandled rejectionで`npm test`がexit 1になる（実テスト失敗ではない）。

## 6. 根拠となる最近の記録
- [worklog-20261018-vuln-fix](../../s.t.findings/wasurenagusa-mcp/202610/worklog-20261018-vuln-fix.md)
- [worklog-20261016-wasurenagusa-fixes](../../s.t.findings/wasurenagusa-mcp/202610/worklog-20261016-wasurenagusa-fixes.md)
- [worklog-20261004-owner-correction-loop](../../s.t.findings/wasurenagusa-mcp/202610/worklog-20261004-owner-correction-loop.md)
