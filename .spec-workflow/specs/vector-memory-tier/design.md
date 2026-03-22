# Design Document - Vector Memory Tier

## Overview

wasurenagusa-mcpの既存Markdownベース記憶システムにベクトルembeddingレイヤーを追加する。MarkdownStorageが「記憶の本体」、VectorStoreが「記憶のインデックス」という役割分担で、既存アーキテクチャを壊さずに意味検索機能を実現する。

## Steering Document Alignment

### Technical Standards
- 既存のGenkit + @google/generative-ai パターンを踏襲（embedding生成には@google/generative-aiを使用）
- ファイルベースの永続化（Firestoreは使わない、ローカルJSON）
- エラー分離原則: embedding失敗がメモリ保存を阻害しない

### Project Structure
- `src/vector/` に新モジュールを配置（既存の `src/storage/`, `src/analyzer/` と同階層）
- テストは `src/vector/*.test.ts` に配置（既存のテストパターンに準拠）

## Code Reuse Analysis

### Existing Components to Leverage
- **MarkdownStorage** (`src/storage/markdown.ts`): 記憶の読み書き。VectorStoreはIDベースでMarkdownStorageのエントリを参照する
- **config.ts** (`src/config.ts`): geminiApiKeyを共用。新規設定項目を追加
- **provider.ts** (`src/llm/provider.ts`): Genkit/GoogleAIの初期化パターンを参照。ただしembeddingは@google/generative-aiを直接使用（Genkitにembedding APIがないため）

### Reference Implementations
- **EmbeddingService** (`my-org/sub-project/functions/src/services/EmbeddingService.ts`): Gemini embedding-001の呼び出しパターン。`@google/genai`のGoogleGenAIクラスを使用
- **RetrievalService** (`my-org/sub-project/functions/src/services/RetrievalService.ts`): コサイン距離検索、閾値フィルタリング、重複排除パターン
- **CeoXPostingService** (`ai-management-dx`): DISTANCE_THRESHOLD=0.45、閾値内シャッフルパターン

### Integration Points
- **memory_save** (`src/tools/`): 保存後にembedding生成を呼び出す
- **memory_search** (`src/tools/`): キーワード検索結果にベクトル検索結果をマージ
- **memory_delete** (`src/tools/`): 削除時にベクトルも削除
- **wasurenagusa-context** (`src/cli/context.ts`): SessionStart時にベクトル検索で短期層を注入 + バックフィル起動

## Architecture

```
memory_save ──→ MarkdownStorage.save() ──→ Markdown Files
     │
     └──→ EmbeddingService.embed() ──→ VectorStore.upsert() ──→ vectors.json

memory_search ──→ MarkdownStorage.search() ──→ keyword results ─┐
     │                                                           ├──→ merge ──→ response
     └──→ EmbeddingService.embed(query) ──→ VectorStore.search() ──→ vector results ─┘

memory_delete ──→ MarkdownStorage.delete() + VectorStore.delete()

SessionStart ──→ VectorStore.search(short-term) ──→ inject context
     │
     └──→ BackfillWorker (background, detached)
```

### Modular Design Principles
- **EmbeddingService**: Gemini API呼び出しのみ。テキスト→768次元ベクトル変換
- **VectorStore**: JSONファイルのCRUD + コサイン距離ブルートフォース検索。APIには一切依存しない
- **MemoryTierLogic**: 閾値定義・アクセスカウント・昇格判定。ビジネスロジックのみ
- **統合レイヤー**: 既存のtools/handlersに追加コードを挿入（tool定義自体は変えない）

## Components and Interfaces

### Component 1: EmbeddingService (`src/vector/embedding-service.ts`)
- **Purpose:** テキストをGemini gemini-embedding-001で768次元ベクトルに変換
- **Interfaces:**
  ```typescript
  class EmbeddingService {
    constructor(apiKey: string)
    embed(text: string): Promise<number[]>
    embedBatch(texts: string[]): Promise<number[][]>
    isAvailable(): boolean
  }
  ```
- **Dependencies:** `@google/generative-ai` (既存dependency)
- **Reuses:** `config.geminiApiKey` を使用。EmbeddingServiceのパターンは既存プロジェクトのEmbeddingServiceを踏襲。ただし`@google/genai`ではなく既存の`@google/generative-ai`を使用（依存追加を避ける）

