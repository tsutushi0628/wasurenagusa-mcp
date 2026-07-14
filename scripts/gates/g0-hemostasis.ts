#!/usr/bin/env node
/**
 * scripts/gates/g0-hemostasis.ts
 * Phase 0（止血）完了ゲート（design.md Phase 0 ③、タスク0.11、R-M1/R-M3/R-A1）。
 *
 * 検証役（qa-engineer）専用資産。実装者は編集しない（design.md「ゲート運用」）。
 *
 * Usage:
 *   node --experimental-specifier-resolution=node --loader ts-node/esm \
 *     scripts/gates/g0-hemostasis.ts --store <memoryPath> --backup <backupDir> [--scheduler-dir <dir>]
 *
 * 実行コマンドについての注記（実機確認済み、2026-07-07）: design.md「ゲート運用」記載の
 * `npx ts-node --esm scripts/gates/<name>.ts` は、本プロジェクトの実行環境（Node v22 +
 * ts-node 10.9.2）では相対import（例: `../restore-store.js` や `../../src/config.js`）を
 * 一切解決できず ERR_MODULE_NOT_FOUND で落ちる（ts-node classic ESMローダーがNode 22の
 * モジュールフックAPIと非互換のため、拡張子解決フォールバックが機能しない。src/内部の
 * 同種の相対import単体でも同じ現象を確認済みで、本ファイル固有の問題ではない）。
 * 上記の `--experimental-specifier-resolution=node --loader ts-node/esm` を明示指定する
 * 起動方法のみが実機で動作する（設定ファイルの変更は不要、起動コマンドの差し替えのみ）。
 * 他フェーズのゲート（G1〜）や `npm run dev` も同一環境では同じ問題を踏む見込みのため、
 * design.md側の記載更新をPdMに提案する。
 *
 * 設計方針:
 * - 前提アサート（DBが開ける、memories総件数1,000件以上、操作ログが存在する）が
 *   1つでも不成立なら、6検査は一切実行せずFAILで終了する（design.md契約どおり）。
 * - 実行可能な検査（v1-blocked、guard-gen-stopped、nightly-dryrun、injection）は
 *   本番と同一の起動経路（dist/cli/*.js、production-path-smoke.mjs と同じ流儀）で行う。
 *   ただし対象は `--store` の実体を一時ディレクトリへコピーしたスクラッチ環境に限定し、
 *   実ストア（本番データ）へは一切書き込まない。
 * - LLMプロバイダのAPIキーはスクラッチ実行中のみ空文字に強制する。ゲートは構造的な
 *   不変条件（書き込み0件・ファイル不変・トークンバジェット遵守）を検証するものであり、
 *   実LLM呼び出しの成否には依存しない・依存させてはいけない（決定論・無料・オフライン実行）。
 * - 各チェックは「収集（I/O・サブプロセス）」と「評価（純粋関数）」を分離する。
 *   評価関数は合成データを直接渡して単体テストできる。
 * - 出力形式: 1検査1行のJSON（check, result, measured, threshold）+ 人間可読サマリ。
 *   記憶本文・クエリ本文は一切出力しない（ファイル名・件数・真偽値・ハッシュのみ）。
 */

import Database from "better-sqlite3";
import { createHash } from "crypto";
import { spawn } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";
import { homedir, tmpdir } from "os";
import { basename, dirname, join, resolve } from "path";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";

import { restoreStore } from "../restore-store.js";
import { sha256OfFile, parseArgs, EXCLUDED_DIR_NAMES } from "../backup-store.js";
import type { BackupManifest } from "../backup-store.js";
import { ActiveProjectsTracker } from "../../src/active-projects.js";
import { getMemoryPath } from "../../src/config.js";
import { extractGuardPrinciples } from "../../src/cli/guard.js";
import type { ConsolidatedDont } from "../../src/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_REPO_ROOT = resolve(__dirname, "..", "..");
const DEFAULT_SCHEDULER_DIR = join(homedir(), ".wasurenagusa", "scheduler");

/** v1（Markdown＋vectors.json）資産のファイル名一覧。存在すればmtime不変を検証する。 */
export const V1_ASSET_FILES = ["config.md", "dont.md", "decisions.md", "snippets.md", "vectors.json"] as const;

