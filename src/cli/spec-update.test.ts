import { describe, it, expect } from "vitest";
import { detectRateLimit } from "./spec-update.js";

describe("detectRateLimit", () => {
  it("exitCode === 0 のときは常にfalseを返す", () => {
    expect(detectRateLimit(0, "you have hit your limit", "")).toBe(false);
    expect(detectRateLimit(0, "", "resets at midnight")).toBe(false);
  });

  it("stdoutに 'hit your limit' を含む場合trueを返す", () => {
    expect(detectRateLimit(1, "Error: you have hit your limit for today", "")).toBe(true);
  });

  it("stderrに 'hit your limit' を含む場合trueを返す", () => {
    expect(detectRateLimit(1, "", "you have hit your limit")).toBe(true);
  });

  it("stdoutに 'resets' を含む場合trueを返す", () => {
    expect(detectRateLimit(1, "Your usage resets in 3 hours", "")).toBe(true);
  });

  it("stderrに 'resets' を含む場合trueを返す", () => {
    expect(detectRateLimit(1, "", "limit resets at 00:00 UTC")).toBe(true);
  });

  it("関連キーワードがない非ゼロ終了はfalseを返す", () => {
    expect(detectRateLimit(1, "some error occurred", "command not found")).toBe(false);
    expect(detectRateLimit(137, "", "killed")).toBe(false);
  });

  it("stdout+stderrの結合でマッチする", () => {
    expect(detectRateLimit(1, "partial hit your ", "limit reached")).toBe(true);
  });
});
