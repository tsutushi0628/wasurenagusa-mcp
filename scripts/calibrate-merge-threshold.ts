/**
 * 類似閾値の実データ較正（memory-redesign spec Phase 3・タスク3.6／R-A6）。
 *
 * ラベル付きペア（${WASURENAGUSA_EVAL_DIR}/merge-labels.jsonl）に対する類似度分布を出し、
 * 誤統合率（different を統合と誤る率）が仮基準5%以下になる最小のコサイン類似度閾値を確定して
 * 記録する。「様子見の0.6/応急の0.25」を実測値へ置き換えるための物差し。
 *
 * 設計方針:
 *   - 較正ロジックは純関数 calibrateThreshold（{label, similarity}[] を入力）に閉じ、DB非依存で
 *     単体テスト可能にする。CLI 層はスナップショットDBから埋め込みを引いて similarity を算出し、
 *     この純関数へ渡すだけ（分岐・集計・判定はすべてコード側／LLM不使用）。
 *   - 出力に本文（記憶タイトル・内容）は載せない（数値のみ・機密配慮）。
 *   - 閾値はコサイン類似度（値が大きいほど近い）。統合判定は sim >= threshold。
 */
import { readFileSync } from "fs";
import { join } from "path";

export type MergeLabel = "same" | "different";

export interface LabeledPair {
  id: string;
  aId: string;
  bId: string;
  label: MergeLabel;
  labeler: string;
}

export interface ScoredPair {
  label: MergeLabel;
  /** コサイン類似度（1 に近いほど同一方向）。*/
  similarity: number;
}

export interface SimStats {
  count: number;
  min: number;
  max: number;
  mean: number;
  median: number;
}

export interface CalibrationResult {
  /** 確定コサイン類似度閾値（sim >= threshold を統合候補とみなす）。*/
  threshold: number;
  /** 確定閾値での誤統合率（different のうち sim>=threshold の割合）。*/
  falseMergeRate: number;
  /** 確定閾値での統合検出率（same のうち sim>=threshold の割合＝merge-recall）。*/
  recall: number;
  /** 仮基準（既定 0.05）。*/
  targetFalseMergeRate: number;
  /** 目標を満たす閾値が見つかったか（false の場合、全 different を除外できる最大閾値を返す）。*/
  achievedTarget: boolean;
  sameStats: SimStats;
  differentStats: SimStats;
}

function computeStats(values: number[]): SimStats {
  if (values.length === 0) {
    return { count: 0, min: NaN, max: NaN, mean: NaN, median: NaN };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
    median,
  };
}

/**
 * ラベル付き＋類似度付きペアから、誤統合率が target 以下になる最小のコサイン類似度閾値を確定する。
 * 最小の閾値を採ることで統合検出率（recall）を最大化する（誤統合率の制約下でのrecall最大化）。
 */
export function calibrateThreshold(
  pairs: ScoredPair[],
  targetFalseMergeRate = 0.05,
): CalibrationResult {
  const sameSims = pairs.filter((p) => p.label === "same").map((p) => p.similarity);
  const diffSims = pairs.filter((p) => p.label === "different").map((p) => p.similarity);

  if (sameSims.length === 0 || diffSims.length === 0) {
    throw new Error(
      `較正には same/different 双方のペアが必要です（same=${sameSims.length}, different=${diffSims.length}）`,
    );
  }

  const falseMergeRateAt = (t: number): number =>
    diffSims.filter((s) => s >= t).length / diffSims.length;
  const recallAt = (t: number): number =>
    sameSims.filter((s) => s >= t).length / sameSims.length;

  // 候補閾値は観測された全類似度（境界がちょうど値の上に来るよう昇順に走査）。
  const candidates = Array.from(new Set(pairs.map((p) => p.similarity))).sort((a, b) => a - b);

  let chosen: number | null = null;
  for (const t of candidates) {
    if (falseMergeRateAt(t) <= targetFalseMergeRate) {
      chosen = t; // 昇順走査で最初に満たした値＝目標を満たす最小閾値（recall最大）
      break;
    }
  }

  const achievedTarget = chosen !== null;
  // 目標未達（different が高類似に密集）の場合は、全 different を除外できる最大閾値
  //（different の最大類似度を上回る値）を保守的に返す。
  const threshold =
    chosen ?? Math.max(...diffSims) + Number.EPSILON;

  return {
    threshold,
    falseMergeRate: falseMergeRateAt(threshold),
    recall: recallAt(threshold),
    targetFalseMergeRate,
    achievedTarget,
    sameStats: computeStats(sameSims),
    differentStats: computeStats(diffSims),
  };
}

