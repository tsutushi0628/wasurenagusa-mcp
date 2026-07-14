/**
 * 外部キルスイッチ（memory-redesign spec Phase 4・タスク4.6・R-C4）。
 *
 * ストア直下（memoryPath）に guards.kill ファイルが存在するかどうかだけで即時に
 * 全ガードを停止する。判定はファイル存在チェックのみ（DB・LLM非介在・同期・低コスト）。
 * MCPプロセスの外から `touch <memoryPath>/guards.kill` の一発で止められることが目的。
 */
import { existsSync } from "fs";
import { join } from "path";

export const KILL_SWITCH_FILE_NAME = "guards.kill";

export function getKillSwitchPath(memoryPath: string): string {
  return join(memoryPath, KILL_SWITCH_FILE_NAME);
}

/**
 * キルスイッチが有効化されているか（= 全ガード停止すべきか）を返す。
 * ファイルシステムエラー（権限等）はfail-safe側に倒し、停止中とみなす設計は取らず、
 * existsSyncの例外は発生しない（存在しない場合falseを返す標準仕様）ためそのまま返す。
 */
export function isKilled(memoryPath: string): boolean {
  try {
    return existsSync(getKillSwitchPath(memoryPath));
  } catch {
    // 判定不能時はfail-open（ガード機構自体が壊れてツール実行をブロックしない）。
    return false;
  }
}
