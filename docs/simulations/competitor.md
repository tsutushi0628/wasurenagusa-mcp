# wasurenagusa — 競合・業界反応シミュレーション
シミュレーション日: 2026-03-04
視点: 競合プロダクト（Mem0, claude-mem, Memorix, Anthropic純正）+ 業界動向

---

## 前提整理

**主要プレイヤーの現状（2026年3月）**:

| プレイヤー | 規模 | 資金 | 戦略 | wasurenagusaとの関係 |
|----------|------|------|------|-------------------|
| **Mem0** | 48.6K stars | $24M (YC) | SDK型、マルチプラットフォーム、エンタープライズ | 異なるレイヤー（SDK vs MCP）。直接競合しにくい |
| **claude-mem** | ~32K stars | OSS | Claude Code特化、Hook型 | 最も近い直接競合。ユーザー層が完全に重なる |
| **Memorix** | 154 stars、4K DL/週 | OSS | 9エージェント対応、マルチLLM | 技術的に最も近い。dont統合機能なし |
| **server-memory** | (公式) 71K DL/週 | Anthropic | 基本KV store | 公式の安心感。機能はミニマル |
| **Anthropic純正** | — | — | Claude Code内蔵メモリ | プラットフォームリスクの本丸 |
| **Letta Code** | N/A | VC | エンタープライズAIメモリ | 異なる市場。企業向け |

---

## 大失敗シナリオ（競合に完全に無視される or 踏み潰される）

### Anthropicの動き
> 2026年Q3: Claude Code v3.0で「Auto Memory」機能をリリース。
> - セッション間の記憶保持（基本）
> - 「よくある間違い」の自動検出（基本）
> - CLAUDE.mdの自動更新
>
> → wasurenagusaの機能の70%が純正で実現される

### claude-memの動き
> 2026年Q2: claude-mem v2.0で「Smart Consolidation」を追加。
> - 蓄積されたメモリの自動圧縮
> - カテゴリ分類の自動化
> - 32K starsの既存ユーザーベースが一斉に移行
>
> → wasurenagusaの唯一の差別化が消滅

### 結果
- wasurenagusaは「claude-memの後追い」として認識される
- 新規ユーザー獲得がゼロになる
- 既存ユーザーもclaude-mem or 純正に移行

### なぜ大失敗するか
1. Anthropicの動きが予想より早い（12ヶ月ではなく6ヶ月で実装）
2. claude-memが32K starsのモメンタムでdont統合を先に実装
3. wasurenagusaが「先駆者だったが後発に追い抜かれた」典型パターン

---

## 失敗シナリオ（競合に認識されるが脅威と見なされない）

### claude-memの反応
> メンテナーがGitHub Issueで言及:
> "Interesting approach with the 'dont consolidation'. We're considering something similar for v2.0."
>
> → 3-6ヶ月後に類似機能を実装。32K starsの規模で即座に普及。

### Memorixの反応
> "wasurenagusa has an interesting 'dont' category concept. We might adopt a similar category system."
>
> → 技術は参照されるが、wasurenagusa自体は使われない

### Anthropicの動き
> 2026年後半: Claude Code v2.5で「Persistent Memory（Beta）」をリリース。
> - 基本的な記憶保持のみ
> - 統合・原則化機能はなし
> - 「公式があるから十分」層がwasurenagusaを試さなくなる

### 結果
- wasurenagusaの「dont統合」コンセプトは業界に影響を与える
- しかしwasurenagusa自体は80 starsに留まる
- 「アイデアは良かったが実行で負けた」パターン

### なぜ失敗で終わるか
1. claude-memがdont統合を実装し、規模の経済で勝つ
2. Anthropic純正の基本機能で「十分」層が離脱
3. wasurenagusaの思想は引用されるが、ツール自体は使われない

---

## 成功シナリオ（競合と共存し、ニッチで確固たるポジション）

### claude-memの反応
> claude-memのメンテナーがブログで言及:
> "wasurenagusa takes a different approach — while claude-mem focuses on comprehensive memory storage, wasurenagusa focuses on behavioral learning from failures. These are complementary tools."
>
> → 棲み分けが明確になり、両方使うユーザーが出現

### Memorixの反応
> Memorix v2.0が「wasurenagusa-compatible dont format」を採用:
> "We've adopted wasurenagusa's dont category and consolidation format as an optional plugin. Users can import their wasurenagusa dont entries into Memorix."
>
> → エコシステム内でのプロトコル化が始まる

### Anthropicの動き
> 2026年後半: Claude Code v2.5で「Persistent Memory（Beta）」をリリース。
> - 基本的なKV store型の記憶保持
> - 「失敗→原則」の統合機能はなし（12ヶ月以上先）
> - 純正の基本機能 + wasurenagusaの高度な学習機能 = 共存可能

### Mem0の反応
> Mem0チームがwasurenagusaを「interesting community project」としてニュースレターで紹介。
> 異なるレイヤー（SDK vs MCP）のため直接的な脅威と見なさない。
> "While Mem0 provides the infrastructure layer, tools like wasurenagusa demonstrate domain-specific memory patterns for coding agents."

