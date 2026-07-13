#!/usr/bin/env node
/**
 * scripts/gates/g-write-severance.ts
 * 破壊型書き込み経路の再発ガード（v1/v2 二重書込・破壊型merge severance の固定検査）。
 *
 * 検証役（qa-engineer）専用資産。実装者は編集しない（g0-hemostasis.ts / g1-foundation.ts と
 * 同じ運用方針を踏襲する）。
 *
 * Usage:
 *   node --experimental-specifier-resolution=node --loader ts-node/esm \
 *     scripts/gates/g-write-severance.ts [--repo-root <dir>]
 *
 * （実行コマンドの注記は g0-hemostasis.ts のヘッダを参照。同一環境・同一理由で
 *   `npx ts-node --esm` 単体は動作しない。）
 *
 * 設計方針:
 * - 本ゲートはソース走査（正規表現）のみで完結する静的検査。DB にも本番データにも一切触れない。
 * - 各チェックは「収集（ファイル読み取り＋正規表現）」と「評価（純粋関数）」を分離する（G0/G1と同型）。
 *   収集関数は走査ルートを引数で受けるため、合成フィクスチャ（一時ディレクトリ）で単体テストできる。
 * - コメント／JSDoc の言及で誤検知しないよう、走査前に行数を保ったままコメントを除去する。
 * - 4検査（いずれか破れたら FAIL）:
 *     A. merge-dead-code : 破壊型 mergePrinciplesIntoMemories() の呼び出し元がゼロ（定義のみ）。
 *     B. v1-write-severed: v1(MarkdownStorage/consolidate-worker) の書き込み経路が
 *        生きた（非テスト）コードから再配線されていない。
 *     C. consolidate-all-no-memories-write:
 *        夜間統合の実体 consolidate-all.ts「本文」が memories/consolidated テーブルへ書き込まない。
 *     D. consolidate-all-closure-no-memories-write:
 *        consolidate-all.ts から辿れるローカル import 閉包（src 配下の相対 import を推移的に収集）の
 *        全モジュールが memories への破壊型書き込みを含まない。Check C の盲点（破壊挙動を別名ヘルパー
 *        へ移して consolidate-all から呼ぶ再侵入）を閉包全体の走査で捕捉する。
 * - 出力形式: G0/G1と同一（1検査1行のJSON: check/result/measured/threshold + 人間可読サマリ）。
 *   記憶本文は一切出力しない（相対パス・行番号・件数・真偽値のみ）。
 *
 * 補足（夢生成の意図的除外）: consolidate-all は後段で runDreamGenerationForProject を呼び、
 * それ自体は memories へ save する。ただし夢生成は統合とは別系統の書き込みで design.md の
 * dry-run 対象外（GroundTruth 確定）。よって Check C は consolidate-all.ts 自身の本文に現れる
 * memories 書き込みだけを対象とし、別モジュール(dream-worker)へ委譲される save は検出しない。
 * Check D も同じ理由で dream-worker.ts を走査対象から除外する（後述）。
 */

import { fileURLToPath } from "url";
import { dirname, isAbsolute, join, relative, resolve } from "path";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import type { Dirent } from "fs";

import { parseArgs } from "../backup-store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_REPO_ROOT = resolve(__dirname, "..", "..");

// ============================================================
// 出力型（G0/G1と同型）
// ============================================================

export interface CheckResult {
  check: string;
  result: "PASS" | "FAIL";
  measured: Record<string, unknown>;
  threshold: Record<string, unknown>;
}

export interface PreconditionResult {
  ok: boolean;
  srcDirExists: boolean;
  consolidateAllExists: boolean;
  reason?: string;
}

export interface GWriteSeveranceOutput {
  preconditions: PreconditionResult;
  checks: CheckResult[];
}

/** 検出したソース位置（走査ルートからの相対パス＋1始まり行番号）。 */
export interface SourceHit {
  file: string;
  line: number;
  match: string;
}

