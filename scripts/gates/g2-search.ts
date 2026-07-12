#!/usr/bin/env node
/**
 * scripts/gates/g2-search.ts
 * Phase 2（検索再建）完了ゲート（design.md Phase 2 ③、タスク2.11、R-B2/R-B3/R-B6）。
 *
 * 検証役（qa-engineer）専用資産。実装者は編集しない（design.md「ゲート運用」）。
 *
 * Usage:
 *   node --experimental-specifier-resolution=node --loader ts-node/esm \
 *     scripts/gates/g2-search.ts --store <凍結スナップショットの.wasurenagusaパス> --golden <ゴールデンパス> \
 *     [--baseline-recall5 0.568] [--shadow-report <前後対比レポートパス>] [--self-search-sample 200] \
 *     [--golden-sha256 <凍結時ハッシュ>] [--snapshot-sha256 <凍結時ハッシュ>]
 *
 * 起動方法の注記: g0/g1 と同様、ts-node classic ESM ローダーの相対import解決のため
 * `--experimental-specifier-resolution=node --loader ts-node/esm` の明示指定のみ実機で動く。
 *
 * 設計方針（g0-hemostasis.ts と同型）:
 * - 前提アサート（ゴールデン50問以上・正ゼロ10問以上・両チェックサム一致・memories 1,000件以上）が
 *   1つでも不成立なら、6検査は一切実行せずFAILで終了する（design.md契約どおり・空振り合格の防止）。
 * - 出力形式: 1検査1行のJSON（check, result, measured, threshold）+ 人間可読サマリ。
 *   記憶本文・クエリ本文は一切出力しない（ゴールデンID・件数・順位・真偽値・ハッシュのみ）。
 * - recall/correct-zero は凍結評価器 eval-golden.ts のexportを再利用する（比較原点の同一性を担保）。
 * - self-search は本ゲート内蔵の境界プローブ（代表標本）で退行を検知し、全生存100%の正本は
 *   コミット済みプロパティテスト tests/properties/self-search.property.test.ts（PT-04）が担う。
 * - read-no-side-effect は本番read経路 handleMemorySearch を作業コピーへ実起動し、可変状態
 *   （memories.intensity/timestamp と vector_metadata.access_count）のハッシュ前後一致を検査する。
 * - 凍結スナップショット原本には一切書き込まない。副作用検査・カウンタ検査は mkdtemp の使い捨て
 *   コピーに対して行う（searchHybrid が段発火カウンタを logs/ へ追記し原本を汚すため）。
 */

import Database from "better-sqlite3";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { dirname, join, relative, resolve } from "path";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from "fs";

import { parseArgs, sha256OfFile, EXCLUDED_DIR_NAMES } from "../backup-store.js";
import {
  loadGoldenQueries,
  runGoldenEval,
  summarizeOutcomes,
  evaluateRunIntegrity,
  EVAL_LIMIT,
  type EvalSummary,
} from "./eval-golden.js";
import { SQLiteStorage } from "../../src/storage/sqlite.js";
import { LocalEmbedding } from "../../src/vector/local-embedding.js";
import { config, getModelsDir } from "../../src/config.js";
import { handleMemorySearch } from "../../src/tools/search.js";
import { mutableStateHash } from "../../src/storage/mutable-state-hash.js";
import { hashBody } from "../../src/utils/hash-body.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_REPO_ROOT = resolve(__dirname, "..", "..");

/** recall@5 合格基準の既定値。PdM裁定2026-07-10（タスク2.3で記録した旧検索再測定値0.568）。
 *  tasks.md:556 の「0.500超」は母集団の異なる16問ベンチ値であり、R-B6 AC3が流用を禁じるため使わない。 */
export const BASELINE_RECALL5_DEFAULT = 0.568;
export const MIN_GOLDEN = 50;
export const MIN_CORRECT_ZERO = 10;
export const MIN_MEMORIES = 1000;
export const SELF_SEARCH_SAMPLE_DEFAULT = 200;
export const SELF_SEARCH_TOP_K = 10;
export const SELF_SEARCH_MIN_QUERY_LENGTH = 3;
/** 全生存自己検索性の正本テスト（本ゲートのself-search検査は退行プローブ、正本はこれ）。 */
export const PT04_TEST_PATH = "tests/properties/self-search.property.test.ts";

