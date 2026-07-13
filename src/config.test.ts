import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveWindowDaysEnv } from "./config.js";

/**
 * env から窓日数を読む際の Number.isFinite ガードの業務要件を固定する。
 *
 * 業務要件:
 *  - 非数（"abc" など parseInt が NaN になる値）は既定値へフォールバックし warn を出す。
 *    非数のまま下流に流れると忘却 dry-run が沈黙停止したりログ回転が throw する事故になる。
 *  - 0 以下は「無効化」を意味する既存仕様（<=0=無効化）なので、既定へ置換せずそのまま通す
 *    （warn もしない）。配布パッケージで環境変数の意味を黙って変えないため。
 *  - 正の整数はそのまま採用する。
 *  - 未設定（undefined / 空文字）は正常系なので既定値を返し warn しない。
 */
describe("resolveWindowDaysEnv（窓日数の env ガード）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("非数入力は既定値へフォールバックし warn を1行出す", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveWindowDaysEnv("abc", 90, "FORGETTING_WINDOW_DAYS")).toBe(90);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("0・負値はそのまま通す（下流の <=0=無効化 という既存仕様を壊さない）・warnしない", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // 0 = 無効化（forgettingWindowDays<=0=忘却無効・logRetentionDays<=0=ログ回転無効）を保存。
    // 既定へ静かに置換しない（配布パッケージで環境変数の意味を変えないため）。
    expect(resolveWindowDaysEnv("0", 90, "FORGETTING_WINDOW_DAYS")).toBe(0);
    expect(resolveWindowDaysEnv("-5", 30, "LOG_RETENTION_DAYS")).toBe(-5);
    expect(warn).not.toHaveBeenCalled();
  });

  it("正の整数はそのまま採用する", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveWindowDaysEnv("120", 90, "FORGETTING_WINDOW_DAYS")).toBe(120);
    expect(warn).not.toHaveBeenCalled();
  });

  it("未設定（undefined / 空文字）は既定値を返し warn しない（正常系）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveWindowDaysEnv(undefined, 30, "LOG_RETENTION_DAYS")).toBe(30);
    expect(resolveWindowDaysEnv("", 30, "LOG_RETENTION_DAYS")).toBe(30);
    expect(resolveWindowDaysEnv("   ", 30, "LOG_RETENTION_DAYS")).toBe(30);
    expect(warn).not.toHaveBeenCalled();
  });
});
