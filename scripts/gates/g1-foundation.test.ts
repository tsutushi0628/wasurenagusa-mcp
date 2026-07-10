/**
 * scripts/gates/g1-foundation.test.ts
 *
 * Phase 1（土台）完了ゲートの業務要件を検証する（タスク1.14、design.md Phase 1 ③の契約）。
 *
 * 業務要件:
 * 1. 前提アサート（schema_versionのMAXが6／memories総件数1,000件以上／バックアップ存在）が
 *    1つでも不成立なら、9検査を一切実行せずFAILで終了する
 * 2. 合成fixture（機構検証専用、tests/fixtures/mini-store/のbuildMiniStoreを再利用）に対して
 *    全9項目PASSする
 * 3. 意図的な違反状態（蘇生状態=deleted済みメモリにvector行が残存）ではresurrection-zero検査
 *    のみがFAILし、他の検査は実行される
 * 4. 各評価関数（evaluate*）は合成データを直接渡した単体でPASS/FAIL判定が正しい
 * 5. 実データ収集関数（collect*）は実スキーマに対する直接SQLとして正しい値を返す
 *
 * pt-invariants/wal/write-failure-counting検査は `npx vitest run <file> --reporter=json`
 * をサブプロセス実行するため、統合テストは相応に時間がかかる（INTEGRATION_TIMEOUT_MS参照）。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

import { buildMiniStore } from "../../tests/fixtures/mini-store/build-mini-store.js";
import { backupStore } from "../backup-store.js";
import {
  assertPreconditions,
  hasAnyBackup,
  runG1,
  collectStateConsistencyMismatch,
  collectTombstones,
  collectDistinctEmbeddingModels,
  collectProjectConfidence,
  collectJournalMode,
  collectSpikeReport,
  hasEmbeddingModelDecisionRecord,
  evaluateStateConsistency,
  evaluatePtInvariants,
  evaluateResurrectionZero,
  evaluateEmbeddingSingleModel,
  evaluateProjectConfidence,
  evaluateWal,
  evaluateWriteFailureCounting,
  evaluateSharedCache,
  evaluateSpikeReport,
  REQUIRED_SCHEMA_VERSION,
  MIN_MEMORIES_FOR_G1,
} from "./g1-foundation.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const INTEGRATION_TIMEOUT_MS = 60000;

const scratchDirs: string[] = [];
function newScratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** schema_version/memoriesの最小列だけを持つ、前提アサート専用の手組みDBを作る
 *  （schema_versionの不整合パターンを、フルスキーマ抜きで軽量に再現するため）。 */
