# 改善ラウンド2設計: オーナーが同じ注意を二度言わない

対象: wasurenagusa-mcp の訂正ループと周辺。実装: Codex（1タスク1変更）。前ラウンド正本 `docs/spec-owner-correction-loop.md`（節6 hook契約・節7 測り方・節9 巻戻しは本書でも有効、矛盾時は本書を優先）。本書はAIだけが読む。発話の生文は転記しない、件数と要約だけ。個人ホームの絶対パスは書かない。

## 0. 先頭1行

本番5日（10-01〜10-05）: 候補51・確定0・本文注入0回。言い直しの2割弱への効果は本番反映前のコード（run6、`b25d316` より前）の再生値。現行コードは訂正語のない短い命令（「全文出して」「質問に答えろ」型）が何回反復しても確定しない構造。天井は確定段で0。次が検出（13クラス123件中、検出64）。注入後の不遵守は未計測。代理指標ではルール既存の再発が60件。

## 1. 実態調査

### 1.1 母数と方法

- 会話記録: Claude Code の会話記録ディレクトリ（`~/.claude/projects/` 配下）の firebase-kit 起動 main session 119本（2026-09-23〜10-05、人間発話あり118）。他プロジェクト起動分は legaltech-lab 4本のみ残存。残りは `cleanupPeriodDays=7` で消失済み。退避済み: `.wasurenagusa/transcripts-archive/{firebase-kit,legaltech-lab}/`（gitignore 済み、336MB、README 同梱）。前ラウンドの manifest（`.tmp/replay/manifest.json`、98 session）は原本消失で再生不能。
- 抽出: `dist/corrections/events.js:extractOwnerEvent`（本番と同じ基準）で 2541 ファイル走査 → オーナー発話 1282（user 1164 / queued 118）。全件 firebase-kit 起動 session。復帰ブロック貼付（`isHandoffPaste`）73・`<pasted_content>` 先頭・コマンド包装を除いた非貼付 1170、活動日 12日。
- 検出: 同じ dist の `detectOwnerCorrections` を直前 assistant text 付きで全発話に適用。
- 本番DB: `.wasurenagusa/memory.db` を `sqlite3 "file:<path>?immutable=1"` で読取（`-readonly` はこの機材で open 失敗）。
- 発話の形: 1〜10発話目 813（63%）、11〜30 333、31〜100 136。40字以下 698（54%）、100字以下 1065（83%）。短い命令が主体。

### 1.2 二度言わされている注意（手分類13クラス、非貼付1170発話）

全536件の候補・テーマ一致発話を確認。同じ趣旨が別session・別日に出たものだけをクラス化。regex は節4 T2 で測定器として固定。

| ID | 中身 | 件数 | session | 日 | 現検出器が候補化 | 規則本文あり |
|---|---|---:|---:|---:|---:|---:|
| R1 | 全文を出せ（省略表示するな） | 20 | 6 | 8 | 20 | 0 |
| R2 | 質問に答えろ・質問があったら止まれ | 5 | 4 | 2 | 5 | 0 |
| R3 | 分からない言葉・社内用語・主語抜き（「〜って何」「意味わからん」含む） | 47 | 36 | 9 | 16 | 7 |
| R4 | 要約に字数制限を課すな・要約の進め方 | 4 | 4 | 2 | 2 | 0 |
| R5 | Codexは作業だけ、設計は自分で | 3 | 2 | 1 | 1 | 0 |
| R6 | 指図したモデルから勝手に切り替えるな | 4 | 3 | 3 | 0 | 0 |
| R7 | モデル指図の同報（Codex使え・Claude使うな・6.1 Sol以上） | 17 | 15 | 3 | 8 | 0 |
| R8 | なぜ敬語か（常体で書け） | 5 | 4 | 3 | 5 | 5 |
| R9 | 一時置き場・成果物の置き場所（firebase-kit に置くな） | 3 | 3 | 2 | 2 | 0 |
| R10 | 自分で確認しろ・調べてから言え | 4 | 4 | 2 | 2 | 0 |
| R11 | 引継ぎにCodex枠の状態を書くな | 1 | 1 | 1 | 1 | 0 |
| R12 | まだ投稿するな（案件内の一時指示） | 4 | 2 | 2 | 2 | 0 |
| R13 | 話が長い・結論から言え | 6 | 6 | 4 | 0 | 0 |
| 計 | | 123 | | 12 | 64 | 12 |

