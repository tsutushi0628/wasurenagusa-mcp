# Tasks Document

運用ルール（全タスク共通）：

- フェーズゲート方式で進める。各フェーズの先頭タスクの着手条件は「前フェーズのゲートスクリプト実行出力（結果本文）が Implementation Logs に貼付され、全項目PASSであること」。exit code では判定しない
- 全実装タスクは Red → Green → Refactor で進める。各タスクの箇条書きは「①失敗するテストを書く ②最小実装で通す ③テスト緑のまま整理する」の順を含む。テストが先に存在しない実装はQAへ引き渡せない
- 1タスク = 1つの検証可能な変更。各タスクに完了条件1行と検証方法を持たせる
- ゲートスクリプト、ゴールデンセット、ラベル付きペアは検証役（qa-engineer）が作成する。実装者は編集しない（R-M3）
- 実装招聘は1エージェント15〜25タスク目安でフェーズ単位に分割する
- design.md の non-goals（各フェーズ②）と禁止フォールバック一覧に反する変更は、発見次第差し戻す
- 完了条件の標準形：全実装タスクは `npm run build` でdist再生成→`npx vitest run` 緑→`node scripts/verify/production-path-smoke.mjs` 全PASS を完了条件に含む（TypeScript修正はビルドしないと全起動経路に発効しない。push=発効ではない）
- 実行標準：着手前にsteering3文書（product.md／structure.md／tech.md）と本spec該当節を読む。作業中に文書と実コードの食い違いを発見したら、推測で進めず作業を止めて乖離内容を報告する
- 完了マークは `[x]`＋コミットハッシュ＋日付で記録し、1タスク=1コミットとする

## Phase 0：止血

目的：出血源を止め、計測を最初に出荷し、全データを可逆にする。
着手条件：作業ツリーがコミット済みHEADのクリーン状態であること（タスク0.0で成立させる。タスク0.0自身の着手条件はなし）。
完了条件：ゲートG0の全項目PASSと出力貼付。
注記：本フェーズ内の完了マーク済みタスクは、フェーズゲート運用開始前の先行実施であり、ゲート証跡（G0）は本タスクでは未整備。

- [ ] 0.0 予測誤差ループの扱い判断と版数ベースライン確定
  - File: 判断記録は Implementation Logs
  - (a) 予測誤差ループ一式（docs/spec-prediction-error-loop.md、src/storage/prediction-error-loop.test.ts、src/vector/prediction-error.test.ts、src/vector/prediction-error.ts ほか関連差分）は退避すべき未コミットWIPではない。コミット8b915a5（オーナー裁定2026-07-03）で本体へ既に反映済みである。本タスクは「温存するか、物理削除を再計画するか」の判断のみを行う（確定はPdM承認）
  - (b) 判断が「物理削除」の場合は本タスクでは実行せず、判断結果をPhase 4の死機能削除（タスク4.8）へ引き継ぐ旨を記録する。判断が「温存」の場合は、タスク4.8の削除対象から本ループを外す旨を記録する
  - (b-確定) 判断確定済み（2026-07-07・PdM確定）: 物理削除。実行はタスク4.8。根拠と先潰し条件は Implementation Logs/task-0.0-prediction-error-loop-decision.md が正本（実データ全ストア0件の実測、タスク4.2注入再設計との構造衝突、git履歴・退避パッチによる二重保全を根拠とする）
  - (c) 版数ベースライン=v5（src/storage/schema.ts:3 の CURRENT_SCHEMA_VERSION=5、schema_version テーブルの MAX(version)=5）を確定する。v5は予測誤差ループ由来の predicted_factors／actual_factors／prediction_error／prediction_delta カラム（migrateV4ToV5）で占有済みであり、Phase 1以降が新設する状態機械・帰属信頼度・埋め込みモデル列の移行先ではない
  - (d) 本Specの移行版数連鎖は v5（ベースライン）→v6（Phase 1 土台列。タスク1.3〜1.4）→v7（Phase 3 lineage/principles。タスク3.1〜3.2）→v8（Phase 4 guards。タスク4.1）で確定（PdM裁定2026-07-05）
  - Purpose: 全file:line引用と版数ベースラインの基準を正史（HEAD）に固定する
  - 完了条件: 予測誤差ループの扱い判断が記録され、ベースライン=v5の記録が貼付されている
  - 検証: schema_version 照会結果の貼付と判断記録
  - _Leverage: git, schema_version テーブル_
  - _Requirements: R-A1, R-A3_
  - _Prompt: Role: scm-engineer | Task: 予測誤差ループの扱いを判断記録し版数ベースラインv5を記録する | Restrictions: 判断確定前に物理削除を実行しない。既存コミットへのforce操作をしない | Success: 扱い判断とv5記録が残る_

- [x] 0.1 sqlite-vec APIの実在確認スパイク（コミット 0aaa269・2026-07-08）
  - File: scripts/spikes/spike-sqlite-vec.ts（新規）
  - vec0仮想テーブルの距離既定（L2）、KNN構文、距離値の取得方法を使い捨ての小DBで実行確認する
  - 動いた構文と動かなかった構文を Implementation Log に記録する。以降の実装はここで確認済みの構文しか使わない
  - Purpose: LLM実装者がAPIを幻覚しやすい領域の事実を最初に固定する
  - 完了条件: KNN実行と距離取得の実行例が動作し、結果本文が貼付されている
  - 検証: スパイク実行出力の貼付
  - _Leverage: node_modules/sqlite-vec, src/storage/schema.ts_
  - _Requirements: R-B4, R-M3_
  - _Prompt: Role: backend-engineer | Task: sqlite-vec 0.1.9のvec0 APIを使い捨てDBで実行確認し結果を記録する | Restrictions: 本番ストアに接続しない。書き込みは使い捨てDBのみ | Success: 確認済み構文の一覧が実行出力付きで残る_

- [x] 0.2 FTS5 trigramクエリ挙動の実在確認スパイク（コミット 024853b・2026-07-08）
  - File: scripts/spikes/spike-fts5-trigram.ts（新規）
  - trigram索引に対するフレーズクエリとトークン分割クエリ（AND、OR）の挙動を、日本語サンプル文で実行確認する
  - 2文字以下のクエリ語の扱い（trigramの最短長制約）も確認する
  - Purpose: Phase 1 のトークナイザスパイクと Phase 2 のクエリビルダの前提事実を固定する
  - 完了条件: フレーズとAND/ORの挙動差が実行出力で確認され貼付されている
  - 検証: スパイク実行出力の貼付
  - _Leverage: src/storage/schema.ts:34-44_
  - _Requirements: R-B1, R-M3_
  - _Prompt: Role: backend-engineer | Task: FTS5 trigramの日本語クエリ挙動を使い捨てDBで確認し記録する | Restrictions: 本番ストアに接続しない | Success: クエリ形ごとのヒット挙動が出力付きで残る_

- [x] 0.3 トークン計数ライブラリの実在確認と較正スパイク（コミット a5a95b7・2026-07-08）
  - File: scripts/spikes/spike-token-counter.ts（新規）
  - 候補ライブラリをローカルで実行し、日本語テキストのトークン数を計測できることを確認する
  - 実測済みの注入サンプル（約8.2KB）で計数し、消費側モデルとの乖離を見込んだ安全係数（バジェットに0.8を乗じる等）を決めて記録する
  - 確定したライブラリを package.json にexact pinで追加する
  - Purpose: R-C1（消費側トークンでのバジェット管理）の計測手段を確定する。タスク0.9の前提
  - 完了条件: 計数ライブラリが確定しexact pinで追加され、較正係数が記録されている
  - 検証: スパイク実行出力と package.json 差分の貼付
  - _Leverage: package.json_
  - _Requirements: R-C1, R-M3_
  - _Prompt: Role: backend-engineer | Task: トークン計数ライブラリを実在確認して確定しexact pinで導入、較正係数を記録する | Restrictions: 未確認ライブラリのAPIを想像で使わない。外部API送信をしない | Success: 日本語テキストの計数が動き、係数の根拠が残る_

- [x] 0.4 バックアップと復元のテスト作成（コミット 11d6386・2026-07-08。0.5と同一コミット）
  - File: scripts/backup-store.test.ts（新規）
  - 「対象全ストアの全ファイルがバックアップされ、チェックサムマニフェストが検証できる」「主ストアは復元リハーサルで件数とチェックサムが一致する」「バックアップ検証失敗時にエラー終了する」を失敗するテストとして先に書く
  - Purpose: R-A1 の受け入れ基準をテストで固定する（Red）
  - 完了条件: テストが存在し、実装前は失敗することを確認済み
  - 検証: テスト実行出力（Red確認）
  - _Leverage: vitest基盤_
  - _Requirements: R-A1_
  - _Prompt: Role: backend-engineer | Task: バックアップと復元リハーサルの業務要件をテストで先に固定する | Restrictions: 実装を書かない。一時ディレクトリのfixtureで完結させる | Success: 要件どおりの失敗テストが揃う_

- [x] 0.5 バックアップと復元スクリプトの実装（コミット 11d6386・2026-07-08）
  - File: scripts/backup-store.ts, scripts/restore-store.ts（新規）
  - 対象ストアの全ファイル（memory.db、Markdown、vectors.json、ログ）をコピーし、チェックサムマニフェストを生成する
  - restore は マニフェスト照合つきでコピーを戻す。照合失敗はエラー終了（fail-loud）
  - 検証の実施範囲: バックアップ取得は対象全ストア、復元リハーサルは主ストアのみ、他ストアはチェックサム検証まで
  - タスク0.4のテストを緑にし、リファクタする
  - Purpose: 唯一のコピーを守り、以降の全手順を可逆にする（Green と Refactor）
  - 完了条件: 全ストアのバックアップとチェックサム検証、主ストアの復元リハーサルが成功している
  - 検証: テスト緑と、実ストアでのリハーサル実行出力
  - _Leverage: scripts/spikes の実行方式（npx ts-node --esm）_
  - _Requirements: R-A1_
  - _Prompt: Role: backend-engineer | Task: 全量バックアップと検証つき復元を実装しテストを緑にする | Restrictions: 原本への書き込みをしない。`??`/`||` のフォールバック代入をしない | Success: 復元リハーサルで件数とチェックサムが一致する_

- [x] 0.6 v1書き込み経路の物理遮断（コミット 5e3d5d5・2026-07-08）
  - File: src/cli/context.ts（変更）, src/tools/save.ts（変更）, 対応テスト（変更と新規）
  - ①「セッション開始処理を実行してもMarkdownと vectors.json が書き変わらない」「retag-workerがspawnされない」を失敗するテストとして先に書く
  - ②SessionStartからの consolidate-worker spawn（src/cli/context.ts:419-423 の鮮度判定起点）を除去する。retag-worker の spawn 実体は保存経路側にあり（定義 src/tools/save.ts:86-96、発火 :185-196）、こちらも除去する
  - ③backfill の spawn（src/cli/context.ts:425-428）はv2経路（埋め込み補完）であり遮断対象外。触らない
  - ④関連する死んだimportを整理する（ワーカーファイル自体の削除は Phase 4）
  - Purpose: 双頭統合とフリップフロップ（監査D1）の書き込み側を止める
  - 完了条件: v1資産への書き込み経路がコード上存在しない
  - 検証: テスト緑と、ゲートG0の v1-blocked 項目
  - _Leverage: 既存の context.test.ts, save系テスト_
  - _Requirements: R-A3_
  - _Prompt: Role: backend-engineer | Task: v1 Markdown統合系への書き込み経路をテスト先行で物理遮断する | Restrictions: アーカイブファイルを削除や移動しない。検索やスキーマに触れない | Success: セッション開始と保存でv1ファイルが不変_