/** merge-labels.jsonl を読む（1行1ペア・空行は無視）。*/
export function loadLabels(path: string): LabeledPair[] {
  const raw = readFileSync(path, "utf-8");
  const out: LabeledPair[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const obj = JSON.parse(t) as LabeledPair;
    if (obj.label !== "same" && obj.label !== "different") {
      throw new Error(`不正な label: ${obj.label}（id=${obj.id}）`);
    }
    out.push(obj);
  }
  return out;
}

/**
 * CLI エントリ。スナップショットDBから各ペアの埋め込みを引いてコサイン類似度を算出し、較正する。
 * 出力は数値のみ（本文非表示）。
 */
async function main(): Promise<void> {
  const evalDir = process.env.WASURENAGUSA_EVAL_DIR;
  if (!evalDir) {
    process.stderr.write(
      "WASURENAGUSA_EVAL_DIR が未設定です（Git外のローカルデータ領域を指す前提）。\n",
    );
    process.exit(2);
  }
  const labelsPath = process.env.MERGE_LABELS_PATH ?? join(evalDir, "merge-labels.jsonl");
  const snapshotDb = process.env.MERGE_CALIBRATE_DB;
  if (!snapshotDb) {
    process.stderr.write(
      "MERGE_CALIBRATE_DB（較正に使うスナップショットDBのパス）を指定してください。\n",
    );
    process.exit(2);
  }

  const { SQLiteStorage } = await import("../src/storage/sqlite.js");
  const { cosineDistance } = await import("../src/vector/cosine-distance.js");
  const { asL2Distance, l2ToCosineSim } = await import("../src/vector/distance-types.js");

  const labels = loadLabels(labelsPath);
  const storage = new SQLiteStorage(snapshotDb);
  storage.initialize();

  const scored: ScoredPair[] = [];
  let missing = 0;
  for (const p of labels) {
    const ea = storage.getEmbedding(p.aId);
    const eb = storage.getEmbedding(p.bId);
    if (!ea || !eb) {
      missing++;
      continue;
    }
    // cosineDistance は 1-cos を返す（=L2正規化ベクトルの内積由来）。ここでは埋め込みの
    // 実内積からコサイン類似度を直接得る（sim = 1 - cosineDistance）。
    const sim = 1 - cosineDistance(ea, eb);
    // 参考: 索引距離(L2)経由の換算と一致することを型経由で確認できる（未使用でも意図の記録）。
    void l2ToCosineSim(asL2Distance(0));
    void asL2Distance;
    scored.push({ label: p.label, similarity: sim });
  }
  storage.close();

  const result = calibrateThreshold(scored);
  // 数値のみのレポート（本文なし）。
  process.stdout.write(
    JSON.stringify(
      {
        labelsTotal: labels.length,
        scored: scored.length,
        missingEmbeddings: missing,
        ...result,
      },
      null,
      2,
    ) + "\n",
  );
}

// スクリプトとして直接実行されたときのみ main を走らせる（テストからの import では走らせない）。
if (process.argv[1] && process.argv[1].endsWith("calibrate-merge-threshold.ts")) {
  main().catch((e) => {
    process.stderr.write(String(e?.stack ?? e) + "\n");
    process.exit(1);
  });
}
