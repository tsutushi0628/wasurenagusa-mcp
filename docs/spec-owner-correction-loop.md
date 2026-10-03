# オーナー訂正の検出・保存・注入設計

対象: wasurenagusa の記憶経路のみ。実装者: Codex。コード変更・本番反映は本書に含めず。firebase-kit の助言・拒否 hook、モデル割当、承認権限は変更対象外。本書の配置と形式は T2 の明示指定を適用。

## 1. 漏れの実測と段別の原因

先に中央・ローカルの分断とStop起動不具合を修復、次に検出と本文注入。長会話対策は最後。優先順位の根拠は中央42/42行の未掲載とT1bの起動不具合確認。T1c完了版にも下記の照合制約あり、段別損失の厳密な順位は未確定。旧S3最大説は不採用。B9は範囲内。最終標本4件中、口調への否定疑問3件を節3.1の狭い例外で扱い、希望口調不明のまま全件を候補へ閉じ込めない。

出典略号: `BF` = `.wasurenagusa/reports/replay/baseline-funnel` の `.md` / `.json`。T1c完了版（2026-10-03 08:04:53 UTC更新）を参照。SHA-256: md=`e15d03cd12539309fd909a9c0722298de2fd922a3c861c4407e2f3228da194dd`、json=`34db9c6b441cfbf3886653c8a33f8d5aded8739993014d7074cd59241501ce37`。再更新時は版と母数を再確認。実発話・実記憶本文・個人パスは転記禁止。

| 段・母数 | 信頼できる実測 | 原因・設計への反映 | 出典の項目名 |
|---|---|---|---|
| 入力母数 | 元調査 106 本に対し BF は読取 109 本、採用 98 セッション | 指定ID除外2、期間外8、人間入力0件1。元106本との対応は節7のmanifestで別検証 | BF.json `metadata.sourceFileCount`, `metadata.sessionAudit`, `population.targetSessions`; 元調査 `out-r2-k3.md` 1.1（107本−現在1本） |
| 入力発話 | 本流 1039、割り込み 97、合計 1136 | 割り込み比率 97/1136 = 8.54%。束判定候補1037、引継ぎ60・300字超39を束判定だけから除外 | BF.json `population.mainHumanUtterances`, `queuedHumanUtterances`, `totalHumanUtterances`, `themeCandidateExclusionsByReason` |
| S1 Stop | 2726 回、中央値 341 ms、p90 601 ms、3000 ms 以上 3 回 | T1bでCLI symlink起動不具合を修正済み、dist反映を最後に確認。所要時間だけで全回未到達と断定せず、新hookの性能根拠にも使わない | BF.json `s1.allStop.{count,medianMs,p90Ms,atLeast3000Ms}` |
| S1 保存 | 期間内中央 248 行、ローカル 10 行 | 保存の大半が中央。Stop 保存ローカルと読取 cwd が別経路 | BF.md「期間内の記憶保存件数」; BF.json `memorySaves.central.total`, `memorySaves.local.total` |
| S2 注入入口 | 98 セッション。題名 7 件が 94、6 件が 1、0 件が 3。TypeError 記録 7 | 成功記録と有効本文到達は別。7 件の固定索引では規則本文が届かない | BF.md「SessionStart注入の全体像」; BF.json `injectionOverview.targetSessionCount`, `titleCountDistribution`, `typeErrorAttemptCount` |
| S2 横断可視性 | 中央の対象プロジェクト向け 42 行のうち未掲載 42 行 | 中央にあるのに注入対象外。読取ストア統一が必要 | BF.json `injectionOverview.centralFirebaseKitMemoryRows`, `centralFirebaseKitRowsNeverInjected` |
| S4 発話位置 | 再発候補 301 件中、1–10 発話 190、11–30 発話 83、31–100 発話 28、101 以上 0 | 63.12% が冒頭 10 発話、31 発話以降は 9.30%。冒頭を優先。トークン残量からの推定は不使用 | BF.json `s4.all.ordinal`（101+ 欠落キーは 0） |
| 段別出力（T1c参考、根拠不採用） | S1=37、S2=264、S3=0 | 下記の機械照合値。防止率や優先度の重みに利用禁止 | BF.json `stageCounts`; BF.md「S2・S3 集計」 |

BF初版の保存・注入・再現率は題名の一般語一致を規則趣旨の一致としたため不採用。最終版の文脈量列は累積byte offsetであり残り文脈量ではないため不採用。B3/B4/B6の件数15/5/18は束パターンの観測件数に限定、元調査の許容範囲外で校正済み正解件数には使わない。S4の301は発話位置の母数のみ、元調査の効果上限139へ流用禁止。

T1c完了版の参考値: B1は再発195/保存照合195/他projectだけ0/注入題名記憶0/注入後再発0、B2–B10は再発106/保存照合69/他projectだけ21/注入題名記憶0/注入後再発0（BF.json `summaryTable`）。保存・注入照合を原因確定に使わない理由: `scripts/replay/lib/analysis.mjs:visibleInFirebaseKit` はscope=general/globalだけで別projectを可視扱い、現行 `src/storage/sqlite.ts:search` のproject条件と不一致。`scripts/replay/lib/themes.mjs:matchesMemoryCoverage` は語距離一致で、全文提示と完全形保存、回答と停止、口調の極性を区別しない。現在本文をtimestampだけで過去へ適用する問題も残存。節7の版履歴・決定論の到達判定・独立LLM監査で検証。

元調査の根拠: `firebase-kit/docs/findings/worklog-20261003-owner-confirmation-automation.md`「案3 二度言わせない台帳」、同リポジトリのローカル調査 `out-r2-k3.md`「1.6 同じ注意の繰り返し」。B2–B10 は合計 148 件、9 束なので Σ(束件数−1)=139。規則施行後の再発 37、規則なし 74、部分規則 212 は別集計で加算禁止。B1 は元調査 198 件、worklog の別集計ではモデル・経路指図 182 件 / 61 セッション / 43 セッションで 2 回以上。B1 と B2–B10 の効果表は分離。

T1c「趣旨一致の記憶一覧」から漏れを分離。検出・保存段の漏れ候補16件（B2=4、B3=3、B7=6、B8=3）、横断可視性の漏れ候補21件（B3=11、B4=4、B8=3、B9=3）、計37。計算: `themes[].recurrenceCount - storedAtRecurrenceCount - otherProjectOnlyAtRecurrenceCount` と `otherProjectOnlyAtRecurrenceCount`。記憶行数でなく再発時点の件数。保存なし16件だけで検出器未検出と断定せず、保存経路の停止も含む。

一覧の対応: B7は一致記憶0行、B9は他project6行、B8は可視1/他project2行、B5は可視1/他project4行（BF.md各束「趣旨一致の記憶」、BF.json `themes`）。旧手調べの4趣旨すべて0行という主張は撤回。16/21は同発話の複数束を含む延べ再発、上記照合制約もあり厳密な原因件数へ格上げ禁止。元調査1235発話と今回1136発話の差99は、現物再抽出1202との差33＋選択除外66。33を引継ぎやコマンドへ便宜配分しない（BF.json `population.r2Comparison`）。

T2着手時の追加読取監査では割り込みにもUserPromptSubmit成功例あり。最終BFと入力時点が違う旧件数は不採用。成功stdoutの全呼出保存は未保証、記録不在だけで未発火と断定禁止。全hook記録数と人間発話数は一対一ではない。再生は元JSONL行順と利用可能時刻を保持、UserPromptSubmitだけに依存せずStopでも未処理queued_commandを回収。

## 2. 設計方針の採否

| 順 | 策 | 採否 | 根拠・固定する判断 |
|---|---|---|---|
| 1 | 中央へ保存・読取を統一 | 採用 | 明示中央設定下で統一。中央248対ローカル10、中央対象42/42未掲載。公開のproject既定は維持 |
| 2 | Stop の正常起動・決定論処理を復旧 | 採用 | 最終集計2726回とT1bの起動検証を区別。APIキーより前に発話回収・保存、T1bを含む最終ビルド確認 |
| 3 | 訂正の自動検出・自動保存 | 採用 | 検出・保存漏れ候補16件、B7の一致記憶0行。引用除外・候補状態・反復昇格を併設 |
| 4 | SessionStart の重要規則本文 | 採用 | 94/98セッションが題名7行。owner可視の継続confirmedをキー不問で先頭最大6件 |
| 5 | 発話ごとの関連記憶本文 | 採用 | 再発候補の63.12%が冒頭10発話。常時本文の未到達分を優先し、関連検索最大2件 |
| 6 | 長会話での再注入 | 採用・低優先 | 31発話以降9.30%。31発話、その後30発話ごと。本文最大2件。文脈量トリガは却下 |
| 7 | queued_command の回収 | 採用 | 人間発話8.54%。旧読取監査にも発火例あり、母数を混ぜず通常発話と同型化 |
| 8 | 普通の依頼文の類似反復 | 採用 | 訂正語だけでは初回を拾えない。初回候補保存、2 回目確定、3 回目以降の予防を狙う。初回未確定を効果に数えない |
| 9 | 束ね・重複統合 | 採用 | 元調査で同種題名が表示上限 10 件超。発話再配信は 0 加算、別発話の同束は件数・強度だけ更新 |
| 10 | UserPromptSubmit のローカル埋め込み | 後回し | `LocalEmbedding.initialize` は remote 許可、各 CLI の cold start 時間未測定。5 秒枠には FTS のみ。`searchHybrid` のスコアを閾値に流用しない |
| 11 | Stop LLM による訂正の必須判定 | 却下 | 検出・束ね・順位・形式はコード。キー不在でも全必須経路が成立 |
| 12 | 既存 Stop LLM 分析 | ゲート付き保持 | 復旧だけで従量課金が発生し得る。新ループは既定で呼ばない。既存分析の明示有効化は節10の判断対象。プロンプト改修は今回の必須経路外 |
| 13 | 既存 principles / guards の自動昇格 | 却下 | 記憶の確定と強制規則の承認は別。既存承認ゲートを迂回せず、拒否動作を追加しない |

2026-07-14 の毎ターン注入停止決定は、今回の明示依頼により上書き。旧 40 字以下スキップは復元しない。短い口調訂正・質問対応の指示も処理対象。

Code Reuse Analysis: `getMinimalIndexEntries`、`search` の FTS・短語救済、`save` の content-hash、`lineage`、`estimateTokens`、`enforceInjectionTokenBudget`、`isDirectRun`、カウンタを再利用。`searchHybrid` / local embedding は現行 MCP 経路を維持し新 hook 経路では未使用。既存 `scope` は技術領域。横断可視性を `scope=general` と同一視しない。firebase-kit `src/backend/index.ts` の既存exportはCloudサービス・LLM・認証・CRUD向け、本件のローカルSQLite処理へ導入不要。新規が必要な機能は発話イベント台帳、訂正束、注入履歴と純粋な検出・選択関数。

## 3. 検出と保存

### 3.1 入力と決定論の判定

新規 `src/corrections/events.ts` の `extractOwnerEvent` を本番・再生で共用。対象は origin.kind=human の user text と attachment.type=queued_command / commandMode=prompt の prompt。既知の sidechain、peer、task 通知、system/meta は除外。UserPromptSubmit の stdin.prompt は hook の人間入力として受理。origin 不在の transcript 行は不明扱い、勝手に human と補完しない。

