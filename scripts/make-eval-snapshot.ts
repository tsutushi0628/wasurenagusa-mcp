#!/usr/bin/env node
/**
 * scripts/make-eval-snapshot.ts
 * 実ストアから評価用スナップショットを作る（design.md「実データスナップショット」、タスク0.11）。
 *
 * scripts/backup-store.ts のオンラインバックアップ手法をそのまま再利用して実DBをコピーし、
 * 既存のredact処理（src/utils/redact-sensitive-data.ts の redactSensitive。dream-worker.ts
 * が外部LLM送信前のサニタイズに使うのと同じ関数）で秘密値パターンのみをマスクする。
 * 日本語本文の統計的性質は保持する（本文まるごと消さない。マスク対象は秘密値パターンのみ）。
 *
 * 出力先: `--out` 省略時は環境変数 `WASURENAGUSA_EVAL_DIR` 配下の `snapshots/<JST日付>/`。
 * `WASURENAGUSA_EVAL_DIR` はリポジトリ外のローカルデータ領域（Git管理外）を指す前提のため、
 * `--out` も未指定なら fail-fast で停止する（既定値でリポジトリ内へ実データを書かせないため）。
 *
 * 用途: タスク0.12がG0（および以降のG1〜G4）を実データに対して実行する際の入力を作る。
 * ゲート自体は本スナップショットのみを検査対象にし、原本（本番ストア）には一切触れない。
 *
 * Usage:
 *   node --experimental-specifier-resolution=node --loader ts-node/esm \
 *     scripts/make-eval-snapshot.ts --store <memoryPath> [--out <dir>]
 */

import Database from "better-sqlite3";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { join } from "path";

import { backupStore, sha256OfFile, listFilesRecursive, parseArgs } from "./backup-store.js";
import { redactSensitive } from "../src/utils/redact-sensitive-data.js";
import { generateJstDatePart } from "../src/utils/operation-logger.js";

/**
 * バックアップ後にredact対象とするテキスト資産ファイル（存在すれば処理、なければスキップ）。
 * v1資産（Markdown）と統合キャッシュ・オーナープロファイルは、過去の会話由来の秘密値
 * （APIキー・絶対パス・メール等）がそのまま転記されている可能性があるため対象に含める。
 */
const TEXT_ASSET_FILES = [
  "config.md",
  "dont.md",
  "decisions.md",
  "snippets.md",
  "config-archive.md",
  "dont-archive.md",
  "decisions-archive.md",
  "snippets-archive.md",
  "consolidated-dont.json",
  "consolidated-config.json",
  "consolidated-dont-summary.md",
  "owner-profile.md",
  "last-session-topic.json",
] as const;

// sha256OfFile / listFilesRecursive / parseArgs は scripts/backup-store.ts のexportを再利用する。

/**
 * memories テーブルの自由記述列の全網羅リスト（セキュリティレビュー指摘2026-07-08対応）。
 * スキーマ（src/storage/schema.ts の memories DDL）の全TEXT列から、識別子・機械値
 * （id、timestamp、category=CHECK制約の列挙値、created_at/updated_at/deleted_at=日時、
 * project=帰属結合キーの識別子。実測で秘密値パターン該当0件を確認済み）を除いた全列。
 * tags/predicted_factors/actual_factors はJSON文字列だが、redactSensitiveの各パターンは
 * 引用符を跨いでマッチしないためJSON構造は壊れない。
 */
const MEMORIES_FREE_TEXT_COLUMNS = [
  "title",
  "content",
  "tags",
  "scope",
  "knowledge_gap",
  "positive_action",
  "scenario",
  "why_core",
  "predicted_factors",
  "actual_factors",
  "prediction_delta",
] as const;