- [x] 0.7 ガードパターン自動生成の停止（コミット c4a1635・2026-07-04）
  - File: src/consolidator/dont-consolidator.ts（変更）, 対応テスト
  - ①「統合を実行しても guardPattern が統合キャッシュへ永続化されない」を失敗するテストとして先に書く
  - ②生成経路の実体は「LLM統合出力の guardPattern フィールドが検証を経て統合キャッシュへ受け入れられる」箇所（src/consolidator/dont-consolidator.ts:51-60）である。ここを検証つき受け入れから無条件除去へ変更する
  - ③src/cli/guard.ts:89-93 は適用時の抽出フィルタであり生成経路ではない。照合ランタイムとともに Phase 4 まで現状維持（触らない）
  - Purpose: 自己DoSベクトル（64正規表現事故）の生成側を恒久停止する
  - 完了条件: ガードパターンを生成するコード経路が存在しない
  - 検証: テスト緑と、ゲートG0の guard-gen-stopped 項目
  - _Leverage: 既存の guard.test.ts_
  - _Requirements: R-C4_
  - _Prompt: Role: backend-engineer | Task: ガードパターン自動生成の経路をテスト先行で停止する | Restrictions: PreToolUse照合の挙動自体は変えない（Phase 4対象） | Success: 統合後もパターン集合が不変_

- [x] 0.8 夜間統合のdry-run化（コミット 9aeb99b・2026-07-08）
  - File: src/cli/consolidate-all.ts（変更）, 対応テスト
  - ①「実行後に memories と統合キャッシュへの書き込みが0件で、レポートファイルが生成される」を失敗するテストとして先に書く
  - ②書き込みを停止し、クラスタ数と統合候補件数のレポート出力へ置き換える
  - Purpose: 統合の書き込みを Phase 3 の追記型実装まで凍結し、その間も観測は続ける
  - 完了条件: 夜間統合が読み取りとレポートのみになっている
  - 検証: テスト緑と、ゲートG0の nightly-dryrun 項目
  - _Leverage: src/cli/consolidate-all.test.ts_
  - _Requirements: R-A3, R-A6_
  - _Prompt: Role: backend-engineer | Task: 夜間統合をテスト先行でdry-run化する | Restrictions: launchd配線を変えない。クラスタリング計算は残す | Success: 書き込み0件でレポートが出る_

- [x] 0.9 可観測性カウンタ5指標と閾値警報（コミット f86eb9a・2026-07-08）
  - File: src/observability/counters.ts, src/observability/counters.test.ts（新規）
  - ①「5指標（ゼロヒット率、注入トークン数、統合件数、ガードブロック件数、蘇生件数）が記録される」「閾値超過で alert=true が付く」を失敗するテストとして先に書く
  - ②JSONL追記の計数モジュールを実装し、検索と注入とガードと統合の各経路から呼び出す
  - ③蘇生件数は「deleted 行への埋め込み付与の検出」で計上する
  - Purpose: 計測を最初の出荷物にする（R-M1）。以降の改修効果はすべてこの計器で測る
  - 完了条件: 5指標がJSONLに出力され、閾値警報が動く
  - 検証: テスト緑と、ゲートG0の counters 項目
  - _Leverage: logs/operation-*.jsonl の既存出力形式_
  - _Requirements: R-M1_
  - _Prompt: Role: backend-engineer | Task: 5指標の計数と警報をテスト先行で実装する | Restrictions: 計数失敗で本処理を落とさないが、失敗自体は計数する。既存ログ形式を壊さない | Success: 実経路から5指標が記録される_

- [x] 0.10 SessionStart注入の修復と注入バジェット強制の同時着地（コミット 3a6b0e7・2026-07-03）
  - File: src/cli/context.ts（変更）, src/injection/budget.ts（新規）, 対応テスト
  - ①「シンボリックリンク経由の実行で注入本文が出力される」「注入は常にトークンバジェット以下」「サマリ欠落時に全文フォールバックせずスキップ計数される」を失敗するテストとして先に書く
  - ②CLIエントリ判定（src/cli/context.ts:709-713）を実体パス解決（realpath比較）へ修正する。判定不能は無言 exit 0 でなくエラー出力
  - ③タスク0.3で確定した計数器によるバジェット強制（超過分の切り詰めとスキップ計数）を、注入本文の出力最終段に同じ変更で入れる
  - ④本タスクの境界: 出力最終段のバジェット強制と欠損スキップ計数まで。注入本文を組み立てるビルダ内部（フォールバック分岐そのもの）は触らない。分岐自体の除去はタスク4.2（相互参照）
  - ⑤修復とバジェットは同一コミットで入れる。順序制約：修復を先行単独で入れると7.5万字注入が全セッションで復活する
  - Purpose: 沈黙死（症状⑤の裏側）を直しつつ、直した瞬間の全文注入復活を構造的に防ぐ（R-C2）
  - 完了条件: シンボリックリンク経由実行で1KB以上かつバジェット以下の注入が出る
  - 検証: テスト緑と、ゲートG0の injection 項目
  - _Leverage: src/cli/context.test.ts, src/injection/budget.ts はPhase 4で注入ビルダに統合予定_
  - _Requirements: R-C1, R-C2_
  - _Prompt: Role: backend-engineer | Task: エントリ判定修復とバジェット強制をテスト先行で同一コミットに載せる | Restrictions: 2つを別コミットに分けない。注入内容の再設計（Phase 4）に踏み込まない | Success: 修復後も注入がバジェット以下に収まる_

- [x] 0.11 ゲートG0スクリプトの作成と合成fixture整備（検証役）（未コミット・2026-07-07実装完了、コミットはPdM承認後。詳細は Implementation Logs/task-0.11-g0-gate-implementation.md）
  - File: scripts/gates/g0-hemostasis.ts, scripts/make-eval-snapshot.ts, tests/fixtures/mini-store/（新規）
  - design.md Phase 0 ③の契約（入力、前提アサート、検査6項目、出力形式）どおりに実装する。backup-restore 検査はストアごとに走査する
  - スナップショット作成スクリプト（実DBコピーと秘密値redact）もここで作る
  - 機構検証専用の合成日本語ミニfixture（tests/fixtures/mini-store/。機密ゼロ）を作成し、「ゲートロジックとプロパティテストとスキーマ移行の機構検証専用。recallやトークナイザ実効の品質主張には使わない」のラベルを同梱READMEに明記する（design.md「合成日本語ミニfixture」参照）
  - 出力に記憶本文とクエリ本文を含めない
  - Purpose: フェーズ完了を実行可能な検査にする（R-M3）
  - 完了条件: 契約どおりのG0が動き、前提アサート不成立で検査せずFAILする
  - 検証: 意図的な違反状態（例: バックアップ欠落）でFAILすることの確認出力
  - _Leverage: scripts/backup-store.ts, dream系redact処理_
  - _Requirements: R-M1, R-M3, R-A1_
  - _Prompt: Role: qa-engineer | Task: design.mdの契約どおりG0ゲートとスナップショット作成を実装する | Restrictions: 実装者のコードを修正しない。出力に本文を載せない | Success: PASSとFAILの両方が正しく判定される_

- [x] 0.12 G0実行と出力貼付、ベースライン記録（未コミット・2026-07-07完了、G0全6項目PASS。詳細は Implementation Logs/task-0.12-g0-execution-and-baseline.md）
  - File: Implementation Logs（追記）
  - 実ストアのスナップショットに対してG0を実行し、結果本文を貼付する
  - requirements.md のベースライン数値を同一手順で再取得し、測定手順とともにローカルデータ領域へ保存する
  - Purpose: Phase 1 の着手条件を成立させ、比較原点を凍結する
  - 完了条件: G0全項目PASSの出力本文が貼付され、ベースライン記録が保存済み
  - 検証: 貼付された出力本文のレビュー（exit codeでは判定しない）
  - _Leverage: scripts/gates/g0-hemostasis.ts_
  - _Requirements: R-M1, R-M2_
  - _Prompt: Role: qa-engineer | Task: G0を実行し出力本文を貼付、ベースラインを同一手順で記録する | Restrictions: FAILを隠さない。本文なしのPASS宣言をしない | Success: 出力本文が貼付され全項目PASS_

## Phase 1：土台

目的：状態機械、帰属、埋め込みモデル、並列耐性の土台を固める。
着手条件：G0全項目PASSの出力本文が Implementation Logs に貼付済みであること。
完了条件：ゲートG1の全項目PASSと出力貼付。
注記：本フェーズ内の完了マーク済みタスクは、フェーズゲート運用開始前の先行実施であり、ゲート証跡（G1）は本タスクでは未整備。

- [ ] 1.1 多言語埋め込みモデル候補の実在確認スパイク
  - File: scripts/spikes/spike-multilingual-embedding.ts（新規）
  - 差替え候補モデルを @huggingface/transformers で実際にロードし、次元数と日本語文ペアの類似度サンプルを確認する
  - 候補の実在（ONNX提供の有無）を確認できないモデルは候補から外す
  - Purpose: モデル差替え判断（タスク1.8）の前提事実を固定する
  - 完了条件: 各候補のロード可否と次元数が実行出力で記録されている
  - 検証: スパイク実行出力の貼付
  - _Leverage: src/vector/local-embedding.ts_
  - _Requirements: R-B5, R-M3_
  - _Prompt: Role: backend-engineer | Task: 差替え候補モデルの実在と次元を実行確認する | Restrictions: 本番ストアに書き込まない。想像上のモデル名を使わない | Success: 候補ごとの事実が出力付きで残る_

- [ ] 1.2 日本語トークナイザ先行スパイク（クエリ側整合の再計測）
  - File: scripts/spikes/spike-query-tokenize.ts（新規）
  - クエリ側のフレーズ固定（src/storage/sqlite.ts:814-816 の escapeFtsQuery）をtrigram整合（引用符除去とトークン分割）へ変えた場合のゼロヒット率を、凍結スナップショットと実ログのクエリ集合で再計測する
  - before/after のゼロヒット率を記録し、検索再設計（Phase 2）の要否と規模の判断を1行で書く
  - Purpose: 安価で情報量の多い実験を再設計の前に置く（設計判断D-3-1）
  - 完了条件: before/afterの数値と規模判断が記録されている
  - 検証: 再計測出力の貼付（クエリ本文は出さず件数と率のみ）
  - _Leverage: scripts/spikes/spike-fts5-trigram.ts, スナップショット_
  - _Requirements: R-B1, R-M3_
  - _Prompt: Role: backend-engineer | Task: クエリ側トークナイズ変更だけの効果をスナップショットで再計測する | Restrictions: 本実装に進まない。出力にクエリ本文を載せない | Success: 主因寄与が数値で確定する_

