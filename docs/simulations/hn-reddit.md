# wasurenagusa — HackerNews / Reddit 反応シミュレーション
シミュレーション日: 2026-03-04
視点: HackerNews (Show HN) / Reddit (r/ClaudeAI, r/LocalLLaMA, r/MachineLearning)

---

## 前提整理

**プロダクト特性**:
- AI coding agentの失敗を自動検知し、原則に統合してセッション注入するMCP server
- OSS、MIT License、npm公開
- 作者のドッグフーディング: 8プロジェクト、508 dontエントリ→7原則、788KB→3KB（99.6%削減）
- 現状Gemini API専用（multi-LLM対応はP0ロードマップ）

**HN/Reddit環境（2026年3月時点）**:
- MCP関連のShow HNは直近1週間で3件。全て1-2 points。**MCP疲れ**が顕著
- 「MCP」「memory」をタイトルに含むだけでスキップされる傾向
- AI coding tool全般への関心は依然高いが、差別化が見えないツールは無視される
- 日本語名のOSSに対する反応は二極化（「cool」派 vs 「can't pronounce it」派）
- r/ClaudeAIはClaude Code関連ツールへの関心が最も高いsubreddit

---

## 大失敗シナリオ（1-2 points、埋没）

### Show HN投稿

```
Show HN: Wasurenagusa – MCP memory server for AI coding agents

wasurenagusa is an MCP server that gives AI agents persistent memory
across sessions. It auto-detects mistakes and consolidates them into
principles.

GitHub: [link]
```

### 反応

**投稿直後（0-2時間）**: 0 points、コメントゼロ。newページの2ページ目に沈む。

**唯一のコメント**:
> "Another MCP memory tool? There are literally 15 of these now. What makes this different from claude-mem or Memorix?"
>
> → 作者の返答が来る頃にはスレッドは死んでいる

**Reddit r/ClaudeAI**:
> "Just tried to install this. Requires Gemini API key? Why would I need a Google API key for my Claude workflow? Pass."
>
> 3 upvotes, 2 replies agreeing

### なぜ大失敗するか
1. タイトルに「MCP」「memory」が入っている → MCP疲れフィルターに引っかかる
2. 説明が機能ベース（"auto-detects mistakes"）で、数字がない
3. Gemini API必須が即座の試用を阻む
4. 日本語名の読み方がわからず、そもそもクリックされない

---

## 失敗シナリオ（10-30 points、小さな反応のみ）

### Show HN投稿

```
Show HN: Wasurenagusa – AI reflection engine that turns failures into principles

After 6 months of daily AI coding, I had 508 "don't do this" entries
scattered across 8 projects. So I built an MCP server that auto-detects
AI failures and consolidates them into behavioral principles.

508 entries → 7 principles. 788KB → 3KB (99.6% reduction).

GitHub: [link] | npm: npx -y wasurenagusa-mcp
```

### 反応

**投稿直後（0-4時間）**: 5-8 upvotes。フロントページには届かないが、/newページの上位に留まる。

**コメント（5-8件）**:

> "Interesting concept. The 508→7 compression is cool. But why Gemini only? I use Claude for coding and OpenAI for everything else. Having to get a third API key just for this is a non-starter."
> 12 points

> "I've been using claude-mem for 3 months and it works great. What's the advantage over that?"
> 8 points
>
> → 作者: "claude-mem stores memories. wasurenagusa learns from them. The key difference is automatic consolidation — it doesn't just remember 'don't use innerHTML', it learns the principle 'always sanitize user input' from dozens of similar failures."
> 5 points

> "The name is impossible to type. 'wasure...' what? Can you add an alias like 'wng' or something?"
> 6 points

> "Nice project. The concept of 'behavioral learning' for AI agents is underexplored. But the Gemini dependency kills it for me. Will watch for multi-LLM support."
> 4 points

**Reddit r/ClaudeAI** (15 upvotes):
> タイトル: "Found an interesting MCP server that auto-consolidates AI mistakes into principles"
>
> トップコメント: "The idea is great but Gemini-only is a dealbreaker. Would love to see this work with Claude's API directly."

### なぜ失敗で終わるか
1. フロントページに届かず、リーチが限定的（〜500人閲覧）
2. Gemini専用がコメントの50%を占め、プロダクト議論に至らない
3. claude-memとの比較で「差別化がわかりにくい」と判断される
4. 「面白いけど今は使わない」→ スターだけ押して離脱

---

## 成功シナリオ（200-400 points、フロントページ入り）

### Show HN投稿

```
Show HN: My AI made 508 mistakes. I taught it to never repeat them.

I've been coding with Claude Code daily for 6 months across 8 projects.
The AI kept making the same mistakes — innerHTML without sanitization,
wrong port numbers, ignoring project conventions.

So I built wasurenagusa ("forget-me-not" in Japanese), an MCP server
that auto-detects failures and consolidates them into behavioral principles.

Results from my daily use:
- 508 failure entries → 7 core principles (auto-consolidated by LLM)
- 788KB of raw "don't do this" data → 3KB injected per session (99.6% reduction)
- The AI now catches itself before repeating past mistakes

Works with Claude Code, Cursor, and Windsurf. Supports OpenAI, Anthropic,
and Gemini APIs.

GitHub: [link] | npm: npx -y wasurenagusa-mcp
```

