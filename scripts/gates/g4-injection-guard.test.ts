/**
 * scripts/gates/g4-injection-guard.test.ts
 *
 * タスク4.11（検証役）: G4が実装状態でPASSし、意図的な違反状態でFAILすることを確認する。
 * 静的構造検査（injection-composition/fail-loud/pull-fixed-blocks/get-context-cap/
 * dead-code-removed/before-after）はG3方式（一時repoへ違反ソースを注入）で違反を再現する。
 * 関数検査（injection-budget/guard-approval/guard-cap/circuit-breaker/kill-switch）は
 * 検査対象関数を差し替え可能なdepsパラメータを使い、意図的に壊れた実装を注入して違反を再現する
 * （本番実装 src/ 配下のコードは一切変更しない）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  checkInjectionBudget,
  checkInjectionComposition,
  checkFailLoud,
  checkPullFixedBlocks,
  checkGetContextCap,
  checkGuardApproval,
  checkGuardCap,
  checkCircuitBreaker,
  checkKillSwitch,
  checkDeadCodeRemoved,
  checkBeforeAfter,
  runG4,
} from "./g4-injection-guard.js";
import type { GuardRule } from "../../src/guards/registry.js";
import { evaluateGuards as prodEvaluateGuards } from "../../src/guards/registry.js";
import type { EvalAction } from "../../src/guards/circuit-breaker.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ------------------------------------------------------------------
// 実装状態でPASSすることの確認
// ------------------------------------------------------------------

describe("G4 検査は実装状態で全項目PASSする", () => {
  it("injection-budget は PASS", () => {
    expect(checkInjectionBudget().result).toBe("PASS");
  });
  it("injection-composition は PASS", () => {
    expect(checkInjectionComposition(REPO_ROOT).result).toBe("PASS");
  });
  it("fail-loud は PASS", () => {
    expect(checkFailLoud(REPO_ROOT).result).toBe("PASS");
  });
  it("pull-fixed-blocks は PASS", () => {
    expect(checkPullFixedBlocks(REPO_ROOT).result).toBe("PASS");
  });
  it("get-context-cap は PASS", () => {
    expect(checkGetContextCap(REPO_ROOT).result).toBe("PASS");
  });
  it("guard-approval は PASS", () => {
    expect(checkGuardApproval().result).toBe("PASS");
  });
  it("guard-cap は PASS", () => {
    expect(checkGuardCap().result).toBe("PASS");
  });
  it("circuit-breaker は PASS", () => {
    expect(checkCircuitBreaker().result).toBe("PASS");
  });
  it("kill-switch は PASS", () => {
    expect(checkKillSwitch().result).toBe("PASS");
  });
  it("dead-code-removed は PASS", () => {
    expect(checkDeadCodeRemoved(REPO_ROOT).result).toBe("PASS");
  });
  it("before-after は PASS", () => {
    expect(checkBeforeAfter(REPO_ROOT).result).toBe("PASS");
  });
  it("runG4は--store未指定で11項目すべて実行しPASSする", () => {
    const { checks } = runG4({ repoRoot: REPO_ROOT });
    expect(checks).toHaveLength(11);
    expect(checks.every((c) => c.result === "PASS")).toBe(true);
  });
});

// ------------------------------------------------------------------
// 関数検査: 意図的に壊れた実装を注入したときFAILする
// ------------------------------------------------------------------

describe("G4 関数検査は意図的な違反状態でFAILする", () => {
  it("injection-budget: バジェットを無視するbuildInjectionではFAIL", () => {
    const brokenBuildInjection = (() => ({
      text: "x".repeat(100000),
      tokenCount: 100000,
      truncated: false,
      skipped: [],
    })) as unknown as typeof import("../../src/injection/builder.js").buildInjection;
    const result = checkInjectionBudget({ buildInjection: brokenBuildInjection });
    expect(result.result).toBe("FAIL");
    expect(result.measured.violations).toBeGreaterThan(0);
  });

  it("guard-approval: 未承認/失効を除外しないgetActiveGuardsではFAIL", () => {
    const brokenGetActiveGuards = ((db: unknown) => {
      // state条件を無視して全件（proposed/expiredも）返す壊れた実装。
      const rows = (db as import("better-sqlite3").Database)
        .prepare("SELECT id, pattern, source_incident_id, approved_at, expires_at, state, created_at FROM guards")
        .all() as Array<{
        id: string;
        pattern: string;
        source_incident_id: string;
        approved_at: string | null;
        expires_at: string;
        state: string;
        created_at: string;
      }>;
      return rows.map((r) => ({
        id: r.id,
        pattern: r.pattern,
        sourceIncidentId: r.source_incident_id,
        approvedAt: r.approved_at,
        expiresAt: r.expires_at,
        state: r.state as GuardRule["state"],
        createdAt: r.created_at,
      }));
    }) as unknown as typeof import("../../src/guards/registry.js").getActiveGuards;
    const result = checkGuardApproval({ getActiveGuards: brokenGetActiveGuards, evaluateGuards: prodEvaluateGuards });
    expect(result.result).toBe("FAIL");
  });

  it("guard-cap: 上限を無視するactivateGuardではFAIL", () => {
    const noopActivateGuard = (() => {
      // 何もthrowせず常に成功する壊れた実装（上限チェックが無い）。
    }) as unknown as typeof import("../../src/guards/registry.js").activateGuard;
    const result = checkGuardCap({ activateGuard: noopActivateGuard });
    expect(result.result).toBe("FAIL");
  });

  it("circuit-breaker: 常にfalseを返すisCircuitOpenではFAIL", () => {
    const brokenIsCircuitOpen = (() => false) as (history: EvalAction[]) => boolean;
    const result = checkCircuitBreaker({ isCircuitOpen: brokenIsCircuitOpen });
    expect(result.result).toBe("FAIL");
  });

  it("kill-switch: 常にfalseを返すisKilledではFAIL", () => {
    const brokenIsKilled = (() => false) as (memoryPath: string) => boolean;
    const result = checkKillSwitch({ isKilled: brokenIsKilled });
    expect(result.result).toBe("FAIL");
  });
});

// ------------------------------------------------------------------
// 静的構造検査: 一時repoへ違反ソースを注入したときFAILする（G3方式）
// ------------------------------------------------------------------

describe("G4 静的構造検査は意図的な違反状態でFAILする", () => {
  let tmpRepo: string;

  beforeEach(() => {
    tmpRepo = mkdtempSync(join(tmpdir(), "g4-violation-"));
  });

  afterEach(() => {
    rmSync(tmpRepo, { recursive: true, force: true });
  });

  it("injection-composition: 全文content混入があればFAIL", () => {
    mkdirSync(join(tmpRepo, "src/injection"), { recursive: true });
    mkdirSync(join(tmpRepo, "src/storage"), { recursive: true });
    writeFileSync(
      join(tmpRepo, "src/injection/builder.ts"),
      `
      getMinimalIndexEntries(); getInjectablePrinciples();
      const lines = indexEntries.map((e) => \`[\${e.category}] \${e.title} (\${e.id})\`);
      const bad = e.content; // 違反: 本文全文の混入
      `,
      "utf-8",
    );
    writeFileSync(
      join(tmpRepo, "src/storage/sqlite.ts"),
      `state = 'active' approved_at IS NOT NULL valid_until > ?`,
      "utf-8",
    );
    expect(checkInjectionComposition(tmpRepo).result).toBe("FAIL");
  });

  it("fail-loud: skipped計数が無ければFAIL", () => {
    mkdirSync(join(tmpRepo, "src/injection"), { recursive: true });
    mkdirSync(join(tmpRepo, "src/cli"), { recursive: true });
    writeFileSync(join(tmpRepo, "src/injection/builder.ts"), "// skipped計数なし", "utf-8");
    writeFileSync(join(tmpRepo, "src/cli/context.ts"), "// fail-loud警報なし", "utf-8");
    expect(checkFailLoud(tmpRepo).result).toBe("FAIL");
  });

  it("pull-fixed-blocks: listHighIntensityDontsを無条件呼び出しすればFAIL", () => {
    mkdirSync(join(tmpRepo, "src/tools"), { recursive: true });
    writeFileSync(
      join(tmpRepo, "src/tools/search.ts"),
      `export async function handleMemorySearch() { const donts = storage.listHighIntensityDonts(); }`,
      "utf-8",
    );
    expect(checkPullFixedBlocks(tmpRepo).result).toBe("FAIL");
  });

  it("get-context-cap: 上限定数が無ければFAIL", () => {
    mkdirSync(join(tmpRepo, "src/storage"), { recursive: true });
    writeFileSync(join(tmpRepo, "src/storage/sqlite.ts"), "// 上限定数なし", "utf-8");
    expect(checkGetContextCap(tmpRepo).result).toBe("FAIL");
  });

  it("dead-code-removed: v1ワーカーが残っていればFAIL", () => {
    mkdirSync(join(tmpRepo, "src/cli"), { recursive: true });
    mkdirSync(join(tmpRepo, "src/consolidator"), { recursive: true });
    mkdirSync(join(tmpRepo, "src/tools"), { recursive: true });
    mkdirSync(join(tmpRepo, "docs"), { recursive: true });
    writeFileSync(join(tmpRepo, "src/cli/consolidate-worker.ts"), "// 復活してしまった死コード", "utf-8");
    writeFileSync(join(tmpRepo, "src/consolidator/staleness.ts"), "", "utf-8");
    writeFileSync(join(tmpRepo, "src/tools/save.ts"), "", "utf-8");
    writeFileSync(join(tmpRepo, "src/cli/context.ts"), "", "utf-8");
    writeFileSync(join(tmpRepo, "docs/graveyard.md"), "予測誤差ループ（保留・削除見送り）", "utf-8");
    expect(checkDeadCodeRemoved(tmpRepo).result).toBe("FAIL");
  });

  it("before-after: 比較スクリプトが無ければFAIL", () => {
    expect(checkBeforeAfter(tmpRepo).result).toBe("FAIL");
  });
});