- before 値: 123件/12日＝10.3件/日。R3 を除くと 76件/12日＝6.3件/日。
- 素文経路（T4）の見込み（手元近似、退避記録1170発話に T4 Done 1 の適格条件を適用）: 適格文 39、束 19、別 session 2回以上の束 4（R1 全文表示 6 session／R2 質問応答 3／R7 の同報1文言 3／R3 の禁止形 2）。うち R7 の束は同一分に3 session へ貼った1回の指図で、1分後に同じ3 session へ撤回文が送られている。同報は1回の行為として計数すれば候補止まり＝確定見込みは3束（R1・R2・R3 禁止形）。3束とも AI の振る舞いへの命令で、案件依頼の混入 0。R7 の例は「同報を2 session 根拠に数えると撤回済みの指図を確定する」誤確定の実例。対象なし動詞だけの文（確認して 等）は requiredValues 空で不適格、R4・R8 は長文・疑問形で素文経路に乗らない（R8 は既存 tone 例外で確定）。
- 同報: 同一分に同文を2〜3 session へ送った群が12群28発話、うちモデル指図が5群（R7）。後から始まる session の開始時に届けば減る言い直し。同じ分に複数 session へ貼る行為自体は、確定が2回目以降に成立する仕組みでは防げない。
- テーマ regex（`scripts/replay/lib/themes.mjs`）の件数は貼付で水増し。B1 327→非貼付252、B7 90→17（真の R5 は3）。B7/B1 は効果の分母から除外。
- R3 は最大だが、語の意味を尋ねる形の大半は個別の語への質問。規則化可能なのは社内用語・工程略号・比喩名づけのオーナー向け出力禁止1本。CLAUDE.md 文体節と dont「オーナー報告で工程略号禁止」に既存。記憶の注入では解消不可（節2「範囲外」）。

### 1.3 漏斗と天井の所在

| 段 | 実測 | 判定 |
|---|---|---|
| 検出 | 123件中64が候補化。R1/R2/R8 は全件、R3 16/47、R6 0/4、R13 0/6 | 半分。R6/R13 は語彙表にない |
| 確定 | 候補263中、規則本文あり14（5%）、confirmed 5（全部 tone 例外、go-live 前の発話）。本番束51の rule_text 非空 2/51、confirmed 0 | **0。構造要因** |
| 配送 | 本番 injections 0行、UserPromptSubmit 465回の注入 token 全0。確定0なので未検証 | 未検証 |
| 注入後 | 未計測。代理: 既存ルール（CLAUDE.md・pdm.md・refs・dont記憶）に書いてあるのに再発＝R2 5・R3 47・R4 4・R9 3・R11 1＝60件。R11 は dont 題名が SessionStart 索引に載っていた session で 10-04 に再発 | 題名注入では守られない実例あり |

確定が0になる機構（`src/corrections/`）:

- `rule-template.ts:317` `renderTypedCorrectionRule` と `:336` `renderCorrectionRule` が `directive` 必須。`detector.ts:565-567` の `directive` は `hasCorrectionMark`（反復語・否定語・継続命令）が条件。「全文出して」「質問に答えろ」は印なし → `ruleText=""`。
- `store.ts:845-849` `usableRows` は `renderCorrectionRule` 非空の根拠だけ、`:883` `repeatConfirmed` はその根拠2件。本文なし候補は反復回数にかかわらず candidate。
- 由来: `b25d316`（10-04 go-live 直後）「訂正の印が無い依頼は何回繰り返しても候補止まり」。契機は反映直後の通し試験で普通の依頼文の2 session反復が規則として確定した件。修正が短い単文命令にも波及。前ラウンド設計書 節2 項8（初回候補保存・2回目確定）と現実装が不一致。別件の `fb1c410`（「また一つ」誤爆、本番 rejected 1件、53字）とは独立。
- 本番 evidence 51 = `request_repeat` 50（score 2）+ `utterance_detection` 1（却下済みの誤候補）。occurrence_count 全部1、session_count 全部1。

検出で落ちる機構: `detector.ts:277 matchesTopic` の語彙表に R6（切替禁止）・R13（長さ・結論先）の対象語なし。R3 の語への質問は述語なしで除外（規則化対象外のため修正対象外）。

### 1.4 本番5日の実値（`owner_correction_*`、10-05 11:20 時点）

- events 282（user 253 / queued 29）、38 session、10 project。全282が退避会話記録の正規化本文と hash 一致（Stop 回収経路の正しさを確認）。
- 15/38 session が複数 project（cwd 移動）。全 session が firebase-kit 起動なのに events.project は cwd 由来（`src/cli/context.ts:912-913`、`src/cli/analyze.ts:408-409`）。同じ注意が別 project の束に分裂。
- pending 138、照合 22（16%）。未照合116のうち102が keep-alive 自動文（firebase-kit `hooks/keepalive-limit.py` が送る「keep-alive: …」、`extracted_candidates` に keep-alive 条件を含む行で計数）。transcript に human 発話として現れず、永久に未照合。delegation_roles negative の候補として毎回検出・保存。残り14件は原因未確認（節6。うち2件は同 session の events と15秒以内、3件は退避記録の正規化本文と hash 一致）。
- 束51: candidate 46（unknown 24、verification 6、delegation 4、document_delivery 3、model_routing 3、summary 2、response 2、storage 1、tone 1）、disputed 4（unknown）、rejected 1。visibility 全部 project。
- memories: dont 363（wasurenagusa-mcp 105、legaltech-lab 94、firebase-kit 42、frontria 34、ai-personal 28 …）。SessionStart 注入は cwd project の最小索引50件の題名のみ（手元で scratch DB に対して実行、4118 bytes、1373〜1483 tokens）。owner-profile.md は0バイト。