/**
 * コピー済み memory.db（スナップショット側。原本ではない）の自由記述テキストから
 * 秘密値パターンを redactSensitive() でマスクして書き戻す。戻り値は書き換えた行数。
 *
 * 対象は memories の全自由記述列（MEMORIES_FREE_TEXT_COLUMNS）に加え、同一DB内で
 * 自由記述テキストを持つ他テーブル（stash の content/summary/file_path、
 * session_topics の topic、themes の name、consolidated の data=統合結果JSON）。
 * 同型パターン（自由記述列のredact漏れ）を同一修正で根治する。
 */
export function redactMemoriesInPlace(dbPath: string): number {
  const db = new Database(dbPath);
  let changed = 0;

  /** 1テーブルの指定テキスト列を行単位でredactする（PK列で行を特定して書き戻す） */
  const redactTableColumns = (table: string, pkColumn: string, columns: readonly string[]): void => {
    const selectSql = `SELECT ${pkColumn}, ${columns.join(", ")} FROM ${table}`;
    const rows = db.prepare(selectSql).all() as Record<string, string | null>[];
    const updateSql = `UPDATE ${table} SET ${columns.map((c) => `${c} = ?`).join(", ")} WHERE ${pkColumn} = ?`;
    const update = db.prepare(updateSql);
    for (const row of rows) {
      let rowChanged = false;
      const newValues: (string | null)[] = columns.map((column) => {
        const value = row[column];
        if (value === null || value === undefined) return value ?? null;
        const redacted = redactSensitive(value);
        if (redacted !== value) rowChanged = true;
        return redacted;
      });
      if (rowChanged) {
        update.run(...newValues, row[pkColumn]);
        changed++;
      }
    }
  };

  try {
    redactTableColumns("memories", "id", MEMORIES_FREE_TEXT_COLUMNS);
    redactTableColumns("stash", "id", ["content", "summary", "file_path"]);
    redactTableColumns("session_topics", "project", ["topic"]);
    redactTableColumns("consolidated", "type", ["data"]);

    // themes.name はPRIMARY KEYのため、UPDATEだと複数テーマが同一の[REDACTED]値へ
    // 衝突しうる。該当行を削除してからredact済み名をINSERT OR IGNOREで入れ直す。
    const themeRows = db.prepare("SELECT name FROM themes").all() as { name: string }[];
    for (const row of themeRows) {
      const redacted = redactSensitive(row.name);
      if (redacted !== row.name) {
        db.prepare("DELETE FROM themes WHERE name = ?").run(row.name);
        db.prepare("INSERT OR IGNORE INTO themes (name) VALUES (?)").run(redacted);
        changed++;
      }
    }
  } finally {
    db.close();
  }
  return changed;
}

/**
 * v1資産（アーカイブ含む）・統合キャッシュ等のテキストファイル本文から秘密値パターンを
 * マスクする（スナップショット側のファイルのみを書き換える。原本には触れない）。
 * logs/ 配下のJSONLログも対象に含める（operation-*.jsonl のクエリ本文・counters等に
 * 過去会話由来の秘密値が混入しうるため。redactSensitiveのパターンは引用符を跨がないため
 * JSON構造は壊れない）。
 * 戻り値は実際に書き換えたファイル名（logs/相対パス含む）一覧。
 */
export function redactTextAssetFiles(snapshotDir: string): string[] {
  const redactedFiles: string[] = [];

  const redactOneFile = (path: string, label: string): void => {
    if (!existsSync(path)) return;
    const raw = readFileSync(path, "utf-8");
    const redacted = redactSensitive(raw);
    if (redacted !== raw) {
      writeFileSync(path, redacted, "utf-8");
      redactedFiles.push(label);
    }
  };

  for (const file of TEXT_ASSET_FILES) {
    redactOneFile(join(snapshotDir, file), file);
  }

  const logsDir = join(snapshotDir, "logs");
  if (existsSync(logsDir) && statSync(logsDir).isDirectory()) {
    for (const name of readdirSync(logsDir)) {
      if (!name.endsWith(".jsonl")) continue;
      redactOneFile(join(logsDir, name), join("logs", name));
    }
  }

  return redactedFiles;
}

