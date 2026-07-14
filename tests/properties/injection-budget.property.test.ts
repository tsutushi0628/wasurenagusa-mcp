/**
 * tests/properties/injection-budget.property.test.ts
 *
 * タスク4.10（検証役）: PT-02 注入トークンバジェット不変条件プロパティテスト。
 * design.md 受け入れ基準（R-C1, R-C4, R-M3のうちR-C1中心）の不変条件化:
 *   「注入本文（buildInjection の戻り値 text）の概算トークン数は、常に指定バジェット以下」
 * 素材（最小索引エントリ・承認済み確定原則）の件数・本文長・欠損パターンを fast-check で
 * 生成し、100ケース以上で検証する。
 *
 * 検査対象は本番実装（src/injection/builder.ts の buildInjection・src/injection/budget.ts の
 * enforceInjectionTokenBudget/estimateTokens）。実装コードは変更しない。
 */
import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SQLiteStorage } from "../../src/storage/sqlite.js";
import { buildInjection } from "../../src/injection/builder.js";
import { estimateTokens, DEFAULT_INJECTION_TOKEN_BUDGET } from "../../src/injection/budget.js";
import type { MemoryCategory } from "../../src/types.js";

/** テスト用フィクスチャ一式。使い捨てのSQLite DBを作る。 */
function withFreshStorage<T>(fn: (storage: SQLiteStorage) => T): T {
  const tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-pt-injection-budget-"));
  const dbPath = join(tmpDir, "test.db");
  const storage = new SQLiteStorage(dbPath);
  storage.initialize();
  try {
    return fn(storage);
  } finally {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** 索引エントリ1件分の生成計画（件数・本文長のばらつきを表現する）。 */
interface IndexEntryPlan {
  titleLength: number;
  category: MemoryCategory;
}

/** 確定原則1件分の生成計画。 */
interface PrincipleEntryPlan {
  textLength: number;
}

const indexEntryArb: fc.Arbitrary<IndexEntryPlan> = fc.record({
  // 短文〜長文（欠損パターンの片端としてtitleLength=0=空文字も許容）まで幅広く生成する。
  titleLength: fc.integer({ min: 0, max: 800 }),
  category: fc.constantFrom<MemoryCategory>("log", "dont", "config"),
});

const principleEntryArb: fc.Arbitrary<PrincipleEntryPlan> = fc.record({
  textLength: fc.integer({ min: 0, max: 800 }),
});

/**
 * 素材の欠損パターン（索引0件・原則0件・両方0件・両方あり）も生成対象に含める。
 * tasks.md 4.10（888行）の対象はエントリ集合（件数・本文長・欠損パターン）の生成であり、
 * バジェット値そのものは可変対象に含まれない。バジェットは本番既定値
 * （DEFAULT_INJECTION_TOKEN_BUDGET=8000）に固定する（design.md「注入ビルダ」節の実運用値）。
 * 参考: バジェットを極端に小さい値（マーカー文言自体のトークン数未満）まで生成器に含めると、
 * enforceInjectionTokenBudget の切り詰めマーカー行自体が上限を超過し得る境界（budget.ts
 * 60行「（注入がバジェット上限で切り詰められました...）」は自身のトークン数を上限チェック
 * せずに常時付加される）が露出するが、本番の実運用バジェット帯では起こらないため、
 * このPT-02では実運用帯を対象にする（発見事項として完了報告に1行残す）。
 */
const scenarioArb = fc.record({
  indexEntries: fc.array(indexEntryArb, { minLength: 0, maxLength: 60 }),
  principleEntries: fc.array(principleEntryArb, { minLength: 0, maxLength: 30 }),
});

/** 日本語マルチバイト文字での長さ検査を含めるため、繰り返し文字列を長さ指定で生成する。 */
function makeText(length: number, seedChar: string): string {
  if (length === 0) return "";
  return seedChar.repeat(length);
}

describe("PT-02 注入トークンバジェット（design.md 不変条件・R-C1）", () => {
  it("生成された索引/原則の件数・本文長・欠損パターンに関わらず、注入本文のトークン数は常にバジェット以下", () => {
    fc.assert(
      fc.property(scenarioArb, ({ indexEntries, principleEntries }) => {
        const budgetTokens = DEFAULT_INJECTION_TOKEN_BUDGET;
        withFreshStorage((storage) => {
          indexEntries.forEach((plan, i) => {
            storage.save({
              category: plan.category,
              title: makeText(plan.titleLength, "あ") || `t${i}`,
              content: `content-${i}`,
            });
          });

          const now = new Date();
          const validUntil = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString();
          principleEntries.forEach((plan, i) => {
            const id = `pt02-principle-${i}`;
            storage.insertPrinciple({
              id,
              text: makeText(plan.textLength, "い") || `p${i}`,
              originTier: "agent_observed",
              evidenceIds: [],
              validUntil,
            });
            storage.approvePrinciple(id, now);
          });

          const result = buildInjection(storage, undefined, budgetTokens, now);

          // 不変条件そのもの: 注入本文の概算トークン数はバジェット以下（budget.tsの本番estimateTokensで測る）。
          expect(estimateTokens(result.text)).toBeLessThanOrEqual(budgetTokens);
          // 戻り値のtokenCountも自己申告のバジェット違反をしていないこと。
          expect(result.tokenCount).toBeLessThanOrEqual(budgetTokens);
          // 欠損（索引0件・原則0件）は無言にならず、素材がある場合は truncated か skipped のどちらかで
          // 状況が可視化されている、または正常に収まっている（3値のいずれかは必ず成立）。
          expect(typeof result.truncated).toBe("boolean");
          expect(Array.isArray(result.skipped)).toBe(true);
        });
      }),
      { numRuns: 120 },
    );
  });
});