- [x] 1.3 スキーマv6移行のテスト作成（コミット 72f901f・2026-07-10。1.4と同一コミット）
  - File: src/storage/migration-v6.test.ts（新規）
  - 版数注記: v5は予測誤差ループ（コミット8b915a5）で占有済みのため、本Specの土台列移行はv6となる（タスク0.0の版数ベースライン=v5参照）
  - 「state列とproject_confidence列とembedding_model列が追加される」「既存行のstateがdeleted_atから正しくバックフィルされる」「移行前にバックアップが走り、失敗時は移行が中止される」を失敗するテストとして先に書く
  - Purpose: R-A1とR-A2の移行要件をテストで固定する（Red）
  - 完了条件: 移行要件のテストが存在し、実装前は失敗する
  - 検証: テスト実行出力（Red確認）
  - _Leverage: src/storage/migration.test.ts の既存パターン_
  - _Requirements: R-A1, R-A2, R-A4_
  - _Prompt: Role: backend-engineer | Task: v6移行の業務要件をテストで先に固定する | Restrictions: 実装を書かない | Success: 要件どおりの失敗テストが揃う_

- [x] 1.4 スキーマv6移行の実装（コミット 72f901f・2026-07-10）
  - File: src/storage/migration.ts（変更）, src/storage/sqlite.ts（変更）, src/storage/schema.ts（変更）
  - design.md Phase 1 ①の手順（列定義）どおり、版数 5→6 の移行を migrateV5ToV6 として src/storage/migration.ts へ追加し、src/storage/sqlite.ts:44-72 の移行ディスパッチへ配線する。CURRENT_SCHEMA_VERSION（src/storage/schema.ts:3）を6へ更新する
  - タスク1.3のテストを緑にし、リファクタする
  - Purpose: 状態機械と帰属信頼度とモデル版数の土台列を入れる
  - 完了条件: 実スナップショットで移行が成功し schema_version テーブルの MAX(version)=6 になる
  - 検証: テスト緑と、スナップショットでの移行実行出力
  - _Leverage: src/storage/migration.ts の migrateVXToVY 関数群, src/storage/sqlite.ts:44-72 の移行ディスパッチ, scripts/backup-store.ts_
  - _Requirements: R-A2, R-A4, R-B5_
  - _Prompt: Role: backend-engineer | Task: v6移行を既存機構に追記しテストを緑にする | Restrictions: 既存列の削除や改名をしない。新規移行フレームワークを作らない | Success: 移行後の全件でstateとdeleted_atが同期_

- [x] 1.5 読み経路への状態可視性の適用（コミット cea316f・2026-07-10）
  - File: src/storage/sqlite.ts（変更）, src/tools/getDetail.ts（変更）, 対応テスト
  - ①design.md の可視性マトリクスを失敗するテストとして先に書く（検索と注入と統合は active のみ、get_detail は archived まで、deleted は全経路不可）
  - ②各読みクエリへ state 条件を統一適用する
  - Purpose: 不可視性の判定をクエリごとの個別実装から状態機械へ集約する
  - 完了条件: 全読み経路がマトリクスどおりに動く
  - 検証: テスト緑と、ゲートG1の pt-invariants 項目
  - _Leverage: src/storage/sqlite.ts:409 の既存フィルタ_
  - _Requirements: R-A2_
  - _Prompt: Role: backend-engineer | Task: 可視性マトリクスをテスト先行で全読み経路へ適用する | Restrictions: ランキング変更に踏み込まない（Phase 2対象） | Success: deletedがどの経路からも返らない_

- [x] 1.6 backfillの蘇生禁止と削除済みベクトル751件の一括掃除（コミット 56cb443・2026-07-04）
  - 実装注記: 実体は scripts/maintenance/purge-tombstones.mjs。掃除対象は tombstone（論理削除済み）行に対応する vectors／vector_metadata 行に加え、tombstone化した memories 行自体も物理削除する（本タスク原文の「memories本体の行を消さない」制約とは異なる実装。dry-run既定・--applyで実削除）
  - File: src/storage/sqlite.ts（変更）, scripts/cleanup-orphan-vectors.ts（新規）, 対応テスト
  - ①「backfill対象の抽出が active に限定される」「掃除後に deleted 対応のベクトル行が0件」を失敗するテストとして先に書く
  - ②getEntriesWithoutEmbedding（src/storage/sqlite.ts:535-543）へ状態フィルタを追加する
  - ③残存751件をトランザクション内で一括削除する掃除スクリプトを実装し、削除件数を出力する
  - Purpose: 蘇生事故（症状⑥）の根治
  - 完了条件: 蘇生経路が存在せず、残存ベクトルが掃除済み
  - 検証: テスト緑と、ゲートG1の resurrection-zero 項目
  - _Leverage: src/consolidator/persistence-helper.ts:84-92 の削除実装_
  - _Requirements: R-A2_
  - _Prompt: Role: backend-engineer | Task: backfillの状態フィルタと孤児ベクトル掃除をテスト先行で実装する | Restrictions: memories本体の行を消さない（消すのはベクトル行のみ） | Success: 掃除後の孤児ベクトル0件が出力で確認できる_

- [ ] 1.7 状態機械プロパティテスト PT-01 と PT-05 の作成（検証役）
  - File: tests/properties/state-machine.property.test.ts（新規）
  - fast-check を導入し（exact pin）、design.md の不変条件I1からI4をプロパティテスト化する
  - 生成器は状態遷移列と読み経路呼び出しの組み合わせを作る
  - Purpose: 不変条件を「全パターンで成り立つ性質」として固定する（R-M3）
  - 完了条件: PT-01とPT-05が存在し緑である
  - 検証: テスト実行出力
  - _Leverage: vitest基盤, design.md の不変条件定義_
  - _Requirements: R-A2, R-M3_
  - _Prompt: Role: qa-engineer | Task: 状態機械の不変条件をfast-checkでプロパティテスト化する | Restrictions: 実装コードを修正しない。違反発見時は再現最小ケースを添えて差し戻す | Success: 生成ケースで不変条件が全件成立_

- [x] 1.8 埋め込みモデルの日本語実測評価と差替え判断（コミット a9cb7ab・2026-07-04）
  - File: scripts/evaluate-embedding-models.ts（新規）
  - 現行モデルと候補モデルで、実スナップショット由来の日本語ペア（類似ペアと非類似ペア）の分離度を実測する
  - 差替えるか据え置くかの判断と根拠を1行で記録する（判断はPdM承認）
  - Purpose: 英語向けモデルが日本語で類似を出せない疑い（症状③の一因）を実測で確定する
  - 完了条件: 評価数値と差替え判断が記録されている
  - 検証: 評価スクリプト実行出力（本文を含めず数値のみ）
  - _Leverage: scripts/spikes/spike-multilingual-embedding.ts_
  - _Requirements: R-B5_
  - _Prompt: Role: backend-engineer | Task: 現行と候補モデルの日本語分離度を実測し判断材料を作る | Restrictions: 出力に記憶本文を載せない。判断の確定はPdMに委ねる | Success: モデル選定が実測数値で裏づけられる_

- [x] 1.9 新ベクトル表と全件再埋め込み（混在禁止アサート込み）（コミット a9cb7ab・2026-07-04）
  - 実装注記: 新旧モデルが同一次元（384）だったため、別名の新ベクトル表・embedding_model列によるバージョン管理・起動時の混在拒否アサートは実装されていない。既存の vectors 表を使い回した直接差し替え＋全件再埋め込み（scripts/maintenance/reembed-all.mjs）で完了した
  - File: src/vector/local-embedding.ts（変更）, src/storage/schema.ts（変更）, scripts/reembed-all.ts（新規）, 対応テスト
  - 対象の特定: 検索用の再埋め込み対象はローカル埋め込み（src/vector/local-embedding.ts、384次元）。src/vector/embedding-service.ts はGemini経由のクラウド埋め込み（768次元、別用途）であり、その再埋め込みは本タスクのnon-goal（触らない）
  - ①「再埋め込み完了前は新モデル検索が起動時アサートで拒否される」「完了後の embedding_model が単一値」「正規化されていないベクトルの保存が拒否される」を失敗するテストとして先に書く
  - ②新モデル用ベクトル表を別名で新設し、参照はコード側の定数で切り替える。旧表は並存保持する
  - ③全件再埋め込みバッチ（再開可能、進捗計数つき）を実装する
  - ④モデル据え置き判断の場合は、本タスクは正規化アサートと版数刻印のみ実施し、その旨を記録する
  - Purpose: 新旧混在の沈黙破損（R-B5）を構造的に防ぐ
  - 完了条件: 生存全件が単一モデルのベクトルを持つ（または据え置き記録がある）
  - 検証: テスト緑と、ゲートG1の embedding-single-model 項目
  - _Leverage: src/vector/local-embedding.ts, src/cli/backfill-worker.ts_
  - _Requirements: R-B5_
  - _Prompt: Role: backend-engineer | Task: 版数管理つき再埋め込みをテスト先行で実装する | Restrictions: 旧表を削除しない。完了ゲート前に新モデル検索を有効化しない | Success: 混在状態が起動時に検出され拒否される_

- [x] 1.10 保存時project刻印の修正（コミット bf622d6・2026-07-10）
  - File: src/tools/save.ts（変更）, 対応テスト
  - 完了済み: project任意引数の追加（コミット 2911955・2026-07-05）。呼び出し側が project を明示すればその値が刻印される
  - 完了: ①「project省略時の保存で project 列が unknown 明示刻印される」「省略時に標準エラー警告が出る」テストを先に書いた（src/tools/save-project-attribution.test.ts） ②project省略時の暗黙cwdフォールバック（旧 src/tools/save.ts:152-156 の basename(projectRoot) 代入）を、unknown明示刻印＋標準エラー警告へ置換した（design.md 禁止フォールバック#5に整合）。project明示時はproject_confidence='confirmed'、省略時は'unknown'をスキーマv6のproject_confidence列へ記録する配線も同時実装した。副作用として project='unknown' が実在の非NULL値になるため、search/searchHybrid/readConfigEntries/readAliveDontEntries等の全project絞り込み経路にproject='unknown'の素通しを追加し、R-A4 AC3（不明バケツをフィルタの裏に消さない）を維持した
  - Purpose: 全件が単一project刻印になる構造（症状①の一因）の根治
  - 完了条件: project省略保存でproject列が unknown になること・既存テストと本番経路スモークが緑のこと
  - 検証: テスト緑（project省略ケースを含む）と production-path-smoke の結果
  - _Leverage: 既存の save系テスト, src/tools/save-project-attribution.test.ts_
  - _Requirements: R-A4_
  - _Prompt: Role: backend-engineer | Task: project省略時の暗黙フォールバックをテスト先行でunknown明示化する | Restrictions: 特定不能時に推測で埋めない（unknownを明示する） | Success: 省略時に必ずunknownが刻印される_

