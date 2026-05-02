# Tasks Document — heart-extension

## タスク粒度ルール

各タスクは **1ファイル × 1関数/1コンポーネント以内** を原則とする。
すべてのタスクは Red → Green → Refactor の順序を明示する：

- **Red**: 失敗テストを書く（期待振る舞いの先行定義）
- **Green**: 最小実装でテストを通す
- **Refactor**: グリーンを保ったまま整理（必要なときのみ）

タスク番号順に進める。並行可能なタスクには「並行可」を明記する。

---

## フェーズ M1: スキーマ拡張（マイグレーション v1→v2）

- [x] 1. **【Red】** 新マイグレーション v2 のテストを `src/storage/migration.test.ts` に追加（CHECK制約に dream/success が含まれること、knowledge_gap カラムが存在することを assert）
  - File: src/storage/migration.test.ts
  - Purpose: マイグレーション v2 の振る舞いを先行定義
  - _Leverage: 既存 migration.test.ts のパターン_
  - _Requirements: B0c-1, F3-1, F4-1_
  - 完了条件: `npm test -- migration` で新規テストが「migrate-v1-to-v2 が定義されていない」or「カラムが存在しない」で失敗する

- [x] 2. **【Green】** `src/storage/schema.ts` の DDL とCURRENT_SCHEMA_VERSION を更新
  - File: src/storage/schema.ts
  - Purpose: 新規 install 時に v2 スキーマで作成されるようにする
  - 変更内容: CHECK制約を `('config','dont','decision','log','snippet','dream','success')` に拡張、`knowledge_gap TEXT` カラム追加、`CURRENT_SCHEMA_VERSION = 2`
  - _Leverage: schema.ts:5-104_
  - _Requirements: B0c-1, F3-1, F4-1_
  - 完了条件: 新規DBに対し v2 スキーマで初期化される（既存 schema.test.ts が通る + タスク1のテストが通る）

- [x] 3. **【Green】** `src/storage/migration.ts` に `migrateV1ToV2_categoryAndKnowledgeGap` 関数を追加（既存マイグレーション `migrateV1ToV2` とは別関数、命名衝突を避ける）
  - File: src/storage/migration.ts
  - Purpose: 既存DB（v1）を v2 にトランザクション安全に移行
  - 内容: memories_new テーブル作成 → INSERT SELECT → DROP memories → RENAME → idx + FTS5 trigger 再作成、すべて `db.transaction(() => {...})()` 内で実行
  - _Leverage: migration.ts:33-89 の transaction パターン_
  - _Requirements: B0c-1, F3-1, F4-1_
  - 完了条件: タスク1のテストが green

- [x] 4. **【Green】** `src/storage/auto-migration.ts` の経路に v1→v2 を組み込む（実装は `SQLiteStorage.initialize()` に集約。auto-migration.ts ファイルは存在せず、initialize 内で schema_version 判定→ migrate を実行する形に統合）
  - File: src/storage/auto-migration.ts
  - Purpose: 起動時に自動で v1→v2 移行が走る
  - 内容: `if (getSchemaVersion(db) < 2) migrateV1ToV2_categoryAndKnowledgeGap(db);` の分岐を追加
  - _Leverage: 既存 auto-migration の v0→v1 パス_
  - _Requirements: B0c-1, F3-1, F4-1_
  - 完了条件: `auto-migration.test.ts` で v1 DB を読み込んで v2 に migrate される

- [x] 5. **【Refactor】** マイグレーション関数の重複箇所を共通化（idx + FTS5 trigger 再作成 helper の抽出）
  - File: src/storage/migration.ts
  - Purpose: 将来の v2→v3 のため共通化
  - 完了条件: 既存テスト全 green

---

## フェーズ M2: B0a + B0b（集約 SQLite 二重書き）