// injection検査の旧契約（1KB下限 MIN_INJECTION_BYTES）は廃止した（PdM裁定2026-07-14:
// Phase4の最小注入設計が優先。旧下限は止血期の「空注入・壊れ注入の検知」が目的だったため、
// その目的は evaluateInjection の非空検査＋最小索引の構成要素検査として保存している）。

export interface CheckResult {
  check: string;
  result: "PASS" | "FAIL";
  measured: Record<string, unknown>;
  threshold: Record<string, unknown>;
}

export interface PreconditionResult {
  ok: boolean;
  dbOpens: boolean;
  memoriesCount: number;
  operationLogExists: boolean;
  reason?: string;
}

// ============================================================
// 共通の小さなI/Oユーティリティ
// （sha256OfFile / parseArgs / models除外セットは scripts/backup-store.ts のexportを再利用）
// ============================================================

function countMemories(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare("SELECT COUNT(*) as c FROM memories").get() as { c: number };
    return row.c;
  } finally {
    db.close();
  }
}

function readConsolidatedCacheHash(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare("SELECT type, data, source_entry_count, consolidated_at, version FROM consolidated ORDER BY type")
      .all();
    return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  } finally {
    db.close();
  }
}

function hasOperationLogs(storePath: string): boolean {
  const logsDir = join(storePath, "logs");
  if (!existsSync(logsDir)) return false;
  const files = readdirSync(logsDir);
  return files.some((f) => /^operation-.*\.jsonl$/.test(f));
}

/**
 * スクラッチ用の使い捨てプロジェクトを作る: <tmp>/<projectName>/.git（findProjectRootの
 * マーカー）+ <tmp>/<projectName>/.wasurenagusa（--store の内容をコピー）。
 * projectName は `basename(dirname(storePath))`（--store の実際の親ディレクトリ名）を
 * そのまま踏襲する。memories.project 列はこのプロジェクト名で保存されているため、
 * ランダムな一時ディレクトリ名にすり替えると project フィルタが一致せず、
 * SessionStart/夜間統合が実際には0件しか見つけられない別の状態を検証してしまう
 * （実ストアの実行環境を模す上で重要）。
 * 実行後は必ず cleanupScratchProject で消す。本番ストア（storePath）は一切書き換えない
 * （読み取りコピーのみ）。
 */
interface ScratchProject {
  projectRoot: string;
  memoryPath: string;
}

function createScratchProject(storePath: string): ScratchProject {
  const projectName = basename(dirname(storePath)) || "scratch-project";
  const tmpParent = mkdtempSync(join(tmpdir(), "g0-scratch-"));
  const projectRoot = join(tmpParent, projectName);
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(join(projectRoot, ".git"), "");
  const memoryPath = join(projectRoot, ".wasurenagusa");
  // models/（再ダウンロード可能な埋め込みモデルキャッシュ、数百MB級）はコピーしない
  // （backup-store.tsと同じ除外セットを再利用）。スクラッチ実行はhermetic環境（APIキー空）で
  // 走り、SessionStart・夜間統合dry-runともDB内の既存ベクトルだけを読むためモデル実体は不要
  // （実ストアスナップショット＝models無しでの全検査PASSを2026-07-07に実証済み）。
  cpSync(storePath, memoryPath, {
    recursive: true,
    filter: (src: string) => {
      const name = basename(src);
      if (EXCLUDED_DIR_NAMES.has(name) && existsSync(src) && statSync(src).isDirectory()) {
        return false;
      }
      return true;
    },
  });
  return { projectRoot, memoryPath };
}

function cleanupScratchProject(scratch: ScratchProject): void {
  rmSync(dirname(scratch.projectRoot), { recursive: true, force: true });
}

/** LLMプロバイダのAPIキーを取り除いた環境変数（スクラッチ実行のhermetic化）。 */
function hermeticEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.GEMINI_API_KEY = "";
  env.OPENAI_API_KEY = "";
  env.ANTHROPIC_API_KEY = "";
  delete env.MEMORY_DIR;
  delete env.WASURENAGUSA_INJECTION_TOKEN_BUDGET;
  return env;
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function spawnNodeScript(
  scriptPath: string,
  opts: { cwd: string; stdin?: string; env: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<SpawnResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill();
          reject(new Error(`タイムアウト: ${scriptPath}`));
        }, opts.timeoutMs)
      : undefined;
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ stdout, stderr, exitCode: code });
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
    }
    child.stdin.end();
  });
}