### 1.5 hook 性能（`.wasurenagusa/logs/correction-metrics/`）

| 日 | UserPromptSubmit n | p50 | p95 | max | tok | SessionStart n | p95 | tok |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 10-04 | 159 | 182 | 652 | 1400 | 0 | 33 | 403 | 1483 |
| 10-05 | 306 | 292 | 801 | 1408 | 0 | 25 | 1199 | 1373 |

前設計の合格線 UserPromptSubmit p95≤500ms を本番で超過。段別内訳は未計測（既存 metrics は総 ms のみ）。

### 1.6 再生（run6、`.tmp/replay/run6/reports/simulate.md`、b25d316 前）

調整 contract 13/70（B5 全文 13/14、他0）、observed 11/70、評価 0/29。失敗 (a)22 (b)35 (c)0。B1 0/124（not_confirmed 116）。b25d316 以後の再生なし。

## 2. 採用する改善（優先順）と採らない案

物差し: オーナーの目から見た、同じことを言う回数の減少。作り込みは削減。

| 順 | 改善 | 効く段 | 見込み（1.2の実数から） |
|---|---|---|---|
| P1 | 素文規則: 訂正語のない短い単文命令も、別 session で2回来たら本文つきで確定 | 確定 | 手元近似で R1（6 session）・R2（3）・R3 の禁止形（2）の3束が確定対象（R7 の同報文言は1回扱いで候補）。確定0→≥3束、誤確定0 |
| P2 | 横断可視性: session の project を起動時に固定、振る舞い規則は owner 可視 | 配送 | 15/38 session の束割れ解消。別 project へ移っても届く |
| P3 | 自動プロンプト除外（keep-alive 等） | 保存・性能 | pending 未照合 116 のうち keep-alive 102 を0に、keep-alive 発話ごとの無駄な検出・保存を除去 |
| P4 | モデル指図の短文を owner 可視・24h で同報 | 確定・配送 | 確定後に始まる session へ開始時に届く（R7 17件・15 session が対象域）。同報行為そのものは減らない。R6 の「勝手に切り替えるな」と撤回文（じゃない・やめて）は取消根拠として扱う |
| P5 | 計測基盤: 退避会話記録＋13クラス測定器＋日次アーカイブ | 測り方 | before 固定（123/12日）。after を同じ物差しで出せる |
| P6 | 段別処理時間の計測 | 性能 | p95 800ms の原因特定。修正は計測後 |
| P7 | 確定規則の遵守検査（Stop、決定論3種）と違反時の再注入 | 注入後 | 注入後段の初の計測。R1（同一 session 内7回）・R8・工程略号に効く |

採らない案と理由:

- 毎ターン hook での LLM 判定: p95 が既に合格線超過、対象クラスは短文命令で決定論で充足、費用。
- Stop LLM 分析（Gemini）の有効化: 従量課金、前ラウンド未決のまま off 維持。
- 既存 dont 363件の一括規則化・SessionStart 索引の全 project 化: 題名注入で守られない実例（R11）、本文枠 1800 tokens に収容不可、オーナーの確認作業増加。
- 束キーの意味統合（言い換え吸収）: LLM が必要。P1 の素文は正規化一致＋既存 topic/action 束で充足。
- 検出閾値・語彙の再調整ラウンド: 評価データ再利用禁止、構造問題（確定0）が先。
- 範囲外（本書の設計対象外、別タスク化）: R3「分からない言葉」47件はルール既存で再発。応答文の工程略号・比喩名づけを出力側で検査する仕組みは firebase-kit の `hooks/advise.py` 系か P7 の拡張。R13「話が長い」も同種。

## 3. 合格基準（測れる形）

全体:

- 言い直し数/日（13クラス合計、測定器 T2）: before 10.2/日（測定器 122/12日）→ 本番反映後7日の平均 ≤5.1/日。R3 除外: 6.3 → ≤3.2。
- 誤確定: 本番7日でオーナーが取り消した確定 ≤1。再生の確定一覧目視で「AIの振る舞いへの命令」でない依頼の確定 0（許容1）。
- 性能: UserPromptSubmit p95 ≤500ms、max <4000ms、5秒 timeout 0。
- 費用: LLM 呼出 0（`correction_llm_call` カウンタ 0）。

改善別の合格基準は節4の各タスク Done に逐条で記載。

## 4. 実装タスク（Codex、1回1変更、依存順）

共通: 各タスク `pnpm exec tsc --noEmit` 終了0、`TMPDIR="$PWD/.tmp/tmpdir" pnpm exec vitest run <対象test>` 全通過。dist・本番DB・`.env`・wrapper の変更は T10 のみ。Codex はヒアドキュメント禁止、apply_patch と node -e を使用。テスト fixture は合成文のみ。会話記録の生文を追跡ファイルへ出力禁止。