/**
 * redact後のスナップショット最終状態から manifest.json を再計算する。
 * backupStore() が最初に書くmanifest.jsonは redact 前の内容で計算されているため、
 * redact後にチェックサムが変わったファイル（memory.db等）分だけ古くなる。
 * 全体を作り直す方が部分更新より単純で取りこぼしがない。
 */
export function regenerateManifest(snapshotDir: string, sourceStore: string, sqliteFileName: string): void {
  const isExcludedSqliteAux = (name: string): boolean =>
    name.endsWith(".db-wal") || name.endsWith(".db-shm") || name.endsWith(".db-journal");

  const allFiles = listFilesRecursive(snapshotDir, snapshotDir).filter(
    (f) => f !== "manifest.json" && !isExcludedSqliteAux(f),
  );

  const db = new Database(join(snapshotDir, sqliteFileName), { readonly: true });
  let memoriesCount = 0;
  try {
    memoriesCount = (db.prepare("SELECT COUNT(*) as c FROM memories").get() as { c: number }).c;
  } finally {
    db.close();
  }

  const files = allFiles.map((relativePath) => {
    const full = join(snapshotDir, relativePath);
    return { relativePath, sha256: sha256OfFile(full), sizeBytes: statSync(full).size };
  });

  const manifest = {
    createdAt: new Date().toISOString(),
    sourceStore,
    sqliteFileName,
    memoriesCount,
    redacted: true,
    files,
  };

  writeFileSync(join(snapshotDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
}

// JST日付はsrc/utils/operation-logger.tsのgenerateJstDatePartを再利用する。

export interface MakeEvalSnapshotResult {
  snapshotDir: string;
  memoriesRedactedCount: number;
  filesRedactedCount: number;
  manifestFilesCount: number;
}

/**
 * 実ストア（memoryPath）から評価用スナップショットを outDir へ作る。
 * outDir の解決（WASURENAGUSA_EVAL_DIR の読み取りとfail-fast判定）は呼び出し側（main）が行う。
 */
export async function makeEvalSnapshot(
  memoryPath: string,
  outDir: string,
  sqliteFileName = "memory.db",
): Promise<MakeEvalSnapshotResult> {
  const manifest = await backupStore(memoryPath, outDir, sqliteFileName);

  const memoriesRedactedCount = redactMemoriesInPlace(join(outDir, sqliteFileName));
  const redactedFiles = redactTextAssetFiles(outDir);
  regenerateManifest(outDir, memoryPath, sqliteFileName);

  return {
    snapshotDir: outDir,
    memoriesRedactedCount,
    filesRedactedCount: redactedFiles.length,
    manifestFilesCount: manifest.files.length,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const storeArg = args["store"];
  if (!storeArg) {
    console.error("Usage: make-eval-snapshot.ts --store <memoryPath> [--out <dir>]");
    process.exit(1);
    return;
  }

  let outDir = args["out"];
  if (!outDir) {
    const evalDir = process.env.WASURENAGUSA_EVAL_DIR;
    if (!evalDir) {
      console.error(
        "WASURENAGUSA_EVAL_DIR が未設定です。--out で出力先を明示するか、環境変数を設定してください。" +
          "実データはリポジトリ外のローカルデータ領域に置く方針のため、既定値でリポジトリ内へは書き込みません。",
      );
      process.exit(1);
      return;
    }
    outDir = join(evalDir, "snapshots", generateJstDatePart());
  }

  const result = await makeEvalSnapshot(storeArg, outDir);
  console.log(`スナップショット作成完了: ${result.snapshotDir}`);
  console.log(`memories redact: ${result.memoriesRedactedCount}件書き換え`);
  console.log(`テキスト資産redact: ${result.filesRedactedCount}ファイル書き換え`);
  console.log(`manifest収録ファイル数: ${result.manifestFilesCount}`);
}

if (process.argv[1] && process.argv[1].endsWith("make-eval-snapshot.ts")) {
  main().catch((error) => {
    console.error("make-eval-snapshot 失敗:", error);
    process.exit(1);
  });
}
