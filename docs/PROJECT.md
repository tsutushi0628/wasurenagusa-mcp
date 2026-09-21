---
schema_version: 1
verified_at: 2026-09-16T12:58:43Z
verified_head: cfea62d
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
- 焦点: 直近コミットは依存関係管理をpnpm共有ストアへ統一する作業（`cfea62d`）。直前にA1移行原子性根治とB2/B4検索評価基盤をv0.21.1としてnpm公開済み（`ed8c19b`）。
- 次の一手: B2/B4の検索ランキング利得は基盤のみ整備し係数は据え置き。適用には代表クエリの大規模Golden Set構築が必要（未着手）。
- 残作業: (a) マルチプロセス同時移行の堅牢化は対応不要(既存の冪等移行機構が直列化するため、配備が現実化したら別タスク)。(b) `src/cli/spec-update.ts` のunhandled rejectionで`npm test`がexit 1になる既知artifact(クリーンアップ推奨、未着手)。
- オーナー未回答: 忘却の自動アーカイブ安全網欠如への対処方針。即時停止か遡及バックフィルかの1問1答判断待ち(`health-audit-20260719.md`時点で未回答、以降の記録なし)。

## 5. 制約と注意事項
- 本番DBの書き換え（忘却バックフィルの遡及処理等）はオーナー承認必須。
- 依存関係管理はpnpm専用。`preinstall`でnpm/yarn installを拒否する（`cfea62d`でpnpm共有ストアへ移行）。
- 検索は日本語2文字漢字語のキーワード検索に構造的弱点あり。
- マルチプロセス下の同時マイグレーションは非対応。単一プロセス起動時移行が前提。
- `src/cli/spec-update.ts`のunhandled rejectionで`npm test`がexit 1になる（実テスト失敗ではない）。

## 6. 根拠となる最近の記録
- [handoff-20260720-a1-atomicity-b2b4-foundation-shipped](findings/handoff-20260720-a1-atomicity-b2b4-foundation-shipped.md)
- [health-audit-20260719](findings/health-audit-20260719.md)
