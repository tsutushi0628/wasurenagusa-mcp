#!/usr/bin/env node
// 自己検索率（self-retrieval）測定ハーネス。
//
// 目的: 「あるエントリのタイトルをそのままクエリにしたとき、そのエントリ自身が
// 検索結果の何位に出るか」を実データのコピーDBで測り、記憶検索の空振り率
// （zero_or_miss率）・上位1件率（self_top1率）・上位5件率（self_top5率）を
// 決定的（乱数・Date.now不使用）に算出する。改修前後の比較用ベースラインを取る。
//
// 対象DBは実データのコピーのみ（原本は一切書き換えない）。実行するたびに
// 同じ結果になるよう、サンプリング・順序は完全に決定的な手順で行う。
//
// 使い方:
//   node scripts/eval/self-retrieval.mjs [dbPath]
//   dbPath省略時は下記 DEFAULT_DB_PATH（実データのコピー専用ディレクトリ）を使う。

import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { existsSync } from "fs";
import { SQLiteStorage } from "../../dist/storage/sqlite.js";
import { LocalEmbedding } from "../../dist/vector/local-embedding.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");

// 実データの原本は一切書き換えない。測定は下記コピーDBに対してのみ行う。
const DEFAULT_DB_PATH =
  "/private/tmp/claude-502/-Users-s-tsukamoto-projects-firebase-kit/05b4cbb4-7aba-4a66-aafc-90a8cb669941/scratchpad/search-eval/memory.db";

// ローカル埋め込みモデルは新規ダウンロードせず、既に本プロジェクトにキャッシュ済みの
// モデル（Xenova/all-MiniLM-L6-v2）を読み取り専用で再利用する（オフラインで再現可能にする）。
const MODELS_DIR = join(PROJECT_ROOT, ".wasurenagusa", "models");

const SAMPLE_TARGET = 150; // 生存エントリから決定的に抽出するサンプル件数
const PROBE_LIMIT = 20;    // self_top1/self_top5/zero_or_missを精密判定するため、既定limit(5)より広く上位N件を見る
const TOP5_THRESHOLD = 5;

async function main() {
  const dbPath = process.argv[2] || DEFAULT_DB_PATH;
  if (!existsSync(dbPath)) {
    throw new Error(`DB not found: ${dbPath}`);
  }

  console.error(`[self-retrieval] DB: ${dbPath}`);

  const storage = new SQLiteStorage(dbPath);
  storage.initialize();

  // 埋め込みが使えるか確認する（使えるならsearchHybrid経路、使えないならsearch経路で統一して測る）
  const localEmbedding = new LocalEmbedding(MODELS_DIR);
  let embeddingAvailable = false;
  try {
    await localEmbedding.initialize();
    embeddingAvailable = localEmbedding.isAvailable();
  } catch (error) {
    console.error("[self-retrieval] LocalEmbedding初期化失敗、search()経路にフォールバック:", error.message);
  }
  console.error(`[self-retrieval] 検索経路: ${embeddingAvailable ? "searchHybrid（FTS5+ベクトル）" : "search（FTS5単独）"}`);

  // 生存エントリを全件取得し、IDの昇順に並べ替える（決定的な順序にする）。
  // storage.search()の公開APIをそのまま使う（読み取り専用ロジックに新規の書き込みを足さない）。
  const allAlive = storage.search({ query: "", limit: 50000 }).results;
  allAlive.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const total = allAlive.length;
  const sampleSize = Math.min(SAMPLE_TARGET, total);
  // 150件に届くよう間隔を動的に算出する（生存9,685件では単純な「100件ごと」だと約97件しか
  // 取れず150件に届かないため、目標サンプル数を優先して間隔を逆算する）。
  const stride = Math.max(1, Math.floor(total / sampleSize));

  const sample = [];
  for (let i = 0; i < total && sample.length < sampleSize; i += stride) {
    sample.push(allAlive[i]);
  }

  console.error(`[self-retrieval] 生存エントリ総数: ${total}件 / サンプル件数: ${sample.length}件 / 間隔: ${stride}`);

  let zeroOrMissCount = 0;
  let top1Count = 0;
  let top5Count = 0;

  for (const entry of sample) {
    let resultIds;
    if (embeddingAvailable) {
      const queryEmbedding = await localEmbedding.embed(entry.title);
      const result = storage.searchHybrid({ query: entry.title, limit: PROBE_LIMIT }, queryEmbedding);
      resultIds = result.results.map((r) => r.id);
    } else {
      const result = storage.search({ query: entry.title, limit: PROBE_LIMIT });
      resultIds = result.results.map((r) => r.id);
    }

    const rank = resultIds.indexOf(entry.id); // -1 = 見つからない（圏外 or 0件）
    if (rank === -1) {
      zeroOrMissCount += 1;
      continue;
    }
    if (rank === 0) {
      top1Count += 1;
    }
    if (rank < TOP5_THRESHOLD) {
      top5Count += 1;
    }
  }

  storage.close();

  const n = sample.length;
  const zeroOrMissRate = zeroOrMissCount / n;
  const selfTop1Rate = top1Count / n;
  const selfTop5Rate = top5Count / n;

  const summary = {
    dbPath,
    searchPath: embeddingAvailable ? "searchHybrid" : "search",
    sampleSize: n,
    totalAliveEntries: total,
    zeroOrMissCount,
    zeroOrMissRate,
    selfTop1Count: top1Count,
    selfTop1Rate,
    selfTop5Count: top5Count,
    selfTop5Rate,
  };

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error("[self-retrieval] 実行失敗:", error);
  process.exit(1);
});
