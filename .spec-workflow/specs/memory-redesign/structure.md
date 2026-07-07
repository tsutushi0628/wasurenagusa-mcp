# Project Structure

> 本書は記憶の代謝再建フィーチャー（memory-redesign）のSteering文書である。
> リポジトリの責務地図とデータ領域の構造、および触ってはいけない領域を定める。実測値の出典は2026-07-03監査。

## Directory Organization

```
wasurenagusa-mcp/
├── src/
│   ├── index.ts          # MCPサーバー本体（ツール公開の入口）
│   ├── config.ts         # 設定の単一定義（環境変数の読み口、パス解決）
│   ├── types.ts          # 共有型定義
│   ├── tools/            # MCPツール実装（保存、検索、詳細取得、文脈取得、削除、強度更新、stash、restore、自律タスク系）
│   ├── cli/              # Hooks CLI群（セッション開始注入、会話分析、ガード、夜間統合、埋め込み補完、各ワーカー）
│   ├── storage/          # 永続化層。sqlite.ts が正本（v2）。markdown.ts はv1遺物、migration.ts はv1→v2移行。search-hint.ts は検索ヒント文言の唯一の判定源（他モジュールに依存しない葉モジュール）
│   ├── vector/           # 埋め込みとスコアリング（ローカル埋め込み、距離計算、タグ拡張、記憶ティア、テーマ）
│   ├── consolidator/     # 統合アルゴリズムと鮮度判定、統合結果の永続化
│   ├── analyzer/         # Stop hook の会話分析（LLM呼び出しと決定論のメタ計算）
│   ├── llm/              # マルチプロバイダ抽象（genkit）。LLM呼び出しはここを経由する
│   ├── scheduler/        # 自律実行スケジューラ（休眠中）
│   ├── autonomous/       # 自律タスク実行（休眠中）
│   └── utils/            # 共通ユーティリティ（操作ログ、機密マスク、CLIエントリ判定、プロンプトエスケープ）
├── prompts/              # LLMプロンプトの正本（テキストファイル）
├── scripts/              # マイグレーション・保守スクリプト。verify/ に本番経路スモークテスト（production-path-smoke.mjs）を置く
├── docs/                 # 仕様書と調査記録（findings/ はgit追跡外）
├── dist/                 # ビルド出力（bin群の実体）
└── .spec-workflow/       # Spec正本（specs/ と steering/ のみ追跡）
```

### 起動経路（配線の地図）

コードを読む前に、どの入口からどの層が呼ばれるかを押さえる。

| 入口 | 実行物 | 通る層 |
|---|---|---|
| SessionStart / PreCompact hook | context CLI | storage → 注入本文生成。統合と埋め込み補完のワーカーをspawn |
| Stop hook | analyze CLI | analyzer（LLM分析）→ storage（自動保存） |
| PreToolUse hook（全ツール） | pre-tool-use-guard CLI | 統合キャッシュのガードパターン照合 |
| 夜間launchd | consolidate-all CLI | vector（近傍探索）→ consolidator → storage |
| MCPツール呼び出し | index.ts → tools/ | storage、vector、llm |

改修の中心対象はこの配線である。
とくにSessionStart起点でspawnされるワーカー群にv1系統（Markdown読み書き）が残っており、Phase 0で書き込み経路を物理遮断する。

## Naming Conventions

### Files

- 新規ファイルはkebab-case（例：`consolidate-all.ts`）
- `src/tools/` 配下は既存慣習がcamelCase（例：`getContext.ts`）。既存ファイル名は維持し、リネームしない
- テストは実装と同ディレクトリに `[filename].test.ts` で共置する

### Code

- **Classes/Types**: PascalCase
- **Functions/Variables**: camelCase（snake_case禁止）
- **Constants/環境変数**: SCREAMING_SNAKE_CASE
- **MCPツール名とパラメータ**: snake_case（MCP公式仕様準拠。例：`memory_search`）

## Import Patterns

### Import Order

1. 外部依存
2. 内部モジュール
3. 相対import

### Module/Package Organization

- ESM（NodeNext）のため、相対importは `.js` 拡張子付きで書く
- 設定値と環境変数は `config.ts` 経由でのみ読む（各所での `process.env` 直読みをしない）

## Code Structure Patterns

- 早期リターンでネストを浅く保つ
- catchしたら文脈を付与して再throwする。代替値を返して正常系に偽装しない
- `??` や `||` によるフォールバック代入は関数引数の既定値のみ許可
- 非同期ワーカーは各フェーズのstart／end、所要時間、処理件数を構造化ログに残す

## Code Organization Principles

1. **Single Responsibility**: 1ファイル1責務。責務が具体的に言えないファイルは分割のサイン
2. **fail-loud**: 欠損と失敗はスキップして計数する。静かに埋め合わせる経路を作らない
3. **Testability**: 不変条件（削除済みは返らない、注入はバジェット以下）はプロパティテストで固定する
4. **Consistency**: 既存の慣習（テスト共置、config経由の設定読み）に従う

## Module Boundaries