// ============================================================
// 共通ユーティリティ
// ============================================================

/**
 * コメント（ブロック/行）を除去する。行番号を保つため、ブロックコメントは空白へ、
 * 行コメントは // 以降を削除する（改行は維持）。文字列リテラル内の // まで消し得るが、
 * それは検出漏れ（＝ガードが甘くなる）方向にしか働かず、本ガードの対象ファイル群では
 * 実害が無い（対象は URL 等を含まない内部モジュール）。
 */
export function stripComments(source: string): string {
  const noBlock = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return noBlock.replace(/\/\/[^\n]*/g, "");
}

/** dir 配下の .ts ファイルを再帰的に列挙する（node_modules / dist は除外）。 */
export function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      out.push(...walkTsFiles(full));
    } else if (e.isFile() && e.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

// ============================================================
// Check A: merge-dead-code（破壊型 merge の呼び出し元ゼロ）
// ============================================================

const MERGE_DEF_RE = /(?:export\s+)?function\s+mergePrinciplesIntoMemories\b/;
const MERGE_CALL_RE = /\bmergePrinciplesIntoMemories\s*\(/;

export interface MergeScanResult {
  definitionSites: SourceHit[];
  callSites: SourceHit[];
}

/**
 * srcDir 配下の全 .ts を走査し、破壊型 mergePrinciplesIntoMemories の定義と呼び出しを分類する。
 * 定義行（`function mergePrinciplesIntoMemories`）は呼び出し正規表現にも一致するため、
 * 先に定義判定して呼び出しから除外する。
 */
export function collectMergeCallSites(srcDir: string): MergeScanResult {
  const definitionSites: SourceHit[] = [];
  const callSites: SourceHit[] = [];
  for (const file of walkTsFiles(srcDir)) {
    const rel = relative(srcDir, file);
    const lines = stripComments(readFileSync(file, "utf-8")).split("\n");
    lines.forEach((line, idx) => {
      if (MERGE_DEF_RE.test(line)) {
        definitionSites.push({ file: rel, line: idx + 1, match: "definition" });
      } else if (MERGE_CALL_RE.test(line)) {
        callSites.push({ file: rel, line: idx + 1, match: "mergePrinciplesIntoMemories(" });
      }
    });
  }
  return { definitionSites, callSites };
}

export function evaluateMergeDeadCode(scan: MergeScanResult): CheckResult {
  return {
    check: "merge-dead-code",
    result: scan.callSites.length === 0 ? "PASS" : "FAIL",
    measured: {
      callSiteCount: scan.callSites.length,
      callSites: scan.callSites,
      definitionSiteCount: scan.definitionSites.length,
    },
    threshold: { callSiteCount: 0 },
  };
}

// ============================================================
// Check B: v1-write-severed（v1 書込ワーカーが生きたコードから再配線されていない）
// ============================================================

const V1_REWIRE_RE = /consolidate-worker|runDontConsolidationForProject/;
/** v1 書込ワーカー本体とテストは対象外（テストは severance を verify する目的で名前を参照する）。 */
const V1_SCAN_EXCLUDE_BASENAMES = new Set(["consolidate-worker.ts"]);

/**
 * srcDir 配下の「生きた（非テスト）」.ts を走査し、v1 書込ワーカー
 * （consolidate-worker モジュール／その v1 書込エントリ runDontConsolidationForProject）への
 * 参照を収集する。参照が 1 件でもあれば severance が破られている（再配線された）。
 * *.test.ts と consolidate-worker.ts 自身は除外する。
 */
export function collectV1WriteReferences(srcDir: string): SourceHit[] {
  const hits: SourceHit[] = [];
  for (const file of walkTsFiles(srcDir)) {
    const rel = relative(srcDir, file);
    if (rel.endsWith(".test.ts")) continue;
    const base = rel.split(/[\\/]/).pop() ?? rel;
    if (V1_SCAN_EXCLUDE_BASENAMES.has(base)) continue;
    const lines = stripComments(readFileSync(file, "utf-8")).split("\n");
    lines.forEach((line, idx) => {
      const m = line.match(V1_REWIRE_RE);
      if (m) {
        hits.push({ file: rel, line: idx + 1, match: m[0] });
      }
    });
  }
  return hits;
}

export function evaluateV1WriteSevered(hits: SourceHit[]): CheckResult {
  return {
    check: "v1-write-severed",
    result: hits.length === 0 ? "PASS" : "FAIL",
    measured: { referenceCount: hits.length, references: hits },
    threshold: { referenceCount: 0 },
  };
}

// ============================================================
// Check C: consolidate-all-no-memories-write
// ============================================================

const CONSOLIDATE_ALL_WRITE_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "sql-insert-memories", re: /\bINSERT\s+INTO\s+memories\b/i },
  { name: "sql-update-memories", re: /\bUPDATE\s+memories\b/i },
  { name: "sql-delete-memories", re: /\bDELETE\s+FROM\s+memories\b/i },
  { name: "storage-save", re: /\.save\s*\(/ },
  { name: "storage-softDelete", re: /\.softDelete\s*\(/ },
  { name: "storage-deleteVectors", re: /\.deleteVectors\s*\(/ },
  { name: "storage-purgeTombstones", re: /\.purgeTombstones\s*\(/ },
  { name: "storage-updateIntensity", re: /\.updateIntensity\s*\(/ },
  { name: "merge-principles", re: /\bmergePrinciplesIntoMemories\s*\(/ },
  { name: "persist-consolidated-sqlite", re: /\bpersistConsolidated\w*ToSqlite\s*\(/ },
  { name: "write-consolidated-v1", re: /\bwriteConsolidated(?:Dont|Config)\s*\(/ },
];

export interface ConsolidateAllScanResult {
  fileExists: boolean;
  writes: SourceHit[];
}

/**
 * consolidate-all.ts 本文を走査し、memories/consolidated テーブルへの書き込みパターンを収集する。
 * 夢生成（runDreamGenerationForProject）は別系統・dry-run 対象外のため検出パターンに含めない。
 */
export function collectConsolidateAllWrites(consolidateAllPath: string): ConsolidateAllScanResult {
  if (!existsSync(consolidateAllPath)) {
    return { fileExists: false, writes: [] };
  }
  const writes: SourceHit[] = [];
  const lines = stripComments(readFileSync(consolidateAllPath, "utf-8")).split("\n");
  lines.forEach((line, idx) => {
    for (const p of CONSOLIDATE_ALL_WRITE_PATTERNS) {
      if (p.re.test(line)) {
        writes.push({ file: "consolidate-all.ts", line: idx + 1, match: p.name });
      }
    }
  });
  return { fileExists: true, writes };
}

export function evaluateConsolidateAllNoWrite(scan: ConsolidateAllScanResult): CheckResult {
  const pass = scan.fileExists && scan.writes.length === 0;
  return {
    check: "consolidate-all-no-memories-write",
    result: pass ? "PASS" : "FAIL",
    measured: { fileExists: scan.fileExists, writeCount: scan.writes.length, writes: scan.writes },
    threshold: { fileExists: true, writeCount: 0 },
  };
}

// ============================================================
// Check D: consolidate-all-closure-no-memories-write
// ============================================================
//
// Check C は consolidate-all.ts「本文」しか見ない。破壊挙動（softDelete/deleteVectors/save や
// memories への生 SQL）を別名ヘルパー（例 consolidator/apply-consolidation.ts）へ移して
// consolidate-all から呼ぶと Check C は素通りする。Check D は consolidate-all.ts から辿れる
// ローカル import 閉包（src 配下の相対 import を推移的に収集）へ走査を広げ、閉包内の任意の
// モジュールに破壊型書き込みが現れたら FAIL にする（別名ヘルパー経由の再侵入を名前非依存で捕捉）。
//
// 走査対象から除外する種別（正当な書き込みを誤検知＝FAIL にしないため）:
// - 破壊プリミティブの「定義ファイル」（storage/ 配下の STORAGE_PRIMITIVE_DEF_FILES）のみ:
//   memories への INSERT/UPDATE/DELETE と save/softDelete/deleteVectors の「定義そのもの」を持つ
//   永続化・マイグレーション・スキーマのプリミティブ。severance が守るのは「統合ロジックがこれを
//   呼ぶか」であり、呼び出し（.save( 等）は呼び出し側モジュールに現れる。定義ファイルだけを除外し、
//   storage/ 配下でも「呼び出し側」の新規ファイルは走査対象に含める（storage/ サブツリーを丸ごと
//   除外すると、破壊呼び出し側を storage/ 配下の別名ヘルパーに置くだけで素通りする盲点が残るため）。
// - dream-worker.ts: 統合とは別系統・dry-run 対象外の意図的な save（Check C と同一の除外理由）。
// テスト（*.test.ts）も除外する（severance を verify する目的で書込名を参照するため）。
// readonly な抑制装置判定（cap-sweep）の SELECT は書き込みパターンに一致しないため自然に除外される。

/** Check D の破壊型書き込みパターン（memories への破壊操作のみ。Check C の派生集合）。 */
const CLOSURE_WRITE_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "sql-insert-memories", re: /\bINSERT\s+INTO\s+memories\b/i },
  { name: "sql-update-memories", re: /\bUPDATE\s+memories\b/i },
  { name: "sql-delete-memories", re: /\bDELETE\s+FROM\s+memories\b/i },
  { name: "storage-save", re: /\.save\s*\(/ },
  { name: "storage-softDelete", re: /\.softDelete\s*\(/ },
  { name: "storage-deleteVectors", re: /\.deleteVectors\s*\(/ },
];

/**
 * storage/ 配下で走査から除外する「破壊プリミティブの定義ファイル」（basename の集合）。
 *
 * ここに挙げたファイルだけが memories への破壊操作（save/softDelete/deleteVectors の実装、
 * および INSERT/UPDATE/DELETE memories の生 SQL）を「定義」する永続化基盤である。実地確認
 * （grep）で storage/ 配下の非テストファイルのうち破壊型書き込みパターンを含むのはこの3ファイル
 * のみ（sqlite=永続化本体、migration=スキーマ移行時の書き換え、schema=FTSトリガ内の INSERT）。
 *
 * severance が守るのは「統合ロジックがこれらを“呼ぶ”か」であり、呼び出しは呼び出し側モジュールに
 * 現れる。よって定義ファイルだけを除外し、storage/ 配下でもここに無い新規ファイル（＝呼び出し側）は
 * 走査対象に含める。これにより破壊呼び出しを storage/ 配下の別名ヘルパーへ移す盲点を塞ぐ。
 * 新たな永続化プリミティブ定義ファイルを storage/ に追加したら、本集合にも追記する（追記漏れは
 * その定義ファイルが走査対象に入り Check D が FAIL するため、沈黙ではなく可視の失敗として現れる）。
 */
const STORAGE_PRIMITIVE_DEF_FILES = new Set<string>(["sqlite.ts", "migration.ts", "schema.ts"]);

/** 相対 import / 相対 export-from の指定子を拾う（型 import・複数行 import も含む）。 */
const RELATIVE_FROM_RE = /(?:import|export)\b[^;]*?\bfrom\s*["'](\.[^"']*)["']/g;
/** 副作用 import（`import "./x.js"`）の相対指定子。 */
const SIDE_EFFECT_IMPORT_RE = /import\s*["'](\.[^"']*)["']/g;
/** 動的 import（`import("./x.js")`）の相対指定子。 */
const DYNAMIC_IMPORT_RE = /import\s*\(\s*["'](\.[^"']*)["']/g;

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 相対 import 指定子を実ファイル（.js→.ts 読替 / ディレクトリ→index.ts）へ解決する。解決不能なら null。 */
export function resolveLocalImport(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null; // 外部パッケージは追わない
  const base = resolve(dirname(fromFile), spec);
  const candidates: string[] = [];
  if (base.endsWith(".js")) candidates.push(base.slice(0, -3) + ".ts");
  if (isFile(base)) candidates.push(base);
  candidates.push(base + ".ts");
  candidates.push(join(base, "index.ts"));
  for (const c of candidates) {
    if (isFile(c)) return c;
  }
  return null;
}

/** ソース本文から相対 import 指定子（静的 from / 副作用 / 動的）を重複排除して抽出する。 */
function extractRelativeImportSpecs(source: string): string[] {
  const specs = new Set<string>();
  for (const re of [RELATIVE_FROM_RE, SIDE_EFFECT_IMPORT_RE, DYNAMIC_IMPORT_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) specs.add(m[1]);
  }
  return [...specs];
}

export interface ClosureScanResult {
  entryExists: boolean;
  /** 閉包に含まれた全ファイル（srcDir 相対・決定論ソート）。 */
  closure: string[];
  /** 実際に走査した（除外後の）ファイル（srcDir 相対）。 */
  scanned: string[];
  /** 走査から除外したファイル（storage 破壊プリミティブ定義ファイル／dream-worker／テスト、srcDir 相対）。 */
  excluded: string[];
  /** 走査対象内で検出した破壊型書き込み位置。 */
  writes: SourceHit[];
}

/**
 * consolidate-all.ts を起点に相対 import 閉包を BFS で収集し、除外集合を差し引いた各ファイルを
 * 破壊型書き込みパターンで走査する。storage 破壊プリミティブ定義ファイル・dream-worker・テストは
 * 走査対象から除外する（storage/ 配下でも定義ファイル以外の呼び出し側は走査する）。
 */
export function collectImportClosureWrites(
  entryFile: string,
  srcDir: string,
): ClosureScanResult {
  if (!existsSync(entryFile)) {
    return { entryExists: false, closure: [], scanned: [], excluded: [], writes: [] };
  }

  const visited = new Set<string>();
  const queue: string[] = [entryFile];
  while (queue.length > 0) {
    const f = queue.shift()!;
    if (visited.has(f)) continue;
    visited.add(f);
    let src: string;
    try {
      src = readFileSync(f, "utf-8");
    } catch {
      continue;
    }
    for (const spec of extractRelativeImportSpecs(src)) {
      const resolved = resolveLocalImport(f, spec);
      if (resolved && !visited.has(resolved)) queue.push(resolved);
    }
  }

  const storageDir = join(srcDir, "storage");
  const isExcluded = (absPath: string): boolean => {
    const base = absPath.split(/[\\/]/).pop() ?? absPath;
    if (base.endsWith(".test.ts")) return true;
    if (base === "dream-worker.ts") return true;
    // storageDir 配下の「破壊プリミティブ定義ファイル」だけを除外する。storage/ サブツリーを
    // 丸ごとは除外しない（storage/ 配下の新規呼び出し側ファイルは走査対象に含めて盲点を塞ぐ）。
    const rel = relative(storageDir, absPath);
    const underStorage = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
    return underStorage && STORAGE_PRIMITIVE_DEF_FILES.has(base);
  };

  const closure: string[] = [];
  const scanned: string[] = [];
  const excluded: string[] = [];
  const writes: SourceHit[] = [];
  for (const f of [...visited].sort()) {
    const rel = relative(srcDir, f);
    closure.push(rel);
    if (isExcluded(f)) {
      excluded.push(rel);
      continue;
    }
    scanned.push(rel);
    const lines = stripComments(readFileSync(f, "utf-8")).split("\n");
    lines.forEach((line, idx) => {
      for (const p of CLOSURE_WRITE_PATTERNS) {
        if (p.re.test(line)) {
          writes.push({ file: rel, line: idx + 1, match: p.name });
        }
      }
    });
  }
  return { entryExists: true, closure, scanned, excluded, writes };
}

export function evaluateImportClosureNoWrite(scan: ClosureScanResult): CheckResult {
  const pass = scan.entryExists && scan.writes.length === 0;
  return {
    check: "consolidate-all-closure-no-memories-write",
    result: pass ? "PASS" : "FAIL",
    measured: {
      entryExists: scan.entryExists,
      closureSize: scan.closure.length,
      scannedCount: scan.scanned.length,
      excludedCount: scan.excluded.length,
      writeCount: scan.writes.length,
      writes: scan.writes,
    },
    threshold: { entryExists: true, writeCount: 0 },
  };
}

// ============================================================
// オーケストレーション
// ============================================================

export interface GWriteSeveranceOptions {
  repoRoot?: string;
  /** テスト差し替え: merge/v1 スキャン対象ディレクトリ（既定 <repoRoot>/src） */
  srcDir?: string;
  /** テスト差し替え: consolidate-all の対象ファイル（既定 <repoRoot>/src/cli/consolidate-all.ts） */
  consolidateAllPath?: string;
}

export function runGWriteSeverance(options: GWriteSeveranceOptions = {}): GWriteSeveranceOutput {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const srcDir = options.srcDir ?? join(repoRoot, "src");
  const consolidateAllPath = options.consolidateAllPath ?? join(srcDir, "cli", "consolidate-all.ts");

  const srcDirExists = existsSync(srcDir);
  const consolidateAllExists = existsSync(consolidateAllPath);
  const ok = srcDirExists && consolidateAllExists;
  let reason: string | undefined;
  if (!srcDirExists) reason = `srcディレクトリが見つかりません: ${srcDir}`;
  else if (!consolidateAllExists) reason = `consolidate-all.ts が見つかりません: ${consolidateAllPath}`;
  const preconditions: PreconditionResult = { ok, srcDirExists, consolidateAllExists, reason };
  if (!ok) {
    return { preconditions, checks: [] };
  }

  const mergeScan = collectMergeCallSites(srcDir);
  const v1Refs = collectV1WriteReferences(srcDir);
  const consolidateAllScan = collectConsolidateAllWrites(consolidateAllPath);
  const closureScan = collectImportClosureWrites(consolidateAllPath, srcDir);

  return {
    preconditions,
    checks: [
      evaluateMergeDeadCode(mergeScan),
      evaluateV1WriteSevered(v1Refs),
      evaluateConsolidateAllNoWrite(consolidateAllScan),
      evaluateImportClosureNoWrite(closureScan),
    ],
  };
}

// ============================================================
// CLI
// ============================================================

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = args["repo-root"];

  const output = runGWriteSeverance(repoRoot ? { repoRoot } : {});

  if (!output.preconditions.ok) {
    console.log(
      JSON.stringify({
        check: "preconditions",
        result: "FAIL",
        measured: output.preconditions,
        threshold: { srcDirExists: true, consolidateAllExists: true },
      }),
    );
    console.log(`\n== g-write-severance結果: 前提不成立のためFAIL（各検査は実行していません） ==`);
    console.log(`理由: ${output.preconditions.reason}`);
    process.exitCode = 1;
    return;
  }

  for (const check of output.checks) {
    console.log(JSON.stringify(check));
  }

  const failed = output.checks.filter((c) => c.result === "FAIL");
  const suffix = failed.length > 0 ? ` / FAIL: ${failed.map((f) => f.check).join(", ")}` : "";
  console.log(`\n== g-write-severance結果: ${output.checks.length - failed.length}/${output.checks.length} PASS${suffix} ==`);
  process.exitCode = failed.length > 0 ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith("g-write-severance.ts")) {
  main();
}
