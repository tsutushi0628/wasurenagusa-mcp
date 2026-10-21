import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import * as fsPromises from "fs/promises";
import { join } from "path";
import type { EvalAction, EvalHistoryEntry } from "./circuit-breaker.js";
import {
  computeBlockRate,
  isCircuitOpen,
  recordEvaluation,
  getRecentHistory,
  CIRCUIT_BREAKER_WINDOW,
  CIRCUIT_BREAKER_BLOCK_RATE_THRESHOLD,
} from "./circuit-breaker.js";

vi.mock("fs/promises", { spy: true });

function getOriginalHistory(raw: string, window: number): EvalAction[] {
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const actions: EvalAction[] = [];
  for (const line of lines.slice(-window)) {
    try {
      const parsed = JSON.parse(line) as EvalHistoryEntry;
      if (parsed.action === "pass" || parsed.action === "block") {
        actions.push(parsed.action);
      }
    } catch {
      continue;
    }
  }
  return actions;
}

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

    async function createHistoryFile(): Promise<string> {
      await recordEvaluation(tmpDir, "pass", new Date("2026-01-01T00:00:00.000Z"));
      const logsDir = join(tmpDir, "logs");
      return join(logsDir, readdirSync(logsDir)[0]);
    }

    beforeEach(() => {
      const temporaryRoot = join(process.cwd(), ".tmp");
      mkdirSync(temporaryRoot, { recursive: true });
      tmpDir = mkdtempSync(join(temporaryRoot, "wasurenagusa-circuit-breaker-test-"));
    });

    afterEach(() => {
      vi.restoreAllMocks();
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

    it("空ファイルはfail-openで空配列", async () => {
      const historyFilePath = await createHistoryFile();
      writeFileSync(historyFilePath, "");
      expect(await getRecentHistory(tmpDir)).toEqual([]);
    });

    it("読込失敗はfail-openで空配列を返しファイルを閉じる", async () => {
      const historyFilePath = await createHistoryFile();
      const handle = await fsPromises.open(historyFilePath, "r");
      try {
        const closeSpy = vi.spyOn(handle, "close");
        vi.spyOn(handle, "read").mockRejectedValue(new Error("read failed"));
        vi.spyOn(fsPromises, "open").mockResolvedValueOnce(handle);
        expect(await getRecentHistory(tmpDir)).toEqual([]);
        expect(closeSpy).toHaveBeenCalledOnce();
      } finally {
        await handle.close();
      }
    });

    it.each([0, -2, 0.5, 1.5, NaN, Infinity, -Infinity])(
      "window=%sでも旧実装と同じ並びを返す",
      async (window) => {
        const historyFilePath = await createHistoryFile();
        const raw = ["pass", "block", "pass", "block"]
          .map((action) => JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", action }))
          .join("\n");
        writeFileSync(historyFilePath, raw);
        expect(await getRecentHistory(tmpDir, window)).toEqual(getOriginalHistory(raw, window));
      },
    );

    describe("10万行の履歴", () => {
      let historyFilePath: string;
      let historyLines: string[];

      beforeEach(async () => {
        historyFilePath = await createHistoryFile();
        const fixture = JSON.parse(readFileSync(historyFilePath, "utf-8")) as EvalHistoryEntry;
        historyLines = Array.from({ length: 100_000 }, (_, index) => {
          let action: EvalAction = "pass";
          if (index % 7 === 0 || index % 13 === 0) {
            action = "block";
          }
          return JSON.stringify({ ...fixture, action });
        });
      });

      it.each(["通常", "行の途中のブロック境界", "末尾改行なし", "壊れた行まじり", "空白行まじり"])(
        "%sでもwindow 100の並びが旧実装と一致する",
        async (scenario) => {
          if (scenario === "行の途中のブロック境界") {
            const index = historyLines.length - CIRCUIT_BREAKER_WINDOW / 2;
            const entry = JSON.parse(historyLines[index]) as EvalHistoryEntry;
            historyLines[index] = JSON.stringify({ ...entry, padding: "境界".repeat(4096) });
          } else if (scenario === "壊れた行まじり") {
            historyLines[historyLines.length - 1] = '{"action":';
            historyLines[historyLines.length - 2] = "null";
            historyLines[historyLines.length - 3] = '{"action":"unknown"}';
            historyLines[historyLines.length - CIRCUIT_BREAKER_WINDOW] = "broken";
          } else if (scenario === "空白行まじり") {
            for (let index = historyLines.length - CIRCUIT_BREAKER_WINDOW; index < historyLines.length; index += 2) {
              historyLines[index] = "\r\t ";
            }
          }

          let raw = historyLines.join("\n");
          if (scenario !== "末尾改行なし") {
            raw += "\n";
          }
          writeFileSync(historyFilePath, raw);

          const expected = getOriginalHistory(raw, CIRCUIT_BREAKER_WINDOW);
          const history = await getRecentHistory(tmpDir, CIRCUIT_BREAKER_WINDOW);
          expect(history).toEqual(expected);
          if (scenario === "壊れた行まじり") {
            expect(history).toHaveLength(CIRCUIT_BREAKER_WINDOW - 4);
          } else {
            expect(history).toHaveLength(CIRCUIT_BREAKER_WINDOW);
          }
        },
      );

      it("window 100を読む合計バイト数が64KB以下になる", async () => {
        const raw = historyLines.join("\n") + "\n";
        writeFileSync(historyFilePath, raw);
        const expected = getOriginalHistory(raw, CIRCUIT_BREAKER_WINDOW);
        const handle = await fsPromises.open(historyFilePath, "r");
        try {
          const readSpy = vi.spyOn(handle, "read");
          const readFileSpy = vi.spyOn(fsPromises, "readFile");
          vi.spyOn(fsPromises, "open").mockResolvedValueOnce(handle);

          expect(await getRecentHistory(tmpDir, CIRCUIT_BREAKER_WINDOW)).toEqual(expected);

          const reads = await Promise.all(readSpy.mock.results.map((result) => result.value));
          const totalBytesRead = reads.reduce((total, result) => total + result.bytesRead, 0);
          expect(readSpy).toHaveBeenCalled();
          expect(readFileSpy).not.toHaveBeenCalled();
          expect(Buffer.byteLength(raw)).toBeGreaterThan(64 * 1024);
          expect(totalBytesRead).toBeGreaterThan(0);
          expect(totalBytesRead).toBeLessThanOrEqual(64 * 1024);
        } finally {
          await handle.close();
        }
      });
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
