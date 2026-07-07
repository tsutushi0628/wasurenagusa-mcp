/**
 * scripts/make-eval-snapshot.test.ts
 *
 * 実ストアから評価用スナップショットを作る処理の業務要件を検証する（タスク0.11）。
 *
 * 業務要件:
 * 1. 実DBをコピーし、コピー側のmemories.title/contentに含まれる秘密値パターンのみを
 *    [REDACTED] に置換する（日本語本文自体は保持する）
 * 2. 原本（コピー元）のDBは一切書き換えない
 * 3. v1資産（Markdown）・統合キャッシュのテキストファイルも同様にredactされる
 * 4. redact後のmanifest.jsonは最終状態と自己整合する（チェックサムが実ファイルと一致する）
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import Database from "better-sqlite3";

import { buildMiniStore } from "../tests/fixtures/mini-store/build-mini-store.js";
import { SQLiteStorage } from "../src/storage/sqlite.js";
import { redactMemoriesInPlace, redactTextAssetFiles, makeEvalSnapshot } from "./make-eval-snapshot.js";

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

describe("redactMemoriesInPlace", () => {
  it("秘密値パターン（メールアドレス・絶対パス）を含む行だけ[REDACTED]に置換し、他行は変えない", () => {
    const memoryPath = join(newScratchDir("mes-redact-"), ".wasurenagusa");
    buildMiniStore(memoryPath, { count: 5 });

    const dbPath = join(memoryPath, "memory.db");
    const storage = new SQLiteStorage(dbPath);
    storage.initialize(memoryPath);
    const secretResult = storage.save({
      category: "config",
      title: "連絡先メモ",
      content: "問い合わせ先は taro@example.com 、設定ファイルは /Users/testuser/secret.env にある。",
      tags: ["fixture"],
      project: "sample-webapp",
    });
    const cleanResult = storage.save({
      category: "config",
      title: "秘密値を含まないメモ",
      content: "これは秘密値を含まない普通の日本語本文です。",
      tags: ["fixture"],
      project: "sample-webapp",
    });
    storage.close();

    const changed = redactMemoriesInPlace(dbPath);
    expect(changed).toBe(1);

    const db = new Database(dbPath, { readonly: true });
    try {
      const secretRow = db.prepare("SELECT title, content FROM memories WHERE id = ?").get(secretResult.id) as {
        title: string;
        content: string;
      };
      expect(secretRow.content).toContain("[REDACTED]");
      expect(secretRow.content).not.toContain("taro@example.com");
      expect(secretRow.content).not.toContain("/Users/testuser/secret.env");

      const cleanRow = db.prepare("SELECT title, content FROM memories WHERE id = ?").get(cleanResult.id) as {
        title: string;
        content: string;
      };
      expect(cleanRow.content).toBe("これは秘密値を含まない普通の日本語本文です。");
    } finally {
      db.close();
    }
  });

  it("memoriesの全自由記述列（dont補助列・予測誤差列・tags・scope含む）がredactされる", () => {
    const memoryPath = join(newScratchDir("mes-redact-cols-"), ".wasurenagusa");
    buildMiniStore(memoryPath, { count: 3 });

    const dbPath = join(memoryPath, "memory.db");
    const storage = new SQLiteStorage(dbPath);
    storage.initialize(memoryPath);
    // 全自由記述列に合成の秘密値（メール・絶対パス）を仕込む
    const result = storage.save({
      category: "dont",
      title: "列網羅テスト taro@example.com",
      content: "本文 /Users/testuser/a.env",
      tags: ["連絡先はtaro@example.com"],
      project: "sample-webapp",
      scope: "設定は/Users/testuser/b.envにある",
      intensity: 5,
      knowledgeGap: ["鍵は/Users/testuser/c.envにある"],
      positiveAction: "taro@example.com へ連絡せず窓口を使う",
      scenario: "/Users/testuser/d.env を直接開いてしまった",
      whyCore: "taro@example.com に直接送ると記録が残らないため",
      predictedFactors: ["/Users/testuser/e.env の権限"],
      actualFactors: ["taro@example.com の設定ミス"],
      predictionDelta: "実際は /Users/testuser/f.env が原因だった",
    });
    storage.close();

    const changed = redactMemoriesInPlace(dbPath);
    expect(changed).toBeGreaterThanOrEqual(1);

    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db
        .prepare(
          "SELECT title, content, tags, scope, knowledge_gap, positive_action, scenario, why_core, predicted_factors, actual_factors, prediction_delta FROM memories WHERE id = ?",
        )
        .get(result.id) as Record<string, string | null>;

      const allText = Object.values(row).filter((v): v is string => typeof v === "string").join("\n");
      expect(allText).not.toContain("taro@example.com");
      expect(allText).not.toContain("/Users/testuser");
      expect(allText).toContain("[REDACTED]");

      // JSON列（tags・knowledge_gap・予測誤差2列）はredact後もJSONとしてパースできる
      for (const jsonColumn of ["tags", "knowledge_gap", "predicted_factors", "actual_factors"] as const) {
        const raw = row[jsonColumn];
        expect(raw, `${jsonColumn} はJSONのまま`).toBeTruthy();
        expect(() => JSON.parse(raw as string), `${jsonColumn} のJSON構造が壊れていない`).not.toThrow();
      }
    } finally {
      db.close();
    }
  });

  it("同一DB内の他テーブル（stash・session_topics・themes・consolidated）の自由記述もredactされる", () => {
    const memoryPath = join(newScratchDir("mes-redact-tables-"), ".wasurenagusa");
    buildMiniStore(memoryPath, { count: 3, seedGuardPattern: false });

    const dbPath = join(memoryPath, "memory.db");
    const db = new Database(dbPath);
    try {
      db.prepare(
        "INSERT INTO stash (id, content, summary, file_path, expires_at) VALUES ('st1', '鍵 sk-abcdefghijklmnopqrstu を退避', '要約 taro@example.com', '/Users/testuser/stash.txt', '2099-01-01')",
      ).run();
      db.prepare(
        "INSERT INTO session_topics (project, topic, session_at) VALUES ('sample-webapp', '直前の話題: /Users/testuser/topic.env の修正', '2026-07-08T00:00:00+09:00')",
      ).run();
      db.prepare("INSERT INTO themes (name) VALUES ('taro@example.comのテーマ')").run();
      db.prepare(
        "INSERT INTO consolidated (type, data, source_entry_count, consolidated_at) VALUES ('dont', ?, 1, '2026-07-08T00:00:00+09:00')",
      ).run(JSON.stringify({ principles: [{ theme: "連絡先", rule: "taro@example.com へ送らない", sourceIds: [] }] }));
    } finally {
      db.close();
    }

    redactMemoriesInPlace(dbPath);

    const verify = new Database(dbPath, { readonly: true });
    try {
      const stashRow = verify.prepare("SELECT content, summary, file_path FROM stash WHERE id = 'st1'").get() as Record<string, string>;
      expect(Object.values(stashRow).join("\n")).not.toMatch(/sk-abcdefghijklmnopqrstu|taro@example\.com|\/Users\/testuser/);

      const topicRow = verify.prepare("SELECT topic FROM session_topics WHERE project = 'sample-webapp'").get() as { topic: string };
      expect(topicRow.topic).not.toContain("/Users/testuser");

      const themeNames = (verify.prepare("SELECT name FROM themes").all() as { name: string }[]).map((r) => r.name).join("\n");
      expect(themeNames).not.toContain("taro@example.com");

      const consolidatedRow = verify.prepare("SELECT data FROM consolidated WHERE type = 'dont'").get() as { data: string };
      expect(consolidatedRow.data).not.toContain("taro@example.com");
      expect(() => JSON.parse(consolidatedRow.data), "consolidated.data のJSON構造が壊れていない").not.toThrow();
    } finally {
      verify.close();
    }
  });
});

describe("redactTextAssetFiles", () => {
  it("v1資産ファイルに含まれる秘密値パターンを置換し、含まないファイルは変えない", () => {
    const snapshotDir = newScratchDir("mes-textredact-");
    writeFileSync(join(snapshotDir, "dont.md"), "連絡先: taro@example.com を含む本文", "utf-8");
    writeFileSync(join(snapshotDir, "config.md"), "秘密値を含まない設定メモ", "utf-8");

    const redacted = redactTextAssetFiles(snapshotDir);
    expect(redacted).toEqual(["dont.md"]);

    expect(readFileSync(join(snapshotDir, "dont.md"), "utf-8")).toBe("連絡先: [REDACTED] を含む本文");
    expect(readFileSync(join(snapshotDir, "config.md"), "utf-8")).toBe("秘密値を含まない設定メモ");
  });

  it("アーカイブMarkdownとlogs/のJSONLも秘密値redactの対象になり、JSONL構造は壊れない", () => {
    const snapshotDir = newScratchDir("mes-archive-logs-redact-");
    writeFileSync(join(snapshotDir, "dont-archive.md"), "旧記録: 鍵は sk-abcdefghijklmnopqrstu にある", "utf-8");
    const logsDir = join(snapshotDir, "logs");
    mkdirSync(logsDir, { recursive: true });
    const logLine = JSON.stringify({
      ts: "2026-07-07T00:00:00+09:00",
      operation_type: "search",
      query: "設定ファイル /Users/someuser/app/.env の場所",
      hit_count: 1,
    });
    writeFileSync(join(logsDir, "operation-2026-07-07.jsonl"), logLine + "\n", "utf-8");

    const redacted = redactTextAssetFiles(snapshotDir);
    expect(redacted.sort()).toEqual(["dont-archive.md", "logs/operation-2026-07-07.jsonl"].sort());

    expect(readFileSync(join(snapshotDir, "dont-archive.md"), "utf-8")).not.toContain("sk-abcdefghijklmnopqrstu");

    const redactedLogRaw = readFileSync(join(logsDir, "operation-2026-07-07.jsonl"), "utf-8").trim();
    const parsed = JSON.parse(redactedLogRaw); // JSON構造が壊れていないこと
    expect(parsed.query).toContain("[REDACTED]");
    expect(parsed.query).not.toContain("/Users/someuser");
    expect(parsed.hit_count).toBe(1);
  });
});

describe("makeEvalSnapshot（統合実行）", () => {
  it(
    "原本を書き換えずコピー側だけredactし、manifest.jsonが最終状態と自己整合する",
    async () => {
      const memoryPath = join(newScratchDir("mes-full-"), ".wasurenagusa");
      buildMiniStore(memoryPath, { count: 10 });

      const dbPath = join(memoryPath, "memory.db");
      const storage = new SQLiteStorage(dbPath);
      storage.initialize(memoryPath);
      const secretResult = storage.save({
        category: "config",
        title: "秘密混入メモ",
        content: "連絡先は taro@example.com です。",
        tags: ["fixture"],
        project: "sample-webapp",
      });
      storage.close();

      const outDir = newScratchDir("mes-full-out-");
      const result = await makeEvalSnapshot(memoryPath, outDir);

      expect(result.memoriesRedactedCount).toBeGreaterThanOrEqual(1);

      // 原本は書き換えられていない（redact前の秘密値がそのまま残っている）
      const originalDb = new Database(dbPath, { readonly: true });
      try {
        const originalRow = originalDb
          .prepare("SELECT content FROM memories WHERE id = ?")
          .get(secretResult.id) as { content: string };
        expect(originalRow.content).toContain("taro@example.com");
      } finally {
        originalDb.close();
      }

      // コピー側はredactされている
      const snapshotDb = new Database(join(outDir, "memory.db"), { readonly: true });
      let manifestMemoriesCount: number;
      try {
        const snapshotRow = snapshotDb
          .prepare("SELECT content FROM memories WHERE id = ?")
          .get(secretResult.id) as { content: string };
        expect(snapshotRow.content).toContain("[REDACTED]");
        expect(snapshotRow.content).not.toContain("taro@example.com");
        manifestMemoriesCount = (snapshotDb.prepare("SELECT COUNT(*) as c FROM memories").get() as { c: number }).c;
      } finally {
        snapshotDb.close();
      }

      // manifest.jsonが最終状態（redact後）と自己整合する
      const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf-8"));
      expect(manifest.memoriesCount).toBe(manifestMemoriesCount);
      const { createHash } = await import("crypto");
      for (const entry of manifest.files as { relativePath: string; sha256: string }[]) {
        const actual = createHash("sha256").update(readFileSync(join(outDir, entry.relativePath))).digest("hex");
        expect(actual, `${entry.relativePath} のチェックサムがmanifestと一致しない`).toBe(entry.sha256);
      }
    },
    30000,
  );
});