- [x] 1.11 projectの決定論バックフィル（strictティア158件・2026-07-07適用済みとDB照合で確定）
  - File: scripts/maintenance/backfill-project-attribution.mjs（実装済み）
  - 実装済み: 決定論的手掛かり（title/tagsに既知プロジェクト名がちょうど1個出現し、起動プロジェクト名と共起しない）のみで判定するprecision優先方式。--tier 3段（recommended/strict/loose）でdry-run既定、--applyで実更新。LLMによる一括再分類はしない
  - recommendedティアは適用済み（1,498件を再帰属）。strictティア該当158件はオーナー承認のうえ2026-07-07セッションで適用済み（handoff-20260707-wasurenagusa-effect-verification-and-spec-rebaseline.md:150「158件全件が更新され、データベースの整合性検査は正常」）。残り約7,869件は現状維持で確定
  - 2026-07-10 pre-flight検証: 実データ照合で確定した。firebase-kit（起動プロジェクト）のmemory.dbへ本番同一スクリプトを--tier=strictでdry-run再実行した結果、strictティア再帰属対象は2件のみ（2026-07-07適用後に新規保存された記憶による残差で、当時の158件バッチとは別物）。158件バッチ自体の未適用残存はゼロと確定した。詳細はImplementation Logs/task-1.11-strict-tier-backfill-verification.md
  - Purpose: 誤帰属の沈黙欠損を避けつつ帰属を回復する（R-A4）
  - 完了条件: strictティア158件の去就（適用／見送り）が承認結果どおりに確定している → 充足（適用確定）
  - 検証: 実行出力（件数のみ）の記録。Implementation Logs/task-1.11-strict-tier-backfill-verification.md 参照
  - _Leverage: scripts/maintenance/backfill-project-attribution.mjs_
  - _Requirements: R-A4_
  - _Prompt: Role: data-investigator | Task: strictティア158件のオーナー承認結果を反映する | Restrictions: LLM分類を使わない。承認外の行に手を加えない | Success: 158件の去就が承認どおりに確定する_

- [x] 1.12 書き込み失敗計数の導入とWAL設定の確認固定（コミット 8dd5912・2026-07-10）
  - File: src/storage/sqlite.ts（変更）, src/observability/counters.ts（変更）, src/storage/write-resilience.test.ts（新規）
  - 前提の事実: WALとbusyタイムアウトはHEADで設定済み（src/storage/schema.ts:112-113）。新規設定は不要で、確認とテスト固定のみ行った
  - ①「接続がWALモードでbusyタイムアウト設定済み（既存設定の固定）」「書き込み失敗が計数と警報になり、握りつぶされない」を失敗するテストとして先に書いた（Red確認済み）
  - ②save/delete/softDeleteのcatchを計数つき再throwへ統一した（recordWriteFailureヘルパー、write_failure_countメトリクス新設）
  - Purpose: 多並列実態での沈黙データ損失を防ぐ（R-A5）
  - 完了条件: 並行書き込みテストで失敗が可視化される → 充足
  - 検証: テスト緑（全5ケース）。npm run build / npx vitest run 全緑 / production-path-smoke 4/4 PASS
  - _Leverage: src/observability/counters.ts, src/storage/schema.ts:112-113_
  - _Requirements: R-A5_
  - _Prompt: Role: backend-engineer | Task: 書き込み失敗の計数付き再throwをテスト先行で導入しWAL設定をテストで固定する | Restrictions: catchで代替値を返さない（計数して再throw）。設定済みのPRAGMAを重複追加しない | Success: 競合時の失敗がカウンタに現れる_

- [ ] 1.13 埋め込みモデルの共有キャッシュ化と旧世代 vectors.json の廃棄
  - File: src/config.ts（変更）, src/vector/local-embedding.ts（変更）, scripts/retire-legacy-vectors.ts（新規）, 対応テスト
  - ①「モデルキャッシュ先が環境変数 WASURENAGUSA_MODEL_CACHE_DIR で共有先へ向く（未設定時は従来動作）」を失敗するテストとして先に書く
  - ②キャッシュ先解決（src/config.ts:78）を変更し、既存7ストアの重複を共有1箇所へ集約する手順スクリプトを添える
  - ③vectors.json はバックアップ取得を確認してから退避リネームする（削除はしない）
  - Purpose: 522MBの重複回収と95MBの遺物整理（R-B8）
  - 完了条件: モデル実体が1箇所になり、旧世代ファイルが読み経路から外れている
  - 検証: テスト緑と、ゲートG1の shared-cache 項目
  - _Leverage: scripts/backup-store.ts_
  - _Requirements: R-B8_
  - _Prompt: Role: backend-engineer | Task: モデル共有キャッシュ化と遺物退避をテスト先行で実装する | Restrictions: バックアップ未確認での退避をしない。v1ファイルを削除しない | Success: 重複が解消され従来環境でも動く_

- [ ] 1.14 ゲートG1スクリプトの作成（検証役）
  - File: scripts/gates/g1-foundation.ts（新規）
  - design.md Phase 1 ③の契約どおりに実装する（前提アサートと検査8項目）
  - Purpose: 土台フェーズの完了を実行可能な検査にする
  - 完了条件: 契約どおりのG1が動き、違反状態でFAILする
  - 検証: 意図的な違反状態（例: 混在ベクトル）でのFAIL確認出力
  - _Leverage: scripts/gates/g0-hemostasis.ts の共通形式_
  - _Requirements: R-M3_
  - _Prompt: Role: qa-engineer | Task: design.mdの契約どおりG1を実装する | Restrictions: 実装者のコードを修正しない。出力に本文を載せない | Success: PASSとFAILの両方が正しく判定される_

- [ ] 1.15 G1実行と出力貼付
  - File: Implementation Logs（追記）
  - スナップショットに対してG1を実行し、結果本文を貼付する
  - Purpose: Phase 2 の着手条件を成立させる
  - 完了条件: G1全項目PASSの出力本文が貼付されている
  - 検証: 貼付された出力本文のレビュー
  - _Leverage: scripts/gates/g1-foundation.ts_
  - _Requirements: R-M3_
  - _Prompt: Role: qa-engineer | Task: G1を実行し出力本文を貼付する | Restrictions: FAILを隠さない | Success: 全項目PASSの本文が残る_

## Phase 2：検索再建

目的：段階フォールバックとRRFと時間減衰で検索を再建し、実測比較後に切り替える。
着手条件：G1全項目PASSの出力本文が Implementation Logs に貼付済みであること。
完了条件：ゲートG2の全項目PASSと出力貼付。
注記：本フェーズ内の完了マーク済みタスクは、フェーズゲート運用開始前の先行実施であり、ゲート証跡（G2）は本タスクでは未整備。

- [ ] 2.1 ゴールデンセットの採取と凍結（検証役）
  - File: ローカルデータ領域 ${WASURENAGUSA_EVAL_DIR}/golden-queries.jsonl（Git外）
  - 実操作ログから design.md のゴールデンセット形式で50問以上を採取する。「正しくゼロ件」クラスを10問以上含める
  - 正解ラベルには「現行有効か（廃止済み決定でないか）」の注記を付ける
  - チェックサムを記録して凍結する。実体もクエリ本文も公開リポジトリに置かない
  - Purpose: 検索評価の物差しを実装から独立に固定する（R-B6、R-M3）
  - 完了条件: 50問以上が凍結され、チェックサムが記録されている
  - 検証: 件数とクラス内訳とチェックサムの記録（本文なし）
  - _Leverage: logs/operation-*.jsonl_
  - _Requirements: R-B6, R-M3_
  - _Prompt: Role: qa-engineer | Task: 実ログからゴールデンセットを採取し形式どおり凍結する | Restrictions: 実装者に採取させない。クエリ本文をリポジトリに置かない | Success: 凍結済みセットの統計だけが記録に残る_

- [ ] 2.2 評価コーパスの凍結スナップショット作成
  - File: ローカルデータ領域 ${WASURENAGUSA_EVAL_DIR}/snapshots/（Git外）
  - タスク0.11のスナップショット作成スクリプトで評価用DBを固定し、チェックサムを記録する
  - 評価期間中のコーパス変更（サルベージ流入を含む）を禁止する旨を記録する
  - Purpose: 評価の再現性を守る（R-B7の分離要件）
  - 完了条件: スナップショットとチェックサムが存在する
  - 検証: チェックサム記録
  - _Leverage: scripts/make-eval-snapshot.ts_
  - _Requirements: R-B6, R-B7_
  - _Prompt: Role: qa-engineer | Task: 評価コーパスを凍結しチェックサムを記録する | Restrictions: 原本に書き込まない | Success: 評価が同一コーパスで再現できる_

- [ ] 2.3 評価スクリプト（recall@k と正しくゼロ件）の作成（検証役）
  - File: scripts/gates/eval-golden.ts（新規）
  - ゴールデンセットを読み、recall@1 / @5 / @10 と「正しくゼロ件」クラスの成績を出力する
  - 出力はゴールデンID（GQ-xxx）と数値のみ。クエリ本文を出さない
  - Purpose: G2の中核検査を再利用可能なスクリプトにする
  - 完了条件: 現行検索に対するベースライン成績が出力できる
  - 検証: 現行検索での実行出力（比較原点として貼付）
  - _Leverage: scripts/gates/g0-hemostasis.ts の共通形式_
  - _Requirements: R-B6, R-M3_
  - _Prompt: Role: qa-engineer | Task: ゴールデン評価スクリプトを作成し現行成績を出す | Restrictions: 実装者のコードを修正しない。本文を出力しない | Success: recallと正しくゼロ件の成績が数値で出る_

- [x] 2.4 段階フォールバッククエリビルダ（コミット 89e5813・2026-07-04）
  - 実装注記: 実体は独立モジュールではなく src/storage/sqlite.ts への直接実装（2.5・2.6と同一コミット）
  - File: src/search/query-builder.ts, src/search/query-builder.test.ts（新規）
  - ①「フレーズ→AND→OR の順で試行し、最初にヒットした段を採用する」「各段の発火が計数される」「2文字以下の語の扱いがスパイク確認どおり」を失敗するテストとして先に書く
  - ②タスク0.2で確認済みの構文のみでビルダを実装する
  - Purpose: 自然文クエリの構造的空振り（症状①）の根治
  - 完了条件: 段階フォールバックが計数つきで動く
  - 検証: テスト緑（日本語自然文ケースを含む）
  - _Leverage: scripts/spikes/spike-fts5-trigram.ts の確認結果, src/observability/counters.ts_
  - _Requirements: R-B1_
  - _Prompt: Role: backend-engineer | Task: 段階フォールバッククエリビルダをテスト先行で実装する | Restrictions: スパイク未確認の構文を使わない。順位付けに踏み込まない | Success: 各段の発火が観測できる_

- [x] 2.5 候補プール拡大とRRF統合（コミット 89e5813・2026-07-04）
  - 実装注記: 実体は独立モジュールではなく src/storage/sqlite.ts への直接実装（2.4・2.6と同一コミット）
  - File: src/search/rrf.ts, src/search/rrf.test.ts（新規）, src/storage/sqlite.ts（変更）
  - ①「FTSとベクトルの候補プールが各20件」「RRFが経路ごとの順位のみを使う」「欠損経路のスコアが捏造されない（禁止フォールバック#2）」を失敗するテストとして先に書く
  - ②LIMIT 5 の候補取得（src/storage/sqlite.ts:405-406、:415）を拡大し、RRF統合を実装する
  - Purpose: 上限5件の押し出し（症状①）と満点捏造の根治
  - 完了条件: RRF順位が両経路の順位から決まる
  - 検証: テスト緑（片経路欠損のケースを含む）
  - _Leverage: src/search/query-builder.ts_
  - _Requirements: R-B1_
  - _Prompt: Role: backend-engineer | Task: 候補プール拡大とRRFをテスト先行で実装する | Restrictions: 欠損経路に既定スコアを与えない | Success: 両経路の順位が統合結果に反映される_

