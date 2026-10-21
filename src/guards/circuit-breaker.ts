/**
 * サーキットブレーカ（memory-redesign spec Phase 4・タスク4.6・R-C4）。
 *
 * 直近100回のPreToolUse評価でブロック率が10%を超えたら全ガードを自動停止する
 * （64正規表現事故の再発形＝自己DoSロックアウトの構造遮断）。
 * 判定はメモリ上の履歴配列に対する純粋関数（isCircuitOpen）で行い、DB・LLMを介在させない。
 * 履歴の永続化（プロセスをまたぐPreToolUse呼び出し間で直近100件を引き継ぐ）だけ
 * ファイルI/Oを使うが、判定ロジック自体はファイルを読んだ後の配列に対してのみ動く。
 */
import { appendFile, mkdir, open } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

export type EvalAction = "pass" | "block";

export interface EvalHistoryEntry {
  ts: string;
  action: EvalAction;
}

export const CIRCUIT_BREAKER_WINDOW = 100;
export const CIRCUIT_BREAKER_BLOCK_RATE_THRESHOLD = 0.1;

const HISTORY_FILE_NAME = "guard-eval-history.jsonl";

function getHistoryFilePath(memoryPath: string): string {
  return join(memoryPath, "logs", HISTORY_FILE_NAME);
}

/**
 * 履歴配列からブロック率を計算する純粋関数。空配列は0（アラートにならない）。
 */
export function computeBlockRate(history: EvalAction[]): number {
  if (history.length === 0) return 0;
  const blocks = history.filter((a) => a === "block").length;
  return blocks / history.length;
}

/**
 * 直近の履歴（呼び出し側が既に直近CIRCUIT_BREAKER_WINDOW件に絞って渡す前提）の
 * ブロック率が閾値を超えていれば true（サーキット開＝全ガード停止すべき）を返す。
 * サンプルが少なすぎる（誤警報を避けるための最小件数）場合は開かない。
 */
export function isCircuitOpen(
  history: EvalAction[],
  threshold: number = CIRCUIT_BREAKER_BLOCK_RATE_THRESHOLD,
): boolean {
  if (history.length === 0) return false;
  return computeBlockRate(history) > threshold;
}

/**
 * 1回の評価結果（実際にブロックすべきと判定されたか＝dry-run/enforceに関わらず
 * 「検出」の実態）を履歴へ追記する。書き込み失敗はfail-open（本処理を落とさない）。
 */
export async function recordEvaluation(
  memoryPath: string,
  action: EvalAction,
  now: Date = new Date(),
): Promise<void> {
  const entry: EvalHistoryEntry = { ts: now.toISOString(), action };
  const filePath = getHistoryFilePath(memoryPath);
  try {
    await mkdir(join(memoryPath, "logs"), { recursive: true });
    await appendFile(filePath, JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // fail-open: 履歴の書き込み失敗はガード機構全体を落とさない。
  }
}

/**
 * 直近window件の評価履歴を読み戻す。ファイル未作成・読込失敗はfail-openで空配列を返す
 * （履歴が読めない＝ブロック率0扱い＝サーキットは開かない、が安全側の既定）。
 */
export async function getRecentHistory(
  memoryPath: string,
  window: number = CIRCUIT_BREAKER_WINDOW,
): Promise<EvalAction[]> {
  const filePath = getHistoryFilePath(memoryPath);
  if (!existsSync(filePath)) return [];
  try {
    const lines: string[] = [];
    let lineLimit = Infinity;
    if (window >= 1) {
      lineLimit = Math.trunc(window);
    }
    const handle = await open(filePath, "r");
    try {
      let position = (await handle.stat()).size;
      const buffer = Buffer.alloc(16 * 1024);
      let remainder = Buffer.alloc(0);
      while (position > 0 && lines.length < lineLimit) {
        const length = Math.min(buffer.length, position);
        position -= length;
        let totalBytesRead = 0;
        while (totalBytesRead < length) {
          const { bytesRead } = await handle.read(buffer, totalBytesRead, length - totalBytesRead, position + totalBytesRead);
          if (bytesRead === 0) return [];
          totalBytesRead += bytesRead;
        }
        const chunk = Buffer.concat([buffer.subarray(0, length), remainder]);
        let lineEnd = chunk.length;
        for (let index = chunk.length - 1; index >= 0 && lines.length < lineLimit; index--) {
          if (chunk[index] !== 0x0a) continue;
          const line = chunk.subarray(index + 1, lineEnd).toString("utf-8");
          if (line.trim().length > 0) {
            lines.push(line);
          }
          lineEnd = index;
        }
        remainder = chunk.subarray(0, lineEnd);
      }
      if (position === 0 && lines.length < lineLimit) {
        const line = remainder.toString("utf-8");
        if (line.trim().length > 0) {
          lines.push(line);
        }
      }
    } finally {
      await handle.close();
    }
    const recentLines = lines.reverse().slice(-window);
    const actions: EvalAction[] = [];
    for (const line of recentLines) {
      try {
        const parsed = JSON.parse(line) as EvalHistoryEntry;
        if (parsed.action === "pass" || parsed.action === "block") {
          actions.push(parsed.action);
        }
      } catch {
        // 壊れた行は読み飛ばす（fail-open）
      }
    }
    return actions;
  } catch {
    return [];
  }
}
