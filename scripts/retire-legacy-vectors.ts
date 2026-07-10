#!/usr/bin/env node
/**
 * scripts/retire-legacy-vectors.ts
 * タスク1.13: 埋め込みモデルの共有キャッシュ化（②）と旧世代vectors.jsonの廃棄（③）。
 *
 * ② consolidateModelCache: プロジェクトごとに重複する models/ キャッシュ（87MB×7ストア＝
 *    522MB相当の重複、R-B8）を1箇所の共有ディレクトリへ集約する手順。既存ファイルは
 *    上書きしない（何度実行しても壊れない）。src/config.ts の getModelsDir() が
 *    WASURENAGUSA_MODEL_CACHE_DIR を読むため、この関数で共有先へ実体を集約すれば、
 *    以後のモデル読み込みは自動的に共有先を使うようになる（読み込み側の変更は不要）。
 *    元のプロジェクト固有ディレクトリ自体の削除は本スクリプトでは行わない
 *    （他プロジェクトのローカル状態を横断的に変更する行為であり、単一ストアの土台整備という
 *    本タスクの権限範囲を超えるため。Implementation Log参照）。
 *
 * ③ retireLegacyVectors: vectors.json を、バックアップ（scripts/backup-store.ts が生成する
 *    manifest.json）に記録されたチェックサムが現在のファイルと一致することを確認できた
 *    ときだけ、同一ディレクトリ内で退避リネームする（削除は一切行わない。
 *    requirements.md「アーカイブファイル自体は削除せず保持すること」に従う）。
 *
 * Usage:
 *   npx ts-node --esm scripts/retire-legacy-vectors.ts consolidate --source <projectModelsDir> --shared <sharedCacheDir>
 *   npx ts-node --esm scripts/retire-legacy-vectors.ts retire --store <memoryPath> --backup <backupDir>
 */

import { existsSync, mkdirSync, copyFileSync, renameSync, readFileSync } from "fs";
import { join, dirname } from "path";

import { listFilesRecursive, sha256OfFile, parseArgs } from "./backup-store.js";
import type { BackupManifest } from "./backup-store.js";

/** 退避後のvectors.jsonに付けるサフィックス（削除ではなく同一ディレクトリ内でのリネーム） */
export const RETIRED_SUFFIX = ".v1-retired";

const LEGACY_VECTORS_FILE = "vectors.json";

export interface ConsolidateResult {
  copiedFiles: number;
  skippedExisting: number;
  sourceMissing: boolean;
}

/**
 * sourceModelsDir（1プロジェクト固有の埋め込みモデルキャッシュ）配下のファイルを
 * sharedCacheDir（共有先）へコピーする。共有先に既に同名ファイルがあれば上書きしない
 * （何度再実行しても安全＝冪等）。sourceが存在しない場合は「既に共有先のみを使っている」
 * とみなし、何もせずスキップする（エラーにしない）。
 */
export function consolidateModelCache(sourceModelsDir: string, sharedCacheDir: string): ConsolidateResult {
  if (!existsSync(sourceModelsDir)) {
    return { copiedFiles: 0, skippedExisting: 0, sourceMissing: true };
  }
  mkdirSync(sharedCacheDir, { recursive: true });

  const relFiles = listFilesRecursive(sourceModelsDir, sourceModelsDir);
  let copiedFiles = 0;
  let skippedExisting = 0;
  for (const rel of relFiles) {
    const dest = join(sharedCacheDir, rel);
    if (existsSync(dest)) {
      skippedExisting++;
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(sourceModelsDir, rel), dest);
    copiedFiles++;
  }
  return { copiedFiles, skippedExisting, sourceMissing: false };
}

export interface RetireResult {
  retired: boolean;
  reason: string;
  retiredPath?: string;
}