function requireDistFile(repoRoot: string, ...segments: string[]): string {
  const path = join(repoRoot, "dist", ...segments);
  if (!existsSync(path)) {
    throw new Error(`ビルド成果物が見つかりません: ${path}（先に \`npm run build\` を実行してください）`);
  }
  return path;
}

// ============================================================
// 前提アサート
// ============================================================

/**
 * 前提アサート: DBが開ける、memories総件数が1,000件以上、操作ログが存在する。
 * 1つでも不成立ならok=falseを返す（呼び出し側は6検査を実行してはいけない）。
 */
export function assertPreconditions(storePath: string): PreconditionResult {
  const dbPath = join(storePath, "memory.db");
  let dbOpens = false;
  let memoriesCount = 0;
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      dbOpens = true;
      memoriesCount = (db.prepare("SELECT COUNT(*) as c FROM memories").get() as { c: number }).c;
    } finally {
      db.close();
    }
  } catch {
    dbOpens = false;
  }

  const operationLogExists = dbOpens ? hasOperationLogs(storePath) : false;
  const ok = dbOpens && memoriesCount >= 1000 && operationLogExists;

  let reason: string | undefined;
  if (!dbOpens) reason = "DBが開けません";
  else if (memoriesCount < 1000) reason = `memories総件数が1,000件未満（実測${memoriesCount}件）`;
  else if (!operationLogExists) reason = "操作ログ(logs/operation-*.jsonl)が存在しません";

  return { ok, dbOpens, memoriesCount, operationLogExists, reason };
}

// ============================================================
// 検査1: backup-restore
// ============================================================

export interface BackupTarget {
  name: string;
  memoryPath: string;
  backupDir: string;
  isPrimary: boolean;
}

/**
 * 検査対象ストア一覧を解決する。主ストア（--store/--backup）に加え、schedulerDir配下の
 * アクティブプロジェクト一覧（ActiveProjectsTracker、既存資産を再利用）を「他ストア」として
 * 走査対象に加える。他ストアのバックアップ先は、主ストアのバックアップ先の親ディレクトリ
 * 配下に project.name のサブディレクトリがある、という規約（backup-store.tsを複数プロジェクトに
 * 対して運用する際の自然な配置）を前提にする。
 */
export async function discoverBackupTargets(
  primaryStore: string,
  primaryBackup: string,
  schedulerDir: string,
): Promise<BackupTarget[]> {
  const primaryName = basename(dirname(primaryStore)) || basename(primaryStore);
  const targets: BackupTarget[] = [
    { name: primaryName, memoryPath: primaryStore, backupDir: primaryBackup, isPrimary: true },
  ];

  const tracker = new ActiveProjectsTracker(schedulerDir);
  const activeProjects = await tracker.getActiveProjects();
  const backupsParentDir = dirname(primaryBackup);

  for (const project of activeProjects) {
    if (project.name === primaryName) continue;
    targets.push({
      name: project.name,
      memoryPath: getMemoryPath(project.path),
      backupDir: join(backupsParentDir, project.name),
      isPrimary: false,
    });
  }

  return targets;
}

/**
 * バックアップディレクトリ自体の整合性を検証する（manifest.json記載の全ファイルが存在し
 * sha256が一致すること）。読み取り専用・ソースストアには一切アクセスしない。
 */
export function verifyBackupManifestIntegrity(backupDir: string): {
  ok: boolean;
  reason?: string;
  fileCount: number;
} {
  const manifestPath = join(backupDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    return { ok: false, reason: "manifest.jsonが存在しません", fileCount: 0 };
  }

  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    return { ok: false, reason: "manifest.jsonのJSON解析に失敗しました", fileCount: 0 };
  }

  for (const entry of manifest.files) {
    const full = join(backupDir, entry.relativePath);
    if (!existsSync(full)) {
      return { ok: false, reason: `ファイル欠落: ${entry.relativePath}`, fileCount: manifest.files.length };
    }
    if (sha256OfFile(full) !== entry.sha256) {
      return { ok: false, reason: `チェックサム不一致: ${entry.relativePath}`, fileCount: manifest.files.length };
    }
  }

  return { ok: true, fileCount: manifest.files.length };
}

/**
 * backup-restore検査。対象全ストアのバックアップ整合性を確認し、主ストアのみ復元リハーサル
 * （一時ディレクトリへの復元。本番ストアは書き換えない）まで行う。
 */