- [x] 6. **【Red】** `src/cli/consolidate-worker.test.ts` に「dont 統合完走後 SQLite consolidated('dont') が non-null になる」テストを追加（モック LLM）
  - File: src/cli/consolidate-worker.test.ts
  - Purpose: B0a 修復の振る舞いを先行定義
  - _Requirements: B0a-1, B0a-2_
  - 完了条件: テストが「writeConsolidated が呼ばれていない」で失敗

- [x] 7. **【Green】** `src/cli/consolidate-worker.ts` の dont 統合完了直後に `storage.writeConsolidated('dont', result)` を1行追加（SQLiteStorage を冒頭で open）
  - File: src/cli/consolidate-worker.ts
  - Purpose: B0a 修復
  - 変更内容: 冒頭で `const storage = new SQLiteStorage(dbPath); storage.initialize(memoryPath);` を追加、`writeConsolidatedDont` の直後に `storage.writeConsolidated('dont', result)` を追加、最後に `storage.close()`
  - _Leverage: consolidate-worker.ts:38-54、staleness.ts:28、sqlite.ts:534_
  - _Requirements: B0a-1, B0a-3_
  - 完了条件: タスク6のテストが green

- [x] 8. **【Green】** `src/cli/consolidate-all.ts` の各プロジェクト処理で同様の SQLite 二重書きを追加
  - File: src/cli/consolidate-all.ts
  - Purpose: 夜間バッチ経路でも B0a 修復
  - 変更内容: `consolidateProject` 内で SQLiteStorage を open し、`writeConsolidatedDont` の直後に `storage.writeConsolidated('dont', result)` を追加、config 統合側も同様
  - _Leverage: consolidate-all.ts:27-55_
  - _Requirements: B0a-1, B0b-1, B0b-2_
  - 完了条件: 既存 consolidate-all 関連テストが全 green、新規 integration test が green

- [x] 9. **【Red】** `src/storage/sqlite.test.ts` に「writeConsolidated 失敗時に元データが破壊されない」回帰テストを追加（fail-open 検証）
  - File: src/storage/sqlite.test.ts
  - Purpose: 既存データの安全性を保証
  - _Requirements: B0a-4_
  - 完了条件: 既存実装で green（writeConsolidated は INSERT OR REPLACE で冪等）

- [x] 10. **【Refactor】** `consolidate-worker.ts` と `consolidate-all.ts` の重複（SQLite open + 二重書きパターン）を `consolidator/persistence-helper.ts` に抽出
  - File: src/consolidator/persistence-helper.ts
  - Purpose: DRY
  - 完了条件: 既存テスト全 green

---

## フェーズ M3: B0c（knowledgeGap 永続化）

- [x] 11. **【Red】** `src/types.ts` に `MemoryEntry.knowledgeGap?: string[]` と `SaveParams.knowledgeGap?: string[]` を期待する型テスト（sqlite.test.ts 内で knowledgeGap 付き save を呼ぶ箇所が型レイヤから先に Red 化する）
  - File: src/types.ts (and a smoke test)
  - Purpose: 型レイヤから先行定義
  - _Requirements: B0c-4_

- [x] 12. **【Green】** `src/types.ts` の MemoryEntry / SaveParams に `knowledgeGap?: string[]` を追加
  - File: src/types.ts
  - Purpose: 型定義
  - _Leverage: types.ts:15-25, 40-49_
  - _Requirements: B0c-4_

- [x] 13. **【Red】** `src/storage/sqlite.test.ts` に「knowledgeGap 付きで save → getDetail で同一配列が返る」テスト追加
  - File: src/storage/sqlite.test.ts
  - Purpose: B0c の振る舞いを先行定義
  - _Requirements: B0c-2, B0c-4_

- [x] 14. **【Green】** `src/storage/sqlite.ts` の `save()` メソッドの INSERT 文に `knowledge_gap` を追加
  - File: src/storage/sqlite.ts
  - Purpose: B0c 書き込み
  - 変更内容: INSERT 列に `knowledge_gap` を追加、bind に `params.knowledgeGap ? JSON.stringify(params.knowledgeGap) : null` を追加
  - _Requirements: B0c-2, B0c-3_

