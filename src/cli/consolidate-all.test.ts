import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { consolidateProject } from "./consolidate-all.js";
import { SQLiteStorage } from "../storage/sqlite.js";
import { config } from "../config.js";
import type { ConsolidatedConfig, ConsolidatedDont } from "../types.js";

/**
 * Windows / SQLite-only 環境（dont.md・config.md などの Markdown ファイルが存在しない）で、
 * consolidate-all が統合を永久スキップせず consolidated を生成することを保証する。
 *
 * 旧実装はファイル版鮮度判定（dont.md / config.md が無いと false を返す）を呼んでいたため、
 * SQLite-only 環境では統合ブロックごとスキップされ、consolidated が永遠に 0 件のままだった。
 */
describe("consolidate-all: SQLite-only 環境で統合がスキップされない", () => {
  let tmpDir: string;
  let projectRoot: string;
  let memoryPath: string;
  let dbPath: string;

  // 2 つのほぼ同一ベクトル（L2 距離 < 0.6 で同一クラスタに入る）
  function nearbyVector(seed: number): number[] {
    const v = new Array(config.localEmbeddingDimensions).fill(0);
    v[0] = 1;
    v[1] = seed * 0.001;
    return v;
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

  it("dont 重複ペアが consolidated('dont') に統合される（dont.md 不在）", async () => {
    const storage = new SQLiteStorage(dbPath);
    storage.initialize(memoryPath);
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

    // mergeCluster が期待する形式（{ principle: {...} }）を返すモック LLM
    const mockGenerateText = async () =>
      JSON.stringify({
        principle: {
          theme: "タグ直書き禁止",
          rule: "❌タグ直書き→💡定数化→✅安全",
          positiveRule: "タグは定数として一元管理する",
          tags: ["tag"],
          sourceCount: 2,
          sourceIds: [a.id, b.id],
        },
      });

    await consolidateProject(projectRoot, { generateTextFn: mockGenerateText });

    const check = new SQLiteStorage(dbPath);
    check.initialize(memoryPath);
    const consolidated = check.readConsolidated("dont") as ConsolidatedDont | null;
    // 統合された principle が新規 dont として保存され、検索結果に現れる
    const aliveDont = check.readAliveDontEntries("myproject");
    check.close();

    expect(consolidated).not.toBeNull();
    expect(consolidated!.principles.length).toBeGreaterThan(0);
    expect(consolidated!.principles[0].theme).toBe("タグ直書き禁止");
    // ファイル側（PreToolUse / Stop guard が直読する）も二重書きされている
    expect(existsSync(join(memoryPath, config.consolidatedDontFile))).toBe(true);
    // 統合 principle が memories に追加されている（元の重複は論理削除されるので alive に principle が含まれる）
    expect(aliveDont.some(e => e.title === "タグ直書き禁止")).toBe(true);
  });

  it("config が consolidated('config') に統合される（config.md 不在）", async () => {
    const storage = new SQLiteStorage(dbPath);
    storage.initialize(memoryPath);
    storage.save({
      category: "config",
      title: "本番API URL",
      content: "本番APIは https://api.example.com",
      project: "myproject",
    });
    storage.close();

    const mockGenerateText = async () =>
      JSON.stringify({
        summaries: [{ topic: "API設定", content: "本番APIは https://api.example.com" }],
      });

    await consolidateProject(projectRoot, { generateTextFn: mockGenerateText });

    const check = new SQLiteStorage(dbPath);
    check.initialize(memoryPath);
    const consolidated = check.readConsolidated("config") as ConsolidatedConfig | null;
    check.close();

    expect(consolidated).not.toBeNull();
    expect(existsSync(join(memoryPath, config.consolidatedConfigFile))).toBe(true);
  });
});
