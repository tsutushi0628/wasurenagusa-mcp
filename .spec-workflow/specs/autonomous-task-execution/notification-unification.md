# Implementation Log: スケジューラ通知の統一体験設計

## 背景

スケジューラの通知が2系統に分かれており、ユーザーが受け取る体験が不統一。

- **自律タスク**: 1件ずつ個別通知（`notifyTaskCompleted` / `notifyTaskFailed`）
- **Spec更新**: 開始通知 + 完了サマリー（`notifySpecUpdateStarted` / `notifySpecUpdateSummary`）

ユーザーの要望: 「人間が知りたいのは、何がいつどう自動実行されたか。タスク種別は内部実装の都合」。

## 1. Before / After

### Before（現在）

1サイクルで自律タスク3件 + Spec更新2件を実行した場合、通知は**最大6通**:

```
通知1: 📋 Spec Update: 2件のタスクを実行開始
通知2: ✅ Task Completed — my-project / テスト追加
通知3: ❌ Task Failed — other-project / ビルド修正
通知4: ✅ Task Completed — third-project / リファクタ
通知5: 📋 Spec Update 完了: 2/2件成功
      Details:
      • project-a (change-based) → exit 0
      • project-b (rotation) → exit 0
```

**問題点:**
- 自律タスクは1件ごとに即時通知、Spec更新はまとめてサマリー → 粒度が不統一
- 開始通知（`spec_update_started`）はSpec更新にしかない
- ユーザーは「今回のサイクルで何が起きたか」を把握するのに複数通知を読む必要がある
- 通知が多すぎてノイズになる

### After（統一後）

1サイクルで**1通**のサマリー通知:

```
通知1: 📊 Scheduler Cycle Summary — 5件実行 (4成功 / 1失敗)
       [全タスクの一覧が1通に集約]
```

**改善点:**
- 1サイクル = 1通知。ユーザーは1回のSlack確認で全体像を把握
- タスク種別（autonomous / change-based / rotation）はラベルで表示するが、フォーマットは統一
- 失敗の種別（exitCode, timeout, validation）が一目で区別可能

**例外（即時通知のまま残すもの）:**
- `notifyHumanRequired` — 人間判断が必要なため即時通知が必須
- `notifyRetryLimitReached` — 上限到達は即時でエスカレーションすべき
- `notifyDailySummary` — 日次レポートは独立した用途

## 2. Slack通知のモック

### 2-1. 通常サイクル（成功あり + 失敗あり）

```json
[
  {
    "type": "header",
    "text": {
      "type": "plain_text",
      "text": "📊 Scheduler Cycle: 5件実行 (4成功 / 1失敗)"
    }
  },
  {
    "type": "section",
    "fields": [
      { "type": "mrkdwn", "text": "*Total:*\n5" },
      { "type": "mrkdwn", "text": "*Duration:*\n12m 34s" }
    ]
  },
  {
    "type": "section",
    "text": {
      "type": "mrkdwn",
      "text": "*Tasks:*\n✅ `my-project` [autonomous] テスト追加 (3m 12s)\n✅ `other-project` [autonomous] リファクタ (5m 01s)\n❌ `third-project` [autonomous] ビルド修正 — Exit code: 1\n✅ `project-a` [change-based] spec更新 (2m 10s)\n✅ `project-b` [rotation] spec更新 (2m 11s)"
    }
  },
  {
    "type": "context",
    "elements": [
      { "type": "mrkdwn", "text": "Cycle completed at 2026-02-18 03:15 JST" }
    ]
  }
]
```

Slackでの表示イメージ:

```
📊 Scheduler Cycle: 5件実行 (4成功 / 1失敗)

Total:          Duration:
5               12m 34s

Tasks:
✅ `my-project` [autonomous] テスト追加 (3m 12s)
✅ `other-project` [autonomous] リファクタ (5m 01s)
❌ `third-project` [autonomous] ビルド修正 — Exit code: 1
✅ `project-a` [change-based] spec更新 (2m 10s)
✅ `project-b` [rotation] spec更新 (2m 11s)

Cycle completed at 2026-02-18 03:15 JST
```

### 2-2. 全成功パターン

```
📊 Scheduler Cycle: 3件実行 (3成功)

Total:          Duration:
3               8m 45s

Tasks:
✅ `my-project` [autonomous] テスト追加 (3m 12s)
✅ `project-a` [change-based] spec更新 (2m 43s)
✅ `project-b` [rotation] spec更新 (2m 50s)

Cycle completed at 2026-02-18 03:15 JST
```