- [x] 15. **【Green】** `src/storage/sqlite.ts` の `getDetail()` および `readDontEntries()` 等の SELECT 系で `knowledge_gap` を読み出し、JSON.parse して MemoryEntry に乗せる（NULL/parse失敗時は undefined）
  - File: src/storage/sqlite.ts
  - Purpose: B0c 読み出し
  - _Requirements: B0c-4_
  - 完了条件: タスク13のテストが green

- [x] 16. **【Red】** `src/cli/analyze.test.ts` に「analysis.knowledgeGap が SaveParams に渡る」テスト追加（モック Analyzer）
  - File: src/cli/analyze.test.ts
  - Purpose: analyze 経路での引き継ぎ確認
  - _Requirements: B0c-2_

- [x] 17. **【Green】** `src/cli/analyze.ts` の SaveParams 構築箇所（analyze.ts:117-126）に `knowledgeGap: analysis.knowledgeGap` を追加
  - File: src/cli/analyze.ts
  - Purpose: analyze からの引き継ぎ
  - _Leverage: analyze.ts:117-126_
  - _Requirements: B0c-2_
  - 完了条件: タスク16のテストが green

---

## フェーズ M4: F1（PreToolUse ガード）

- [x] 18. **【Red】** `src/cli/pre-tool-use-guard.test.ts` を新規作成し、「stdin に rm -rf 含む tool_input → exit 2」テスト追加
  - File: src/cli/pre-tool-use-guard.test.ts
  - Purpose: F1 entry point の振る舞いを先行定義
  - _Leverage: 既存 guard.test.ts のテストパターン_
  - _Requirements: F1-1, F1-2_

- [x] 19. **【Green】** `src/cli/pre-tool-use-guard.ts` を新規作成、stdin から PreToolUse hook input を読み tool_input を JSON.stringify して checkGuard に渡す
  - File: src/cli/pre-tool-use-guard.ts
  - Purpose: F1 entry CLI
  - 内容: guard.ts の main 関数を参考に、`tool_input` を `message` に変換する1行アダプタ部のみ書く。`checkGuard` / `extractGuardPrinciples` / `readBlockCounts` / `writeBlockCounts` は guard.ts から import
  - _Leverage: guard.ts:94-126, 128-210_
  - _Requirements: F1-1, F1-2, F1-4, F1-5, F1-7_
  - 完了条件: タスク18のテストが green

- [x] 20. **【Red】** 「同一セッション同一パターン4回目 → exit 0（警告）」テスト追加
  - File: src/cli/pre-tool-use-guard.test.ts
  - _Requirements: F1-3_

- [x] 21. **【Green】** タスク19の実装で MAX_BLOCK_COUNT が継承されているため、テスト追加で green になることを確認（追加実装不要のはず）
  - 完了条件: タスク20のテストが green

- [x] 22. **【Red】** 「maxIntensity が全て < 5 のプロジェクト → exit 0」テスト追加
  - File: src/cli/pre-tool-use-guard.test.ts
  - _Requirements: F1-6_
  - 完了条件: 既存実装で green（extractGuardPrinciples が空配列を返すため）

- [x] 23. **【Green】** package.json の bin エントリに `wasurenagusa-pretool-guard: dist/cli/pre-tool-use-guard.js` を追加（既存 guard / context と同列）
  - File: package.json
  - Purpose: CLI として呼び出せるようにする
  - _Requirements: F1-1_

- [x] 24. **【Refactor】** guard.ts に CLI 直接実行ガード（`isDirectRun = process.argv[1] === fileURLToPath(import.meta.url)`）を追加し、`pre-tool-use-guard.ts` が `import { checkGuard } from "./guard.js"` した際に guard.ts の main 自動実行が走らないよう抑止した。共通関数の `guard-runtime.ts` への抽出はせず、guard.ts 側を「import 安全」にする最小変更でDRYを満たした（既存 wasurenagusa-guard バイナリの動作は不変）。
  - File: src/cli/guard.ts
  - Purpose: import 安全化（guard.ts の top-level main 呼び出しが pretool-guard の stdin を奪わないように）
  - 完了条件: 既存テスト全 green、wasurenagusa-guard / wasurenagusa-pretool-guard 両方が独立に動作