- [x] 2.6 時間減衰ランキング（コミット 89e5813・2026-07-04）
  - 実装注記: 実体は独立モジュールではなく src/storage/sqlite.ts への直接実装（2.4・2.5と同一コミット）。タスク2.7〜2.9が前提とする新旧並走モジュール構成（src/search/配下の別実装とshadow.ts）は存在せず、本番コードを直接置換した
  - File: src/search/time-decay.ts, src/search/time-decay.test.ts（新規）
  - ①「最終順位が rrfScore × 半減期減衰 で決まる」「時系列単独の並びが存在しない」を失敗するテストとして先に書く
  - ②半減期は設定値（既定90日）とし、timestamp DESC の最終並び（src/storage/sqlite.ts:452-453）を置き換える
  - Purpose: 関連度を捨てて時系列で並べる欠陥（症状①）の根治。recencyは素性として残す
  - 完了条件: 古い高関連と新しい低関連の順位がテストで検証されている
  - 検証: テスト緑
  - _Leverage: src/search/rrf.ts_
  - _Requirements: R-B2_
  - _Prompt: Role: backend-engineer | Task: 時間減衰ランキングをテスト先行で実装する | Restrictions: 純関連度への一本化をしない（減衰素性を残す） | Success: 減衰の有無で順位が意図どおり変わる_

- [ ] 2.7 読み経路の書き込み副作用の廃止
  - File: src/tools/search.ts（変更）, 対応テスト
  - 前提注記: 新検索は89e5813で本番実装（src/storage/sqlite.ts）へ直接置換済みで、新旧並走のモジュール構成（src/search/配下の別実装）は存在しない。効果確認は2.1〜2.3の評価体系（ゴールデンセット＋凍結スナップショット＋評価スクリプト）と本番経路スモークで行う
  - ①「検索実行後にいかなるエントリの intensity も timestamp も変わらない」を失敗するテストとして先に書く
  - ②検索中の破壊的自動昇格（src/tools/search.ts:125-152）を除去し、利用実績の反映は既存の検索スコア加点に一本化する
  - ③search.ts に try/finally を入れてDBハンドルのリークも同時に塞ぐ（同一関数の根治範囲）
  - Purpose: 読み取りの無副作用（不変条件I3）。時間減衰順位の汚染防止
  - 完了条件: 読み経路に書き込みが存在しない
  - 検証: テスト緑と、PT-01の再実行と、本番経路スモーク
  - _Leverage: src/vector/search-scorer.ts_
  - _Requirements: R-B2, R-A2_
  - _Prompt: Role: backend-engineer | Task: 検索の書き込み副作用をテスト先行で廃止する | Restrictions: スコア加点ロジック自体は変えない | Success: 検索前後でDB内容が不変_

- [ ] 2.8 自己検索性プロパティテスト PT-04 の作成と修正ループ（検証役と実装者）
  - File: tests/properties/self-search.property.test.ts（新規）
  - 前提注記: 検査対象は本番検索実装（src/storage/sqlite.ts。89e5813で直接置換済み）。並走用の別実装は存在しない
  - 検証役が「全生存エントリは自身の本文をクエリにすると上位10件に入る」を実スナップショット全件で検査するテストを書く
  - 失敗が出た場合、実装者が原因を分類して修正し、再実行する（失敗の出力は件数と分類のみ）
  - Purpose: 「保存した記憶はその内容自身で必ず見つかる」の全件保証（R-B3）
  - 完了条件: 全件で自己検索性が成立する
  - 検証: PT-04の実行出力（達成率100%）
  - _Leverage: src/storage/sqlite.ts の検索実装, scripts/eval/self-retrieval.mjs, スナップショット_
  - _Requirements: R-B3, R-M3_
  - _Prompt: Role: qa-engineer | Task: 自己検索性を全件プロパティテスト化する | Restrictions: 実装都合で基準を緩めない。本文を出力しない | Success: 達成率100%が出力で確認できる_

- [ ] 2.9 検索再建の実測評価（シャドー並走の代替）
  - File: レポートはローカルデータ領域
  - 再定義注記: 新検索は89e5813で本番へ直接置換済みのため、旧検索を本番に残したままのシャドー並走は成立しない。切替妥当性の事後確認へ目的を変更する
  - 2.1〜2.3の評価体系（ゴールデンセット＋凍結スナップショット＋評価スクリプト）で現行検索の成績（recall@k、正しくゼロ件、ゼロヒット率）を測る。切替前成績は旧検索実装（89e5813の親コミットのビルド）を同一の凍結スナップショットとゴールデンセットに対して実行して取得し、前後対比レポートを作る
  - 併せて本番経路スモーク（scripts/verify/production-path-smoke.mjs）で実起動経路の動作を確認する
  - 主要指標に退行があれば、89e5813系コミットのrevertによる切り戻しをPdMへ提案する
  - Purpose: fixture合格だけで切替済みとしない（R-B6-5の趣旨を事後評価で担保）
  - 完了条件: 前後対比レポートが存在し、現行系が主要指標で切替前以上である（またはrevert提案が出ている）
  - 検証: レポート本文（数値のみ）の貼付とスモーク結果
  - _Leverage: scripts/gates/eval-golden.ts, scripts/verify/production-path-smoke.mjs, src/observability/counters.ts_
  - _Requirements: R-B6_
  - _Prompt: Role: qa-engineer | Task: ゴールデン評価と本番経路スモークで切替前後の対比レポートを作る | Restrictions: 結論を先に決めて測らない。退行を隠さない | Success: 前後対比が同一物差しの数値で残る_

- [ ] 2.10 検索hintへのフォールバック段ラベル追加
  - File: src/storage/search-hint.ts（変更）, src/tools/search.ts（変更）, 対応テスト
  - 済み: ヒント文言の一元化とマージ後件数からの再導出（src/storage/search-hint.ts、コミット 626f8d1）
  - 残作業: hint出力に発火したフォールバック段（フレーズ／AND／OR）のラベルを追加する
  - Purpose: ヒットの経路可視化
  - 完了条件: hintにフォールバック段ラベルが含まれる
  - 検証: テスト緑と、実検索でのhint確認
  - _Leverage: src/storage/search-hint.ts_
  - _Requirements: R-B1, R-B6_
  - _Prompt: Role: backend-engineer | Task: hintへフォールバック段ラベルを追加する | Restrictions: 既存のヒント文言・件数再導出ロジックを変えない | Success: hintに発火段が見える_

- [ ] 2.11 ゲートG2スクリプトの作成（検証役）
  - File: scripts/gates/g2-search.ts（新規）
  - design.md Phase 2 ③の契約どおりに実装する（ゴールデン前提アサート、recall、correct-zero、self-search、fallback-counters、shadow-report）
  - Purpose: 検索再建の完了を実行可能な検査にする
  - 完了条件: 契約どおりのG2が動き、違反状態でFAILする
  - 検証: 意図的な違反状態（例: ゴールデン件数不足）でのFAIL確認出力
  - _Leverage: scripts/gates/eval-golden.ts_
  - _Requirements: R-M3_
  - _Prompt: Role: qa-engineer | Task: design.mdの契約どおりG2を実装する | Restrictions: 実装者のコードを修正しない | Success: PASSとFAILの両方が正しく判定される_

- [ ] 2.12 G2実行と出力貼付
  - File: Implementation Logs（追記）
  - 凍結スナップショットとゴールデンセットでG2を実行し、結果本文を貼付する
  - Purpose: Phase 3 の着手条件を成立させる
  - 完了条件: G2全項目PASS（recall@5がベースライン0.500超を含む）の出力本文が貼付されている
  - 検証: 貼付された出力本文のレビュー
  - _Leverage: scripts/gates/g2-search.ts_
  - _Requirements: R-B6, R-M3_
  - _Prompt: Role: qa-engineer | Task: G2を実行し出力本文を貼付する | Restrictions: FAILを隠さない | Success: 全項目PASSの本文が残る_

## Phase 3：代謝（統合と昇格）

目的：追記型統合の再稼働、昇格の人間ゲート、在庫の回収。
着手条件：G2全項目PASSの出力本文が Implementation Logs に貼付済みであること。
完了条件：ゲートG3の全項目PASSと出力貼付。

- [ ] 3.1 スキーマv7移行のテスト作成
  - File: src/storage/migration-v7.test.ts（新規）
  - 「lineage と principles テーブルが design.md の定義どおり作られる」「必須列欠落の行が拒否される」「移行前バックアップが走る」を失敗するテストとして先に書く
  - Purpose: 系譜と昇格の土台要件を固定する（Red）
  - 完了条件: 移行要件のテストが存在し、実装前は失敗する
  - 検証: テスト実行出力（Red確認）
  - _Leverage: src/storage/migration-v6.test.ts_
  - _Requirements: R-A6, R-A7_
  - _Prompt: Role: backend-engineer | Task: v7移行の要件をテストで先に固定する | Restrictions: 実装を書かない | Success: 要件どおりの失敗テストが揃う_

- [ ] 3.2 スキーマv7移行の実装
  - File: src/storage/schema.ts（変更）, src/storage/migration.ts（変更）
  - design.md Phase 3 ①の手順（テーブル定義）どおり、schema_version テーブルの MAX(version) を 6→7 にする移行を migrateV6ToV7 として実装し、タスク3.1を緑にする
  - Purpose: 追記型統合と人間ゲートのデータ土台
  - 完了条件: スナップショットで移行が成功し schema_version テーブルの MAX(version)=7 になる
  - 検証: テスト緑と移行実行出力
  - _Leverage: src/storage/migration.ts の migrateVXToVY 関数群, src/storage/sqlite.ts:44-72 の移行ディスパッチ_
  - _Requirements: R-A6, R-A7_
  - _Prompt: Role: backend-engineer | Task: v7移行を実装しテストを緑にする | Restrictions: 既存テーブルの列を変更しない | Success: 新テーブル2つが制約つきで存在する_

- [ ] 3.3 距離尺度の型封じ
  - File: src/vector/distance-types.ts, src/vector/distance-types.test.ts（新規）, src/vector/cosine-distance.ts（変更）
  - ①「同一尺度同士しか比較できない」「尺度混同コードがコンパイルエラーになる（型レベルのネガティブテスト）」「l2ToCosineSim が正規化前提で正しい値を返す」を失敗するテストとして先に書く
  - ②design.md の型定義を実装し、既存の生数値閾値（src/cli/consolidate-all.ts:75、src/vector/memory-tier.ts:9-13）を Threshold 型へ置換する
  - Purpose: 尺度取り違え（症状③）を型エラーで再発防止する（R-B4）
  - 完了条件: 閾値の生数値持ち回りがコードベースから消えている
  - 検証: テスト緑と、ゲートG3の distance-types 項目
  - _Leverage: src/vector/cosine-distance.ts_
  - _Requirements: R-B4_
  - _Prompt: Role: backend-engineer | Task: 距離尺度のbranded typesをテスト先行で導入する | Restrictions: 閾値の数値自体はこの段階で変えない（較正はタスク3.6） | Success: 混同コードがコンパイルで落ちる_

