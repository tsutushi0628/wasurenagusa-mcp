import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import { consolidateProject } from "./consolidate-all.js";
import { SQLiteStorage } from "../storage/sqlite.js";
import { config } from "../config.js";
import type { ConsolidatedConfig, ConsolidatedDont } from "../types.js";

const DRY_RUN_REPORT_FILE = "consolidation-dryrun-report.json";

/**
 * 夜間統合のdry-run化（タスク0.8、design.md Phase 0 ⑤、R-A3・R-A6）。
 *
 * 統合（dont重複排除・config要約）は、書き込み（memoriesへのマージ結果保存・原本の論理削除・
 * 統合キャッシュへの永続化）を停止し、クラスタ数・統合候補件数のレポート出力のみを行う。
 * クラスタリング計算自体（読み取り専用の分析）はPhase 3の追記型統合実装まで維持する。
 *
 * F3夢生成（heart-extension、統合とは別系統の書き込み）はこのdry-run化の対象外のため、
 * 各テストで直近のdreamエントリを事前に用意し、干渉なく検証できるようにする
 * （dream生成は直近24h以内にdreamがあれば無条件でスキップする仕様を利用）。
 *
 * Windows / SQLite-only 環境（dont.md・config.md などの Markdown ファイルが存在しない）でも
 * 同様にdry-runが機能することを確認するため、意図的にMarkdownファイルを作らない。
 */