- [x] 25. **【ドキュメント】** `~/.claude/settings.json` に追加すべき PreToolUse hooks エントリ例を `docs/findings/spec-20260502-pre-tool-use-guard-setup.md` に記録（オーナー設定用）
  - File: docs/findings/spec-20260502-pre-tool-use-guard-setup.md
  - Purpose: 運用手順の永続化
  - _Requirements: §5.1 設定_

---

## フェーズ M5: F3（夢機能）

### 5.1 dream-worker

- [x] 26. **【Red】** `prompts/dream.txt` の不在を expect するテストを `src/cli/dream-worker.test.ts` に追加（プロンプト読込で失敗）
  - File: src/cli/dream-worker.test.ts
  - Purpose: 夢生成プロンプトの存在を先行定義
  - _Requirements: F3-2_

- [x] 27. **【Green】** `prompts/dream.txt` を新規作成（システム指示 + 出力 JSON 形式 + セキュリティ指示）
  - File: prompts/dream.txt
  - Purpose: F3 プロンプト
  - 内容: §4.4.1 設計に従う。1〜2文の詩的な夢の生成、機密の抽象化、JSON `{"title", "content"}` 出力
  - _Requirements: F3-2_
  - 完了条件: タスク26のテストが green

- [x] 28. **【Red】** 「シード3件 → モック LLM → category='dream' で save が呼ばれる」テスト追加
  - File: src/cli/dream-worker.test.ts
  - Purpose: dream-worker の主流フロー先行定義
  - _Requirements: F3-2, F3-3_

- [x] 29. **【Green】** `src/cli/dream-worker.ts` を新規作成（SQLiteStorage open → シード抽出 → プロンプト読込 → LLM 呼び出し → save → close）
  - File: src/cli/dream-worker.ts
  - Purpose: F3 ワーカ本体
  - _Leverage: consolidate-worker.ts のパターン_
  - _Requirements: F3-2, F3-3_
  - 完了条件: タスク28のテストが green

- [x] 30. **【Red】** 「直近24h以内に dream あり → save が呼ばれない」重複防御テスト追加
  - File: src/cli/dream-worker.test.ts
  - _Requirements: F3-7_

- [x] 31. **【Green】** dream-worker に「直近1件 dream の timestamp チェック → 24h 以内なら exit 0」分岐を追加
  - File: src/cli/dream-worker.ts
  - _Requirements: F3-7_
  - 完了条件: タスク30のテストが green

- [x] 32. **【Red】** 「LLM 失敗 → exit 0、save 呼ばれない、stderr に1行」fail-open テスト追加
  - File: src/cli/dream-worker.test.ts
  - _Requirements: F3-6_

- [x] 33. **【Green】** dream-worker の LLM 呼び出しを try/catch でラップし fail-open
  - File: src/cli/dream-worker.ts
  - _Requirements: F3-6_

- [x] 34. **【Green】** `src/cli/consolidate-all.ts` の末尾で各プロジェクトについて dream-worker を直列呼び出し（spawn 内ではなく内部 import で関数呼び出し、または spawn detached いずれか。並列化しない）
  - File: src/cli/consolidate-all.ts
  - Purpose: 夜間バッチに相乗り
  - _Requirements: F3-2_

### 5.2 夢の注入

- [x] 35. **【Red】** `src/cli/context.test.ts` に「DB に直近24h dream 1件 → agent モード出力に `### 今朝の夢` セクション含む」テスト追加
  - File: src/cli/context.test.ts (新規 or 既存)
  - _Requirements: F3-4_

- [x] 36. **【Green】** `src/cli/context.ts` に `getDreamContent(storage, currentProject): Promise<string>` を新設（直近24h dream 1件 → `### 今朝の夢\n${content}` 文字列、なければ空）
  - File: src/cli/context.ts
  - _Requirements: F3-4_
  - 完了条件: タスク35のテストが green

