#!/usr/bin/env node
/**
 * scripts/compare-injection-effect.ts
 * タスク4.9（検証役）: 注入前後の挙動比較（固定タスクスイート）。
 *
 * design.md 設計判断D-8（注入ゼロ実験の部分採用）の判断材料を数値で揃える。
 * 「注入あり」と「注入なし」で、記憶参照が効くべき代表タスクの挙動差を実測する。
 *
 * 実測する挙動差:
 *   - 「注入あり」= buildInjection() が返す最小索引＋確定原則のテキストに、
 *     タスクが期待する記憶（expectedMemoryId）のタイトル・IDが含まれているか
 *     （＝検索を1回も呼ばずに到達できるか）。
 *   - 「注入なし」= 注入ゼロと同義。定義上、事前到達は常に不成立（0%）。
 *     したがって差分は「注入ありでの到達率」そのものが、注入が生む実効価値になる。
 *
 * 結論を先に決めず、固定タスクスイート（代表的な記憶参照パターン: config / dont / 確定原則）
 * を実データではなく合成フィクスチャで再現し、同一の buildInjection 実装（本番コード）へ通す。
 *
 * Usage:
 *   npx tsx scripts/compare-injection-effect.ts [--budget <tokens>]
 *
 * 出力: ローカルデータ領域（.wasurenagusa/reports/compare-injection-effect.json, Git追跡外）へ
 * 前後比較レポートを書き出し、標準出力にも数値と判定のみを表示する。
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join, resolve, dirname } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { SQLiteStorage } from "../src/storage/sqlite.js";
import { buildInjection } from "../src/injection/builder.js";
import { DEFAULT_INJECTION_TOKEN_BUDGET } from "../src/injection/budget.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

interface FixtureMemory {
  id: string;
  category: "config" | "dont" | "decision" | "log" | "snippet";
  title: string;
  content: string;
}

interface FixturePrinciple {
  id: string;
  text: string;
  validUntil: string;
}

interface TaskCase {
  taskId: string;
  description: string;
  /** このタスクで「記憶参照が効くべき」対象のID（memories または principles）。 */
  expectedMemoryId?: string;
  expectedPrincipleId?: string;
}

/** 固定タスクスイート: 代表的な記憶参照パターン（config / dont / 確定原則）を各1件以上含む。 */
const FIXTURE_MEMORIES: FixtureMemory[] = [
  { id: "fx-config-1", category: "config", title: "本番デプロイはSSHリモート経由", content: "workflowファイルpush時はSSHリモートに切替える" },
  { id: "fx-dont-1", category: "dont", title: "git push --force は明示指示時のみ", content: "force pushは既定禁止、明示指示のみ許可" },
  { id: "fx-decision-1", category: "decision", title: "スキーマ版数7→8でguardsテーブル新設", content: "guards テーブルを新設し承認制ガードの正本にする" },
  { id: "fx-log-1", category: "log", title: "G3ゲートは静的構造検査を主とする", content: "false-merge-rateのみラベル+スナップショット時に実測" },
];

const FIXTURE_PRINCIPLES: FixturePrinciple[] = [
  { id: "fx-principle-1", text: "本番反映後の実出力はメインが直接ツール経由で確認する", validUntil: "2099-01-01T00:00:00.000Z" },
];

/** タスクごとに「その記憶参照が効けば到達できるはず」の対象を宣言する。 */
const TASK_SUITE: TaskCase[] = [
  { taskId: "task-deploy-workflow-push", description: "workflowファイルを含むpushでOAuth scope不足が出た時の対処", expectedMemoryId: "fx-config-1" },
  { taskId: "task-force-push-check", description: "force pushしてよいか判断する", expectedMemoryId: "fx-dont-1" },
  { taskId: "task-schema-migration", description: "guardsテーブルの版数管理の経緯を確認する", expectedMemoryId: "fx-decision-1" },
  { taskId: "task-gate-design", description: "G3ゲートの検査方式を思い出す", expectedMemoryId: "fx-log-1" },
  { taskId: "task-prod-verify-principle", description: "本番反映後の確認手順の原則を思い出す", expectedPrincipleId: "fx-principle-1" },
];