NFKC、CRLF、連続空白のみ正規化。否定・条件・対象語・数値・モデル名を落とさない。system-reminder / IDE 包装、コードフェンス、引用行、引用符内、XML の引用データ領域を検出対象から除外。スラッシュコマンドは先頭 `/[a-z][a-z0-9-]*`、引継ぎ貼付は既存 replay の handoff 判定を共用。本文 2000 Unicode 文字超は貼付候補として自動確定なし。残る独立した非引用文を 1 文ずつ、最大 300 文字で採点。長文の一部を切って命令に見せる処理は禁止。技術サンプル内の禁止形、第三者への依頼、否定例、引用された過去指示は 0 点。

| 条件 | 点 | 適用・除外 |
|---|---:|---|
| 反復を指す副詞・過去指示参照 | +3 | `また` 単独は加点せず、同文中の行動対象と是正述語が必須 |
| AI の既往行動への問い・不一致指摘 | +2 | `なぜ/なんで` と既往述語、または明示的な誤り指摘。技術的な原因質問は除外 |
| 禁止・是正の述語 | +2 | `するな/やめて/しないで/答えて/示して` 等。対象を抽出できる文のみ |
| 継続適用語 | +2 | `今後/毎回/常に/次から`。今回だけ等の期限語があれば継続加点なし |
| 直前 AI 行動との対象一致 | +2 | 直前 assistant の text / tool 名と同じ対象キー。一般語だけの一致は不可 |
| 感情語のみ | 0 | 罵倒・不満の強さだけで内容を作らない |

訂正候補: 4点以上かつ行動対象と是正述語あり。即時確定: 6点以上、直前行動一致あり、規則本文を条件ごと抽出可能。継続適用の明示: 4点以上でも明示命令として確定可能。通常の依頼・単発禁止は2点でも `request_repeat` 候補。対象に対する行動は読めるが有限述語・条件解析の範囲外なら候補限定、反復で未知条件を補完禁止。対象語だけで行動のない断片は不採用。継続根拠なしで恒久規則へ拡大禁止。閾値は節7の調整側だけで検証・固定。

訂正マーカーなしの依頼は、行動述語と対象が取れる場合だけ `request_repeat` 候補。既知対象キーは文体、応答待機、文書提示、表現明瞭性、要約制約、デザイン部品、検証根拠、委譲役割、保存場所、モデル経路。語彙表は合成例でテスト。束キーはtopic_key×規則の動作・必須値×極性×適用境界。条件の細部と発話文字列はキーから除外、根拠へ保持。モデル名だけの一致、全文という単語だけの一致は束ねない。案件限定の単発依頼を横断方針へ一般化しない。

初版の有限語彙表は下表。対象名詞と同文中の述語を組合せ、抽出できた範囲のみ採用。語彙拡張はdetector_version変更と合成テストが必須。未定義の対象・述語・条件は candidate限定、即時確定なし。

| topic_key | 対象語の選択集合 | 行動として抽出する項目 |
|---|---|---|
| tone | 口調、文体、敬体、常体、敬語 | 選択・変更・維持 |
| response_policy | 質問、回答、返答、待機 | 応答・停止・再開の順序 |
| document_delivery | 文書、文章、本文、全文、提示 | 提示する範囲と形式 |
| expression_policy | 言葉、用語、略号、略語、比喩 | 使用・説明・置換 |
| summary_constraints | 要約、字数、文字数、長さ | 制限・解除・順序 |
| design_components | デザイン、部品、フォント、CSS | 維持・再利用・変更 |
| verification | 検証、確認、出典、原本 | 照合対象・根拠提示 |
| delegation_roles | 設計、実装、作業、委譲 | 役割と担当の対応 |
| storage_location | 保存、配置、一時、成果物 | 保存先・保持期間 |
| model_routing | モデル、経路、担当、利用枠 | モデル名/担当名と作業種別の対応 |

加点用の有限パターン: 反復=`再度|再び|繰り返し|前にも|以前にも|前回|また|(?:前|以前)(?:にも|も|に).{0,12}(?:言|伝|指示)`（前表の条件付き）、既往述語=`した|していた|している|なった|使った|出した|変えた|保存した`、不一致=`違う|誤り|無視|守っていない`、是正述語=`するな|やめ(?:て|ろ)|しないで|答え(?:て|ろ)|示(?:して|せ)|出(?:して|せ)|止(?:めて|まれ)|確認(?:して|しろ)|使(?:って|え|うな)|維持(?:して|しろ)|変更(?:して|しろ)`、継続=`今後|毎回|常に|次から`、期限=`今回だけ|この作業だけ|今日だけ|一時的`。第三者主語・条件句があるのに束キーへ保存できない場合は自動確定なし。表は検出初版の限界を意図的に固定し、未知言い換えの見逃しは再生の(a)失敗へ計上。

toneだけの狭い例外: 同じ非引用文の `なぜ/なんで/何で` ＋tone対象語＋既往述語（上表に加え状態述語 `なの/なん/なんだ/ですか`）を、直前AIの口調への否定として採点。敬語・敬体・ですますの対象と、直前assistant textの敬体判定が両方成立した場合だけ、既往行動への問い+2、禁止・是正+2、直前行動一致+2=6点。生成する規則の動作はオーナー向け応答の常体指定、本文は下表のtone型で構成。根拠は次の文末判定のみ。問いの口調から希望スタイルを自由生成せず、敬意の否定・乱暴な表現へ拡大しない。

敬体判定: 同一sessionで直前人間発話から今回発話までの、最後の非空assistant textを取得。引用・コード・system領域を除外、句読点と改行で文を区切り、末尾の閉じ括弧・Markdown装飾・空白を除去。文末が `です/ます/でした/ました/ません` のいずれかに一致する文が1つ以上なら敬体使用あり。対象語はあるが一致文0、直前文取得不能、問いが第三者・成果物の引用文に向く場合は確定しない。一般的な口調・文体だけの問いや逆方向の変更は候補限定。今回だけ・特定成果物の条件がある場合はその範囲を保持。継続語なしの初回確定はproject可視・30日期限、独立session反復で一般対象が一致した場合のみ節5のowner可視条件を適用。

T1c完了版の無作為抽出引用を採点。入力はBF.mdの各束に載る30字以内の引用、引用内の切れた末尾は独立命令として補完しない。各標本を既存記憶・反復根拠なしの初回として採点。tone例外以外の直前行動加点は付けず、当該束の趣旨外の命令は不採用（他束での検出とは別）。引用・個人ID・発話本文の転記なし。これは設計の適用確認であり、節7の独立監査・通し再生の成功数ではない。

| 束名 | 評価件数 | confirmed | candidate | 不採用 | 決め手の条件 |
|---|---:|---:|---:|---:|---|
| B5 全文を出す指示 | 10 | 0 | 9 | 1 | 完全文の提示依頼9件は是正2点または未知述語の候補。継続・直前行動根拠なし。画面構造の確認1件は全文提示の対象外 |
| B7 Codexは作業だけ・設計は自分で | 7 | 0 | 3 | 4 | 役割の禁止・条件付き許可・担当指定3件は候補。未定義の使役述語や切れた条件から完全規則を確定せず。残り4件は利用枠・一般委譲等で設計分担の趣旨外 |
| B8 質問に答えて止まる | 7 | 0 | 7 | 0 | 完結した回答命令4件は是正2点、残る3件は未定義述語・条件・切断文で候補。回答だけの命令から停止まで補わず、切れた過去指示を新たな停止命令にしない |
| B9 敬語・口調（例外適用前） | 4 | 0 | 3 | 1 | 否定疑問3件は希望口調の明示なしで候補止まり。文体の追加指定1件は行動なし |
| B9 敬語・口調（例外適用後） | 4 | 3 | 0 | 1 | 疑問3件すべて直前assistantに敬体文末あり、2+2+2=6点で確定。行動なし1件は不採用のまま |

採点元: BF.md「B5」222–231行、「B7」286–292行、「B8」304–310行、「B9」324–327行。B9の疑問3件をBF.jsonのsession・行位置から元JSONLへ照合、各発話の最後のassistant textで非引用の敬体文末1件以上を確認。最後の1文だけでは1件の敬体使用を落とすため、上記の文単位判定。希望口調不明による全滅は例外適用前3/3、適用後0/3。

改善後の束単位: 同じtopic_key・同じ極性・同じ規則動作と必須値なら、言い回し・条件の細部が異なっても同束。Dice 0.85と条件全文一致を統合条件から除去。対象・動作の有限分類は下表の型IDへ正規化、語の近さだけで動作を混同しない。適用境界＝project/scope、宛先、案件限定、期限種別、taskのsession。既存のowner可視への昇格条件は節5のまま。unknownは正規化した同文のみ候補として照合、既知topicとの統合・確定・注入なし。B1–B10は評価用ラベルのまま。

条件の保全: 発話ごとの条件をevidenceへ保持、規則の適用範囲は根拠の条件分岐の和集合。条件A/条件Bの反復から無条件規則を作らず、AまたはBの場面だけ同じ動作を適用。未解析条件は反復数へ加えても確定根拠には不算入。数値上限・単位・比較方向、停止の有無、保存先、モデル名等の行動結果を変える値は必須値として別束。逆極性、別宛先、別案件、今回限定の別sessionも分離。条件分岐を240文字以内の完全規則で表せなければ候補維持、条件を削って確定禁止。

model_routingは作業種別×完全なモデル識別子×極性で分離。1文に複数割当なら対ごとに最大3束、同じモデルでも設計とレビューは別束。モデルの版・派生名を短縮しない。作業不明の利用指示は候補限定。同じ作業・適用範囲で矛盾する割当は統合せずdisputed、異なる作業の割当は相反扱いしない。

規則文は新規 `src/corrections/rule-template.ts` の決定論関数で生成、detectorとstoreが共用。入力＝型ID・動作・極性・必須値・適用条件・継続根拠、出力＝完全な規則または型不成立。非引用の指示述語と必要な値を抽出できる場合のみ成立。質問・相談の中の動詞だけでは不成立。toneの既往行動照合例外は上記条件のまま、一般の質問文へ拡張なし。LLM生成・生発話のコピー・不足値の推測なし。

| topic_key | 規則文の型・分離する動作 |
|---|---|
| tone | `{宛先}への応答は{明示された文体}で書く`。既往行動照合例外だけ常体を決定可 |
| response_policy | `質問に回答する` / `質問に回答してから停止する` / `指示まで待機する`。回答指示から停止を補完禁止 |
| document_delivery | `{対象文書}は{全文/指定範囲}を表示する`。文案・報告への継続適用根拠がある場合の型例: `文案・報告は毎回全文を表示する` |
| expression_policy | `{指定用語}を説明する` / `{元の表現}を{指定表現}に置き換える` / `{指定表現}を使わない` |
| summary_constraints | `{対象}を{数値・単位・比較方向}に収める` / `{対象}の字数制限を解除する`。異なる上限・解除・処理順序は別動作 |
| design_components | `{指定部品}を再利用する` / `{指定部品}を維持する` / `{指定対象}を{指定値}に変更する` |
| verification | `{対象}を{指定原本}と照合する` / `{対象}の検証根拠を提示する`。確認の担当を相談する文は不成立 |
| delegation_roles | `{作業種別}は{指定担当}に任せる`。設計と実装の担当を別々に保持 |
| storage_location | `{成果物種別}を{指定保存先}へ保存する` / `{成果物種別}を{指定期間}保持する` |
| model_routing | `{作業種別}には{モデル識別子}を使う` / `{作業種別}には{モデル識別子}を使わない` |

