# Requirements Document - Smart Tag Retrieval

## Introduction

記憶の検索精度を向上させるため、タグの拡張・重み付けと検索ランキングの最適化を行う。

**解決する課題**:
1. **タグが少なすぎて検索の網が粗い**: 現在の最大5個では、関連する記憶が引っかからないケースが多い
2. **タグに重みがなくランキングが平坦**: 汎用タグ（「Gemini」）も具体的タグ（「rate-limit」）も同じ扱い。的確な記憶が上位に来ない
3. **時間経過が検索結果に反映されない**: 3ヶ月前の記憶も昨日の記憶も同じ優先度で返される

**行動変容**: SessionStart Hookで注入される記憶と、memory_searchの検索結果が「今このセッションで本当に必要なもの」に近づく。限られたコンテキストウィンドウを、最も価値の高い記憶で満たせるようになる。

**設計思想**: AIの強みは「全ての記憶を高解像度で永久に保持できる」こと。人間の忘却を模倣してデータを削除するのではなく、**保存は全量維持したまま、取り出しの優先順位だけを最適化する**。

## Alignment with Product Vision

product.mdの課題9「コンテキスト注入の無駄 - セッション開始時に全記憶を注入すると、関係ない情報でコンテキストを圧迫する」に直接対応。Product Principle 3「コンテキストを圧迫しない軽量設計」とPrinciple 4「必要な時に思い出す」を強化する。

## Requirements

### REQ-1: 保存時タグ拡張+重み付け（フェーズ1・同期）

**User Story:** wasurenagusaの利用者として、memory_saveで保存されたエントリに対して、豊富で重み付けされたタグが自動的に付与されてほしい。次の会話ですぐに活用可能であること。

#### Acceptance Criteria

1. WHEN memory_saveでエントリが保存される THEN embedding生成と並列でGemini APIによるタグ拡張+重み付け分析が実行されること
2. WHEN タグ分析が完了 THEN 各タグに0.0〜1.0の重みが付与されること（具体的な事実値・固有名詞は高重み、汎用的なカテゴリ語は低重み）
3. WHEN タグ分析が完了 THEN タグ数の上限は撤廃し、意味的に有用なタグを可能な限り多く生成すること（目安: 7〜15個）
4. WHEN Gemini APIがエラー THEN エントリ自体の保存は成功し、呼び出し元が指定した元のタグ（重みなし）がフォールバックとして保存されること
5. WHEN wasurenagusa-analyze（Stop Hook）による自動保存 THEN 同様にタグ拡張+重み付けが実行されること

### REQ-2: テーマ変動時の過去エントリ再タグ付け（フェーズ2・非同期）

**User Story:** システムとして、新しいテーマが発見された際に、関連する過去エントリのタグを自動的に更新したい。記憶ネットワーク全体の検索精度が段階的に向上すること。

#### Acceptance Criteria

1. WHEN フェーズ1のタグ分析で重み0.5以上の新テーマが検出される THEN そのテーマが「既存のテーマ集合」に存在するか判定すること
2. WHEN 新テーマと判定される THEN そのテーマに関連する過去エントリ（ベクトル類似度で特定）を非同期でバックグラウンド再タグ付けすること
3. WHEN 再タグ付けを実行 THEN 1回あたり最大20件まで処理し、API呼び出しの負荷を分散すること
4. WHEN 再タグ付けが完了 THEN 元のタグを上書きするのではなく、新しいタグをマージし、重みは最大値を採用すること
5. WHEN memory_saveのレスポンスが返却される THEN フェーズ2の完了を待たないこと（非ブロッキング）

### REQ-3: 検索ランキングにfreshness係数を導入

> **【SUPERSEDED — 2026-07-20】機構の一本化（順序の意図は継承・実現手段のみ差し替え）**
>
> 下記 AC1〜AC3 が規定する freshness 機構（`freshness = max(0.7, e^(-0.693 * daysSinceLastAccess / HALF_LIFE_DAYS))`、HALF_LIFE_DAYS=14、アクセスによる係数リセット＝再浮上）は、**memory-redesign の time-decay に一本化されたため廃止**する。
>
> - **正本**: `memory-redesign/design.md`（time-decay: 半減期90日・floor無し・アクセスによるreset無し。`finalScore = rrfScore × 0.5^(ageDays/H)`, H=90）。二重減衰の禁止（PdM裁定）と実装済み挙動に整合する。
> - **継承する意図**: User Story（下記）の「時間経過を考慮した順序で返す／最近が上位・古くても的確なら十分なランク」という**順序要求は保持**する。差し替わったのは実現手段（式・半減期・reset有無）のみ。
> - **廃止の理由**: 本 REQ-3 は実装から独立して取り残された旧仕様で、別式・半減期14・access-reset を要求しており、実装済みの time-decay（半減期90・floor無・reset無）と真っ向から矛盾する。減衰係数を触る前提として、正本を memory-redesign に確定する。
> - **AC4 の扱い**: 「古い記憶でも関連度が非常に高ければ上位に出うる（減衰は掛け算の1要素で絶対的足切りではない）」という性質は time-decay 機構でも成立するため、意図として引き続き有効。
>
> 以下の AC1〜AC4 の原文は歴史的記録として削除せず残す（superseded マーク）。