export async function checkBackupRestore(targets: BackupTarget[]): Promise<CheckResult> {
  const details: { name: string; ok: boolean; reason?: string }[] = [];
  let allValid = true;

  for (const target of targets) {
    const verification = verifyBackupManifestIntegrity(target.backupDir);
    details.push({ name: target.name, ok: verification.ok, reason: verification.reason });
    if (!verification.ok) allValid = false;
  }

  const primary = targets.find((t) => t.isPrimary);
  let rehearsalOk = false;
  let rehearsalReason: string | undefined;

  if (primary) {
    const primaryValid = details.find((d) => d.name === primary.name)?.ok ?? false;
    if (primaryValid) {
      const scratchTarget = mkdtempSync(join(tmpdir(), "g0-rehearsal-"));
      try {
        await restoreStore(primary.backupDir, scratchTarget);
        rehearsalOk = true;
      } catch (error) {
        rehearsalOk = false;
        rehearsalReason = error instanceof Error ? error.message : String(error);
      } finally {
        rmSync(scratchTarget, { recursive: true, force: true });
      }
    } else {
      rehearsalReason = "主ストアのバックアップ自体が無効なため復元リハーサル未実施";
    }
  } else {
    rehearsalReason = "主ストアが対象一覧に存在しません";
  }

  const pass = allValid && rehearsalOk;
  return {
    check: "backup-restore",
    result: pass ? "PASS" : "FAIL",
    measured: {
      storesChecked: targets.length,
      allBackupsValid: allValid,
      primaryRehearsalOk: rehearsalOk,
      details,
      ...(rehearsalReason ? { rehearsalReason } : {}),
    },
    threshold: { allBackupsValid: true, primaryRehearsalOk: true },
  };
}

// ============================================================
// 検査2: v1-blocked ＋ 検査6: injection（SessionStart実行を1回共有）
// ============================================================

export function readV1FileMtimes(memoryPath: string): Record<string, number | null> {
  const result: Record<string, number | null> = {};
  for (const file of V1_ASSET_FILES) {
    const path = join(memoryPath, file);
    result[file] = existsSync(path) ? statSync(path).mtimeMs : null;
  }
  return result;
}

export interface SessionStartRunResult {
  stdoutText: string;
  stdoutBytes: number;
  stdoutTokensEstimate: number;
  budgetTokens: number;
  v1FileMtimesBefore: Record<string, number | null>;
  v1FileMtimesAfter: Record<string, number | null>;
}

/**
 * SessionStart処理（本番と同一の起動経路: dist/cli/context.js）を、`--store` のスクラッチ
 * コピーに対して1回だけ実行する。v1-blocked（mtime不変）とinjection（バイト数・トークン数）
 * の両方の生データをここで収集する。symlink経由の起動を模すため、実ファイルへの
 * シンボリックリンクを作ってそれを実行する（タスク0.10のrealpath修復の回帰検出）。
 */
export async function runSessionStartAgainstScratchCopy(
  storePath: string,
  repoRoot: string,
): Promise<SessionStartRunResult> {
  const distContext = requireDistFile(repoRoot, "cli", "context.js");
  const contextModule = (await import(distContext)) as {
    estimateTokens: (text: string) => number;
    DEFAULT_INJECTION_TOKEN_BUDGET: number;
  };

  const scratch = createScratchProject(storePath);
  const symlinkDir = mkdtempSync(join(tmpdir(), "g0-symlink-"));
  const symlinkPath = join(symlinkDir, "context.js");
  try {
    const { symlinkSync } = await import("fs");
    symlinkSync(distContext, symlinkPath);

    const before = readV1FileMtimes(scratch.memoryPath);

    const hookInput = JSON.stringify({
      session_id: "g0-hemostasis-v1-blocked-injection",
      transcript_path: "/dev/null",
      cwd: scratch.projectRoot,
      hook_event_name: "SessionStart",
    });

    const { stdout } = await spawnNodeScript(symlinkPath, {
      cwd: scratch.projectRoot,
      stdin: hookInput,
      env: hermeticEnv(),
      timeoutMs: 30000,
    });

    const after = readV1FileMtimes(scratch.memoryPath);

    return {
      stdoutText: stdout,
      stdoutBytes: Buffer.byteLength(stdout, "utf-8"),
      stdoutTokensEstimate: contextModule.estimateTokens(stdout),
      budgetTokens: contextModule.DEFAULT_INJECTION_TOKEN_BUDGET,
      v1FileMtimesBefore: before,
      v1FileMtimesAfter: after,
    };
  } finally {
    rmSync(symlinkDir, { recursive: true, force: true });
    cleanupScratchProject(scratch);
  }
}

