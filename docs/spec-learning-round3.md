# 学習化ラウンド3設計: 個別の注意を原則にまとめ、効き目で強弱をつけ、確かめた原則を Jev へ降ろす

対象: wasurenagusa-mcp の訂正ループ（ラウンド2 本番反映済み、schema v12）と、降ろし先 firebase-kit の Jev 知識カード。実装: Codex（1タスク1変更）。前ラウンド正本 `docs/spec-improvement-round2.md`（節5 本番反映・止め方、節4 の検証コマンド書式は本書でも有効。矛盾時は本書を優先）、`docs/spec-owner-correction-loop.md`（hook 契約）。経緯 `docs/findings/worklog-20261004-owner-correction-loop.md`（10/07 の2行）。本書はAIだけが読む。発話の生文は転記しない、件数・hash・合成文だけ。個人ホームの絶対パスは書かない。

## 0. 先頭1行

**目指す姿（オーナー 10/07）**: Wasurenagusa＝オーナーのパートナーとして洗練され続ける仕組み。言われた注意を覚えるだけでなく、言われる前に察し、効いたかを自分で確かめ、外れたら直し、使わなくなった癖は手放す。全タスク・合格基準はこの1行に照らして判断。レビュー観点も同じ（「オーナーのパートナーとして洗練され続けられる設計か」）。

ラウンド2 は 10/07 本番反映済みだが、評価「0/19」は測定器の構造値（空DB起点・再発定義に訂正判定なし・project を firebase-kit 固定）で、初見会話への効き目は未測定。本番実値（10/07 読取）は confirmed 1・candidate 105・disputed 7・rejected 1、injections 0行、violations 0行。ラウンド3 は先に測定器を直して before を固定し、次に規則文の壊れ・束割れ・反応形の取りこぼしを直し、そのうえで原則への抽象化・強度の上下・Jev への降ろしを足す。オーナー裁定（10/07）で2点を置き換え済み: e 類（「Codex活用して」型の反復指図）は規則にせず、Codex 枠を見た経路選択と AI どうしのレビュー往復の暴走停止で効かせる（節2.4）。抽象化の LLM は Luna Max（Codex）を夜間に1晩1回だけ呼ぶ（節2.1）。

## 1. 実態調査

### 1.1 構想と対応づけ

- 速い直感役 = Jev（firebase-kit の hook 群。依頼文から役・モデルを即判定、知識カードを差し込む）。熟考役 = wasurenagusa（記憶つき、会話記録を振り返って訂正を検出・保存）。熟考役が学んだ原則を直感役へ降ろす。オーナー承認済み（10/07）。
- 3本柱: ①抽象化（個別の注意・反応形 → 原則、初見の場面にも当てる）②強弱（効いた／守られなかった実績で強度を上下、使われない規則は弱める）③降ろし（何度も確かめた原則を Jev へ渡し、毎回の検索なしで効かせる）。
- 本書は設計だけ。実装・本番反映は別途オーナー y/n。

### 1.2 評価「0/19」の分解（一次、10/07 data-analyst）

| 項目 | 実測・所在 |
|---|---|
| 評価再生は空 DB 起点 | `scripts/replay/lib/simulate-engine.mjs:1708`（coverage ごと）・`:2356`（hook-timing）が `initializeBlankStore` で毎回空ストア。調整側の確定束が評価へ入らない → 初見への汎化は未測定 |
| 「再発」の定義 | `createReplayOccurrenceRows`（`:1035` 以降、`counts.get(label) < 2` で skip）= テーマ regex の2回目以降。訂正判定なし |
| project 固定 | `SOURCE_PROJECT = "firebase-kit"`（`:29`、使用 `:1292` `:1850` `:2010`）。実作業は legaltech-lab 6 ほか。`scripts/replay/lib/session-project.mjs`（ラウンド2 T3b）は存在するが再生に未接続 |
| scratch の schema | `initializeBlankStore`（`:1031`）は `CORRECTION_SCHEMA_VERSION !== 11` で throw、v12 の `owner_correction_violations` を作らない。強弱の再生には v12 化が要る（`src/storage/migration.ts:618` `migrateV11ToV12` あり） |
| 未来漏れの罠 | 持ち越し再生を作るとき、`retrieval.ts:301-302` は `expires_at` だけで絞り `confirmed_at` を見ない。評価 event より後に確定した束が見える恐れ |

19件の内訳（手分類、以後「分解」+記号。漏斗の (a)(b)(c) とは別物）:

| 分解 | 件数 | 中身 | 真の再発か |
|---|---:|---|---|
| a 言い回し違い | 6 | 同じ趣旨の別の言い回し。うち5件が頼る束 `oc:v2:e2b0dbcc` は規則文が「言葉を使わない」で、根拠の「変な／俺のわからない」が落ちて壊れている。1件は「だけ」未解析で condition_key が割れ束分裂（`oc:v2:5a11b088` と `oc:v2:b14f5594`）。反応形（「いみわからん」）は検出器が訂正と見ない | 再発 |
| c 初出 | 1 | 母集団に先行発話なし | 再発でない見込み（台帳 T5 で確定） |
| e 反復する指図 | 5 | 「Codex活用して」「Astra/Fableにレビューさせて」型。調整側 17・20 session | 再発でない（裁定済み: 指図の反復は訂正でない）。分母から除く。効かせ方は節2.4 |
| x 測定器の誤爆 | 7 | テーマ regex の当たり外れ | 再発でない |
| b・d | 0 | | |

- 真の再発 = a6（c が再発なら 7）。e・x・（c が初出なら c）は分母に入らない。分母が小さいので、汎化の主張は評価37 session ではなく封印した新規母集団（節2 H2）で行う。評価37 session は分解で中身が見られた = 調整に使えない（回帰専用に格下げ）。
- 「初見に効かない」の機構: 配送は SessionStart の索引・毎発話の関連検索・再注入で、言い回し照合ではなく束単位。したがって言い回し違いは「束がまだ作られていない」か「束が壊れている／割れている」で落ちる。原則単位で束ねれば、別の言い回しも同じ束の根拠になり、配送は原則に対して1回で済む。

### 1.3 本番 DB と現行コードの実測（読取専用、`sqlite3 "file:<path>?immutable=1"`、10/07）

- `owner_correction_bundles`: candidate 105（unknown 61・verification 16・model_routing 7・delegation_roles 6・document_delivery 6・storage_location 3・response_policy 2・summary_constraints 2・design_components 1・tone 1）、confirmed 1（verification、intensity 4）、disputed 7、rejected 1。
- `owner_correction_injections` 0行、`owner_correction_violations` 0行。schema_version 12。
- 強度は上がる一方: `store.ts:636` `calculateIntensity`（根拠 score から 1〜5）、`store.ts:996` `Math.max(bundle.intensity, calculateIntensity(...))`。下げる経路なし。順位は `retrieval.ts:318,363` `ORDER BY b.intensity DESC`。
- 強度の目盛り: 束 `intensity` は 1〜5（`correction-schema.ts:107` CHECK）。束の確定時に作る dont 記憶は `intensity: bundle.intensity`（`store.ts:573-583` `restoreOrSaveMemory`）で同値コピー。記憶側は 1〜10、手動ピン留め 6 以上（`updateIntensity.ts`）。設計判断: 束 intensity が正、記憶は同値コピーのまま（相関記憶は 1〜5 帯に収まり、手動ピン 6 以上が常に上位）。目盛りを変えない。
- 違反検査は3種のみ（`src/corrections/compliance.ts`: tone・document_delivery・expression_policy）。「注入後に守られなかった」の直接信号は少ない。代わりに決定論で取れる信号 = 注入済みの束に、注入後の同 session で新しい根拠（evidence）が付く = オーナーが注入にも関わらず言い直した。
- LLM 基盤の現況: 訂正ループの hook 内 LLM 呼出は 0 が契約（`correction_llm_call` カウンタ）。Stop の LLM 分析（`WASURENAGUSA_STOP_LLM`）は off 維持。夜間に LLM を呼ぶ既存経路はない。オーナー裁定（10/07）で抽象化に使う LLM は Luna Max のみ = Codex の `gpt-6-luna`・推論 max（`~/.codex/config.toml` 既定、`firebase-kit/.claude/refs/codex.md:36`）。Codex の非対話呼び出しは `codex exec`（`--sandbox`・`-C`・`-o/--output-last-message`・`--skip-git-repo-check`・`--ephemeral`、PROMPT は引数か stdin。`codex exec --help` で確認）。実装委譲の正規ラッパー `.claude/fusion/codex-task--run--with-rules-and-worklog.sh` は実装委譲専用（`refs/codex.md:11`）で、常に `--write` を渡し（ラッパー `:741-743`）、規約を前置きし、`<CD>/docs/findings/codex-worklog.md` へ追記し、必須3欄が無いと exit 10（`refs/codex.md:26`）、`--role` は `agents/*.md` の実在名のみ（ラッパー `:117-146`）。読取だけの夜間バッチには使わない。

### 1.4 Jev 側の接点（firebase-kit/.claude/hooks/ を実読）

| 接点 | 実体 | 降ろし先として |
|---|---|---|
| 知識カード | `jev-knowledge.json`（version 1、21枚）。1枚 = `id`・`scene`・`triggers`・`exclude_patterns`・`types`・`main`・`pinned`・`knowledge[]`・`evidence_ids`（wasurenagusa の記憶 ID）・`count`・`last_seen` | 本命。降ろす原則 = カード |
| 差し込み（オーナー発話） | `advise.py:911` `_owner_knowledge` → `jev_knowledge.cards_for_prompt`（`main:true` かつ `triggers` の部分一致、`exclude_patterns` で除外、上限 `MAX_CARDS=5` + pinned 全部） | 場面が引き金語で特定できる原則はここで効く。hook 内で DB を引かない |
| 差し込み（Agent 招聘） | `advise.py:901` `_agent_knowledge` → `cards_for_type`（`types` 一致、司令塔は空） | サブエージェントへ届く唯一の経路。wasurenagusa の注入はサブへ届かない |
| 生成元 | `hooks/scripts/extract-jev-knowledge.py`（`CARD_DEFINITIONS` 手定義 + `knowledge_override` + `pinned`）、材料は `rank-dont-clusters.py`（`category='dont' and state='active'` の記憶を trigram Jaccard で束ねる） | 既に wasurenagusa の dont を材料にしている。束 `owner_correction:*` の dont 記憶も同じ表に入るが、確定・強度・実績を見ず、手定義カードのみが出る |
| 割当（役・モデル） | `assignment-catalog.json`（38型、`route` A=30／C=8、`model_by_band`、`effort_by_band`）、`model-tier-map.json`（`pinned_model_roles`・`codex_roles`・`reviewer_model`）、`codex-launch-map.json` | 節2.4(1)「Codex 先行」の接点。`route` を枠に応じて A から C へ切り替える（`jev_assignment.py:337` `_finalize`、`advise.py:1602` `_assignment_pretool_output`、`advise.py:103` `ASSIGNMENT_CODEX_ROUTE="C"`） |