各型へ抽出済みの適用条件を前置、否定は型ごとの禁止動作へ変換。解釈できない否定・条件・値は型不成立。毎回等の継続表現は根拠がある場合だけ付与、単発反復だけでは追加なし。生発話はevents.excerptと元位置、条件と型入力はevidence.conditionsへ別保存。型不成立のcandidate.rule_textは空文字、memories未作成。新規DDL不要、既存TEXT列の条件JSONに型入力を格納。bundle.condition_keyは規則動作・必須値・適用境界の正規形、versions.conditionsはその時点の有効条件分岐を保持。

### 3.2 記録と追記型スキーマ

現在のスキーマはv10。`migration-v11.test.ts` と `migrateV10ToV11` を追加。memoriesの既存列・MCP入出力型は維持。新規8表のDDLは `src/storage/correction-schema.ts` に集約、新規隔離DBと専用移行から共用。通常 `initialize` と `initializeSchema` の両方で既存v10へのcorrection DDL・v11版数更新を禁止。通常MCP読取からも先行移行なし。v1〜v10の既存移行は維持、v11済みDBは再利用、新規DBのv11作成は明示の初期化経路だけ。本番v11適用は承認後のT25専用移行、scratchはT4/T7の試験で明示初期化。

| テーブル | 必須列・制約 |
|---|---|
| `owner_correction_events` | `event_id` PK、`session_id_hash`、`source_uuid_hash` nullable、`human_ordinal`、`observed_at`、`available_at`、`source_kind` = user / queued_command / hook / legacy_import、`excerpt` 最大120文字、`previous_action` 最大160文字、`action_first_locator_hash`、`action_last_locator_hash`、`project`、`scope`、`raw_text_hash`、`source_locator_hash`、`processed_at`。発話単位、bundle_keyを持たない |
| `owner_correction_evidence` | PK(`event_id`,`bundle_key`)、双方FK、`source` = utterance_detection / request_repeat / legacy_import、`score`、`detector_version`、抽出した条件・極性。1発話最大3束、束ごと1根拠 |
| `owner_correction_pending` | `receipt_id` PK、`session_id_hash`、`received_at`、`last_confirmed_ordinal`、`raw_text_hash`、秘密検査済み抽出結果最大3件、取得済み前行動位置、`matched_event_id` nullable、未照合出力のepoch/order/版/hash/callback成功時刻。未照合hookの保管、反復数に加算しない |
| `owner_correction_bundles` | `bundle_key` PK、`memory_id` UNIQUE nullable、`rule_text` 最大240文字の完全な条件付き規則（型不成立candidateは空文字）、`topic_key`、`polarity`、`condition_key`、`project`、`scope`、`visibility` = project / owner、`status` = candidate / confirmed / expired / rejected / disputed、`intensity` 1–5、`occurrence_count`、`session_count`、`first_seen_at`、`last_seen_at`、`expires_at` nullable、`lifetime_kind` = explicit_continuing / inferred / task / routing、`continuation_basis`、`confirmed_at` nullable、`version`、`counterevidence_event_id` nullable、`last_confirmation_asked_at` nullable、`confirmation_state` = none / offered / answered |
| `owner_correction_versions` | PK(`bundle_key`,`version`)、完全な `rule_text`・body_hash・条件・極性・visibility・status・confirmed_at・expires_at・lifetime_kind・continuation_basis・根拠event_id集合・`effective_from`・変更/失効/取消理由。更新・取消・期限変更ごとに追記。過去版の有効終端は次版effective_fromと当該expires_atの早い方で復元 |
| `owner_correction_sessions` | `session_id_hash` PK、`human_ordinal`、`transcript_offset`、`transcript_identity`、`compact_epoch`、`last_refresh_ordinal`、`last_seen_at`。カーソルと通し番号は原子的更新 |
| `owner_correction_injections` | UNIQUE(`session_id_hash`,`compact_epoch`,`bundle_key`,`version`,`human_ordinal`,`trigger`)、版へのFK、`emitted_at`、`output_order`、`body_hash`、`output_hash`、`token_estimate`、`trigger` = start / prompt / refresh / compact、`body_included`、`stdout_status` = emitted / failed。本文はversionsを参照。body_hashは完全規則本文、output_hashは最終stdout全体のSHA-256 |
| `owner_correction_imports` | UNIQUE(`source_store_hash`,`source_memory_id`)、`target_memory_id`、`imported_at`、`source_timestamp`、`source_content_hash`。取込時刻と原根拠時刻を分離 |

event_idはsession＋transcript UUIDのSHA-256、UUID不在は一意な元JSONL位置。context/Stop共通の有界増分読取で前人間発話とその後のassistant text/tool_useを保持。直前AI行動は今回発話より前の区間に固定、Stop時の訂正への応答を代用禁止。hookに対応行が未出現ならpendingへ保存、次のhook/Stopで全文hash・順序・元位置を一対一照合。前行動取得不能はaction_unknown、行動一致による即時確定不可。完全な継続命令の別採点は利用可、ただしevent_id未照合の間は根拠を確定保存せずpendingに保持。

未照合の検索・冷却は最後の確定通し番号を参照。UUIDまたは元位置確定後、同一transactionでeventsへ1行、evidenceへ最大3行、通し番号を1回更新しpendingを対応済みにする。既存eventへの再配信は通し番号0加算、同じ(event_id,bundle_key)は根拠0加算。同文別UUIDは別発話。同文連投・並行hookで照合不明ならpendingのまま、推測で反復昇格禁止。未照合hookの出力はpending receiptにoutput_order/hashとともに記録し、確定ordinalのinjectionsへ偽装しない。一対一照合後だけ実出力時刻を保持してledgerへ結び、対応不能は(c)未判定。

excerpt はローカル運用 DB の出典用。公開 fixture へ出さない。秘密値・個人パス・連絡先を保存前に既存の秘密検査方式で伏せる。伏せた結果だけから規則を再構成できない場合は候補のまま、注入しない。previous_action は LLM 要約なし。直前 tool 名・結果種別または非引用 assistant 文の対象句をテンプレート化。断片しか取れなければ `action_unknown`。推測した失敗理由は保存禁止。

### 3.3 昇格・重複・反証

初回 candidate は memories に保存しない。confirmed への遷移時だけ `SQLiteStorage.save` で dont / 1 束 1 行を作り、bundle と memory_id を同一トランザクションで結ぶ。既存 memories.state は active を維持、候補状態を既存 state に混ぜない。確定は観測済みの記憶としての確定であり、principles.approved や guards.active を意味しない。

同じbundleの独立発話はoccurrence_count +1、別sessionはsession_count +1、intensity = min(5, max(既存値, 1+floor(score/2)) + 反復時1)。同(event_id,bundle_key)は0加算。条件全文一致でevidenceを絞らず同束の根拠を読む。規則は有効な根拠集合から再生成、最後の発話による本文上書き禁止。rule_text・条件・有効性に変更なしならcountのみ更新、本文・期限・状態の変更はversion +1と完全snapshot追記。条件の細部追加は同束の条件分岐追加、動作・必須値・極性・適用境界の変更は別束。相反は両方disputedで自動注入停止。versionsの根拠参照と注入履歴は7日監査・時点再生に必要な期間を保持、イベント詳細を30日で除去しても版の出典hash・有効区間は維持。

確定の共通前提: 既知topic、指示述語あり（toneの限定例外を除く）、型と全必須値が成立、適用条件を欠落なく表現、秘密値なし。unknown・相談・質問・型不成立は即時/反復/明示ID確定の全経路でcandidate維持、注入0。detectorの判定に加えstoreでも同じ型関数で検査、反復2回だけで安全条件を迂回禁止。

共通前提を満たす根拠について、(a) 即時確定の採点条件、(b) 同束の独立発話2回が30日以内かつ反証なし、(c) オーナーが当該規則IDを明示して確定、のいずれかで昇格。(b)は条件の細部が違っても計数、共通動作と保持した条件分岐だけを確定。今回だけの依頼はセッション終了時失効、owner可視へ昇格禁止。

期限: 通常候補7日、反復照合用の最小イベント情報30日。明示継続命令は `explicit_continuing` / expires_at=null、取消・相反まで有効。project/owner可視性とは独立。反復由来・tone例外初回・案件限定の確定は `inferred` で最終根拠から30日、今回だけは `task` でsession終了。model_routingというtopicだけでは24時間へ分類せず、一時的な利用枠・代替経路の明示がある場合だけ `routing` / 24時間、より短い明示期限があればそちらを優先。一般の反復割当はinferred、継続指定はexplicit_continuing。継続語・一般対象・期限語の根拠を保存、単発反復から無期限へ拡大禁止。異なる期限種別は別束。同一条件の反復では最終根拠から期限更新、異なる条件分岐を同束に持つ場合は各分岐の期限の最短を束のexpires_atへ保存。短期条件を長期条件へ引き延ばさず、失効時は束全体を停止。分岐別の動的注入は追加しない。

キーとdetector_versionをv2へ更新。旧scratch束は改善率の算出へ混在させず、各分割を空DBから再生。既存v1のconfirmedを生本文のまま注入禁止。今回の再生後DBは診断専用で本番へ移入しない。旧版と到達台帳は改変せず保持、本番v10からの導入境界はT25のまま。今回の設計作業でDB更新なし。

7日経過candidateはexpired、30日内の独立発話で同束再開・根拠2件の昇格可。rejected/disputedはこの経路で再開禁止。参照・注入では期限延長なし。明示取消は即rejected、相反はdisputedとして停止版を追記。曖昧な反証は1束7日1回、全体でも7日1問を上限に確認候補。hookは停止せず、次の通常応答向けに規則IDと条件を確認する1問を提示。最大100文字、発話800tokens内で規則1件を置換。stdout成功後offered、未回答はdisputed維持。回答は非引用本文の規則ID＋操作（確定/取消/条件変更）を必須、単独肯定は不可。回答時answered、条件変更は新versionと再判定。承認権限や課金許可の獲得に記憶を利用禁止。

## 4. 注入とトークン予算

注入対象: 節3の型が成立したv2のconfirmed、有効期限内、元 memories が active、visibility の一致、disputed / rejected でないもの。unknown・型不成立・旧版の生発話本文は除外。出典と適用条件を付けたrule_textを表示。引用データが上位規約を上書きしないことを固定ヘッダーに明記。既存 principles / 最小索引の機能は維持。

### 4.1 選択・検索・冷却

開始時の選択順は本節で節2の概要を更新。合計6件を維持し、モデル規則の予約を常時規則の巡回より優先。

常時規則＝継続適用の根拠を持つowner可視のconfirmed規則。topic_keyの3種固定を廃止。B4のデザイン部品、B5の全文提示、B7の役割分担も同じ選択対象。継続根拠は明示継続命令、明示ID確定、または30日以内の独立session反復で一般対象・行動・条件が一致する根拠。案件固有・製品固有の規則はproject可視を維持。限定条件があるowner規則は条件を本文に残し、適用場面外の実行を要求しない。

