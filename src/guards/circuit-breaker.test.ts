import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  computeBlockRate,
  isCircuitOpen,
  recordEvaluation,
  getRecentHistory,
  CIRCUIT_BREAKER_WINDOW,
  CIRCUIT_BREAKER_BLOCK_RATE_THRESHOLD,
} from "./circuit-breaker.js";

describe("circuit-breaker（タスク4.6・R-C4）", () => {
  describe("computeBlockRate / isCircuitOpen（純粋関数）", () => {
    it("履歴が空ならブロック率0でサーキットは開かない", () => {
      expect(computeBlockRate([])).toBe(0);
      expect(isCircuitOpen([])).toBe(false);
    });

    it("直近100回でブロック率が10%を超えると開く", () => {
      const history = [...Array(9).fill("block"), ...Array(91).fill("pass")] as ("pass" | "block")[];
      expect(computeBlockRate(history)).toBeCloseTo(0.09);
      expect(isCircuitOpen(history)).toBe(false);

      const historyOver = [...Array(11).fill("block"), ...Array(89).fill("pass")] as ("pass" | "block")[];
      expect(computeBlockRate(historyOver)).toBeCloseTo(0.11);
      expect(isCircuitOpen(historyOver)).toBe(true);
    });

    it("閾値ちょうど（10%）は開かない（超過のみ開く）", () => {
      const history = [...Array(10).fill("block"), ...Array(90).fill("pass")] as ("pass" | "block")[];
      expect(computeBlockRate(history)).toBeCloseTo(CIRCUIT_BREAKER_BLOCK_RATE_THRESHOLD);
      expect(isCircuitOpen(history)).toBe(false);
    });

    it("全件blockなら開く", () => {
      expect(isCircuitOpen(Array(5).fill("block"))).toBe(true);
    });
  });

  describe("recordEvaluation / getRecentHistory（永続化）", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-circuit-breaker-test-"));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("記録した評価が読み戻せる", async () => {
      await recordEvaluation(tmpDir, "pass");
      await recordEvaluation(tmpDir, "block");
      const history = await getRecentHistory(tmpDir);
      expect(history).toEqual(["pass", "block"]);
    });

    it("直近window件のみを返す（古い分は切り捨て）", async () => {
      for (let i = 0; i < 105; i++) {
        await recordEvaluation(tmpDir, i < 5 ? "block" : "pass");
      }
      const history = await getRecentHistory(tmpDir, CIRCUIT_BREAKER_WINDOW);
      expect(history.length).toBe(CIRCUIT_BREAKER_WINDOW);
      // 先頭5件のblockは切り捨てられ、直近100件は全てpassのはず
      expect(history.every((a) => a === "pass")).toBe(true);
    });

    it("未作成ファイルはfail-openで空配列", async () => {
      expect(await getRecentHistory(join(tmpDir, "not-exist"))).toEqual([]);
    });

    it("実運用相当: 直近100回でブロック率が10%を超えると自動停止すべきと判定できる", async () => {
      for (let i = 0; i < 100; i++) {
        await recordEvaluation(tmpDir, i < 15 ? "block" : "pass");
      }
      const history = await getRecentHistory(tmpDir);
      expect(isCircuitOpen(history)).toBe(true);
    });
  });
});
