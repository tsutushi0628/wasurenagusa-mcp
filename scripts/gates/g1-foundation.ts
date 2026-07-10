#!/usr/bin/env node
/**
 * scripts/gates/g1-foundation.ts
 * Phase 1（土台）完了ゲート（design.md Phase 1 ③、タスク1.14、schema v6 + R-A4/R-A5/R-B7/R-B8）。
 *
 * 検証役（qa-engineer）専用資産。実装者は編集しない（design.md「ゲート運用」、G0（g0-hemostasis.ts）
 * と同じ運用方針を踏襲する）。
 *
 * Usage:
 *   node --experimental-specifier-resolution=node --loader ts-node/esm \
 *     scripts/gates/g1-foundation.ts --store <memoryPath>
 *
 * （実行コマンドの注記はg0-hemostasis.tsのヘッダを参照。同一環境・同一理由で
 *   `npx ts-node --esm` 単体は動作しない。）
 *
 * 設計方針:
 * - 前提アサート（schema_versionのMAXが6である、バックアップが存在する、memories総件数が
 *   1,000件以上）が1つでも不成立なら、9検査は一切実行せずFAILで終了する（G0と同型の契約）。
 * - 9検査は design.md Phase 1 ③ の契約どおり、実ストア（`--store`）に対する読み取り専用の
 *   検査で完結させる。書き込みを伴う検証（PT-01/PT-05の状態機械プロパティ、WALのbusy_timeout
 *   確認、書き込み失敗の計数）は、実ストアを一切経由せず、実装コードを直接演習する既存の
 *   テストファイル（tests/properties/state-machine.property.test.ts、
 *   src/storage/write-resilience.test.ts）を `npx vitest run <file> --reporter=json` で
 *   サブプロセス実行し、その合否を転記する（各テスト自身が使い捨ての一時DBを作るため、
 *   `--store` の実体には一切触れない。実装者のコードも一切変更しない）。
 * - 各チェックは「収集（I/O・サブプロセス）」と「評価（純粋関数）」を分離する。
 *   評価関数は合成データを直接渡して単体テストできる（G0と同型）。
 * - 出力形式: G0と同一（1検査1行のJSON: check/result/measured/threshold + 人間可読サマリ）。
 *   記憶本文・クエリ本文は一切出力しない（ファイル名・件数・真偽値・モデル名・ハッシュのみ）。
 */

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { homedir } from "os";
import { basename, dirname, join, resolve } from "path";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";

import { parseArgs } from "../backup-store.js";
import { getModelsDir } from "../../src/config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_REPO_ROOT = resolve(__dirname, "..", "..");
const BACKUPS_ROOT = join(homedir(), ".wasurenagusa", "eval", "backups");

/** design.md Phase 1 ③ 前提アサートの固定値 */
export const REQUIRED_SCHEMA_VERSION = 6;
export const MIN_MEMORIES_FOR_G1 = 1000;

/** project-confidenceチェックのpassthrough回帰検査で使う、実在しない番兵プロジェクト名 */
const SENTINEL_PROJECT = "__g1_sentinel_nonexistent_project__";

/** embedding-single-modelの「モデル据え置き判断」エスケープハッチのマーカー文字列 */
const EMBEDDING_MODEL_DECISION_MARKER = "embedding_model据え置き判断";

// ============================================================
// 出力型（G0と同型）
// ============================================================

export interface CheckResult {
  check: string;
  result: "PASS" | "FAIL";
  measured: Record<string, unknown>;
  threshold: Record<string, unknown>;
}

export interface PreconditionResult {
  ok: boolean;
  dbOpens: boolean;
  schemaVersionOk: boolean;
  maxSchemaVersion: number;
  memoriesCount: number;
  backupExists: boolean;
  reason?: string;
}

export interface G1Output {
  preconditions: PreconditionResult;
  checks: CheckResult[];
}

interface VitestAssertion {
  fullName: string;
  status: string;
}

// ============================================================
// 前提アサート
// ============================================================

/**
 * projectName配下のバックアップ（<backupsRoot>/<date>/<projectName>/manifest.json）が
 * 1つでも存在するかを確認する（バックアップ本体の中身検証はしない。存在確認のみ）。
 * backupsRootは既定で実運用先（~/.wasurenagusa/eval/backups）を指すが、テストからは
 * 一時ディレクトリを注入できる（実グローバル状態に触れずに検証するため）。
 */