export function evaluateV1Blocked(
  mtimesBefore: Record<string, number | null>,
  mtimesAfter: Record<string, number | null>,
): CheckResult {
  const keys = Object.keys(mtimesBefore);
  const changedFiles = keys.filter((k) => mtimesBefore[k] !== mtimesAfter[k]);
  return {
    check: "v1-blocked",
    result: changedFiles.length === 0 ? "PASS" : "FAIL",
    measured: { filesChecked: keys.length, changedFiles },
    threshold: { changedFiles: 0 },
  };
}

/**
 * injection検査（新契約・PdM裁定2026-07-14）: 旧契約「1KB以上」はPhase4の最小注入設計
 * （design.md「最小索引」定義）と衝突するため置換した。旧下限の目的（空注入・壊れ注入の検知）
 * は①非空検査で保存し、質の検査は②最小索引の必須構成要素（セクション見出しと
 * 「[カテゴリ] 要旨 (ID)」形式の索引行）の存在確認、③トークンバジェット以下、で行う。
 */
export function evaluateInjection(stdoutText: string, tokensEstimate: number, budgetTokens: number): CheckResult {
  const nonEmpty = stdoutText.trim().length > 0;
  const hasMinimalIndexSection = /### 最小索引/.test(stdoutText);
  const hasIndexLineFormat = /^\[[^\]]+\] .+ \([^()]+\)$/m.test(stdoutText);
  const minimalIndexPresent = hasMinimalIndexSection && hasIndexLineFormat;
  // 「確定原則のみ・索引0件」の正当出力（全記憶が確定原則へ昇華済み等）を PASS にする（rank4）。
  // 確定原則セクション見出しと「- 要旨 (ID)」形式の原則行が揃っていれば、有効な素材が
  // 注入されている証拠として最小索引の代替に足りる。空注入・壊れ注入（「（対象なし）」等で
  // 索引行も原則行も無い出力）は両系統とも不成立となり従来どおり FAIL する。
  const hasPrinciplesSection = /### 確定原則/.test(stdoutText);
  const hasPrincipleLineFormat = /^- .+ \([^()]+\)$/m.test(stdoutText);
  const confirmedPrinciplesPresent = hasPrinciplesSection && hasPrincipleLineFormat;
  const materialPresent = minimalIndexPresent || confirmedPrinciplesPresent;
  const withinBudget = tokensEstimate <= budgetTokens;
  const pass = nonEmpty && materialPresent && withinBudget;
  return {
    check: "injection",
    result: pass ? "PASS" : "FAIL",
    measured: {
      outputBytes: Buffer.byteLength(stdoutText, "utf-8"),
      nonEmpty,
      hasMinimalIndexSection,
      hasIndexLineFormat,
      minimalIndexPresent,
      hasPrinciplesSection,
      hasPrincipleLineFormat,
      confirmedPrinciplesPresent,
      materialPresent,
      tokensEstimate,
      budgetTokens,
    },
    threshold: { nonEmpty: true, materialPresent: true, maxTokens: budgetTokens },
  };
}

// ============================================================
// 検査3: guard-gen-stopped ＋ 検査4: nightly-dryrun（統合実行を1回共有）
// ============================================================

function readGuardFileState(path: string): { count: number; hash: string | null } {
  if (!existsSync(path)) return { count: 0, hash: null };
  const raw = readFileSync(path, "utf-8");
  const hash = createHash("sha256").update(raw).digest("hex");
  let count = 0;
  try {
    const parsed = JSON.parse(raw) as ConsolidatedDont;
    count = extractGuardPrinciples(parsed).length;
  } catch {
    count = 0;
  }
  return { count, hash };
}