**User Story:** wasurenagusaの利用者として、memory_searchの結果が時間経過を考慮した順序で返されてほしい。最近の記憶が上位に来つつ、古くても的確な記憶は十分なランクで返ること。

#### Acceptance Criteria（AC1〜AC3 は SUPERSEDED・上記バナー参照）

1. WHEN memory_searchが実行される THEN 各エントリに対してfreshness係数（0.7〜1.0）が計算されること
2. WHEN freshness係数を計算 THEN `freshness = max(0.7, e^(-0.693 * daysSinceLastAccess / HALF_LIFE_DAYS))` の式で算出すること（HALF_LIFE_DAYS初期値: 14）
3. WHEN エントリがmemory_searchまたはmemory_get_detailでアクセスされる THEN lastAccessedAtが更新され、freshness係数がリセットされること（再浮上）
4. WHEN 古いエントリ（freshness = 0.7）でもクエリとの関連度が非常に高い THEN 上位に表示されうること（freshnessは掛け算の1要素であり、絶対的な足切りではない）

### REQ-4: タグ重み付きスコアリング

**User Story:** wasurenagusaの利用者として、memory_searchで「薄く多く引っかかり、的確なものが上位に来る」結果を得たい。

#### Acceptance Criteria

1. WHEN memory_searchが実行される THEN ヒットしたタグの重みの合計が検索スコアに反映されること
2. WHEN 複数タグがヒット THEN 各タグの重みを合算し、マッチしたタグ数が多くかつ重みが高いエントリほど上位にランクされること
3. WHEN ベクトル検索結果とタグ検索結果をマージ THEN 最終スコア = `vectorSimilarity * tagWeightScore * freshness * accessBoost` の複合スコアでランキングすること
4. WHEN ベクトル検索のみでヒット（タグ不一致） THEN tagWeightScoreはデフォルト値（1.0）を使用すること（ペナルティなし）

### REQ-5: accessBoostの連続値化

**User Story:** システムとして、アクセス頻度に基づくスコア補正を現在のバイナリ判定（5回超→intensity 5）から連続値に変更し、滑らかなランキングを実現したい。

#### Acceptance Criteria

1. WHEN memory_searchの結果をスコアリング THEN accessBoost = `min(1.2, 1.0 + accessCount * 0.04)` で連続値として計算すること
2. WHEN accessCountが5を超過 THEN 従来通りintensity 5への自動昇格も維持すること（後方互換性）
3. WHEN accessCountが0 THEN accessBoostは1.0（ニュートラル）であること

## Non-Functional Requirements

### Code Architecture and Modularity
- **Single Responsibility Principle**: タグ拡張（TagEnricher）、スコアリング（SearchScorer）、再分析（RetagWorker）は独立モジュール
- **Modular Design**: 既存のsearch.tsとsave.tsを変更するが、新しいロジックは別ファイルに切り出す
- **Dependency Management**: TagEnricherはGemini APIにのみ依存。SearchScorerはpure function（外部依存なし）
- **Clear Interfaces**: SearchScorer.score()は全要素を引数で受け取り、テスト可能

### Performance
- フェーズ1のタグ拡張: embedding生成と並列実行するため、memory_saveの追加レイテンシは最小限（Gemini API 1回分 = 100-300ms）
- フェーズ2の再タグ付け: バックグラウンド非同期実行。memory_saveの応答時間に影響しない
- freshness計算: pure math、1エントリあたり < 0.01ms
- スコアリング: pure math、1000エントリで < 5ms

### Security
- タグ拡張に使用するGemini APIキーは既存のconfig.tsの仕組みで管理
- 重み付きタグはローカルファイルのみに保存

### Reliability
- タグ拡張失敗時: 元のタグで保存（graceful degradation）
- 再タグ付け失敗時: 既存タグは維持され、次回フェーズ2で再試行
- freshness計算: 外部依存なし、失敗しない

### Usability
- ユーザー操作の変更なし。memory_searchのインターフェースは同一
- 結果の順序が改善されるだけで、breaking changeなし
- タグ重みは内部情報であり、memory_searchの返却値には含めない（memory_get_detailでは参照可能）