- **依存方向**：`tools/` と `cli/` が上流で、`storage/`、`vector/`、`consolidator/`、`analyzer/`、`llm/`、`utils/` に依存する。下流から上流への依存は禁止
- **正本と遺物**：書き込みの正本は `storage/sqlite.ts`。`storage/markdown.ts` への書き込みはPhase 0で物理遮断し、以後は読み取り（コールド保管の閲覧とサルベージ）のみ
- **LLM呼び出しの一本化**：全LLM呼び出しは `llm/provider.ts` の抽象を経由する。特定ベンダSDKの直書きは是正対象
- **プロンプトの置き場**：LLMプロンプトの正本は `prompts/` のテキストファイル。プロンプト本文（データ投入ブロック除く）は100行以下を守り、決定論的な計算（閾値判定、加点、分類の検証）はコード側に置く
- **休眠系の隔離**：`scheduler/` と `autonomous/` は休眠中。本改修の依存対象にしない

## データ領域の構造

コードとは別に、利用者の各リポジトリとホームにデータ領域がある。
本改修はデータ移行プロジェクトであり、この領域の構造理解が前提になる。

### プロジェクト毎ストア（各リポジトリ直下 `.wasurenagusa/`、git追跡外）

```
.wasurenagusa/
├── memory.db                 # 正本（v2）。エントリ本文＋FTS索引＋vec0埋め込み＋統合キャッシュ＋stash＋テーマ
├── models/                   # ローカル埋め込みモデルのキャッシュ（約87MB。共有キャッシュ化が確定済み）
├── logs/                     # 操作ログ（JSONL）。改修効果を測る計器
├── consolidated-dont.json    # 統合キャッシュ（派生物）。ガードと注入が参照する
├── consolidated-config.json  # 同上
├── dont.md ほかカテゴリ別Markdown   # v1正本（凍結対象）
├── *-archive.md              # v1アーカイブ（4ストア合計4,567件、3.2MB。検索経路から到達不能）
└── vectors.json              # v1クラウド埋め込みの遺物（実測3072次元、95MB）
```

### グローバル領域（ホーム直下 `~/.wasurenagusa/`）

- 環境変数のフォールバック（`.env`）
- スケジューラ状態と変更ログ（休眠中。変更ログは上限なし追記で実測5.7MB）

### 派生物と再構築可能性

「何が正本で、何が作り直せるか」を固定する。
バックアップ設計とロールバック設計はこの表を前提にする。

| 資産 | 位置づけ | 再構築 |
|---|---|---|
| エントリ本文（SQLiteの行） | 正本 | 不可。全量バックアップ必須 |
| v1 Markdownとアーカイブ | 歴史的正本 | 不可。コールド保管 |
| FTS索引 | 派生物 | 本文から再構築可 |
| vec0埋め込み | 派生物 | 再埋め込みで再構築可。ただしモデル版数に依存するため版数列で管理 |
| 統合キャッシュ | 派生物 | 統合の再実行で再構築可 |
| テーマ、サマリ | 派生物 | 再生成可 |
| 操作ログ | 計測データ | 再構築不可だが正本ではない。ローテーション対象 |
| models/ | キャッシュ | 再ダウンロード可 |
| vectors.json | 遺物 | バックアップ後に廃棄する |

## 触ってはいけない領域

実装者は以下を変更禁止（または条件付き）として扱う。
各Specのnon-goals欄はこの節を引き写して具体化する。

1. **`.wasurenagusa/` の実データ**：全量バックアップの完了ゲートを通過する前の破壊的操作は全面禁止。唯一のコピーを守れば以降の全手順が可逆になる
2. **v1 Markdownアーカイブ**：物理削除しない。git差分レビューと人間による監査性が要件であり、コールド保管と系譜保持が確定判断である
3. **ゴールデンクエリ集合と実データスナップショット**：実クエリ由来のため公開リポジトリに置かない。ローカルデータ領域にgit外で保持し、リポジトリには形式定義とポインタのみ置く。実装者は中身を書かない（検証役を分離する）
4. **`docs/findings/`**：git追跡外。個人パス、実名、記憶エントリの生本文、実クエリ本文を追跡ファイルに載せない
5. **休眠機能（`scheduler/`、`autonomous/`）**：Phase 4の依存監査と死因記録を経るまで、独断で削除も再起動もしない
6. **検索評価中のコーパス**：評価期間中は凍結し、評価スナップショットと分離する。アーカイブのサルベージ取り込みは評価凍結の解除後に行う
7. **予測誤差ループ（死機能）**：着手時点では作業ツリーの未コミットWIPだったが、コミット8b915a5（オーナー裁定2026-07-03）で履歴へ保全されHEADに反映済みで、スキーマバージョン5を占有している。実データ0件のまま代謝再建Specの評価対象外である点は変わらない。現行HEADの状態を前提に実装・行番号引用してよい

## Code Size Guidelines

- **LLMプロンプト本文**: 100行以下（データ投入ブロック除く）。現行の会話分析プロンプト（288行、コミット済みHEADで確認）は削減対象
- **ファイルと関数**: 既存慣習に従い、責務が複数になったら分割する

## Documentation Standards

- 本フィーチャーのSpec正本は `.spec-workflow/specs/memory-redesign/` 配下に置く
- 調査と実装の経緯は `docs/findings/`（git追跡外）に残し、追跡ファイルからはポインタで参照する
- 公開リポジトリのため、追跡ファイルには個人ホームの絶対パス、実在社名、個人名、経営実数、記憶エントリの生本文、実クエリ本文を書かない。パスはリポジトリ相対で書く
- 症状の数値、比率、構造、技術識別子は書いてよい