### 反応

**Phase 1（0-2時間）**: 15-20 upvotes。フロントページ下部に到達。

**Phase 2（2-6時間）**: 80-150 upvotes。フロントページ中位に安定。コメント30件超。

**Phase 3（6-24時間）**: 200-400 upvotes。24時間後にフロントページから落ちる。

**トップコメント**:

> "This is genuinely clever. Most 'memory' tools just store key-value pairs. The insight that AI agents need to learn *principles* from *failures*, not just remember facts, is the right framing."
> 89 points

> "I've been maintaining a 400-line CLAUDE.md that Claude ignores after the first 200 lines. This solves that exact problem. Just installed it."
> 67 points
>
> → Reply: "Wait, CLAUDE.md has a 200-line limit? Is that documented anywhere?"
> → Reply: "Not officially. But anyone who's used Claude Code seriously has noticed it stops following instructions past ~200 lines."
> 45 points

> "The name 'wasurenagusa' (forget-me-not) is beautiful. Perfect naming for a memory tool."
> 52 points
>
> → Reply: "It's poetic, but I had to copy-paste it to install. A shorter alias would help adoption."

> "Philosophical question: if the AI consolidates its own failures into principles, and those principles change its behavior, is this the beginning of AI self-improvement?"
> 41 points

> "508 failures → 7 principles. That's basically how human expertise works. You make a thousand mistakes, then you internalize a few rules that prevent most of them. Interesting that it works for AI too."
> 38 points

**Reddit r/ClaudeAI** (120 upvotes):
> トップコメント: "Finally something that goes beyond basic memory storage. The 'dont consolidation' feature is what I've been wanting. Just set it up and it works with Claude's API. The setup guide is clear."

**Reddit r/LocalLLaMA** (40 upvotes):
> "Does this work with local models? I'd love to use this with my Llama 3 setup but without sending data to any cloud API."

### なぜ成功するか
1. タイトルが数字ではなくストーリーで導入（"My AI made 508 mistakes"）
2. 具体的な失敗例（innerHTML, port numbers）が共感を呼ぶ
3. multi-LLM対応済みでGemini批判が発生しない
4. 「CLAUDE.mdの200行制限」問題がHNコミュニティの共有ペインを突く
5. 哲学的議論（AI self-improvement）がHN民のエンゲージメントを高める

---

## 大成功シナリオ（800+ points、24時間フロントページ滞在）

### Show HN投稿
（成功シナリオと同じ投稿。違いは初動のupvote速度とコメントの質）

### 反応

**Phase 1（0-1時間）**: 30+ upvotes。フロントページ上位に一気に到達。

**Phase 2（1-6時間）**: 200+ upvotes。トップ5に入る。コメント80件超。Twitter/Xで「Show HN」経由のシェアが始まる。

**Phase 3（6-24時間）**: 500-800 upvotes。GitHubでトレンド入り（TypeScript部門）。star数が1日で500+増加。

**Phase 4（2-7日目）**: 累計800+ upvotes。dev.to/Zennで解説記事が自然発生。npm DLが週1,000を超える。

**バイラルコメント**:

> "I've been thinking about this problem for months. The current approach to AI memory is wrong — we're treating AI like a database when we should be treating it like a student. Students don't memorize every fact; they learn principles from failures. That's exactly what this does."
> 234 points

> "Just deployed this across my team's 12 projects. After one week, our AI stopped suggesting `var` in TypeScript files, stopped ignoring our ESLint config, and stopped creating files in the wrong directory. The consolidation report is fascinating — it extracted 4 principles from 200+ entries."
> 178 points

> "The author's dogfooding data is what sold me. 508 real failures across 8 real projects, compressed into 7 principles. This isn't a toy — it's a tool built by someone who uses AI coding agents harder than almost anyone."
> 156 points

> "@dang: Can we get the author to do an AMA? The concept of 'behavioral learning for AI agents' deserves a deeper discussion."
> 89 points

**Reddit r/MachineLearning** (200 upvotes):
> タイトル: "Interesting approach to AI agent behavioral learning: auto-consolidating failures into principles"
>
> トップコメント (ML researcher): "This is essentially online meta-learning applied to coding agents. The principle extraction from failure examples is reminiscent of curriculum learning. Would love to see a paper on the consolidation algorithm."

### なぜ大成功するか
1. 「AI self-improvement」の哲学的議論がHNの知的好奇心にヒット
2. チーム導入の実例コメントが「使える」証拠を提供
3. ML研究者コミュニティからの学術的関心が信頼性を付与
4. 「CLAUDE.md 200行問題」がClaude Codeユーザーの共有ペインとして拡散
5. 投稿タイミング（US西海岸の火〜木曜朝9時）が完璧にハマる

---

## 分岐ポイント

| 分岐 | 条件 |
|------|------|
| 大失敗 → 失敗 | タイトルに「MCP」「memory」を入れない。数字で導入する |
| 失敗 → 成功 | **multi-LLM対応が完了している**。Gemini批判がコメントを支配しない |
| 成功 → 大成功 | 初動1時間で30+ upvotes。哲学的議論が自然発生する |

**最大のレバレッジポイント**: Show HNのタイトル設計。数字リード × ストーリー × 「reflection/learning」フレーミング。

---

*作成日: 2026-03-04*