- 範囲の限定: ③の firebase-kit 側は「`extract-jev-knowledge.py` の取込口追加 + `jev-knowledge.json` 再生成 + テスト」まで。「引き金語を持たない常時系の原則」（例: 知らない言葉を使わない）を差し込むには `jev_knowledge.py` に `always` カードの扱いが要る（`cards_for_prompt` はこのファイル内なので `advise.py` は不変）。③（降ろし）の取込では `advise.py`・`assignment-catalog.json`・`model-tier-map.json` を触らない。節2.4 の2本（T16 経路選択・T17 レビュー停止）だけが `jev_assignment.py`・`assignment-catalog.json`・`advise.py`・`action_guard.py` を触る。firebase-kit は全 session の hook を担うため、自動書込はしない（wasurenagusa は提案ファイルを出すだけ、取込と commit は firebase-kit 側の通常手順）。
- 静的文面の限界: 知らない言葉の規則は CLAUDE.md の文体節にも既にあり、それでも 47 件再発した（ラウンド2 節1.2 R3）。カードに降ろしても同じ運命の恐れ。だから卒業条件を「注入して守られた実績」に置き、卒業後に言い直しが出たら取り消す（節2 ③）。

### 1.5 既存資産の棚卸し（firebase-kit/backend は不使用: MCP + SQLite で Firebase 無関係）

| 区分 | 資産 |
|---|---|
| そのまま使う | `bundle-key.ts`（`diceCoefficient`・`haveSameBundleKey`、束ねの類似度）／`store.ts` `cancelCorrectionBundle`・`restoreOrSaveMemory`／`injection-policy.ts` の restore 経路・冷却・予算 800 tokens／`compliance.ts`／`observability/correction-metrics.ts`（`correction_llm_call`）／`cli/scheduler-setup.ts`（launchd、深夜実行）／`scripts/replay/repeat-classes.mjs`（13クラス測定器、before 122/12日）／`session-project.mjs`／`make-manifest.mjs`／`cli/correction-import.ts` の `--migrate-v12` の形／`jev_knowledge.py`・`extract-jev-knowledge.py`・`jev-knowledge.json`／firebase-kit: `action_guard.py:581` `judge_summarizer_spawn`（招聘回数の上限と state ファイルの前例）・`hooks/state/report-length-guard-shadow.jsonl`（shadow 運用の前例）・`advise.py:1264` `_is_codex_launch_command`・`jev_assignment.py:337` `_finalize` |
| 拡張する | `simulate-engine.mjs`（online モード・project 配線・台帳つき再発・v12 化）／`rule-template.ts`・`detector.ts`・`bundle-key.ts`（修飾語保存・「だけ」・反応形）／`store.ts:996`（強度の式）／`retrieval.ts`・`injection-policy.ts`（原則の構成員を二重注入しない）／`correction-schema.ts`・`migration.ts`・`correction-import.ts`（v13）／`extract-jev-knowledge.py`（卒業提案の取込）／`jev_knowledge.py`（`always`、任意）／firebase-kit: `assignment-catalog.json`（`codex_first` 項目）・`scripts/assignment-catalog-check.py`・`action_guard.py`（判定8）・`advise.py`（枠通知、指摘の記録） |
| 新規 | `src/corrections/principles.ts`、`src/cli/abstract-principles.ts`、`prompts/` 配下の抽象化プロンプト、`src/corrections/strength.ts` と `src/cli/strength-job.ts`、`src/corrections/graduation.ts` と `src/cli/graduation-export.ts`、再発台帳（`.wasurenagusa/reports/ledger/`、gitignore 配下）、firebase-kit: `hooks/lib/codex_quota.py`・`hooks/scripts/codex-quota.py`（Codex 枠リーダー）・`hooks/state/review-loop/` |

### 1.6 e 類が指す仕組みの実態（firebase-kit/.claude を実読、10/07）

- Astra = Codex の設計・文章用モデル `gpt-6-astra`。根拠: `hooks/model-tier-map.json:36-38`（`codex_design_models`）、`hooks/advise.py:1387`・`:1449`（設計判断を含む依頼は gpt-6-astra を検討、実装役での起動は「不足」判定）。呼ばれる経路は3つ: (1) Bash で `codex exec --model gpt-6-astra` を直接（`agents/technical-writer.md:16`、`agents/report-writer.md:35`、`skills/lab-detail-write/SKILL.md:78`）、(2) 要約ランナーの書き手 `astra-xhigh`（`fusion/summarize--call--gated.py:17,29`）、(3) ChatGPT ウェブ版の GPT-6 Astra を CDP 経由（`skills/chappy/scripts/chatgpt--ask--via-cdp.mjs:16`、枠はウェブ版で Codex CLI とは別）。
- 他のレビュー役: Claude 側は `-reviewer` 名の Agent（`model-tier-map.json:9,11` で `reviewer_model: fable`）と独立点検の型 a22〜a24（`assignment-catalog.json`、fable）。Codex 側の第三意見は `--model gpt-6.1-sol --effort xhigh`（`refs/codex.md:38` 以下「レビュー依頼時のモデル」）。
- レビュー往復の既存の制御: `refs/gates.md:7` の散文「同一課題3回差し戻しでオーナーへエスカレーション」だけ。機械的な上限・停止はない。招聘回数を数えて止めるコードの前例は要約役だけ（`hooks/lib/action_guard.py:581` `judge_summarizer_spawn`、state は `hooks/state/summarizer-spawns/<session>.json`、`evaluate` は `action_guard.py:920`）。
- Codex 枠の既存の確認: `turn-reminder.md:12`「Codex枠状況は常に確認。応答に出すのは枠切れか残り2%以下のときだけ」は AI への指示文で、枠を読むコードは firebase-kit に0件（`used_percent`・`rate_limits` の grep で該当なし）。Codex 自身が書く記録が接点: `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl` の `token_count` イベントの `payload.rate_limits`（`primary.used_percent`・`primary.window_minutes`・`primary.resets_at`、`secondary`、`plan_type`、`rate_limit_reached_type`）。実測の形（10/07 の rollout）: `window_minutes:10080`（週）、`secondary:null`、`plan_type:"pro"`。
- 枠の実測（9/30〜10/07、pro の週窓、62,247 イベント）: 使用率は 0〜100 を往復する（実際に使い切る水準）。1時間あたりの増分は p50 1pt・p90 14pt・p99 73pt・最大 85pt。契約形態が変わった履歴がある（9/22 時点は plus の「5時間窓 + 週窓」、のち prolite・pro の週窓のみ）。したがって読取は窓の種類・本数に依存せず、`resets_at` が現在より後の窓の `used_percent` の最大を使う。窓が更新済み（`resets_at` が過去）なら使用 0 とみなす。
- オーナー裁定（10/07、趣旨）: 「Codex活用しろ」を決まりにしても AI は守らない。オーナーはどの AI にどれだけ枠があるか確認しながら指示している。Codex の枠があるときは Codex から使う。AI に Astra レビューをさせると無限ループして枠を使い切ることがある、それを止める。

## 2. 採用する改善（優先順）と採らない案

物差し: オーナーの目から見た、同じことを言う回数の減少。測定器を直すのが先（before の固定が改善より前）。

| 順 | 改善 | 効く段 | 見込み |
|---|---|---|---|
| L0 | 測定器: v12 scratch・project 別・持ち越し再生（時刻順 online）・台帳つき再発・封印した新規母集団 H2 | 測り方 | 分母の 7/19 が誤爆と判明済み。before を正しい形で固定 |
| L1 | 規則文の根拠保存（修飾語脱落）／「だけ」で束が割れない／反応形の検出 | 検出・確定 | 分解a 6件のうち5件が頼る壊れ束と1件の束分裂を解消 |
| L2 | 抽象化: 同趣旨の束・候補を原則1束へ | 確定・配送 | 言い回し違いが同じ束の根拠になる。単独では候補止まりの3言い回しが原則では3 session 根拠で確定 |
| L3 | 強弱: 注入後も言い直された束は上げ、使われない束は下げる | 配送の順位 | 予算 800 tokens の取り合いを実績順にする |
| L4 | 降ろし: 守られた実績のある原則を Jev カードへ | 配送・サブ | hook 予算を空け、サブエージェントと場面引き金へ届く |
| L5 | Codex 先行の経路選択（枠が残っているときは Codex から） | 配送（経路） | R7（モデル指図の同報）17件/12日の言い直しを、規則でなく経路で減らす |
| L6 | AI どうしのレビュー往復の暴走停止 | 枠の保護 | 同一成果物のレビュー無限ループによる枠切れを止める |

### 2.1 ① 抽象化（L2）の設計

置き方: 原則 = 既存の `owner_correction_bundles` の1行（`bundle_key` 接頭 `pr:v1:`）。束表に乗せるのは、versions・injections・violations・cancel・dont 記憶（`restoreOrSaveMemory`）の外部キーと機構をそのまま使えるため。構成員との対応だけ新表 `owner_correction_principle_members`（v13）。束表の列は増やさない。

LLM 設計原則（`firebase-kit/.claude/refs/llm-design.md`）への適合:

1. システム化優先: コードが全部やる = 材料集め（status が candidate／confirmed、visibility が owner になりうる topic、同 polarity）、群の作成（`diceCoefficient` ≥ 0.5 または `requiredValuesKey` 共有で連結成分、1群 10件まで）、session 重複除去（同一分・同文は1回扱い。ラウンド2 T4 の規則）、閾値（群に束 ≥2・別 session ≥3・正規化文が2種以上）、採用・保存・取消・形式整形。
2. LLM の責務は1つだけ: 各群（1晩 ≤20群）の規則文 ≤10本を読み、「全部同じ趣旨か。同じなら全員に当てはまる1文の原則に言い直す。違う趣旨が混ざるなら混ざった番号を返す」。意味判断のみ。件数・順位・確定は触らない。
3. プロンプト本文 ≤100行（目標40行、データ投入ブロックは除く）。出力は JSON 配列 `[{group_id, verdict:"merge"|"none", principle:string, odd_ids:number[]}]` のみ。後から来た候補束の「既存原則に属するか」も同じ1呼出の中の群として入れる。
4. 出力ガードは入力との差分で組む: (i) 原則文の内容語（漢字・カタカナ・英数字の2字以上の連なり）は全て、構成員の規則文の和集合に部分文字列として存在する。無い語を足したら不採用。(ii) 原則文の極性を既存の極性判定（`rule-template.ts`／`detector.ts` にある極性抽出。関数名は T9 着手時に確認）で測り、構成員の極性と一致。(iii) 長さ ≤120字。ゲートは throw でなく不採用 + 理由コード記録（ガード不採用は LLM 責務を阻害しない warning 級、`llm-design.md` 原則4）。
5. 実行場所と呼び方: 深夜の scheduler バッチだけ。hook 内では呼ばない。**1晩1回、全群を1プロンプトにまとめて Luna Max へ1呼出**（オーナー裁定）。呼び方は `codex exec --sandbox read-only --skip-git-repo-check -C <空の作業ディレクトリ> -o <出力ファイル> -`（プロンプトは stdin）、`-m`・推論は指定せず `~/.codex/config.toml` 既定の gpt-6-luna・max に任せる（`refs/codex.md:36`: max は config.toml 既定でのみ効く）。`--ephemeral` は付けない（rollout が残らないと枠の前後差が測れない）。正規ラッパーを使わない理由は節1.3。**Codex 枠が少ない日は飛ばす**: 呼出前に枠リーダー（T10）で残りを読み、残り 30% 未満・枠切れ・観測不能のいずれかなら呼ばず、群は翌晩へ持ち越す。30% は、夜間バッチは1日待てる任意の仕事でオーナーの実作業と枠を取り合うこと、オーナー確定の「枠なし」線が 2% であること、1晩の消費は T11 で実測して上限 3pt（週枠）に収めることから、実作業側に十分な余裕を残す値として置く。呼出は `correction_llm_call` で計数（1晩 ≤1）。失敗は operation log に1行・非0終了（握りつぶさない、同夜の再試行なし）。hook には影響しない。
6. 3段階: `WASURENAGUSA_PRINCIPLES=off|shadow|on`。既定は shadow（原則を `candidate` で保存し注入しない）。replay（T18）で通ってから on。