export interface QuarantineInfo {
  status: "QUARANTINED";
  label: string;
  requirement: string;
  /** 既知の未達状態（xfail-strictの基準）。実測がこれと完全一致するときだけ QUARANTINED（緑）とする。 */
  baselineMeasured: Record<string, number>;
  baselineResult: "FAIL";
  reason: string[];
  reference: string[];
  removal: string;
}

/** 既知baselineからのズレ（改善・劣化・エラーいずれも）＝fail-loudの根拠。 */
export interface QuarantineDrift {
  direction: "improved" | "degraded-or-error";
  message: string;
  expected: { result: string; measured: Record<string, unknown> };
  actual: { result: string; measured: Record<string, unknown> };
}

export interface CheckResult {
  check: string;
  /** QUARANTINED＝仕様見直し保留（既知baseline一致時のみ・緑を妨げない）。baselineからズレたらFAIL（総合赤）にして気づけるようにする。 */
  result: "PASS" | "FAIL" | "QUARANTINED";
  measured: Record<string, unknown>;
  threshold: Record<string, unknown>;
  quarantine?: QuarantineInfo;
  /** 隔離検査が既知baselineからズレてFAILに転じたときの方向・突合情報。 */
  quarantineDrift?: QuarantineDrift;
}

export interface PreconditionResult {
  ok: boolean;
  goldenCount: number;
  correctZeroCount: number;
  goldenChecksumMatch: boolean | "unchecked";
  snapshotChecksumMatch: boolean | "unchecked";
  memoriesCount: number;
  reason?: string;
}

/**
 * 仕様見直し保留（QUARANTINED）検査の明示レジストリ＝隔離の唯一のレバー。
 *
 * 設計意図（オーナー裁定2026-07-11）:
 * - silent skip 禁止。該当検査も必ず実測実行し、実値（例: 0/15）を JSON 行に残したうえで、
 *   総合判定からのみ除外し、理由を大書する（隠蔽でなく監査に裏打ちされた明示保留）。
 * - xfail-strict（恒久マスク化の防止）: 実測が既知 baselineMeasured と完全一致するときだけ QUARANTINED（緑）。
 *   悪化・改善・エラーのいずれでも baseline からズレたら総合を赤（exit 非0）にして必ず気づけるようにする。
 * - このレジストリから該当キーを削除すれば「一発で」通常のハードゲート（FAILで総合赤）へ復帰する。
 *   機構決定後（下記 reference の再設計タスク完了後）に必ず外すこと。恒久除去はしない。
 */
export const QUARANTINED_CHECKS: Record<string, QuarantineInfo> = {
  "correct-zero": {
    status: "QUARANTINED",
    label: "仕様見直し保留（pending redesign）",
    requirement: "R-B6 AC4（無関連クエリは0件）",
    // 既知の未達状態＝15問全てで0件化に失敗（0/15）。これと完全一致するときのみ QUARANTINED（緑）。
    // 改善（zeroCorrectCount増）・劣化・構造変化（zeroQueries≠15）・エラーはいずれも baseline ズレ＝赤。
    baselineMeasured: { zeroQueries: 15, zeroCorrectCount: 0 },
    baselineResult: "FAIL",
    reason: [
      "correct-zero は現機構では原理的に達成不能のため、失敗ではなく仕様見直し保留として隔離する（オーナー裁定2026-07-11：改善は出荷・correct-zeroは別枠で再設計・過剰機構は作らない）。",
      "独立ラベル監査: 「正しくゼロ件」15問中12問が“いまエージェント/チームがどの状態か”を問うライブ状態照会（state-probe）。本番運用ではこの種を検索に流さない設計＝本番では起きない場面を試験している。",
      "ラベル誤りはゼロ（clearly-relevant 0/15・defensible-zero 12/15・questionable 3/15）。再ラベルでは解けない（＝ラベル修正では回避不能）。",
      "R-B6 AC4 は「無関連＝埋め込み距離が遠い」を仮定するが、実体は「無関連＝回答可能性が無い」。距離では判別できない軸を要求している。",
      "分離不能を証明: correct-zero の最近傍距離帯[0.4355, 0.5388]が hit の正解距離帯[0.37, 0.5577]に完全内包し分離帯が無い。全15問を0件化するとF<0.4355が必要となり recall@5 が 8/37=0.216 へ崩落、合格基準>0.568 を割る。単調フロアは数学的に存在しない（反例: correct-zero GQ-049=0.4355 が hit GQ-001 の正解0.5196 より近い）。",
      "現機構での0件化は不能。是正は別枠の再設計（回答可能性ゲートの機構決定）に委ねる。過剰機構（LLM関連度ゲート・埋め込みモデル更新）は今回作らない。",
    ],
    reference: [
      "再設計タスク: tasks.md タスク2.13（correct-zero再設計）",
      "要件注記: requirements.md R-B6 AC4（仕様見直し保留）",
      "設計注記: design.md Phase2 ③ G2契約 correct-zero 項",
      "監査根拠: 検証役独立監査 correct-zero-label-audit.md・correct-zero-report.md（分離不能の証明つき）",
    ],
    removal: "本レジストリ QUARANTINED_CHECKS から \"correct-zero\" を削除すれば一発でハードゲート（FAILで総合赤）へ復帰する。機構決定後に外すこと。",
  },
};

