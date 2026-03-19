# Cross-Project Memory（v0.8.0〜v0.9.0）

## 実装日: 2026-03-18

## サマリ

wasurenagusa-mcpに**ベクトル記憶層**と**クロスプロジェクト記憶検索**を実装。AIコーディングエージェントが「プロジェクトの壁を超えて記憶を引き出せる」状態を実現した。

---

## v0.8.0: Vector Memory Tiers（ベクトル記憶層）

### 何を作ったか
- Gemini Embedding（gemini-embedding-001, 768次元）によるベクトル検索基盤
- コサイン距離ベースの3階層記憶モデル

| 階層 | 閾値 | 用途 |
|------|------|------|
| 短期（short） | ≤ 0.2 | 高関連 — SessionStartで自動注入 |
| 中期（medium） | ≤ 0.45 | 文脈関連 — memory_search時に表出 |
| 長期（long） | ≤ 0.7 | 緩い関連 — 発見可能だが自動注入なし |

### 主要コンポーネント
- `src/vector/cosine-distance.ts` — コサイン距離計算（純粋関数）
- `src/vector/memory-tier.ts` — 階層定義・フィルタ・昇格判定
- `src/vector/vector-store.ts` — VectorStoreクラス（vectors.json CRUD + ブルートフォース検索）
- `src/vector/embedding-service.ts` — Gemini Embedding API wrapper

### 統合ポイント
- `memory_save` → 保存時に自動embedding生成 + VectorStore.upsert
- `memory_search` → キーワード検索 + ベクトル検索マージ、アクセスカウント更新
- `memory_delete` → VectorStore.deleteで同期削除
- SessionStart（context.ts） → medium tier検索で関連記憶自動注入 + バックフィルworker spawn
- バックフィル（backfill-worker.ts） → 既存エントリの段階的ベクトル化（1回最大20件、detached process）

### 自動昇格
- ベクトル検索でヒットするたびにaccessCount++
- accessCount > 5 で `importance: "critical"` に自動昇格（永続注入対象に）

### 設計判断
- **依存追加なし**: 既存の `@google/generative-ai` パッケージを流用
- **ローカルJSON保存**: vectors.json（1000エントリ ≒ 6MB）。外部DB不要
- **Graceful degradation**: GEMINI_API_KEY未設定時はキーワード検索のみ（従来通り）

---

## v0.8.1: Session Topic Continuity（セッショントピック継続性）

### 何を作ったか
- Stop Hook時にLLM分析結果の`sessionTopic`をembedding化して`last-session-topic.json`に保存
- 次のSessionStartでは保存済みembeddingを検索クエリとして使用（API呼び出し不要）

### 動作フロー
```
Session End → LLM分析 → sessionTopic生成 → Gemini embed → last-session-topic.json保存
Next Session Start → last-session-topic.json読み込み → embedding直接使用 → ベクトル検索
```

### 設計判断
- `shouldSave`と独立して毎セッション実行（保存判定がfalseでもトピック記録）
- SessionStartではembedding再生成不要（ファイルから直接読み込み）
- フォールバック: ファイルなし時はプロジェクト名でembed

---

## v0.9.0: Cross-Project Memory（クロスプロジェクト記憶）

### 何を作ったか
- **ActiveProjectsTracker**: 直近セッションのプロジェクト上位5件を自動追跡
- **SessionStart横断検索**: 他のアクティブプロジェクトのvectors.jsonを直接参照
- **memory_search横断**: `project: "active"` オプションで5プロジェクト横断検索

### 主要コンポーネント
- `src/active-projects.ts` — ActiveProjectsTrackerクラス
- `src/types.ts` — ActiveProject / ActiveProjectsData 型追加

### 変更ファイル
- `src/cli/analyze.ts` — Stop Hookでactive-projects.json自動更新
- `src/cli/context.ts` — SessionStartで横断ベクトル検索（short tier 0.2）
- `src/tools/search.ts` — `project: "active"` オプション追加

### データ構造
```json
// ~/.wasurenagusa/scheduler/active-projects.json
{
  "projects": [
    {
      "name": "wasurenagusa-mcp",
      "path": "/Users/s.tsukamoto/projects/wasurenagusa-mcp",
      "lastSessionAt": "2026-03-18T23:15:00+09:00",
      "sessionTopic": "クロスプロジェクト記憶検索を実装"
    }
  ],
  "maxActiveProjects": 5,
  "updatedAt": "2026-03-18T23:15:00+09:00"
}
```

### 設計判断
- **global-vectors.jsonは作らない**: 各プロジェクトのvectors.jsonを直接参照。データ重複・同期問題を回避
- **横断検索はshort tier（0.2）のみ**: 他プロジェクトからのノイズを防ぐため厳しめの閾値
- **自然減衰**: セッションしなくなったプロジェクトはランキングから自動脱落
- **VSCode依存なし**: Claude Code Hookだけで完結

---

## テスト実績

| バージョン | テストファイル | テスト数 |
|-----------|-------------|---------|
| v0.8.0 | 34 | 384 |
| v0.9.0 | 37 | 391 |

全テスト通過、型チェッククリーン。

---

## 定量的インパクト（著者の8プロジェクト運用実績ベース）

```
1,581 "dont" entries   →  5-9 principles per project (LLM consolidation)
29 config entries      →  4-5 thematic summaries     (LLM consolidation)
21,800 chars raw data  →  6,200 chars injected        (71% reduction)
+ クロスプロジェクト記憶共有（5プロジェクト間）
```

---

## AI-motoeへのフィードバック候補

1. **ベクトル記憶層のアーキテクチャ**: 短期/中期/長期の3階層 + アクセスカウントによる自動昇格は、他のAIエージェントシステムにも適用可能
2. **セッショントピック継続性**: Stop/Start Hookの組み合わせでセッション間の文脈を低コストで引き継ぐパターン
3. **クロスプロジェクト記憶**: global DBを持たずに各プロジェクトのローカルストアを直接参照する設計。データ一貫性の問題を構造的に回避
4. **「カレントプロジェクト」概念**: 人間のワーキングメモリ上限（≒5）をシステムに反映。認知科学的アプローチ