原則の確定と配送:

- 原則は構成員の根拠の別 session 合計（同報除外）≥2 で確定。単独では候補止まりの言い回し3つが、原則では確定になる。これが「学ぶ」の中身。
- 原則が confirmed の間、構成員は注入から除く（二重注入防止）。原則を取り消せば（`cancelCorrectionBundle`）構成員が復帰。
- 後から来た初見の言い回し: 新しい候補束は通常どおり作られ、深夜バッチが「既存原則に属するか」を LLM で判定（同じガード）して構成員に追加。属した時点で原則の根拠に加わる。ただし初見の session 内の効き目は、追加を待たずに効く（原則は SessionStart から言い回しに関係なく配送済みのため）。ここが初見への汎化の機構。
- visibility: 構成員がすべて owner 可視 topic（ラウンド2 T6 の `OWNER_VISIBLE_TOPICS`、`unknown` は素文適格 negative のみ）のときだけ owner。1つでも project 限定なら原則は作らない。

### 2.2 ② 強弱（L3）の設計

強度 = 予算が足りないときの配送優先度。1〜5、束 intensity が正。

| 信号 | 取り方（決定論、SQL） | 作用 |
|---|---|---|
| 守られなかった（上げ） | 束に body つき注入（`owner_correction_injections` の `body_included=1` かつ `stdout_status='emitted'`）があり、同 session でその注入より後（`human_ordinal` が大）に同束の根拠 event が付く。または `owner_correction_violations` の行 | +1（上限5、同束で3日に1回まで）。再注入の対象順にも効く |
| 効いた（保護） | body つき注入のあった session が ≥5・別日 ≥3 で、直近5注入に守られなかった信号 0 | 強度は動かさない。使われない判定の時計を戻し、卒業候補（settled）にする |
| 使われない（下げ） | 21日間、`trigger='prompt'` の body つき注入 0 かつ根拠 0 かつ violation 0（SessionStart だけの配送は「使われた」に数えない） | −1（21日ごと、下限1）。取り消しはしない（期限切れは既存の寿命規則） |

- 式の変更: `store.ts:996` の `Math.max(bundle.intensity, calculateIntensity(...))` をやめ、`intensity = clamp(calculateIntensity(根拠) + 強度イベント(owner_correction_strength_events)の delta 合計, 1, 5)` に。根拠が増えても調整が消えない。`freshRoutingCycle` は調整を引き継がない。
- 実行: 深夜のバッチ `strength-job`（`--now` を注入できる形。replay が日付を進めて回す）。hook は保存済みの intensity を読むだけで処理増なし。`WASURENAGUSA_STRENGTH=off|shadow|on`（shadow = 計算して log へ、反映しない）。
- 採らない案: 「効いた」で上げる。守られた規則がみな 5 に張り付き、識別力が消える。「守られなかった」で下げる。守られていない規則こそ強く届ける必要がある（ラウンド2 T9 の再注入と同じ向き）。

### 2.3 ③ 降ろし（L4）の設計

- 卒業条件（`graduation.ts`、コードのみ）: 原則または束が confirmed・visibility owner・lifetime が `explicit_continuing` または `inferred`（`task`・`routing` は不可）・settled（節2.2 の効いた）・確定から ≥7日・卒業後の取消根拠なし。
- 配送の形（コードが決める。LLM 不使用）: 引き金語を取れる原則 = `delivery:"scene"`（`triggers` は構成員の `requiredValues`・topic 語から決定論で作る、`exclude_patterns` は構成員の否定形から）。取れない常時系 = `delivery:"always"`。
- 提案ファイル（wasurenagusa が書く。取込は firebase-kit 側）`.wasurenagusa/reports/graduation/proposal-<日付>.json`: `{schema:1, generated_at, source_head, principles:[{principle_key, rule_text, topic_key, delivery, triggers, exclude_patterns, types, evidence:{sessions, days, injected_sessions, failures_after_injection, violations}}]}`。7日を過ぎた提案は取込拒否。卒業を取り消した原則は次回の提案に載らない = 取込側が「卒業由来のカードを毎回全再生成」するので自動で消える。
- 取込: `extract-jev-knowledge.py --graduation <proposal>` が `g-<hash8>` の id でカードを作り、手定義カード（k01〜k22）は不変。出力は `--out` へ書き、差分を表示。反映は通常の commit 手順（オーナー確認）。自動書込なし。
- 差し込み量: 卒業カード分は1回の差し込みで ≤150 tokens、全体は既存の `MAX_CARDS=5` に従う。
- 卒業後の取消: 卒業した原則に新しい言い直し根拠が付いたら、`owner_correction_graduations.revoked_at` を立て、強度 +1、wasurenagusa の注入に戻す。
- wasurenagusa 側: 卒業中の原則は `prompt`・`refresh` 注入から外し（予算を空ける）、`start` は維持。
- 現実的な見込み: 現状 confirmed 1。卒業が実データで0件でも本ラウンドの合格とする（節3 A9）。抽象化で確定が増えてから効く。通しの確認は合成 fixture で行う。

### 2.4 e 類の置き換え設計（オーナー裁定 10/07）

e 類（指図の反復）は記憶の規則にしない。理由はオーナーの言うとおり、決まりにしても AI が守らないこと、そして指図の中身が「その時の枠の状況」に依存すること。効かせるのは2本、どちらもコード（hook）で、firebase-kit 側（T16・T17）。

(1) Codex 先行の経路選択（L5、T10・T16）

- 枠を読む: `hooks/lib/codex_quota.py`（T10）が Codex の rollout から最新の `rate_limits` を読み、`{remaining_percent, reached, resets_at, observed_at, stale}` を返す（読み方は節1.6）。観測がない・読めないときは「不明」。
- 経路選択: `assignment-catalog.json` の型に任意項目 `codex_first: true` を足す。Jev の割当が `codex_first` の型で、枠が残っている（残り >2% かつ枠切れでない）なら、割当を `route:"C"`・`gpt-6-luna`・推論 `max` に切り替える（`jev_assignment.py:337` `_finalize`）。以降は既存の Codex 経路の通知（`advise.py:1619` 付近）がそのまま働き、司令塔は正規ラッパーを使う。枠なし・不明・`codex_first` なしの型は現行の route A のまま。2% は、オーナーが確定した「枠切れか残り2%以下」と同じ線。実行中に尽きた場合は既存のフォールバック（`refs/codex.md:46`）が受ける。
- 初期の対象型（オーナー確認可、節6）: a07 確定設計の実施計画・a09 確定文面の置換・a10 作業記録の整形。a09・a10 の docs-clerk は既に「第一選択＝正規経路スクリプト、Codex の枠枯渇時のみ自身で直書き」と文書にあるのに守られていない型（`agents/docs-clerk.md:10`）。対象外にする型と理由: 調査・読取・QA・scm（`refs/codex.md:54` 据え置き: 実装モデルと別ベンダーで検品）、a36 外部サービス操作（`refs/codex.md:50`「Codex対象外: 認証必須の外部SaaS運用」）、a37 要約変換（要約ランナーが書き手の選択と枠の見積もりを自前で持つ、`refs/summarization.md:142-144`）、Fable の設計型（設計判断が目的）、独立点検型（別ベンダー点検が目的）。
- 枠の表示（オーナー確定規則の機械化）: 枠を応答に出すのは枠切れか残り2%以下のときだけ。hook が UserPromptSubmit で枠を読み、枠切れ・残り ≤2% のときだけ1行（「Codex枠: 枠切れ／残り X%、リセット M/D HH:MM」）をコンテキストへ足し、それ以外は何も足さない。通常時のトークン増は 0。

(2) AI どうしのレビュー往復の暴走停止（L6、T17）

- 前例どおり `action_guard.py` に判定8を足す（判定7 `judge_summarizer_spawn` と同型: PreToolUse で数え、上限で deny、state ファイルに残す）。
- 「レビュー起動」の決定論の判定: (a) Agent で `name` が `-reviewer` で終わる（`model-tier-map.json:9` の `reviewer_suffix`）、(b) Bash の Codex 起動（`advise.py:1256` `CODEX_LAUNCH_MARKERS`）で、招聘文／task-file に独立行 `レビュー対象: <成果物パス>` がある。独立行は既存の流儀（「要約ジョブ: <path>」「Fable使用: オーナー承認済み」）。レビュー起動なのに独立行がないときは数えず、通知で独立行を促す。成果物キーは独立行のパスを正規化した値（独立行なしは `name`／モデル＋役の hash）。
- 停止条件（成果物キーごと、レビュアーをまたいで合算、24時間動きがなければリセット。初期値は節6 で確認）:
  1. 回数: 同一成果物のレビュー起動が3回に達したら4回目を deny。値の根拠は `refs/gates.md:7`（同一課題3回でエスカレーション）に揃えた。Astra・Fable・Sol を交互にしても合算。
  2. 同一指摘: 直前のレビューの指摘のうち 80% 以上が今回の指摘と一致（指摘1行の正規化文の文字3-gram Jaccard ≥0.7 で対応づけ）したら、次のレビュー起動を deny。指摘は Agent なら `tool_response`、Codex なら `--output-last-message` のファイルから PostToolUse で記録する。読めなければ指摘の記録なし（回数の条件だけ効く）。
  3. 枠の急増: Codex モデルのレビュー起動だけに適用。(i) 同一成果物のレビュー起動前後の使用率の差の累計が 20pt（週枠）以上、または (ii) 直近60分の使用率の増分が 50pt 以上のとき、新しい Codex レビュー起動を deny（実装委譲は止めない）。(ii) の 50pt は節1.6 の実測（1時間増分 p90 14pt・p99 73pt）の間に置き、通常の実装日の p90 を超えない。Codex 枠が残り 2% 以下・枠切れなら Codex レビューは常に deny。
- deny 文: 「同一成果物のレビューが上限に達した（回数／同一指摘／枠急増のどれか）。オーナーへ指摘履歴を1行ずつ付けてエスカレーションする。続行はオーナーの許可後、招聘文に独立行『レビュー上限解除: オーナー承認済み』を入れる」。
- 運用: `REVIEW_LOOP_GUARD=off|shadow|on`。既定 shadow（`hooks/state/review-loop-shadow.jsonl` に「止めたはずの起動」を記録、deny しない。`report-length-guard-shadow.jsonl` の前例）。7日で誤停止 0 を確認してから on。ChatGPT ウェブ版の Astra（CDP 経由）は枠を読めないので回数と同一指摘の条件だけ効く。