/** 実測が既知 baselineMeasured（と baselineResult）に完全一致するか。 */
function matchesBaseline(check: CheckResult, q: QuarantineInfo): boolean {
  if (check.result !== q.baselineResult) return false;
  for (const [k, v] of Object.entries(q.baselineMeasured)) {
    if (check.measured[k] !== v) return false;
  }
  return true;
}

/**
 * 明示隔離の適用（xfail-strict）。QUARANTINED_CHECKS に載る検査について:
 * - 実測が既知 baseline と完全一致 → result を "QUARANTINED" に置換（実測値は保持・総合判定で非FAIL＝緑を妨げない）。
 * - baseline からズレ（改善・劣化・エラーのいずれも）→ result を "FAIL" に固定し（総合赤）、方向つきの
 *   quarantineDrift を添付して大書通知する。＝恒久マスクにならず「壊れたら（あるいは想定外に直ったら）分かる」。
 * 非隔離の検査はそのまま返す。
 */
export function applyQuarantine(check: CheckResult): CheckResult {
  const q = QUARANTINED_CHECKS[check.check];
  if (!q) return check;
  if (matchesBaseline(check, q)) {
    return { ...check, result: "QUARANTINED", quarantine: q };
  }
  // 既知baselineからのズレ＝fail-loud。想定外PASS（XPASS）は「改善＝隔離解除検討」、それ以外は「劣化/エラー＝要調査」。
  const improved = check.result === "PASS";
  const drift: QuarantineDrift = {
    direction: improved ? "improved" : "degraded-or-error",
    message: improved
      ? `隔離検査 ${check.check} が既知の未達状態から想定外にPASSした（XPASS）。分離機構が成立した可能性＝タスク2.13で隔離解除（QUARANTINED_CHECKSからキー削除）を検討すること。`
      : `隔離検査 ${check.check} の実測が既知baselineからズレた（劣化またはエラー）。既知値と実測を突合し要調査。改善方向なら2.13で隔離解除を検討。`,
    expected: { result: q.baselineResult, measured: q.baselineMeasured },
    actual: { result: check.result, measured: check.measured },
  };
  return { ...check, result: "FAIL", quarantine: q, quarantineDrift: drift };
}

// ============================================================
// 前提アサート（design.md契約: 不成立なら6検査を実行せずFAIL）
// ============================================================

export function assertPreconditions(
  storePath: string,
  goldenPath: string,
  expectedGoldenSha?: string,
  expectedSnapshotSha?: string,
): PreconditionResult {
  const dbPath = join(storePath, config.sqliteFile);
  const result: PreconditionResult = {
    ok: false,
    goldenCount: 0,
    correctZeroCount: 0,
    goldenChecksumMatch: "unchecked",
    snapshotChecksumMatch: "unchecked",
    memoriesCount: 0,
  };

  if (!existsSync(goldenPath)) {
    result.reason = "ゴールデンセットが存在しない";
    return result;
  }
  if (!existsSync(dbPath)) {
    result.reason = "スナップショットDBが存在しない";
    return result;
  }

  const golden = loadGoldenQueries(goldenPath);
  result.goldenCount = golden.length;
  result.correctZeroCount = golden.filter((g) => g.expect === "correct-zero").length;

  if (expectedGoldenSha) {
    result.goldenChecksumMatch = sha256OfFile(goldenPath) === expectedGoldenSha;
  }
  if (expectedSnapshotSha) {
    result.snapshotChecksumMatch = sha256OfFile(dbPath) === expectedSnapshotSha;
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    result.memoriesCount = (db.prepare("SELECT COUNT(*) c FROM memories").get() as { c: number }).c;
  } finally {
    db.close();
  }

  if (result.goldenCount < MIN_GOLDEN) result.reason = `ゴールデン${result.goldenCount}問 < ${MIN_GOLDEN}`;
  else if (result.correctZeroCount < MIN_CORRECT_ZERO)
    result.reason = `正ゼロ${result.correctZeroCount}問 < ${MIN_CORRECT_ZERO}`;
  else if (result.goldenChecksumMatch === false) result.reason = "ゴールデンチェックサム不一致";
  else if (result.snapshotChecksumMatch === false) result.reason = "スナップショットチェックサム不一致";
  else if (result.memoriesCount < MIN_MEMORIES) result.reason = `memories${result.memoriesCount}件 < ${MIN_MEMORIES}`;
  else result.ok = true;

  return result;
}

