import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SQLiteStorage } from "../storage/sqlite.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/**
 * TASK-039: E2E統合テスト（マイグレーションフロー）
 *
 * v1テストデータ作成→マイグレーション→SQLiteからの読み出し→FTS5検索→冪等性を検証する。
 */

function createV1TestData(memoryPath: string): void {
  // config.md
  writeFileSync(
    join(memoryPath, "config.md"),
    `# Config Memory

API URL、ポート、認証情報など、毎回参照すべき設定情報。

---

## フロントエンドポート設定

- **id**: mig-001
- **timestamp**: 2026-01-15T10:30:00+09:00
- **category**: config
- **project**: my-app
- **scope**: frontend
- **tags**: port, config, frontend
- **content**: フロントエンドはポート3000を使用。devサーバーはVite。

---

## APIエンドポイント

- **id**: mig-002
- **timestamp**: 2026-02-01T14:00:00+09:00
- **category**: config
- **project**: my-app
- **scope**: backend
- **tags**: api, endpoint
- **content**: 本番APIはhttps://api.example.com/v2、ステージングはhttps://staging-api.example.com/v2

---

`,
  );

  // dont.md
  writeFileSync(
    join(memoryPath, "dont.md"),
    `# Don't Memory

やってはいけないこと、過去のミス、ユーザーが怒ったポイント。

---

## 本番DBに直接接続禁止

- **id**: mig-003
- **timestamp**: 2026-01-20T09:00:00+09:00
- **category**: dont
- **project**: my-app
- **intensity**: 5
- **tags**: database, production, security
- **content**: 本番データベースに直接接続してはいけない。必ずエミュレータかステージング環境を使う。

---

## console.logを残さない

- **id**: mig-004
- **timestamp**: 2026-03-10T16:00:00+09:00
- **category**: dont
- **intensity**: 3
- **tags**: logging, code-review
- **content**: console.logをコミットに残してはいけない。デバッグ用のlogger.debug()を使う。

---

`,
  );

  // decisions.md
  writeFileSync(
    join(memoryPath, "decisions.md"),
    `# Decisions Memory

決定事項、採用した方針、技術選定の理由。

---

## TypeScript strict mode採用

- **id**: mig-005
- **timestamp**: 2026-03-01T11:00:00+09:00
- **category**: decision
- **project**: my-app
- **tags**: typescript, strict
- **content**: TypeScript strict modeを全プロジェクトで有効化。anyは原則禁止。

---

`,
  );

  // snippets.md
  writeFileSync(
    join(memoryPath, "snippets.md"),
    `# Snippets Memory

よく使うコマンド、クエリ、便利スクリプト。

---

## Firebaseデプロイ

- **id**: mig-006
- **timestamp**: 2026-02-15T16:00:00+09:00
- **category**: snippet
- **scope**: infra
- **tags**: firebase, deploy
- **content**: firebase deploy --only functions --project my-app-prod

---

`,
  );

  // logs/
  const logsDir = join(memoryPath, "logs");
  mkdirSync(logsDir, { recursive: true });

  writeFileSync(
    join(logsDir, "2026-04-01.md"),
    `# Log: 2026-04-01

---

## CSRFトークンデバッグ

- **id**: mig-007
- **timestamp**: 2026-04-01T15:30:00+09:00
- **category**: log
- **project**: my-app
- **tags**: csrf, debug, cookie
- **content**: CSRFトークンの問題をデバッグ。原因はクッキーのSameSite属性がLaxに設定されていたこと。Noneに変更して解決。

---

`,
  );
}

function createVectorsJson(memoryPath: string): void {
  const vectorsData = {
    version: 1,
    entries: {
      "mig-001": {
        embedding: Array.from({ length: 768 }, (_, i) => i * 0.001),
        accessCount: 8,
        createdAt: "2026-01-15T10:30:00+09:00",
        lastAccessedAt: "2026-04-05T12:00:00+09:00",
      },
      "mig-003": {
        embedding: Array.from({ length: 768 }, (_, i) => i * 0.002),
        accessCount: 15,
        createdAt: "2026-01-20T09:00:00+09:00",
        lastAccessedAt: "2026-04-06T08:00:00+09:00",
      },
    },
  };
  writeFileSync(
    join(memoryPath, "vectors.json"),
    JSON.stringify(vectorsData),
  );
}