(3) 測定上の扱い

指図の反復は訂正ではない。台帳（T4）で `klass:"e"` は `recurrence:"no"`、再発の分母に入らない（切替項目なし）。e 類の効きは replay でなく本番の R7 発話数（13クラス測定器、before 17件/12日 = 1.4件/日）で見る（節3 A12）。

### 2.5 採らない案と理由

- 毎ターン hook での LLM 判定・抽象化の hook 内実行: ラウンド2 の p95 超過（800ms 対 500ms）が未解決。LLM は深夜バッチのみ。
- 抽象化の結果の自動本番注入: shadow を挟み、replay で通してから on。誤合流は全 session へ広がるため。
- 構成員なしの LLM 作文原則（member 無しで原則を新規創作）: 根拠の差分ガードが効かない。必ず構成員の言い換えにする。
- Jev カードへの自動書込: 全 session の hook に効く設定ファイル。提案→取込→commit の三段にする。
- 既存 dont 363件の一括原則化: ラウンド2 の採らない案を維持（オーナーの確認作業増・題名注入で守られない実例）。原則化の対象は訂正ループの束だけ。
- 評価37 session の再利用: 分解で中身を見たので汎化の根拠に使わない（回帰専用）。
- 抽象化に Luna 以外のモデルを使う案: オーナー裁定で不採用（Luna Max のみ）。Luna で品質基準に届かないときは LLM 段を止め、決定論の L1 だけで出荷する。別モデルへの切替は新たな裁定事項。
- 抽象化を1群ずつ呼ぶ案: 夜間バッチは1晩1呼出（オーナー裁定）。群が多い日は上限（20群）を超えた分を翌晩へ。
- e 類を記憶の規則（24h routing の常設化、分母への算入）にする案: 不採用。守られない規則を増やすだけで、枠の状況は規則でなく枠そのものを読んだ経路選択で扱う。

### 2.6 母集団の取り扱い

- dev: `.tmp/codex-T10a/manifest.json`（archive firebase-kit 09-23〜10-05、121 session）。時刻順に1つのストアへ流す online 再生。調整に使う。
- H2: 最初の人間発話が 2026-10-08 00:00 JST 以後の session。10-06・10-07 は未使用（見られているので除外）。manifest は T18 まで作らない・中身を見ない・調整に使わない。台帳は T18 で system 出力を見る前に作る（盲検）。archive の日次取込（ラウンド2 T3）が動いていることが前提。
- H2 の終了: 台帳の再発 ≥40件、または 14日、早い方。14日で40件に満たなければ n を併記して報告。

## 3. 合格基準（測れる形）

before の欄は T5（dev）と T18（H2、同日に before=ラウンド3前 HEAD・after=ラウンド3後を同じ判定器・同 manifest・別 scratch で）で測る。閾値は本書で固定、結果を見て触らない（触ったら再生をやり直し、本書を改版）。T5 完了時に before 欄を埋めて commit。

| ID | 指標 | 測り方 | before | 合格 |
|---|---|---|---|---|
| A1 | 壊れた規則文 | 台帳 intent「分からない言葉」の束の `rule_text` が正規表現 `変な|わから|知らな` のいずれかを含む割合 | 0/1（実測。確定束 `oc:v2:e2b0dbcc` の規則文「言葉を使わない」） | 1/1。かつ合成 fixture 8本で修飾語が規則文に残る |
| A2 | 束割れ | 「だけ」の有無だけが違う2発話の束数。「だけ／のみ／しか／ばかり」差の合成8対 | 実データ 2 束（実測。`b4e2d144`（候補）／`b14f5594`（確定）。束キーは project を含み、調整のみ再生時の `5a11b088` とは別。合成8対は T7 で測る） | 実データ 1 束、合成 8対すべて同一束 |
| A3 | 反応形の検出 | 台帳 intent 内の反応形 event（「いみわからん」型）の候補化率／台帳で再発でない行の誤候補化率 | 反応形 19 event で反応形としての検出 0（証拠行あり 4 event は別 topic の request_repeat 3・tone 1）。再発でない行の誤候補化: 251 event 中 67（26.7%。source=utterance_detection に限ると 3＝1.2%、B2 の再発でない 12 event 中 2） | 候補化 ≥90%、誤候補化 ≤5% |
| A4 | 言い回し違いが防げた（dev 回帰） | 分解a 6件のうち漏斗 (a)(b)(c) を通る数（持ち越し online 再生） | 3/6（実測。防げた3件は言葉の反応形、止まり3件は (b) 未確定2件・(b) 確定が行動後1件。持ち越しなしでは 0/6） | ≥4/6 |
| A5 | dev の防げた率（台帳の再発。e・x は分母に入らない） | 持ち越し online 再生、project 別 | 13/61 = 21.3%（再測定。数え方修正後。旧 15/61（欠陥ある判定）は「防げた」扱いが2件多かった。B2〜B10。B1 の再発 16 件は別集計 0/16） | before + 20pt 以上 |
| A6 | 初見への汎化（H2） | 同上、H2。ラウンド3前 HEAD と後を同条件で | T18 | after ≥30% かつ before + 15pt 以上 |
| A7 | 抽象化の純度・安全 | 採用された原則の構成員が台帳の別 intent をまたぐ数／差分ガード違反で採用された数／構成員 ≥3 session・言い回し ≥2 の原則数／夜間バッチの Codex 呼出数／Codex 残り 30% 未満の晩の呼出数／hook 内 LLM 呼出／1晩の枠消費（呼出前後の使用率差） | – | 0／0／≥1（dev か H2 の再生で）／≤1回/晩／0／0／≤3pt（週枠） |
| A8 | 強弱 | 合成 suite（守られなかった +1、3日に1回、使われない −1・下限1、効いた = 動かさず時計を戻す、根拠増で調整が消えない、routing 再開で引継なし）。dev 再生の「注入後再訂正率」= 注入後に同束の根拠が付いた session 数 ÷ body つき注入のあった session 数 | 注入後再訂正率: 旧 3/72（欠陥ある数え方＝stale_version）→ 新 3/72 = 4.2%（再測定。数え方を直しても同値。HEAD 純粋ビルドは未来漏れで 7/111 = 6.3%） | suite 全通過、率 ≤ before × 0.7 |
| A9 | 降ろし | firebase-kit の pytest（`test_jev_knowledge.py`・`test_extract_jev_knowledge.py`・`test_jev_advise.py`）全通過／`hooks-selftest.sh --strict` 通過／合成 fixture の通し（提案→取込→カード→合成 prompt で差し込み）1往復／卒業カード分の差し込み ≤150 tokens／Jev 型判定 eval の型・モデル正答率が着手前と同値（API 鍵があるとき） | pytest 現行 | 全通過・差分 0。実データの卒業 0件でも合格 |
| A10 | ラウンド2 の不変条件 | UserPromptSubmit p95（replay hook-timing）／max／timeout／誤確定（再生の確定・原則一覧目視で振る舞い命令でないもの） | UserPromptSubmit p95 92.0ms／max 96.4ms／timeout 0（hook-timing、実 bin 67回）。確定3束の誤確定 0 | p95 ≤ before + 50ms、max <4000ms、timeout 0、誤確定 ≤1 |
| A11 | 本番14日の言い直し | 13クラス測定器（`repeat-classes.mjs`）の R7 を除いた合計の1日あたり件数。ラウンド2 反映後の窓（10/07〜10/14）を T18 着手時に測って基準とする | 8.8/日（R7 除外 105件/12日、ラウンド2 前）、ラウンド2 窓 = T18 で測定 | 基準の ≤0.7倍。オーナーが取り消した確定・原則 ≤1 |
| A12 | Codex 先行と枠表示（firebase-kit） | 枠リーダーの合成 rollout で: plus（5時間窓+週窓）・pro（週窓のみ）・枠切れ（`rate_limit_reached_type` あり）・窓更新後（`resets_at` が過去）・観測なしの5形。枠の通知は残り 2.0%→出る、2.1%→出ない、枠切れ→出る、不明→出ない。実機の最新 rollout の読取値が末尾イベントの `used_percent` と一致。経路選択は a09 の合成招聘文で、残り 50%→route C・gpt-6-luna・max、残り 2%→route A、不明→route A、`codex_first` なしの型→常に route A。本番は R7 発話数/日 | 実装なし／R7 17件/12日=1.4/日 | 合成は全期待どおり、実機差 0、Jev 型判定 eval の正答率が着手前と同値（鍵があるとき）、R7 ≤0.7/日（14日平均） |
| A13 | レビュー暴走停止（firebase-kit） | 合成ログ（レビュー起動の列）で: 同一成果物の3回目まで通り4回目を deny（Astra・Fable・Sol 交互でも合算）／直前と指摘の 80% 以上が一致した次の起動を deny、指摘が変われば通す／同一成果物の枠消費累計 20pt 以上で Codex レビューを deny、直近60分 50pt 以上で新規 Codex レビューを deny し実装委譲は通す／枠切れ・残り ≤2% で Codex レビューを deny／独立行『レビュー上限解除: オーナー承認済み』で通る／24時間動きなしでリセット／レビューでない起動（実装・要約役・通常の Agent）30件の合成で deny 0 | 上限なし（散文のみ） | 全期待どおり（停止の正解率 100%）、誤停止 0、guard の追加遅延 p95 ≤20ms、shadow 7日の実ログで誤停止 0 |

## 4. 実装タスク（Codex、1回1変更、依存順）

共通: 各タスク `pnpm exec tsc --noEmit` 終了0、`TMPDIR="$PWD/.tmp/tmpdir" pnpm exec vitest run <対象test>` 全通過。dist・本番DB・`.env`・wrapper の変更は T18 のみ。**`pnpm run build` 禁止**（本番 dist 差し替え。10/06 事故）。scratch は `pnpm exec tsc --outDir .tmp/<sid>/build --declaration false`。Codex はヒアドキュメント禁止、apply_patch と node -e を使用。fixture は合成文のみ。会話記録の生文を追跡ファイルへ出力禁止。LLM を呼ぶタスクは `llm-design.md` に従う。T1〜T5 が測定器側（改善より前）。firebase-kit 側のタスク（T10・T15・T16・T17）は `--cd` を firebase-kit にして別委譲にし、wasurenagusa 側のタスクと混ぜない（`refs/codex.md` 完走契約: `--add-dir` 不使用・リポジトリごとに分割）。firebase-kit の hook は共有 main で全 session に即効くので、T16・T17 は shadow を既定にする。

### T1 scratch を v12 に（測定器 1/5）

触るファイル: `scripts/replay/lib/simulate-engine.mjs`（`initializeBlankStore` `:1031` 付近）、`scripts/replay/simulate.test.ts`。

#### Done
1. scratch ストアを `migrateV11ToV12` まで進め、`owner_correction_violations` を作る。`CORRECTION_SCHEMA_VERSION !== 11` の throw を「v11 初期化後に v12 へ上げた結果が 12」の検査へ。
2. 既存 mode（cold・freeze・acceptance・hook-timing）の出力形は不変。

