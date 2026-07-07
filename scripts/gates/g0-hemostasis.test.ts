/**
 * scripts/gates/g0-hemostasis.test.ts
 *
 * Phase 0（止血）完了ゲートの業務要件を検証する（タスク0.11、design.md Phase 0 ③の契約）。
 *
 * 業務要件:
 * 1. 前提アサート（DBが開ける／memories総件数1,000件以上／操作ログ存在）が1つでも
 *    不成立なら、6検査を一切実行せずFAILで終了する
 * 2. 合成fixture（機構検証専用、tests/fixtures/mini-store/）に対して全項目PASSする
 * 3. 意図的な違反状態（バックアップ欠落）ではbackup-restore検査がFAILする
 * 4. 各評価関数（evaluate*）は合成データを直接渡した単体でPASS/FAIL判定が正しい
 * 5. backup-restore検査は対象ストアを複数（主ストア＋他のアクティブプロジェクト）
 *    走査する
 *
 * 実行可能な検査（v1-blocked/injection/guard-gen-stopped/nightly-dryrun/counters）は
 * dist/ のビルド成果物を本番と同一の起動経路で実行するため、本テストの実行前に
 * `npm run build` 済みであることを前提とする。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";

import { buildMiniStore } from "../../tests/fixtures/mini-store/build-mini-store.js";
import { SQLiteStorage } from "../../src/storage/sqlite.js";
import { backupStore } from "../backup-store.js";
import {
  assertPreconditions,
  discoverBackupTargets,
  verifyBackupManifestIntegrity,
  checkBackupRestore,
  evaluateV1Blocked,
  evaluateInjection,
  evaluateGuardGenStopped,
  evaluateNightlyDryrun,
  runG0,
  V1_ASSET_FILES,
  MIN_INJECTION_BYTES,
} from "./g0-hemostasis.js";

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

/** 前提アサートを満たす操作ログファイルを1件作る。 */
function seedOperationLog(memoryPath: string): void {
  mkdirSync(join(memoryPath, "logs"), { recursive: true });
  writeFileSync(
    join(memoryPath, "logs", "operation-2026-07-07.jsonl"),
    JSON.stringify({ ts: "2026-07-07T00:00:00+09:00", operation_type: "search", session_id: "s1", query: "x", category: "log", hit_count: 0, project: "sample-webapp", duration_ms: 1 }) + "\n",
    "utf-8",
  );
}

/** v1-blocked検査を非自明にするため、v1資産ファイルをダミー内容で作る。 */
function seedV1Files(memoryPath: string): void {
  for (const file of V1_ASSET_FILES) {
    writeFileSync(join(memoryPath, file), file.endsWith(".json") ? "{}" : "# seed\n", "utf-8");
  }
}

/** injection検査を非自明にする、少量・小容量の合致プロジェクト分エントリを追加する。
 *  buildMiniStoreの1000件は前提アサート（1,000件以上）を満たすための母数で、既定の
 *  FIXTURE_PROJECTS（sample-webapp等）へ均等分配される。ここで別途 `projectName`
 *  （G0のスクラッチ実行がstorePathの親ディレクトリ名から導く実際のプロジェクト名）に
 *  一致する少数のエントリを直接保存し、「1KB以上・トークンバジェット未満」の両方を
 *  満たす現実的な注入本文を作る（母数全部を一致させるとバジェット超過でinjection検査が
 *  意図せずFAILする。8000トークン≒16000字前後が閾値の目安）。 */
function seedMatchingProjectEntries(memoryPath: string, projectName: string): void {
  const dbPath = join(memoryPath, "memory.db");
  const storage = new SQLiteStorage(dbPath);
  storage.initialize(memoryPath);
  try {
    for (let i = 0; i < 6; i++) {
      storage.save({
        category: "dont",
        title: `合成エントリ${i}`,
        content: `G0注入検査用の合成本文${i}。現実的な分量で1KB以上を確保しつつバジェット未満に収める。`,
        tags: ["fixture"],
        project: projectName,
        intensity: 3,
      });
    }
  } finally {
    storage.close();
  }
}