- [ ] 3.4 カテゴリ限定KNNと距離単位の統一
  - File: src/cli/consolidate-all.ts（変更）, src/storage/sqlite.ts（変更）, 対応テスト
  - ①「統合の近傍探索が対象カテゴリで事前に絞り込まれる」「類似判定がコサイン類似度の型で行われる」を失敗するテストとして先に書く
  - ②全カテゴリ1万ベクトルへのKNN（src/storage/sqlite.ts:526-534）をカテゴリ絞り込みつきに変え、閾値適用を型経由へ置き換える
  - Purpose: 近傍枠の浪費と尺度誤適用（症状③）の根治
  - 完了条件: dont統合の候補生成がカテゴリ内で行われる
  - 検証: テスト緑
  - _Leverage: src/vector/distance-types.ts, タスク0.1の確認構文_
  - _Requirements: R-A6, R-B4_
  - _Prompt: Role: backend-engineer | Task: カテゴリ限定KNNと型経由の閾値適用をテスト先行で実装する | Restrictions: マージ実行にはまだ進まない（dry-runのまま） | Success: 候補クラスタが実データで生成される_

- [ ] 3.5 ラベル付きペアの作成（検証役）
  - File: ローカルデータ領域 ${WASURENAGUSA_EVAL_DIR}/merge-labels.jsonl（Git外）
  - design.md の形式で same 50件以上と different 50件以上を人手ラベルで作成する
  - 統合候補クラスタと、表現が似て意味が異なるペアの両方を含める
  - Purpose: 閾値較正と誤統合率測定の物差し（R-M3）
  - 完了条件: 最小件数を満たすラベル集合が存在する
  - 検証: 件数内訳の記録（本文なし）
  - _Leverage: 夜間dry-runレポートの候補クラスタ_
  - _Requirements: R-A6, R-M3_
  - _Prompt: Role: qa-engineer | Task: 統合評価用のラベル付きペアを人手で作成する | Restrictions: 実装者に作らせない。本文をリポジトリに置かない | Success: same/differentが各50件以上揃う_

- [ ] 3.6 類似閾値の実データ較正
  - File: scripts/calibrate-merge-threshold.ts（新規）
  - ラベル付きペアに対する類似度分布を出し、誤統合率（different を統合と誤る率）が仮基準5%以下になる閾値を確定して記録する
  - Purpose: 「様子見の0.6」を実測値へ置き換える（症状③の根治）
  - 完了条件: 確定閾値とその根拠分布が記録されている
  - 検証: 較正スクリプトの実行出力（数値のみ）
  - _Leverage: src/vector/distance-types.ts, merge-labels.jsonl_
  - _Requirements: R-A6_
  - _Prompt: Role: backend-engineer | Task: ラベル付きペアで統合閾値を較正し記録する | Restrictions: ラベルを書き換えない。出力に本文を載せない | Success: 閾値が誤統合率の実測で裏づけられる_

- [ ] 3.7 追記型マージの実装
  - File: src/consolidator/persistence-helper.ts（変更）, src/consolidator/lineage.ts（新規）, 対応テスト
  - ①「マージ結果が新レコードで追加される」「原本の本文が変更も物理削除もされない」「マージ結果の100%に merged_from 系譜が付く」「吸収された原本は deleted へ遷移し、索引行が同一トランザクションで除去される」を失敗するテストとして先に書く
  - ②追記型マージと系譜記録を実装する
  - Purpose: 不可逆な原本破壊の禁止（R-A6）
  - 完了条件: マージ前後で原本ハッシュが全件不変
  - 検証: テスト緑と、ゲートG3の append-only と lineage-complete 項目
  - _Leverage: src/storage/sqlite.ts の状態遷移, prompts/consolidate-cluster.txt_
  - _Requirements: R-A6, R-A2_
  - _Prompt: Role: backend-engineer | Task: 追記型マージと系譜をテスト先行で実装する | Restrictions: 原本行のUPDATEをしない。物理DELETEをしない | Success: 系譜から原本へ遡れる_

- [ ] 3.8 矛盾解決（supersedes）の実装
  - File: src/consolidator/lineage.ts（変更）, src/search/ 応答整形（変更）, 対応テスト
  - ①「新決定が旧決定を陳腐化させると supersedes が記録される」「検索応答で superseded の旧決定に後継ポインタが表示される」を失敗するテストとして先に書く
  - ②統合フローの一級要件として supersedes 判定（LLMの意味判断＋コードの記録）を実装する
  - Purpose: 廃止済み決定が無印で検索に出る問題（R-A6-3、精度指標の背景）の根治
  - 完了条件: 新旧矛盾ペアで後継関係が可視化される
  - 検証: テスト緑
  - _Leverage: src/consolidator/lineage.ts_
  - _Requirements: R-A6_
  - _Prompt: Role: backend-engineer | Task: supersedes記録と表示をテスト先行で実装する | Restrictions: 旧決定を削除しない（関係の明示のみ） | Success: 閲覧者が新旧を判別できる_

- [ ] 3.9 夜間統合の上限件数とdry-run経由の再開手順
  - File: src/cli/consolidate-all.ts（変更）, 対応テスト
  - ①「1晩の統合件数が上限で止まる」「書き込み再開はdry-runレポートの確認記録を前提にする」を失敗するテストとして先に書く
  - ②上限つきの書き込みモードを実装する（既定はdry-runのまま。切替は設定でなく明示コミット）
  - Purpose: 初回一括統合を最大の事故日にしない（R-A6-4、R-A6-5）
  - 完了条件: 上限遵守がログで確認できる
  - 検証: テスト緑と、ゲートG3の batch-cap 項目
  - _Leverage: src/observability/counters.ts_
  - _Requirements: R-A6_
  - _Prompt: Role: backend-engineer | Task: 統合の上限件数と再開手順をテスト先行で実装する | Restrictions: 既定をdry-runから変えない | Success: 上限超過分が翌晩へ持ち越される_

- [ ] 3.10 LLM出力の業務整合性ガード（warning設計）
  - File: src/consolidator/output-guard.ts, src/consolidator/output-guard.test.ts（新規）
  - ①「sourceIds が入力ID集合の部分集合でなければ warning と計数を残し当該フィールドを破棄する」「category がenum外なら同様」「throwしない」「JSONパース失敗はバッチスキップと計数」を失敗するテストとして先に書く
  - ②統合と起草とサルベージ判定の全LLM出力へ共通適用する
  - Purpose: sourceIds捏造の沈黙空振りと無検証キャストの根治（llm-design 4原則の④）
  - 完了条件: 3種のLLM出力すべてがガード経由になっている
  - 検証: テスト緑（捏造IDと不正enumのケースを含む）
  - _Leverage: src/observability/counters.ts_
  - _Requirements: R-A6, R-A7_
  - _Prompt: Role: backend-engineer | Task: 入力差分判定のLLM出力ガードをwarning設計でテスト先行実装する | Restrictions: throwで強制しない。ガードをLLMに実装させない（全部コード） | Success: 捏造フィールドが破棄され計数される_

- [ ] 3.11 昇格の人間ゲート（principles承認フロー）
  - File: src/consolidator/promotion.ts, src/cli/promote.ts（新規）, package.json（bin追加）, 対応テスト
  - ①「必須フィールド（出所ティア、証拠、TTL）を欠く候補が起草段階で拒否される」「approved_at がNULLの原則が注入対象にならない」「valid_until 到来で expired になる」「自動昇格の経路が存在しない」を失敗するテストとして先に書く
  - ②起草（state='proposed'）とCLI承認（wasurenagusa-promote list / approve / reject）を実装する
  - Purpose: 自己増殖ループとインジェクション永続化の構造遮断（R-A7）
  - 完了条件: 承認なしで注入層に載る経路が存在しない
  - 検証: テスト緑と、ゲートG3の human-gate 項目
  - _Leverage: principles テーブル, src/consolidator/output-guard.ts_
  - _Requirements: R-A7_
  - _Prompt: Role: backend-engineer | Task: 昇格の人間ゲートをテスト先行で実装する | Restrictions: 承認の自動化や既定承認を作らない | Success: 未承認原則が注入ビルダから返らない_

- [ ] 3.12 初回統合の少量バッチ実行と人間サンプル確認
  - File: 実行記録は Implementation Logs、対象はローカルストア
  - 較正済み閾値で少量バッチ（上限は1晩50クラスタ目安、実値は記録）を書き込みモードで実行する
  - マージ結果からサンプルを抽出してオーナーが目視確認し、確認記録を残す（サンプル本文はローカル確認のみで転記しない）
  - Purpose: 初回一括統合の事故リスクを段階投入で抑える（R-A6-5）
  - 完了条件: 少量バッチが完走し、サンプル確認記録が存在する
  - 検証: 統合件数と系譜件数の出力、確認記録
  - _Leverage: タスク3.6の確定閾値, タスク3.9の上限機構_
  - _Requirements: R-A6_
  - _Prompt: Role: backend-engineer | Task: 少量バッチの初回統合を実行し確認材料を揃える | Restrictions: 上限を超えて流さない。オーナー確認前に次バッチへ進まない | Success: 件数と品質確認の記録が残る_

- [ ] 3.13 キュレーション台帳（統合区分）の流し込み
  - File: scripts/apply-merge-ledger.ts（新規）, 台帳はローカルデータ領域
  - 棚卸しで作成済みの統合候補台帳（282クラスタ）を追記型マージへ少量バッチで流す
  - 削除区分の台帳は実行しない（オーナー承認後の別作業。本Specのnon-goal）
  - Purpose: 未回収在庫（症状②）の回収を追記型で安全に進める
  - 完了条件: 台帳の統合区分が処理され、処理件数とスキップ件数が記録されている
  - 検証: 実行出力（件数のみ）と、PT-01の再実行
  - _Leverage: src/consolidator/persistence-helper.ts_
  - _Requirements: R-A6, R-B7_
  - _Prompt: Role: data-investigator | Task: 統合台帳を追記型マージへ少量バッチで流す | Restrictions: 削除区分に触れない。原本を壊さない | Success: 処理とスキップの内訳が数値で残る_

- [ ] 3.14 アーカイブ4,567件の選別投入とコールドストレージ確定
  - File: scripts/salvage-archive.ts（新規）, 対応テスト
  - 実態（2026-07-05実測）: 実体は各プロジェクト .wasurenagusa/ 直下の dont-archive.md／decisions-archive.md（v1形式Markdown・計4,567件・全件DB不在）。active記憶とのタイトル重複は0.6%
  - 処置方針: dont系3,225件のみ統合パイプラインへの選別投入対象とする。decisions系1,342件はコールドストレージ確定（検索編入しない・削除もしない）
  - ①「アーカイブ形式（見出し＋idメタ）が構造化パースされる」「重複判定がタイトル正規化一致→埋め込み近接の2段で行われる」を失敗するテストとして先に書く
  - ②5段の手順で実装する: (i) アーカイブ形式パーサ (ii) active記憶と統合済み原則に対する重複判定（2段） (iii) 投入候補台帳の生成（件数レポート・dry-run既定） (iv) オーナー承認 (v) --applyで統合入力へ投入し実行ログを記録。decisions系1,342件は(iii)以降の投入対象に含めない
  - Purpose: 到達不能な死蔵領域（症状⑦）の去就確定（R-B7）
  - 完了条件: dont系3,225件が台帳生成→承認→投入まで完了し、decisions系1,342件がコールドストレージとして確定記録されている
  - 検証: テスト緑と、台帳の件数レポート・実行ログ
  - _Leverage: src/consolidator/output-guard.ts_
  - _Requirements: R-B7_
  - _Prompt: Role: data-investigator | Task: アーカイブ形式パーサと重複判定をテスト先行で実装し、承認後にdont系のみ選別投入する | Restrictions: アーカイブ原本ファイルを削除しない。decisions系をコールドストレージから検索編入しない | Success: dont系の投入内訳とdecisions系のコールド確定が記録に残る_