#### レビュー観点
本番 DB へ触れない（scratch のみ）／v12 移行が通常 initialize に入らない契約（ラウンド2 T9）を崩さない。

#### 検証コマンド（コマンドと期待値）
- `TMPDIR="$PWD/.tmp/tmpdir" pnpm exec vitest run scripts/replay/simulate.test.ts` → 通過。新規: scratch に `owner_correction_violations` 表あり・schema_version 12。
- `node scripts/replay/simulate.mjs --mode hook-timing --manifest .tmp/codex-T10a/manifest.json --compiled-root .tmp/<sid>/build --scratch .tmp/<sid>/t1` → 終了0。

### T2 再生の project を session 別に（測定器 2/5）

触るファイル: `scripts/replay/lib/simulate-engine.mjs`（`SOURCE_PROJECT` `:29`、`:1292` `:1850` `:2010`）、`scripts/replay/lib/session-project.mjs`（入出力の確認）、`scripts/replay/simulate.test.ts`。

#### Done
1. events の project を `session-project.mjs` の判定（written_files／worklog_only／launch_dir）で session ごとに決める。`SOURCE_PROJECT` 定数を撤去。
2. 出力に session 数の project 別内訳（件数のみ）。
3. manifest に project 情報がない場合は launch_dir（起動フォルダ）にフォールバックし、そのことを出力に記録（黙って firebase-kit にしない）。

#### レビュー観点
firebase-kit 固定に依存していたテスト fixture を直す（合成のみ）／project が違う session 間で owner 可視でない束が混ざらない。

#### 検証コマンド（コマンドと期待値）
- `TMPDIR="$PWD/.tmp/tmpdir" pnpm exec vitest run scripts/replay/simulate.test.ts scripts/replay/lib/session-project.test.ts` → 通過。新規: 合成2 session（別 project）で events.project が別。
- `grep -n "SOURCE_PROJECT" scripts/replay/lib/simulate-engine.mjs` → 0行。
- `node scripts/replay/simulate.mjs --mode cold --split tune --manifest .tmp/codex-T10a/manifest.json --compiled-root .tmp/<sid>/build --scratch .tmp/<sid>/t2` の出力 project 内訳に firebase-kit 以外（legaltech-lab 含む）が出る。

### T3 持ち越し再生（時刻順 online）（測定器 3/5）

触るファイル: `scripts/replay/lib/simulate-engine.mjs`（新 mode `online`）、`scripts/replay/simulate.mjs`（引数）、`src/corrections/retrieval.ts`（`confirmed_at` の可視条件）、各 test。

#### Done
1. `--mode online --until <日付>`: manifest の session を最初の人間発話の時刻順に、1つのストアへ流す。調整→評価の分割をせず、ある event の時点で既に確定している束だけが見える（持ち越し）。
2. 未来漏れ防止: 検索・配送の可視条件に「`confirmed_at` ≤ 当該 event の時刻」を追加（本番の hook は現在時刻なので挙動不変）。
3. 既存 `cold`・`freeze` の契約（評価の1回限り・hash 一致）は不変。online は別の出力名で、評価の claim ファイルを使わない。
4. 出力: 再発ごとの漏斗結果（防げた／(a)(b)(c) の止まり先・理由コード）、注入後再訂正率の分子分母、hook 時間。

#### レビュー観点
未来漏れ（確定が event より後の束が見える）0／時刻の同値・順序の扱い（同一分）／`confirmed_at` 条件が本番の取りこぼしを生まない（現在時刻 = event 時刻の場合）。

#### 検証コマンド（コマンドと期待値）
- `TMPDIR="$PWD/.tmp/tmpdir" pnpm exec vitest run scripts/replay/simulate.test.ts src/corrections/retrieval.test.ts` → 通過。新規: 合成3 session で session1 が確定した束が session3 では見え、session1 より前の event には見えない。
- `node scripts/replay/simulate.mjs --mode online --manifest .tmp/codex-T10a/manifest.json --compiled-root .tmp/<sid>/build --scratch .tmp/<sid>/t3 --until 2026-10-05` → 終了0、出力に再発ごとの漏斗結果。

### T4 台帳つき再発定義（測定器 4/5）

触るファイル: `scripts/replay/lib/simulate-engine.mjs`（`createReplayOccurrenceRows` `:1035` 付近）、新規 `scripts/replay/lib/recurrence-ledger.mjs`、新規 `scripts/replay/lib/recurrence-ledger.test.ts`、`scripts/replay/simulate.mjs`（引数）。

#### Done
1. 台帳 `.wasurenagusa/reports/ledger/recurrence-ledger.jsonl`（gitignore 配下、生文なし）の行 = `{event_hash, session_hash, theme_label, recurrence:"yes"|"no", intent_id, klass:"a"|"c"|"e"|"x"|"b"|"d"}`。ローダは重複・欠落（テーマ regex 2回目以降なのに台帳に行なし）を throw。
2. 再発 = テーマ regex 2回目以降 かつ 台帳 `recurrence:"yes"`。`klass:"e"`（指図の反復、裁定済み: 訂正でない）は台帳で `recurrence:"no"` とし、切替項目は設けない。
3. 出力に分母の内訳（klass 別件数、除外件数）と台帳ファイルの sha256。
4. 台帳に行のない event が再発候補になったら、台帳未整備として終了非0（H2 で盲検の台帳を先に作らせる強制）。

#### レビュー観点
台帳の読込が判定器（detector）に依存しない（独立）／台帳に生文が入る経路なし。

#### 検証コマンド（コマンドと期待値）
- `TMPDIR="$PWD/.tmp/tmpdir" pnpm exec vitest run scripts/replay/lib/recurrence-ledger.test.ts scripts/replay/simulate.test.ts` → 通過。新規: 合成台帳で x・e が分母に入らない、台帳欠落で非0。

### T5 dev 台帳の作成と before 固定（測定器 5/5、data-analyst + Codex）

触るファイル: `.wasurenagusa/reports/ledger/recurrence-ledger.jsonl`（データ、追跡外）、`.wasurenagusa/reports/round3/before-dev.json`、`docs/spec-learning-round3.md`（節3 before 欄）。

#### Done
1. 10/07 の分解結果（firebase-kit の `.tmp/<session>/sub-data-analyst/` の `join-tune.json`・`join-evaluation.json`）から dev 全再発候補（調整 90＋評価 19）の台帳を作る。c 初出の扱いと全行の `intent_id` を確定。2人目の点検で 20% 抜取の一致 ≥90%。
2. 現行 HEAD（ラウンド2 完了時点、コミット hash を記録）の scratch ビルドで T3 の online 再生を実施。出力: A1〜A5・A8・A10 の before 値。`repeat-classes.mjs` の 122/12日 を再掲。
3. 節3 の before 欄を実測値で埋めて commit（閾値は不変）。
4. archive の最新 mtime が 10/07 以降であること（日次取込の稼働）を確認し、H2 の開始条件（2026-10-08 以後の session が archive に入る）を記録。

#### レビュー観点
分母の内訳（再発 yes ／ x ／ c ／ e）を併記／調整に使った後の値を before にしていない／before ビルドが本番 dist でなく scratch。

#### 検証コマンド（コマンドと期待値）
- `node scripts/replay/simulate.mjs --mode online --manifest .tmp/codex-T10a/manifest.json --compiled-root .tmp/<sid>/build-before --scratch .tmp/<sid>/before --until 2026-10-05` → 終了0、`before-dev.json` が出る。台帳の評価側 19件の内訳が 分解a 6／c 1／e 5／x 7 と一致（x は分母に入らない）。
- `node scripts/replay/repeat-classes.mjs --transcripts .wasurenagusa/transcripts-archive/firebase-kit --compiled-root .tmp/<sid>/build-before --out .tmp/<sid>/rc.json` → `total=122`。
- `git diff docs/spec-learning-round3.md` → 節3 の before 欄のみ変更。

### T6 規則文の根拠保存（L1）

触るファイル: `src/corrections/rule-template.ts`、`src/corrections/rule-template.test.ts`、`src/corrections/detector.ts`（修飾語の抽出のみ）、`src/corrections/detector.test.ts`。

#### Done
1. 否定・禁止の対象語に係る修飾（「変な」「俺のわからない」「知らない」型の連体修飾）を、規則文から落とさず保持する。「〜を使わない」だけに縮めない。
2. 修飾が取れないときは、取れた範囲だけで規則文を作らず、素文経路（ラウンド2 T4）の原文のまま扱う（加工しない）。
3. 合成 fixture 8本（修飾語あり4・なし4）で、規則文が修飾語を含む／含まない比較。ラウンド2 の既存ケースは全通過。
4. 規則文 ≤240字の契約（`correction-schema.ts`）を超えない。超えるなら修飾を残して他を削る優先順位を明記。

#### レビュー観点
否定・条件の脱落の再発防止（ラウンド2 必須1と同型）／修飾語を足しすぎて別の規則に変わらない（入力に無い語を足さない）。

#### 検証コマンド（コマンドと期待値）
- `TMPDIR="$PWD/.tmp/tmpdir" pnpm exec vitest run src/corrections/rule-template.test.ts src/corrections/detector.test.ts` → 全通過。新規: 「変な言葉を使うな」型の合成文で規則文が「変な」を含む。
- online 再生（T3）を scratch で再実行 → 台帳 intent「分からない言葉」の束の `rule_text` が `変な|わから|知らな` を含む（A1）。

### T7 「だけ」で束が割れない（L1）

触るファイル: `src/corrections/bundle-key.ts`、`src/corrections/detector.ts`（条件語の解析のみ）、各 test。

#### Done
1. 「だけ／のみ／しか／ばかり」を条件語として解析し、condition_key に正規形で入れる（有無の差で束を割らない）。「しか〜ない」は否定の強調として別扱い。
2. 同じ意図で「だけ」の有無だけが違う合成8対が同一束になる。意味が逆になる組（「全部」対「だけ」）は別束のまま。
3. 既存の束キー（`oc:v2:*`）は書換えない。新規計算のみ新規則（detector_version を上げる）。旧根拠は新規則の計数に入れない（再生で空から作る）。

#### レビュー観点
意味の違う束の誤合流 0／既存の素文束キー（正規化一致）の契約と矛盾しない。

#### 検証コマンド（コマンドと期待値）
- `TMPDIR="$PWD/.tmp/tmpdir" pnpm exec vitest run src/corrections/bundle-key.test.ts src/corrections/detector.test.ts` → 通過。新規: 合成8対が同一束、逆意味2組が別束。
- online 再生で、台帳の割れていた2発話（`5a11b088`／`b14f5594` 相当）が同一束キー（A2）。

### T8 反応形の検出（L1）

触るファイル: `src/corrections/detector.ts`、`src/corrections/detector.test.ts`。

#### Done
1. 反応形（「いみわからん」「ってなに」型の、直前の AI 出力へ向いた理解不能の反応）を訂正として候補化する。語彙は `scripts/replay/lib/repeat-class-patterns.mjs` の R3 部分と同じ正規表現を detector に複製せず、共有できる形なら共有、不可なら detector 側へ移す（測定器は検出器から独立のまま。測定器から detector の import は禁止）。
2. 規則文は作らず candidate（素文経路の適格条件を満たさないため）。確定は原則（T12）か既存の反復で。
3. 誤候補化を抑える: 質問の返答として正当な「って何」（ユーザーが自分で定義を尋ねる文脈）は除く条件を、台帳の再発でない行で確認。