- [x] 37. **【Green】** `context.ts` main の agent モード出力組み立て箇所で `getDreamContent` の出力を「行動原則トップ3」と「直近の注意事項」の間に挿入
  - File: src/cli/context.ts
  - _Requirements: F3-4_

- [x] 38. **【Green】** injection モード側にも同等の挿入を追加（「設定情報」と「行動原則」の間）
  - File: src/cli/context.ts
  - _Requirements: F3-5_

- [x] 39. **【Red】** 「DB に dream 0件 → セクション省略（空文字）」テスト追加
  - File: src/cli/context.test.ts
  - _Requirements: F3-8_

- [x] 40. **【Green】** タスク36の実装が「0件で空文字を返す」ようになっていればテストが green になる（実装で確認）
  - _Requirements: F3-8_

---

## フェーズ M6: F4（success 記憶活用）

### 6.1 success 検出

- [x] 41. **【Red】** `src/analyzer/index.test.ts`（または analyzer/prompt-loader.test.ts）に「S1: 反対意見後の称賛 → category='success'」テスト追加（モック LLM で fixed JSON 応答）
  - File: src/analyzer/index.test.ts (or new test file)
  - _Requirements: F4-2 (S1)_

- [x] 42. **【Green】** `prompts/analysis.txt` に success カテゴリ説明セクション追加（S1/S2/S3 シグナル + Negative example + 出力 JSON 値域 success 追加）
  - File: prompts/analysis.txt
  - _Leverage: analysis.txt:6-66 のカテゴリ定義パターン_
  - _Requirements: F4-2, F4-3_
  - 完了条件: タスク41のテストが green（モック LLM 応答で意図通り分岐）

- [x] 43. **【Red】** 「単なる『ありがとう』 → success ではない（shouldSave: false or 別カテゴリ）」 negative テスト追加
  - File: src/analyzer/index.test.ts
  - _Requirements: F4-3_

- [x] 44. **【Green】** プロンプトで Negative example を強調（タスク42の追記で済むか確認）
  - 完了条件: タスク43のテストが green

- [x] 45. **【Green】** `src/types.ts` の `MemoryCategory` に `"success"` を追加（タスク12の流れで既に追加されている可能性あり、その場合確認のみ）
  - File: src/types.ts

- [x] 46. **【Green】** Analyzer の出力 JSON ランタイムバリデーション（あれば）の enum を更新
  - File: src/analyzer/index.ts
  - 完了条件: success カテゴリの保存が落ちずに通る

### 6.2 success 注入

- [x] 47. **【Red】** `src/cli/context.test.ts` に「DB に直近30日 success 5件 → agent モード出力に `### 効いた提案パターン` 上位3件」テスト追加
  - File: src/cli/context.test.ts
  - _Requirements: F4-5_

- [x] 48. **【Green】** `src/cli/context.ts` に `getSuccessContent(storage, currentProject): Promise<string>` を新設（直近30日以内 success 上位3件 → `### 効いた提案パターン\n- title: content要約` 文字列、なければ空）
  - File: src/cli/context.ts
  - _Requirements: F4-5_
  - 完了条件: タスク47のテストが green

- [x] 49. **【Green】** `context.ts` main の agent モード出力組み立てで `getSuccessContent` の出力を「行動原則トップ3」と「今朝の夢」の間に挿入
  - File: src/cli/context.ts
  - _Requirements: F4-5_

- [x] 50. **【Green】** injection モード側にも `getSuccessContent` を「行動原則」の下に挿入
  - File: src/cli/context.ts
  - _Requirements: F4-6_

- [x] 51. **【Red】** 「success 0件 → セクション省略」テスト追加
  - File: src/cli/context.test.ts
  - _Requirements: F4-7_

- [x] 52. **【Red】** 「success 31日前のみ → セクション省略」鮮度フィルタテスト追加
  - File: src/cli/context.test.ts
  - _Requirements: F4-8_