function buildBareDb(dbPath: string, schemaVersion: number, memoriesCount: number): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT);
    CREATE TABLE memories (id TEXT PRIMARY KEY);
  `);
  db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(schemaVersion, "2026-07-10T00:00:00+09:00");
  const insert = db.prepare("INSERT INTO memories (id) VALUES (?)");
  for (let i = 0; i < memoriesCount; i++) insert.run(`bare-${i}`);
  db.close();
}

describe("hasAnyBackup / assertPreconditions", () => {
  it("バックアップ先ディレクトリ自体が存在しなければfalse", () => {
    const backupsRoot = join(newScratchDir("g1-backup-root-"), "does-not-exist");
    const storePath = join(newScratchDir("g1-project-"), "sample-project", ".wasurenagusa");
    expect(hasAnyBackup(storePath, backupsRoot)).toBe(false);
  });

  it("該当プロジェクトのmanifest.jsonが存在すればtrue", async () => {
    const backupsRoot = newScratchDir("g1-backup-root-ok-");
    const projectDir = newScratchDir("g1-project-ok-");
    const storePath = join(projectDir, ".wasurenagusa");
    buildMiniStore(storePath, { count: 5 });
    const projectName = "sample-project-ok";
    await backupStore(storePath, join(backupsRoot, "20260710", projectName));

    // hasAnyBackupはstorePathの親ディレクトリ名からprojectNameを導く規約のため、
    // 実際のプロジェクトディレクトリ名をprojectNameに合わせて検証する
    const namedProjectDir = join(dirname(projectDir), projectName);
    mkdirSync(namedProjectDir, { recursive: true });
    const namedStorePath = join(namedProjectDir, ".wasurenagusa");
    buildMiniStore(namedStorePath, { count: 5 });

    expect(hasAnyBackup(namedStorePath, backupsRoot)).toBe(true);
  });

  it("memories 1,000件未満・schema v6・バックアップありは、memories件数不足でFAILする", async () => {
    const backupsRoot = newScratchDir("g1-precond-small-backup-");
    const projectName = "g1-precond-small";
    const projectDir = join(newScratchDir("g1-precond-small-parent-"), projectName);
    mkdirSync(projectDir, { recursive: true });
    const storePath = join(projectDir, ".wasurenagusa");
    buildMiniStore(storePath, { count: 30 });
    await backupStore(storePath, join(backupsRoot, "20260710", projectName));

    const result = assertPreconditions(storePath, backupsRoot);
    expect(result.ok).toBe(false);
    expect(result.memoriesCount).toBe(30);
    expect(result.schemaVersionOk).toBe(true);
    expect(result.backupExists).toBe(true);
    expect(result.reason).toContain("1000件未満");
  });

  it("schema_versionが6でない（旧世代のまま）はschemaVersionOk=falseでFAILする", () => {
    const backupsRoot = newScratchDir("g1-precond-schema-backup-");
    const projectDir = newScratchDir("g1-precond-schema-");
    const storePath = join(projectDir, ".wasurenagusa");
    mkdirSync(storePath, { recursive: true });
    buildBareDb(join(storePath, "memory.db"), 5, 1000);

    const result = assertPreconditions(storePath, backupsRoot);
    expect(result.ok).toBe(false);
    expect(result.schemaVersionOk).toBe(false);
    expect(result.maxSchemaVersion).toBe(5);
    expect(result.reason).toContain(`v${REQUIRED_SCHEMA_VERSION}`);
  });

  it("memories 1,000件以上・schema v6だがバックアップが見つからないとFAILする", () => {
    const backupsRoot = newScratchDir("g1-precond-nobackup-root-");
    const projectDir = newScratchDir("g1-precond-nobackup-");
    const storePath = join(projectDir, ".wasurenagusa");
    buildMiniStore(storePath, { count: MIN_MEMORIES_FOR_G1 });

    const result = assertPreconditions(storePath, backupsRoot);
    expect(result.ok).toBe(false);
    expect(result.backupExists).toBe(false);
    expect(result.reason).toContain("バックアップ");
  });

  it("DBが存在しないストアはdbOpens=falseでFAILする", () => {
    const backupsRoot = newScratchDir("g1-precond-nodb-backup-");
    const projectDir = newScratchDir("g1-precond-nodb-");
    const storePath = join(projectDir, ".wasurenagusa");
    mkdirSync(storePath, { recursive: true });

    const result = assertPreconditions(storePath, backupsRoot);
    expect(result.ok).toBe(false);
    expect(result.dbOpens).toBe(false);
    expect(result.reason).toBe("DBが開けません");
  });
});

describe("runG1: 前提アサート不成立時は9検査を実行せずFAILする", () => {
  it("小さすぎるストアではchecksが空配列で返る", async () => {
    const backupsRoot = newScratchDir("g1-run-precond-fail-backup-");
    const projectDir = newScratchDir("g1-run-precond-fail-");
    const storePath = join(projectDir, ".wasurenagusa");
    buildMiniStore(storePath, { count: 10 });

    const output = await runG1({ storePath, backupsRoot, repoRoot: REPO_ROOT });

    expect(output.preconditions.ok).toBe(false);
    expect(output.checks).toEqual([]);
  });
});

describe("collect*: 実データ収集関数の単体テスト（実スキーマに対する直接SQL）", () => {
  it("collectStateConsistencyMismatch: state/deleted_atが常時同期していれば0件", () => {
    const projectDir = newScratchDir("g1-collect-state-");
    const storePath = join(projectDir, ".wasurenagusa");
    buildMiniStore(storePath, { count: 20, softDeleteCount: 2, resurrectionCount: 0 });

    const db = new Database(join(storePath, "memory.db"), { readonly: true });
    try {
      expect(collectStateConsistencyMismatch(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  it("collectTombstones: 蘇生件数指定どおりにvectors件数が計上される", () => {
    const projectDir = newScratchDir("g1-collect-tombstones-");
    const storePath = join(projectDir, ".wasurenagusa");
    buildMiniStore(storePath, { count: 20, softDeleteCount: 2, resurrectionCount: 1 });

    const db = new Database(join(storePath, "memory.db"), { readonly: true });
    try {
      sqliteVec.load(db);
      const tombstones = collectTombstones(db);
      expect(tombstones.memories).toBe(2);
      expect(tombstones.vectors).toBe(1);
    } finally {
      db.close();
    }
  });

  it("collectDistinctEmbeddingModels: buildMiniStoreは単一モデルのみを使う", () => {
    const projectDir = newScratchDir("g1-collect-model-");
    const storePath = join(projectDir, ".wasurenagusa");
    buildMiniStore(storePath, { count: 20 });

    const db = new Database(join(storePath, "memory.db"), { readonly: true });
    try {
      const models = collectDistinctEmbeddingModels(db);
      expect(models).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("collectProjectConfidence: buildMiniStoreはproject列に実名を入れるがprojectConfidenceを渡さないためunknown一色になり、project列自体はnull/'unknown'文字列を含まずpassthroughは0件で一致する", () => {
    const projectDir = newScratchDir("g1-collect-pc-");
    const storePath = join(projectDir, ".wasurenagusa");
    // softDeleteCount:0で固定し、論理削除の混入なしにproject-confidence分布だけを検証する
    // （collectProjectConfidenceはdeleted_at IS NULLで絞るため、既定softDeleteCount=2のままだと
    // 母数が18件になり検証がsoft-delete件数に依存してしまう）
    buildMiniStore(storePath, { count: 20, softDeleteCount: 0 });

    const db = new Database(join(storePath, "memory.db"), { readonly: true });
    try {
      const data = collectProjectConfidence(db);
      // project列（sample-webapp等の実名）はnull/'unknown'文字列を含まないため0件
      expect(data.expectedUnknownOrNullCount).toBe(0);
      expect(data.passthroughSentinelCount).toBe(0);
      // project_confidence列は、storage.save()を直接呼ぶbuildMiniStoreがprojectConfidence引数を
      // 渡さないため（呼び出し元はsrc/tools/save.tsのツール層ではなくストレージ層を直接使う）、
      // 常定値'unknown'に落ちる（distribution.confirmedにはならない。据え置き判断ではなくfixture
      // ビルダー自体の既知挙動）。project-confidence検査はこの分布を評価材料にせず正直に報告するのみ。
      expect(data.distribution.unknown).toBe(20);
    } finally {
      db.close();
    }
  });

  it("collectJournalMode: buildMiniStoreはWALモードで初期化される", () => {
    const projectDir = newScratchDir("g1-collect-wal-");
    const storePath = join(projectDir, ".wasurenagusa");
    buildMiniStore(storePath, { count: 20 });

    const db = new Database(join(storePath, "memory.db"), { readonly: true });
    try {
      expect(collectJournalMode(db).toLowerCase()).toBe("wal");
    } finally {
      db.close();
    }
  });

  it("collectSpikeReport: 実際のImplementation Log（task-1.2）が実測値パターンを含む", () => {
    const data = collectSpikeReport(REPO_ROOT);
    expect(data.fileExists).toBe(true);
    expect(data.hasBeforeNumber).toBe(true);
    expect(data.hasAfterNumber).toBe(true);
  });

  it("hasEmbeddingModelDecisionRecord: マーカーを含まないrepoRootではfalse（機構検証用の隔離ディレクトリ）", () => {
    const isolatedRepoRoot = newScratchDir("g1-no-decision-record-");
    expect(hasEmbeddingModelDecisionRecord(isolatedRepoRoot)).toBe(false);
  });
});

describe("evaluate*（純粋関数の単体テスト、合成データで直接検証）", () => {
  it("evaluateStateConsistency: 不整合0件ならPASS", () => {
    expect(evaluateStateConsistency(0).result).toBe("PASS");
  });

  it("evaluateStateConsistency: 意図的な違反（不整合が1件以上）はFAILする", () => {
    const result = evaluateStateConsistency(3);
    expect(result.result).toBe("FAIL");
    expect(result.measured.mismatchCount).toBe(3);
  });

  it("evaluatePtInvariants: PT-01/PT-05が両方passedならPASS", () => {
    const result = evaluatePtInvariants([
      { fullName: "... PT-01（不変条件I1）: ...", status: "passed" },
      { fullName: "... PT-05（不変条件I4 + 定義済み遷移のみ）: ...", status: "passed" },
    ]);
    expect(result.result).toBe("PASS");
  });

  it("evaluatePtInvariants: 意図的な違反（PT-05がfailed）はFAILする", () => {
    const result = evaluatePtInvariants([
      { fullName: "... PT-01（不変条件I1）: ...", status: "passed" },
      { fullName: "... PT-05（不変条件I4 + 定義済み遷移のみ）: ...", status: "failed" },
    ]);
    expect(result.result).toBe("FAIL");
  });

  it("evaluatePtInvariants: 意図的な違反（PT-05のテスト自体が見つからない）はFAILする", () => {
    const result = evaluatePtInvariants([{ fullName: "... PT-01（不変条件I1）: ...", status: "passed" }]);
    expect(result.result).toBe("FAIL");
  });

  it("evaluateResurrectionZero: vectors/vectorMetadataとも0件ならPASS", () => {
    const result = evaluateResurrectionZero({ memories: 5, vectors: 0, vectorMetadata: 0 });
    expect(result.result).toBe("PASS");
  });

  it("evaluateResurrectionZero: 意図的な違反（蘇生=vectorsが1件以上残存）はFAILする", () => {
    const result = evaluateResurrectionZero({ memories: 5, vectors: 1, vectorMetadata: 0 });
    expect(result.result).toBe("FAIL");
    expect(result.measured).toEqual({ memories: 5, vectors: 1, vectorMetadata: 0 });
  });

  it("evaluateEmbeddingSingleModel: 単一モデルならPASS", () => {
    const result = evaluateEmbeddingSingleModel(["Xenova/multilingual-e5-small"], false);
    expect(result.result).toBe("PASS");
  });

  it("evaluateEmbeddingSingleModel: 意図的な違反（複数モデル・据え置き記録なし）はFAILする", () => {
    const result = evaluateEmbeddingSingleModel(["model-a", "model-b"], false);
    expect(result.result).toBe("FAIL");
  });

  it("evaluateEmbeddingSingleModel: 複数モデルでも据え置き判断の記録があればPASS（エスケープハッチ）", () => {
    const result = evaluateEmbeddingSingleModel(["model-a", "model-b"], true);
    expect(result.result).toBe("PASS");
  });

  it("evaluateProjectConfidence: passthrough件数が期待件数と一致すればPASS", () => {
    const result = evaluateProjectConfidence({
      distribution: { confirmed: 10, unknown: 2 },
      passthroughSentinelCount: 2,
      expectedUnknownOrNullCount: 2,
    });
    expect(result.result).toBe("PASS");
  });

  it("evaluateProjectConfidence: 意図的な違反（passthrough節が壊れunknown/null行を取りこぼす）はFAILする", () => {
    const result = evaluateProjectConfidence({
      distribution: { confirmed: 10, unknown: 2 },
      passthroughSentinelCount: 0,
      expectedUnknownOrNullCount: 2,
    });
    expect(result.result).toBe("FAIL");
  });

  it("evaluateWal: journal_mode=wal かつ AC1/AC2両方passedならPASS", () => {
    const result = evaluateWal({
      journalMode: "wal",
      assertions: [
        { fullName: "... 接続はWALモードで動作する", status: "passed" },
        { fullName: "... busyタイムアウトが設定されている(0より大きい)", status: "passed" },
      ],
    });
    expect(result.result).toBe("PASS");
  });

  it("evaluateWal: 意図的な違反（journal_modeがwalでない）はFAILする", () => {
    const result = evaluateWal({
      journalMode: "delete",
      assertions: [
        { fullName: "... 接続はWALモードで動作する", status: "passed" },
        { fullName: "... busyタイムアウトが設定されている(0より大きい)", status: "passed" },
      ],
    });
    expect(result.result).toBe("FAIL");
  });

  it("evaluateWal: 意図的な違反（busy_timeoutのテストがfailed）はFAILする", () => {
    const result = evaluateWal({
      journalMode: "wal",
      assertions: [
        { fullName: "... 接続はWALモードで動作する", status: "passed" },
        { fullName: "... busyタイムアウトが設定されている(0より大きい)", status: "failed" },
      ],
    });
    expect(result.result).toBe("FAIL");
  });

  it("evaluateWriteFailureCounting: AC3の3テストがすべてpassedならPASS", () => {
    const result = evaluateWriteFailureCounting([
      { fullName: "... 例外は握りつぶされず再throwされる", status: "passed" },
      { fullName: "... カウンタへ計上される（握りつぶされない）", status: "passed" },
      { fullName: "... softDeleteの書き込み失敗（DBクローズ後の呼び出し）もカウンタへ計上される", status: "passed" },
    ]);
    expect(result.result).toBe("PASS");
  });

  it("evaluateWriteFailureCounting: 意図的な違反（1件failed）はFAILする", () => {
    const result = evaluateWriteFailureCounting([
      { fullName: "... 例外は握りつぶされず再throwされる", status: "failed" },
      { fullName: "... カウンタへ計上される（握りつぶされない）", status: "passed" },
      { fullName: "... softDeleteの書き込み失敗（DBクローズ後の呼び出し）もカウンタへ計上される", status: "passed" },
    ]);
    expect(result.result).toBe("FAIL");
  });

  it("evaluateSharedCache: 環境変数が設定され解決先と一致すればPASS", () => {
    const result = evaluateSharedCache(true, "/shared/models", "/shared/models");
    expect(result.result).toBe("PASS");
  });

  it("evaluateSharedCache: 現状（環境変数未設定=タスク1.13の意図的な未実施）はFAILとして正しく検出する", () => {
    const result = evaluateSharedCache(false, "/per-store/models", undefined);
    expect(result.result).toBe("FAIL");
  });

  it("evaluateSpikeReport: ファイル存在＋旧新の実測値パターン両方ありならPASS", () => {
    const result = evaluateSpikeReport({ fileExists: true, hasBeforeNumber: true, hasAfterNumber: true });
    expect(result.result).toBe("PASS");
  });

  it("evaluateSpikeReport: 意図的な違反（ファイル不在）はFAILする", () => {
    const result = evaluateSpikeReport({ fileExists: false, hasBeforeNumber: false, hasAfterNumber: false });
    expect(result.result).toBe("FAIL");
  });
});

describe("runG1: 合成fixtureに対する統合実行（pt-invariants/wal/write-failure-countingはvitestサブプロセス実行）", () => {
  const ORIGINAL_MODEL_CACHE_DIR = process.env.WASURENAGUSA_MODEL_CACHE_DIR;

  afterEach(() => {
    if (ORIGINAL_MODEL_CACHE_DIR === undefined) {
      delete process.env.WASURENAGUSA_MODEL_CACHE_DIR;
    } else {
      process.env.WASURENAGUSA_MODEL_CACHE_DIR = ORIGINAL_MODEL_CACHE_DIR;
    }
  });

  /** projectName配下に前提アサートを満たすfixtureストア＋バックアップを1つ作る。 */
  async function buildFullFixture(
    projectName: string,
    miniStoreOptions: Parameters<typeof buildMiniStore>[1],
  ): Promise<{ storePath: string; backupsRoot: string }> {
    const projectDir = join(newScratchDir(`${projectName}-parent-`), projectName);
    mkdirSync(projectDir, { recursive: true });
    const storePath = join(projectDir, ".wasurenagusa");
    buildMiniStore(storePath, miniStoreOptions);

    const backupsRoot = newScratchDir(`${projectName}-backup-root-`);
    await backupStore(storePath, join(backupsRoot, "20260710", projectName));

    return { storePath, backupsRoot };
  }

  it(
    "正常系: 前提アサートを満たし蘇生ゼロ・共有キャッシュ有効なfixtureは全9検査がPASSする",
    async () => {
      const { storePath, backupsRoot } = await buildFullFixture("g1-fixture-pass", {
        count: MIN_MEMORIES_FOR_G1,
        softDeleteCount: 2,
        resurrectionCount: 0,
      });

      // shared-cache検査を実測でPASSさせるため、共有キャッシュ先を一時的に有効化する
      // （タスク1.13の仕組み自体は実装済みで、グローバル適用のみ未実施。ここでは仕組みの
      // 正しさをfixture内で実証する。実運用への適用状態はshared-cache検査が別途正直に転記する）。
      const sharedModelsDir = newScratchDir("g1-shared-models-");
      process.env.WASURENAGUSA_MODEL_CACHE_DIR = sharedModelsDir;

      const output = await runG1({ storePath, backupsRoot, repoRoot: REPO_ROOT });

      expect(output.preconditions.ok, JSON.stringify(output.preconditions)).toBe(true);
      expect(output.checks).toHaveLength(9);
      const failed = output.checks.filter((c) => c.result === "FAIL");
      expect(failed, `FAILした検査: ${JSON.stringify(failed, null, 2)}`).toEqual([]);
      expect(output.checks.map((c) => c.check).sort()).toEqual(
        [
          "state-consistency",
          "pt-invariants",
          "resurrection-zero",
          "embedding-single-model",
          "project-confidence",
          "wal",
          "write-failure-counting",
          "shared-cache",
          "spike-report",
        ].sort(),
      );
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "意図的な違反系: 蘇生状態（deleted済みメモリにvector行が残存）のfixtureはresurrection-zeroのみFAILし他は実行される",
    async () => {
      const { storePath, backupsRoot } = await buildFullFixture("g1-fixture-resurrection-fail", {
        count: MIN_MEMORIES_FOR_G1,
        softDeleteCount: 2,
        resurrectionCount: 1,
      });

      const sharedModelsDir = newScratchDir("g1-shared-models-fail-case-");
      process.env.WASURENAGUSA_MODEL_CACHE_DIR = sharedModelsDir;

      const output = await runG1({ storePath, backupsRoot, repoRoot: REPO_ROOT });

      expect(output.preconditions.ok, JSON.stringify(output.preconditions)).toBe(true);
      expect(output.checks).toHaveLength(9);

      const resurrectionCheck = output.checks.find((c) => c.check === "resurrection-zero");
      expect(resurrectionCheck?.result).toBe("FAIL");

      const otherFailed = output.checks.filter((c) => c.check !== "resurrection-zero" && c.result === "FAIL");
      expect(otherFailed, `resurrection-zero以外にFAILした検査: ${JSON.stringify(otherFailed, null, 2)}`).toEqual([]);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "意図的な違反系: 共有キャッシュ環境変数を設定しない現状のfixtureはshared-cacheのみFAILする（FAILを隠さない）",
    async () => {
      const { storePath, backupsRoot } = await buildFullFixture("g1-fixture-sharedcache-fail", {
        count: MIN_MEMORIES_FOR_G1,
        softDeleteCount: 2,
        resurrectionCount: 0,
      });
      delete process.env.WASURENAGUSA_MODEL_CACHE_DIR;

      const output = await runG1({ storePath, backupsRoot, repoRoot: REPO_ROOT });

      expect(output.preconditions.ok, JSON.stringify(output.preconditions)).toBe(true);
      const sharedCacheCheck = output.checks.find((c) => c.check === "shared-cache");
      expect(sharedCacheCheck?.result).toBe("FAIL");

      const otherFailed = output.checks.filter((c) => c.check !== "shared-cache" && c.result === "FAIL");
      expect(otherFailed, `shared-cache以外にFAILした検査: ${JSON.stringify(otherFailed, null, 2)}`).toEqual([]);
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
