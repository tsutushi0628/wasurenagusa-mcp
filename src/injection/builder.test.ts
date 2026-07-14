import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import fc from "fast-check";

import { SQLiteStorage } from "../storage/sqlite.js";
import { config } from "../config.js";
import { buildInjection, MINIMAL_INDEX_LIMIT } from "./builder.js";
import { estimateTokens } from "./budget.js";

/**
 * 注入ビルダ（buildInjection）の業務要件を検証する（タスク4.2）。
 *
 * 業務要件（design.md「昇格の人間ゲート」「最小索引」「禁止フォールバック#1」）:
 *   1. 注入本文が最小索引と approved かつ有効期限内の原則のみで構成される
 *      （未承認proposed・失効expired・却下rejectedの原則は決して出ない）
 *   2. 素材欠損時に全文フォールバックせず、スキップ理由が計数される
 *   3. 任意のDB状態でバジェット以下（PT-02相当のプロパティテスト）
 */
describe("buildInjection: 注入本文の構成", () => {
  let tmpDir: string;
  let projectRoot: string;
  let memoryPath: string;
  let dbPath: string;
  let storage: SQLiteStorage;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-builder-test-"));
    projectRoot = join(tmpDir, "myproject");
    memoryPath = join(projectRoot, ".wasurenagusa");
    dbPath = join(memoryPath, config.sqliteFile);
    mkdirSync(memoryPath, { recursive: true });
    storage = new SQLiteStorage(dbPath);
    storage.initialize(memoryPath);
  });

  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("空DBでは最小索引0件・原則0件で、全文フォールバックせず理由が積まれる", () => {
    const result = buildInjection(storage, "myproject");

    expect(result.text).not.toContain("undefined");
    expect(result.skipped).toContain("minimal-index-empty");
  });

  it("state='active'の記憶はタイトル行のみで索引に入り、本文（content）は注入されない", () => {
    storage.save({
      category: "config",
      title: "APIキーはSecret Manager管理",
      content: "本文がここに漏れたら全文注入の再発なので絶対に混入しないこと",
      tags: [],
      project: "myproject",
    });

    const result = buildInjection(storage, "myproject");

    expect(result.text).toContain("APIキーはSecret Manager管理");
    expect(result.text).not.toContain("本文がここに漏れたら");
  });

  it("承認済み(approved)かつ有効期限内の原則のみが注入され、未承認・失効・却下は出ない", () => {
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    storage.insertPrinciple({
      id: "p-approved",
      text: "承認済み原則テキスト",
      originTier: "owner_confirmed",
      evidenceIds: ["e1"],
      validUntil: future,
    });
    storage.approvePrinciple("p-approved");

    storage.insertPrinciple({
      id: "p-proposed",
      text: "未承認原則テキスト",
      originTier: "agent_observed",
      evidenceIds: ["e2"],
      validUntil: future,
    });
    // 承認しない（proposedのまま）

    storage.insertPrinciple({
      id: "p-expired",
      text: "失効原則テキスト",
      originTier: "owner_confirmed",
      evidenceIds: ["e3"],
      validUntil: past,
    });
    storage.approvePrinciple("p-expired");

    const result = buildInjection(storage, "myproject");

    expect(result.text).toContain("承認済み原則テキスト");
    expect(result.text).not.toContain("未承認原則テキスト");
    expect(result.text).not.toContain("失効原則テキスト");
  });

  it("索引取得が例外を投げても、全文フォールバックせずエラー理由を積んで空文字続行する", () => {
    const brokenStorage = {
      getMinimalIndexEntries: () => {
        throw new Error("index unavailable");
      },
      getInjectablePrinciples: () => [],
    } as unknown as SQLiteStorage;

    const result = buildInjection(brokenStorage, "myproject");

    expect(result.skipped).toContain("minimal-index-error");
    expect(result.text).not.toContain("index unavailable");
  });

  it("索引が上限件数を超えても、返却件数はMINIMAL_INDEX_LIMIT以下に保たれる（ストレージ側の上限適用を前提に、ビルダが上限超過分を追加しない）", () => {
    for (let i = 0; i < MINIMAL_INDEX_LIMIT + 20; i++) {
      storage.save({
        category: "log",
        title: `ログ${i}`,
        content: "内容",
        tags: [],
        project: "myproject",
      });
    }

    const result = buildInjection(storage, "myproject", 100000);
    const indexLines = result.text
      .split("\n")
      .filter((l) => l.startsWith("[log]"));

    expect(indexLines.length).toBeLessThanOrEqual(MINIMAL_INDEX_LIMIT);
  });

  it("バジェット超過時は切り詰められ、skippedにbudget-truncated理由が積まれる", () => {
    for (let i = 0; i < 30; i++) {
      storage.save({
        category: "config",
        title: `非常に長いタイトルを持つ設定エントリその${i}`.repeat(5),
        content: "内容",
        tags: [],
        project: "myproject",
      });
    }

    const tinyBudget = 50;
    const result = buildInjection(storage, "myproject", tinyBudget);

    expect(result.truncated).toBe(true);
    expect(result.skipped.some((s) => s.startsWith("budget-truncated"))).toBe(true);
    expect(estimateTokens(result.text)).toBeLessThanOrEqual(
      tinyBudget + estimateTokens("（注入がバジェット上限で切り詰められました: 約99999 トークン省略）"),
    );
  });

  it("PT-02相当: 任意のDB状態（エントリ件数・本文長・欠損パターン）で注入トークン数がバジェット以下", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            title: fc.string({ minLength: 1, maxLength: 200 }),
            content: fc.string({ minLength: 0, maxLength: 5000 }),
          }),
          { maxLength: 30 },
        ),
        (entries) => {
          const caseDir = mkdtempSync(join(tmpdir(), "wasurenagusa-builder-pt02-"));
          const caseMemoryPath = join(caseDir, ".wasurenagusa");
          mkdirSync(caseMemoryPath, { recursive: true });
          const caseStorage = new SQLiteStorage(join(caseMemoryPath, config.sqliteFile));
          try {
            caseStorage.initialize(caseMemoryPath);
            for (const e of entries) {
              caseStorage.save({
                category: "config",
                title: e.title || "無題",
                content: e.content,
                tags: [],
                project: "myproject",
              });
            }

            const budgetTokens = DEFAULT_INJECTION_TOKEN_BUDGET_FOR_TEST;
            const result = buildInjection(caseStorage, "myproject", budgetTokens);

            expect(result.tokenCount).toBeLessThanOrEqual(
              budgetTokens + BUDGET_MARKER_SLACK,
            );
          } finally {
            caseStorage.close();
            rmSync(caseDir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 25 },
    );
  });
});

// PT-02プロパティテストで使う既定バジェットと、切り詰めマーカー行自体の分だけ許容する誤差
// （マーカー行「（注入がバジェット上限で切り詰められました: 約N トークン省略）」自体のトークン数）。
const DEFAULT_INJECTION_TOKEN_BUDGET_FOR_TEST = 500;
const BUDGET_MARKER_SLACK = 60;