/**
 * G0の前提アサート＋6検査すべてを非自明に検証できる、完全なfixtureストアを1つ作る。
 * 戻り値のmemoryPathをそのままG0の--storeに、backupDirを--backupに使う。
 */
function buildFullFixture(): { memoryPath: string; backupDir: string } {
  const projectName = "g0-fixture-project";
  const parentDir = newScratchDir("g0-fixture-parent-");
  const projectDir = join(parentDir, projectName);
  mkdirSync(projectDir, { recursive: true });
  const memoryPath = join(projectDir, ".wasurenagusa");
  buildMiniStore(memoryPath, { count: 1000, softDeleteCount: 2, resurrectionCount: 1, seedGuardPattern: true });
  seedMatchingProjectEntries(memoryPath, projectName);
  seedOperationLog(memoryPath);
  seedV1Files(memoryPath);

  // models/（埋め込みモデルキャッシュ相当）を番兵として同梱する。スクラッチコピーは
  // models/を除外する仕様（backup-store.tsと同じ除外セット）のため、「models/がある
  // ストアでも全検査が壊れず通る」ことを統合実行のたびに実証する。
  mkdirSync(join(memoryPath, "models"), { recursive: true });
  writeFileSync(join(memoryPath, "models", "sentinel-model-file.bin"), "dummy-model-bytes", "utf-8");

  const backupDir = join(newScratchDir("g0-fixture-backup-"), projectName);
  return { memoryPath, backupDir };
}

describe("assertPreconditions", () => {
  it("memories 1,000件未満・操作ログなしのストアは前提アサート不成立でFAILする", () => {
    const projectDir = newScratchDir("g0-precond-small-");
    const memoryPath = join(projectDir, ".wasurenagusa");
    buildMiniStore(memoryPath, { count: 30 });

    const result = assertPreconditions(memoryPath);
    expect(result.ok).toBe(false);
    expect(result.memoriesCount).toBe(30);
    expect(result.operationLogExists).toBe(false);
    expect(result.reason).toContain("1,000件未満");
  });

  it("memories 1,000件以上・操作ログありのストアは前提アサートが成立する", () => {
    const projectDir = newScratchDir("g0-precond-ok-");
    const memoryPath = join(projectDir, ".wasurenagusa");
    buildMiniStore(memoryPath, { count: 1000 });
    seedOperationLog(memoryPath);

    const result = assertPreconditions(memoryPath);
    expect(result.ok).toBe(true);
    expect(result.dbOpens).toBe(true);
    expect(result.memoriesCount).toBeGreaterThanOrEqual(1000);
    expect(result.operationLogExists).toBe(true);
  });

  it("DBが存在しないストアはdbOpens=falseでFAILする", () => {
    const projectDir = newScratchDir("g0-precond-nodb-");
    const memoryPath = join(projectDir, ".wasurenagusa");
    mkdirSync(memoryPath, { recursive: true });

    const result = assertPreconditions(memoryPath);
    expect(result.ok).toBe(false);
    expect(result.dbOpens).toBe(false);
    expect(result.reason).toBe("DBが開けません");
  });
});

describe("runG0: 前提アサート不成立時は6検査を実行せずFAILする", () => {
  it("小さすぎるストアではchecksが空配列で返る", async () => {
    const projectDir = newScratchDir("g0-run-precond-fail-");
    const memoryPath = join(projectDir, ".wasurenagusa");
    buildMiniStore(memoryPath, { count: 10 });
    const backupDir = join(newScratchDir("g0-run-precond-fail-backup-"), "sample-webapp");

    const output = await runG0({ storePath: memoryPath, backupPath: backupDir, schedulerDir: newScratchDir("g0-empty-scheduler-") });

    expect(output.preconditions.ok).toBe(false);
    expect(output.checks).toEqual([]);
  });
});