interface TaskResult {
  taskId: string;
  description: string;
  withInjectionReached: boolean;
  withoutInjectionReached: boolean;
}

function withFreshStorage<T>(fn: (storage: SQLiteStorage) => T): T {
  const tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-compare-injection-"));
  const dbPath = join(tmpDir, "test.db");
  const storage = new SQLiteStorage(dbPath);
  storage.initialize();
  try {
    return fn(storage);
  } finally {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function seedFixtures(storage: SQLiteStorage, now: Date): void {
  for (const m of FIXTURE_MEMORIES) {
    storage.save({ category: m.category, title: m.title, content: m.content });
  }
  for (const p of FIXTURE_PRINCIPLES) {
    storage.insertPrinciple({
      id: p.id,
      text: p.text,
      originTier: "agent_observed",
      evidenceIds: [],
      validUntil: p.validUntil,
    });
    storage.approvePrinciple(p.id, now);
  }
}

/** 「注入あり」: buildInjection()の本番実装が返すテキストに期待対象が含まれるか。 */
function reachedWithInjection(injectionText: string, task: TaskCase): boolean {
  if (task.expectedMemoryId) {
    const target = FIXTURE_MEMORIES.find((m) => m.id === task.expectedMemoryId);
    return !!target && injectionText.includes(target.title);
  }
  if (task.expectedPrincipleId) {
    const target = FIXTURE_PRINCIPLES.find((p) => p.id === task.expectedPrincipleId);
    return !!target && injectionText.includes(target.text);
  }
  return false;
}

export function runComparison(budgetTokens: number = DEFAULT_INJECTION_TOKEN_BUDGET): {
  budgetTokens: number;
  results: TaskResult[];
  withInjectionReachRate: number;
  withoutInjectionReachRate: number;
} {
  const results: TaskResult[] = withFreshStorage((storage) => {
    const now = new Date();
    seedFixtures(storage, now);
    const injection = buildInjection(storage, undefined, budgetTokens, now);
    return TASK_SUITE.map((task) => ({
      taskId: task.taskId,
      description: task.description,
      withInjectionReached: reachedWithInjection(injection.text, task),
      // 注入なし = 定義上、事前注入テキストが空文字であることと等価。
      withoutInjectionReached: reachedWithInjection("", task),
    }));
  });

  const withInjectionReachRate =
    results.filter((r) => r.withInjectionReached).length / results.length;
  const withoutInjectionReachRate =
    results.filter((r) => r.withoutInjectionReached).length / results.length;

  return { budgetTokens, results, withInjectionReachRate, withoutInjectionReachRate };
}

function parseFlag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const budgetRaw = parseFlag("--budget");
  const budgetTokens = budgetRaw ? Number(budgetRaw) : DEFAULT_INJECTION_TOKEN_BUDGET;
  const report = runComparison(budgetTokens);

  const reportDir = join(REPO_ROOT, ".wasurenagusa", "reports");
  mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, "compare-injection-effect.json");
  writeFileSync(
    reportPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), ...report }, null, 2),
    "utf-8",
  );

  console.log(JSON.stringify({
    budgetTokens: report.budgetTokens,
    taskCount: report.results.length,
    withInjectionReachRate: report.withInjectionReachRate,
    withoutInjectionReachRate: report.withoutInjectionReachRate,
    delta: report.withInjectionReachRate - report.withoutInjectionReachRate,
    reportPath,
  }, null, 2));
}

if (process.argv[1] && process.argv[1].endsWith("compare-injection-effect.ts")) {
  main().catch((e) => {
    console.error(String(e?.stack ?? e));
    process.exitCode = 1;
  });
}