describe("E2E: マイグレーションフロー", () => {
  let tmpDir: string;
  let memoryPath: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-e2e-migration-"));
    memoryPath = join(tmpDir, ".wasurenagusa");
    dbPath = join(tmpDir, "memory.db");
    mkdirSync(memoryPath, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("v1テストデータ→マイグレーション→SQLiteからの読み出し→内容一致", () => {
    createV1TestData(memoryPath);
    createVectorsJson(memoryPath);

    const storage = new SQLiteStorage(dbPath);
    storage.initialize(memoryPath);

    // 全7エントリが移行されていること
    const allResults = storage.search({ query: "" });
    expect(allResults.totalCount).toBe(7);

    // 個別エントリの内容一致検証
    const detail = storage.getDetail({
      ids: ["mig-001", "mig-002", "mig-003", "mig-004", "mig-005", "mig-006", "mig-007"],
    });
    expect(detail.entries.length).toBe(7);
    expect(detail.notFound.length).toBe(0);

    // config: mig-001
    const config1 = detail.entries.find(e => e.id === "mig-001");
    expect(config1).toBeDefined();
    expect(config1!.category).toBe("config");
    expect(config1!.title).toBe("フロントエンドポート設定");
    expect(config1!.content).toContain("ポート3000");
    expect(config1!.project).toBe("my-app");
    expect(config1!.scope).toBe("frontend");
    expect(config1!.tags).toContain("port");

    // dont: mig-003 (intensity付き)
    const dont1 = detail.entries.find(e => e.id === "mig-003");
    expect(dont1).toBeDefined();
    expect(dont1!.category).toBe("dont");
    expect(dont1!.intensity).toBe(5);
    expect(dont1!.content).toContain("本番データベース");

    // decision: mig-005
    const decision = detail.entries.find(e => e.id === "mig-005");
    expect(decision).toBeDefined();
    expect(decision!.category).toBe("decision");
    expect(decision!.content).toContain("strict mode");

    // snippet: mig-006 (scope付き)
    const snippet = detail.entries.find(e => e.id === "mig-006");
    expect(snippet).toBeDefined();
    expect(snippet!.scope).toBe("infra");

    // log: mig-007
    const log = detail.entries.find(e => e.id === "mig-007");
    expect(log).toBeDefined();
    expect(log!.category).toBe("log");
    expect(log!.content).toContain("CSRF");

    storage.close();
  });

  it("マイグレーション後のFTS5検索でヒットすること", () => {
    createV1TestData(memoryPath);

    const storage = new SQLiteStorage(dbPath);
    storage.initialize(memoryPath);

    // 日本語キーワードで検索
    const portSearch = storage.search({ query: "ポート" });
    expect(portSearch.results.length).toBeGreaterThanOrEqual(1);
    expect(portSearch.results.some(r => r.id === "mig-001")).toBe(true);

    // 英語キーワードで検索
    const csrfSearch = storage.search({ query: "CSRF" });
    expect(csrfSearch.results.length).toBeGreaterThanOrEqual(1);
    expect(csrfSearch.results.some(r => r.id === "mig-007")).toBe(true);

    // カテゴリフィルタ付き検索
    const dontSearch = storage.search({ query: "データベース", category: "dont" });
    expect(dontSearch.results.length).toBeGreaterThanOrEqual(1);
    expect(dontSearch.results.every(r => r.category === "dont")).toBe(true);

    // projectフィルタ付き検索
    const projectSearch = storage.search({ query: "", project: "my-app" });
    expect(projectSearch.results.length).toBeGreaterThanOrEqual(1);

    storage.close();
  });

  it("二重マイグレーションの冪等性（件数が増えない）", () => {
    createV1TestData(memoryPath);

    // 1回目のマイグレーション
    const storage1 = new SQLiteStorage(dbPath);
    storage1.initialize(memoryPath);
    const count1 = storage1.search({ query: "" }).totalCount;
    expect(count1).toBe(7);
    storage1.close();

    // 2回目: 同じDBで再initialize
    const storage2 = new SQLiteStorage(dbPath);
    storage2.initialize(memoryPath);
    const count2 = storage2.search({ query: "" }).totalCount;
    expect(count2).toBe(7); // 件数が増えていない
    storage2.close();

    // 3回目: さらに再initialize
    const storage3 = new SQLiteStorage(dbPath);
    storage3.initialize(memoryPath);
    const count3 = storage3.search({ query: "" }).totalCount;
    expect(count3).toBe(7);
    storage3.close();
  });

  it("vector_metadataが正しく移行される", () => {
    createV1TestData(memoryPath);
    createVectorsJson(memoryPath);

    const storage = new SQLiteStorage(dbPath);
    storage.initialize(memoryPath);

    // getVectorMetadataで移行されたメタデータを確認
    const metadata = storage.getVectorMetadata(["mig-001", "mig-003"]);

    expect(metadata.size).toBe(2);

    const meta1 = metadata.get("mig-001");
    expect(meta1).toBeDefined();
    expect(meta1!.accessCount).toBe(8);

    const meta3 = metadata.get("mig-003");
    expect(meta3).toBeDefined();
    expect(meta3!.accessCount).toBe(15);

    storage.close();
  });

  it("マイグレーション後にgetContextでconfig/dontが返る", () => {
    createV1TestData(memoryPath);

    const storage = new SQLiteStorage(dbPath);
    storage.initialize(memoryPath);

    const context = storage.getContext("my-app");

    // configにポート設定が含まれる
    expect(context.config).toContain("ポート3000");
    // dontに本番DB禁止が含まれる
    expect(context.dont).toContain("本番データベース");

    storage.close();
  });

  it("マイグレーション後に新規saveしても既存データに影響しない", () => {
    createV1TestData(memoryPath);

    const storage = new SQLiteStorage(dbPath);
    storage.initialize(memoryPath);

    // 新規エントリを保存
    storage.save({
      category: "config",
      title: "新規設定",
      content: "マイグレーション後に追加した設定",
      tags: ["new"],
    });

    // 全件確認: 7(v1) + 1(新規) = 8
    const allResults = storage.search({ query: "" });
    expect(allResults.totalCount).toBe(8);

    // v1エントリはそのまま
    const detail = storage.getDetail({ ids: ["mig-001"] });
    expect(detail.entries[0].content).toContain("ポート3000");

    storage.close();
  });
});