describe("verifyBackupManifestIntegrity / checkBackupRestore", () => {
  it("バックアップ欠落（manifest.jsonなし）はFAILと判定する", () => {
    const backupDir = newScratchDir("g0-no-backup-");
    const result = verifyBackupManifestIntegrity(backupDir);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("manifest.json");
  });

  it("有効なバックアップはOKと判定し、主ストアは復元リハーサルまでPASSする", async () => {
    const projectDir = newScratchDir("g0-backup-ok-");
    const memoryPath = join(projectDir, ".wasurenagusa");
    buildMiniStore(memoryPath, { count: 50 });
    const backupDir = join(newScratchDir("g0-backup-ok-dir-"), "sample-webapp");
    await backupStore(memoryPath, backupDir);

    const verification = verifyBackupManifestIntegrity(backupDir);
    expect(verification.ok).toBe(true);

    const targets = [{ name: "sample-webapp", memoryPath, backupDir, isPrimary: true }];
    const result = await checkBackupRestore(targets);
    expect(result.check).toBe("backup-restore");
    expect(result.result).toBe("PASS");
    expect((result.measured as { primaryRehearsalOk: boolean }).primaryRehearsalOk).toBe(true);
  });

  it("意図的な違反（バックアップのチェックサム改ざん）はFAILする", async () => {
    const projectDir = newScratchDir("g0-backup-tamper-");
    const memoryPath = join(projectDir, ".wasurenagusa");
    buildMiniStore(memoryPath, { count: 50 });
    const backupDir = join(newScratchDir("g0-backup-tamper-dir-"), "sample-webapp");
    await backupStore(memoryPath, backupDir);

    // 意図的な違反状態: バックアップ済みファイルの中身を書き換えてチェックサムを壊す
    const manifest = JSON.parse(readFileSync(join(backupDir, "manifest.json"), "utf-8"));
    const targetFile = manifest.files.find((f: { relativePath: string }) => f.relativePath !== "memory.db")
      ?? manifest.files[0];
    writeFileSync(join(backupDir, targetFile.relativePath), "TAMPERED-CONTENT", "utf-8");

    const verification = verifyBackupManifestIntegrity(backupDir);
    expect(verification.ok).toBe(false);
    expect(verification.reason).toContain("チェックサム不一致");

    const targets = [{ name: "sample-webapp", memoryPath, backupDir, isPrimary: true }];
    const result = await checkBackupRestore(targets);
    expect(result.result).toBe("FAIL");
  });
});

describe("discoverBackupTargets: 対象ストアの複数走査", () => {
  it("schedulerDirにアクティブプロジェクトがなければ主ストアのみが対象になる", async () => {
    const schedulerDir = newScratchDir("g0-scheduler-empty-");
    const targets = await discoverBackupTargets("/tmp/primary/.wasurenagusa", "/tmp/backup/primary", schedulerDir);
    expect(targets).toHaveLength(1);
    expect(targets[0].isPrimary).toBe(true);
  });

  it("schedulerDirに他のアクティブプロジェクトがあれば走査対象へ追加される（ストアごとの走査）", async () => {
    const schedulerDir = newScratchDir("g0-scheduler-active-");
    const activeProjectsData = {
      projects: [
        { name: "other-project-a", path: "/tmp/other-project-a", lastSessionAt: "2026-07-07T00:00:00+09:00", sessionTopic: "test" },
        { name: "other-project-b", path: "/tmp/other-project-b", lastSessionAt: "2026-07-06T00:00:00+09:00", sessionTopic: "test" },
      ],
      maxActiveProjects: 5,
      updatedAt: "2026-07-07T00:00:00+09:00",
    };
    writeFileSync(join(schedulerDir, "active-projects.json"), JSON.stringify(activeProjectsData), "utf-8");

    const targets = await discoverBackupTargets("/tmp/primary/.wasurenagusa", "/tmp/backup/primary", schedulerDir);
    expect(targets).toHaveLength(3);
    expect(targets.filter((t) => !t.isPrimary).map((t) => t.name).sort()).toEqual(["other-project-a", "other-project-b"]);
    // 他ストアのバックアップ先は主ストアのバックアップ先の親ディレクトリ配下、project.name規約
    expect(targets.find((t) => t.name === "other-project-a")?.backupDir).toBe("/tmp/backup/other-project-a");
  });
});

