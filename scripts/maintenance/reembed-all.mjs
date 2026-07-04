#!/usr/bin/env node
// 全ストア再埋め込みスクリプト。
// ローカル埋め込みモデルを Xenova/all-MiniLM-L6-v2（英語向け）から
// Xenova/multilingual-e5-small（多言語・同384次元）へ差し替えたことに伴い、
// 既存の vectors 行を新モデルのベクトルで丸ごと置き換える。
//
// 背景: モデルを差し替えると旧モデルのベクトル空間と新モデルのベクトル空間は別物になり、
// 同一DB内に新旧が混在すると距離比較（検索・重複クラスタリング）が意味を成さない。
// このスクリプトは「生存エントリ（deleted_at IS NULL）全件」を新モデル（e5系の非対称
// プレフィックスのうち文書側 "passage: "）で再埋め込みし、対応する vectors 行を置き換える。
//
// 冪等性による安全設計: モデル版数を記録する専用列はスキーマに追加していない
// （スキーマ変更を最小に留める判断。本タスクの制約でスキーマ・migrationは対象外のため）。
// 代わりに --apply は常に「対象の生存エントリ全件」を無条件に再処理する（差分スキップを
// しない）。そのため実行が途中で失敗しても、再実行すれば対象全件が新モデルのベクトルで
// 上書きされて完了する構造になっており、新旧混在のまま放置される状態が原理的に発生しない。
// 実行後は対象ID全件にベクトルが存在するかを数え直す完了検証を行い、一致しなければ
// 非ゼロで終了する（沈黙成功を出さない）。
//
// このスクリプトは実データへの --apply を自動実行しない。呼び出し側が対象DBパスと
// --apply を明示したときのみ実データが書き換わる。
//
// 使い方:
//   node scripts/maintenance/reembed-all.mjs <dbPath>                     # dry-run（既定・件数報告のみ、DBは書き換えない）
//   node scripts/maintenance/reembed-all.mjs <dbPath> --apply             # 生存エントリ全件を新モデルで再埋め込み
//   node scripts/maintenance/reembed-all.mjs <dbPath> --apply --limit 20  # 先頭20件（id昇順）だけに絞って試す
//   node scripts/maintenance/reembed-all.mjs <dbPath> --models-dir <path> # モデルキャッシュ先を明示指定（既定: dbPathと同じディレクトリ配下のmodels/）
//   node scripts/maintenance/reembed-all.mjs <dbPath> --batch-size 16     # embedBatchの一括件数を変更（既定32）

import { existsSync } from "fs";
import { dirname, join } from "path";
import Database from "better-sqlite3";
import { SQLiteStorage } from "../../dist/storage/sqlite.js";
import { LocalEmbedding, EMBEDDING_DIMENSIONS } from "../../dist/vector/local-embedding.js";

const DEFAULT_BATCH_SIZE = 32;
const VALUE_FLAGS = new Set(["limit", "models-dir", "batch-size"]);

function parseArgs(argv) {
  const positional = [];
  const flags = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") {
      flags.apply = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (!VALUE_FLAGS.has(key)) {
        console.error(`[reembed-all] 未知のオプション: ${arg}`);
        process.exit(1);
      }
      flags[key] = argv[i + 1];
      i++;
      continue;
    }
    positional.push(arg);
  }

  return {
    dbPath: positional[0],
    apply: flags.apply === true,
    limit: flags.limit !== undefined ? parseInt(flags.limit, 10) : undefined,
    modelsDir: flags["models-dir"],
    batchSize: flags["batch-size"] !== undefined ? parseInt(flags["batch-size"], 10) : DEFAULT_BATCH_SIZE,
  };
}

function log(message) {
  process.stderr.write(`[reembed-all] ${message}\n`);
}

// 生存エントリ（id/title/content）を読み取り専用接続で取得する（書き込み用接続とは分離する）。
function readAliveEntries(dbPath) {
  const readDb = new Database(dbPath, { readonly: true });
  const rows = readDb
    .prepare("SELECT id, title, content FROM memories WHERE deleted_at IS NULL ORDER BY id")
    .all();
  readDb.close();
  return rows;
}

// 対象ID群のうち、実際に新次元のベクトルを持つ件数を数える（完了検証専用）。
// vectors は vec0 仮想テーブルのため、拡張未ロードの生接続からは読めない
// （sqlite-vec のロードは SQLiteStorage.initialize() が内部で行う）。よって
// 素の better-sqlite3 接続で直接 SELECT せず、SQLiteStorage の公開API
// （getEmbedding）経由で1件ずつ検証する。
function countVerifiedVectors(storage, ids) {
  let count = 0;
  for (const id of ids) {
    const vec = storage.getEmbedding(id);
    if (vec && vec.length === EMBEDDING_DIMENSIONS) {
      count++;
    }
  }
  return count;
}