### T1 自動プロンプト除外（P3）

触るファイル: `src/corrections/events.ts`、`src/cli/context.ts`、`src/corrections/events.test.ts`、`src/cli/context-entry.test.ts`。

#### Done（合格基準逐条）

1. `extractOwnerEvent` に自動プロンプト判定を追加: 先頭（空白除去後）が `keep-alive:`、`<task-notification`、`<system-reminder`、`<command-message>` のいずれかなら `null`。firebase-kit `hooks/advise.py:_is_automated_prompt` と同じ4系統。
2. UserPromptSubmit 入口で null なら pending 登録・検出・候補保存・関連検索を省略。既存の空 stdout で復帰。metrics に `miss` でなく新理由コード `automated_prompt` を計数。
3. Stop 回収（`analyze.ts`）でも同判定で除外（transcript に現れた場合の保険）。
4. 既存の人間発話の抽出結果は不変（events.test の既存ケース全通過）。

#### レビュー観点
先頭一致だけで判定し、本文中の語には不反応／人間の通常文中の「keep-alive」は先頭でなければ通過／queued_command 経路にも適用。

#### 検証コマンド（コマンドと期待値）

- `TMPDIR="$PWD/.tmp/tmpdir" pnpm exec vitest run src/corrections/events.test.ts src/cli/context-entry.test.ts` → 全通過、新規ケース「keep-alive 先頭は null」「本文中 keep-alive は非 null」を含む。
- 合成 stdin（`{"session_id":"t","cwd":".","hook_event_name":"UserPromptSubmit","prompt":"keep-alive: とだけ返す"}`）を `node dist/cli/context.js`（scratch ビルド `--outDir .tmp/<sid>/build`）へ、`MEMORY_DIR` は隔離DB → stdout 空、隔離DBの `owner_correction_pending` 増分 0。
- 本番反映後24h: `select count(*) from owner_correction_pending where matched_event_id is null and received_at > '<反映時刻>'` ≤ 同期間 pending 総数の15%（現状 84%）、かつ `extracted_candidates like '%keep-alive%'` の新規行 0。

### T2 測定器と before 固定（P5b）

触るファイル: 新規 `scripts/replay/repeat-classes.mjs`、新規 `scripts/replay/lib/repeat-classes.test.ts`、新規 `scripts/replay/lib/repeat-class-patterns.mjs`。

#### Done（合格基準逐条）

1. 入力: 会話記録ディレクトリ（`--transcripts`）。抽出は `dist` でなく、scratch ビルドの `extractOwnerEvent` を `--compiled-root` から import。貼付（`isHandoffPaste`、先頭 `<pasted_content`、先頭 `<command-`）とスラッシュコマンドを除外。
2. 13クラスの regex を `repeat-class-patterns.mjs` に固定（下記）。1発話は最初に一致した1クラスへ分類。
3. 出力 JSON: クラス別 件数・session数・日数、日別合計、同報群（同一分・同文・2 session以上）件数、活動日数、1日あたり件数。生文は出力禁止（hash と先頭 0 文字）。
4. `--since`/`--until` で期間指定。before 値を `.wasurenagusa/reports/repeat-classes/before-20261005.json` に保存（gitignore 配下）。
5. テスト: 合成13文で各クラス1件、貼付除外、同報群の計数。

regex（NFKC 後の本文に適用、`u` フラグ）:

```
R1  (?:全文|文章|文面)(?:を|も|だけ)?[^。]{0,8}(?:出|見せ|表示)
R2  質問(?:に|だけ|あったら)[^。]{0,6}(?:答え|止ま)|(?:まず|おい)[^。]{0,4}質問に答え
R3  (?:変な|きしょい|キモい|気色悪い|おまえが定義した|俺のわからない|わからない)(?:言葉|日本語|表現|呼称)|って(?:何|なに)\?|ってなに|いみ(?:が)?わからん|意味(?:が)?わからん|意味不明|主語を(?:はぶくな|つけ)
R4  字数(?:制限|で)[^。]{0,10}(?:やめ|やるな|するな)|(?:文字|字)(?:制限|数指定)[^。]{0,6}(?:やめ|やるな|するな|無理)|無制限にしろ|要約系の仕事になったら
R5  Codex(?:に|には)[^。]{0,12}(?:作業(?:しか|だけ)|ぽんだし|丸投げ)|設計(?:は|を)おまえ
R6  (?:勝手に|かってに)(?:切り替え|きりかえ)|なんで(?:Sonnet|Codex|Sol)[^。]{0,8}(?:使|つか|よぶ)|Codex(?:でやれ|つかえ|使え)(?:って|っつ)
R7  ^(?:(?:なるべく|可能な限り)Claude(?:を)?(?:つか|使)わない|Codex(?:を)?(?:使いまくって|かつよう|活用|潤沢|じゅんたく)|Codexは最低でも|都度GPT6-SOL)
R8  (?:なんで|何で)[^。]{0,8}敬語
R9  一時置き場|なんで(?:これ)?Firebase-kit|常にFirebase-kit|プロジェクト外
R10 自分で確認しろ|調べる癖|裏取りはやりな|確認して進めろ
R11 Codex[^。]{0,10}引き継ぐな|引き継ぎに入ってるなら消せ|毎回出す
R12 まだ投稿(?:しないで|するな|はしないで)
R13 はなしがながい|話が長|結論から|けつろんからいえ
```