// ============================================================
// 検査（純粋評価は分離してテスト可能に）
// ============================================================

/** recall検査: recall@5 が基準値を超えること（design.md「超えること」= 厳密に上回る）。 */
export function evaluateRecall(summary: EvalSummary, baselineRecall5: number): CheckResult {
  return {
    check: "recall",
    result: summary.recallAt5 > baselineRecall5 ? "PASS" : "FAIL",
    measured: { recallAt1: summary.recallAt1, recallAt5: summary.recallAt5, recallAt10: summary.recallAt10, hitQueries: summary.hitQueries },
    threshold: { recallAt5MustExceed: baselineRecall5 },
  };
}

/** correct-zero検査: 「正しくゼロ件」クラス全問で0件（design.md契約・R-B6 AC4）。 */
export function evaluateCorrectZero(summary: EvalSummary): CheckResult {
  return {
    check: "correct-zero",
    result: summary.zeroCorrectCount === summary.zeroQueries ? "PASS" : "FAIL",
    measured: { zeroQueries: summary.zeroQueries, zeroCorrectCount: summary.zeroCorrectCount },
    threshold: { allMustReturnZero: true },
  };
}

// hashBody・mutableStateHash は共有正本（src/utils/hash-body.ts, src/storage/mutable-state-hash.ts）
// をimportして使う（cr-verify-07・cr-verify-16。単体テスト側と基準の乖離を防ぐ）。

// ============================================================
// 収集＋オーケストレーション
// ============================================================

interface G2Options {
  storePath: string;
  goldenPath: string;
  baselineRecall5: number;
  shadowReportPath?: string;
  selfSearchSample: number;
  expectedGoldenSha?: string;
  expectedSnapshotSha?: string;
  repoRoot?: string;
}

/** 作業用の使い捨てコピーを作る（原本の凍結保護）。
 *  models/（埋め込みモデルキャッシュ、実測552MB）は backup-store.ts の EXCLUDED_DIR_NAMES に
 *  倣って複製せず除外する（cr-verify-06a。本ゲートは1回の実行で最大4回複製するため、除外なしだと
 *  桁で無駄なI/Oコストになる）。除外後もモデル解決を保つため、除外ディレクトリはシンボリックリンクで
 *  原本を指す（複製ゼロで読み取り専用の共有・getModelsDir経由の全呼び出しが透過的に原本を読む）。
 *  rmSync(recursive)はシンボリックリンク自体だけを外し、リンク先の実体は削除しない（fs.rmSync実行時
 *  にシンボリックリンクをunlinkするのみで、target側を再帰走査しないため）。 */
function freshCopy(storePath: string): { dir: string; storeDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "g2-"));
  const storeDir = join(dir, ".wasurenagusa");
  cpSync(storePath, storeDir, {
    recursive: true,
    filter: (src: string) => {
      const relPath = relative(storePath, src);
      if (EXCLUDED_DIR_NAMES.has(relPath) && existsSync(src) && statSync(src).isDirectory()) {
        return false;
      }
      return true;
    },
  });
  for (const name of EXCLUDED_DIR_NAMES) {
    const originalDir = join(storePath, name);
    if (existsSync(originalDir)) {
      symlinkSync(originalDir, join(storeDir, name), "dir");
    }
  }
  return { dir, storeDir };
}

