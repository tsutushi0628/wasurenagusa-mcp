import { describe, it, expect } from "vitest";
import { loadPrompt } from "./prompt-loader.js";

describe("prompt-loader", () => {
  it("analysis.txtを読み込める", async () => {
    const prompt = await loadPrompt("analysis.txt");
    expect(prompt).toBeTruthy();
    expect(prompt).toContain("カテゴリ定義");
    expect(prompt).toContain("dont");
    expect(prompt).toContain("config");
  });

  it("duplicate-check.txtを読み込める", async () => {
    const prompt = await loadPrompt("duplicate-check.txt");
    expect(prompt).toBeTruthy();
    expect(prompt).toContain("重複判定");
  });

  it("存在しないファイルはエラーになる", async () => {
    await expect(loadPrompt("nonexistent.txt")).rejects.toThrow();
  });

  it("analysis.txtに感情検知の記述がある（悲しみ・失望・諦め）", async () => {
    const prompt = await loadPrompt("analysis.txt");
    expect(prompt).toContain("悲しみ");
    expect(prompt).toContain("失望");
    expect(prompt).toContain("諦め");
  });

  it("analysis.txtにメタ情報による諦め検知セクションがある", async () => {
    const prompt = await loadPrompt("analysis.txt");
    expect(prompt).toContain("会話メタ情報による諦め検知");
    expect(prompt).toContain("avgUserMessageLength");
    expect(prompt).toContain("currentMessageLength");
    expect(prompt).toContain("turnsSinceLastPositive");
  });

  it("analysis.txtにdontの3点セットfew-shot例がある", async () => {
    const prompt = await loadPrompt("analysis.txt");
    expect(prompt).toContain("few-shot");
    expect(prompt).toContain("例1:");
    expect(prompt).toContain("例2:");
    expect(prompt).toContain("例3:");
  });
});