function isValidDryRunReport(path: string): boolean {
  try {
    const raw = readFileSync(path, "utf-8");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed = JSON.parse(raw) as any;
    return (
      typeof parsed?.generatedAt === "string" &&
      typeof parsed?.project === "string" &&
      typeof parsed?.dont?.stale === "boolean" &&
      typeof parsed?.dont?.aliveEntryCount === "number" &&
      typeof parsed?.dont?.clusterCount === "number" &&
      typeof parsed?.dont?.dupClusterCount === "number" &&
      typeof parsed?.config?.stale === "boolean" &&
      typeof parsed?.config?.entryCount === "number"
    );
  } catch {
    return false;
  }
}

export interface ConsolidationRunResult {
  guardPatternCountBefore: number;
  guardPatternCountAfter: number;
  guardFileHashBefore: string | null;
  guardFileHashAfter: string | null;
  memoriesCountBefore: number;
  memoriesCountAfter: number;
  consolidatedCacheHashBefore: string;
  consolidatedCacheHashAfter: string;
  reportExists: boolean;
  reportValid: boolean;
}

/**
 * consolidateProject（dist/cli/consolidate-all.js）を、指定プロジェクトルートに対して
 * 1回だけ呼び出す使い捨てラッパースクリプトを一時ファイルへ書き出し、別プロセスとして
 * 実行する。
 *
 * 同一プロセス内で `await import(distConsolidateAll)` すると、Node のESMモジュール
 * キャッシュにより「そのプロセスで最初にdist/config.jsが読み込まれた時点のprocess.env」
 * が以後ずっと使われ続ける。本ゲートは複数のcheckで dist/cli/context.js と
 * dist/cli/consolidate-all.js の両方を動的importするため、後から process.env を
 * 書き換えても間に合わない（実機で dream 生成が実際に発火し、hermetic化が効いていない
 * ことを確認した）。子プロセスとして起動すれば env はプロセスごとに独立するため、
 * hermeticEnv() が確実に効く。
 */
async function runConsolidateProjectInSubprocess(
  distConsolidateAll: string,
  projectRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const wrapperDir = mkdtempSync(join(tmpdir(), "g0-consolidate-wrapper-"));
  const wrapperPath = join(wrapperDir, "run-consolidate.mjs");
  const moduleUrl = pathToFileURL(distConsolidateAll).href;
  writeFileSync(
    wrapperPath,
    [
      `import { consolidateProject } from ${JSON.stringify(moduleUrl)};`,
      `await consolidateProject(${JSON.stringify(projectRoot)});`,
      "",
    ].join("\n"),
    "utf-8",
  );
  try {
    const result = await spawnNodeScript(wrapperPath, { cwd: projectRoot, env, timeoutMs: 30000 });
    if (result.exitCode !== 0) {
      throw new Error(
        `consolidateProjectのサブプロセス実行が失敗しました(exit=${result.exitCode}): ${result.stderr}`,
      );
    }
  } finally {
    rmSync(wrapperDir, { recursive: true, force: true });
  }
}

/**
 * 夜間統合（本番と同一の起動経路: dist/cli/consolidate-all.js の consolidateProject）を
 * `--store` のスクラッチコピーに対して1回だけ実行する。guard-gen-stopped（ガードパターン
 * 再生成なし）とnightly-dryrun（書き込み0件＋レポート生成）の両方の生データをここで収集する。
 */
export async function runConsolidationAgainstScratchCopy(
  storePath: string,
  repoRoot: string,
): Promise<ConsolidationRunResult> {
  const distConsolidateAll = requireDistFile(repoRoot, "cli", "consolidate-all.js");
  const scratch = createScratchProject(storePath);
  try {
    const guardFilePath = join(scratch.memoryPath, "consolidated-dont.json");
    const dbPath = join(scratch.memoryPath, "memory.db");

    const guardBefore = readGuardFileState(guardFilePath);
    const memoriesCountBefore = countMemories(dbPath);
    const consolidatedCacheHashBefore = readConsolidatedCacheHash(dbPath);

    await runConsolidateProjectInSubprocess(distConsolidateAll, scratch.projectRoot, hermeticEnv());

    const guardAfter = readGuardFileState(guardFilePath);
    const memoriesCountAfter = countMemories(dbPath);
    const consolidatedCacheHashAfter = readConsolidatedCacheHash(dbPath);

    const reportPath = join(scratch.memoryPath, "consolidation-dryrun-report.json");
    const reportExists = existsSync(reportPath);
    const reportValid = reportExists && isValidDryRunReport(reportPath);

    return {
      guardPatternCountBefore: guardBefore.count,
      guardPatternCountAfter: guardAfter.count,
      guardFileHashBefore: guardBefore.hash,
      guardFileHashAfter: guardAfter.hash,
      memoriesCountBefore,
      memoriesCountAfter,
      consolidatedCacheHashBefore,
      consolidatedCacheHashAfter,
      reportExists,
      reportValid,
    };
  } finally {
    cleanupScratchProject(scratch);
  }
}