### 2-3. 失敗のみパターン（バリデーション失敗含む）

```
📊 Scheduler Cycle: 2件実行 (0成功 / 2失敗)

Total:          Duration:
2               0m 02s

Tasks:
❌ `bad-project` [autonomous] テスト — バリデーション失敗: フィールド "why" が空
❌ `other` [change-based] spec更新 — Exit code: 1

Cycle completed at 2026-02-18 03:15 JST
```

### 2-4. 失敗時の種別表示

失敗理由は以下のように区別:

| 失敗タイプ | 表示 |
|-----------|------|
| exitCode !== 0 | `Exit code: {n}` |
| バリデーション失敗 | `バリデーション失敗: {reason}` |
| 例外/エラー | `Error: {message}` |
| タイムアウト | `Timeout after {n}ms` (※ executorが返すexit codeで判別) |

### 2-5. タスクゼロ（pingのみ）

pingのみの場合はサイクルサマリー通知を送信しない（現在と同じ）。

## 3. コンポーネント設計

### 3-1. 新規型定義

```typescript
// 1サイクルの全タスク結果を集約する型
export interface CycleTaskResult {
  project: string;
  taskType: "autonomous" | "change-based" | "rotation";
  description: string;       // autonomous: task.what, spec: "spec更新"
  summary?: string;          // 成功時のサマリー（Spec更新のstdout先頭等）
  exitCode: number;
  durationMs: number;
  failReason?: string;       // 失敗時のみ
}

export interface CycleSummary {
  results: CycleTaskResult[];
  totalDurationMs: number;
  completedAt: string;        // ISO 8601 JST
}
```

### 3-2. SlackNotifier の変更

**新規メソッド:**
```typescript
async notifyCycleSummary(summary: CycleSummary): Promise<void>
private buildCycleSummaryBlocks(summary: CycleSummary): SlackBlock[]
private formatDuration(ms: number): string  // "3m 12s" 形式
```

**削除対象メソッド:**
```typescript
// 以下は廃止（統一サマリーに置換）
notifyTaskCompleted()        → 廃止
notifyTaskFailed()           → 廃止
notifySpecUpdateStarted()    → 廃止
notifySpecUpdateSummary()    → 廃止
```

**残すメソッド:**
```typescript
notifyHumanRequired()        → そのまま（即時性必要）
notifyRetryLimitReached()    → そのまま（即時性必要）
notifyDailySummary()         → そのまま（独立用途）
```

**NotificationType の変更:**
```typescript
// Before
export type NotificationType =
  | "task_completed"
  | "task_failed"
  | "task_human_required"
  | "task_retry"
  | "daily_summary"
  | "spec_update_started"
  | "spec_update_summary";

// After
export type NotificationType =
  | "cycle_summary"            // 新規
  | "task_human_required"      // 残す
  | "task_retry"               // 残す
  | "daily_summary";           // 残す
// task_completed, task_failed, spec_update_started, spec_update_summary は廃止
```

### 3-3. spec-update.ts （呼び出し側）の変更

**現在のフロー:**
```
自律タスクループ内:
  成功 → notifyTaskCompleted()        ← 廃止
  失敗 → notifyTaskFailed()           ← 廃止
  human → notifyHumanRequired()       ← 残す
  retry → notifyRetryLimitReached()   ← 残す

Spec更新開始時:
  notifySpecUpdateStarted()           ← 廃止

Spec更新完了後:
  notifySpecUpdateSummary()           ← 廃止
```

**新フロー:**
```
// 1. サイクル開始時: CycleTaskResult[] を初期化
const cycleResults: CycleTaskResult[] = [];

// 2. 各タスク実行後: 結果をcycleResultsに追加（通知は送らない）
//    - 自律タスク: { project, taskType: "autonomous", description: task.what, ... }
//    - Spec更新: { project, taskType: task.type, description: "spec更新", ... }

// 3. 即時通知が必要なものだけ従来通り送信:
//    - notifyHumanRequired() — そのまま
//    - notifyRetryLimitReached() — そのまま

// 4. 全タスク完了後（runWithConcurrencyLimit後）: 1回だけサマリー通知
if (cycleResults.length > 0) {
  await notifier.notifyCycleSummary({
    results: cycleResults,
    totalDurationMs: /* 全体の経過時間 */,
    completedAt: new Date().toISOString(),
  });
}
```

**具体的な変更箇所:**

