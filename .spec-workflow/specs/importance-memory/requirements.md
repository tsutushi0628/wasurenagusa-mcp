# Requirements: 記憶の強弱システム（importance field）

## Introduction

wasurenagusa-mcpは会話からdontエントリを自動保存し、定期的に統合（consolidate）して5-8の行動原則に圧縮する。しかし統合プロセスで具体的な記憶が抽象原則に溶け込み、「エミュレータ再起動は言うな」のような強い具体的指示が意味を失う問題がある。

importanceフィールドを導入し、criticalな記憶を統合から保護して永続的に具体的なまま保持する仕組みを構築する。

## Alignment with Product Vision

wasurenagusaの存在意義は「AIがユーザーの怒り・失望を繰り返さない」こと。統合による具体的記憶の消失は、この根幹を損なう問題である。importanceフィールドにより、ユーザーの最も強い感情を伴う指示が永続的に保護され、AIの信頼性が向上する。

## Requirements

### Requirement 1: importance判定（自動保存時）

**User Story:** AIとして、ユーザーの感情強度に応じてメモリの重要度を自動判定したい。強い怒りや具体的な禁止指示は永続的に保持されるべきだからである。

#### Acceptance Criteria

1. WHEN 会話がStop Hookで分析される THEN 分析結果JSONに `"importance": "critical" | "normal"` フィールドが含まれる SHALL
2. WHEN ユーザーが「絶対〜するな」「二度と〜するな」レベルの強い禁止指示を発している THEN importance は `"critical"` と判定される SHALL
3. WHEN ユーザーの感情強度が非常に高い（強い怒り・深い失望・諦め） THEN importance は `"critical"` と判定される SHALL
4. WHEN 上記に該当しない通常のdontエントリ THEN importance は `"normal"` と判定される SHALL
5. WHEN dont以外のカテゴリ（config, decision, log, snippet） THEN importance は常に `"normal"` とする SHALL

### Requirement 2: importance手動指定（memory_save経由）

**User Story:** ユーザーとして、手動保存時にimportanceを指定できるようにしたい。自分にとって最も重要な記憶を明示的に保護できるべきだからである。

#### Acceptance Criteria

1. WHEN memory_saveツールが呼ばれる THEN inputSchemaにオプショナルな `importance` パラメータ（"critical" | "normal"）が存在する SHALL
2. IF importance が未指定 THEN デフォルト値 `"normal"` が適用される SHALL
3. WHEN importance: "critical" で保存された THEN エントリのメタデータにimportanceが永続化される SHALL

### Requirement 3: critical記憶の統合除外

**User Story:** システムとして、criticalな記憶を統合（consolidation）対象から除外したい。具体的な禁止指示が抽象原則に溶け込んで意味を失うことを防ぐためである。

#### Acceptance Criteria

1. WHEN dont統合（consolidation）が実行される THEN importance: "critical" のエントリは統合入力から除外される SHALL
2. WHEN importance: "critical" のエントリが除外された THEN 統合結果の `sourceEntryCount` はcritical除外後のエントリ数を反映する SHALL
3. WHEN 全エントリがcritical THEN 統合は実行されず、既存の統合結果が保持される SHALL

### Requirement 4: 3層コンテキスト注入

**User Story:** AIとして、セッション開始時に3層構造でdont情報を受け取りたい。統合原則・具体的禁止・直近の鮮度の3つをバランスよく保持するためである。

#### Acceptance Criteria

1. WHEN SessionStart Hookが実行される THEN dontセクションは以下の3層で構成される SHALL：
   - 層1: 統合原則（consolidated-dont.json。既存動作と同一）
   - 層2: criticalエントリ（importance: "critical" のdontエントリを具体的にそのまま表示）
   - 層3: 直近30日の未統合エントリ（importance: "normal" かつ未統合のdontエントリ）
2. WHEN criticalエントリが0件 THEN 層2は出力されない SHALL
3. WHEN 直近30日の未統合エントリが0件 THEN 層3は出力されない SHALL
4. WHEN 層2のcriticalエントリが表示される THEN 各エントリのtitle・contentが省略なく表示される SHALL

### Requirement 5: 永続性の保証

**User Story:** システムとして、importanceフィールドが保存・読み込みで欠損しないようにしたい。Markdown形式での永続化が信頼できることが前提だからである。

#### Acceptance Criteria

1. WHEN importance: "critical" のエントリが保存される THEN Markdownファイルに `- **importance**: critical` メタデータ行が書き込まれる SHALL
2. WHEN Markdownファイルがパースされる THEN `- **importance**:` 行が存在すれば MemoryEntry に importance フィールドとして反映される SHALL
3. IF `- **importance**:` 行が存在しない（既存エントリ） THEN importance は `"normal"` として扱われる SHALL（後方互換性）
4. WHEN エントリが検索結果（MemoryIndexEntry）として返される THEN importance フィールドが含まれる SHALL

## Non-Functional Requirements

### Code Architecture and Modularity
- **後方互換性**: importanceフィールドが存在しない既存エントリは `"normal"` として扱う。既存のMarkdownファイルの再構築は不要
- **Single Responsibility**: importance判定ロジックはanalysis.txtプロンプト内に記述し、新たなモジュールの追加は最小限に抑える
- **既存パターンの踏襲**: formatter/parser/consolidator の既存パターンに沿って拡張する

### Performance
- コンテキスト注入時のcriticalエントリフィルタリングはインメモリで行い、追加のI/Oを最小限にする
- 統合処理のcritical除外フィルタは統合前の1回のみ実行する

### Security
- importanceフィールドはシステム内部で使用し、ユーザー入力のバリデーションで `"critical" | "normal"` 以外の値を拒否する

### Reliability
- importanceフィールド欠損時のデフォルト値 `"normal"` により、既存データとの互換性を維持する
- criticalエントリが消失しないよう、アーカイブ処理でもimportanceを保持する