#### レビュー観点
測定器は検出器と独立（`detector.ts` の import 禁止）／R7 は行頭一致のみ／貼付除外の3条件を充足。

#### 検証コマンド（コマンドと期待値）

- `TMPDIR="$PWD/.tmp/tmpdir" pnpm exec vitest run scripts/replay/lib/repeat-classes.test.ts` → 通過。
- `node scripts/replay/repeat-classes.mjs --transcripts .wasurenagusa/transcripts-archive/firebase-kit --compiled-root .tmp/<sid>/build --out .wasurenagusa/reports/repeat-classes/before-20261005.json` → `total=122`、`R1=20 R2=5 R3=48 R4=3 R5=3 R6=4 R7=17 R8=4 R9=3 R10=4 R11=1 R12=4 R13=6`（10-05 改版: 先勝ち分類の実測値。手分類の123とは重複一致2発話の配属差。before の正はこの値）、`utterances=1170`、`activeDays=12`、`broadcastGroups=12`。差があれば regex か除外条件の転記ミス。本書でなく実装を確認。

### T3 会話記録の日次アーカイブと manifest 入力（P5a/d）

触るファイル: 新規 `scripts/maintenance/archive-transcripts.mjs`、`src/cli/scheduler-setup.ts`（launchd plist に1ジョブ追加）、`scripts/replay/make-manifest.mjs`（`--transcripts` への archive 入力に対応、`DATE_START/DATE_END` を引数化）、各 test。

#### Done（合格基準逐条）

1. 会話記録ディレクトリ配下の main session `*.jsonl`（サブディレクトリは除外）を `.wasurenagusa/transcripts-archive/<起動ディレクトリ名>/` へ、新規・更新分だけコピー（mtime と size 比較）。削除なし。
2. launchd で1日1回。失敗は `logs/operation-*.jsonl` へ1行。
3. `make-manifest.mjs` は archive を入力に 2026-09-23〜10-05 の manifest 作成に対応。期間は `--from/--to`。
4. archive の README に取得元・期間・用途・転記禁止を記載済み（本書の退避で作成済み、内容維持）。

#### レビュー観点
コピー先は gitignore 配下（`git check-ignore`）／原本の書換えなし／ディスク増分の上限（例: 2GB 超で古い月を警告）。

#### 検証コマンド（コマンドと期待値）

- `node scripts/maintenance/archive-transcripts.mjs --dry-run` → コピー予定件数のみ表示、ファイル変更0。
- 実行後 `ls .wasurenagusa/transcripts-archive/firebase-kit | wc -l` ≥ 119。
- `node scripts/replay/make-manifest.mjs --transcripts .wasurenagusa/transcripts-archive/firebase-kit --from 2026-09-23 --to 2026-10-05 --out .tmp/<sid>/manifest.json` → sessions 118（人間発話あり）。
- `TMPDIR="$PWD/.tmp/tmpdir" pnpm exec vitest run scripts/replay/lib/make-manifest.test.ts` → 通過。

### T4 素文規則の確定（P1、本ラウンドの本丸）

触るファイル: `src/corrections/rule-template.ts`、`src/corrections/store.ts`、`src/corrections/detector.ts`（素文適格フラグの付与のみ）、`src/corrections/rule-template.test.ts`、`src/corrections/store.test.ts`、`src/corrections/detector.test.ts`。

#### Done（合格基準逐条）

