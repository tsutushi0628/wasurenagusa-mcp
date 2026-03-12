# wasurenagusa — AI Tool Community 反応シミュレーション
シミュレーション日: 2026-03-04
視点: AI Tool Community（MCP開発者、AI coding agentユーザー、Awesome MCP List管理者）

---

## 前提整理

**プロダクト特性**:
- AI coding agentの失敗自動検知→原則統合→セッション注入のMCP server
- OSS / MIT / npm公開
- ドッグフーディング: 508 dont→7原則、788KB→3KB

**AI Tool Community環境（2026年3月時点）**:
- MCP登録サーバー: 8,600+。Memory カテゴリは最も競争が激しいカテゴリの一つ
- 評価基準（コミュニティの暗黙知）:
  1. **セットアップ時間**: 5分以内でなければ試用すらされない
  2. **LLMプロバイダ**: 特定LLM縛りは即脱落要因（評価者の40-60%が離脱）
  3. **初回の「おっ」体験**: 効果を実感するまでの時間が鍵
  4. **Awesome List掲載**: awesome-mcp-servers に載るかどうかが認知の分水嶺
- 主要競合の現状:
  - @modelcontextprotocol/server-memory: 公式、71K weekly DL、基本KV store
  - Memorix: 154 stars、4K weekly DL、9エージェント対応
  - claude-mem: ~32K stars、Claude Code特化

---

## 大失敗シナリオ（awesome-mcp-serversに載らない、試用ゼロ）

### 反応

**Awesome MCP List PR**:
> PR提出 → メンテナーからコメント:
> "Thanks for submitting. However, we already have 12 memory-related servers listed. Can you clarify what makes this different from existing entries like server-memory or Memorix?"
>
> → 差別化説明が不十分 → PR放置 → 60日後にstale closedされる

**MCP Discord**:
> 告知投稿にリアクション2件（thumbs up）。質問ゼロ。

**理由**:
1. セットアップが10分超（APIキー取得→env設定→MCP登録→Hook設定の4ステップ）
2. Gemini専用で評価者の60%が脱落
3. READMEが機能一覧型で「何が嬉しいのか」が伝わらない
4. 既存のmemory MCPとの差別化が不明確

---

## 失敗シナリオ（awesome-listには載るが試用が続かない）

### 反応

**Awesome MCP List**:
> PR承認。「Memory」カテゴリの13番目として掲載。
> 掲載後1週間のGitHub star増加: +20

**MCP Discord**:
> "Interesting concept. Tried to install it but got stuck at the Gemini API key step. I use OpenAI for everything. Will check back when multi-LLM support is added."
> リアクション: 5

> "The dont consolidation feature is unique. But the effect takes weeks to show. By then I've already forgotten I installed it."
> リアクション: 3

**GitHub Issues**:
> #1: "Support for OpenAI / Anthropic API" (8 upvotes)
> #2: "Setup is too complex" (5 upvotes)
> #3: "First-time experience: nothing happens until I've used it for a week?" (3 upvotes)

**予測指標**:
- GitHub stars: 50-80（1ヶ月後）
- npm月間DL: 100-200
- アクティブユーザー（週1回以上起動）: 10-20人

**理由**:
1. awesome-list掲載で認知はされるが、Gemini縛りで試用率が低い
2. 蓄積型の効果は「初回の'おっ'体験」がなく、定着しない
3. 競合（server-memory）がシンプルすぎて「これでいいや」で済まされる

---

## 成功シナリオ（カテゴリ内でトップ5入り）

### 反応

**Awesome MCP List**:
> PR承認。差別化の明確さからFeatured（★マーク付き）で掲載。
> 掲載後1週間のGitHub star増加: +150

**MCP Discord**:
> "OK so I've been using wasurenagusa for 2 weeks now. The consolidation just ran and it extracted 5 principles from my 89 'dont' entries. One of them is 'always check if the target file exists before attempting to edit it' — which is EXACTLY the mistake my AI keeps making. This is legit."
> リアクション: 28

> "The comparison with CLAUDE.md is eye-opening. I had 300 lines in my CLAUDE.md and Claude was ignoring half of it. wasurenagusa consolidates everything into 5-7 principles that actually fit in the context window. Game changer."
> リアクション: 19

**GitHub Issues**:
> 建設的なIssueが増加:
> #1: "Feature request: export consolidated principles to CLAUDE.md format" (12 upvotes)
> #2: "Support for team-shared principles" (8 upvotes)
> #3: "Integration guide for Cursor" (6 upvotes)

**YouTuber/Blogger**:
> 2-3人のAI tool reviewerが「wasurenagusa試してみた」記事/動画を公開。
> 「Memory MCPの中で唯一『学習』してくれるツール」として紹介。

**予測指標**:
- GitHub stars: 300-800（3ヶ月後）
- npm月間DL: 500-1,000
- アクティブユーザー: 50-100人
- awesome-mcp-servers内のmemoryカテゴリでtop 3に定着

**理由**:
1. multi-LLM対応で試用障壁がゼロ
2. 2週間後の「統合レポート」が「おっ」体験を生む（遅延型だがインパクト大）
3. CLAUDE.md 200行問題のソリューションとして認知される
4. 「memory」ではなく「learning」ツールとしてカテゴリが再定義される

---

## 大成功シナリオ（Memory MCPカテゴリの代表格に）

### 反応

**Awesome MCP List**:
> メンテナーがREADMEのトップセクション「Highlights」にwasurenagusaを追加。
> 「The most starred memory server with behavioral learning capabilities」として特記。

**MCP公式ブログ/ニュースレター**:
> 「Community Spotlight: wasurenagusa — Teaching AI agents to learn from mistakes」
> として公式チャネルで紹介される。

**エコシステム影響**:
> - server-memoryの次バージョンに「consolidation」機能のRFCが提出される（wasurenagusa inspired）
> - Memorixが「wasurenagusa-compatible dont format」を採用
> - 新しいMemory MCPがREADMEで「Unlike wasurenagusa, we focus on...」と比較対象として使われる

**コミュニティ評判**:
> "If you're using Claude Code seriously, wasurenagusa is basically mandatory. The difference between 'AI that remembers' and 'AI that learns' is night and day."
> — AI tool reviewer（フォロワー50K）

**予測指標**:
- GitHub stars: 2,000-5,000（6ヶ月後）
- npm月間DL: 3,000-10,000
- アクティブユーザー: 500-1,000人
- Memory MCPカテゴリのデファクトリーダー

**理由**:
1. 「dont consolidation」が他MCPに影響を与え、エコシステムの標準になる
2. 公式チャネルからの推薦が信頼性と認知度を一気に押し上げる
3. 「wasurenagusa = AI behavioral learning」のブランド連想が確立

---

## 分岐ポイント

| 分岐 | 条件 |
|------|------|
| 大失敗 → 失敗 | awesome-mcp-servers PRに明確な差別化説明を添える |
| 失敗 → 成功 | **multi-LLM対応完了** + 「初回'おっ'体験」の設計（サンプルデータ or 初回統合の早期実行） |
| 成功 → 大成功 | dont formatのプロトコル化 + 公式チャネルからの認知 |

**最大のレバレッジポイント**: 「初回の'おっ'体験」のタイミング設計。蓄積型ツールの宿命として、効果実感まで2-3週間かかる。これをどう短縮するか（サンプルデータでのデモ、初回セッション後の即時統合、ダッシュボードでの可視化等）が定着率を決める。

---

*作成日: 2026-03-04*
