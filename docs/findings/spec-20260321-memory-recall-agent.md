# 記憶想起Agentパターン設計

## 結論
SessionStart Hookでの大量コンテキスト注入をやめ、outputMode=agentでは「記憶想起Agent」パターンに移行する。
コンテキストウィンドウの有効活用と、人間の記憶に近い「想起」体験を実現する。

## 2つの目的
1. コンテキストウィンドウの有効活用（デフォルト注入を少なくする）
2. 人間の記憶のように知識を出し入れする（注入ではなく想起）

## agentモード設計

### SessionStart Hook
- dont原文（行動原則）: 全件注入。確実に守るべきルールだから省略不可
- config原文: 全件注入
- owner-profile: 全件注入

### UserPromptSubmit Hook
- 「記憶想起Agentを起動しろ」リマインドテキストを毎回注入（数行）
- compaction後も消えない（毎回再注入されるため）

### 記憶想起Agent（同期起動）
- インプット: (1) セッションで話しているプロジェクト（cwdベース）、(2) ユーザーの直近の発言
- 処理: memory_searchでユーザーの発言に関連する記憶を検索
- アウトプット: タイトル+1行要約で返却（なければ「関連記憶なし」）
- 同期実行（バックグラウンドだと記憶が間に合わない）

### 人間の記憶のアナロジー
- compaction = 忘却
- Hookリマインド = 想起トリガー（「あ、これ何か覚えがあるな」）
- memory_search = 思い出す
- 要約 = 意識に上がった記憶（全詳細ではなく要点だけ）

## injectionモード設計（従来方式、構造化）
- 短期記憶: 直近の注意事項（最新dont、未統合分）
- 中期記憶: 統合済みdont/config、ベクトル検索結果
- 長期記憶: owner-profile
- 全部SessionStart Hookで一括注入

## 検証で見つかった穴と対策
1. compaction後に指示を忘れる → UserPromptSubmit Hookで毎回再注入
2. バックグラウンド起動だと記憶が間に合わない → 同期実行
3. dont/configを毎回取得するのはオーバーヘッド → SessionStart Hookでdont/configは従来通り注入（ハイブリッド）
4. 「話題のプロジェクト」の特定 → cwdベースが80%カバー
5. 短いやりとりで無駄起動 → メインAgentの判断に委ねる（Hookは「必要に応じて」と指示）
6. MCPサーバーダウン時のフォールバック → dont/configはSessionStart注入で確保済み
7. 記憶保存（memory_save） → メインが直接実行（判断はメインにしかできない）

## 実装タスク
1. [x] wasurenagusa-mcp: agentモードのSessionStart出力をdont+config+owner-profileのみに変更 → b6d98a9
2. [x] wasurenagusa-mcp: wasurenagusa-context内にUserPromptSubmit分岐を追加（wasurenagusa-recall新設は不要）
3. [x] CLAUDE.md: 記憶想起Agentの起動ルールを追加
4. [x] README更新（UserPromptSubmit Hook設定・agentモードフロー追記）

## 実装判断メモ
- wasurenagusa-recall CLI新設は不要。既存wasurenagusa-contextのhook_event_name分岐で対応
- UserPromptSubmit Hookの出力は1行リマインドのみ（コンテキスト汚損防止）
- 記憶想起Agentの起動判断はメインAgentに委ねる（「必要と判断した場合」）
