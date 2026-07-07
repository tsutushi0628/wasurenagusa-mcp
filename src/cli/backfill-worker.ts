#!/usr/bin/env node
/**
 * backfill-worker
 * detachedプロセスとして起動され、embedding未生成のメモリエントリをバックグラウンドで埋める。
 *
 * 使い方: node backfill-worker.js <memoryPath> <projectRoot> [batchSize]
 *
 * context.ts の SessionStart hook から spawn される。
 * hookの5秒タイムアウトに影響を与えず、Embedding APIコールを完了できる。
 */

import { join } from "path";
import { SQLiteStorage } from "../storage/index.js";
import { config } from "../config.js";
import { LocalEmbedding } from "../vector/local-embedding.js";
import { increment } from "../observability/counters.js";
import { isMainModule } from "../utils/cli-entry.js";

// 蘇生件数の計測失敗のプロセス内カウンタ（fail-open時の可視化用、counters.tsの
// counterWriteFailureCountと同型のパターン）。計測失敗を偽の0件として記録しないための
// 可視化専用カウンタであり、observability/counters.tsのJSONL書き込み失敗カウンタとは
// 別の失敗モード（SQL読み取り失敗）を計上するため区別して持つ。
let resurrectionMeasurementFailureCount = 0;

export function getResurrectionMeasurementFailureCount(): number {
  return resurrectionMeasurementFailureCount;
}

/** テスト専用: プロセス内失敗カウンタをリセットする */
export function resetResurrectionMeasurementFailureCountForTest(): void {
  resurrectionMeasurementFailureCount = 0;
}

/**
 * 可観測性カウンタ（タスク0.9、R-M1）: 蘇生件数（deleted行への埋め込み付与）を検出し記録する。
 * 論理削除済みmemoriesに対応するvectors行が残っている＝蘇生（またはvector未清算）の兆候。
 * backfill自体のクエリはgetEntriesWithoutEmbedding()でdeleted_at IS NULLを絞り込んでいる
 * ため蘇生を起こさないが、他経路での再発を毎回のbackfill実行時に検知する安全網とする。
 * fail-open: 計測失敗はbackfill本処理を止めない。ただし計測できなかったことを偽の0件として
 * 記録・返却しない（0は「蘇生ゼロを確認できた」の意味に限定する）。計測失敗時はnullを返し、
 * 失敗自体はresurrectionMeasurementFailureCountで可視化する。
 */
export async function detectAndRecordResurrection(
  storage: SQLiteStorage,
  memoryPath: string,
): Promise<number | null> {
  try {
    const tombstones = storage.countTombstones();
    await increment(memoryPath, "resurrection_count", tombstones.vectors);
    return tombstones.vectors;
  } catch (error) {
    resurrectionMeasurementFailureCount++;
    console.error("[backfill] 蘇生件数の計測に失敗:", error);
    return null;
  }
}

async function main() {
  const [memoryPath, projectRoot, batchSizeArg] = process.argv.slice(2);

  if (!memoryPath) {
    console.error("[backfill] memoryPath引数がありません");
    process.exit(1);
  }
  if (!projectRoot) {
    console.error("[backfill] projectRoot引数がありません");
    process.exit(1);
  }

  // 蘇生検出（countTombstones()）は純SQL読みでembeddingが不要なため、
  // LocalEmbeddingの可用性チェックより前に実行する（embedding未整備環境でも安全網が働く）。
  const dbPath = join(memoryPath, config.sqliteFile);
  const storage = new SQLiteStorage(dbPath);
  storage.initialize(memoryPath);

  await detectAndRecordResurrection(storage, memoryPath);

  const localEmbedding = new LocalEmbedding(join(memoryPath, config.modelsDir));
  await localEmbedding.initialize();
  if (!localEmbedding.isAvailable()) {
    storage.close();
    process.exit(0);
  }

  // embedding未生成のIDを特定（SQLiteStorage経由）
  const missingIds = storage.getEntriesWithoutEmbedding();

  if (missingIds.length === 0) {
    storage.close();
    process.exit(0);
  }

  // バッチサイズ: 引数指定あり→その値(0=全件)、なし→config
  const requestedBatchSize = batchSizeArg !== undefined ? parseInt(batchSizeArg, 10) : config.backfillBatchSize;
  const batch = requestedBatchSize === 0 ? missingIds : missingIds.slice(0, requestedBatchSize);

  let processed = 0;
  for (const id of batch) {
    try {
      const detail = storage.getDetail({ ids: [id] });
      if (detail.entries.length === 0) {
        continue;
      }
      const entry = detail.entries[0];
      const textToEmbed = entry.title + " " + entry.content;
      const embedding = await localEmbedding.embed(textToEmbed, "passage");
      storage.upsertVector(id, embedding);
      processed++;
      console.error(`[backfill] ${processed}/${batch.length} embedded: ${id}`);
    } catch (error) {
      console.error(`[backfill] ${id} 失敗:`, error);
      // 1件の失敗で全体を止めない、次のエントリに進む
    }
  }

  console.error(`[backfill] 完了: ${processed}/${batch.length}件処理`);
  storage.close();
}

// import 時に main を実行しない（テストから detectAndRecordResurrection を import
// できるように）。bin(symlink) 経由でも起動するよう realpath 比較する isMainModule を使う。
if (isMainModule(import.meta.url)) {
  main().catch(error => {
    console.error("[backfill] fatal:", error);
    process.exit(1);
  });
}