#### レビュー観点
測定器と検出器の独立（R3 regex の共有方向が測定器→検出器でないこと）／反応形が単独で確定しない／台帳で `no` の行の誤候補化 ≤5%。

#### 検証コマンド（コマンドと期待値）
- `TMPDIR="$PWD/.tmp/tmpdir" pnpm exec vitest run src/corrections/detector.test.ts` → 通過。新規: 反応形の合成6文が候補、通常質問の合成6文が非候補。
- online 再生で A3: 台帳の反応形の候補化率 ≥90%、台帳 no 行の誤候補化率 ≤5%。

### T9 schema v13 と原則の保存（L2 の土台）

触るファイル: `src/storage/correction-schema.ts`、`src/storage/migration.ts`、`src/cli/correction-import.ts`（`--migrate-v13`）、`src/storage/migration-v13.test.ts`、新規 `src/corrections/principles.ts`、新規 `src/corrections/principles.test.ts`、`src/corrections/retrieval.ts`・`src/corrections/injection-policy.ts`（構成員の除外）。

#### Done
1. v13 DDL: `owner_correction_principle_members(principle_key, member_key, attached_at, attach_source in ('cluster','later_attach'), PK(principle_key, member_key), FK 両方 → owner_correction_bundles)`、`owner_correction_strength_events(bundle_key, at, from_intensity, to_intensity, delta, reason in ('failure','idle','graduation_revoke','manual'), basis, PK(bundle_key, at, reason))`、`owner_correction_graduations(bundle_key, graduated_at, proposal_hash, revoked_at, revoke_reason, PK(bundle_key, graduated_at))`、`owner_correction_abstraction_runs(run_id, ran_at, mode, calls, groups, adopted, rejected_guard, rejected_none, skipped_reason, quota_before_pct, quota_after_pct)`。束表・記憶表の列は増やさない。
2. v13 移行は専用 `--migrate-v13`（dry-run で DDL 差分を先に表示、`--apply`）。通常 initialize では実行しない（ラウンド2 T9 の契約と同じ）。v12 → v13 のみ受付。
3. `principles.ts`: 原則の作成（`pr:v1:<正規化文の hash>`）、構成員の追加、根拠の別 session 合計（同一分・同文は1回）、確定判定（別 session ≥2）、取消（`cancelCorrectionBundle` 流用、構成員復帰）。
4. 構成員が confirmed 原則に属する間、`retrieval.ts`・`injection-policy.ts` の注入候補から除外。原則を取り消すと復帰。
5. `WASURENAGUSA_PRINCIPLES=off` で原則関連の処理が全停止。

#### レビュー観点
v12 以前の DB に対し通常 initialize が v13 を作らない／構成員除外の SQL が index を使い hook 期限（3500ms）に影響しない／原則の確定が構成員の個別確定を壊さない／violations・injections の外部キーが原則の `(bundle_key, version)` で成立。

#### 検証コマンド（コマンドと期待値）
- `TMPDIR="$PWD/.tmp/tmpdir" pnpm exec vitest run src/storage/migration-v13.test.ts src/corrections/principles.test.ts src/corrections/retrieval.test.ts src/corrections/injection-policy.test.ts` → 全通過。新規: v12 DB の複製で `--migrate-v13` dry-run が DDL 差分を表示、`--apply` で schema 13・integrity ok。構成員3つが候補で別 session 3 → 原則 confirmed・構成員は注入から除外。
- `node dist/cli/correction-import.js --migrate-v13`（scratch ビルドの dist、隔離 DB）→ dry-run 表示のみ・DB 無変化。

### T10 Codex 枠リーダー（firebase-kit 側、`--cd` firebase-kit）

触るファイル（firebase-kit）: 新規 `.claude/hooks/lib/codex_quota.py`、新規 `.claude/hooks/scripts/codex-quota.py`、新規 `.claude/hooks/tests/test_codex_quota.py`（合成 rollout fixture は `.claude/hooks/tests/fixtures/` 配下）。

#### Done
1. `codex_quota.py`: `CODEX_HOME`（既定 `~/.codex`）の `sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl` を新しい順に（最大5ファイル・直近2日）末尾から読み、最後の `token_count` イベントの `payload.rate_limits` を取る。窓は `primary`・`secondary`（null 可）のうち `resets_at` が現在より後のものの `used_percent` の最大。全窓が更新済みなら使用 0、`window_rolled:true`。`rate_limit_reached_type` が null でない、または使用 ≥100 なら `reached:true`。観測なし・形式不正は `unknown`（例外にせず値で返す。呼び出し側が「不明」を扱う）。
2. 返り値 `{status:"ok"|"unknown", remaining_percent, used_percent, reached, resets_at, observed_at, stale, plan_type, window_rolled}`。観測が6時間より古いと `stale:true`（値は返す）。
3. `codex-quota.py --json`: 上記を JSON で標準出力。`--notice`: 枠切れか残り ≤2% のときだけ1行（「Codex枠: 枠切れ／残り X%、リセット M/D HH:MM」）、それ以外は空出力（オーナー確定規則）。
4. `--history-days 14`: 直近14日の1時間あたり増分の分布（p50・p90・p99・最大）を出す（節1.6 の実測値の再現と、T17 の閾値 50pt の確認用）。p90 が 50pt 以上、または p99 が 50pt 未満（閾値が一度も効かない）なら、T17 の閾値を見直して本書を改版してから T17 に進む。
5. 読取のみ。rollout を書き換えない。本文（プロンプト・応答）を読み出さず `rate_limits` だけを取り出す。

#### レビュー観点
窓の種類（plus の5時間窓+週窓、pro の週窓のみ）に依存しない／`resets_at` が過去の窓を使用 0 として扱う／rollout が大きくても数百 ms で返る（末尾から読む）／本文を保持・出力しない。

#### 検証コマンド（コマンドと期待値）
- `cd firebase-kit && python3 -m pytest .claude/hooks/tests/test_codex_quota.py -q` → 全通過。合成 rollout の5形（plus・pro・枠切れ・窓更新後・観測なし）が節3 A12 の期待どおり。残り 2.0% で `--notice` が出力あり、2.1% で空。
- `python3 .claude/hooks/scripts/codex-quota.py --json` → `status:"ok"`、`used_percent` が最新 rollout の末尾 `token_count` の `used_percent` と一致（差 0）。所要 <500ms。
- `python3 .claude/hooks/scripts/codex-quota.py --history-days 14` → p50・p90・p99・最大を表示。

### T11 Luna での抽象化品質の確認（L2）

触るファイル（wasurenagusa）: 新規 `scripts/spikes/abstraction-check.mjs`、新規 `scripts/spikes/abstraction-check.test.ts`、新規 `prompts/principle-abstraction.md`（プロンプト本文）、`.wasurenagusa/reports/round3/abstraction-check.json`。

#### Done
1. 題材 = 台帳 intent ごとの束の規則文群（dev）から、同趣旨の群30と、別趣旨が混ざる群30（台帳の別 intent の束を人工的に混ぜる）の固定セット。生文でなく規則文（システム生成の文）を使う。
2. 被験は Luna Max のみ。T12 と同じ呼び方（`codex exec --sandbox read-only …`、モデル・推論は config.toml 既定）で、60群を1プロンプト・1呼出にまとめて実測する（1晩1呼出の運用そのままの条件）。
3. 指標: 同趣旨群で merge する率、混在群で `none` を返す率（誤合流率 = 混在群で merge した率）、差分ガード通過率、出力 JSON の欠落群数、1呼出の所要秒、1呼出の枠消費（T10 の枠リーダーで前後の使用率差）。
4. プロンプトは `llm-design.md` の4原則を満たす（本文 ≤100行、JSON のみ、決定論処理を含めない）。行数を test で検査。
5. 合格: 混在群の誤合流率 ≤5%、同趣旨群の merge 率 ≥70%、出力欠落群 0、1呼出の枠消費 ≤3pt（週枠）。未達なら T12 の LLM 段は shadow のまま on にしない（決定論の L1 だけで出荷）。60群が1呼出に収まらない場合は群数の上限（T12 の1晩の群上限）を下げて再測定し、その上限を T12 に反映する。

#### レビュー観点
同趣旨判定のみを LLM へ（集計・順位・閾値を渡さない）／混在群で merge を返す誤合流率を最重視／枠を測るため `--ephemeral` を付けない／実行は read-only サンドボックス。

#### 検証コマンド（コマンドと期待値）
- `TMPDIR="$PWD/.tmp/tmpdir" pnpm exec vitest run scripts/spikes/abstraction-check.test.ts` → 通過（プロンプト ≤100行、ガード関数の合成ケース、出力 JSON のパース）。
- `node scripts/spikes/abstraction-check.mjs --groups .tmp/<sid>/groups.json --out .wasurenagusa/reports/round3/abstraction-check.json` → 上記指標を出力。呼出数 1、合格条件 5 を機械判定して `pass` を出す。

### T12 抽象化ジョブ（shadow、L2）

触るファイル: 新規 `src/cli/abstract-principles.ts`、`src/corrections/principles.ts`（群作成・ガード・採用）、新規 `src/corrections/codex-batch.ts`（非対話呼び出しと枠の見張り）、`src/cli/scheduler-setup.ts`（深夜ジョブに1本追加、`codex` の絶対パスを plist に解決して埋め、見つからなければ install を失敗させる）、`src/observability/correction-metrics.ts`（カウンタ）、各 test。

#### Done
1. 節2.1 のとおり: 材料集め→群作成（`diceCoefficient` ≥0.5 または `requiredValuesKey` 共有の連結成分、≤10件）→閾値（束 ≥2・別 session ≥3・正規化文2種以上）→群を別 session 数の多い順に最大20群→**1プロンプトにまとめて1呼出**→差分ガード（内容語・極性・長さ）→採用。上限を超えた群は翌晩へ。
2. 呼び出し（`codex-batch.ts`）: `codex exec --sandbox read-only --skip-git-repo-check -C <.wasurenagusa/tmp/abstraction/<run_id>/ の空ディレクトリ> -o <出力ファイル> -`、プロンプトは stdin。`-m`・推論は指定しない（config.toml 既定の gpt-6-luna・max）。`--ephemeral` なし。`codex` は環境変数 `WASURENAGUSA_CODEX_BIN`（plist で絶対パス）。タイムアウト 20分で kill。呼出は1晩1回、再試行なし（test で呼出数 ≤1 を検査）。出力に無かった群は「none（その晩は見送り）」。
3. 枠の見張り: 呼出前に `WASURENAGUSA_CODEX_QUOTA_CMD`（既定は firebase-kit の `codex-quota.py --json` を指す値を plist に埋める。wasurenagusa は firebase-kit を import しない）を実行。残り 30% 未満・`reached`・`status:"unknown"`・コマンド実行不能のいずれかなら呼ばず、`skipped_reason` を記録して正常終了（飛ばした晩は失敗でなく仕様）。呼出後に再度読み、前後の使用率を `owner_correction_abstraction_runs` に記録。
4. `WASURENAGUSA_PRINCIPLES=shadow`（既定）では原則を candidate で保存し注入しない。`on` で confirmed 化・注入。`off` で何もしない（Codex も呼ばない）。
5. 後から来た候補束の既存原則への追加（`later_attach`）は同じ1呼出の中の群。同じガード。
6. 失敗は operation log に1行・非0終了。部分採用の途中失敗でも原則の半端な保存なし（1原則 = 1トランザクション）。
7. hook 経路（context.ts・analyze.ts）から Codex 呼出モジュールを import していないことを test で検査。

