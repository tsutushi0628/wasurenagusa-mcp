#!/usr/bin/env node
// tombstone（論理削除済み=deleted_at IS NOT NULL）掃除スクリプト。
//
// 背景: memory_delete は物理削除ではなく softDelete（deleted_at にタイムスタンプを
// 書き込む論理削除）を行う。memory_search からは外れるが memories 行・対応する
// vectors / vector_metadata 行は物理的に残り続け、掃除経路が無いと溜まり続ける。
//
// 既定は dry-run（tombstone件数と対応するvectors/vector_metadataの件数を数えて
// 報告するだけ・DBは書き換えない）。--apply を明示したときのみ実際に物理削除する。
//
// このスクリプトは実データに対して自動実行しない。呼び出し側が対象DBパスを
// 明示し、--apply も明示的に指定したときのみ実データが変更される。
//
// 使い方:
//   node scripts/maintenance/purge-tombstones.mjs <dbPath>          # dry-run（既定）
//   node scripts/maintenance/purge-tombstones.mjs <dbPath> --apply  # 実削除

import { existsSync } from "fs";
import { SQLiteStorage } from "../../dist/storage/sqlite.js";

function parseArgs(argv) {
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const apply = argv.includes("--apply");
  const dbPath = positional[0];
  return { dbPath, apply };
}

function formatCounts(label, counts) {
  return `[purge-tombstones] ${label} - memories: ${counts.memories}件 / vectors: ${counts.vectors}件 / vector_metadata: ${counts.vectorMetadata}件`;
}

function main() {
  const { dbPath, apply } = parseArgs(process.argv.slice(2));

  if (!dbPath) {
    console.error("[purge-tombstones] 対象DBパスを引数で指定してください");
    console.error("使い方: node scripts/maintenance/purge-tombstones.mjs <dbPath> [--apply]");
    process.exit(1);
  }
  if (!existsSync(dbPath)) {
    console.error(`[purge-tombstones] DBが見つかりません: ${dbPath}`);
    process.exit(1);
  }

  const storage = new SQLiteStorage(dbPath);
  storage.initialize();

  console.log(`[purge-tombstones] 対象DB: ${dbPath}`);
  console.log(`[purge-tombstones] モード: ${apply ? "APPLY（物理削除を実行する）" : "DRY-RUN（数えるだけ・DBは書き換えない）"}`);

  const before = storage.countTombstones();
  console.log(formatCounts("削除対象（適用前）", before));

  if (!apply) {
    console.log("[purge-tombstones] dry-runのためDBは書き換えていません。実削除するには --apply を指定してください。");
    storage.close();
    return;
  }

  const deleted = storage.purgeTombstones();
  console.log(
    `[purge-tombstones] 削除実行 - memories: ${deleted.deletedMemories}件 / vectors: ${deleted.deletedVectors}件 / vector_metadata: ${deleted.deletedVectorMetadata}件`
  );

  const after = storage.countTombstones();
  console.log(formatCounts("残存tombstone（適用後）", after));

  storage.close();
}

main();