| ファイル | 行 | 現在 | 変更後 |
|---------|-----|------|--------|
| `spec-update.ts` L290 | `notifyTaskFailed(...)` | `cycleResults.push(...)` に置換 |
| `spec-update.ts` L317 | `notifyTaskCompleted(...)` | `cycleResults.push(...)` に置換 |
| `spec-update.ts` L444 | `notifyTaskFailed(...)` (validation) | `cycleResults.push(...)` に置換 |
| `spec-update.ts` L463 | `notifyTaskFailed(...)` (error) | `cycleResults.push(...)` に置換 |
| `spec-update.ts` L492 | `notifySpecUpdateStarted(...)` | 削除 |
| `spec-update.ts` L523 | `specUpdateDetails.push(...)` | `cycleResults.push(...)` に置換 |
| `spec-update.ts` L554-563 | `notifySpecUpdateSummary(...)` | `notifyCycleSummary(...)` に置換 |

**注意: `executeAutonomousTask` 関数のシグネチャ変更**

現在 `executeAutonomousTask` は内部で `notifier.notifyTaskCompleted/Failed` を直接呼んでいる。統一後はこの関数から通知呼び出しを除去し、代わりに結果情報を返すようにする。

```typescript
// Before: 内部で通知を送信
async function executeAutonomousTask(
  task, taskStore, executor, notifier
): Promise<{ exitCode: number; durationMs: number }>

// After: 通知は送らず、結果を返す（failReasonも含む）
async function executeAutonomousTask(
  task, taskStore, executor, notifier
): Promise<{ exitCode: number; durationMs: number; failReason?: string }>
```

`notifier` 引数は `notifyHumanRequired` / `notifyRetryLimitReached` のために残す。

### 3-4. 並列実行との整合

`cycleResults` 配列は `runWithConcurrencyLimit` のラムダ内から push される。JavaScriptのシングルスレッド特性上、`push` はアトミックであり、明示的なロック不要。ただし結果の順序はタスク完了順になる（元の投入順ではない）。表示上は問題ない。

## 4. 削除対象

### メソッド

| メソッド | ファイル | 理由 |
|---------|--------|------|
| `notifyTaskCompleted()` | `notifier.ts` L92-99 | サマリーに統合 |
| `notifyTaskFailed()` | `notifier.ts` L101-108 | サマリーに統合 |
| `notifySpecUpdateStarted()` | `notifier.ts` L149-154 | サマリーに統合（開始通知は廃止） |
| `notifySpecUpdateSummary()` | `notifier.ts` L156-161 | サマリーに統合 |
| `buildSpecUpdateStartedBlocks()` | `notifier.ts` L266-275 | 上記に伴い不要 |
| `buildSpecUpdateSummaryBlocks()` | `notifier.ts` L278-307 | 上記に伴い不要 |

### 型定義

| 型 | ファイル | 理由 |
|----|--------|------|
| `SpecUpdateTaskDetail` | `notifier.ts` L36-41 | `CycleTaskResult` に置換 |
| `SpecUpdateSummaryResult` | `notifier.ts` L42-47 | `CycleSummary` に置換 |
| `NotificationType` の `task_completed` | `notifier.ts` L4 | 廃止 |
| `NotificationType` の `task_failed` | `notifier.ts` L5 | 廃止 |
| `NotificationType` の `spec_update_started` | `notifier.ts` L9 | 廃止 |
| `NotificationType` の `spec_update_summary` | `notifier.ts` L10 | 廃止 |

### NotificationPayload のブランチ

`task_completed` / `task_failed` / `spec_update_started` / `spec_update_summary` のブランチを削除し、`cycle_summary` ブランチを追加。

### テストファイル

`notifier.test.ts` の以下テストケースは削除/書き換え:
- `notifyTaskCompleted` describe → 削除
- `notifyTaskFailed` describe → 削除
- `notifyCycleSummary` describe → 新規追加

### `spec-update.ts` の変数

| 変数 | 行 | 理由 |
|------|-----|------|
| `specUpdateDetails` | L489 | `cycleResults` に統合 |

## 5. 移行時の注意点

1. **`SpecUpdateTaskDetail` の外部参照**: `spec-update.ts` で `import { type SpecUpdateTaskDetail }` している。`CycleTaskResult` に置換する際にimportも更新する
2. **`getEmoji` / `getTitle` マップ**: 廃止する `NotificationType` に対応するエントリを削除し、`cycle_summary` エントリを追加
3. **buildSlackBlocks の条件分岐**: `task_completed` / `task_failed` 用のブロックビルダー（L199-243）は `cycle_summary` 用に置換
4. **テストの `fetchMock` パターン**: 既存テストの構造を流用し、`notifyCycleSummary` のブロック構造を検証する