SessionStart: 合計6件の内側でmodel_routingへ最大2件を先に予約。対象はowner可視または当該project/scopeに可視な、作業×モデルの型が成立した有効な確定規則。project規則をownerへ変更せず、条件と期限も維持。残枠は常時規則をtopicごとに1件ずつ、次いで同topicの2件目、その他project規則の順。モデル規則が0/1件なら空く予約枠を他へ返す。各群はintensity降順、独立session数降順、last_seen降順、bundle_key昇順。同じbundle/versionを二重選択しない。新規session・clear・resumeで1回、同session/epoch/startの再起動は抑止。

未到達配送の集合＝常時規則＋可視な確定model_routing。6件・本文1800tokens超過だけでなく、開始後の確定・更新も対象。同session/epochで成功出力のない版を台帳から算出、次のUserPromptSubmitで検索語一致なしに最大2件ずつ配送。残りは後続発話へ、失効・取消分は除外。合否表に開始時欠落件数・全件到達までの発話数を表示。モデル規則なしではB4/B5/B7を含む異なる6topicの開始到達、モデル規則ありでは予約と後続配送を検証。7件以上・開始後確定・compact復元も必須。

UserPromptSubmit: 2000文字までの非引用本文から対象語最大8個と既知topicを抽出。`SQLiteStorage.search` のFTS phrase→AND→ORと2文字CJK救済を利用。型の対象語（文案・報告等を含む）でtopicを特定できた場合は、可視な同topicの確定束もSQLで取得。topic一致候補を優先してFTS候補とmemory_idで統合、project/owner各最大20・合計最大40。モデル名・ツール名だけではtopic一致経路を開かず、model_routingは作業種別も照合。owner検索で他projectの一般記憶を取得禁止。

常時規則も関連分へ含める。現行 `retrieval.ts` のalwaysOnKeysによる関連候補除外を廃止、開始時出力済みという理由だけで検索から落とさない。同一発話の復元/定期/関連はbundle/versionで重複除去。常時規則すべての毎発話再掲にはしない。

型の対象・動作からtopicを特定でき、必要な適用条件も一致する候補はR=1。文字長の足切りより先に判定。topic不明のFTS候補だけ R = 0.6 × 対象語一致率 + 0.4 × 非引用queryとruleの文字bigram Dice、R>=0.55かつ3文字以上の対象語1個一致、または独立した2文字対象語2個一致を要求。モデル名・ツール名だけの一致は不採用。R降順、intensity降順、last_seen降順、bundle_key昇順。FTS rankは候補取得専用。関連度閾値は未到達配送・復元へ適用しない。未到達分・定期分・関連分がすべて0なら空出力。

同session/epochの同bundle/versionは成功出力から10人間発話の冷却。常時規則にも同じ冷却を適用、関連分では冷却後の一致発話で再提示可。人間発話番号はqueuedを含み、tool/assistantで増やさない。内容更新・再訂正・反証解消なら冷却解除。現在の再訂正への注入を、その訂正を防いだ件として数えない。

再注入: 31, 61, 91…発話時。常時規則から最終注入が古い順に最大2件交代選択。2件以下なら同規則の再注入可。31の根拠はS4の31発話以降28/301、30間隔は同じ母数区切りに合わせた初期値。11発話での全件再掲は不採用、11–30の83件へは開始時本文・未到達分配送・関連検索で対応。

PreCompact: stdout到達は未確認、(c)成功根拠から除外。epoch更新予約と小量再掲だけ。SessionStart source=compactで新epochを確定、開始時と同じ6件枠・モデル予約で復元。記録なしなら次のUserPromptSubmitでepoch確定、常時/モデル規則の復元を関連分より優先して最大2件、残りは後続発話へ。旧epochの冷却・到達実績は使わない。全件復元前の欠落を成功扱いせず、実際の後続出力から計上。

### 4.2 件数・文字数・概算トークン

文字数は Unicode code point。240 文字を超える規則は句点・条件節を含む完全な一規則を選べる場合のみ縮小、否定・条件を切る場合は注入対象外。表示 ID・題名・ヘッダー込みで `estimateTokens` による実出力値を最後に検査。

| 経路 | 本文件数上限 | 1件文字上限 | 本文総文字上限 | 新規本文ブロック上限 | 全出力上限 | 根拠 |
|---|---:|---:|---:|---:|---:|---|
| SessionStart / source=compact | 6（内2件までモデル規則予約、残枠は常時優先） | 240 | 1440 | 1800 tokens | 8000 tokens | 既存8000の22.5%を本文へ予約 |
| UserPromptSubmit の関連分 | 2 | 240 | 480 | 650 tokens | 下行との共通上限 800 tokens | 全文常時注入を避け、既存 8000 の 8.125% を関連分上限 |
| 常時/モデル規則の未到達分 / compact後復元 | 2 | 240 | 480 | 650 tokens | 関連分と合算800 tokens | 語一致不要、復元優先。収まらない分は後続発話 |
| 発話31以降の定期再注入 | 2 | 160 | 320 | 450 tokens | 関連分と合算800 tokens | 再発の9.30%向け |
| PreCompact | 2 | 160 | 320 | 450 tokens | 450 tokens | 既存8000の5.625%以内。次epoch到達とは区別 |

UserPromptSubmitの優先順は常時/モデル規則の未到達・compact復元→定期分1件予約→関連分。最大3件・本文640文字・全出力800tokensを同時制約。完全規則単位で落とし、未到達分は未配送のまま保持。最低1規則も入らない環境予算では0件、stderrと計数のみ。省略マーカーすら収まらなければ空出力。部分文を出さない。

SessionStartの割当: 新規本文1800、既存最小索引・承認原則最大5000、補助最大1200、合計8000。環境予算が小さければその値を全体上限に本文→承認原則→索引→補助の順で充当、大きくても本文上限は不変。最小索引は既存50件。既存 `enforceInjectionTokenBudget` は既存索引部分だけに限定、規則本文へ行単位切詰めを適用禁止。最後にヘッダー・ID込みの完全な項目単位で全体を実測し、上限まで低優先項目を除外。ledger対象ID/version/body_hashはこの最終文字列に残った規則だけから確定。

平均は未計測。節7で 0 件発話を含めて測定。設計上の合格線: 発話ごとの平均 <=200tokens、p95 <=650、最大800。SessionStart を含む全注入平均も併記し、分母を全人間発話とする。31発話以上の定期分の長期平均上限は 450/30=15tokens/発話。開始分を含む平均はセッション長に左右されるため実測値を必須表示。目標超過時は閾値を評価データへ過適合させず、実装の重複・冷却・上限欠陥を先に確認。

## 5. 保存先・読出し先の単一化

中央化は絶対パスのMEMORY_DIRを環境変数かパッケージ直下.envに明示した場合だけ。そのモードでは中央を新規書込・読取の唯一の正本。公開既定は維持: MEMORY_DIR未設定なら `<projectRoot>/.wasurenagusa`、相対なら `<projectRoot>/<MEMORY_DIR>`。相対指定をエラーにしない。パッケージのnode_modules配下を保存先として自動選択しない。

共通resolver `src/storage/resolve-store.ts:resolveHookStore` の入力はprojectRoot・実行ファイルURL・起動時の環境値・ホームディレクトリ。非空の環境MEMORY_DIRを最優先、未設定/空ならbinのrealpathから特定したパッケージ直下.envのMEMORY_DIR、それも未設定/空なら `~/.wasurenagusa/.env` のMEMORY_DIR（改修前の config.ts が dotenv で読んでいた順。司令塔裁定 2026-10-03: 公開利用者の後方互換を優先し、ホーム.envの採用除外は撤回）。どれも未設定/空なら既定。値が絶対なら中央、相対ならprojectRoot基準。環境の相対値がパッケージ.envの絶対値より優先。引用符・空白はdotenvのparse相当で解釈、変数展開・shell実行なし。

resolverはdotenv.configでprocess.envへ流し込まず、読取辞書の1キーだけを参照。`src/config.ts:getMemoryPath` も同じresolverへ接続。既存.env読込でMEMORY_DIRが後からprocess.envに混入しないよう、このキーを除外して他キーだけ既存設定へ反映。ホーム設定のMEMORY_DIRもresolverが同じ1キー読取で扱い、import順に依存しない。その他のキーの優先順は変更しない。MCP/hookの未設定・相対指定のproject保存契約を保持。

この機材の中央化はT25でgitignore済みパッケージ.envのMEMORY_DIRだけを中央の絶対パスへ変更。変更前のキー状態を非追跡の導入証跡に記録、取消時は同キーだけ復元。settings無変更。MCPと全hookの解決結果が同じrealpathか事前検証、不一致なら有効化しない。検証出力は参照名・一致成否だけ。scratchは絶対MEMORY_DIRを明示、パッケージ保存先推定なし。

visibility=ownerは応答文体・提示形式・一般方針に限定。projectは根拠project、scopeは既存技術領域を保持。特定製品・ファイル・案件・期限・担当条件はprojectまたは限定条件を維持。dont/generalだけで横断化禁止。owner許可は①明示継続命令＋一般対象、②規則IDの明示確定、③独立session2つ以上で一般対象・行動・条件の一致した反復根拠、のいずれか。③は有限30日を維持、複数案件の単発依頼を一般方針へ拡張禁止。各根拠をcontinuation_basisへ保存し、他project由来も同条件で候補化。

既存ローカル記憶のimportは新CLI `wasurenagusa-correction-import` へ明示した入力DBだけ。既定dry-runは入力・中央ともreadonly、initialize/DDLを呼ばない。入力と中央のrealpath一致は拒否。`--apply` はT25承認後のみ、本番入力の削除・更新なし。active記憶をcontent-hash/project/scope/categoryで照合、重複は既存行の全列を変えずimports対応だけ追加。異内容ID衝突は新ID、新規行は原timestamp・状態・条件を保持し取込時刻と分離。原記憶の忠実な移入と訂正候補化は別判定。

通常 `save` は重複時更新と時刻再採番があるためimportに流用禁止。内部専用import APIを同じSQLiteStorage transactionへ追加、MCPのSaveParamsは不変。同一source IDの内容が前回import後に変化した場合は衝突として停止し、黙って既存対応を上書きしない。同一入力の再実行0追加、既存重複行の全列不変、原時刻保持を試験。ベクトル再生成・ネットワークなし。

中央の既存 dont も、語だけで confirmed にしない。rule_text / positive_action の完全な条件を抽出でき、継続意図が検証できるものだけ legacy_import 候補。既存 principles の owner_confirmed 根拠か、独立した2出典があれば確定。一般化・出典確認不能な既存行は索引のまま。既存本文への memory_get_detail は維持。横断の文体・方針候補は project に関係なく抽出するが、注入は確定後のみ。

移行漏れ検証: ローカル10行の対応先または重複先、中央対象42行の検索対象化を全件確認。実運用集計はローカル、公開fixtureは合成値のみ。hookはモードを問わず既存DBだけを開き、不在・権限不足は失敗。明示中央の不在を別のcwdローカルDB作成で置換禁止。

## 6. hook の契約

settingsのイベント配線・timeout・matcherは維持。外側は `~/.claude/hooks/wasurenagusa-context-skip-short.sh` の本文だけ差替。stdinをそのまま `wasurenagusa-context` へ渡し、40字足切りなし。binは単一プロセス、最終文字列までstdoutへ書かない。wrapperは再bufferせず、binが制御を返した場合はexit0。外側5秒timeoutが殺した場合はstdout破棄・Claude継続の既存契約、wrapperのexit0を保証したと扱わない。supervisor/worker・IPC・毎発話の子プロセス起動は採用しない。ヒアドキュメント・here-string・一時ファイル不要。