async function main() {
  const { dbPath, apply, limit, modelsDir: modelsDirArg, batchSize } = parseArgs(process.argv.slice(2));

  if (!dbPath) {
    console.error("[reembed-all] 対象DBパスを引数で指定してください");
    console.error(
      "使い方: node scripts/maintenance/reembed-all.mjs <dbPath> [--apply] [--limit N] [--models-dir PATH] [--batch-size N]"
    );
    process.exit(1);
  }
  if (!existsSync(dbPath)) {
    console.error(`[reembed-all] DBが見つかりません: ${dbPath}`);
    process.exit(1);
  }
  if (limit !== undefined && (Number.isNaN(limit) || limit <= 0)) {
    console.error(`[reembed-all] --limit は正の整数で指定してください: ${limit}`);
    process.exit(1);
  }
  if (Number.isNaN(batchSize) || batchSize <= 0) {
    console.error(`[reembed-all] --batch-size は正の整数で指定してください: ${batchSize}`);
    process.exit(1);
  }

  // モデルキャッシュ先: 明示指定が無ければ本番と同じ配置慣習（memoryPath/memory.db と同階層のmodels/）に揃える
  const modelsDir = modelsDirArg || join(dirname(dbPath), "models");

  log(`対象DB: ${dbPath}`);
  log(`モード: ${apply ? "APPLY（新モデルで全件再埋め込みを実行する）" : "DRY-RUN（件数報告のみ・DBは書き換えない）"}`);
  log(`モデルキャッシュ先: ${modelsDir}`);

  const allAlive = readAliveEntries(dbPath);
  const target = limit !== undefined ? allAlive.slice(0, limit) : allAlive;

  log(`生存エントリ件数: ${allAlive.length}件`);
  log(`再埋め込み対象数: ${target.length}件${limit !== undefined ? `（--limit ${limit} で絞り込み）` : "（全件）"}`);

  if (!apply) {
    log("dry-runのためDBは書き換えていません。実行するには --apply を指定してください。");
    return;
  }

  if (target.length === 0) {
    log("再埋め込み対象が0件のため終了します。");
    return;
  }

  const t0 = Date.now();
  const localEmbedding = new LocalEmbedding(modelsDir);
  await localEmbedding.initialize();
  if (!localEmbedding.isAvailable()) {
    throw new Error("LocalEmbedding初期化に失敗しました（isAvailable=false）");
  }
  log(`モデル初期化完了（${Date.now() - t0}ms）`);

  const storage = new SQLiteStorage(dbPath);
  storage.initialize();

  let processed = 0;
  const processedIds = [];
  const embedStart = Date.now();

  for (let i = 0; i < target.length; i += batchSize) {
    const batch = target.slice(i, i + batchSize);
    const texts = batch.map((row) => row.title + " " + row.content);
    const embeddings = await localEmbedding.embedBatch(texts, "passage");

    for (let j = 0; j < batch.length; j++) {
      const embedding = embeddings[j];
      if (embedding.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(
          `次元不一致: id=${batch[j].id} expected=${EMBEDDING_DIMENSIONS} actual=${embedding.length}`
        );
      }
      storage.upsertVector(batch[j].id, embedding);
      processedIds.push(batch[j].id);
      processed++;
    }

    log(`進捗: ${processed}/${target.length}`);
  }

  const embedMs = Date.now() - embedStart;

  // 完了検証: 対象ID全件に新次元のベクトルが存在するか数え直す（新旧混在のまま終わっていないかの最終確認）。
  // storage をまだ閉じる前に、同じ接続（vec0ロード済み）で検証する。
  const verifiedCount = countVerifiedVectors(storage, processedIds);
  const complete = verifiedCount === target.length;

  storage.close();

  if (!complete) {
    console.error(`[reembed-all] 完了検証NG: 対象${target.length}件のうちベクトル確認できたのは${verifiedCount}件`);
    process.exit(1);
  }

  const summary = {
    dbPath,
    modelsDir,
    aliveEntryCount: allAlive.length,
    targetCount: target.length,
    processed,
    verifiedCount,
    complete,
    embedTotalMs: embedMs,
    embedAvgMsPerEntry: target.length > 0 ? Math.round((embedMs / target.length) * 100) / 100 : 0,
  };

  console.log(JSON.stringify(summary, null, 2));
  log(`完了: ${processed}/${target.length}件を新モデルで再埋め込み・完了検証OK`);
}

main().catch((error) => {
  console.error("[reembed-all] 実行失敗:", error);
  process.exit(1);
});
