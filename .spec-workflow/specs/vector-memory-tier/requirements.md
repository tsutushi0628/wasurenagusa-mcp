# Requirements Document - Vector Memory Tier

## Introduction

wasurenagusa-mcpにベクトルembeddingベースの記憶層システムを追加する。現在のキーワード検索（部分文字列一致）に加え、意味的類似性による記憶検索を実現する。

**解決する課題**: 現在のmemory_searchはキーワード部分一致のみ。「Gitで怒られた」という記憶を「ブランチ切り忘れ」の文脈で検索しても引けない。ベクトル化により意味的に関連する記憶が自動的に浮上する。

**行動変容**: AIエージェントが過去の失敗・学びを文脈に応じて想起できるようになり、同じミスの繰り返しが減少する。

## Alignment with Product Vision

wasurenagusa-mcpは「AIコーディングエージェントに永続メモリを与える」ツール。現在の3層注入（統合済み/critical/直近30日）はSessionStart時の静的注入。ベクトル検索を加えることで、作業文脈に応じた動的な記憶想起が可能になり、「忘れないAI」から「思い出せるAI」への進化を実現する。

## Requirements

### REQ-1: メモリ保存時のEmbedding自動生成

**User Story:** wasurenagusaの利用者として、memory_saveで保存したメモリに自動でベクトルembeddingが付与されてほしい。追加の操作なしに意味検索が利用可能になること。

#### Acceptance Criteria

1. WHEN memory_saveでエントリが保存される THEN タイトル+コンテンツを結合したテキストからGemini gemini-embedding-001でembeddingが生成され、ベクトルストアに保存されること
2. WHEN Gemini APIキーが未設定 THEN embedding生成をスキップし、エントリ自体は従来通りMarkdownに保存されること（後方互換性）
3. WHEN embedding生成がAPI エラーで失敗 THEN エントリ自体の保存は成功し、embeddingのみ欠落した状態となること。エラーはstderrに出力
4. WHEN replaceIdを指定してエントリを置換 THEN 旧エントリのembeddingが削除され、新エントリのembeddingで置換されること
5. WHEN memory_deleteでエントリが削除される THEN 対応するembeddingもベクトルストアから削除されること

### REQ-2: ベクトル検索によるメモリ検索

**User Story:** AIエージェントとして、memory_searchで意味的に関連する記憶を検索したい。キーワードが完全一致しなくても、文脈的に関連する記憶が返ってほしい。

#### Acceptance Criteria

1. WHEN memory_searchが実行される THEN ベクトル検索結果とキーワード検索結果がマージされて返却されること
2. WHEN ベクトル検索を実行 THEN クエリテキストをembedding化し、コサイン距離で全ベクトルとブルートフォース比較し、閾値以内の結果を返すこと
3. WHEN 検索結果をマージ THEN ベクトル検索で見つかったがキーワード検索で見つからなかったエントリも結果に含まれること（和集合）
4. IF embeddingが存在しないエントリ THEN キーワード検索でのみ検索対象となること（後方互換性）
5. WHEN ベクトル検索のみでヒット THEN 結果のhintに「意味検索でヒット」である旨を表示すること

### REQ-3: 記憶層の距離閾値制御

**User Story:** システムとして、記憶の関連度を距離で3段階に分け、用途に応じて適切な範囲の記憶を引きたい。

#### Acceptance Criteria

1. WHEN SessionStart時のコンテキスト注入 THEN 短期層（distance <= 0.2）のみを注入すること（強く関連するものだけ）
2. WHEN memory_searchによる能動検索 THEN 中期層（distance <= 0.45）まで検索すること
3. WHEN 明示的にtier指定で検索 THEN 長期層（distance <= 0.7）まで広く検索可能であること
4. WHEN 閾値を超える結果 THEN 検索結果から除外されること

### REQ-4: アクセスカウントによるcritical昇格

**User Story:** システムとして、繰り返し参照される記憶を自動的にcriticalに昇格させ、永続的に保持したい。

#### Acceptance Criteria

1. WHEN ベクトル検索で記憶が引かれる THEN その記憶のアクセスカウントが+1されること
2. WHEN アクセスカウントが閾値（初期値: 5）を超過 THEN そのエントリのimportanceがcriticalに自動昇格すること
3. WHEN 長期層の記憶がベクトル検索で引かれる THEN 次回以降は短期層でも注入対象となること（距離による層は固定だが、アクセスにより注目度が上がる）
4. WHEN criticalに昇格 THEN 統合（consolidation）の対象外となり、永続保持されること（既存のcritical挙動と同一）

### REQ-5: 既存メモリへのバックフィル

**User Story:** 既存ユーザーとして、ベクトル機能追加後に既存のメモリにもembeddingが付与されてほしい。手動操作なしに段階的にバックフィルされること。

#### Acceptance Criteria

1. WHEN wasurenagusa-contextが実行される（SessionStart） THEN embeddingのないエントリが存在するか確認し、あればバックグラウンドでバックフィルを開始すること
2. WHEN バックフィルを実行 THEN 1セッションあたり最大20件まで処理し、API呼び出しの負荷を分散すること
3. WHEN 全エントリのバックフィルが完了 THEN バックフィル処理をスキップすること
4. IF APIキーが未設定 THEN バックフィルをスキップすること

## Non-Functional Requirements

### Code Architecture and Modularity
- **Single Responsibility Principle**: EmbeddingService（embedding生成）、VectorStore（ベクトル保存・検索）、記憶層ロジック（閾値判定・昇格）は独立モジュール
- **Modular Design**: 既存のMarkdownStorageを変更せず、VectorStoreを横に並べる設計。MarkdownStorage = 記憶の本体、VectorStore = 記憶のインデックス
- **Dependency Management**: EmbeddingServiceはGemini APIにのみ依存。VectorStoreはファイルシステムにのみ依存。循環依存禁止
- **Clear Interfaces**: VectorStore.search()は距離付きIDリストを返し、MarkdownStorageと組み合わせて使う

### Performance
- ベクトル検索はブルートフォースコサイン距離計算。1000エントリ以内で10ms以内を目標
- embedding生成はGemini API呼び出し（1回あたり100-300ms想定）。memory_save時の同期処理だが、バックフィルは非同期
- vectors.jsonのファイルサイズ: 1000エントリ x 768次元 x 8byte = 約6MBで許容範囲

### Security
- Gemini APIキーは既存のconfig.tsの仕組みで管理（.envファイル）
- ベクトルデータはローカルファイルのみ。外部送信なし（embedding生成時のAPI呼び出しを除く）

### Reliability
- embedding生成失敗時もメモリ保存は成功すること（エラー分離）
- vectors.jsonの破損時はファイルを再生成可能（バックフィルで復旧）
- ファイルロック不要（CLIは基本的にシングルプロセス実行）

### Usability
- ユーザーは設定変更なしに利用開始可能（Gemini APIキーは既存のGemini分析機能と共用）
- memory_searchのインターフェースは変更なし（内部でベクトル検索が追加されるだけ）
- 新規ツール追加は不要（既存ツールの拡張で実現）