| bin / 入口 | 変更 | stdin | stdout | settings枠 / 内側期限 |
|---|---|---|---|---|
| `wasurenagusa-context` SessionStart | 中央読取・限定本文・履歴 | session_id, cwd, hook_event_name, source。transcript_path は照合用 | 文脈に入る限定本文と既存索引。JSONのログ混入禁止 | 5秒 / 3500ms |
| 同 UserPromptSubmit | 検出・束保存・関連検索 | 上記 + prompt。UUIDは任意、欠落時の対応付けは節3 | 最大800tokens。通常0件なら空 | 5秒 / 3500ms |
| 同 PreCompact | epoch予約・限定再掲 | 上記、source不要 | 最大450tokensの再掲 | 15秒 / 3500ms |
| `wasurenagusa-analyze` Stop | 未処理人間発話の決定論回収を最初に実行 | session_id, cwd, transcript_path, stop_hook_active | 空。診断はstderrのみ | 30秒 / 決定論2500ms、LLM有効時も総25000ms |
| `wasurenagusa-pretool-guard` | 変更なし | 既存 tool入力 | 既存契約 | 10秒 / 既存。新記憶から guard を生成しない |
| `wasurenagusa-correction-import` 新規 | 非hook移行CLI | stdinなし、`--source`、`--apply` | 件数と匿名化した対応集計 | hook枠外。最終反映のみ |

stdin上限1MiB、JSON型とイベント列挙を検証。bin入口で時計を開始、非同期stdin待ちも含め3500msを処理期限とし、入力→差分読取→保存→FTS→選択→描画の各段の前後で残り時間を確認。300msを最終出力・履歴用に予約し、残りが足りなければ新たな段へ入らず空stdoutで返す。内部4秒回収を同期停止まで保証しない。同期SQLite/I/O停止はsettingsの5秒timeoutが最終境界、Promise.raceで中断できると扱わない。性能の合格は節7の外側時計によるcold実測で確認。

DB busy_timeout=100ms、候補40件と増分読取上限を維持、transaction内ネットワーク・モデルロードなし。hookは `SQLiteStorage.openExistingForHook` のfileMustExistで開き、v11と必要表をSELECT確認。initializeのDDL・migration・sqlite-vec loadは禁止。不在/旧版はstderrと空stdout、本番の事前移行はT25だけ。内部関数はthrow、hook境界だけが原因コードをstderr・計数へ出してexit0/空stdoutへ変換。contextの開始時を含めAPIキーがあっても既存backfill spawn・embedding/LLM初期化を呼ばない。LOOP=offの索引経路も同じネットワーク0契約、v10の既存索引をDDLなしで読める既存専用openを用意。

UserPromptSubmit: 同一プロセスでイベント照合→訂正判定→束保存→選択→最終予算検査、stdoutを最後に1回だけwrite。write callback成功後だけ最終本文のID/version/hashを注入台帳へ記録。EPIPE・callback失敗はemitted禁止。残時間と100ms busy枠で履歴を確定、失敗はledger_unknownとして別計数し、出力を撤回・再送しない。書込後の外側timeoutではstdoutが破棄され得るため、台帳のemittedだけで実到達成功にしない。再生・7日監査はhook_successの本文hash/版との一致、timeoutでないことも要求。履歴不明・記録欠落は(c)未判定。過去発話への遡及適用禁止。

context/Stop共通差分読取: 1回上限2MiB・200人間発話、contextは3500msの残時間内、Stop決定論は2500ms。上限到達は処理済みの完全行までcursor更新、次hook/Stopで継続。切れたJSONL末尾は再読、ローテート・短縮はファイル同一性を確認しevent_id重複抑止付きで先頭再走査。前人間発話境界とassistant位置を区間状態に保持、今回訂正後の応答を混ぜない。差分不足・action_unknownを計数。

Stopはstop_hook_active/scheduler抑止を維持、APIキー検査より前に未処理人間発話・queued・pending照合を処理。直近50件×500字はLLM入力だけの制限、決定論抽出へ適用しない。

停止スイッチ: `WASURENAGUSA_CORRECTION_LOOP=off` で新規検出・本文注入・新規台帳更新を停止、既存索引は維持。`WASURENAGUSA_CORRECTION_INJECT=off` は観測保存のみ。`WASURENAGUSA_STOP_LLM=off` が既定、有効化は `on` と課金承認の両方が必要。APIキー存在だけでは承認と扱わない。既存LLMの利用を承認した場合も、訂正をLLM成功に依存させない。Stop LLM拡張時は決定論層へ計数・分類・重複判定を移し、System+Userの指示本文100行以下、出力の新規事実は入力との差分で警告・候補保留。自然言語の業務判断を文字完全一致でthrowしない。

可観測性: `src/observability/counters.ts` の名前型へ `correction_input_total`, `correction_queued_total`, `correction_candidate`, `correction_confirmed`, `correction_dedup`, `correction_rejected`, `correction_conflict`, `correction_store_error`, `correction_backlog`, `correction_injected`, `correction_cooldown_skip`, `correction_budget_skip`, `correction_hook_timeout`, `correction_hook_ms`, `correction_tokens`, `correction_llm_call` を追加。イベント種別ごとの時間・token標本は別の数値計測モジュールで構造化し、既存カウンタJSONL形式は壊さない。発話本文・絶対パス・秘密値はログ禁止。DBのハッシュID、detector_version、reason_code、数値のみ。stderrは1失敗1行。観測失敗自体は既存write_failureへ記録。

数値標本の上限: hookイベント種別ごと1日1000件、1件256bytes以下。JST日付別JSONL、上限後は総数と省略数だけ計数。保存先は解決済みストアの `logs/correction-metrics/`、保持30日。T17に統合した計測モジュールが専用領域だけを回転、既存ログ不変。標本省略日のp95は全件統計とせず、隔離再生の全件値で導入合否判定。追加理由コードはaction_unknown、pending_unmatched、always_not_emitted、ledger_unknown。外側timeoutで内部記録が残らない場合は外側実測/失敗記録から計数。

## 7. 効果の測り方: 再生と「防げた」の定義

`scripts/replay/simulate.mjs` と実処理 `scripts/replay/lib/simulate-engine.mjs` を改修。本番と同じTypeScriptのイベント抽出・検出・保存・選択・予算コードを実行。`pnpm exec tsc --outDir .tmp/<session_id>/replay-build --declaration false` でscratchへビルドし、生成JSをimport。本番distは読み書きせず、ネットワーク・実ストア書込・モデルdownload禁止。中央ストアはreadonly SELECTのみ、本ラウンドの初期記憶投入なし。本番secret・本文を追跡fixtureへ出さない。

正しい母数は対象期間内に人間発話がある98session。元調査の106本は当時のファイル総数107本から現セッション1本を引いた値で、日付による絞り込みなし。期間母集団との差を不足ファイル扱いしない。元定義の出典はBF.json `metadata.r2Definition`・`population.r2Comparison`、節1の `out-r2-k3.md`。B2–B10の再発106件とは単位も別。

T23の母集団検査: 現物manifestで期間内人間発話ありの98session、期間・除外理由・読取終了byte offset・prefix hashを固定。BF記録109本/採用98本と、今回現物111本/採用98本の総ファイル数差は履歴情報として併記。現在の採用対象に原本欠損・hash不一致があれば評価不成立。元106本のID/hash復元をT25の条件にしない。T25の母集団ゲートは現在の98sessionの再現と後述の分割別検証。

manifestには存在・読取件数・期間・除外・重複を別保存。session内はJSONL可視行順とhook完了順を維持、session間だけtimestampで安定merge。queuedの元時刻が挿入行より過去でも前へ移動禁止。利用可能時刻はsession内直前時刻と元timestampの最大値、同時刻は行順。session間同時刻の因果不明は未到達。clockへ利用可能時刻を注入、元時刻も保持。後日の追記は固定offset以降を読まない。

本ラウンドの再生・報告・導入判定は`cold`のみ、記憶ゼロから学習。warmは復元可能な初期投入0件のため効果評価から除外、coldの別名として比較表へ掲載禁止。報告本文のwarm節と必須ゲートから除去、除外理由は実行メタデータに保持。現在DBの古いtimestampだけで当時の本文を証明せず、期間末DBを最初から読ませない。外部memory_saveも当時の保存イベントと本文versionを確認できる場合だけ利用可能時刻へ投入、復元不能行は効果から除外。

ユーザー発話→既存/新規hook→assistant action→Stop→次発話を時刻順に処理。UserPromptSubmit成功出力の不在は失敗と即断しない。coverageを `observed`（実記録で確認できる発火）、`contract`（新hook契約で発火を仮定）の2通りで報告、主指標はobserved。queued発火が確認できない区間の検出はStop回収のみ。Stopより先のAI行動には遡及しない。新実装の別セッション開始は本番と同じSessionStart処理を呼ぶ。

「防げた」＝同じ監査束の2回目以降の発話のうち(a)(b)(c)をすべて満たす件。監査束は `scripts/replay/lib/themes.mjs` のBラベル、ファイルhashを実行条件に固定。本番の狭いbundle_keyとは別。これはBラベル単位の行動前本文到達であり、モデルの実行改善や意味の完全一致とは別に報告。

1. (a) 再発より先行する、同じBラベルの人間発話が本番検出器に当たること。検出器の束分類で評価分母を作らない。
2. (b) その発話を根拠とする規則が直前AI行動開始前にconfirmedとして保存済み。candidate・未来保存・今回訂正を契機にした保存は不可。根拠はevidenceとversionsのevent_idを辿る。
3. (c) 同じsession・同じcompact_epochのSessionStart出力、または再発より小さい確定human_ordinalのUserPromptSubmit出力で、同じBラベルの先行発話から生まれた規則本文がemit済み。注入時点と直前AI行動時点の両方で当該版がconfirmed・未失効・未取消。題名だけ・予算落ち・PreCompact出力・timeout破棄は不可。

直前AI行動の定義: 再発発話H_iの1つ前の人間発話H_prevからH_iまでのassistant行動すべて（textとtool_use）。queuedも人間発話に含む。最初のassistant行をA_firstとして機械的に固定。出力完了はA_firstより前を必須とし、単にH_iより前というだけでは成功にしない。同じBラベルから生まれた規則の根拠は公開文面の類似度でなく元event_idへの参照で確定。

区間内の各assistant行について、同epochの先行emitとその時点の有効版を照合。途中compactはそれ以前の出力を無効化、compact後最初のassistantより前に同束本文の再出力が必要。期限切れ・取消・置換後の旧版で成功扱い禁止。区間にassistant行なし、前人間発話なし、行位置不明、未照合ordinal、ledger/hook_success欠損は未判定として分母に残す。時刻同値はmanifestの可視順で決定、順序不能なら未判定。

判定単位は `event_id × Bラベル`。注入ledgerのversion/body_hashを追記snapshotと最終stdoutに照合し、成功出力記録まで一致した場合だけ(c)成立。v1出力→v2変更→取消後でも、v1が有効だった過去区間の再判定値は不変。cold/observedとcold/contractを分割ごとに別集計。発話単位合計は重複除去、束別延べ合計と差を表示。Bラベル内の極性・条件違いは独立LLM監査の誤対応として別計数、(c)の実行に意味ラベル入力を要求しない。

