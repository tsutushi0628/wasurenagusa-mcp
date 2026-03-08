# wasurenagusa v0.6.0 X投稿ドラフト

## メイン告知（日本語）

wasurenagusa v0.6.0 リリース

AIコーディングエージェントに「学習能力」を与えるMCPサーバー。

v0.6.0 の目玉: LLM統合レイヤー
- 1,581件のdontエントリ → プロジェクトあたり5-9原則に圧縮
- 29件のconfigエントリ → 4-5テーマ別サマリーに圧縮
- 21,800文字の生データ → 6,200文字に注入（71%削減）

セッション開始時に自動で鮮度チェック → バックグラウンドでLLM圧縮。ゼロ遅延。

Hooks連携で完全自動。ユーザーの操作ゼロ。

https://github.com/tsutushi0628/wasurenagusa-mcp

#ClaudeCode #MCP #AI

---

## メイン告知（英語）

wasurenagusa v0.6.0 — Teach your AI coding agent to learn from its mistakes.

New: LLM Consolidation Layer
- 1,581 "dont" entries → 5-9 principles per project
- 29 config entries → 4-5 thematic summaries
- 21,800 chars raw → 6,200 chars injected (71% reduction)

Background consolidation on session start. Zero latency. Zero effort.

Now supports Gemini / OpenAI / Anthropic.

https://github.com/tsutushi0628/wasurenagusa-mcp

#ClaudeCode #MCP #AI

---

## 技術フォーカス投稿

コンテキスト効率の話。

メモリMCPの多くは「全部注入」する。100件貯まれば100件分のトークンを消費。

wasurenagusaのアプローチ:
1. LLMが数百件を5-9個の原則に圧縮（dont統合）
2. 散在する設定を4-5テーマに集約（config統合）
3. Owner Profileはカスタマイズ部分のみ注入（89%削減）
4. 検索はindex→detailの2段階（70-90%削減）

21,800文字 → 6,200文字。コンテキストの0.75%で済む。

---

## 比較投稿

Claude CodeのメモリMCP比較:

wasurenagusa:
- ミス自動検出（リトライ+感情）
- LLM統合（dont→原則、config→テーマ）
- 71%注入削減
- Markdown保存（人間が読める）
- MIT

claude-mem:
- 手動でミス記録
- 統合なし
- SQLite保存
- AGPL-3.0

CLAUDE.md:
- 手動管理のみ
- 増え続ける一方
- フィルタリングなし

それぞれ思想が違う。wasurenagusaは「AIが自分で学ぶ」に振り切ってる。
