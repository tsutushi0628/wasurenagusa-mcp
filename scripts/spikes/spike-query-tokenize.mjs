#!/usr/bin/env node
/**
 * spike-query-tokenize: クエリ側トークナイズ変更のゼロヒット率 再計測（タスク1.2）
 *
 * 実装注記: tasks.mdの原文ファイル名は scripts/spikes/spike-query-tokenize.ts（.ts）だが、
 * 検証対象が本番の現行実装（src/storage/sqlite.ts の escapeFtsQuery/tokenizeForFts）そのもので
 * あるため、再実装による乖離を避けてビルド済み dist/ を直接importする（タスク1.6/1.9と同じ
 * 判断＝忠実性を優先し .mjs 実装へ変更。scripts/maintenance/配下の既存パターンを踏襲）。
 *
 * 目的: クエリ側のフレーズ固定（旧escapeFtsQuery）をtrigram整合（現行のtokenizeForFts分割＋
 * OR結合）へ変えたことの効果を、変更対象（クエリ側トークナイズ）だけに絞って再計測する。
 * 「旧」は commit 89e5813 の直前（89e5813~1）の実装 `"${query.replace(/"/g,'""')}"` を
 * git show で確認した正確な文字列（想像で再現していない）。「新」は現行の dist/ を実行時に
 * importして使う（本物の現行関数。再実装の乖離リスクなし）。
 *
 * クエリ集合: 凍結スナップショット（~/.wasurenagusa/eval/snapshots/2026-07-07/firebase-kit/
 * .wasurenagusa/logs/operation-*.jsonl）に記録された実ログの operation_type="search" の
 * query フィールドをそのまま使う（架空のクエリを作らない）。件数のみを出力し、クエリ本文は
 * 標準出力に一切出さない。
 *
 * 測定方法: FTS5への影響を直接見るため、m.state='active' と結合したFTSマッチ件数
 * （memories_fts MATCH ?）を新旧それぞれのエスケープ結果で実行し、0件になった数を数える。
 * 検証対象はFTSの検索テキスト構造の生成のみで、本番ストアへは一切書き込まない
 * （スナップショットのコピーに対してのみ読み取りを行う）。
 *
 * Usage: node scripts/spikes/spike-query-tokenize.mjs
 */

import Database from "better-sqlite3";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, copyFileSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

import { escapeFtsQuery as newEscapeFtsQuery } from "../../dist/storage/sqlite.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");

const SNAPSHOT_DIR = join(
  process.env.HOME,
  ".wasurenagusa/eval/snapshots/2026-07-07/firebase-kit/.wasurenagusa",
);

// commit 89e5813~1 の実装そのもの（git show で確認済み。再現ではなく引用）
function oldEscapeFtsQuery(query) {
  return `"${query.replace(/"/g, '""')}"`;
}

function collectRealQueries(snapshotDir) {
  const logsDir = join(snapshotDir, "logs");
  const files = readdirSync(logsDir).filter((f) => f.startsWith("operation-") && f.endsWith(".jsonl"));
  const queries = [];
  for (const file of files) {
    const lines = readFileSync(join(logsDir, file), "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // 壊れた行はスキップ（本スパイクの主目的外。件数として記録するのみ）
      }
      if (entry.operation_type === "search" && typeof entry.query === "string" && entry.query.length > 0) {
        queries.push(entry.query);
      }
    }
  }
  return queries;
}

// 凍結スナップショット（2026-07-07/08採取）はスキーマv5時点（state列導入=タスク1.4は
// 本セッションでの後続作業）のため、可視性条件は state 列ではなく deleted_at で判定する
// （タスク1.5で確認済みのとおり、state='active' は deleted_at IS NULL と1:1で同義）。
function countFtsHits(db, matchExpr) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM memories m
       INNER JOIN memories_fts fts ON m.rowid = fts.rowid
       WHERE memories_fts MATCH ? AND m.deleted_at IS NULL`,
    )
    .get(matchExpr);
  return row.cnt;
}

function main() {
  if (!existsSync(SNAPSHOT_DIR)) {
    throw new Error(`凍結スナップショットが見つかりません: ${SNAPSHOT_DIR}`);
  }

  const queries = collectRealQueries(SNAPSHOT_DIR);
  console.log(`実ログから収集したクエリ件数: ${queries.length}件（operation_type="search"の全出現、重複除去なし）`);

  // スナップショットDBを使い捨てコピーへ複製してから開く（原本には触れない）
  const tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-spike-query-tokenize-"));
  const dbCopyPath = join(tmpDir, "memory.db");
  copyFileSync(join(SNAPSHOT_DIR, "memory.db"), dbCopyPath);

  let db;
  try {
    db = new Database(dbCopyPath, { readonly: false });
    db.pragma("journal_mode = WAL");

    let oldZeroHits = 0;
    let newZeroHits = 0;
    let oldErrors = 0;
    let newErrors = 0;

    for (const query of queries) {
      try {
        const oldMatch = oldEscapeFtsQuery(query);
        if (countFtsHits(db, oldMatch) === 0) oldZeroHits++;
      } catch {
        oldErrors++; // 旧実装はクエリによって不正なFTS構文でSQLエラーになる場合がある(既知の脆さ)
      }

      try {
        const newMatch = newEscapeFtsQuery(query);
        if (countFtsHits(db, newMatch) === 0) newZeroHits++;
      } catch {
        newErrors++;
      }
    }

    const total = queries.length;
    const oldRate = total > 0 ? ((oldZeroHits + oldErrors) / total) * 100 : 0;
    const newRate = total > 0 ? ((newZeroHits + newErrors) / total) * 100 : 0;

    console.log("\n=== spike-query-tokenize 実行結果（クエリ本文は非表示） ===");
    console.log(`対象クエリ総数: ${total}`);
    console.log(`[旧: フレーズ固定] ゼロヒット=${oldZeroHits}件, SQL構文エラー=${oldErrors}件, ゼロヒット率(エラー含む)=${oldRate.toFixed(1)}%`);
    console.log(`[新: trigram整合(OR結合)] ゼロヒット=${newZeroHits}件, SQL構文エラー=${newErrors}件, ゼロヒット率(エラー含む)=${newRate.toFixed(1)}%`);
    console.log(`\n判断: ${oldRate > newRate ? "クエリ側トークナイズ変更のみでゼロヒット率が改善している" : "クエリ側トークナイズ変更単独では改善が確認できない（他要因の寄与を疑う）"}（差=${(oldRate - newRate).toFixed(1)}pt）`);
  } finally {
    if (db) db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main();
