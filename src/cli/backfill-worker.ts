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

  const localEmbedding = new LocalEmbedding(join(memoryPath, config.modelsDir));
  await localEmbedding.initialize();
  if (!localEmbedding.isAvailable()) {
    process.exit(0);
  }

  const dbPath = join(memoryPath, config.sqliteFile);
  const storage = new SQLiteStorage(dbPath);
  storage.initialize(memoryPath);

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

main().catch(error => {
  console.error("[backfill] fatal:", error);
  process.exit(1);
});