/** checkSelfSearch・checkFallbackCounters が重複していたストレージ＋埋め込みの初期化4行の抽出
 *  （cr-verify-08）。初期化失敗時（拡張ロード失敗等）もストレージ接続を確実に閉じてリークを防ぐ
 *  （cr-verify-01と同型の防御。コンストラクタで既に開いた接続をここで漏らさない）。 */
async function openStorageAndEmbedding(
  dbPath: string,
  storeDir: string,
): Promise<{ storage: SQLiteStorage; embedding: LocalEmbedding }> {
  const storage = new SQLiteStorage(dbPath);
  try {
    storage.initialize(storeDir);
    const embedding = new LocalEmbedding(getModelsDir(storeDir));
    await embedding.initialize();
    return { storage, embedding };
  } catch (error) {
    storage.close();
    throw error;
  }
}

/** self-search 退行プローブ（境界標本・群単位）。全生存100%の正本はPT-04テスト。
 *  searchHybridが段発火カウンタを logs/ へ追記するため使い捨てコピー上で実行し、凍結原本を汚さない。 */
async function checkSelfSearch(storePath: string, sample: number, repoRoot: string): Promise<CheckResult> {
  const { dir, storeDir } = freshCopy(storePath);
  const pt04Present = existsSync(join(repoRoot, PT04_TEST_PATH));
  try {
    const dbPath = join(storeDir, config.sqliteFile);
    const db = new Database(dbPath, { readonly: true });
    const alive = db
      .prepare("SELECT id, content FROM memories WHERE state = 'active' ORDER BY id")
      .all() as { id: string; content: string }[];
    db.close();

    const eligible = alive.filter((r) => (r.content ?? "").trim().length >= SELF_SEARCH_MIN_QUERY_LENGTH);
    const excluded = alive.length - eligible.length;

    // 全コーパスで本文群化（PT-04と同基準）: 同一本文群のいずれか1件がtop-10に入れば群成立。
    // 標本内だけで群化すると、標本外に重複本文を持つエントリを誤FAIL計上するため全生存で群を張る。
    const fullGroups = new Map<string, string[]>();
    for (const r of eligible) {
      const h = hashBody(r.content.trim());
      if (!fullGroups.has(h)) fullGroups.set(h, []);
      fullGroups.get(h)!.push(r.id);
    }

    // 標本抽出: 決定論順（本文ハッシュ順）で先頭sample群を代表本文として検査する。
    const bodyHashes = [...fullGroups.keys()].sort();
    const pickedHashes = bodyHashes.slice(0, Math.min(sample, bodyHashes.length));
    const repContentByHash = new Map<string, string>();
    for (const r of eligible) {
      const h = hashBody(r.content.trim());
      if (!repContentByHash.has(h)) repContentByHash.set(h, r.content);
    }

    const { storage, embedding } = await openStorageAndEmbedding(dbPath, storeDir);
    if (!embedding.isAvailable()) {
      storage.close();
      return {
        check: "self-search",
        result: "FAIL",
        measured: { reason: "embedding-unavailable", sampledGroups: pickedHashes.length },
        threshold: { failedGroupsMax: 0, pt04TestPresent: true },
      };
    }

    let failedGroups = 0;
    const failedSample: string[] = [];
    try {
      for (const h of pickedHashes) {
        const repContent = repContentByHash.get(h)!;
        const memberIds = fullGroups.get(h)!; // 全コーパスの群メンバ
        const emb = await embedding.embed(repContent, "query");
        const res = storage.searchHybrid({ query: repContent, category: "all", limit: SELF_SEARCH_TOP_K }, emb);
        const top = new Set(res.results.slice(0, SELF_SEARCH_TOP_K).map((e) => e.id));
        if (!memberIds.some((id) => top.has(id))) {
          failedGroups += 1;
          if (failedSample.length < 10) failedSample.push(memberIds[0]);
        }
      }
    } finally {
      storage.close();
    }

    return {
      check: "self-search",
      result: failedGroups === 0 && pt04Present ? "PASS" : "FAIL",
      measured: { sampledGroups: pickedHashes.length, totalGroups: fullGroups.size, failedGroups, failedSampleIds: failedSample, excludedShort: excluded, pt04TestPresent: pt04Present },
      threshold: { failedGroupsMax: 0, pt04TestPresent: true, note: "全生存100%の正本はPT-04テスト。本検査は全コーパス群単位の境界標本退行プローブ" },
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** read-no-side-effect: 本番read経路を実起動し可変状態が不変か（R-B2 AC3）。 */
async function checkReadNoSideEffect(storePath: string): Promise<CheckResult> {
  const { dir, storeDir } = freshCopy(storePath);
  try {
    const dbPath = join(storeDir, config.sqliteFile);
    // 操作ログ（logs/*.jsonl）はread結果に無関係だが未作成だとmkdir競合するため事前作成。
    mkdirSync(join(storeDir, "logs"), { recursive: true });
    const before = mutableStateHash(dbPath);
    // getMemoryPath(projectRoot)=resolve(projectRoot, ".wasurenagusa") が storeDir を指すよう mkdtemp親を渡す。
    const projectRoot = dir;
    // クエリは既存エントリの本文そのもの（自己クエリ）を使う。距離≈0でsearchVectors(medium)が必ず当該
    // ベクトルを返し、read経路を確実にヒットさせる（invoked>0の母数を稼ぐ）。旧実装にあった
    // アクセス計数の書き込み・破壊的critical自動昇格はこの読み経路から既に撤去済み（タスク2.7・R-B2 AC3、
    // src/tools/search.ts参照）で、この検査が発火を保証する対象ではない。goldenクエリだとヒット自体が
    // 起きず「呼び出しはしたが実質何も検証していない」偽陰性になるため、自己クエリで確実にヒットさせる。
    const probeDb = new Database(dbPath, { readonly: true });
    const probeRows = probeDb
      .prepare("SELECT content FROM memories WHERE state = 'active' AND length(trim(content)) >= 20 ORDER BY id LIMIT 5")
      .all() as { content: string }[];
    probeDb.close();
    let invoked = 0;
    for (const row of probeRows) {
      try {
        await handleMemorySearch({ query: row.content, limit: EVAL_LIMIT }, projectRoot);
        invoked += 1;
      } catch {
        /* 起動失敗はinvoked未加算で検知 */
      }
    }
    // fire-and-forgetの操作ログ書き込み（best-effort）を沈静化させてから後測ハッシュを採る。
    await new Promise((r) => setTimeout(r, 300));
    const after = mutableStateHash(dbPath);
    const memUnchanged = before.memories === after.memories;
    const vmUnchanged = before.vectorMeta === after.vectorMeta;
    return {
      check: "read-no-side-effect",
      result: invoked > 0 && memUnchanged && vmUnchanged ? "PASS" : "FAIL",
      measured: {
        invoked,
        memoriesIntensityTimestampUnchanged: memUnchanged,
        vectorMetaAccessCountUnchanged: vmUnchanged,
      },
      threshold: { invokedMin: 1, allMutableStateUnchanged: true, requirement: "R-B2 AC3" },
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** fallback-counters: 検索実行で各段の発火計数がJSONLへ出力されること。 */
async function checkFallbackCounters(storePath: string, goldenPath: string): Promise<CheckResult> {
  const { dir, storeDir } = freshCopy(storePath);
  try {
    const dbPath = join(storeDir, config.sqliteFile);
    const { storage, embedding } = await openStorageAndEmbedding(dbPath, storeDir);
    try {
      const golden = loadGoldenQueries(goldenPath).slice(0, 5);
      if (embedding.isAvailable()) {
        for (const g of golden) {
          const emb = await embedding.embed(g.query, "query");
          storage.searchHybrid({ query: g.query, category: "all", limit: EVAL_LIMIT }, emb);
        }
      }
    } finally {
      storage.close();
    }
    // カウンタ書き込みは void increment(...).catch(() => {}) の fire-and-forget であり、直後にログを
    // 読むと未着地の競合になり得る。checkReadNoSideEffect と同じ300ms待機で沈静化させてから読む
    // （cr-verify-14）。
    await new Promise((r) => setTimeout(r, 300));
    const logsDir = join(storeDir, "logs");
    let stageEvents = 0;
    let corruptLineCount = 0;
    const stagesSeen = new Set<string>();
    if (existsSync(logsDir)) {
      for (const f of readdirSync(logsDir).filter((n) => n.startsWith("counters-") && n.endsWith(".jsonl"))) {
        for (const line of readFileSync(join(logsDir, f), "utf8").split(/\n/).filter(Boolean)) {
          try {
            const o = JSON.parse(line) as Record<string, unknown>;
            const metric = String(o.metric ?? o.name ?? "");
            if (/fallback|stage|フォールバック|段/.test(metric) || o.stage !== undefined) {
              stageEvents += 1;
              if (o.stage !== undefined) stagesSeen.add(String(o.stage));
            }
          } catch {
            // JSON.parse失敗行は無言破棄せず件数化して可視化する（src/observability/counters.ts の
            // corruptLineCount方式に倣う。cr-verify-14）。
            corruptLineCount += 1;
          }
        }
      }
    }
    return {
      check: "fallback-counters",
      result: stageEvents > 0 ? "PASS" : "FAIL",
      measured: { stageEvents, stagesSeen: [...stagesSeen], corruptLineCount },
      threshold: { stageEventsMin: 1 },
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** shadow-report: 前後対比レポートが存在し、新系が主要指標で旧系以上（R-B6 AC5）。 */
export function checkShadowReport(reportPath: string | undefined, currentRecall5: number, baselineRecall5: number): CheckResult {
  const exists = !!reportPath && existsSync(reportPath);
  const currentAtLeastBaseline = currentRecall5 >= baselineRecall5;
  return {
    check: "shadow-report",
    result: exists && currentAtLeastBaseline ? "PASS" : "FAIL",
    measured: { reportExists: exists, reportPath: reportPath ?? null, currentRecall5, baselineRecall5, currentAtLeastBaseline },
    threshold: { reportMustExist: true, currentRecall5MustBeAtLeastBaseline: true, requirement: "R-B6 AC5" },
  };
}

export interface G2Output {
  preconditions: PreconditionResult;
  checks: CheckResult[];
}

export async function runG2(options: G2Options): Promise<G2Output> {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const pre = assertPreconditions(options.storePath, options.goldenPath, options.expectedGoldenSha, options.expectedSnapshotSha);
  if (!pre.ok) return { preconditions: pre, checks: [] };

  // recall / correct-zero: 凍結評価器を原本コピーで実行（searchHybridはデータ非破壊だがカウンタ追記のためコピー推奨）。
  const { dir, storeDir } = freshCopy(options.storePath);
  let recallCheck: CheckResult;
  let correctZeroCheck: CheckResult;
  let integrityCheck: CheckResult;
  let currentRecall5 = 0;
  try {
    const run = await runGoldenEval(storeDir, options.goldenPath);
    const summary = summarizeOutcomes(run.outcomes);
    currentRecall5 = summary.recallAt5;
    recallCheck = evaluateRecall(summary, options.baselineRecall5);
    correctZeroCheck = evaluateCorrectZero(summary);
    const integ = evaluateRunIntegrity(loadGoldenQueries(options.goldenPath).length, run.outcomes.length, run.failures.length);
    integrityCheck = { check: integ.check, result: integ.result, measured: integ.measured, threshold: integ.threshold };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const selfSearch = await checkSelfSearch(options.storePath, options.selfSearchSample, repoRoot);
  const readNoSide = await checkReadNoSideEffect(options.storePath);
  const fallbackCounters = await checkFallbackCounters(options.storePath, options.goldenPath);
  const shadow = checkShadowReport(options.shadowReportPath, currentRecall5, options.baselineRecall5);

  return {
    preconditions: pre,
    // 明示隔離を最後に適用（該当検査は実測実行済み・実値を保持したまま総合判定からのみ除外）。
    checks: [integrityCheck, recallCheck, correctZeroCheck, selfSearch, readNoSide, fallbackCounters, shadow].map(applyQuarantine),
  };
}

// ============================================================
// CLI
// ============================================================

/** 本番read経路の best-effort 操作ログ（fire-and-forget）はread結果に無関係。
 *  そのタイムアウト/使い捨てコピー破棄時のENOENTだけを限定的に握り潰し、他の例外はそのまま落とす。 */
function isBenignLogNoise(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /logOperation timeout/.test(msg) || (/ENOENT/.test(msg) && /[/\\]g2-[^/\\]+[/\\]/.test(msg));
}

async function main(): Promise<void> {
  process.on("unhandledRejection", (reason) => {
    if (!isBenignLogNoise(reason)) throw reason;
  });
  process.on("uncaughtException", (err) => {
    if (!isBenignLogNoise(err)) {
      console.error(err);
      process.exit(1);
    }
  });
  const args = parseArgs(process.argv.slice(2));
  const storeArg = args["store"];
  const goldenArg = args["golden"];
  if (!storeArg || !goldenArg) {
    console.error("Usage: g2-search.ts --store <storePath> --golden <goldenPath> [--baseline-recall5 N] [--shadow-report P] [--self-search-sample N] [--golden-sha256 H] [--snapshot-sha256 H]");
    process.exit(1);
    return;
  }

  const output = await runG2({
    storePath: storeArg,
    goldenPath: goldenArg,
    baselineRecall5: args["baseline-recall5"] ? Number(args["baseline-recall5"]) : BASELINE_RECALL5_DEFAULT,
    shadowReportPath: args["shadow-report"],
    selfSearchSample: args["self-search-sample"] ? Number(args["self-search-sample"]) : SELF_SEARCH_SAMPLE_DEFAULT,
    expectedGoldenSha: args["golden-sha256"],
    expectedSnapshotSha: args["snapshot-sha256"],
  });

  const preThreshold = { goldenMin: MIN_GOLDEN, correctZeroMin: MIN_CORRECT_ZERO, memoriesMin: MIN_MEMORIES, checksumsMustMatch: true };
  if (!output.preconditions.ok) {
    console.log(JSON.stringify({ check: "preconditions", result: "FAIL", measured: output.preconditions, threshold: preThreshold }));
    console.log(`\n== G2結果: 前提アサート不成立のためFAIL（検査は実行していません） ==`);
    console.log(`理由: ${output.preconditions.reason}`);
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({ check: "preconditions", result: "PASS", measured: output.preconditions, threshold: preThreshold }));
  for (const c of output.checks) console.log(JSON.stringify(c));

  const failed = output.checks.filter((c) => c.result === "FAIL");
  const quarantined = output.checks.filter((c) => c.result === "QUARANTINED");
  const passed = output.checks.filter((c) => c.result === "PASS");

  // 隔離検査を大書（silent skip でないことを目視保証）。実測値・理由・参照・解除方法を全出力する。
  const bar = "━".repeat(72);
  for (const q of quarantined) {
    const info = q.quarantine;
    if (!info) continue;
    console.log(`\n${bar}`);
    console.log(`【QUARANTINED ／ ${info.label}】 検査: ${q.check}（${info.requirement}）`);
    console.log(`実測（隠さず表示）: ${JSON.stringify(q.measured)}`);
    console.log("理由:");
    for (const line of info.reason) console.log(`  ・${line}`);
    console.log("参照:");
    for (const ref of info.reference) console.log(`  - ${ref}`);
    console.log(`隔離解除: ${info.removal}`);
    console.log(bar);
  }

  // 隔離検査が既知baselineからズレた場合は大書で赤通知（xfail-strict）。恒久マスクにせず「壊れたら/直ったら分かる」。
  const drifted = failed.filter((c) => c.quarantineDrift);
  for (const d of drifted) {
    const dr = d.quarantineDrift!;
    console.log(`\n${bar}`);
    console.log(`【FAIL ／ 隔離baselineからのズレ検知（xfail-strict）】 検査: ${d.check}`);
    console.log(`方向: ${dr.direction === "improved" ? "改善（XPASS＝想定外にPASS）" : "劣化またはエラー"}`);
    console.log(`通知: ${dr.message}`);
    console.log(`既知baseline: result=${dr.expected.result} measured=${JSON.stringify(dr.expected.measured)}`);
    console.log(`今回実測    : result=${JSON.stringify(dr.actual.result)} measured=${JSON.stringify(dr.actual.measured)}`);
    console.log(`→ 総合を赤（exit 1）に固定。恒久マスクではないため放置不可。`);
    console.log(bar);
  }

  const effectiveTotal = passed.length + failed.length;
  const verdict = failed.length === 0 ? "緑（exit 0）" : "赤（exit 1）";
  const qNote = quarantined.length > 0 ? ` ＋ ${quarantined.length} QUARANTINED（${quarantined.map((q) => q.check).join(", ")}）` : "";
  const failNote = failed.length > 0 ? ` ／ FAIL: ${failed.map((f) => f.check).join(", ")}` : "";
  console.log(`\n== G2結果: 実効 ${passed.length}/${effectiveTotal} PASS${qNote} → 総合: ${verdict}${failNote} ==`);
  process.exitCode = failed.length > 0 ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith("g2-search.ts")) {
  main().catch((error) => {
    console.error("g2-search 失敗:", error);
    process.exit(1);
  });
}