describe("consolidate-all: 夜間統合のdry-run化（書き込み停止・レポート出力）", () => {
  let tmpDir: string;
  let projectRoot: string;
  let memoryPath: string;
  let dbPath: string;

  // 2 つのほぼ同一ベクトル（L2 距離 < 0.25 で同一クラスタに入る。SIM_DISTANCE_THRESHOLD 参照）
  function nearbyVector(seed: number): number[] {
    const v = new Array(config.localEmbeddingDimensions).fill(0);
    v[0] = 1;
    v[1] = seed * 0.001;
    return v;
  }

  function seedRecentDreamToSkipF3(storage: SQLiteStorage): void {
    storage.save({
      category: "dream",
      title: "既存の夢（F3干渉防止用ダミー）",
      content: "dry-run検証をF3夢生成の挙動から独立させるための事前シード",
      tags: ["dream"],
      project: "myproject",
    });
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-consolidate-all-test-"));
    projectRoot = join(tmpDir, "myproject");
    memoryPath = join(projectRoot, ".wasurenagusa");
    dbPath = join(memoryPath, config.sqliteFile);
    mkdirSync(memoryPath, { recursive: true });
    // dont.md / config.md は意図的に作らない（SQLite-only を再現）
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("dont重複候補があっても、memoriesと統合キャッシュへの書き込みは発生せず、レポートに検出件数が記録される", async () => {
    const storage = new SQLiteStorage(dbPath);
    storage.initialize(memoryPath);
    seedRecentDreamToSkipF3(storage);
    const a = storage.save({
      category: "dont",
      title: "タグ直書き禁止A",
      content: "タグをコードに直書きしてはいけない",
      project: "myproject",
      intensity: 4,
    });
    const b = storage.save({
      category: "dont",
      title: "タグ直書き禁止B",
      content: "タグはハードコードせず定数化する",
      project: "myproject",
      intensity: 5,
    });
    // 重複クラスタを形成するための近接ベクトル
    storage.upsertVector(a.id, nearbyVector(1));
    storage.upsertVector(b.id, nearbyVector(2));
    storage.close();

    // dry-run中はdont/config統合のLLM呼び出しが一切発生しないため、generateTextFnの注入は不要
    await consolidateProject(projectRoot);

    const check = new SQLiteStorage(dbPath);
    check.initialize(memoryPath);
    const consolidated = check.readConsolidated("dont") as ConsolidatedDont | null;
    const aliveDont = check.readAliveDontEntries("myproject");
    check.close();

    // 統合キャッシュ（SQLite・ファイル双方）への書き込みが発生していない
    expect(consolidated).toBeNull();
    expect(existsSync(join(memoryPath, config.consolidatedDontFile))).toBe(false);
    // memoriesへの書き込み（マージ結果の新規保存・原本の論理削除）が発生していない
    expect(aliveDont.find((e) => e.id === a.id)).toBeDefined();
    expect(aliveDont.find((e) => e.id === b.id)).toBeDefined();
    expect(aliveDont.length).toBe(2);

    // レポートファイルが生成され、クラスタ数・重複候補件数が記録されている
    const reportPath = join(memoryPath, DRY_RUN_REPORT_FILE);
    expect(existsSync(reportPath)).toBe(true);
    const report = JSON.parse(readFileSync(reportPath, "utf-8"));
    expect(report.dont.stale).toBe(true);
    expect(report.dont.aliveEntryCount).toBe(2);
    expect(report.dont.dupClusterCount).toBeGreaterThan(0);

    // 可観測性カウンタ（タスク0.9、R-M1）: 統合候補件数が記録される
    const counterFiles = readFileSync(
      join(memoryPath, "logs", `counters-${new Date(new Date().getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)}.jsonl`),
      "utf-8",
    ).trim().split("\n").map((l) => JSON.parse(l));
    const consolidationEntry = counterFiles.find((e) => e.metric === "consolidation_count");
    expect(consolidationEntry).toBeDefined();
    expect(consolidationEntry.value).toBe(report.dont.dupClusterCount + report.config.entryCount);
  });

  it("config候補があっても、統合キャッシュへの書き込みは発生せず、レポートに候補件数が記録される", async () => {
    const storage = new SQLiteStorage(dbPath);
    storage.initialize(memoryPath);
    seedRecentDreamToSkipF3(storage);
    storage.save({
      category: "config",
      title: "本番API URL",
      content: "本番APIは https://api.example.com",
      project: "myproject",
    });
    storage.close();

    await consolidateProject(projectRoot);

    const check = new SQLiteStorage(dbPath);
    check.initialize(memoryPath);
    const consolidated = check.readConsolidated("config") as ConsolidatedConfig | null;
    check.close();

    expect(consolidated).toBeNull();
    expect(existsSync(join(memoryPath, config.consolidatedConfigFile))).toBe(false);

    const reportPath = join(memoryPath, DRY_RUN_REPORT_FILE);
    expect(existsSync(reportPath)).toBe(true);
    const report = JSON.parse(readFileSync(reportPath, "utf-8"));
    expect(report.config.stale).toBe(true);
    expect(report.config.entryCount).toBe(1);
  });

  it("統合候補が0件のときも、レポートは生成され件数0が記録される（沈黙成功を出さない）", async () => {
    const storage = new SQLiteStorage(dbPath);
    storage.initialize(memoryPath);
    seedRecentDreamToSkipF3(storage);
    storage.close();

    await consolidateProject(projectRoot);

    const reportPath = join(memoryPath, DRY_RUN_REPORT_FILE);
    expect(existsSync(reportPath)).toBe(true);
    const report = JSON.parse(readFileSync(reportPath, "utf-8"));
    expect(report.dont.aliveEntryCount).toBe(0);
    expect(report.dont.dupClusterCount).toBe(0);
    expect(report.config.entryCount).toBe(0);
  });
});

/**
 * main()のAPIキー無し早期exitガード撤去（push前レビュー指摘）。
 * 統合はdry-run化済み（LLM呼び出し無し）のため、APIキーが1つも無い実行環境でも
 * dry-runレポートとconsolidation_countカウンタが記録されることをCLI実機（spawn）で確認する。
 * ビルド済みでないとスキップされる（pre-tool-use-guard.test.tsのCLI実機テストと同型）。
 */
describe("consolidate-all main() CLI（実機）: APIキー無しでもdry-run処理が実行される", () => {
  let tmpHome: string;
  let projectRoot: string;
  let memoryPath: string;
  const cliPath = resolve(__dirname, "../../dist/cli/consolidate-all.js");

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "wasurenagusa-consolidate-main-test-"));
    projectRoot = join(tmpHome, "myproject");
    memoryPath = join(projectRoot, ".wasurenagusa");
    mkdirSync(memoryPath, { recursive: true });

    // F3夢生成をスキップさせ、LLM/ネットワーク呼び出しを一切発生させない
    // （直近24h以内にdreamがあれば無条件スキップする仕様を利用。他テストと同じ手法）
    const storage = new SQLiteStorage(join(memoryPath, config.sqliteFile));
    storage.initialize(memoryPath);
    storage.save({
      category: "dream",
      title: "既存の夢（F3干渉防止用ダミー）",
      content: "main() CLI実機テストをF3夢生成の挙動から独立させるための事前シード",
      tags: ["dream"],
      project: "myproject",
    });
    storage.close();

    const schedulerDir = join(tmpHome, ".wasurenagusa", "scheduler");
    mkdirSync(schedulerDir, { recursive: true });
    writeFileSync(
      join(schedulerDir, "active-projects.json"),
      JSON.stringify({
        projects: [{
          name: "myproject",
          path: projectRoot,
          lastSessionAt: new Date().toISOString(),
          sessionTopic: "test",
        }],
        maxActiveProjects: 5,
        updatedAt: new Date().toISOString(),
      }),
    );
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("APIキーが1つも無くても、対象プロジェクトのdry-runレポートとconsolidation_countカウンタが記録される", () => {
    if (!existsSync(cliPath)) {
      // ビルド前: スキップ
      return;
    }

    // HOMEをtmpHomeへ差し替え、実HOME配下のスケジューラ/秘密には一切触れない
    const proc = spawnSync("node", [cliPath], {
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpHome,
        GEMINI_API_KEY: "",
        OPENAI_API_KEY: "",
        ANTHROPIC_API_KEY: "",
      },
    });

    expect(proc.status).toBe(0);
    expect(existsSync(join(memoryPath, DRY_RUN_REPORT_FILE))).toBe(true);

    const logsDir = join(memoryPath, "logs");
    expect(existsSync(logsDir)).toBe(true);
    const counterFiles = readdirSync(logsDir).filter((f) => f.startsWith("counters-"));
    expect(counterFiles.length).toBe(1);
    const entries = readFileSync(join(logsDir, counterFiles[0]), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(entries.some((e) => e.metric === "consolidation_count")).toBe(true);
  });
});