describe("evaluate*（純粋関数の単体テスト、合成データで直接検証）", () => {
  it("evaluateV1Blocked: mtime不変ならPASS", () => {
    const before = { "dont.md": 100, "vectors.json": 200 };
    const after = { "dont.md": 100, "vectors.json": 200 };
    const result = evaluateV1Blocked(before, after);
    expect(result.result).toBe("PASS");
  });

  it("evaluateV1Blocked: 意図的な違反（mtimeが変化）はFAILする", () => {
    const before = { "dont.md": 100, "vectors.json": 200 };
    const after = { "dont.md": 999, "vectors.json": 200 };
    const result = evaluateV1Blocked(before, after);
    expect(result.result).toBe("FAIL");
    expect((result.measured as { changedFiles: string[] }).changedFiles).toEqual(["dont.md"]);
  });

  it("evaluateInjection: 1KB以上かつバジェット以下ならPASS", () => {
    const result = evaluateInjection(2048, 500, 8000);
    expect(result.result).toBe("PASS");
  });

  it("evaluateInjection: 意図的な違反（1KB未満）はFAILする", () => {
    const result = evaluateInjection(MIN_INJECTION_BYTES - 1, 10, 8000);
    expect(result.result).toBe("FAIL");
  });

  it("evaluateInjection: 意図的な違反（バジェット超過）はFAILする", () => {
    const result = evaluateInjection(2048, 9000, 8000);
    expect(result.result).toBe("FAIL");
  });

  it("evaluateGuardGenStopped: パターン件数・ファイル内容が不変ならPASS", () => {
    const result = evaluateGuardGenStopped(1, 1, "hash-a", "hash-a");
    expect(result.result).toBe("PASS");
  });

  it("evaluateGuardGenStopped: 意図的な違反（パターン件数が増加=再生成）はFAILする", () => {
    const result = evaluateGuardGenStopped(1, 2, "hash-a", "hash-b");
    expect(result.result).toBe("FAIL");
  });

  it("evaluateNightlyDryrun: 書き込み0件＋レポート生成ならPASS", () => {
    const result = evaluateNightlyDryrun(1000, 1000, "cache-hash", "cache-hash", true, true);
    expect(result.result).toBe("PASS");
  });

  it("evaluateNightlyDryrun: 意図的な違反（memories件数が変化=書き込み発生）はFAILする", () => {
    const result = evaluateNightlyDryrun(1000, 1001, "cache-hash", "cache-hash", true, true);
    expect(result.result).toBe("FAIL");
  });

  it("evaluateNightlyDryrun: 意図的な違反（レポート未生成）はFAILする", () => {
    const result = evaluateNightlyDryrun(1000, 1000, "cache-hash", "cache-hash", false, false);
    expect(result.result).toBe("FAIL");
  });
});

describe("runG0: 合成fixtureに対する統合実行（実行可能な検査。dist/ビルド成果物を使用）", () => {
  it(
    "正常系: 前提アサートを満たしバックアップも有効なfixtureは全6検査がPASSする",
    async () => {
      const { memoryPath, backupDir } = buildFullFixture();
      await backupStore(memoryPath, backupDir);

      const output = await runG0({
        storePath: memoryPath,
        backupPath: backupDir,
        schedulerDir: newScratchDir("g0-empty-scheduler-"),
        repoRoot: REPO_ROOT,
      });

      expect(output.preconditions.ok).toBe(true);
      expect(output.checks).toHaveLength(6);
      const failed = output.checks.filter((c) => c.result === "FAIL");
      expect(failed, `FAILした検査: ${JSON.stringify(failed, null, 2)}`).toEqual([]);
      expect(output.checks.map((c) => c.check).sort()).toEqual(
        ["backup-restore", "counters", "guard-gen-stopped", "injection", "nightly-dryrun", "v1-blocked"].sort(),
      );
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "意図的な違反系: バックアップを作らない場合、backup-restore検査のみFAILし他は実行される",
    async () => {
      const { memoryPath, backupDir } = buildFullFixture();
      // バックアップを意図的に作らない（欠落状態）

      const output = await runG0({
        storePath: memoryPath,
        backupPath: backupDir,
        schedulerDir: newScratchDir("g0-empty-scheduler-"),
        repoRoot: REPO_ROOT,
      });

      expect(output.preconditions.ok).toBe(true);
      expect(output.checks).toHaveLength(6);
      const backupCheck = output.checks.find((c) => c.check === "backup-restore");
      expect(backupCheck?.result).toBe("FAIL");
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