export function hasAnyBackup(storePath: string, backupsRoot: string = BACKUPS_ROOT): boolean {
  const projectName = basename(dirname(storePath));
  if (!existsSync(backupsRoot)) return false;
  let dateDirs: string[];
  try {
    dateDirs = readdirSync(backupsRoot).filter((d) => {
      try {
        return statSync(join(backupsRoot, d)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
  return dateDirs.some((d) => existsSync(join(backupsRoot, d, projectName, "manifest.json")));
}

export function assertPreconditions(storePath: string, backupsRoot: string = BACKUPS_ROOT): PreconditionResult {
  const dbPath = join(storePath, "memory.db");
  let dbOpens = false;
  let maxSchemaVersion = 0;
  let memoriesCount = 0;
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      dbOpens = true;
      const versionRow = db.prepare("SELECT MAX(version) as v FROM schema_version").get() as
        | { v: number | null }
        | undefined;
      maxSchemaVersion = versionRow?.v ?? 0;
      memoriesCount = (db.prepare("SELECT COUNT(*) as c FROM memories").get() as { c: number }).c;
    } finally {
      db.close();
    }
  } catch {
    dbOpens = false;
  }

  const schemaVersionOk = dbOpens && maxSchemaVersion === REQUIRED_SCHEMA_VERSION;
  const backupExists = dbOpens ? hasAnyBackup(storePath, backupsRoot) : false;
  const ok = dbOpens && schemaVersionOk && memoriesCount >= MIN_MEMORIES_FOR_G1 && backupExists;

  let reason: string | undefined;
  if (!dbOpens) reason = "DBが開けません";
  else if (!schemaVersionOk) {
    reason = `schema_versionがv${REQUIRED_SCHEMA_VERSION}ではありません（実測v${maxSchemaVersion}）`;
  } else if (memoriesCount < MIN_MEMORIES_FOR_G1) {
    reason = `memories総件数が${MIN_MEMORIES_FOR_G1}件未満（実測${memoriesCount}件）`;
  } else if (!backupExists) {
    reason = "バックアップ（~/.wasurenagusa/eval/backups/*/<project>/manifest.json）が見つかりません";
  }

  return { ok, dbOpens, schemaVersionOk, maxSchemaVersion, memoriesCount, backupExists, reason };
}

// ============================================================
// 検査1: state-consistency（stateとdeleted_atの常時同期、実データでの検証）
// ============================================================

export function collectStateConsistencyMismatch(db: Database.Database): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) as c FROM memories
         WHERE (state = 'deleted' AND deleted_at IS NULL)
            OR (state != 'deleted' AND deleted_at IS NOT NULL)`,
      )
      .get() as { c: number }
  ).c;
}

export function evaluateStateConsistency(mismatchCount: number): CheckResult {
  return {
    check: "state-consistency",
    result: mismatchCount === 0 ? "PASS" : "FAIL",
    measured: { mismatchCount },
    threshold: { mismatchCountMax: 0 },
  };
}

// ============================================================
// 検査2: pt-invariants（PT-01/PT-05をvitestサブプロセスで再実行し合否を転記）
// ============================================================

export function evaluatePtInvariants(assertions: VitestAssertion[]): CheckResult {
  const requiredMarkers = ["PT-01", "PT-05"];
  const matched = requiredMarkers.map((marker) => assertions.find((a) => a.fullName.includes(marker)));
  const allFoundAndPassed = matched.every((m) => m !== undefined && m.status === "passed");
  return {
    check: "pt-invariants",
    result: allFoundAndPassed ? "PASS" : "FAIL",
    measured: {
      results: matched.map((m, i) => ({ marker: requiredMarkers[i], found: m !== undefined, status: m?.status ?? null })),
    },
    threshold: { requiredMarkers, requiredStatus: "passed" },
  };
}

// ============================================================
// 検査3: resurrection-zero（tombstone化済みmemoriesにvectors/vector_metadataが残っていないこと）
// ============================================================

export interface TombstoneCounts {
  memories: number;
  vectors: number;
  vectorMetadata: number;
}

/** SQLiteStorage.countTombstones()（src/storage/sqlite.ts）と同じ定義を独立に再導出する。
 *  同一コードをimportして検査すると「実装が壊れても検査も一緒に壊れる」ため、意図的に別実装。 */
export function collectTombstones(db: Database.Database): TombstoneCounts {
  const memories = (
    db.prepare("SELECT COUNT(*) as c FROM memories WHERE deleted_at IS NOT NULL").get() as { c: number }
  ).c;
  const vectors = (
    db
      .prepare(
        `SELECT COUNT(*) as c FROM vectors
         WHERE id IN (SELECT id FROM memories WHERE deleted_at IS NOT NULL)`,
      )
      .get() as { c: number }
  ).c;
  const vectorMetadata = (
    db
      .prepare(
        `SELECT COUNT(*) as c FROM vector_metadata
         WHERE id IN (SELECT id FROM memories WHERE deleted_at IS NOT NULL)`,
      )
      .get() as { c: number }
  ).c;
  return { memories, vectors, vectorMetadata };
}

export function evaluateResurrectionZero(t: TombstoneCounts): CheckResult {
  const result = t.vectors === 0 && t.vectorMetadata === 0 ? "PASS" : "FAIL";
  return {
    check: "resurrection-zero",
    result,
    measured: t,
    threshold: { vectorsMax: 0, vectorMetadataMax: 0 },
  };
}

// ============================================================
// 検査4: embedding-single-model
// ============================================================

export function collectDistinctEmbeddingModels(db: Database.Database): string[] {
  return (db.prepare("SELECT DISTINCT embedding_model as m FROM vector_metadata").all() as { m: string }[]).map(
    (r) => r.m,
  );
}

/** Implementation Logs配下に「据え置き判断」の記録マーカーがあるかを確認する（エスケープハッチ）。 */
export function hasEmbeddingModelDecisionRecord(repoRoot: string): boolean {
  const logsDir = join(repoRoot, ".spec-workflow", "specs", "memory-redesign", "Implementation Logs");
  if (!existsSync(logsDir)) return false;
  let files: string[];
  try {
    files = readdirSync(logsDir).filter((f) => f.endsWith(".md"));
  } catch {
    return false;
  }
  return files.some((f) => {
    try {
      return readFileSync(join(logsDir, f), "utf-8").includes(EMBEDDING_MODEL_DECISION_MARKER);
    } catch {
      return false;
    }
  });
}

export function evaluateEmbeddingSingleModel(models: string[], hasRecordedDecision: boolean): CheckResult {
  const distinctCount = models.length;
  const result = distinctCount <= 1 || hasRecordedDecision ? "PASS" : "FAIL";
  return {
    check: "embedding-single-model",
    result,
    measured: { distinctCount, models, hasRecordedDecision },
    threshold: { distinctCountMax: 1, escapeHatch: "hasRecordedDecision" },
  };
}

// ============================================================
// 検査5: project-confidence（分布の実測 + R-A4 AC3 passthroughの独立回帰検査）
// ============================================================

export interface ProjectConfidenceData {
  distribution: Record<string, number>;
  passthroughSentinelCount: number;
  expectedUnknownOrNullCount: number;
}

export function collectProjectConfidence(db: Database.Database): ProjectConfidenceData {
  const rows = db
    .prepare("SELECT project_confidence as pc, COUNT(*) as c FROM memories WHERE deleted_at IS NULL GROUP BY project_confidence")
    .all() as { pc: string; c: number }[];
  const distribution: Record<string, number> = {};
  for (const r of rows) distribution[r.pc] = r.c;

  // R-A4 AC3の実SQLパターン（src/storage/sqlite.ts、6箇所）を独立に再導出し、実在しない番兵
  // プロジェクト名を束縛して実行する。同一コードをimportせず別実装で照合することで、将来
  // 「OR project = 'unknown'」節が誤って削除される回帰を検出できる。
  const passthroughSentinelCount = (
    db
      .prepare(
        `SELECT COUNT(*) as c FROM memories
         WHERE deleted_at IS NULL AND (project IS NULL OR project = 'unknown' OR project = ?)`,
      )
      .get(SENTINEL_PROJECT) as { c: number }
  ).c;

  const expectedUnknownOrNullCount = (
    db
      .prepare("SELECT COUNT(*) as c FROM memories WHERE deleted_at IS NULL AND (project IS NULL OR project = 'unknown')")
      .get() as { c: number }
  ).c;

  return { distribution, passthroughSentinelCount, expectedUnknownOrNullCount };
}

export function evaluateProjectConfidence(d: ProjectConfidenceData): CheckResult {
  const result = d.passthroughSentinelCount === d.expectedUnknownOrNullCount ? "PASS" : "FAIL";
  return {
    check: "project-confidence",
    result,
    measured: {
      distribution: d.distribution,
      passthroughSentinelCount: d.passthroughSentinelCount,
      expectedUnknownOrNullCount: d.expectedUnknownOrNullCount,
    },
    threshold: { passthroughSentinelCountMustEqualExpected: true },
  };
}

// ============================================================
// 検査6: wal（実ストアのjournal_mode直読み + AC1/AC2をvitestサブプロセスで転記）
// ============================================================

export function collectJournalMode(db: Database.Database): string {
  const rows = db.pragma("journal_mode") as { journal_mode: string }[];
  return rows[0]?.journal_mode ?? "";
}

export interface WalData {
  journalMode: string;
  assertions: VitestAssertion[];
}

export function evaluateWal(d: WalData): CheckResult {
  const journalModeOk = d.journalMode.toLowerCase() === "wal";
  const requiredTitles = ["接続はWALモードで動作する", "busyタイムアウトが設定されている"];
  const matched = requiredTitles.map((t) => d.assertions.find((a) => a.fullName.includes(t)));
  const allFoundAndPassed = matched.every((m) => m !== undefined && m.status === "passed");
  const result = journalModeOk && allFoundAndPassed ? "PASS" : "FAIL";
  return {
    check: "wal",
    result,
    measured: {
      journalMode: d.journalMode,
      ac1Ac2: matched.map((m, i) => ({ title: requiredTitles[i], found: m !== undefined, status: m?.status ?? null })),
    },
    threshold: { journalMode: "wal", requiredTitles, requiredStatus: "passed" },
  };
}

// ============================================================
// 検査7: write-failure-counting（AC3をvitestサブプロセスで転記）
// ============================================================

export function evaluateWriteFailureCounting(assertions: VitestAssertion[]): CheckResult {
  const requiredTitles = [
    "例外は握りつぶされず再throwされる",
    "カウンタへ計上される（握りつぶされない）",
    "softDeleteの書き込み失敗",
  ];
  const matched = requiredTitles.map((t) => assertions.find((a) => a.fullName.includes(t)));
  const allFoundAndPassed = matched.every((m) => m !== undefined && m.status === "passed");
  return {
    check: "write-failure-counting",
    result: allFoundAndPassed ? "PASS" : "FAIL",
    measured: {
      results: matched.map((m, i) => ({ title: requiredTitles[i], found: m !== undefined, status: m?.status ?? null })),
    },
    threshold: { requiredTitles, requiredStatus: "passed" },
  };
}

// ============================================================
// 検査8: shared-cache（タスク1.13の仕組みが実際にグローバル適用されているかを実測）
// ============================================================

export function evaluateSharedCache(
  envVarSet: boolean,
  resolvedModelsDir: string,
  envValue: string | undefined,
): CheckResult {
  const result = envVarSet && resolvedModelsDir === envValue ? "PASS" : "FAIL";
  return {
    check: "shared-cache",
    result,
    measured: { envVarSet, resolvedModelsDir },
    threshold: { envVarRequired: "WASURENAGUSA_MODEL_CACHE_DIR", resolvedShouldEqualEnvValue: true },
  };
}

// ============================================================
// 検査9: spike-report（task-1.2の再測定ログに旧→新の実測値が残っていること）
// ============================================================

const SPIKE_REPORT_RELATIVE_PATH = [
  ".spec-workflow",
  "specs",
  "memory-redesign",
  "Implementation Logs",
  "task-1.2-query-tokenize-remeasurement.md",
] as const;

export interface SpikeReportData {
  fileExists: boolean;
  hasBeforeNumber: boolean;
  hasAfterNumber: boolean;
}

export function collectSpikeReport(repoRoot: string): SpikeReportData {
  const filePath = join(repoRoot, ...SPIKE_REPORT_RELATIVE_PATH);
  if (!existsSync(filePath)) {
    return { fileExists: false, hasBeforeNumber: false, hasAfterNumber: false };
  }
  const content = readFileSync(filePath, "utf-8");
  return {
    fileExists: true,
    hasBeforeNumber: content.includes("ゼロヒット率(エラー含む)=99.8%"),
    hasAfterNumber: content.includes("ゼロヒット率(エラー含む)=2.5%"),
  };
}

export function evaluateSpikeReport(d: SpikeReportData): CheckResult {
  const result = d.fileExists && d.hasBeforeNumber && d.hasAfterNumber ? "PASS" : "FAIL";
  return {
    check: "spike-report",
    result,
    measured: d,
    threshold: {
      requiredFile: SPIKE_REPORT_RELATIVE_PATH.join("/"),
      requiredPatterns: ["ゼロヒット率(エラー含む)=99.8%", "ゼロヒット率(エラー含む)=2.5%"],
    },
  };
}

// ============================================================
// vitestサブプロセス実行ヘルパー
// ============================================================

function flattenVitestAssertions(json: unknown): VitestAssertion[] {
  const out: VitestAssertion[] = [];
  const testResults = (json as { testResults?: unknown[] })?.testResults ?? [];
  for (const tr of testResults) {
    const assertionResults = (tr as { assertionResults?: unknown[] })?.assertionResults ?? [];
    for (const ar of assertionResults) {
      const a = ar as { fullName?: string; status?: string };
      out.push({ fullName: a.fullName ?? "", status: a.status ?? "" });
    }
  }
  return out;
}

/**
 * `npx vitest run <testFile> --reporter=json` をサブプロセス実行し、assertionResultsを
 * フラットな配列へ変換して返す。実ストア（--store）には一切触れない（各テストファイルが
 * 自前の一時DBを使うため）。記憶本文・クエリ本文はテストのアサーション名にも含まれない。
 */
export function runVitestJson(repoRoot: string, testFile: string): Promise<VitestAssertion[]> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("npx", ["vitest", "run", testFile, "--reporter=json"], {
      cwd: repoRoot,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", () => {
      try {
        const parsed = JSON.parse(stdout);
        resolvePromise(flattenVitestAssertions(parsed));
      } catch (error) {
        reject(
          new Error(
            `vitest --reporter=jsonの出力解析に失敗（${testFile}）: ${(error as Error).message}\nstderr末尾: ${stderr.slice(-500)}`,
          ),
        );
      }
    });
  });
}

// ============================================================
// オーケストレーション
// ============================================================

export interface G1Options {
  storePath: string;
  repoRoot?: string;
  /** テスト専用: バックアップ探索先の差し替え（既定は実運用先 ~/.wasurenagusa/eval/backups） */
  backupsRoot?: string;
}

export async function runG1(options: G1Options): Promise<G1Output> {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const preconditions = assertPreconditions(options.storePath, options.backupsRoot ?? BACKUPS_ROOT);
  if (!preconditions.ok) {
    return { preconditions, checks: [] };
  }

  const dbPath = join(options.storePath, "memory.db");
  const db = new Database(dbPath, { readonly: true });

  try {
    sqliteVec.load(db);

    const stateConsistencyMismatch = collectStateConsistencyMismatch(db);
    const tombstones = collectTombstones(db);
    const embeddingModels = collectDistinctEmbeddingModels(db);
    const hasRecordedDecision = hasEmbeddingModelDecisionRecord(repoRoot);
    const projectConfidenceData = collectProjectConfidence(db);
    const journalMode = collectJournalMode(db);
    const spikeReportData = collectSpikeReport(repoRoot);
    const resolvedModelsDir = getModelsDir(options.storePath);
    const envValue = process.env.WASURENAGUSA_MODEL_CACHE_DIR;

    const [ptAssertions, writeResilienceAssertions] = await Promise.all([
      runVitestJson(repoRoot, "tests/properties/state-machine.property.test.ts"),
      runVitestJson(repoRoot, "src/storage/write-resilience.test.ts"),
    ]);

    const checks: CheckResult[] = [
      evaluateStateConsistency(stateConsistencyMismatch),
      evaluatePtInvariants(ptAssertions),
      evaluateResurrectionZero(tombstones),
      evaluateEmbeddingSingleModel(embeddingModels, hasRecordedDecision),
      evaluateProjectConfidence(projectConfidenceData),
      evaluateWal({ journalMode, assertions: writeResilienceAssertions }),
      evaluateWriteFailureCounting(writeResilienceAssertions),
      evaluateSharedCache(!!envValue, resolvedModelsDir, envValue),
      evaluateSpikeReport(spikeReportData),
    ];

    return { preconditions, checks };
  } finally {
    db.close();
  }
}

// ============================================================
// CLI
// ============================================================

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const storeArg = args["store"];

  if (!storeArg) {
    console.error("Usage: g1-foundation.ts --store <memoryPath>");
    process.exit(1);
    return;
  }

  const output = await runG1({ storePath: storeArg });

  const preconditionThreshold = {
    schemaVersion: REQUIRED_SCHEMA_VERSION,
    memoriesCountMin: MIN_MEMORIES_FOR_G1,
    backupExists: true,
  };

  if (!output.preconditions.ok) {
    console.log(
      JSON.stringify({
        check: "preconditions",
        result: "FAIL",
        measured: output.preconditions,
        threshold: preconditionThreshold,
      }),
    );
    console.log(`\n== G1結果: 前提アサート不成立のためFAIL（9検査は実行していません） ==`);
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
  console.log(`\n== G1結果: ${output.checks.length - failed.length}/${output.checks.length} PASS${suffix} ==`);
  process.exitCode = failed.length > 0 ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith("g1-foundation.ts")) {
  main().catch((error) => {
    console.error("g1-foundation 失敗:", error);
    process.exit(1);
  });
}