export function evaluateGuardGenStopped(
  guardPatternCountBefore: number,
  guardPatternCountAfter: number,
  guardFileHashBefore: string | null,
  guardFileHashAfter: string | null,
): CheckResult {
  const fileUnchanged = guardFileHashBefore === guardFileHashAfter;
  const pass = guardPatternCountBefore === guardPatternCountAfter && fileUnchanged;
  return {
    check: "guard-gen-stopped",
    result: pass ? "PASS" : "FAIL",
    measured: { guardPatternCountBefore, guardPatternCountAfter, fileUnchanged },
    threshold: { guardPatternCountDelta: 0, fileUnchanged: true },
  };
}

export function evaluateNightlyDryrun(
  memoriesCountBefore: number,
  memoriesCountAfter: number,
  cacheHashBefore: string,
  cacheHashAfter: string,
  reportExists: boolean,
  reportValid: boolean,
): CheckResult {
  const cacheUnchanged = cacheHashBefore === cacheHashAfter;
  const pass = memoriesCountBefore === memoriesCountAfter && cacheUnchanged && reportExists && reportValid;
  return {
    check: "nightly-dryrun",
    result: pass ? "PASS" : "FAIL",
    measured: {
      memoriesCountBefore,
      memoriesCountAfter,
      cacheUnchanged,
      reportExists,
      reportValid,
    },
    threshold: { memoriesWrites: 0, cacheWrites: 0, reportExists: true, reportValid: true },
  };
}

// ============================================================
// 検査5: counters
// ============================================================

/**
 * 可観測性カウンタ（src/observability/counters.ts、タスク0.9で実装済み）を一時ディレクトリ
 * に対して実際に increment→snapshot まで動かし、5指標が構造どおり出力されることを確認する。
 * 実ストアのlogs/には一切書き込まない（スクラッチの空ディレクトリのみ使用）。
 */