1. 素文適格（`plainCommandEligible`）を `CorrectionRuleInput` に追加。detector が付与。条件すべて: 正規化文 ≤40 Unicode 文字／1文（segments 単位）／`EXPLICIT_COMMAND_ENDING` 一致／`hasCorrectionPredicate` 真／質問・相談でない（`looksLikeQuestion` 偽、`isConsultationQuestion` 偽）／秘密値なし・貼付でない／`THIRD_PARTY`・`EXAMPLE_CONTEXT` 不一致／topic が既知10種で `requiredValues` が1個以上（対象語が取れている。対象なしの「確認して」型は不適格）、`model_routing` はモデル名を含む文のみ、または `unknown` かつ `NEGATIVE_ACTION` 一致（禁止形のみ）。束ね: 既知 topic は topic/action/polarity/requiredValues の一致、`unknown` と `model_routing` 短文は正規化同文のみ。
2. 単発では従来どおり本文なし candidate（`b25d316` の detector テスト「ordinary typed and unknown requests as bodyless candidates」維持）。
3. `store.ts applyCorrectionEvidence`: 同束の根拠が「本文あり」または「素文適格」で、別 session・30日内に2件以上なら confirmed。同一分（observed_at の分まで一致）・同文の根拠は1回の行為として1件に数える（同報を2 session 根拠にしない）。本文は `removeCorrectionMarkers(commandText)`。同束に複数文言があれば、2 session 以上で同文の文言を優先、無ければ最短。既存の本文あり経路は不変。
4. 素文確定の lifetime は inferred（30日）。model_routing は routing（24h）。`explicit_continuing` は従来どおり継続語がある場合のみ。
5. 同 session 内の2回は確定不可（session_count≥2 必須）。肯定形の unknown（例: 下書き依頼）は2 session でも確定不可。41字以上は確定不可。
6. 確定時の memory 作成・version 追記・取消（`cancelCorrectionBundle`）は既存経路を使用。detector_version を v3 に更新。v2 以前の根拠は素文確定の計数から除外（再生で空DBから作成）。

#### レビュー観点
「AIの振る舞いへの命令」以外は確定対象外（合成の依頼文10本で確定0）／否定・条件の脱落（前ラウンド必須1）の素文経路での再発防止＝素文は加工せず原文のまま、`removeCorrectionMarkers` 以外の切り詰めなし／同じ文の再配信（同 event）は0加算／secret 伏せ後の文は本文に不採用（伏せ字が入ったら不適格）。

#### 検証コマンド（コマンドと期待値）

- `TMPDIR="$PWD/.tmp/tmpdir" pnpm exec vitest run src/corrections/rule-template.test.ts src/corrections/store.test.ts src/corrections/detector.test.ts` → 全通過。新規ケース: 別 session 2回で確定（R1型・R2型・R4型・unknown禁止形）、同 session 2回は candidate、肯定形 unknown 2 session は candidate、41字は candidate、質問形は candidate、`b25d316` 由来の既存ケースはそのまま。
- `pnpm test` → 失敗は既知の g1-foundation 系のみ（本件外）。
- 再生（T10 で実施、ここでは scratch）: 空DBから archive 118 session を cold 再生し、`owner_correction_bundles where status='confirmed'` の一覧（rule_text・topic・session_count）を `.tmp/<sid>/confirmed.md` へ → 確定 ≥3（R1 全文表示・R2 質問応答・R3 禁止形 各≥1）、R7 の同報文言は候補のまま、全件目視で振る舞い命令でない確定 0（許容1）。

### T5 session の project 固定（P2a）

触るファイル: `src/cli/context.ts`（912-913 付近）、`src/cli/analyze.ts`（408-409 付近）、`src/corrections/session-store.ts`、`src/corrections/session-store.test.ts`、`src/cli/context-entry.test.ts`。

#### Done（合格基準逐条）

1. events.project はその session の最初の event の project を優先。無ければ cwd 由来。DDL 変更なし（`owner_correction_events` を session_id_hash で引く）。
2. SessionStart の読出し project も同じ規則（起動時 cwd＝最初の値）。
3. compact 後も同じ。
4. 既存 15 session の過去 events は書換えなし。

#### レビュー観点
追加 SELECT の hook 期限（3500ms）への影響（index 済み列）／cwd 移動時に project 規則が読めなくなる副作用（owner 可視化 T6 で吸収する前提）。

#### 検証コマンド（コマンドと期待値）

- `TMPDIR="$PWD/.tmp/tmpdir" pnpm exec vitest run src/corrections/session-store.test.ts src/cli/context-entry.test.ts` → 通過。新規: 同 session で cwd を変えた2発話が同 project。
- 本番反映後7日: `select count(*) from (select session_id_hash from owner_correction_events where observed_at > '<反映時刻>' group by 1 having count(distinct project)>1)` → 0。

### T6 振る舞い規則の owner 可視（P2b）

触るファイル: `src/cli/analyze.ts`（`OWNER_VISIBLE_TOPICS` 51-57、`correctionVisibility` 156-163）、`src/cli/analyze-correction.test.ts`、`src/corrections/store.test.ts`。

#### Done（合格基準逐条）

1. `OWNER_VISIBLE_TOPICS` に `storage_location`、`verification`、`delegation_roles` を追加。`unknown` は素文適格かつ negative のときだけ owner 候補。`design_components` は project 維持。`model_routing` は T7。
2. 条件は既存どおり general/continuing/audience:owner のみ（案件限定・期限付きは project）。
3. `store.ts:914 canBeOwner` は sessionCount≥2 で成立するため変更なし。確定時に owner へ昇格。

#### レビュー観点
前ラウンド設計 節5「visibility=owner は応答文体・提示形式・一般方針に限定」との整合＝verification/delegation/storage は一般方針として扱う裁定／project 固有の保存先（特定ディレクトリ名入り）は `unparsed` 条件で project に限定。