Σ(束−1)=139はB2–B10の元調査上限、実効値ではない。通常依頼を2回目で確定する束は初回→2回目のconfirmed到達なし、その分は成功不可。B1は別表、139へ加算禁止。T1c完了版のB2–B10再発106も139と母数が異なる。評価分母は固定したthemes.mjsと抽出除外規則による2回目以降の発話、元139・BF106との差分理由を併記。意味監査の不一致・判定不能を分母から消して率を引き上げない。

出力指標:

- 防げた割合＝到達件/固定監査束の2回目以降の発話件。B2–B10全体・束別・同一/別session別、B1は独立表。同一/別は成功に用いた最も早い先行保存根拠のsessionで分類。
- (a)失敗、(b)失敗、(c)失敗を最初の失敗で排他的計数。別途queued未到達、冷却、予算、期限、compact、未判定をreason別表示。(c)別session出力だけでは原因を断定しない。行動時点の有効性・可視性、開始時点で未確定、開始枠超過、後続配送漏れ、hook観測不明、関連検索不一致を副理由として保持。期限・可視性を確認してから別session理由を付与、別sessionの過去出力だけで現在の到達可能性を仮定禁止。旧実装も同じ修正済み判定器で測り、理由付け変更による差と動作改善を分離。
- 誤検出監査はconfirmed保存から50件、candidate陽性を混ぜない。candidate陽性も別標本50件、見逃し監査は未検出陰性から50件。各群50未満なら全件、復元抽出なし。event_id/bundle_key順に並べ、seed=20261003のFisher–Yatesで抽出。
- 1人間発話あたりの注入token平均・p50・p95・最大・0件率。SessionStartを含む値/含まない値、関連分/再注入分を分離。併せてUserPromptSubmitの観測件数、候補数、選択数、成功出力数を集計、未観測と選択0を区別。分母は各分割の期間内人間発話、期間外の開始復元用行を混ぜない。
- hook処理時間p50/p95/最大、5秒超率、内部deadline超率。隔離DBでscratchビルドの実binを毎回新規プロセスとして起動し、stdin送信前のspawn開始からcloseまでを親の外側時計で測る。通常/queued/DB busy/不正JSON/巨大入力/ネットワーク禁止を含める。関数import再生の処理時間は別列。UserPromptSubmit p95<=500ms・最大<4000ms、Stop決定論p95<=1000ms。内部失敗のexit0と、意図的な同期停止時の外側5秒timeout・stdout破棄・Claude継続は別試験。

意味監査は人手正解ラベル・2人の合議を廃止し、GPT-6.1 SolとClaude Opusの2体で独立判定。同じ原発話・前AI区間・除外範囲・抽出規則を渡し、互いの出力と検出器のscore/採否は隠す。返却は妥当/誤り/判定不能と根拠元位置、プロンプトは100行以内。件数・率・区間計算はコード。既知正解の合成例で判定方向を検査。不一致は件数として保持し、再判定で無理に一致させない。公開報告に「LLM2体の独立監査」、モデル版、一致/不一致/不能件数、Wilson95%区間を明記。逐語・個人パスは非公開。

判定者変更の理由: オーナーのSonnet不使用指示により、2体目をClaude Opusへ変更。

session単位でseed=20261003の7:3分割。session hash昇順からFisher–Yates、先頭floor(98×0.7)=68sessionを調整用70%、残り30sessionを評価用30%としてmanifestを先に固定。同じsessionを両側へ入れない。各側は別の空DB・台帳・候補状態から時系列cold再生、分割間の記憶流用なし。分割内の2回目以降を分母とし、独立cold化で旧全体301件から分母が変わる理由と件数を併記。

変更判断に使うのは調整側だけ。束キー、型、語彙、閾値、配送、監査手順を調整側で固定→コードhash・detector_version・themes hash・監査プロンプトhashを保存→評価側を1回実行。評価側の数字・失敗例を見て変更・seed再選択・再分割禁止。評価不合格は不合格のまま報告、同じ30%を再調整後の未見評価として再利用禁止。今回の既存全体値は原因調査の基準値、7:3の独立評価値とは呼ばない。

JSON・Markdownの全効果表に `調整用70%` / `評価用30%` の2列を必須化。分母・到達数・率、(a)(b)(c)、B1別表、束別、token、誤保存監査を両列で表示、observed/contractは別表。評価実行前は未実行と明記、0で埋めない。現行simulate-cold.md/jsonに分割列なしを確認済み、T23改修をD3bへ含める。LLM監査は分割・群ごとに最大50件、hook/決定論再生の外で実行。固定結果を読めば再生はネットワークなし。2体が実行できなければ `audit_model_unavailable`、合否未成立。既存利用枠を使用、新規従量課金は承認後だけ。

監査合格線: confirmed標本n件（最大50）の誤保存上界を `(両者一致の誤り + 不一致 + 判定不能)/n` とし2%以下。n=50なら1件以下、n=0は未評価。生の不一致件数も別表示。秘密値保存0、hookと決定論再生のネットワーク0、通常系5000ms超0、既存MCP回帰0、節4上限違反0。意図的な外側timeout試験は通常性能分布に混ぜない。改善率は実測のまま、本番承認後7日間は本文到達後の実再発を別集計、元調査の週88回とは母数差を明記。

## 8. 実装タスク分割

15タスク。各行は一つの受入動作を所有、合成fixtureのRed→最小実装→整理。テストも同じ所有者。旧IDは追跡用に維持し欠番は統合、T18は削除。T1/T1bと既存.gitignore差分を保持。各統合後 `pnpm exec tsc --noEmit`、全統合後 `pnpm test`。導入前はscratchビルドと隔離DBだけ、dist・実DB・wrapper・.envには触れない。

| ID | 触るファイル・単一責務 | Done（逐条） | 検証コマンド | 依存・並行可否 |
|---|---|---|---|---|
| T3（旧T3） | `src/storage/resolve-store.ts`, `src/config.ts`, 各同名test: 保存先互換 | ①未設定/相対はproject従来値 ②絶対env/.envだけ中央、env優先 ③1キー読取・MEMORY_DIRのdotenv混入0・import順不変 ④MCP/hook一致 ⑤symlink/global installでnode_modules保存なし | `pnpm exec vitest run src/storage/resolve-store.test.ts src/config.test.ts` | 依存なし。並行群G1 |
| T4（旧T4–T6） | `src/storage/correction-schema.ts`, `schema.ts`, `migration.ts`, `correction-schema.test.ts`, `schema.test.ts`, `migration-v11.test.ts`: 明示v11作成/移行 | ①8表・多対多・pending・版FK ②新規隔離/移行後構造一致 ③v10既存行不変・再実行0差分 ④失敗rollback ⑤通常schema呼出では既存v10へ新DDL/版更新0 | `pnpm exec vitest run src/storage/correction-schema.test.ts src/storage/schema.test.ts src/storage/migration-v11.test.ts` | 依存なし、契約は節3.2。G1。sqlite.ts編集なし |
| T7（旧T7+T7c） | `src/storage/sqlite.ts`, `auto-migration.test.ts`, `sqlite-hook-open.test.ts`: 既存DBを承認なしに移行しない接続 | ①通常initializeもv11先行移行なし ②hookはfileMustExist・DDL/mkdir/migration/vec 0 ③busy100ms・旧版throw ④loop offのv10索引readのみ ⑤v11済み/新規隔離は正常 ⑥MCP既存可視性不変 | `pnpm exec vitest run src/storage/auto-migration.test.ts src/storage/sqlite-hook-open.test.ts src/storage/visibility-matrix.test.ts` | T3/T4後。G2、sqlite.ts所有者1人 |
| T7b（旧T7b+T7d） | `src/storage/sqlite.ts`, `sqlite-correction-access.test.ts`, `sqlite-correction-search.test.ts`: 訂正用DB境界 | ①save/束/根拠/版更新を同一transaction・失敗rollback ②可視ID限定FTS最大40・他project一般記憶0 ③内部importは原時刻保持・重複全列不変 ④MCP型/読取connection契約不変 | `pnpm exec vitest run src/storage/sqlite-correction-access.test.ts src/storage/sqlite-correction-search.test.ts` | T7後。sqlite.tsはT7→T7bの2本だけ、同時不可 |
| T8（旧T8–T10） | `src/corrections/events.ts`, `detector.ts`, `bundle-key.ts`, 各同名test: 発話から条件付き候補 | ①user/queued同型・非human/引用除外 ②位置/UUID/利用可能順保持 ③採点境界・B9敬体例外/未知条件保留 ④最大3束・節3の型/極性/適用境界で統合、条件細部とDiceの制約除去 ⑤同文別発話は別根拠、同モデル別作業は別束 ⑥unknown/質問/型不成立/秘密は確定0 | `pnpm exec vitest run src/corrections/events.test.ts src/corrections/detector.test.ts src/corrections/bundle-key.test.ts` | 依存なし、入出力は節3。G1。改善差分はD3a |
| T11（旧T11+T16） | `src/corrections/session-store.ts`, `src/cli/transcript-reader.ts`, 各同名test: 発話照合とcursor | ①pendingを次hook/Stopで一対一照合 ②前AIは訂正前区間だけ ③多束でもordinal1回・再配信0加算 ④queued/同文連投/並行hook/遅延JSONL ⑤2MiB/200件・cursor原子更新 ⑥短縮/壊れ末尾回復 | `pnpm exec vitest run src/corrections/session-store.test.ts src/cli/transcript-reader.test.ts` | T7b/T8後 |
| T12（旧T12） | `src/corrections/store.ts`, 同名test: 根拠から確定/失効 | ①候補7日・反復30日・型成立の独立2根拠で昇格 ②confirmedだけ1active memory、全確定経路で型再検査 ③(event,bundle)冪等・条件細部違いも計数 ④相反/取消は停止版 ⑤通常モデル割当30日・明示継続は取消まで・一時経路24時間 ⑥条件分岐と版を追記し過去到達不変 | `pnpm exec vitest run src/corrections/store.test.ts` | T7b/T8/T11後。改善差分はD3a |
| T13（旧T13+T14） | `src/corrections/retrieval.ts`, `injection-policy.ts`, 各同名test: 規則到達選択 | ①候補40/関連2・topic一致優先・FTSはR0.55・ネットワーク0 ②owner/project条件一致 ③開始6件の内モデル規則最大2予約・残枠はtopic巡回 ④常時/モデル規則の未到達と開始後確定を後続配送 ⑤常時も関連再提示可・冷却10・31+30n・compact復元 ⑥unknown/旧生本文/期限/相反除外 | `pnpm exec vitest run src/corrections/retrieval.test.ts src/corrections/injection-policy.test.ts` | T7b/T12後。G3。改善差分はD3b |
| T15（旧T15） | `src/corrections/render.ts`, `src/injection/budget.ts`, 各同名test: 完全規則の予算制御 | ①開始1800/8000・発話800等全上限 ②条件/否定/複数行規則の切断0 ③budget=1は空 ④ヘッダー/ID込み ⑤最終出力とledger対象/hash一致・規則1件落ちも整合 ⑥既存索引helper互換 | `pnpm exec vitest run src/corrections/render.test.ts src/injection/budget.test.ts` | 依存なし、表示項目は節3.2/4.2。G1 |
| T17（旧T17+T24） | `src/observability/counters.ts`, `correction-metrics.ts`, 各同名test: 数値観測 | ①全counter型/理由コード ②既存JSONL不変 ③0件含むtoken/時間/欠落計数 ④秘密/本文/個人パス0 ⑤日上限/回転/省略を区別 | `pnpm exec vitest run src/observability/counters.test.ts src/observability/correction-metrics.test.ts` | 依存なし、節6の型固定。G1 |
| T19（旧T19、期限処理を内包） | `src/cli/context.ts`, `context-entry.test.ts`: 単一process注入 | ①開始/毎発話/compact連結・保存先共通 ②各段残時間・stdin期限/上限 ③開始含むbackfill/embedding/network/子起動0 ④offは索引維持 ⑤最終stdout1回・callback後だけledger ⑥EPIPE/台帳失敗/timeoutを成功にしない | `pnpm exec vitest run src/cli/context-entry.test.ts src/injection` | T3/T7/T7b/T11/T12/T13/T15/T17後。G3。T1b差分保持 |
| T20（旧T20） | `src/cli/analyze.ts`, `analyze-correction.test.ts`: Stop回収 | ①APIキー前の決定論保存 ②queued/pending回収・前AI取り違え0 ③LLM既定off ④symlink起動 ⑤決定論2500ms/総25000msと上限継続 | `pnpm exec vitest run src/cli/analyze-correction.test.ts src/utils/cli-entry.test.ts` | T3/T7/T7b/T8/T11/T12/T17後。G3。cli-entry.test.tsは読取・実行のみ |
| T21（旧T21+T22） | `src/corrections/import.ts`, `src/cli/correction-import.ts`, 各同名test: readonly検証から忠実な取込 | ①引数/同一DB拒否 ②dry-runは双方readonly・DDL0 ③隔離apply冪等・原時刻/条件/状態保持 ④異内容ID衝突保全・既存重複全列不変 ⑤一般化/期限延長0 ⑥件数だけ出力 ⑦専用v11移行はapply必須・隔離試験 | `pnpm exec vitest run src/corrections/import.test.ts src/cli/correction-import.test.ts` | T3/T7b/T12後。G3。実DBapplyなし |
| T23（旧T23） | `scripts/replay/simulate.mjs`, `scripts/replay/lib/simulate-engine.mjs`, `scripts/replay/lib/simulate.test.ts`: 自動到達判定と導入前評価 | ①本番TS共用・(a)(b)(c)境界・未来漏洩0 ②B1別表・別sessionの副理由・epoch/失効/多束検証 ③期間内人間発話あり98sessionのmanifest、元106本は定義差 ④coldのみ報告・warm初期0件をゲートから除去・外側bin計測 ⑤7:3固定・状態分離・全指標を調整/評価の2列で表示 ⑥Sol/Opus独立監査を分割/群別表示・隔離通し試験 ⑦評価閲覧後の再調整禁止・節7ゲート | `pnpm exec vitest run scripts/replay/lib/simulate.test.ts` と下記再生・導入前検証コマンド | T19/T20/T21後。単独。T1cのファイルは読取のみ。改善差分はD3b |
| T25（旧T25） | `package.json`, 最終 `dist/**`, 中央DB v11/取込、外側wrapper本文、パッケージ.envのMEMORY_DIR: 本番導入 | ①全隔離試験/再生/機密検査合格とdry-run結果を提示 ②**本番反映の承認を得てから**distビルド・中央v11移行・import apply・wrapper差替・.env変更を実行 ③MCP/hook同一realpath事前検証 ④T1b含むdist ⑤settings byte同一 ⑥hooks-selftest/実hook合成1往復 ⑦.envキー/機能スイッチの取消手順確認 | `pnpm exec tsc --noEmit`、`pnpm test`、承認後 `pnpm run build`、下記本番導入検証 | 全タスク・実母集団ゲート合格＋オーナーの本番反映y/n後。単独。今回の設計作業では実行禁止 |