- [ ] 3.15 保存経路タグ付けのGenkit統合と失敗の可観測化
  - File: src/vector/tag-enricher.ts（変更）, src/vector/embedding-service.ts（変更）, src/llm/provider.ts（変更）, 対応テスト
  - 前提: モデル名の1行止血（tag-enricher.ts の使用モデルを gemini-3.1-flash-lite化）は2026-07-05実施済み
  - ①「タグ拡張呼び出しが src/llm/provider.ts のGenkit経路（createGenerateTextFn）経由になる」「呼び出し失敗がthrowせず警告計数される」を失敗するテストとして先に書く
  - ②tag-enricher.ts の旧SDK（@google/generative-ai）直叩きを src/llm/provider.ts の createGenerateTextFn 経由へ差し替える。embedding-service.ts の旧SDK直叩きも同様に、provider.ts 側へGenkitの埋め込み呼び出しを新設した上でそちら経由へ差し替える
  - ③両モジュールの失敗時catch（現状は代替値を返して正常系に偽装）に警告計数を追加する（throwにしないwarning設計。既存のfallback自体は残す）
  - ④遠隔埋め込み経路（embedding-service）の同型根治: 旧SDK直叩き・モデル名リテラル・taskTypeが常時RETRIEVAL_DOCUMENTでクエリ/文書の非対称が欠落している点、および残る死設定（embeddingDimensions等）の生死判定
  - Purpose: 旧SDK直叩きの重複実装解消と、沈黙していた呼び出し失敗の可観測化（llm-design原則）
  - 完了条件: 2箇所ともGenkit経路経由になり、失敗が計数で可視化される
  - 検証: テスト緑（呼び出し失敗ケースを含む）
  - _Leverage: src/llm/provider.ts, src/observability/counters.ts_
  - _Requirements: R-M3_
  - _Prompt: Role: backend-engineer | Task: タグ拡張と埋め込みのLLM呼び出しをGenkit経路へ統合し失敗をテスト先行で警告計数化する | Restrictions: throwで強制しない。既存のfallback挙動を壊さない | Success: 呼び出し経路が単一化され失敗が計数で見える_

- [ ] 3.16 ゲートG3スクリプトの作成（検証役）
  - File: scripts/gates/g3-metabolism.ts（新規）
  - design.md Phase 3 ③の契約どおりに実装する（誤統合率、append-only、lineage、batch-cap、human-gate、distance-types、salvage-report）
  - Purpose: 代謝フェーズの完了を実行可能な検査にする
  - 完了条件: 契約どおりのG3が動き、違反状態でFAILする
  - 検証: 意図的な違反状態（例: 原本更新）でのFAIL確認出力
  - _Leverage: scripts/gates/g2-search.ts の共通形式_
  - _Requirements: R-M3_
  - _Prompt: Role: qa-engineer | Task: design.mdの契約どおりG3を実装する | Restrictions: 実装者のコードを修正しない | Success: PASSとFAILの両方が正しく判定される_

- [ ] 3.17 G3実行と出力貼付
  - File: Implementation Logs（追記）
  - スナップショットとラベル付きペアでG3を実行し、結果本文を貼付する
  - Purpose: Phase 4 の着手条件を成立させる
  - 完了条件: G3全項目PASSの出力本文が貼付されている
  - 検証: 貼付された出力本文のレビュー
  - _Leverage: scripts/gates/g3-metabolism.ts_
  - _Requirements: R-M3_
  - _Prompt: Role: qa-engineer | Task: G3を実行し出力本文を貼付する | Restrictions: FAILを隠さない | Success: 全項目PASSの本文が残る_

## Phase 4：注入とガードの再設計

目的：常時注入の最小化、ガードの承認制移行、死機能の清算、効果の最終測定。
着手条件：G3全項目PASSの出力本文が Implementation Logs に貼付済みであること。
完了条件：ゲートG4の全項目PASSと出力貼付、KPI再測定の完了。

- [ ] 4.1 スキーマv8移行（guardsテーブル）
  - File: src/storage/schema.ts（変更）, src/storage/migration.ts（変更）, src/storage/migration-v8.test.ts（新規）
  - ①「guards テーブルが design.md の定義どおり作られ、出所とTTLの欠落が拒否される」を失敗するテストとして先に書く
  - ②schema_version テーブルの MAX(version) を 7→8 にする移行を migrateV7ToV8 として実装する（移行前自動バックアップ込み）
  - Purpose: ガード正本の一本化（R-C4）
  - 完了条件: スナップショットで移行が成功し schema_version テーブルの MAX(version)=8 になる
  - 検証: テスト緑と移行実行出力
  - _Leverage: src/storage/migration.ts の migrateVXToVY 関数群, src/storage/sqlite.ts:44-72 の移行ディスパッチ_
  - _Requirements: R-C4_
  - _Prompt: Role: backend-engineer | Task: v8移行をテスト先行で実装する | Restrictions: 既存テーブルに触れない | Success: 制約つきguardsテーブルが存在する_

- [ ] 4.2 注入ビルダの再設計（最小索引と承認済み原則のみ）
  - File: src/injection/builder.ts, src/injection/builder.test.ts（新規）, src/cli/context.ts（変更）
  - ①「注入本文が最小索引と approved かつ有効期限内の原則のみで構成される」「素材欠損時に全文フォールバックせずスキップ計数と警報が出る」「任意のDB状態でバジェット以下」を失敗するテストとして先に書く
  - ②注入ビルダを実装し、CLI（context）の呼び先を差し替える。30日全文注入とサマリ欠落フォールバック（src/cli/context.ts:207-293、:326-334）を除去する
  - ③タスク0.10のバジェット機構をビルダへ統合する
  - Purpose: push型の質量崩壊（症状⑤）の根治（R-C1）
  - 完了条件: 全文を注入するコード経路が存在しない
  - 検証: テスト緑と、ゲートG4の injection-budget と injection-composition と fail-loud 項目
  - _Leverage: src/injection/budget.ts, principles テーブル_
  - _Requirements: R-C1, R-A7_
  - _Prompt: Role: backend-engineer | Task: 最小注入ビルダをテスト先行で実装し全文経路を除去する | Restrictions: 全文フォールバックを「安全側」として残さない | Success: どのDB状態でもバジェット以下の注入になる_

- [ ] 4.3 angerHistory等の固定付帯ブロックのpull化
  - File: src/tools/search.ts（変更）, 対応テスト
  - ①「検索応答に固定付帯ブロックが無条件で含まれない」「必要時はpull（明示要求または注入側の一箇所）で取得できる」を失敗するテストとして先に書く
  - ②全検索への無条件付帯（src/tools/search.ts:257-296）を除去する
  - Purpose: 検索1回ごとの固定コスト（監査D7）の根治（R-C3）
  - 完了条件: 検索応答が検索結果とhintのみになる
  - 検証: テスト緑と、ゲートG4の pull-fixed-blocks 項目
  - _Leverage: src/injection/builder.ts_
  - _Requirements: R-C3_
  - _Prompt: Role: backend-engineer | Task: 固定付帯ブロックをテスト先行でpull化する | Restrictions: 情報自体を消さない（提供箇所を一箇所に移す） | Success: 全ベンチ呼び出しで付帯が消える_

- [ ] 4.4 memory_get_context の上限
  - File: src/tools/getContext.ts（変更）, src/storage/sqlite.ts（変更）, 対応テスト
  - ①「返却が件数と分量の上限以下」「上限で切られたことが応答に明示される」を失敗するテストとして先に書く
  - ②LIMITなしの全件読み（src/storage/sqlite.ts:874-887）へ上限を入れ、ツール説明にも上限を明記する
  - Purpose: 1呼び出しでの69万字ダンプ（監査D6）の根治（R-C3）
  - 完了条件: 上限適用と明示が動く
  - 検証: テスト緑と、ゲートG4の get-context-cap 項目
  - _Leverage: src/injection/budget.ts_
  - _Requirements: R-C3_
  - _Prompt: Role: backend-engineer | Task: get_contextの上限をテスト先行で実装する | Restrictions: 上限超過を黙って切り捨てない（明示する） | Success: 応答が常に上限以下で切断が可視_

- [ ] 4.5 ガード承認制ランタイム
  - File: src/guards/registry.ts, src/guards/registry.test.ts（新規）, src/cli/pre-tool-use-guard.ts（変更）, src/cli/guard.ts（変更）
  - ①「評価されるのは state='active' かつ期限内の規則のみ」「未承認と失効は評価されない」「アクティブ規則数の上限超過の有効化がエラー」「ブロック表示に出所（事故ID）が含まれる」を失敗するテストとして先に書く
  - ②guards テーブルを正本とするレジストリと承認CLI（wasurenagusa-guard approve）を実装する。照合元を consolidated-dont.json からguardsレジストリへ差し替える（src/cli/pre-tool-use-guard.ts の読取部。現状は consolidated-dont.json の guardPattern を読む実装）。統合キャッシュJSONの guardPatterns 読み取りを廃止する
  - Purpose: 自動生成全廃後のガードの受け皿（R-C4）
  - 完了条件: ガードの正本がguardsテーブルのみになっている
  - 検証: テスト緑と、ゲートG4の guard-approval と guard-cap 項目
  - _Leverage: guards テーブル, 既存のReDoS検査（src/consolidator/dont-consolidator.ts:51-63）_
  - _Requirements: R-C4_
  - _Prompt: Role: backend-engineer | Task: 承認制ガードレジストリをテスト先行で実装する | Restrictions: パターンの自動生成や自動承認を作らない | Success: 承認済みだけが効く_

- [ ] 4.6 サーキットブレーカと外部キルスイッチ
  - File: src/guards/circuit-breaker.ts, src/guards/kill-switch.ts（新規）, 対応テスト
  - ①「直近100回の評価でブロック率が10%を超えると全ガードが自動停止し警報が出る」「ストア直下の guards.kill ファイル存在で即時全停止する」を失敗するテストとして先に書く
  - ②両機構を実装し、PreToolUse評価の最前段に置く
  - 前提条件: 本タスクの両機構が揃うことが settings.json への新ガード本配線（タスク4.15）の前提条件である。導入順序はキルスイッチ→サーキットブレーカ→観測（タスク4.15のdry-run観測）→本配線で固定し、順序を入れ替えない
  - Purpose: 自己DoSのロックアウト（64正規表現事故の再発形）の構造遮断（R-C4）
  - 完了条件: MCP外から touch 一発で全ガードが止まる
  - 検証: テスト緑と、ゲートG4の circuit-breaker と kill-switch 項目
  - _Leverage: src/observability/counters.ts_
  - _Requirements: R-C4_
  - _Prompt: Role: backend-engineer | Task: 遮断器とキルスイッチをテスト先行で実装する | Restrictions: 停止判定にDBやLLMを介在させない（ファイルとメモリのみで即応） | Success: ロックアウト経路が実験で再現できない_

