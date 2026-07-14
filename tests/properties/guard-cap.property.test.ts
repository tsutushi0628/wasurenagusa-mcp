/**
 * tests/properties/guard-cap.property.test.ts
 *
 * タスク4.10（検証役）: PT-03 ガード上限不変条件プロパティテスト。
 * design.md 受け入れ基準（R-C4, R-M3）の不変条件化:
 *   「アクティブ規則数が上限（既定 DEFAULT_MAX_ACTIVE_GUARDS=20、生成器で可変にした上限含む）に
 *   達している状態で、新規規則を activate しようとすると常に GuardCapExceededError を投げ、
 *   規則は active に遷移しない（DB状態も変化しない）」
 *
 * 検査対象は本番実装（src/guards/registry.ts の activateGuard・countActiveGuards）。
 * 実装コードは変更しない。既存 tests/guards/registry.test.ts と同じ生SQL INSERTフィクスチャ
 * 規約（insertGuard）を踏襲する。
 */
import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";
import { GUARDS_DDL } from "../../src/storage/schema.js";
import {
  activateGuard,
  countActiveGuards,
  GuardCapExceededError,
  type GuardState,
} from "../../src/guards/registry.js";

function insertGuard(
  db: Database.Database,
  row: {
    id: string;
    pattern: string;
    sourceIncidentId: string;
    approvedAt?: string | null;
    expiresAt: string;
    state: GuardState;
  },
): void {
  db.prepare(
    `INSERT INTO guards (id, pattern, source_incident_id, approved_at, expires_at, state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(row.id, row.pattern, row.sourceIncidentId, row.approvedAt ?? null, row.expiresAt, row.state);
}

function withFreshGuardsDb<T>(fn: (db: Database.Database) => T): T {
  const tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-pt-guard-cap-"));
  const db = new Database(join(tmpDir, "memory.db"));
  db.exec(GUARDS_DDL);
  try {
    return fn(db);
  } finally {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

const FAR_FUTURE = "2099-01-01T00:00:00.000Z";

/**
 * 規則追加列の生成計画: 上限値そのものと、その上限ちょうどまでを埋める既存active件数、
 * そこへ追加投入する新規proposed規則数（1件以上＝必ず上限超過を試す）を生成する。
 */
const scenarioArb = fc.record({
  maxActiveGuards: fc.integer({ min: 1, max: 30 }),
  extraProposedCount: fc.integer({ min: 1, max: 5 }),
});

describe("PT-03 ガード上限（design.md 不変条件・R-C4）", () => {
  it("アクティブ規則数が上限に達している状態からの新規有効化は常にエラーになり、状態は変化しない", () => {
    fc.assert(
      fc.property(scenarioArb, ({ maxActiveGuards, extraProposedCount }) => {
        withFreshGuardsDb((db) => {
          // 上限ちょうどまでactive規則を埋める。
          for (let i = 0; i < maxActiveGuards; i++) {
            insertGuard(db, {
              id: `cap-active-${i}`,
              pattern: `pattern-${i}`,
              sourceIncidentId: `inc-active-${i}`,
              approvedAt: FAR_FUTURE,
              expiresAt: FAR_FUTURE,
              state: "active",
            });
          }
          expect(countActiveGuards(db)).toBe(maxActiveGuards);

          // 上限超過を試みる新規proposed規則を複数件用意する。
          for (let i = 0; i < extraProposedCount; i++) {
            const id = `cap-proposed-${i}`;
            insertGuard(db, {
              id,
              pattern: `extra-pattern-${i}`,
              sourceIncidentId: `inc-extra-${i}`,
              expiresAt: FAR_FUTURE,
              state: "proposed",
            });

            // 不変条件そのもの: 上限到達済みでの有効化は常にGuardCapExceededErrorをthrowする。
            expect(() => activateGuard(db, id, maxActiveGuards)).toThrow(GuardCapExceededError);

            // 規則はactiveへ遷移していない（DB状態も変化していない）。
            const row = db.prepare("SELECT state, approved_at FROM guards WHERE id = ?").get(id) as {
              state: string;
              approved_at: string | null;
            };
            expect(row.state).toBe("proposed");
            expect(row.approved_at).toBeNull();

            // アクティブ件数自体も上限のまま増えていない。
            expect(countActiveGuards(db)).toBe(maxActiveGuards);
          }
        });
      }),
      { numRuns: 100 },
    );
  });
});