export async function checkCounters(repoRoot: string): Promise<CheckResult> {
  const distCounters = requireDistFile(repoRoot, "observability", "counters.js");
  const { increment, snapshot } = (await import(distCounters)) as {
    increment: (memoryPath: string, metric: string, value?: number) => Promise<void>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    snapshot: (memoryPath: string) => Promise<any>;
  };

  const scratchDir = mkdtempSync(join(tmpdir(), "g0-counters-"));
  try {
    await increment(scratchDir, "search_total", 10);
    await increment(scratchDir, "search_zero_hit", 1);
    await increment(scratchDir, "injection_tokens", 500);
    await increment(scratchDir, "consolidation_count", 2);
    await increment(scratchDir, "guard_block_count", 1);
    await increment(scratchDir, "resurrection_count", 0);

    const snap = await snapshot(scratchDir);

    // 蘇生カウンタはゲージ意味論に変更された（毎回「現在の絶対値」を記録するため
    // sum/totalは水増しになり廃止。latest/max/observations/alertのみ）。
    // ラウンドトリップ確認はmax（その日の最大読み値）で行う。
    const structurallyPresent =
      Number.isFinite(snap?.zeroHitRate?.rate) &&
      Number.isFinite(snap?.injectionTokens?.total) &&
      Number.isFinite(snap?.consolidationCount?.total) &&
      Number.isFinite(snap?.guardBlockCount?.total) &&
      Number.isFinite(snap?.resurrectionCount?.max) &&
      Number.isFinite(snap?.resurrectionCount?.latest);

    const valuesMatch =
      snap?.zeroHitRate?.totalSearches === 10 &&
      snap?.zeroHitRate?.zeroHitSearches === 1 &&
      snap?.injectionTokens?.total === 500 &&
      snap?.consolidationCount?.total === 2 &&
      snap?.guardBlockCount?.total === 1 &&
      snap?.resurrectionCount?.max === 0;

    const pass = structurallyPresent && valuesMatch;

    return {
      check: "counters",
      result: pass ? "PASS" : "FAIL",
      measured: {
        metricsPresent: structurallyPresent,
        zeroHitRate: snap?.zeroHitRate?.rate,
        injectionTokensTotal: snap?.injectionTokens?.total,
        consolidationCountTotal: snap?.consolidationCount?.total,
        guardBlockCountTotal: snap?.guardBlockCount?.total,
        resurrectionCountMax: snap?.resurrectionCount?.max,
        resurrectionCountLatest: snap?.resurrectionCount?.latest,
      },
      threshold: { metricsExpected: 5, roundTripValuesMatch: true },
    };
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

// ============================================================
// オーケストレーション
// ============================================================

export interface G0Options {
  storePath: string;
  backupPath: string;
  schedulerDir?: string;
  repoRoot?: string;
}

export interface G0Output {
  preconditions: PreconditionResult;
  checks: CheckResult[];
}

export async function runG0(options: G0Options): Promise<G0Output> {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const schedulerDir = options.schedulerDir ?? DEFAULT_SCHEDULER_DIR;

  const preconditions = assertPreconditions(options.storePath);
  if (!preconditions.ok) {
    return { preconditions, checks: [] };
  }

  const targets = await discoverBackupTargets(options.storePath, options.backupPath, schedulerDir);
  const backupRestore = await checkBackupRestore(targets);

  const sessionRun = await runSessionStartAgainstScratchCopy(options.storePath, repoRoot);
  const v1Blocked = evaluateV1Blocked(sessionRun.v1FileMtimesBefore, sessionRun.v1FileMtimesAfter);
  const injection = evaluateInjection(sessionRun.stdoutText, sessionRun.stdoutTokensEstimate, sessionRun.budgetTokens);

  const consolidationRun = await runConsolidationAgainstScratchCopy(options.storePath, repoRoot);
  const guardGenStopped = evaluateGuardGenStopped(
    consolidationRun.guardPatternCountBefore,
    consolidationRun.guardPatternCountAfter,
    consolidationRun.guardFileHashBefore,
    consolidationRun.guardFileHashAfter,
  );
  const nightlyDryrun = evaluateNightlyDryrun(
    consolidationRun.memoriesCountBefore,
    consolidationRun.memoriesCountAfter,
    consolidationRun.consolidatedCacheHashBefore,
    consolidationRun.consolidatedCacheHashAfter,
    consolidationRun.reportExists,
    consolidationRun.reportValid,
  );

  const counters = await checkCounters(repoRoot);

  return {
    preconditions,
    checks: [backupRestore, v1Blocked, guardGenStopped, nightlyDryrun, counters, injection],
  };
}

// ============================================================
// CLI（parseArgsは scripts/backup-store.ts のexportを再利用）
// ============================================================

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const storeArg = args["store"];
  const backupArg = args["backup"];
  const schedulerDirArg = args["scheduler-dir"];

  if (!storeArg || !backupArg) {
    console.error("Usage: g0-hemostasis.ts --store <memoryPath> --backup <backupDir> [--scheduler-dir <dir>]");
    process.exit(1);
    return;
  }

  const output = await runG0({ storePath: storeArg, backupPath: backupArg, schedulerDir: schedulerDirArg });

  const preconditionThreshold = { dbOpens: true, memoriesCountMin: 1000, operationLogExists: true };

  if (!output.preconditions.ok) {
    console.log(
      JSON.stringify({
        check: "preconditions",
        result: "FAIL",
        measured: output.preconditions,
        threshold: preconditionThreshold,
      }),
    );
    console.log(`\n== G0結果: 前提アサート不成立のためFAIL（6検査は実行していません） ==`);
    console.log(`理由: ${output.preconditions.reason}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    JSON.stringify({
      check: "preconditions",
      result: "PASS",
      measured: output.preconditions,
      threshold: preconditionThreshold,
    }),
  );
  for (const check of output.checks) {
    console.log(JSON.stringify(check));
  }

  const failed = output.checks.filter((c) => c.result === "FAIL");
  const suffix = failed.length > 0 ? ` / FAIL: ${failed.map((f) => f.check).join(", ")}` : "";
  console.log(`\n== G0結果: ${output.checks.length - failed.length}/${output.checks.length} PASS${suffix} ==`);
  process.exitCode = failed.length > 0 ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith("g0-hemostasis.ts")) {
  main().catch((error) => {
    console.error("g0-hemostasis 失敗:", error);
    process.exit(1);
  });
}