- [ ] 4.7 既存64パターンの出所採掘と選別承認申請
  - File: 採掘記録はローカルデータ領域、承認申請は guards テーブル
  - 応急処置前のガードパターン64個の出所（元になった事故記憶）を採掘し、実事故由来と確認できたものだけを guards へ proposed で登録する
  - 確認できないパターンは移行せず、除外理由を件数つきで記録する
  - Purpose: 本物の再発防止を数本だけ残す（R-C4-6）
  - 完了条件: 64件全件に採掘結果が付き、proposed 登録がオーナー承認待ちになっている
  - 検証: 採掘内訳（件数のみ）の記録
  - _Leverage: バックアップ済みの旧統合キャッシュ, memory.db の事故記憶_
  - _Requirements: R-C4_
  - _Prompt: Role: data-investigator | Task: 64パターンの出所を採掘し実事故由来のみ承認申請する | Restrictions: 出所不明のパターンを「念のため」残さない。パターン本文の一括転記をしない | Success: 残す根拠が事故IDで裏づけられる_

- [ ] 4.8 死機能の依存監査つき物理削除と死因記録
  - File: src/vector/prediction-error.ts ほか該当ファイル（削除）, src/cli/context.ts（変更）, src/tools/save.ts（変更）, docs/graveyard.md（新規）
  - 対象：予測誤差ループ（実データ0件）、UserPromptSubmit空回り配線（src/cli/context.ts:381-383）、Phase 0 で遮断済みのv1経路（consolidate-worker のMarkdown統合、retag-worker、staleness v1判定）、save.ts の replaceId デッドコード
  - 条件: 予測誤差ループの削除はタスク0.0の判断が「物理削除」の場合のみ実施する。「温存」判断の場合は対象から外し、残り3系のみ削除する（v5スキーマ列自体は判断によらず本タスクで削除しない。列の去就は別途オーナー判断）
  - タスク0.0判断の反映（2026-07-07確定・物理削除）: 予測誤差ループは削除対象に含める。以下をゲート条件に追加する（判断記録 Implementation Logs/task-0.0-prediction-error-loop-decision.md が正本）:
    - 削除直前に予測誤差4列の実データ0件を再実測する（1件でも存在したら削除を保留しオーナーへエスカレーション）
    - 依存監査の対象一覧を固定: import参照／MCPツールスキーマ公開のoptionalフィールド4つ／型エクスポート（src/types.ts）／テスト／プロンプト・ドキュメント・過去handoffの言及
    - 削除の完了判定は `npm run build` でのdist再生成と本番経路スモーク（scripts/verify/production-path-smoke.mjs）全PASSで行う（コミット済み＝完了としない）
    - graveyard記録には死因1行に加え、設計意図の要約（docs/spec-prediction-error-loop.md参照）と復活条件（自動捕捉v2の需要実証時は旧実装の蘇生でなく再建後アーキテクチャ上で新規設計）を含める
    - 残置するv5の4列には src/storage/schema.ts のコメントで「未使用・将来予約・再利用禁止・由来はgraveyard参照」を注記する
  - ①各対象の参照元を依存監査し、削除後に全テストとビルドが通ることを確認する
  - ②機能ごとに死因を1行で docs/graveyard.md に記録する（記録がないと将来再発明される）
  - stashとスケジューラは対象外（オーナー判断待ちの別タスク）
  - Purpose: 二重系統の最終清算（R-A3、症状⑧）
  - 完了条件: 対象各系（タスク0.0の判断を反映した対象一覧）の実装コードが存在せず、死因記録がある
  - 検証: 依存監査の結果と、ゲートG4の dead-code-removed 項目
  - _Leverage: tsc とテストスイート全体_
  - _Requirements: R-A3_
  - _Prompt: Role: backend-engineer | Task: 死機能を依存監査つきで物理削除し死因を記録する | Restrictions: 対象外（stash、スケジューラ）に触れない。アーカイブデータファイルを消さない | Success: 削除後も全テストが緑で死因が残る_

- [ ] 4.9 注入前後の挙動比較（固定タスクスイート）
  - File: scripts/compare-injection-effect.ts（新規）, レポートはローカルデータ領域
  - 固定タスクスイート（記憶参照が効くべき代表タスク）を「注入あり」と「注入なし」で実行し、挙動差を記録する
  - 結果を注入内容の削り幅の判断材料としてPdMへ報告する（注入ゼロ実験の部分採用）
  - Purpose: 注入の実効性を測ってから削り幅を決める（設計判断D-8）
  - 完了条件: 前後比較レポートが存在する
  - 検証: レポートの貼付（数値と判定のみ）
  - _Leverage: src/injection/builder.ts_
  - _Requirements: R-M2_
  - _Prompt: Role: qa-engineer | Task: 注入前後の固定タスク比較を実測しレポート化する | Restrictions: 結論を先に決めて測らない | Success: 削り幅の判断材料が数値で揃う_

- [ ] 4.10 プロパティテスト PT-02 と PT-03 の作成（検証役）
  - File: tests/properties/injection-budget.property.test.ts, tests/properties/guard-cap.property.test.ts（新規）
  - PT-02：fast-checkでエントリ集合（件数、本文長、欠損パターン）を生成し、100ケース以上で注入トークン数がバジェット以下であることを検査する
  - PT-03：規則追加列を生成し、上限超過の有効化が常にエラーになることを検査する
  - Purpose: 受け入れ基準の不変条件化（R-C1、R-C4、R-M3）
  - 完了条件: PT-02とPT-03が存在し緑である
  - 検証: テスト実行出力
  - _Leverage: fast-check, src/injection/builder.ts, src/guards/registry.ts_
  - _Requirements: R-C1, R-C4, R-M3_
  - _Prompt: Role: qa-engineer | Task: 注入バジェットとガード上限をプロパティテスト化する | Restrictions: 実装コードを修正しない | Success: 生成ケース全件で不変条件が成立_

- [ ] 4.11 ゲートG4スクリプトの作成（検証役）
  - File: scripts/gates/g4-injection-guard.ts（新規）
  - design.md Phase 4 ③の契約どおりに実装する（検査11項目）
  - Purpose: 最終フェーズの完了を実行可能な検査にする
  - 完了条件: 契約どおりのG4が動き、違反状態でFAILする
  - 検証: 意図的な違反状態（例: 未承認ガードの評価）でのFAIL確認出力
  - _Leverage: scripts/gates/g3-metabolism.ts の共通形式_
  - _Requirements: R-M3_
  - _Prompt: Role: qa-engineer | Task: design.mdの契約どおりG4を実装する | Restrictions: 実装者のコードを修正しない | Success: PASSとFAILの両方が正しく判定される_

- [ ] 4.12 G4実行と出力貼付
  - File: Implementation Logs（追記）
  - スナップショットでG4を実行し、結果本文を貼付する
  - Purpose: 改修全体の完了条件の一つを成立させる
  - 完了条件: G4全項目PASSの出力本文が貼付されている
  - 検証: 貼付された出力本文のレビュー
  - _Leverage: scripts/gates/g4-injection-guard.ts_
  - _Requirements: R-M3_
  - _Prompt: Role: qa-engineer | Task: G4を実行し出力本文を貼付する | Restrictions: FAILを隠さない | Success: 全項目PASSの本文が残る_

- [ ] 4.13 KPI定義の実装とベースライン同一手順の再測定
  - File: scripts/measure-kpi.ts（新規）, 結果はローカルデータ領域と Implementation Logs
  - 主KPI「必要になった時に見つかった率」の代理指標（検索ヒット後の get_detail 到達、または結果IDの後続利用）と、精度指標（廃止済み決定が正解より上位に出た率）をコードで定義する
  - requirements.md のベースライン全項目を、タスク0.12で保存した同一手順で再測定し、改修前後の対比表を作る
  - Purpose: 改修の成否をゼロヒット率単独でなく実利用価値で判定する（R-M2）
  - 完了条件: 前後対比表が存在し、KPI定義がコードで再実行可能である
  - 検証: 再測定出力の貼付（数値のみ）
  - _Leverage: scripts/gates/eval-golden.ts, logs/operation-*.jsonl_
  - _Requirements: R-M2_
  - _Prompt: Role: qa-engineer | Task: KPIを定義しベースラインを同一手順で再測定する | Restrictions: 手順を変えて測らない。都合の悪い指標を落とさない | Success: 前後対比が同一物差しで示される_

- [ ] 4.14 最終整合の確認と別タスク提案の集約
  - File: Implementation Logs（追記）
  - 全フェーズの non-goals に触れていないことを差分で最終確認する
  - 本Specから除外した改善候補（横断検索の順位統一、自動保存分析プロンプトの減量、stashとスケジューラの去就、キュレーション台帳の削除区分実行、強度調整16件の反映、現行運用に矛盾する高強度3件の後継ポインタ置換）を別タスク提案として1行ずつ集約する。台帳由来の項目（削除区分・強度調整・陳腐化置換）はいずれもオーナー承認後に実行する旨を明記する
  - Purpose: スコープの単一真実源を守ったまま、発見済みの改善余地を失わない
  - 完了条件: non-goals遵守の確認記録と別タスク提案一覧が存在する
  - 検証: 記録のレビュー
  - _Leverage: git diff, design.md の non-goals_
  - _Requirements: R-M3_
  - _Prompt: Role: qa-engineer | Task: non-goals遵守を差分確認し別タスク提案を集約する | Restrictions: 提案を勝手に実装しない | Success: スコープ外変更ゼロが確認できる_

- [ ] 4.15 dry-run観測モードを経た本配線
  - File: src/guards/registry.ts（変更）, src/cli/pre-tool-use-guard.ts（変更）, 対応テスト
  - ①「dry-runモードでは違反を検出してもブロックせずログにのみ記録する」「観測期間中のブロック率レポートが生成できる」を失敗するテストとして先に書く
  - ②dry-run観測モードを実装し、一定期間ログ記録のみで運用する
  - ③観測期間終了後、ブロック率レポートを生成しオーナー承認を得る
  - ④承認後、settings.json のPreToolUseフックが新ガード（guardsレジストリ経由の承認済み規則）のブロック挙動を有効にする本配線へ進む
  - 順序はタスク4.6（キルスイッチ→サーキットブレーカ）→本タスクの観測→オーナー承認→有効化で固定する
  - Purpose: 新ガード配線を無評価でいきなり本番ブロックへ進めず、観測を経てから有効化する（自己DoS再発の追加防止）
  - 完了条件: dry-run観測でのブロック率レポートが存在し、オーナー承認後に有効化されている
  - 検証: テスト緑と、観測期間のブロック率レポート
  - _Leverage: src/guards/circuit-breaker.ts, src/guards/kill-switch.ts, src/observability/counters.ts_
  - _Requirements: R-C4_
  - _Prompt: Role: backend-engineer | Task: dry-run観測モードをテスト先行で実装しブロック率レポートを作る | Restrictions: オーナー承認前に本配線を有効化しない | Success: 観測→承認→有効化の順序が守られる_
