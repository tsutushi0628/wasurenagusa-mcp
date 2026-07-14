import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";
import { GUARDS_DDL } from "../storage/schema.js";
import {
  getActiveGuards,
  evaluateGuards,
  checkGuardsFromDb,
  countActiveGuards,
  activateGuard,
  GuardCapExceededError,
  GuardNotFoundError,
  DEFAULT_MAX_ACTIVE_GUARDS,
  evaluateGuardsWithMode,
  computeBlockRateReport,
  type GuardRule,
} from "./registry.js";

function insertGuard(
  db: Database.Database,
  row: {
    id: string;
    pattern: string;
    sourceIncidentId: string;
    approvedAt?: string | null;
    expiresAt: string;
    state: "proposed" | "active" | "expired" | "disabled";
  },
): void {
  db.prepare(
    `INSERT INTO guards (id, pattern, source_incident_id, approved_at, expires_at, state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(row.id, row.pattern, row.sourceIncidentId, row.approvedAt ?? null, row.expiresAt, row.state);
}

describe("guards レジストリ（タスク4.5・R-C4）", () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-guards-registry-test-"));
    db = new Database(join(tmpDir, "memory.db"));
    db.exec(GUARDS_DDL);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("getActiveGuards", () => {
    it("state='active' かつ期限内の規則のみを返す", () => {
      insertGuard(db, { id: "g-active", pattern: "foo", sourceIncidentId: "inc-1", expiresAt: "2099-01-01T00:00:00.000Z", state: "active" });
      insertGuard(db, { id: "g-proposed", pattern: "bar", sourceIncidentId: "inc-2", expiresAt: "2099-01-01T00:00:00.000Z", state: "proposed" });
      insertGuard(db, { id: "g-expired", pattern: "baz", sourceIncidentId: "inc-3", expiresAt: "2099-01-01T00:00:00.000Z", state: "expired" });
      insertGuard(db, { id: "g-disabled", pattern: "qux", sourceIncidentId: "inc-4", expiresAt: "2099-01-01T00:00:00.000Z", state: "disabled" });

      const rules = getActiveGuards(db);
      expect(rules.map((r) => r.id)).toEqual(["g-active"]);
    });

    it("state='active' でも expires_at が過去なら返さない（未承認と失効は評価されない）", () => {
      insertGuard(db, { id: "g-lapsed", pattern: "foo", sourceIncidentId: "inc-1", expiresAt: "2000-01-01T00:00:00.000Z", state: "active" });

      const rules = getActiveGuards(db, new Date("2026-01-01T00:00:00.000Z"));
      expect(rules).toEqual([]);
    });

    it("guards テーブルが0件なら空配列を返す", () => {
      expect(getActiveGuards(db)).toEqual([]);
    });
  });

  describe("evaluateGuards（fail-safe）", () => {
    it("active規則が0件なら常にpass（何もブロックしない）", () => {
      const result = evaluateGuards("rm -rf /", []);
      expect(result.action).toBe("pass");
    });

    it("パターンにマッチしたら出所(source_incident_id相当)を含むblockを返す", () => {
      const guards: GuardRule[] = [
        {
          id: "g1",
          pattern: "禁止ワード",
          sourceIncidentId: "incident-42",
          approvedAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2099-01-01T00:00:00.000Z",
          state: "active",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ];
      const result = evaluateGuards("これは禁止ワードです", guards);
      expect(result.action).toBe("block");
      expect(result.matchedGuardId).toBe("g1");
      expect(result.message).toContain("incident-42");
    });

    it("マッチしなければpass", () => {
      const guards: GuardRule[] = [
        {
          id: "g1",
          pattern: "禁止ワード",
          sourceIncidentId: "incident-42",
          approvedAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2099-01-01T00:00:00.000Z",
          state: "active",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ];
      expect(evaluateGuards("普通のコマンド", guards).action).toBe("pass");
    });
  });

  describe("checkGuardsFromDb（統合経路）", () => {
    it("proposed規則しか無ければpass（未承認は評価されない）", () => {
      insertGuard(db, { id: "g-proposed", pattern: "危険", sourceIncidentId: "inc-1", expiresAt: "2099-01-01T00:00:00.000Z", state: "proposed" });
      expect(checkGuardsFromDb(db, "危険なコマンド").action).toBe("pass");
    });

    it("active規則にマッチすればblock", () => {
      insertGuard(db, { id: "g-active", pattern: "危険", sourceIncidentId: "inc-1", expiresAt: "2099-01-01T00:00:00.000Z", state: "active" });
      expect(checkGuardsFromDb(db, "危険なコマンド").action).toBe("block");
    });
  });

  describe("activateGuard（承認）", () => {
    it("proposedからactiveへ遷移する", () => {
      insertGuard(db, { id: "g1", pattern: "p", sourceIncidentId: "inc-1", expiresAt: "2099-01-01T00:00:00.000Z", state: "proposed" });
      activateGuard(db, "g1");
      const rules = getActiveGuards(db);
      expect(rules.map((r) => r.id)).toEqual(["g1"]);
      expect(rules[0].approvedAt).not.toBeNull();
    });

    it("存在しないidはGuardNotFoundErrorをthrow", () => {
      expect(() => activateGuard(db, "nope")).toThrow(GuardNotFoundError);
    });

    it("アクティブ規則数が上限を超える有効化はGuardCapExceededErrorをthrowし、遷移しない", () => {
      for (let i = 0; i < 3; i++) {
        insertGuard(db, { id: `active-${i}`, pattern: `p${i}`, sourceIncidentId: "inc-1", expiresAt: "2099-01-01T00:00:00.000Z", state: "active" });
      }
      insertGuard(db, { id: "g-new", pattern: "p-new", sourceIncidentId: "inc-1", expiresAt: "2099-01-01T00:00:00.000Z", state: "proposed" });

      expect(() => activateGuard(db, "g-new", 3)).toThrow(GuardCapExceededError);

      const row = db.prepare("SELECT state FROM guards WHERE id = 'g-new'").get() as { state: string };
      expect(row.state).toBe("proposed");
    });

    it("上限未満なら有効化できる（既定上限DEFAULT_MAX_ACTIVE_GUARDS）", () => {
      insertGuard(db, { id: "g1", pattern: "p", sourceIncidentId: "inc-1", expiresAt: "2099-01-01T00:00:00.000Z", state: "proposed" });
      expect(() => activateGuard(db, "g1", DEFAULT_MAX_ACTIVE_GUARDS)).not.toThrow();
    });

    it("既にactiveなら冪等に成功する（再承認）", () => {
      insertGuard(db, { id: "g1", pattern: "p", sourceIncidentId: "inc-1", expiresAt: "2099-01-01T00:00:00.000Z", state: "active" });
      expect(() => activateGuard(db, "g1")).not.toThrow();
    });

    it("countActiveGuardsが期限内activeのみを数える", () => {
      insertGuard(db, { id: "g1", pattern: "p", sourceIncidentId: "inc-1", expiresAt: "2099-01-01T00:00:00.000Z", state: "active" });
      insertGuard(db, { id: "g2", pattern: "p", sourceIncidentId: "inc-1", expiresAt: "2000-01-01T00:00:00.000Z", state: "active" });
      expect(countActiveGuards(db)).toBe(1);
    });
  });

  describe("dry-run観測モード（タスク4.15）", () => {
    it("dry-runでは違反検出してもaction=passを返し、observationに検出実態を残す", () => {
      const guards: GuardRule[] = [
        {
          id: "g1",
          pattern: "危険",
          sourceIncidentId: "inc-1",
          approvedAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2099-01-01T00:00:00.000Z",
          state: "active",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ];
      const { result, observation } = evaluateGuardsWithMode("危険なコマンド", guards, "dry-run");
      expect(result.action).toBe("pass");
      expect(observation.action).toBe("block");
      expect(observation.mode).toBe("dry-run");
    });

    it("enforceモードでは実際にblockを返す", () => {
      const guards: GuardRule[] = [
        {
          id: "g1",
          pattern: "危険",
          sourceIncidentId: "inc-1",
          approvedAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2099-01-01T00:00:00.000Z",
          state: "active",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ];
      const { result } = evaluateGuardsWithMode("危険なコマンド", guards, "enforce");
      expect(result.action).toBe("block");
    });

    it("computeBlockRateReportが検出率を集計する", () => {
      const report = computeBlockRateReport([
        { ts: "t1", action: "block", mode: "dry-run" },
        { ts: "t2", action: "pass", mode: "dry-run" },
        { ts: "t3", action: "pass", mode: "dry-run" },
        { ts: "t4", action: "pass", mode: "dry-run" },
      ]);
      expect(report.totalObservations).toBe(4);
      expect(report.wouldBlockCount).toBe(1);
      expect(report.wouldBlockRate).toBe(0.25);
    });
  });
});