### Component 2: VectorStore (`src/vector/vector-store.ts`)
- **Purpose:** ベクトルデータのローカルJSON保存・検索・削除
- **Interfaces:**
  ```typescript
  interface VectorEntry {
    id: string              // MemoryEntry.idと同一
    embedding: number[]     // 768次元ベクトル
    accessCount: number     // 検索でヒットした回数
    createdAt: string       // ISO 8601 JST
    lastAccessedAt: string  // 最終アクセス日時
  }

  class VectorStore {
    constructor(memoryPath: string)
    upsert(id: string, embedding: number[]): Promise<void>
    delete(ids: string[]): Promise<void>
    search(queryEmbedding: number[], threshold: number, limit: number): Promise<VectorSearchResult[]>
    incrementAccessCount(ids: string[]): Promise<void>
    getEntriesWithoutEmbedding(allIds: string[]): Promise<string[]>
    getEntryCount(): Promise<number>
  }

  interface VectorSearchResult {
    id: string
    distance: number        // コサイン距離（0-2, 0が完全一致）
    accessCount: number
  }
  ```
- **Dependencies:** fs/promises（ファイルI/O）のみ
- **Storage:** `{memoryPath}/vectors.json`

### Component 3: MemoryTier (`src/vector/memory-tier.ts`)
- **Purpose:** 記憶層の閾値定義・検索結果のフィルタリング・昇格判定
- **Interfaces:**
  ```typescript
  type TierName = "short" | "medium" | "long"

  const TIER_THRESHOLDS: Record<TierName, number> = {
    short: 0.2,
    medium: 0.45,
    long: 0.7,
  }

  const CRITICAL_PROMOTION_THRESHOLD = 5  // アクセスカウント閾値

  function filterByTier(results: VectorSearchResult[], tier: TierName): VectorSearchResult[]
  function shouldPromoteToCritical(accessCount: number): boolean
  ```
- **Dependencies:** なし（純粋関数）

### Component 4: BackfillWorker (`src/cli/backfill-worker.ts`)
- **Purpose:** embeddingのない既存メモリに非同期でembeddingを生成
- **Interfaces:** CLI実行（detached process）。引数: memoryPath
- **Dependencies:** EmbeddingService, VectorStore, MarkdownStorage
- **Reuses:** `src/cli/consolidate-worker.js` と同じdetached spawn パターン（context.tsのspawnConsolidationBackground参照）

## Data Models

### VectorStoreData (`vectors.json`)
```typescript
interface VectorStoreData {
  version: 1
  entries: Record<string, VectorEntry>  // key = MemoryEntry.id
}

interface VectorEntry {
  id: string              // MemoryEntry.idと同一
  embedding: number[]     // 768次元（Float64）
  accessCount: number     // 初期値: 0
  createdAt: string       // ISO 8601 JST
  lastAccessedAt: string  // 最終アクセス日時（初期値: createdAt）
}
```

### vectors.jsonファイル構造
- 保存先: `{memoryPath}/vectors.json`（.wasurenagusa/vectors.json）
- 全エントリを1ファイルに格納（ブルートフォース検索のため全件ロードが必要）
- 1000エントリで約6MB（768次元 x 8byte x 1000）。許容範囲

## Error Handling

### Error Scenarios
1. **Gemini APIキー未設定**
   - **Handling:** EmbeddingService.isAvailable()がfalseを返す。embedding生成をスキップ
   - **User Impact:** キーワード検索のみで動作（従来と同等）

2. **Gemini API呼び出し失敗（ネットワーク/レート制限）**
   - **Handling:** エラーをstderrに出力。メモリ保存自体は成功させる
   - **User Impact:** そのエントリのembeddingが欠落。次回バックフィルで補完される

3. **vectors.json破損・読み込み失敗**
   - **Handling:** 空のVectorStoreDataとして初期化。次回バックフィルで全件再生成
   - **User Impact:** 一時的にベクトル検索が効かなくなるが、次回SessionStartで復旧開始

4. **vectors.json書き込み競合**
   - **Handling:** wasurenagusa-mcpはシングルプロセス想定のためファイルロック不要。バックフィルworkerはdetachedだが、vectors.jsonへの書き込みは逐次（エントリ1件処理ごとに保存）
   - **User Impact:** 影響なし

## Testing Strategy

### Unit Testing
- **EmbeddingService**: APIモック（@google/generative-aiのモック）でembed/embedBatchの入出力を検証
- **VectorStore**: tmpディレクトリ上の実ファイルでCRUD・検索・アクセスカウントを検証
- **MemoryTier**: 純粋関数のためモック不要。閾値フィルタリング・昇格判定を検証
- **コサイン距離計算**: 既知のベクトルペアで距離計算の正確性を検証

### Integration Testing
- memory_save → VectorStore保存 → memory_search → ベクトル検索ヒット の一連のフローをテスト
- embedding未生成エントリとの混在検索テスト
- memory_delete → VectorStore削除の整合性テスト

### End-to-End Testing
- wasurenagusa-context実行時のバックフィル起動確認（プロセスspawnのみ検証）
- 実Gemini API呼び出しテスト（API key必須、CIではスキップ可）