#### レビュー観点
差分ガードが入力との照合（語を足したら不採用）／別 intent の合流 0／同報（同一分・同文）を別 session と数えない／hook の import グラフに LLM が混ざらない／正規ラッパー（`--write`・worklog 追記）を使っていない／read-only／launchd の PATH・認証（`~/.codex/auth.json`）で動く／生文・認証情報のログ出力なし／飛ばした晩を失敗扱いにしない。

#### 検証コマンド（コマンドと期待値）
- `TMPDIR="$PWD/.tmp/tmpdir" pnpm exec vitest run src/corrections/principles.test.ts src/corrections/codex-batch.test.ts src/cli/abstract-principles.test.ts src/observability/correction-metrics.test.ts` → 全通過。新規: `codex` をスタブ（merge／none／語を足した出力／極性反転の出力／群欠落）で、merge のみ採用・他は理由コードつき不採用。枠スタブ（残り 29%・30%・reached・unknown・コマンド失敗）で 29%・reached・unknown・失敗は呼出 0、30% は呼出 1。shadow で注入 0。
- 合成 DB（隔離）で `node dist/cli/abstract-principles.js --dry-run` → Codex 呼出 0、採用候補一覧と呼出予定の群数のみ。
- 再生（T18）で A7。

### T13 強弱: 強度の上下（L3）

触るファイル: `src/corrections/store.ts`（`:996` の式）、新規 `src/corrections/strength.ts`、新規 `src/cli/strength-job.ts`、`src/cli/scheduler-setup.ts`、各 test、`scripts/replay/lib/simulate-engine.mjs`（online 再生で日付を進めて strength-job を回す）。

#### Done
1. 節2.2 の3信号を SQL で決定論に取る。`strength-job --now <時刻>`。上げ +1（同束3日に1回・上限5）、下げ −1（21日ごと・下限1）、効いた = 動かさず時計を戻して settled 判定の材料にする。
2. `store.ts:996` を `clamp(calculateIntensity(根拠) + strength_events の delta 合計, 1, 5)` に。`freshRoutingCycle` は引継なし。memories の `intensity` は同値コピーのまま（節1.3）。
3. `WASURENAGUSA_STRENGTH=off|shadow|on`。shadow は strength_events に `basis` つきで記録、intensity は更新しない。
4. 再生: online 再生が日付を進めて `strength-job --now` を呼ぶ。出力に「注入後再訂正率」。

#### レビュー観点
SessionStart だけの配送を「使われた」に数えていない／同 session 内の根拠が注入より前なら失敗に数えない（`human_ordinal` の大小）／根拠が増えても調整が消えない／上げ下げが hook 内で走らない。

#### 検証コマンド（コマンドと期待値）
- `TMPDIR="$PWD/.tmp/tmpdir" pnpm exec vitest run src/corrections/strength.test.ts src/corrections/store.test.ts` → 全通過。節3 A8 の合成 suite 6本。
- `node scripts/replay/simulate.mjs --mode online ... --scratch .tmp/<sid>/t12` の出力「注入後再訂正率」が T5 の before の 0.7倍以下（A8）。

### T14 卒業提案の書出（L4、wasurenagusa 側）

触るファイル: 新規 `src/corrections/graduation.ts`、新規 `src/cli/graduation-export.ts`、`src/corrections/injection-policy.ts`（卒業中を `prompt`・`refresh` 注入から外す）、各 test。

#### Done
1. 節2.3 の卒業条件・配送形（scene／always）・提案ファイル形式 `schema:1`。`WASURENAGUSA_GRADUATION=off|on`（既定 off、提案ファイルを書くだけ）。
2. 卒業の記録（`owner_correction_graduations`）、卒業後の取消（新根拠で `revoked_at`、強度 +1、注入復帰）。
3. 卒業中の原則は `prompt`・`refresh` 注入から外れ `start` は維持。
4. 提案ファイルに生文・パス・秘密値が入らない（規則文は既に伏せ字検査済み）。7日超は取込側が拒否するための `generated_at` を入れる。

#### レビュー観点
`task`・`routing` の寿命を卒業させない／引き金語の導出が決定論（LLM 不使用）／取消後に提案から消える。

#### 検証コマンド（コマンドと期待値）
- `TMPDIR="$PWD/.tmp/tmpdir" pnpm exec vitest run src/corrections/graduation.test.ts src/corrections/injection-policy.test.ts` → 通過。新規: 合成の settled 原則が提案に載る、routing は載らない、取消後は載らない。
- `node dist/cli/graduation-export.js --out .tmp/<sid>/proposal.json`（隔離 DB、scratch ビルド）→ `schema:1`、`principles` 配列、生文なし。

### T15 Jev への取込（L4、firebase-kit 側。範囲は節1.4）

触るファイル（firebase-kit）: `.claude/hooks/scripts/extract-jev-knowledge.py`（`--graduation <proposal>`）、`.claude/hooks/jev-knowledge.json`（再生成）、`.claude/hooks/tests/test_extract_jev_knowledge.py`、`.claude/hooks/tests/test_jev_knowledge.py`。任意: `.claude/hooks/lib/jev_knowledge.py`（`always` カード対応）。**触らない**: `advise.py`・`assignment-catalog.json`・`model-tier-map.json`（この3つは T16・T17 だけが触る）。

#### Done
1. `--graduation <proposal>`: スキーマ検査（`schema:1`、`generated_at` が7日以内、各行の必須項目、knowledge 行 ≤3・各 ≤200字）。不適合は拒否して非0。
2. `g-<hash8>` の id・`evidence_ids`（記憶 ID）・`count`（session 数）・`types`・`main:true` でカードを生成。卒業由来のカードは毎回全再生成（提案に無い `g-*` は消える）。手定義カード（k01〜k22）は不変。出力は `--out`、差分を標準出力へ。
3. `always` カード（引き金語なし）を扱う場合は `jev_knowledge.py` に `always:true` の選択を追加。差し込み上限 `MAX_CARDS` と `pinned` の既存規則は不変、always は1回 ≤150 tokens。扱わない選択をした場合は always 原則を提案から除外し、その旨を取込出力へ記録。
4. 反映は diff をオーナー確認後に通常の commit。自動書込なし。

#### レビュー観点
手定義カードの `knowledge_override` 機構を壊さない／`exclude_patterns` が正規表現として有効（コンパイル検査）／トリガー1語の過広がりで全プロンプトに差し込まない（引き金語の最小長・一般語除外）。

#### 検証コマンド（コマンドと期待値）
- `cd firebase-kit && python3 -m pytest .claude/hooks/tests/test_extract_jev_knowledge.py .claude/hooks/tests/test_jev_knowledge.py .claude/hooks/tests/test_jev_advise.py -q` → 全通過。新規: 合成 proposal で `g-*` カード生成、7日超の proposal 拒否、手定義カード不変、卒業取消後の再生成でカード消滅。
- `FORCE_SELFTEST=1 bash .claude/hooks/hooks-selftest.sh --strict` → 通過。
- 合成 prompt を `advise.py` の UserPromptSubmit 入力へ（`JEV_DISABLE` を付けず）→ 該当 `g-*` カードの知識行が差し込まれ、不一致 prompt では差し込まれない。
- `python3 .claude/hooks/tests/jev-prompt-eval/run.py`（API 鍵があるとき）→ 着手前と型・モデル正答率が同値。

### T16 Codex 先行の経路選択と枠の通知（L5、firebase-kit 側、`--cd` firebase-kit）

触るファイル（firebase-kit）: `.claude/hooks/lib/jev_assignment.py`（`_finalize` `:337`）、`.claude/hooks/assignment-catalog.json`（`codex_first`）、`.claude/hooks/scripts/assignment-catalog-check.py`（新項目の検査）、`.claude/hooks/advise.py`（UserPromptSubmit の枠通知）、`.claude/hooks/tests/test_jev_assignment.py`・`test_jev_advise.py`・`test_assignment_hooks.py`。

#### Done
1. 型に任意項目 `codex_first: true` を許す。初期の対象は a07・a09・a10（節2.4(1)。対象外の型と理由もカタログの note か本書に残す）。項目の検査（真偽値のみ・route A の型だけに付く）を `assignment-catalog-check.py` に。
2. `_finalize`: `codex_first` の型で、枠リーダー（T10、`lib/codex_quota.py`）が `status:"ok"`・残り >2%・`reached` でないなら、`route:"C"`・`model:"gpt-6-luna"`・`effort:"max"`・`route_reason:"codex_first"` を返す。それ以外（枠なし・不明・`codex_first` なし）は現行どおり。リーダーが例外・不明でも割当判定自体は失敗させない。
3. `advise.py` の route C 分岐（`:1619` 付近）はそのまま使い、通知文に枠の状況は足さない（表示規則は4）。
4. UserPromptSubmit: `codex-quota` の通知（`--notice` 相当）が空でないときだけ1行を additionalContext へ足す。通常時は何も足さない。
5. `JEV_CODEX_FIRST=off` で2・4を止め、現行動作へ戻す。
6. Jev 型判定（type 選定・band 選定）のロジックと正答率に影響しない（route と model の解決だけを変える）。

#### レビュー観点
通常時の出力トークン増 0／`codex_first` の型にだけ効く／Codex 経路にできない型（認証必須・調査・QA・scm）に付けていない／枠リーダーの失敗が割当を壊さない／実行中に尽きたときのフォールバック（`refs/codex.md:46`）を妨げない。

#### 検証コマンド（コマンドと期待値）
- `cd firebase-kit && python3 -m pytest .claude/hooks/tests/test_jev_assignment.py .claude/hooks/tests/test_jev_advise.py .claude/hooks/tests/test_assignment_hooks.py -q` → 全通過。新規: a09 の合成招聘文（`decide()` をスタブ）で、残り 50%→route C・gpt-6-luna・max、残り 2%→route A・sonnet、不明→route A、`codex_first` なしの型→route A、`JEV_CODEX_FIRST=off`→route A。枠通知は 2.0%・枠切れで出て 2.1%・不明で出ない。
- `python3 .claude/hooks/scripts/assignment-catalog-check.py` → 終了0。
- `FORCE_SELFTEST=1 bash .claude/hooks/hooks-selftest.sh --strict` → 通過。
- `python3 .claude/hooks/tests/jev-prompt-eval/run.py`（API 鍵があるとき）→ 着手前と型・モデル正答率が同値。

### T17 AI どうしのレビュー往復の暴走停止（L6、firebase-kit 側、`--cd` firebase-kit）

触るファイル（firebase-kit）: `.claude/hooks/lib/action_guard.py`（判定8、`evaluate` `:920` の Agent・Bash 分岐）、`.claude/hooks/advise.py`（PostToolUse で指摘の記録、レビュー起動に独立行がないときの通知）、`.claude/hooks/tests/test_action_guard.py`、`.claude/hooks/tests/test_jev_advise.py`、`.claude/refs/codex.md`（独立行 `レビュー対象:` の1行追記）。