- [x] 53. **【Green】** `getSuccessContent` の SELECT に `timestamp >= datetime('now', '-30 days')` フィルタを追加
  - File: src/cli/context.ts
  - _Requirements: F4-8_
  - 完了条件: タスク51・52のテストが green

---

## フェーズ M7: 観測ゴール（F2）と統合検証

- [ ] 54. **【統合検証】** firebase-kit プロジェクトの `.wasurenagusa/` 配下で `wasurenagusa-context` を agent モードで実行し、出力に「行動原則トップ3」（3件）「直近の注意事項」（最大5件）「効いた提案パターン」（success が0件なら省略）「今朝の夢」（dream が無ければ省略）が期待通り並ぶことを目視確認
  - 手段: `node dist/cli/context.js < /tmp/mock-hook-input.json`
  - _Requirements: F2-1, F2-2, F2-3, F3-4, F4-5_
  - オーナー目視確認はメイン Agent が実行する（CLAUDE.md 行動原則 7）

- [ ] 55. **【統合検証】** 夜2時 launchd の動作確認（手動 `launchctl start com.wasurenagusa.consolidate` → ログで dream 生成成功を確認）
  - _Requirements: F3-2, F3-3_
  - 完了条件: 翌朝 SessionStart で `### 今朝の夢` が表示される

- [ ] 56. **【統合検証】** PreToolUse ガードのスモークテスト（テスト用 consolidated-dont.json を fixture として置き、`echo '{"tool_input":{"command":"rm -rf /"}}' \| node dist/cli/pre-tool-use-guard.js` の exit code が 2 になることを確認）
  - _Requirements: F1-1, F1-2_

- [ ] 57. **【ドキュメント】** `docs/findings/spec-20260502-heart-extension-rollout.md` に本spec の実装完了報告と、オーナーが ~/.claude/settings.json に追加すべき hooks エントリを記録
  - File: docs/findings/spec-20260502-heart-extension-rollout.md
  - Purpose: 運用手順の永続化と、PreToolUse hook 設定をオーナーが反映するための手引き

---

## 並行可能性マップ

| フェーズ | 依存 | 並行可 |
|---------|------|--------|
| M1 (タスク1-5) | なし | 全タスク直列（マイグレーションは順序依存） |
| M2 (タスク6-10) | M1完了 | タスク6/7 と タスク8/9 は並行可 |
| M3 (タスク11-17) | M1完了 | M2と並行可 |
| M4 (タスク18-25) | M2完了 | M3と並行可 |
| M5 (タスク26-40) | M1完了 | M4と並行可（5.1 と 5.2 は順序依存） |
| M6 (タスク41-53) | M1完了 | M5と並行可（6.1 と 6.2 は順序依存） |
| M7 (タスク54-57) | M2-M6完了 | 全タスク並行可（観測のみ） |

---

## タスク数と工数見積

| フェーズ | タスク数 | 内訳 | 見積（1タスク=15-30分） |
|---------|----------|------|----------|
| M1 | 5 | スキーマ拡張 | 1.5-2h |
| M2 | 5 | B0a/B0b SQLite 二重書き | 1-1.5h |
| M3 | 7 | B0c knowledgeGap 永続化 | 2-3h |
| M4 | 8 | F1 PreToolUse ガード | 2-3h |
| M5 | 15 | F3 夢機能（worker + 注入） | 4-6h |
| M6 | 13 | F4 success（検出 + 注入） | 3-5h |
| M7 | 4 | 観測・統合・ドキュメント | 1-2h |
| **合計** | **57** | | **15-23h（1.5〜3 営業日相当）** |

LLM呼び出しコスト見積: dream-worker は1プロジェクト1回/日、success 検出は既存 analyze.ts に統合のため追加コストゼロ。再集約（B0b）は初回のみ全 dont エントリ（3309件）を1度集約するため Gemini Flash で約 ¥30〜¥60 程度の一時コスト見込み。