### 結果
- wasurenagusaは「AI behavioral learning」カテゴリの代表として認知
- claude-memとは「記憶 vs 学習」で棲み分け
- Memorixとは互換フォーマットで協調
- Anthropic純正とは機能レイヤーが異なり共存

### なぜ成功するか
1. 「dont統合」が唯一無二の機能として12ヶ月間維持される
2. 競合が「補完的」と認めるポジショニングに成功
3. dontフォーマットのプロトコル化で「標準」としての地位を獲得
4. Anthropic純正は基本機能に留まり、高度な統合は外部MCPの領域として残る

---

## 大成功シナリオ（業界標準になる）

### エコシステム変革
> - 3つ以上のMemory MCPがwasurenagusaの「dont consolidation」プロトコルを採用
> - MCP公式ドキュメントで「behavioral learning pattern」としてwasurenagusaが引用される
> - 「dont」「consolidation」が業界用語として定着

### Anthropicの認知
> Anthropic公式ブログ:
> "The MCP ecosystem has produced remarkable innovations. Projects like wasurenagusa demonstrate how third-party servers can push the boundaries of what's possible with AI coding agents — in this case, teaching agents to learn from their own failures."
>
> → 公式の「お墨付き」がwasurenagusaの地位を確立

### Mem0の動き
> Mem0 SDK v3.0に「Behavioral Learning Module」を追加。
> wasurenagusaのdont consolidationアルゴリズムにインスパイアされた設計。
> "Inspired by the pioneering work of wasurenagusa..."
>
> → Mem0に思想が取り込まれることは「勝利」（名前が残る）

### 結果
- wasurenagusaは「AI behavioral learning」の先駆者として歴史に残る
- 思想がMem0等の大規模プロジェクトに取り込まれ、影響力が増大
- しんたろうさんがMCP/AI agent分野のthought leaderとして認知される

### なぜ大成功するか
1. 「dont consolidation」が技術概念として定着
2. 純正が12ヶ月以内に追いつかず、wasurenagusaの先行期間が十分に確保された
3. dontフォーマットのプロトコル化→他MCPが採用→事実上の標準

---

## タイムライン予測

```
2026年3月   wasurenagusa npm公開
2026年4月   multi-LLM対応完了、Show HN投稿
2026年6月   ← クリティカルデッドライン: ここまでにポジション確立必須
2026年Q3    Anthropic「Persistent Memory Beta」リリース（基本機能のみ）
2026年Q3    claude-mem がdont統合を検討開始
2026年Q4    claude-mem v2.0 にconsolidation機能追加の可能性
2027年Q1    Anthropic 純正の統合機能（もし実装する場合）
```

**時間窓**: wasurenagusaがポジションを確立できるのは **2026年6月末まで**。
- claude-memがdont統合を実装するまで: 推定3-6ヶ月
- Anthropic純正が「統合」に到達するまで: 推定12ヶ月以上
- この間にstars数・npm DL・コミュニティ認知を積み上げることが生存条件

---

## MCPプロトコルリスク（2026年3月追加）

「MCPはなぜCLIに負けたのか」等の批判が出現。ツール定義のトークンオーバーヘッド（43倍）やモデル進化でCLI直接操作が可能になった点が指摘されている。

**wasurenagusaへの影響:**
- wasurenagusaのコア機能（失敗検知→統合→注入）はMCPに依存していない（CLI既存）
- MCPは追加利便性レイヤーに過ぎないため、MCPが衰退してもCLIで全機能動く
- **対策: 「MCP server」ではなく「AI behavioral learning tool（MCP & CLI）」としてポジショニング**
- CLI-first + MCP-optionalの二刀流はむしろ差別化要因になる

---

## 防御戦略

### 技術的堀（弱い）
- dont consolidationのアルゴリズム自体は模倣可能（LLMプロンプト）
- 技術的な参入障壁はほぼゼロ

### 思想的堀（強い）
- 「AI behavioral learning」という概念の先駆者としてのブランド
- ドッグフーディングデータ（508→7）の信頼性と再現性
- 「反省エンジン」というフレーミングの所有権

### プロトコル堀（最強だが実現困難）
- dontフォーマットの標準化 → 他MCPが採用 → ネットワーク効果
- wasurenagusa互換を名乗るMCPが増えるほど、wasurenagusaの地位が強化

### 推奨防御策
1. **思想リーダーシップ**: 定期的にブログ/記事で「AI behavioral learning」の概念を深掘り
2. **プロトコル公開**: dont consolidationのフォーマット仕様を公開し、他MCPに採用を呼びかけ
3. **Anthropicとの関係**: MCP仕様への準拠を完璧にし、公式チャネルで紹介される可能性を最大化
4. **スピード**: 6月末デッドラインを厳守。品質より速度

---

## 分岐ポイント

| 分岐 | 条件 |
|------|------|
| 大失敗 → 失敗 | Anthropic純正が「統合」まで来ない（基本機能止まり）|
| 失敗 → 成功 | **claude-memがdont統合を実装する前にポジション確立**。2026年6月末がデッドライン |
| 成功 → 大成功 | dontフォーマットが他MCPに採用される。プロトコルとしての標準化 |

---

*作成日: 2026-03-04*