#### Done
1. 判定8 `judge_review_loop`: 節2.4(2) のとおり。レビュー起動の判定（`-reviewer` 名の Agent、独立行 `レビュー対象:` つきの Codex 起動）、成果物キー、停止条件3つ（回数3、同一指摘 80%、枠の急増: 成果物累計 20pt・直近60分 50pt、Codex レビューのみ・枠切れか残り ≤2% は常に deny）、24時間でリセット、解除行 `レビュー上限解除: オーナー承認済み`。
2. state: `.claude/hooks/state/review-loop/<成果物キー hash>.json`（回数・各回の時刻・各回前後の使用率・指摘 fingerprint の集合）。書込は原子的（一時ファイル→rename）。state が壊れていたら「止めない」側に倒し、shadow ログへ記録。
3. 指摘の記録: PostToolUse で Agent の `tool_response`、または Codex 起動コマンドの `--output-last-message` のファイルから、指摘行（箇条書き・番号行）を正規化して fingerprint にする。読めなければ記録しない。本文は state に残さず fingerprint（文字3-gram の hash 集合）だけ。
4. `REVIEW_LOOP_GUARD=off|shadow|on`、既定 shadow（`.claude/hooks/state/review-loop-shadow.jsonl` に止めたはずの起動を1行、deny しない）。on にするのは shadow 7日で誤停止 0 を確認後。
5. deny 文は節2.4(2) のとおり（どの条件に当たったか・履歴・解除方法）。
6. 追加遅延 p95 ≤20ms（state の読込1回）。レビューでない呼出は判定8の入口で即 return。

#### レビュー観点
レビューでない起動（実装委譲・要約役・通常の Agent・Bash）を止めない（誤停止 0）／独立行がない起動を黙って通さず通知／同一指摘の判定が成果物の通常の修正（指摘が減る・変わる）で誤作動しない／枠の条件が Codex モデルのレビューだけに効く／解除行の手順がオーナー承認に紐づく／state に本文・秘密値を残さない／並行 session が同じ成果物を叩いても数えがずれない。

#### 検証コマンド（コマンドと期待値）
- `cd firebase-kit && python3 -m pytest .claude/hooks/tests/test_action_guard.py .claude/hooks/tests/test_jev_advise.py -q` → 全通過。新規（合成ログ）: 同一成果物の3回目まで通り4回目 deny（Astra・Fable・Sol 交互）／指摘 80% 一致の次を deny・指摘が変われば通す／成果物累計 20pt で Codex レビュー deny／直近60分 50pt で新規 Codex レビュー deny・実装委譲は通る／枠切れ・残り 2% で Codex レビュー deny／解除行で通る／24時間後リセット／レビューでない起動30件で deny 0。
- `REVIEW_LOOP_GUARD=shadow` で同じ合成ログ → deny 0、shadow ログに止める対象が出る。
- `FORCE_SELFTEST=1 bash .claude/hooks/hooks-selftest.sh --strict` → 通過。

### T18 再生で before/after、H2 評価、本番反映

触るファイル: `docs/findings/worklog-<日付>-round3.md`、`.wasurenagusa/reports/round3/`（データ）。

#### Done
1. H2 の開始条件（節2.6）を満たしたら manifest を作り、台帳を盲検で作る（system 出力を見る前、data-analyst）。
2. scratch ビルド2つ: ラウンド3前 HEAD（T5 の記録 hash）とラウンド3後。同じ manifest・同じ判定器・別 scratch で、dev（online、`--until 2026-10-05`）と H2（online、dev を持ち越し元に H2 を続ける）を再生。出力: A1〜A8・A10 の after 値、A5・A6 の before/after。
3. 本番の before 値として A11 の基準（ラウンド2 窓 10/07〜10/14 の1日あたり件数）を測る。
4. 節5 の手順で本番反映（オーナー y/n）。shadow から始める。
5. 反映後14日の after（A11、DB 実値、性能）を worklog へ追記。

#### レビュー観点
前後を同じ判定器・同じ manifest・同じ scratch 条件で比べているか／H2 を見てから閾値・語彙・regex・プロンプトを触っていないか（触ったら H2 の結果を破棄、再生をやり直し本書改版）／再生 DB を本番へ移入していないか／before/after の分母（再発件数・活動日数）を併記しているか。

#### 検証コマンド（コマンドと期待値）
- `pnpm exec tsc --outDir .tmp/<sid>/build-after --declaration false` → 終了0。
- `node scripts/replay/simulate.mjs --mode online --manifest .tmp/<sid>/manifest-h2.json --compiled-root .tmp/<sid>/build-after --scratch .tmp/<sid>/after-h2` → A6: 防げた率 ≥30% かつ before + 15pt 以上。
- `--mode hook-timing` → A10: p95 ≤ before + 50ms、max <4000ms。

## 5. 本番反映の手順と止め方

反映（T18、オーナー y/n 後。ラウンド2 節5 の形に追加）:

1. `.env` の `WASURENAGUSA_CORRECTION_LOOP=off`。
2. `cp .wasurenagusa/memory.db .wasurenagusa/migration-backups/pre-round3-<日付>.db`、`PRAGMA integrity_check` が ok。
3. `pnpm run build`（この手順でのみ。dist 反映＝全 session の hook が新コードを使う）。
4. `node dist/cli/correction-import.js --migrate-v13`（dry-run で DDL 差分を先に確認）→ `--apply`。
5. 合成1往復は本番 DB の複製（`MEMORY_DIR` 差替え）で: UserPromptSubmit に短文命令、Stop（transcript 付き）、別 session_id で SessionStart。stdout・stderr・`owner_correction_*` を確認、本番 DB 無変化。
6. firebase-kit で `FORCE_SELFTEST=1 bash .claude/hooks/hooks-selftest.sh --strict`。
7. 環境変数: `WASURENAGUSA_PRINCIPLES=shadow`、`WASURENAGUSA_STRENGTH=shadow`、`WASURENAGUSA_GRADUATION=off`、`WASURENAGUSA_CORRECTION_LOOP=on`。夜間バッチ用: `WASURENAGUSA_CODEX_BIN`（`codex` の絶対パス）・`WASURENAGUSA_CODEX_QUOTA_CMD`（firebase-kit の枠リーダーの呼び出し）を `scheduler-setup` で plist へ埋める。firebase-kit 側（T10・T16・T17）は commit で全 session に効くため、`REVIEW_LOOP_GUARD=shadow`・`JEV_CODEX_FIRST` 既定を確認してから commit する。
8. shadow 7日後に原則・強度の記録を見て（誤合流 0、強度の上下が意図どおり）、`PRINCIPLES=on`→24h 観測→`STRENGTH=on`→24h 観測。`GRADUATION=on` と Jev の取込は最後（提案の diff をオーナー確認、firebase-kit 側で通常 commit）。

止め方（効く順）:

- 全部: `WASURENAGUSA_CORRECTION_LOOP=off`。
- 原則だけ: `WASURENAGUSA_PRINCIPLES=off`（原則の注入・バッチ停止、構成員が通常配送へ戻る）。個別の誤合流は原則を `cancelCorrectionBundle`（構成員復帰、履歴保存）。
- 強度だけ: `WASURENAGUSA_STRENGTH=off`（調整は無視され、根拠由来の強度に戻る）。
- Codex 先行だけ: `JEV_CODEX_FIRST=off`。レビュー停止だけ: `REVIEW_LOOP_GUARD=off`（誤停止は shadow に戻す `=shadow`）。夜間の抽象化だけ: `WASURENAGUSA_PRINCIPLES=off`（Codex も呼ばない）。
- 卒業だけ: `WASURENAGUSA_GRADUATION=off`＋ firebase-kit で卒業由来カードを除いて再生成（`--graduation none`）して commit。緊急時は firebase-kit の直前 commit へ戻す（`jev-knowledge.json` のみ）。`JEV_DISABLE=1` は Jev 全体が止まるため最終手段。
- コード: 直前 commit の dist へ `pnpm run build`。v13 の表は維持（削除 DDL なし）。
- DB: 退避ファイルからの全体巻戻しは新規記憶喪失のため最終手段。

## 6. 未確認事項（オーナー確認が要るもの = 論点A〜B。10/07 の裁定2件は反映済みで、e 類の扱いと抽象化モデルは確定）

論点A: Codex 先行の初期対象型を a07 確定設計の実施計画・a09 確定文面の置換・a10 作業記録の整形の3つにしてよいか（節2.4(1)。対象外の型と理由は同節。追加・除外はカタログの `codex_first` 1項目の差分で済む）。

論点B: レビュー停止の初期値（同一成果物 3回・指摘一致 80%・成果物累計 20pt・直近60分 50pt）。3回は `refs/gates.md:7` に揃え、50pt は枠の実測（1時間増分 p90 14pt・p99 73pt）の間。shadow 7日の実ログで誤停止が出たら調整する運用上の値で、本書の評価閾値ではない。

その他の未確認:

- Luna の抽象化品質（T11）。未達なら LLM 段は出荷せず決定論の L1 だけで出す。別モデルへの切替は新たな裁定。
- 枠の読取は最後に Codex を動かした時点の値。他端末で Codex を使うと実残量と食い違う（`stale` で表すが補正はしない）。ChatGPT ウェブ版の Astra の枠は読めない（T17 は回数と同一指摘だけ適用）。
- 夜間バッチ（launchd）での `codex` の PATH と認証（`~/.codex/auth.json`）。T12 の検証で実機の1晩分を確認する。
- c 初出1件が真の再発か（T5 台帳で確定。分母 6 か 7 か）。
- H2 の件数: 10/08 以後 14日で台帳の再発が40件に届くか（過去 10.2/日の言い直しのうち台帳の再発に当たる割合が不明）。足りなければ n 併記で報告。
- H2 は本番でラウンド2 の注入が動いた期間の発話を含む。確定が1件のため影響は小さい見込みだが、注入で言い直しが減っていれば before 側も減る（比較は同じ母集団なので前後差には効かない）。
- 日次 archive 取込（ラウンド2 T3）の稼働（T5 で確認）。
- 抽象化の候補群の実数（現 candidate 105 のうち、閾値「束 ≥2・別 session ≥3」を満たす群の数）。T12 の dry-run で初めて出る。0 に近ければ原則が作られず A7 の「≥1 原則」が dev 再生だけで判定になる。
- 卒業の実数: 現状 confirmed 1、settled の条件（別日 ≥3・5 session）を満たす原則が出るのは抽象化 on の後。
- Jev eval（`jev-prompt-eval/run.py`）は API 鍵が要る。鍵なしなら A9・A12 のこの項目は「未測定」で、pytest と selftest で代替。
- 「引き金語を持たない常時系の原則」を Jev へ降ろす `always` 対応（`jev_knowledge.py`）の採否。採らないと常時系は降ろせず、wasurenagusa の配送に残る。
- UserPromptSubmit p95 800ms（ラウンド2 の合格線 500ms 超過）は本ラウンドの対象外。A10 は悪化させないことだけを見る。
