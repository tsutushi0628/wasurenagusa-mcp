import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runDontConsolidationForProject } from "./consolidate-worker.js";
import { SQLiteStorage } from "../storage/sqlite.js";
import { config } from "../config.js";
import type { ConsolidatedDont } from "../types.js";

/**
 * heart-extension B0a: consolidate-worker の dont 統合完走後、
 * SQLite consolidated('dont') テーブルに同一データが書き込まれることを保証する。
 */
describe("consolidate-worker B0a: SQLite二重書き", () => {
  let tmpDir: string;
  let projectRoot: string;
  let memoryPath: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-consolidate-worker-test-"));
    projectRoot = join(tmpDir, "myproject");
    memoryPath = join(projectRoot, ".wasurenagusa");
    dbPath = join(memoryPath, config.sqliteFile);
    mkdirSync(memoryPath, { recursive: true });

    // dont.md を用意（MarkdownStorage が読む）
    writeFileSync(
      join(memoryPath, "dont.md"),
      `# Don't Memory

---

## 本番DBに直接接続禁止

- **id**: dont-test-001
- **timestamp**: 2026-01-20T09:00:00+09:00
- **category**: dont
- **project**: myproject
- **intensity**: 5
- **tags**: db, production
- **content**: 本番DBに直接接続してはいけない。必ずエミュレータを使う。

---

## ログ出力フォーマット違反

- **id**: dont-test-002
- **timestamp**: 2026-01-21T10:00:00+09:00
- **category**: dont
- **project**: myproject
- **intensity**: 4
- **tags**: log
- **content**: ログ出力時にuserIdをそのまま出すな。マスク必須。

---

`,
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("dont 統合完走後 SQLite consolidated('dont') が non-null になる", async () => {
    // モック LLM: 統合結果の JSON を返す
    const mockGenerateText = async () => `{
      "principles": [
        {
          "theme": "本番DB保護",
          "rule": "❌本番直接接続→💡エミュレータ→✅安全",
          "positiveRule": "本番DBはエミュレータ経由で操作する",
          "tags": ["db", "production"],
          "sourceCount": 1,
          "sourceIds": ["dont-test-001"]
        }
      ]
    }`;

    const result = await runDontConsolidationForProject({
      memoryPath,
      projectRoot,
      generateTextFn: mockGenerateText,
    });

    expect(result).not.toBeNull();

    // SQLite consolidated('dont') テーブルに書き込まれている
    const storage = new SQLiteStorage(dbPath);
    storage.initialize();
    const consolidated = storage.readConsolidated("dont") as ConsolidatedDont | null;
    storage.close();

    expect(consolidated).not.toBeNull();
    expect(consolidated!.principles.length).toBeGreaterThan(0);
    expect(consolidated!.principles[0].theme).toBe("本番DB保護");
    expect(consolidated!.sourceEntryCount).toBe(2);
  });

  it("ファイル書き込み（consolidated-dont.json）も継続して動く（二重書き）", async () => {
    const mockGenerateText = async () => `{
      "principles": [
        {
          "theme": "ログマスク",
          "rule": "❌生userId→💡マスク→✅安全",
          "positiveRule": "userIdをマスクしてログ出力する",
          "tags": ["log"],
          "sourceCount": 1,
          "sourceIds": ["dont-test-002"]
        }
      ]
    }`;

    await runDontConsolidationForProject({
      memoryPath,
      projectRoot,
      generateTextFn: mockGenerateText,
    });

    const consolidatedJsonPath = join(memoryPath, config.consolidatedDontFile);
    expect(existsSync(consolidatedJsonPath)).toBe(true);
  });

  it("LLM 失敗時もファイル書き込みは保持され、SQLiteも書かれない（fail-open）", async () => {
    const failingGenerateText = async () => {
      throw new Error("LLM API failure");
    };

    const result = await runDontConsolidationForProject({
      memoryPath,
      projectRoot,
      generateTextFn: failingGenerateText,
    });

    expect(result).toBeNull();

    // SQLite consolidated は空のまま
    const storage = new SQLiteStorage(dbPath);
    storage.initialize();
    const consolidated = storage.readConsolidated("dont");
    storage.close();
    expect(consolidated).toBeNull();
  });

  it("dont エントリ 0件の場合は何も書き込まない", async () => {
    // dont.md を空に上書き
    writeFileSync(
      join(memoryPath, "dont.md"),
      `# Don't Memory

`,
    );

    const mockGenerateText = async () => "{}";

    const result = await runDontConsolidationForProject({
      memoryPath,
      projectRoot,
      generateTextFn: mockGenerateText,
    });

    expect(result).toBeNull();

    const storage = new SQLiteStorage(dbPath);
    storage.initialize();
    const consolidated = storage.readConsolidated("dont");
    storage.close();
    expect(consolidated).toBeNull();
  });
});
