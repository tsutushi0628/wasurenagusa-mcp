# wasurenagusa — Dev Twitter/X 反応シミュレーション
シミュレーション日: 2026-03-04
視点: 開発者Twitter/X（日本語圏 + 英語圏）

---

## 前提整理

**プロダクト特性**:
- AI coding agentの失敗を自動検知→原則統合→セッション注入するMCP server
- OSS / MIT / npm公開。日本人開発者による個人プロジェクト
- ドッグフーディング: 508 dontエントリ→7原則、788KB→3KB

**Dev Twitter/X環境（2026年3月時点）**:
- AI coding tool関連の投稿は高エンゲージメント帯（平均RT率が通常投稿の3-5倍）
- 日本語開発者コミュニティ: Claude Code/Cursorの利用率が急増。「AI開発術」系の投稿がバズりやすい
- 英語圏: 「AI agent memory」関連は飽和傾向。差別化が見えないと無視される
- Before/After形式の投稿が最もバイラルしやすい
- 日本語名のOSS: 「かっこいい」と「読めない」の二極化反応

---

## 大失敗シナリオ（インプレッション1,000未満、完全無視）

### 作者の告知投稿

```
wasurenagusa-mcp をnpmに公開しました！
AIコーディングエージェントに永続的なメモリを与えるMCPサーバーです。
GitHub: [link]
#MCP #ClaudeCode #AI
```

### 反応
- いいね: 5（フォロワーのみ）
- RT: 0
- インプレッション: 800
- コメント: 0

### なぜ大失敗するか
1. 「公開しました」は最もエンゲージメントが低い投稿パターン
2. 「MCPサーバー」「永続的なメモリ」は技術用語すぎて非開発者に刺さらない
3. Before/Afterの数字がない
4. 「何が嬉しいのか」が30文字で伝わらない

---

## 失敗シナリオ（日本語圏で小さな反応、英語圏は無反応）

### 作者の告知投稿

```
AIコーディングエージェントって、毎回同じミスしない？

6ヶ月使い込んで508回の失敗を記録した結果、
LLMが自動で7つの原則に圧縮してくれるツール作った。

788KB → 3KB（99.6%削減）
使えば使うほどAIが賢くなる。

wasurenagusa（忘れな草）
GitHub: [link]
```

### 反応

**日本語圏**:
- いいね: 80-150
- RT: 20-40
- インプレッション: 15,000-30,000

> "面白い発想。でもGemini APIキー必要なのか…Claude使ってるのにGoogleのAPIキー取りに行くの面倒"
> いいね 12

> "Claude.mdが200行超えると無視される問題、これで解決するの？気になる"
> いいね 8

> "忘れな草って名前いいね。ただnpmのパッケージ名コピペしないと打てないw"
> いいね 15

**英語圏**: 反応なし（日本語投稿のため届かない）

### なぜ失敗で終わるか
1. 日本語圏のみで小さなバズ。英語圏に波及しない
2. Gemini API問題がコメントの30%を占め、興味の転換が起きない
3. 「試してみた」報告が少なく、二次拡散の燃料が不足

---

## 成功シナリオ（日本語圏でバズ→英語圏に波及）

### 作者の告知スレッド（日本語）

```
【スレッド 1/5】
AIコーディングエージェントに「反省」を教えるツールを作った。

6ヶ月間、8プロジェクトでClaude Codeを毎日使い込んだ。
AIは毎回同じミスをする。innerHTML、ポート番号間違い、コーディング規約無視…

508回の失敗を記録し、LLMに「原則を導き出して」と頼んだら、
7つの原則に自動圧縮された。788KB → 3KB。

次のセッションから、AIが同じミスをしなくなった。
```

```
【スレッド 2/5】
Before:
- セッション開始→AIが前回と同じミス→手動で修正→イライラ
- CLAUDE.mdに書いても200行超えると無視される

After:
- セッション開始→過去の原則が自動注入→AIが地雷を踏まない
- 使えば使うほどAIが賢くなる
```

```
【スレッド 3/5】
仕組み:
1. SessionStart Hook → 原則をAIに自動注入
2. 作業中 → 失敗を自動検知（リトライ・感情パターン）
3. SessionEnd Hook → 失敗を記録
4. バックグラウンド → LLMが原則に統合

すべて自動。手間ゼロ。
```

```
【スレッド 4/5】
wasurenagusa（忘れな草）
- OSS / MIT License
- npm: npx -y wasurenagusa-mcp
- OpenAI / Anthropic / Gemini 対応
- Claude Code / Cursor / Windsurf で動作

GitHub: [link]
```