/**
 * memoryPath配下のvectors.jsonを、backupDir/manifest.json（backup-store.tsが生成した
 * バックアップ）に記録されたsha256と現在のファイル内容が一致することを確認できたときだけ、
 * 同一ディレクトリ内で退避リネームする（削除しない）。
 *
 * - vectors.jsonが既に存在しない場合: 退避対象なしとして冪等にスキップする（バックアップの
 *   有無を問わずエラーにしない。二重実行での安全性を優先）。
 * - マニフェストが存在しない／vectors.jsonの記録がない／チェックサム不一致: いずれも
 *   「バックアップ未確認」とみなし、原本には一切手をつけずエラーで中止する（fail-loud）。
 */
export function retireLegacyVectors(memoryPath: string, backupDir: string): RetireResult {
  const liveVectorsPath = join(memoryPath, LEGACY_VECTORS_FILE);
  if (!existsSync(liveVectorsPath)) {
    return { retired: false, reason: "vectors.jsonは既に存在しません（退避対象なし、冪等スキップ）" };
  }

  const manifestPath = join(backupDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `バックアップ未確認のため退避を中止します: マニフェストが存在しません（${manifestPath}）。` +
        `先に scripts/backup-store.ts でバックアップを取得してください。`,
    );
  }
  const manifest: BackupManifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const entry = manifest.files.find((f) => f.relativePath === LEGACY_VECTORS_FILE);
  if (!entry) {
    throw new Error(
      `バックアップ未確認のため退避を中止します: マニフェストにvectors.jsonの記録がありません（${manifestPath}）。`,
    );
  }
  const liveHash = sha256OfFile(liveVectorsPath);
  if (liveHash !== entry.sha256) {
    throw new Error(
      `バックアップ未確認のため退避を中止します: チェックサム不一致（バックアップ=${entry.sha256}, 現在=${liveHash}）。` +
        `バックアップ取得後にvectors.jsonが変更された可能性があります。再度バックアップを取得してください。`,
    );
  }

  const retiredPath = liveVectorsPath + RETIRED_SUFFIX;
  if (existsSync(retiredPath)) {
    throw new Error(`退避先が既に存在します（${retiredPath}）。二重実行の可能性を確認してください。`);
  }
  renameSync(liveVectorsPath, retiredPath);
  return { retired: true, reason: "バックアップとのチェックサム一致を確認し退避完了", retiredPath };
}

async function main() {
  const [subcommand, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (subcommand === "consolidate") {
    const source = args["source"];
    const shared = args["shared"];
    if (!source || !shared) {
      console.error("Usage: retire-legacy-vectors.ts consolidate --source <projectModelsDir> --shared <sharedCacheDir>");
      process.exit(1);
      return;
    }
    const result = consolidateModelCache(source, shared);
    if (result.sourceMissing) {
      console.log(`スキップ: ソースが存在しません（${source}）`);
    } else {
      console.log(`集約完了: コピー=${result.copiedFiles}件, 既存スキップ=${result.skippedExisting}件 → ${shared}`);
    }
    return;
  }

  if (subcommand === "retire") {
    const store = args["store"];
    const backup = args["backup"];
    if (!store || !backup) {
      console.error("Usage: retire-legacy-vectors.ts retire --store <memoryPath> --backup <backupDir>");
      process.exit(1);
      return;
    }
    const result = retireLegacyVectors(store, backup);
    console.log(result.retired ? `退避完了: ${result.retiredPath}` : `スキップ: ${result.reason}`);
    return;
  }

  console.error("Usage: retire-legacy-vectors.ts <consolidate|retire> ...（引数の詳細は各サブコマンドのUsageを参照）");
  process.exit(1);
}

// scripts/配下は直接node/ts-node実行のみを想定するため、既存パターン（backup-store.ts）に
// 倣い単純パス比較で判定する。
if (process.argv[1] && process.argv[1].endsWith("retire-legacy-vectors.ts")) {
  main().catch((error) => {
    console.error("retire-legacy-vectors 失敗:", error);
    process.exit(1);
  });
}