並行群（各タスクの依存充足が先、群内の全件同時開始を意味しない）:

- G1: T3・T4・T8・T15・T17。各モジュール契約は節3〜6で固定、相互importが未実装なら型境界を合成入力で検証。
- G2: T7またはT7bと、未完のT8・T15・T17。sqlite.tsのT7→T7bだけは必ず直列。その後T11→T12。
- G3: T13・T20・T21、T13完了後はT19・T20・T21。T15/T17が未完なら依存先を開始しない。
- 改善ラウンドはD3a→D3b→T25の直列。D3a/D3bにT8/T12/T13/T23の改善差分を集約、旧タスクとの二重編集禁止。T25は現98sessionの分割別検証・監査合格と本番承認後だけ開始。

並行実行は使い捨てworktreeの `--isolate` 必須。同じファイルを2タスクが触らない。表の所有外ファイル編集が必要なら直列へ組替。依存結果を本体へ取り込んでから次タスクの隔離環境を作る。共通test/型ファイルを無断追加所有しない。差分取り込み時は既存作業との差を検査、衝突を自動上書きしない。

DB接続契約: correction各repositoryは同じSQLiteStorageを受け、読取は既存connection、書込はrunCorrectionTransaction。callbackへ同一DBと通常save・内部import APIを渡し、correction内部だけで使用。MCPにSQL実行APIを公開しない。別接続の擬似transaction禁止。FTSはT7bの既存基盤共用、T13でコピー実装しない。

再生コマンド契約: `pnpm exec tsc --outDir .tmp/<session_id>/replay-build --declaration false` → `node scripts/replay/simulate.mjs --manifest <local-manifest> --compiled-root .tmp/<session_id>/replay-build --scratch .tmp/<session_id>/replay --mode cold --split tune --audit <local-tune-audit-results>`。調整側固定後、同条件で `--split evaluation --audit <local-evaluation-audit-results>` を1回。分割別結果を保存し、JSON/Markdownに2列を表示。現CLI未対応のmanifest/compiled-root/scratch/split引数はD3bで受理・検証、分割IDと版hashの不一致は失敗。入力manifestと固定監査結果は非追跡、個人パスの既定埋込なし。warm実行は本ラウンドの検証に含めない。

導入前検証（T23、承認不要）: 同CLIの `--mode acceptance` で、scratchの実bin＋隔離DBを使い、合成人間発話→Stop保存→別session開始→語不一致の関連依頼→compact→発話31を通す。v10通常openでDDL0、明示隔離移行、dry-run、隔離import、.env解決は合成fixtureだけ。`--mode hook-timing` は同fixtureを新規processで反復し、cold時間と意図的timeoutを分離。各modeのCLI引数は上記と共通、本番dist・設定・DBを書かず節7の合否を出す。

本番承認の対象: 中央ストア参照名、v10→v11の8表差分、import dry-run集計、自動保存の継続範囲、dist/wrapper/.env変更。本番DDL・import・通常hookの自動保存有効化のすべてより先に承認を得る。専用移行は `node <compiled-root>/cli/correction-import.js --migrate-v11 --apply` とし、dry-runではDDL差分だけ表示。T21が引数と専用migration呼出を所有、隔離DBで先に試験。

本番導入検証（T25）: MCP/hookの解決先realpath一致を確認してから承認対象の中央へ移行/import、wrapperを反映し合成sessionで1往復。元settingsをhash比較。配線検査はfirebase-kitをcwdに `FORCE_SELFTEST=1 bash .claude/hooks/hooks-selftest.sh --strict`。キャッシュ/一時領域を使うためT25だけで実行、本T2では実行しない。

## 9. 危険と巻き戻し

| 危険 | 歯止め | 戻し方 |
|---|---|---|
| 誤保存・候補増殖 | 1人間発話最大3候補、project/日最大20新規束、超過は件数だけ記録。候補7日、記憶昇格は節3条件。既存IDの重複加算なし。秘密検査 | `WASURENAGUSA_CORRECTION_LOOP=off`、該当bundleをrejected、対応memoryは既存論理退避APIで停止。イベント根拠を保ち物理削除なし |
| 本文増大・古い規則の過剰注入 | 開始1800、発話800の上限。最大件数と冷却。条件/否定切断禁止 | `WASURENAGUSA_CORRECTION_INJECT=off` で既存索引のみ。本文量と欠落原因を計数してから修復 |
| DBロック・hook遅延 | 100ms busy、単一processの段ごと残時間確認、外側5秒、FTSのみ | wrapperを元のstdin消費+exit0へ戻す。settings配線変更不要。Stopも新ループoff、未処理はcursor以降に残す |
| 移行誤り | readonly入力、dry-run、imports対応表、hash、同一DB拒否 | import対象IDだけ論理退避、元ローカルは不変。DB全体を過去へ戻して新規記憶を失わない |
| 課金・ネットワーク発生 | 新ループは0呼出。Stop LLM既定off、APIキーのみでonにしない | WASURENAGUSA_STOP_LLM=off。UserPromptSubmitで呼出を検出したら導入試験不合格 |
| 強制規則への誤昇格 | correction確定とprinciples承認を分離、PreToolUse不変更 | 新規注入offで記憶由来助言停止。既存guardは本改修の巻戻し対象外 |

スキーマ巻戻しは削除DDLを実行せず、新表を残して旧コード相当の経路へ切替。新schema versionを読めるソースを保った機能スイッチで戻す。旧distを無検証で上書きしてversion不一致を作らない。新規バックアップ・複製はこの設計で要求せず、移行の入力不変と追記履歴で可逆性を確保。

## 10. 設計判断の未決

決定済み: 明示絶対設定下の中央を正本、公開project既定維持、既存FTS＋既知topicの決定論検索、候補/確定分離、横断範囲を独立列、型成立の独立2根拠で反復確定、31発話から再注入、本文上限固定、settings配線維持、hookのLLM非依存、単一process。改善分は節3/4/7および末尾D3a/D3bへ集約。束は条件細部を根拠へ移し動作・極性・割当を分離、unknown/質問/型不成立は確定禁止、本文は決定論の型。常時規則の関連再提示とB1の開始予約・後続配送を採用。98sessionの7:3独立cold評価、warm報告除外、Sol/Opus監査を固定。導入前の処理時間と誤保存率はscratch/隔離DBで判定、本番反映はT25のy/n後のみ。

独立Solレビューへの対応（R番号は依頼で指定されたローカル `t2-review-sol.md`）:

| 指摘 | 採否・反映先／採らない部分の理由 |
|---|---|
| R01 保存先互換 | 採用: 節5/T3。ホーム.envのMEMORY_DIR採用案は不採用、中央化の明示元を環境変数/パッケージ.envに限定する今回指示を優先 |
| R02 本番DDLの先行実行 | 採用: 節3.2/8/T4/T7/T25。通常schema/initialize双方で既存v10への新DDLと版更新を止め、専用移行を承認境界へ |
| R03 語不一致の規則未到達 | 採用: 節4/T13/D3b。固定5topic予約案は不採用、全owner継続規則のtopic巡回を維持。改善分として開始6件内にモデル規則最大2件予約、projectモデル規則も未到達配送 |
| R04 発話と束の多対多 | 採用: 節3.2/T4/T11/T12。発話PKと根拠複合PKを分離、ordinalは発話ごと1回 |
| R05 supervisorの同期停止 | 問題を採用、supervisor強化案は不採用: 節6/T19。同期停止の必要性を示す実測なし、外側timeoutと単一processで処理 |
| R06 UUIDなしと前行動 | 採用: 節3.2/6/T11。pendingの再照合・通し番号・訂正前区間を固定 |
| R07 本文版の復元 | 採用: 節3.2/3.3/7/T12。完全snapshotと有効区間を追記、台帳から版参照 |
| R08 決定論の到達判定 | 採用: 節7/T23。A_first前・同epoch・両時点有効を自動判定。細分束の意味正解を必須入力にする案は不採用、今回指定のBラベルを固定し意味差は別監査 |
| R09 監査母集団と判定者 | 採用: 節7/T23/D3b。confirmed/candidate/陰性を分割ごとに別抽出、Sol/Opusの独立LLM判定、不一致/不能を保存・報告 |
| R10 タスク細分化 | 採用: 節8。15本、SQLite直列は2本、同一ファイルの同時編集なし、並行群と--isolate明示 |
| R11 継続命令の30日失効 | 採用: 節3.3/T12。明示継続owner方針は取消まで有効、反復推定は有限 |
| R12 importの時刻/追記契約 | 採用: 節5/T7b/T21。通常saveと内部import API分離、原時刻保持、重複行全列不変 |
| R13 予算ガードの規則切断 | 採用: 節4.2/T15。完全規則単位で制限、極小予算は空、最終出力だけを台帳化 |
| R14 元manifest/cold計測 | 改訂: 節7/8/T23/D3b。元106本は期間未限定の総数、現98sessionが正しい母数。元一覧復元を導入ゲートから除去、現manifestと分割別評価で検証。実binの外側時計計測は維持 |

レビューの補足提案も反映: context開始時のbackfill spawn停止は節6/T19、外側timeout時にwrapper exit0を保証しない区別は節6/7。15本案はsupervisorを落としSQLiteを2本に分けて採用。

決めてほしいことは1問。

**復旧した既存 Stop LLM 分析の従量課金を有効にするか。** 推奨: 有効化しない。今回の訂正防止は決定論の検出・保存・注入で完結し、追加API費用0。代替: 別途上限予算と利用プロバイダを明示して既存分析を有効化。その場合は既存 `prompts/analysis.txt` の100行制約と入力差分検証を満たす改修・独立評価を先に実施し、訂正防止の完成と分離。回答が無い間はoff、その他の実装は進行可能。

## 11. 改善ラウンド 1

対象: D3の設計差分。根拠は `.wasurenagusa/reports/replay/simulate-cold.md`・同JSON、読取専用で確認した `.tmp/replay/cold/observed/memory.db`。基準値は全98sessionの旧版cold/observed、分割別評価は未実施。B2–B10は13/106件（12.3%）、現行0%、排他失敗(a)19・(b)70・(c)4。束別はB5が12/17、B9が1/3、他0。B1は10/195件（5.1%）、(a)0・(b)55・(c)130。防げた件数は節7の行動前本文到達、意味監査の合格を代替しない。

### 11.1 原因 → 変更 → 減らす失敗区分

| 原因・実測 | 最小の変更 | 期待する失敗区分の変化 |
|---|---|---|
| 235束中confirmed9・candidate226。`bundle-key.ts` は動作・極性・条件全文一致＋Dice0.85、`store.ts` も条件全文一致で根拠抽出。言い換えと条件細部で独立2根拠に届かない | 節3: 動作・必須値・極性・適用境界を守って同topicを統合、条件は根拠と規則の分岐に保持 | (b)減少を見込む。(a)の未検出は束の統合だけでは減らない |
| confirmed9本にunknown2本とverification2本を含む。相談文も反復で確定。`detector.ts` はtone例外以外を生発話でruleText化、`store.ts` は2根拠だけで昇格 | 節3: 全確定経路に既知topic・指示述語・型成立の共通前提。生発話は根拠へ、本文は型から生成 | 誤保存と誤った到達成功を除去。不正な確定を止めるため(b)が増える場合も表示、率の維持を優先しない |
| observedの発話ごとの関連注入0.0tokens、開始以外の出力も0。DB台帳はstartのみ、`retrieval.ts` は常時規則をrelatedから除外。残るproject規則にはunknown・相談文・短いモデル指示が混在、FTS後の語長条件も先に適用 | 節4: 常時規則も関連候補へ、型の対象topicから可視確定束を取得、同発話の重複を除き10発話冷却。節7: hook観測と選択0を別計数 | 発火する経路の(c)減少を見込む。observedの未観測を新しい出力で埋めず、contractとの差を残す |
| B1の(c)に別session出力121件。確定model_routing2本はproject可視・routing24時間。`readAlwaysOnRules` はownerかつ継続/推定のみ、開始は残枠、未到達配送はalwaysOnのみ | 節3: 一時方針だけ24時間、通常反復割当は30日、明示継続は取消まで。節4: 6件内に最大2件予約、projectのまま開始後確定と未到達も配送 | 可視・有効なB1の(c)減少を見込む。失効した一時指示の復活・別projectへの拡大は禁止 |
| 元106本を期間母集団と誤解した導入ゲート、7:3列なし、warm初期投入0件 | 節7/8: 母数98session、分割別cold報告、warm除外、Sol/Opus監査 | (a)(b)(c)の改善ではなく評価の是正。母数変更・理由再分類を改善へ算入しない |

B1の6枠落ち説は今回の台帳から支持されない。記録済み開始92回で、開始時点に有効なモデル規則の選択機会9件、未出力0件。開始予約は後続の型成立規則が増えた場合もB1を届ける変更。現状の配送漏れは開始後確定・24時間扱い・project規則の後続配送除外を分けて扱う。`simulate-engine.mjs:adjudicatePrevention` は同session本文を見つけた場合だけ期限を検査し、見つからなければ別sessionの過去出力を理由に採用するため、121件すべてを枠不足や有効規則の未到達と断定不可。D3bで時点別の副理由を出す。

関連注入0の観測上の制約: `simulate-engine.mjs` はobservedUserHookを確認できた発話だけ選択処理を呼ぶ。contractでは開始除外平均約3.53tokens、関連本文合計5tokens（平均約0.0042）で、常時除外だけがobservedの0を説明するわけではない。開始枠を増やして観測不在を補う設計は不採用。冷却・予算は維持し、関連対象と配送漏れを修正。本文上限は開始1800・発話800tokensのまま。

### 11.2 寄せる束と分ける束

数値は現在の束数/うち独立発話1回の束数。統合後の束数は未計測、目標件数を置かない。実測例は束名と件数だけ、生発話の引用なし。

| 束名 | 現在の束数 / 1回の束数 | 寄せる単位 | 分ける境界 |
|---|---:|---|---|
| summary_constraints | 26 / 26 | 同じ制限動作と値、条件細部の違い | 上限値・比較方向・解除・順序の違い |
| model_routing | 22 / 20 | 同じ作業×同じ完全モデル識別子×同じ極性 | 別作業・別モデル・逆極性・適用境界 |
| verification | 21 / 19 | 同じ照合/根拠提示動作と対象 | 原本照合と根拠提示の違い、指示と相談 |
| document_delivery | 18 / 17 | 同じ全文表示動作、言い回しと条件細部の違い | 全文表示と部分表示、提示と保存、逆極性 |
| unknown | 123 / 120 | 正規化した同文の候補だけ | 意味不明の異文を寄せず、反復しても確定しない |

### 11.3 実装タスク

Codex実装2本。D3aの単一受入動作＝独立根拠から意味と条件を保った規則だけ確定。D3b＝確定規則を予算内で届け、独立した評価で到達を測る。各受入条件のRed→最小実装→整理。ファイル所有は下表で固定、D3a→D3bの直列。共用の型関数・条件JSON契約はD3aで確定、D3bはimportのみ。DDL・本番DB・dist・設定・実会話fixtureの追跡追加なし。

| ID | 触るファイル・単一責務 | Done（逐条） | 検証コマンド | 依存・並行可否 |
|---|---|---|---|---|
| D3a | `src/corrections/bundle-key.ts`, `detector.ts`, `store.ts`, 新規 `rule-template.ts`, 各同名test、`src/cli/analyze.ts`, `analyze-correction.test.ts`: 条件を保った規則確定 | ①同topic/同動作/同必須値/同極性の言い換え・条件細部違いを同束、30日内の独立2根拠で確定 ②逆極性・別動作・別作業モデル・異なる数値制限・案件境界は分離、相反だけ停止 ③10topicの型を共用し本文の生コピー0、根拠別条件を保持、型不成立の本文空・memoryなし ④unknown/質問/相談/欠落条件は即時・反復・ID確定すべてで確定0、tone限定例外は維持 ⑤規則と期限を根拠集合から再生成、一般モデル反復30日・一時経路24時間・明示継続は取消まで、版履歴不変 ⑥キー/検出版v2・イベント冪等・Stop/pending経由と直接保存で同じ判定、型入力を既存条件JSONで引き渡す ⑦合成例だけで反復昇格と誤昇格防止を検証、既存回帰を通す | `pnpm exec vitest run src/corrections/bundle-key.test.ts src/corrections/detector.test.ts src/corrections/rule-template.test.ts src/corrections/store.test.ts src/cli/analyze-correction.test.ts`、`pnpm exec tsc --noEmit`、`pnpm test` | 統合済みT8/T11/T12/T20後。D3bに型関数・v2キー・条件JSONを渡す。D3b所有ファイルの編集禁止 |
| D3b | `src/corrections/retrieval.ts`, `injection-policy.ts`, 各同名test、`scripts/replay/simulate.mjs`, `scripts/replay/lib/simulate-engine.mjs`, `scripts/replay/lib/simulate.test.ts`: 規則到達と分割別検証 | ①常時規則をrelatedから除外せず、型の対象topicで候補取得、モデル名だけの照合は不採用、冷却10・候補40・関連2・重複0 ②開始6件内モデル最大2予約、project可視維持、開始後確定/未到達/compactの後続配送 ③ヘッダー込み開始1800・発話800以内、予算で落ちた規則は未配送維持、部分文0 ④T23改修: manifest/compiled-root/scratch/split引数、98sessionの固定7:3・DB/台帳分離・各分割内の再発分母、全指標をJSON/Markdownの調整70%/評価30%の2列へ出す ⑤調整側だけで変更を決めhash固定後に評価側1回、評価を見た再調整禁止、両側の到達/誤保存/tokenとSol/Opus監査を報告 ⑥別session理由に時点別有効性・開始時状態・枠/後続配送/観測/検索の副理由、hook観測数と出力数、旧実装も同じ判定器で比較 ⑦元106本の復元ゲートとwarm比較/必須ゲートを除去、現98sessionの欠損・hash不一致は失敗 ⑧実binの隔離通し試験と既存回帰を通し、機密値・逐語を追跡成果物へ出さない | `pnpm exec vitest run src/corrections/retrieval.test.ts src/corrections/injection-policy.test.ts scripts/replay/lib/simulate.test.ts src/corrections/render.test.ts src/injection/budget.test.ts`、`pnpm exec tsc --noEmit`、`pnpm test`、節8のscratchビルド→`--split tune`→固定→`--split evaluation`、同CLIの`--mode acceptance`・`--mode hook-timing` | D3a後。T13/T23改善分を所有、D3a所有ファイルは読取のみ。render/budgetのtestは実行のみ。T25は分割別検証・監査合格と本番承認後 |

レビュー: 条件統合後も適用範囲を広げていないか／型が停止・期限・否定・モデル版を補完/欠落させていないか／評価側を見て語彙・閾値・束・配送を変更していないか。改善後の(a)(b)(c)件数と率は両分割で実測、目標値の数字は置かない。