```
【スレッド 5/5】
「すぐ忘れる最強の天才に、人間の記憶を。」

AIは最強の天才だけど、会話が終わるとすべて忘れる。
人間は失敗の痛みから原則を学ぶ。
wasurenagusaは、その仕組みをAIに実装した。

使い込むほど育つAI、試してみてほしい。
```

### 反応

**Phase 1: 初動（投稿〜6時間）**
- いいね: 300-500
- RT: 100-200
- インプレッション: 50,000-100,000

> "CLAUDE.mdが200行で無視される問題、マジでこれ。ずっと悩んでた。入れてみる"
> いいね 89, RT 23

> "「AIに反省を教える」って表現が秀逸。メモリツールじゃなくて学習ツールなんだ"
> いいね 67, RT 15

> "508→7は人間のメタ認知そのもの。千の失敗から数個の原則を抽出する。AIにこれができるのか"
> いいね 45, RT 12

**Phase 2: 拡大（6-24時間）**
- 「やってみた」報告が出始める

> "wasurenagusa入れて3日。マジでAIが同じミスしなくなってる。地味にすごい"
> いいね 120, RT 35

> "忘れな草の統合レポート見た。うちのプロジェクト、132の失敗から4原則が生まれてた。面白い"
> いいね 85, RT 20

**Phase 3: 英語圏波及（2-5日目）**
- 英語圏の日本ウォッチャーがピックアップ

> "Japanese developer built an MCP server that teaches AI to learn from 508 mistakes. Compressed into 7 principles. Called 'wasurenagusa' (forget-me-not). This is beautiful."
> Likes 200, RT 80

### なぜ成功するか
1. スレッド形式でBefore/After→仕組み→インストール→哲学の順序
2. 「CLAUDE.md 200行問題」がClaude Codeユーザーの共感を即座に獲得
3. 「やってみた」報告が自然発生し、二次拡散の燃料になる
4. 「忘れな草」の名前の美しさが英語圏でも話題に

---

## 大成功シナリオ（日本語圏トレンド→英語圏バイラル→メディア波及）

### 追加の拡散要素

**Phase 4: メディア波及（1-2週間後）**

> **Zenn記事**: 「AIに反省を教えた6ヶ月の記録 — 508の失敗から7つの原則が生まれるまで」
> 800+ likes、はてブ200+

> **dev.to記事**: "I Taught My AI to Learn From 508 Mistakes — Here's What It Discovered"
> 500+ reactions、HN経由で再拡散

> **YouTuber**: 「AIが自分で原則を学ぶ…？wasurenagusaが凄すぎた」
> 5万再生

**バイラル投稿（英語圏で最もシェアされる型）**:

```
I gave my AI coding agent the ability to learn from its mistakes.

After 508 failures across 8 projects, it auto-extracted 7 core principles:

1. Always sanitize user input at boundaries
2. Check port conflicts before starting servers
3. Follow project naming conventions, not generic patterns
4. Read existing code before suggesting changes
5. Test edge cases, not just happy paths
6. Respect .gitignore and security boundaries
7. Ask before destructive operations

788KB of raw mistakes → 3KB of wisdom.
The AI now catches itself before repeating past errors.

Tool: wasurenagusa (forget-me-not)
Open source: [link]
```

予測エンゲージメント: Likes 2,000+, RT 800+, インプレッション 500,000+

**なぜバズるか**: 7原則の具体的な内容が「あるある」の連鎖を引き起こす。開発者なら全員が共感できるリスト。

### 反応の連鎖

> "原則#4 'Read existing code before suggesting changes' — AIに言われると耳が痛いw これ人間にも当てはまる"
> Likes 500+

> "This is basically how senior developers are made. 10 years of mistakes → a few core principles. wasurenagusa does it in 6 months."
> Likes 300+

### なぜ大成功するか
1. **7原則の具体的リスト**がコンテンツとして単体で完結している（ツールを使わなくても面白い）
2. 「AIに反省を教える」が人間の成長プロセスのメタファーとして共感を呼ぶ
3. 日本語の美しい名前（忘れな草）がストーリー性を追加
4. 開発者 × AI × 哲学の交差点が知的好奇心を刺激

---

## 分岐ポイント

| 分岐 | 条件 |
|------|------|
| 大失敗 → 失敗 | Before/After数字を投稿に含める。「公開しました」ではなく問題提起から入る |
| 失敗 → 成功 | **スレッド形式で段階的に情報開示**。「やってみた」報告が3件以上出る |
| 成功 → 大成功 | **7原則の具体的リストを公開**。原則自体がコンテンツとして独立して面白い |

**最大のレバレッジポイント**: 7原則の具体的リストの公開。ツールの宣伝ではなく、原則そのものが「面白いコンテンツ」として拡散し、ツールへの誘導が自然に発生する。

---

*作成日: 2026-03-04*
