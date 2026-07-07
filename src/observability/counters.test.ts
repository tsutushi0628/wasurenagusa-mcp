import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, chmodSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  increment,
  snapshot,
  getCounterWriteFailureCount,
  resetCounterWriteFailureCountForTest,
  DEFAULT_THRESHOLDS,
} from "./counters.js";

/**
 * 可観測性カウンタ5指標と閾値警報（タスク0.9、R-M1）。
 *
 * 5指標: ゼロヒット率、注入トークン数、統合件数、ガードブロック件数、蘇生件数。
 * 計測は Phase 0 で最初に出荷する（R-M1 AC3）。以降の全改修効果はこの計器で測る。
 */
describe("observability/counters: 5指標の計測と閾値警報", () => {
  let tmpDir: string;
  let memoryPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-counters-test-"));
    memoryPath = join(tmpDir, ".wasurenagusa");
    mkdirSync(memoryPath, { recursive: true });
    resetCounterWriteFailureCountForTest();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("5指標（ゼロヒット率・注入トークン数・統合件数・ガードブロック件数・蘇生件数）が記録される", async () => {
    await increment(memoryPath, "search_total", 1);
    await increment(memoryPath, "search_zero_hit", 1);
    await increment(memoryPath, "injection_tokens", 3000);
    await increment(memoryPath, "consolidation_count", 4);
    await increment(memoryPath, "guard_block_count", 1);
    await increment(memoryPath, "resurrection_count", 0);

    const result = await snapshot(memoryPath);

    expect(result.zeroHitRate.totalSearches).toBe(1);
    expect(result.zeroHitRate.zeroHitSearches).toBe(1);
    expect(result.zeroHitRate.rate).toBe(1);
    expect(result.injectionTokens.max).toBe(3000);
    expect(result.consolidationCount.total).toBe(4);
    expect(result.guardBlockCount.total).toBe(1);
    expect(result.resurrectionCount.latest).toBe(0);
    expect(result.resurrectionCount.max).toBe(0);
    expect(result.corruptLineCount).toBe(0);
    expect(typeof result.counterWriteFailureCount).toBe("number");

    // JSONL追記の実体を直接確認（他モジュールとログファイルを共有しないこと）
    const today = new Date();
    const jst = new Date(today.getTime() + 9 * 60 * 60 * 1000);
    const datePart = jst.toISOString().slice(0, 10);
    const logPath = join(memoryPath, "logs", `counters-${datePart}.jsonl`);
    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(6);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty("ts");
      expect(parsed).toHaveProperty("metric");
      expect(parsed).toHaveProperty("value");
    }
  });

  it("閾値超過時はsnapshot()でalert=trueが付く（注入トークン数・統合件数・ガードブロック件数・蘇生件数）", async () => {
    await increment(memoryPath, "injection_tokens", DEFAULT_THRESHOLDS.injectionTokens + 1);
    await increment(memoryPath, "consolidation_count", DEFAULT_THRESHOLDS.consolidationCount + 1);
    for (let i = 0; i < DEFAULT_THRESHOLDS.guardBlockCount + 1; i++) {
      await increment(memoryPath, "guard_block_count", 1);
    }
    await increment(memoryPath, "resurrection_count", 1);

    const result = await snapshot(memoryPath);

    expect(result.injectionTokens.alert).toBe(true);
    expect(result.consolidationCount.alert).toBe(true);
    expect(result.guardBlockCount.alert).toBe(true);
    expect(result.resurrectionCount.alert).toBe(true);
  });

  it("閾値未満のときはalert=falseのまま（誤警報を出さない）", async () => {
    await increment(memoryPath, "injection_tokens", DEFAULT_THRESHOLDS.injectionTokens - 1);
    await increment(memoryPath, "consolidation_count", 1);
    await increment(memoryPath, "guard_block_count", 1);
    await increment(memoryPath, "resurrection_count", 0);

    const result = await snapshot(memoryPath);

    expect(result.injectionTokens.alert).toBe(false);
    expect(result.consolidationCount.alert).toBe(false);
    expect(result.guardBlockCount.alert).toBe(false);
    expect(result.resurrectionCount.alert).toBe(false);
  });

  it("ゼロヒット率が閾値超過かつ十分なサンプル数のときalert=trueが付く（少数サンプルの誤警報は避ける）", async () => {
    // サンプル数不足（1件）: 100%ゼロヒットでもalertは出さない
    await increment(memoryPath, "search_total", 1);
    await increment(memoryPath, "search_zero_hit", 1);
    const smallSample = await snapshot(memoryPath);
    expect(smallSample.zeroHitRate.alert).toBe(false);

    // サンプル数を最小基準まで積み増し、閾値を超えるゼロヒット率にする
    for (let i = 0; i < 10; i++) {
      await increment(memoryPath, "search_total", 1);
      await increment(memoryPath, "search_zero_hit", 1);
    }
    const largeSample = await snapshot(memoryPath);
    expect(largeSample.zeroHitRate.rate).toBeGreaterThan(DEFAULT_THRESHOLDS.zeroHitRate);
    expect(largeSample.zeroHitRate.alert).toBe(true);
  });

  it("カウンタ書き込み失敗時は本処理を落とさず、失敗自体が計数される（fail-open + 失敗の可視化）", async () => {
    const unwritableMemoryPath = join(tmpDir, "no-such-parent", "deeply", "nested", "path");
    // 親ディレクトリを読み取り専用にして mkdir/appendFile を失敗させる
    mkdirSync(join(tmpDir, "no-such-parent"), { recursive: true });
    chmodSync(join(tmpDir, "no-such-parent"), 0o444);

    const before = getCounterWriteFailureCount();

    await expect(increment(unwritableMemoryPath, "guard_block_count", 1)).resolves.toBeUndefined();

    expect(getCounterWriteFailureCount()).toBe(before + 1);

    chmodSync(join(tmpDir, "no-such-parent"), 0o755);
  });

  it("カウンタ書き込み失敗件数がsnapshot()のcounterWriteFailureCountに配線されている", async () => {
    const unwritableMemoryPath = join(tmpDir, "no-such-parent-wired", "deeply", "nested", "path");
    mkdirSync(join(tmpDir, "no-such-parent-wired"), { recursive: true });
    chmodSync(join(tmpDir, "no-such-parent-wired"), 0o444);

    await increment(unwritableMemoryPath, "guard_block_count", 1);

    // 失敗カウンタはプロセス内グローバルなため、別のmemoryPathに対するsnapshot()からも読める
    const result = await snapshot(memoryPath);
    expect(result.counterWriteFailureCount).toBeGreaterThan(0);

    chmodSync(join(tmpDir, "no-such-parent-wired"), 0o755);
  });

  it("蘇生件数はゲージ（現在の絶対値の記録）のため、同じ値を複数回記録してもsumで水増しされない", async () => {
    // backfill-workerが同日に複数回実行され、毎回「現在のtombstoneベクトル数」を記録するケースを再現
    await increment(memoryPath, "resurrection_count", 3);
    await increment(memoryPath, "resurrection_count", 3);
    await increment(memoryPath, "resurrection_count", 3);

    const result = await snapshot(memoryPath);

    expect(result.resurrectionCount.latest).toBe(3);
    expect(result.resurrectionCount.max).toBe(3);
    expect(result.resurrectionCount.observations).toBe(3);
    // sum相当のtotalフィールドはゲージには存在しない（水増し露出を残さない）
    expect(result.resurrectionCount).not.toHaveProperty("total");
  });

  it("count系メトリクス（注入トークン数・統合件数・ガードブロック件数）はちょうど閾値ではalertが立たない（exclusive境界）", async () => {
    await increment(memoryPath, "injection_tokens", DEFAULT_THRESHOLDS.injectionTokens);
    await increment(memoryPath, "consolidation_count", DEFAULT_THRESHOLDS.consolidationCount);
    await increment(memoryPath, "guard_block_count", DEFAULT_THRESHOLDS.guardBlockCount);

    const result = await snapshot(memoryPath);

    expect(result.injectionTokens.alert).toBe(false);
    expect(result.consolidationCount.alert).toBe(false);
    expect(result.guardBlockCount.alert).toBe(false);
  });

  it("蘇生件数はちょうど閾値でもalertが立つ（inclusive境界、ゼロが正のため到達自体を検知する）", async () => {
    await increment(memoryPath, "resurrection_count", DEFAULT_THRESHOLDS.resurrectionCount);

    const result = await snapshot(memoryPath);

    expect(result.resurrectionCount.alert).toBe(true);
  });

  it("壊れた行が混ざっていても他行の集計は止めず、壊れ行数がcorruptLineCountに記録される（無言破棄しない）", async () => {
    await increment(memoryPath, "guard_block_count", 1);
    await increment(memoryPath, "guard_block_count", 1);

    // JSTの日付ファイルへ壊れた1行を直接追記する
    const today = new Date();
    const jst = new Date(today.getTime() + 9 * 60 * 60 * 1000);
    const datePart = jst.toISOString().slice(0, 10);
    const logPath = join(memoryPath, "logs", `counters-${datePart}.jsonl`);
    const fs = await import("fs/promises");
    await fs.appendFile(logPath, "not a json line\n", "utf-8");

    const result = await snapshot(memoryPath);

    expect(result.guardBlockCount.total).toBe(2);
    expect(result.corruptLineCount).toBe(1);
  });

  it("既存カウンタファイルの読込自体が失敗したらsnapshot()はthrowする（fail-loud、既存ファイル無しの正常系とは区別する）", async () => {
    const today = new Date();
    const jst = new Date(today.getTime() + 9 * 60 * 60 * 1000);
    const datePart = jst.toISOString().slice(0, 10);
    const logsDir = join(memoryPath, "logs");
    const logPath = join(logsDir, `counters-${datePart}.jsonl`);
    mkdirSync(logsDir, { recursive: true });
    // ファイルではなくディレクトリを同名パスに置き、readFileを確実に失敗させる
    mkdirSync(logPath, { recursive: true });

    await expect(snapshot(memoryPath)).rejects.toThrow();
  });
});
