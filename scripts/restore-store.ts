#!/usr/bin/env node
/**
 * scripts/restore-store.ts
 * backup-store.ts が作った manifest.json つきバックアップから、対象ストア
 * （.wasurenagusa ディレクトリ）へ検証つきで復元する（タスク0.5、R-A1）。
 *
 * 検証（fail-loud）: manifest.json 記載の全ファイルについて、実ファイルの存在と
 * sha256一致を復元前に確認する。1件でも欠落・不一致ならエラーで停止し、復元処理は
 * 一切実行しない（破損バックアップからの黙った復元を防ぐ）。
 *
 * 復元後は memory.db のチェックサム一致と memories 行数一致（マニフェスト記録値との
 * 突合）を確認する復元リハーサルまで行う。
 *
 * Usage: npx ts-node --esm scripts/restore-store.ts --backup <backupDir> --target <memoryPath>
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, copyFileSync, rmSync } from "fs";
import { join, dirname } from "path";

import { sha256OfFile, parseArgs } from "./backup-store.js";
import type { BackupManifest } from "./backup-store.js";

export interface RestoreResult {
  restoredFiles: number;
  memoriesCount: number;
}

/**
 * backupDir（manifest.json + 各ファイル）を検証してから targetPath へ復元する。
 * 検証失敗時は例外を投げる（fail-loud）。復元先に既存ファイルがあれば上書きする。
 */
export async function restoreStore(
  backupDir: string,
  targetPath: string,
): Promise<RestoreResult> {
  const manifestPath = join(backupDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`マニフェストが存在しません: ${manifestPath}`);
  }
  const manifest: BackupManifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

  // 1. 検証: マニフェスト記載の全ファイルのsha256が一致すること（fail-loud）
  for (const entry of manifest.files) {
    const full = join(backupDir, entry.relativePath);
    if (!existsSync(full)) {
      throw new Error(`バックアップ検証失敗: ファイルが存在しません: ${entry.relativePath}`);
    }
    const actualHash = sha256OfFile(full);
    if (actualHash !== entry.sha256) {
      throw new Error(
        `バックアップ検証失敗: チェックサム不一致 ${entry.relativePath}（期待=${entry.sha256}, 実際=${actualHash}）`,
      );
    }
  }

  // 2. 復元: マニフェスト記載の全ファイルをtargetPathへコピー
  // （sqliteファイル自体は下記の専用処理でWAL/SHM整理とセットで復元するため、
  // ここでは二重コピーを避けてスキップする）
  mkdirSync(targetPath, { recursive: true });
  for (const entry of manifest.files) {
    if (entry.relativePath === manifest.sqliteFileName) continue;
    const src = join(backupDir, entry.relativePath);
    const dest = join(targetPath, entry.relativePath);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  }

  // memory.db 本体を復元。復元先に旧世代のWAL/SHMが残っていると新しいdbファイルと
  // 世代不整合を起こすため、コピー前に削除する。
  const targetSqlitePath = join(targetPath, manifest.sqliteFileName);
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const auxPath = targetSqlitePath + suffix;
    if (existsSync(auxPath)) rmSync(auxPath);
  }
  const backedUpSqlitePath = join(backupDir, manifest.sqliteFileName);
  copyFileSync(backedUpSqlitePath, targetSqlitePath);

  // 3. 復元リハーサル検証: チェックサムとmemories件数が一致すること
  // （バックアップ側のsha256はstep1の検証で実ファイルと一致済みのmanifestエントリを再利用し、
  // 大きくなりうるsqliteファイルの二重ハッシュ計算を避ける）
  const backedUpEntry = manifest.files.find((f) => f.relativePath === manifest.sqliteFileName);
  if (!backedUpEntry) {
    throw new Error(`マニフェストにsqliteファイルのエントリがありません: ${manifest.sqliteFileName}`);
  }
  const restoredHash = sha256OfFile(targetSqlitePath);
  if (restoredHash !== backedUpEntry.sha256) {
    throw new Error("復元リハーサル失敗: memory.dbのチェックサムが一致しません");
  }

  const db = new Database(targetSqlitePath, { readonly: true });
  let memoriesCount: number;
  try {
    const row = db.prepare("SELECT COUNT(*) as c FROM memories").get() as { c: number };
    memoriesCount = row.c;
  } finally {
    db.close();
  }
  if (memoriesCount !== manifest.memoriesCount) {
    throw new Error(
      `復元リハーサル失敗: memories件数が一致しません（バックアップ時=${manifest.memoriesCount}, 復元後=${memoriesCount}）`,
    );
  }

  return { restoredFiles: manifest.files.length, memoriesCount };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const backupArg = args["backup"];
  const targetArg = args["target"];
  if (!backupArg || !targetArg) {
    console.error("Usage: restore-store.ts --backup <backupDir> --target <memoryPath>");
    process.exit(1);
    return;
  }

  const result = await restoreStore(backupArg, targetArg);
  console.log(`復元完了: ${result.restoredFiles}ファイル, memories=${result.memoriesCount}件`);
}

if (process.argv[1] && process.argv[1].endsWith("restore-store.ts")) {
  main().catch((error) => {
    console.error("restore-store 失敗:", error);
    process.exit(1);
  });
}
