# Requirements: project-scope-memory

## Introduction

wasurenagusaの記憶構造に **project** と **scope** フィールドを追加し、複数プロジェクトの知識を1箇所に集約管理できるようにする。また、SessionStart時のコンテキスト注入を最小限にし、AIが必要な時に動的に記憶を取得する「人間の脳のように必要な時に思い出す」体験を実現する。

## Alignment with Product Vision

- **product.md 原則1「自律自動が基本」** に沿い、projectはcwdから自動取得、scopeはGemini分析で自動判定
- **原則3「コンテキストを圧迫しない軽量設計」** に沿い、全文注入からインデックス注入+動的取得に移行
- **原則6「プロジェクト特化 + グローバル知識」** を発展させ、シンボリックリンクによる集約管理でプロジェクト横断の知識活用を実現

## Requirements

### R1: エントリにproject・scopeフィールドを追加

**User Story:** As a 複数プロジェクトを運用する開発者, I want 記憶エントリにプロジェクト名とスコープが記録されること, so that プロジェクト横断で知識を管理・フィルタリングできる

#### Acceptance Criteria

1. WHEN エントリが保存される THEN システム SHALL projectフィールドにプロジェクト名（cwdのディレクトリ名）を自動付与する
2. WHEN Stop Hookで自動保存される THEN システム SHALL scopeフィールドをGemini分析で自動判定する
3. WHEN memory_saveで手動保存される THEN システム SHALL scopeフィールドをオプション引数として受け付ける（未指定時は"general"）
4. IF scopeが定義済み候補に含まれない THEN システム SHALL 自由入力値をそのまま受け入れる

### R2: scope候補の定義

**User Story:** As a 開発者, I want スコープに推奨候補があること, so that 一貫した分類で知識を整理できる

#### Acceptance Criteria

1. WHEN scopeを指定する THEN システム SHALL 以下の候補を提示する: frontend, backend, infra, design, spec, ai, general
2. WHEN 候補以外の値が指定された THEN システム SHALL その値をそのまま保存する（バリデーションで弾かない）
3. WHEN scopeが未指定 THEN システム SHALL デフォルト値 "general" を使用する

### R3: SessionStart時のコンテキスト注入を最小化

**User Story:** As a 開発者, I want セッション開始時のコンテキスト消費を最小限にしたい, so that コンテキストウィンドウを効率的に使える

#### Acceptance Criteria

1. WHEN SessionStartが発火する THEN システム SHALL dontカテゴリは全件の内容を注入する
2. WHEN SessionStartが発火する THEN システム SHALL configカテゴリはタイトル+内容を全文注入する（projectフィルタ適用後）
3. WHEN SessionStartが発火する THEN システム SHALL decision/log/snippetカテゴリは注入しない
4. WHEN 注入される THEN システム SHALL 現在のプロジェクトに関連するエントリ + project未指定のエントリのみを対象とする

### R4: 動的な記憶取得（必要な時に思い出す）

**User Story:** As a AI, I want 必要な時に関連する記憶を検索・取得したい, so that コンテキストを圧迫せずに正確な情報にアクセスできる

#### Acceptance Criteria

1. WHEN memory_searchが呼ばれる THEN システム SHALL project/scopeでフィルタリング可能とする
2. WHEN memory_get_detailが呼ばれる THEN システム SHALL 指定IDのフル詳細（project/scope含む）を返却する
3. WHEN memory_searchでprojectフィルタが指定される THEN システム SHALL そのプロジェクトのエントリのみを返却する
4. WHEN memory_searchでprojectフィルタが未指定 THEN システム SHALL 全プロジェクトのエントリを検索対象とする

### R5: 既存データとの後方互換性

**User Story:** As a 既存ユーザー, I want 既存のエントリが新しい仕組みでも正常に動作すること, so that データ移行の手間がない

#### Acceptance Criteria

1. IF エントリにprojectフィールドが存在しない THEN システム SHALL project未指定として扱い、全プロジェクトに適用する
2. IF エントリにscopeフィールドが存在しない THEN システム SHALL "general"として扱う
3. WHEN 既存のMarkdownファイルを読み込む THEN システム SHALL project/scopeがなくてもパースエラーにならない

## Non-Functional Requirements

### Code Architecture and Modularity
- 既存のMemoryEntry型にproject/scopeを追加するのみ。新規ファイル不要
- storage/markdown.tsの保存・読み込みロジックに対応を追加
- analyzer/gemini.tsの分析プロンプトにscope判定を追加

### Performance
- memory_search の応答時間は既存と同等（< 100ms）を維持
- SessionStart時の注入トークン量を現状から50%以上削減

### Security
- 既存と同等。追加のセキュリティ要件なし

### Reliability
- 既存エントリにproject/scopeがなくても正常動作（後方互換性）
- Geminiによるscope判定が失敗した場合は"general"にフォールバック

### Usability
- ユーザーは何もしなくてもproject/scopeが自動付与される
- 手動保存時のscopeは完全にオプション
