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

  it("analysis.txtにsuccessカテゴリ定義がある（F4）", async () => {
    const prompt = await loadPrompt("analysis.txt");
    expect(prompt).toContain("success");
    // S1/S2/S3 シグナル
    expect(prompt).toMatch(/S1|反対意見後|称賛/);
    expect(prompt).toMatch(/S2|根拠提示|懸念解消|採用/);
    expect(prompt).toMatch(/S3|複数案/);
  });

  it("analysis.txtにsuccessのnegative example（保存しない例）がある（F4 誤保存防止）", async () => {
    const prompt = await loadPrompt("analysis.txt");
    // 「単なるありがとう」「単なるOK」は保存しない、と明記
    expect(prompt).toMatch(/保存しない|negative/i);
    expect(prompt).toMatch(/ありがとう|OK|いいね/);
  });

  it("analysis.txtの出力JSON値域に success が含まれる（F4）", async () => {
    const prompt = await loadPrompt("analysis.txt");
    // 出力形式の category 列挙に "success" が入っていること
    expect(prompt).toMatch(/"category":[^]*success/);
  });
});
