#!/usr/bin/env node
/**
 * scripts/backup-store.ts
 * 対象ストア（.wasurenagusa ディレクトリ）の全量バックアップを取得する（タスク0.5、R-A1）。
 *
 * 対象: memory.db は better-sqlite3 のオンラインバックアップAPI（Database#backup）で
 * 一貫性のある単一ファイルへスナップショットする（WAL/SHMをそのままコピーしない。
 * backup() 自体が完結したスナップショットを作るため、WAL/SHMの追加コピーはむしろ
 * 世代不整合を招く）。それ以外のファイル（Markdown各種、vectors.json、
 * consolidated-*.json、config.json、last-session-topic.json、owner-profile.md、
 * logs/ 配下全ファイル 等）はそのままコピーする。
 *
 * 除外: models/ ディレクトリ（ローカルembeddingモデルのキャッシュ。プロジェクト固有の
 * 記憶データではなく再ダウンロード可能なため対象外。将来タスク1.13の共有キャッシュ化
 * 対象と一致させる）。memory.db-wal / memory.db-shm / memory.db-journal（上記の理由で
 * 対象外）。
 *
 * バックアップ先には manifest.json（各ファイルの相対パス・sha256・サイズ・memories行数・
 * 生成時刻）を書く。復元側（restore-store.ts）はこのマニフェストで検証してから復元する。
 *
 * Usage: npx ts-node --esm scripts/backup-store.ts --store <memoryPath> --backup <backupDir>
 */

import Database from "better-sqlite3";
import { createHash } from "crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  readFileSync,
  writeFileSync,
  cpSync,
} from "fs";
import { join, relative, basename } from "path";

/** バックアップ対象から除外するディレクトリ名（再ダウンロード可能なキャッシュ） */
export const EXCLUDED_DIR_NAMES = new Set(["models"]);

/** SQLiteの補助ファイル（WAL/SHM/journal）はbackup()が別途スナップショット化するため対象外 */
function isExcludedSqliteAux(name: string): boolean {
  return name.endsWith(".db-wal") || name.endsWith(".db-shm") || name.endsWith(".db-journal");
}

export interface ManifestEntry {
  relativePath: string;
  sha256: string;
  sizeBytes: number;
}

export interface BackupManifest {
  createdAt: string;
  sourceStore: string;
  sqliteFileName: string;
  memoriesCount: number;
  files: ManifestEntry[];
}

export function sha256OfFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function listFilesRecursive(dir: string, baseDir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listFilesRecursive(full, baseDir));
    } else {
      out.push(relative(baseDir, full));
    }
  }
  return out;
}

/**
 * 1ストア（memoryPathディレクトリ）の全量バックアップを取得する。
 * 戻り値のmanifestはbackupDir/manifest.jsonにも書き出される。
 */
export async function backupStore(
  memoryPath: string,
  backupDir: string,
  sqliteFileName = "memory.db",
): Promise<BackupManifest> {
  if (!existsSync(memoryPath)) {
    throw new Error(`バックアップ元ストアが存在しません: ${memoryPath}`);
  }
  mkdirSync(backupDir, { recursive: true });

  // 1. memory.db をオンラインバックアップAPIで一貫スナップショット化
  // 件数カウントは同一のsourceDb接続で行う（バックアップ先ファイルを別途readonlyで
  // 開き直すと、WALモードDBの仕様上-shm/-walが backupDir 内に副作用生成されてしまい、
  // 「SQLite補助ファイルは対象外」という除外方針に違反するため）。
  const sqlitePath = join(memoryPath, sqliteFileName);
  let memoriesCount = 0;
  if (existsSync(sqlitePath)) {
    const sourceDb = new Database(sqlitePath, { readonly: true });
    try {
      const row = sourceDb.prepare("SELECT COUNT(*) as c FROM memories").get() as { c: number };
      memoriesCount = row.c;
      await sourceDb.backup(join(backupDir, sqliteFileName));
    } finally {
      sourceDb.close();
    }
  }

  // 2. その他ファイルをコピー（models/、SQLite補助ファイル、sqliteファイル自体は除外）
  // 除外ディレクトリはトップレベル相対パス一致で判定する（basename一致だと
  // logs/models のような深い階層の同名ディレクトリまで誤って除外してしまうため）。
  cpSync(memoryPath, backupDir, {
    recursive: true,
    filter: (src: string) => {
      const name = basename(src);
      if (name === sqliteFileName) return false; // 上でbackup()済み
      if (isExcludedSqliteAux(name)) return false;
      const relPath = relative(memoryPath, src);
      if (EXCLUDED_DIR_NAMES.has(relPath) && existsSync(src) && statSync(src).isDirectory()) {
        return false;
      }
      return true;
    },
  });

  // 3. マニフェスト生成（backupDir配下の全ファイルが対象。manifest.json自体と、
  // 万一混入したSQLite補助ファイルは対象外＝防御的フィルタ）
  const allFiles = listFilesRecursive(backupDir, backupDir);
  const files: ManifestEntry[] = allFiles
    .filter((f) => f !== "manifest.json" && !isExcludedSqliteAux(basename(f)))
    .map((relativePath) => {
      const full = join(backupDir, relativePath);
      return {
        relativePath,
        sha256: sha256OfFile(full),
        sizeBytes: statSync(full).size,
      };
    });

  const manifest: BackupManifest = {
    createdAt: new Date().toISOString(),
    sourceStore: memoryPath,
    sqliteFileName,
    memoriesCount,
    files,
  };

  writeFileSync(join(backupDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
  return manifest;
}

export function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`--${key} には値が必要です`);
      }
      out[key] = value;
      i++;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const storeArg = args["store"];
  const backupArg = args["backup"];
  if (!storeArg || !backupArg) {
    console.error("Usage: backup-store.ts --store <memoryPath> --backup <backupDir>");
    process.exit(1);
    return;
  }

  const manifest = await backupStore(storeArg, backupArg);
  console.log(`バックアップ完了: ${manifest.files.length}ファイル, memories=${manifest.memoriesCount}件`);
  console.log(`manifest: ${join(backupArg, "manifest.json")}`);
}

// bin(symlink)経由でも起動するようrealpath比較する既存パターンに倣い、
// scripts/配下は直接node実行のみを想定するため単純パス比較で判定する。
if (process.argv[1] && process.argv[1].endsWith("backup-store.ts")) {
  main().catch((error) => {
    console.error("backup-store 失敗:", error);
    process.exit(1);
  });
}