#### 検証コマンド（コマンドと期待値）

- `TMPDIR="$PWD/.tmp/tmpdir" pnpm exec vitest run src/cli/analyze-correction.test.ts src/corrections/store.test.ts` → 通過。新規: 別 project の2 session で同じ R2型命令 → confirmed かつ visibility=owner。
- 再生（T10）で owner 可視 confirmed ≥3、別 project の session 開始時に本文到達 ≥1。

### T7 モデル指図の短文（P4）

触るファイル: `src/corrections/detector.ts`（model_routing 分岐 286-295、`conditionDescriptor` 418-422）、`src/corrections/rule-template.ts`（model_routing 型）、`src/cli/analyze.ts`（visibility）、各 test。

#### Done（合格基準逐条）

1. model_routing で作業種別が取れない短文（例: 使用強制・使用禁止だけ）は素文適格なら本文＝素文、lifetime=routing（24h）、visibility=owner。
2. 同 topic の逆極性（やめて・使うな）は既存 `stopContradictoryBundles` で disputed＝注入停止。加えて、同一 session で根拠発話の直後5人間発話以内に同 topic の撤回文（`じゃない|ではない|やめて|なし` を含み、モデル名か「都度・毎回・常に」を含む）が来たら反証として束を disputed にする（実例: 同報の1分後に撤回）。復旧・枠切れの報告は規則化・候補化の対象外（命令述語なし）。
3. SessionStart のモデル予約2件と UserPromptSubmit 未到達配送は既存のまま。
4. 24h 失効後に同文が来たら新規候補として再計数（期限切れ束の再開は既存仕様）。

#### レビュー観点
一時の利用枠事情の30日規則化を防止（routing 固定）／モデル名のみの一致による束化を防止／別作業種別の割当（設計は Astra・実装は Sol）は従来の型経路のまま。

#### 検証コマンド（コマンドと期待値）

- `TMPDIR="$PWD/.tmp/tmpdir" pnpm exec vitest run src/corrections/detector.test.ts src/corrections/rule-template.test.ts src/cli/analyze-correction.test.ts` → 通過。新規: 別 session 2回の短文モデル指図で confirmed・owner・expires_at=最終根拠+24h、逆極性で disputed。
- 本番7日: model_routing の confirmed ≥1、確定後に始まった session の SessionStart 本文に到達 ≥1、撤回文で24h 以内に disputed/失効した実例を worklog に記載。
- `TMPDIR="$PWD/.tmp/tmpdir" pnpm exec vitest run src/corrections/store.test.ts` → 新規: 同一分・同文の2 session 根拠は1件扱いで candidate、撤回文で disputed。

### T8 段別処理時間（P6）

触るファイル: `src/observability/correction-metrics.ts`、`src/cli/context.ts`、`src/observability/correction-metrics.test.ts`。

#### Done（合格基準逐条）

1. UserPromptSubmit/SessionStart の metrics 行に `st`（段別 ms: stdin・position・detect・store・retrieve・render・write）を追加。既存キー `ms/tok/miss` 不変、1行256bytes 以内。
2. 日次集計スクリプト（既存 `scripts/maintenance/` に1本）で p50/p95/max を段別に出力。

#### レビュー観点
計測自体による時間増加（Date.now 7回程度）／本文・パスの出力なし。

#### 検証コマンド（コマンドと期待値）

- `TMPDIR="$PWD/.tmp/tmpdir" pnpm exec vitest run src/observability/correction-metrics.test.ts` → 通過。
- 本番反映後3日: 段別 p95 の表を `docs/findings/` の worklog に記載。合計 p95 ≤500ms を満たさなければ最大段を次タスクで修正（修正方法は本書の対象外）。

### T9 確定規則の遵守検査（P7、v12 を伴う、最後）

触るファイル: `src/cli/correction-import.ts`（`--migrate-v12` の受付）、`src/storage/correction-schema.ts`（新表 `owner_correction_violations`: session_id_hash、human_ordinal、bundle_key、version、checker、detected_at）、`src/storage/migration-v12.test.ts`、`src/cli/analyze.ts`、`src/corrections/injection-policy.ts`、新規 `src/corrections/compliance.ts` と test。

#### Done（合格基準逐条）

1. Stop の決定論回収の直後、直前 assistant text（引用・コード除外）を、その session で注入済み（injections emitted）の confirmed 規則と照合。チェッカー3種のみ: tone（常体規則があるのに敬体文末 `です/ます/でした/ました/ません` が2文以上）、document_delivery（全文表示規則があるのに省略標識 `（略）|（中略）|以下略|…省略` がある）、expression_policy（略号禁止規則があるのに `[A-Z]\d+` 形の工程略号が本文にある）。
2. 違反は violations に1行、metrics に `k:"violation"`。
3. 次の UserPromptSubmit で、違反した規則を冷却無視で先頭に再注入（既存 `restore` 経路を使用）。再注入は同 session で規則ごと最大2回。
4. 環境変数 `WASURENAGUSA_CORRECTION_COMPLIANCE=off` で検査と再注入を停止（既定 on）。
5. v12 専用移行は T10 の本番手順で実行。通常 initialize では実行禁止（前ラウンド T4/T7 の契約）。

