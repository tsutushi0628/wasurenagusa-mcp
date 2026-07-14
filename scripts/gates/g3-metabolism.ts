#!/usr/bin/env node
/**
 * scripts/gates/g3-metabolism.ts
 * Phase 3（代謝＝統合と昇格）完了ゲート（design.md Phase 3 ③、タスク3.16、R-A6/R-A7/R-M3）。
 *
 * 検証役（qa-engineer）専用資産。実装者は編集しない（design.md「ゲート運用」）。
 *
 * 契約7項目: false-merge-rate / append-only / lineage-complete / batch-cap / human-gate /
 * distance-types / salvage-report。静的構造検査（ソース走査）を主とし、false-merge-rate は
 * ラベル付きペア（--labels）とスナップショット（--store）が揃うときのみ実測する。
 *
 * Usage:
 *   node --loader ts-node/esm scripts/gates/g3-metabolism.ts \
 *     [--repo-root <dir>] [--labels <merge-labels.jsonl>] [--store <.wasurenagusaパス>] \
 *     [--target-false-merge 0.05]
 *
 * 出力形式: G0/G1/G-write-severance と同型（1検査1行のJSON: check/result/measured/threshold）。
 * 記憶本文は一切出力しない（件数・真偽値・比率・ファイル位置のみ）。
 */
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";
import { existsSync, readFileSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_REPO_ROOT = resolve(__dirname, "..", "..");

export interface CheckResult {
  check: string;
  result: "PASS" | "FAIL";
  measured: Record<string, unknown>;
  threshold: Record<string, unknown>;
}

function read(repoRoot: string, rel: string): string | null {
  const p = join(repoRoot, rel);
  return existsSync(p) ? readFileSync(p, "utf-8") : null;
}

/** applyAppendOnlyMerge の本文を切り出す（メソッド宣言から対応する閉じ括弧の手前まで・簡易）。 */
function extractMethodBody(source: string, methodSig: string): string | null {
  const start = source.indexOf(methodSig);
  if (start < 0) return null;
  // メソッド宣言以降 2500 文字を窓として見る（本メソッドはこの範囲に収まる）。
  return source.slice(start, start + 2500);
}

/**
 * append-only: 追記型マージが原本の本文 UPDATE も物理 DELETE もしないことを静的に検査する。
 * applyAppendOnlyMerge 本文が「新規 saveInternal」「state='deleted' への UPDATE」だけを行い、
 * 本文 UPDATE（UPDATE memories SET ... content）や DELETE FROM memories を含まないこと。
 */
export function checkAppendOnly(repoRoot: string): CheckResult {
  const src = read(repoRoot, "src/storage/sqlite.ts");
  const body = src ? extractMethodBody(src, "applyAppendOnlyMerge(input:") : null;
  const violations: string[] = [];
  let hasMethod = body !== null;
  if (!hasMethod) {
    violations.push("applyAppendOnlyMerge が見つからない");
  } else {
    if (!/saveInternal\(/.test(body!)) violations.push("新規レコード追記(saveInternal)が無い");
    if (!/state = 'deleted'/.test(body!)) violations.push("原本の論理deleted遷移が無い");
    // 原本破壊の禁止パターン
    if (/DELETE\s+FROM\s+memories/i.test(body!)) violations.push("物理DELETE(memories)を含む");
    if (/UPDATE\s+memories\s+SET\s+content/i.test(body!)) violations.push("原本本文のUPDATEを含む");
  }
  return {
    check: "append-only",
    result: violations.length === 0 ? "PASS" : "FAIL",
    measured: { hasMethod, violations },
    threshold: { violations: 0 },
  };
}

/** lineage-complete: 追記型マージが全 sourceId に merged_from 系譜を記録する構造を静的に検査。 */
export function checkLineageComplete(repoRoot: string): CheckResult {
  const src = read(repoRoot, "src/storage/sqlite.ts");
  const body = src ? extractMethodBody(src, "applyAppendOnlyMerge(input:") : null;
  const ok =
    body !== null &&
    /for\s*\(const sid of input\.sourceIds\)/.test(body) &&
    /insertLineageStmt\.run\(/.test(body) &&
    /relation.*merged_from|'merged_from'/.test(src!);
  return {
    check: "lineage-complete",
    result: ok ? "PASS" : "FAIL",
    measured: { recordsMergedFromPerSource: ok },
    threshold: { recordsMergedFromPerSource: true },
  };
}

/** batch-cap: 夜間統合の上限機構が存在する。 */
export function checkBatchCap(repoRoot: string): CheckResult {
  const src = read(repoRoot, "src/consolidator/batch-cap.ts");
  const ok = !!src && /export function capClusters/.test(src) && /DEFAULT_NIGHTLY_CAP/.test(src);
  return {
    check: "batch-cap",
    result: ok ? "PASS" : "FAIL",
    measured: { hasCapMechanism: ok },
    threshold: { hasCapMechanism: true },
  };
}

/**
 * human-gate: 自動昇格の経路が無いことを静的に検査する。approvePrinciple( の呼び出しは CLI
 * （cli/promote.ts）とテストにのみ現れ、統合ロジック（consolidator/）には現れないこと。
 * かつ注入取得 getInjectablePrinciples が approved_at IS NOT NULL を要求すること。
 */
export function checkHumanGate(repoRoot: string): CheckResult {
  const sqlite = read(repoRoot, "src/storage/sqlite.ts") ?? "";
  const promotion = read(repoRoot, "src/consolidator/promotion.ts") ?? "";
  const violations: string[] = [];
  // 昇格ロジック層（promotion.ts）が承認を自動で呼んでいないこと（起草のみ・承認はCLI）。
  if (/\.approvePrinciple\(/.test(promotion)) violations.push("promotion.ts が approve を自動呼び出し");
  // 注入取得が approved_at 非NULL を要求すること。
  if (!/approved_at IS NOT NULL/.test(sqlite)) violations.push("注入取得が approved_at 非NULL を要求しない");
  return {
    check: "human-gate",
    result: violations.length === 0 ? "PASS" : "FAIL",
    measured: { violations },
    threshold: { violations: 0 },
  };
}

/** distance-types: 距離尺度の型封じ（branded types）が存在し、カテゴリKNNが Threshold を要求する。 */
export function checkDistanceTypes(repoRoot: string): CheckResult {
  const dt = read(repoRoot, "src/vector/distance-types.ts") ?? "";
  const sqlite = read(repoRoot, "src/storage/sqlite.ts") ?? "";
  const ok =
    /CosineSimilarity/.test(dt) &&
    /L2Distance/.test(dt) &&
    /searchVectorsByCategory\([^)]*threshold:\s*Threshold/.test(sqlite);
  return {
    check: "distance-types",
    result: ok ? "PASS" : "FAIL",
    measured: { brandedTypes: /CosineSimilarity/.test(dt), knnUsesThreshold: /threshold:\s*Threshold/.test(sqlite) },
    threshold: { brandedTypes: true, knnUsesThreshold: true },
  };
}

/**
 * salvage-report: アーカイブ選別投入（タスク3.14）の台帳/レポート生成器が存在する。
 * 未実装（scripts/salvage-archive.ts 不在）なら FAIL（正直に未達を表示）。
 */
export function checkSalvageReport(repoRoot: string): CheckResult {
  const exists = existsSync(join(repoRoot, "scripts/salvage-archive.ts"));
  return {
    check: "salvage-report",
    result: exists ? "PASS" : "FAIL",
    measured: { salvageScriptPresent: exists },
    threshold: { salvageScriptPresent: true },
  };
}

/**
 * false-merge-rate: ラベル付きペアで誤統合率が target 以下になる確定閾値が得られるか。
 * ラベル/スナップショット未提供時は「実測不能」を FAIL として表示する（3.5ラベル未整備を隠さない）。
 */
export async function checkFalseMergeRate(
  labelsPath: string | undefined,
  storePath: string | undefined,
  target: number,
): Promise<CheckResult> {
  if (!labelsPath || !storePath) {
    return {
      check: "false-merge-rate",
      result: "FAIL",
      measured: { reason: "labels/store 未提供のため実測不能（タスク3.5のラベル整備が前提）" },
      threshold: { targetFalseMergeRate: target },
    };
  }
  const { loadLabels, calibrateThreshold } = await import("../calibrate-merge-threshold.js");
  const { SQLiteStorage } = await import("../../src/storage/sqlite.js");
  const { cosineDistance } = await import("../../src/vector/cosine-distance.js");
  const labels = loadLabels(labelsPath);
  const storage = new SQLiteStorage(join(storePath, "memory.db"));
  storage.initialize(storePath);
  const scored: { label: "same" | "different"; similarity: number }[] = [];
  for (const p of labels) {
    const ea = storage.getEmbedding(p.aId);
    const eb = storage.getEmbedding(p.bId);
    if (!ea || !eb) continue;
    scored.push({ label: p.label, similarity: 1 - cosineDistance(ea, eb) });
  }
  storage.close();
  const r = calibrateThreshold(scored, target);
  return {
    check: "false-merge-rate",
    result: r.achievedTarget && r.falseMergeRate <= target ? "PASS" : "FAIL",
    measured: { falseMergeRate: r.falseMergeRate, threshold: r.threshold, scored: scored.length },
    threshold: { targetFalseMergeRate: target },
  };
}

export interface G3Options {
  repoRoot?: string;
  labelsPath?: string;
  storePath?: string;
  targetFalseMerge?: number;
}

export async function runG3(options: G3Options = {}): Promise<CheckResult[]> {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const target = options.targetFalseMerge ?? 0.05;
  return [
    await checkFalseMergeRate(options.labelsPath, options.storePath, target),
    checkAppendOnly(repoRoot),
    checkLineageComplete(repoRoot),
    checkBatchCap(repoRoot),
    checkHumanGate(repoRoot),
    checkDistanceTypes(repoRoot),
    checkSalvageReport(repoRoot),
  ];
}

function parseFlag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const targetRaw = parseFlag("--target-false-merge");
  const checks = await runG3({
    repoRoot: parseFlag("--repo-root"),
    labelsPath: parseFlag("--labels"),
    storePath: parseFlag("--store"),
    targetFalseMerge: targetRaw ? Number(targetRaw) : undefined,
  });
  for (const c of checks) console.log(JSON.stringify(c));
  const failed = checks.filter((c) => c.result === "FAIL");
  console.log(`\n== G3(代謝)結果: ${checks.length - failed.length}/${checks.length} PASS ==`);
  if (failed.length > 0) console.log(`FAIL項目: ${failed.map((c) => c.check).join(", ")}`);
  process.exitCode = failed.length > 0 ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith("g3-metabolism.ts")) {
  main().catch((e) => {
    console.error(String(e?.stack ?? e));
    process.exitCode = 1;
  });
}