#### レビュー観点
偽陽性（引用文の敬体、コード中の略号）の除外／再注入は 800 tokens 枠内／LLM 呼出0。

#### 検証コマンド（コマンドと期待値）

- `TMPDIR="$PWD/.tmp/tmpdir" pnpm exec vitest run src/corrections/compliance.test.ts src/storage/migration-v12.test.ts src/corrections/injection-policy.test.ts` → 通過。合成10例（違反5・非違反5）で 5/5・0/5。
- 本番7日: 違反件数、再注入件数、再注入後の同 session 内再違反率を worklog へ。

### T10 再生で before/after、本番反映

触るファイル: `scripts/replay/simulate.mjs`（manifest・compiled-root 引数は既存）、`docs/findings/worklog-<日付>-round2.md`。

#### Done（合格基準逐条）

1. scratch ビルド → archive manifest（T3）で cold 再生を2回: 現行 `main`（T1〜T9 前の commit）と改修後。同じ判定器。出力: 確定束数・確定一覧（目視用）・(a)(b)(c)・注入 tokens・hook 時間。
2. 測定器（T2）の before 値を再掲。
3. 節5の手順で本番反映。
4. 反映後7日の after（測定器・DB 実値・性能）を worklog に追記。

#### レビュー観点
現行 main と改修後を同じ判定器・同じ manifest・同じ scratch 条件で比べているか／評価結果を見て閾値・語彙・regex を触っていないか（触ったら再生をやり直し、本書を改版）／再生DBを本番へ移入していないか／before/after の分母（活動日数・発話数）を併記しているか。

#### 検証コマンド（コマンドと期待値）

- `pnpm exec tsc --outDir .tmp/<sid>/build --declaration false` → 終了0。
- `node scripts/replay/simulate.mjs --manifest .tmp/<sid>/manifest.json --compiled-root .tmp/<sid>/build --scratch .tmp/<sid>/replay --mode cold` → 改修後の confirmed ≥3（現行は0）、誤確定目視 ≤1、UserPromptSubmit 注入平均 ≤200 tokens・p95 ≤650。
- `--mode hook-timing` → p95 ≤500ms、max <4000ms。

## 5. 本番反映の手順と止め方

反映（T10、オーナー y/n 後）:

1. `.env` の `WASURENAGUSA_CORRECTION_LOOP=off`。
2. `cp .wasurenagusa/memory.db .wasurenagusa/migration-backups/pre-round2-<日付>.db`。
3. `pnpm run build`（dist 反映＝全 session の hook が新コードを使用）。
4. T9 を含む場合のみ v12 専用移行 `node dist/cli/correction-import.js --migrate-v12 --apply`（dry-run で DDL 差分を先に表示）。
5. 合成1往復（UserPromptSubmit に短文命令、Stop、別 session_id で SessionStart）で stdout と `owner_correction_*` を確認。
6. firebase-kit で `FORCE_SELFTEST=1 bash .claude/hooks/hooks-selftest.sh --strict`。
7. `WASURENAGUSA_CORRECTION_LOOP=on`。T1〜T8 の順に段階反映可能（各段で 24h 観測）。

止め方（効く順）:

- 全部: `WASURENAGUSA_CORRECTION_LOOP=off`（保存・注入停止、索引は維持）。
- 注入だけ: `WASURENAGUSA_CORRECTION_INJECT=off`。
- 遵守検査だけ: `WASURENAGUSA_CORRECTION_COMPLIANCE=off`。
- 個別の誤確定: `cancelCorrectionBundle`（10-04 の却下で使用実績、`.wasurenagusa/migration-backups/pre-reject-mata-20261004.db` が前例）。履歴を保存し、同文の再候補化を防止。
- コード: 直前 commit の dist へ `pnpm run build`。v12 の表は維持（削除 DDL なし）。
- DB: 退避ファイルからの全体巻戻しは新規記憶喪失のため最終手段。

## 6. 未確認事項

- pending 未照合116のうち keep-alive 以外の14件の不一致理由（11件は hash が退避記録の正規化本文にも生本文にも無い）。T1 後に残れば T8 の理由コードで追跡。
- tone 例外の本番動作: 手元検出の confirmed 5件は全部 go-live 前の発話。本番 tone 候補1件は長い貼付依頼文の中の1文（復帰ブロックではないため貼付除外の対象外）。go-live 後に R8 の再発がなく、未検証。
- UserPromptSubmit p95 800ms の段別内訳（T8 で計測）。
- 注入後に守られない割合の直接値（T9 で初計測）。
- `scripts/replay/simulate.mjs` の archive 由来 manifest に対する引数互換性（T3 で確認）。