import { describe, it, expect, vi } from "vitest";
import { Analyzer } from "./index.js";
import type { AnalysisResult } from "../types.js";

/**
 * heart-extension F4: Analyzer.analyze が success カテゴリの JSON 応答を
 * 落とさず通すことを保証する。
 *
 * - 実LLMの判定品質はプロンプト経由で担保（prompt-loader.test.ts でカバー）
 * - 本テストは「success カテゴリの分析結果がパースされて返ってくる」型互換性のみを保証する
 */
describe("Analyzer F4: success カテゴリの型互換性", () => {
  it("LLM が success の JSON を返したら shouldSave=true / category='success' で取得できる", async () => {
    const mockGenerate = vi.fn().mockResolvedValue(`{
      "shouldSave": true,
      "category": "success",
      "title": "媚び化リスク指摘で同意",
      "summary": "S1: 反対意見後の称賛シグナル。媚び化リスクを根拠付きで指摘した上で、ユーザーから '助かった' と強い肯定を得た提案。",
      "tags": ["success", "feedback"],
      "reason": "S1パターン検出",
      "scope": "ai",
      "sessionTopic": "成功パターンの記憶活用設計のレビュー"
    }`);

    const analyzer = new Analyzer(mockGenerate);
    const result = await analyzer.analyze({
      conversationLog: "user: 媚び化リスクある？\nai: あります、根拠は…\nuser: 助かった、それでいこう",
      latestMessage: "user: 助かった、それでいこう",
    });

    expect(result.shouldSave).toBe(true);
    expect(result.category).toBe("success");
    expect(result.title).toContain("媚び化");
  });

  it("LLM が success ではない JSON を返したら category='success' にならない（誤保存防止）", async () => {
    // 単なる「ありがとう」シナリオ。LLM がプロンプトに従って category=null / shouldSave=false を返す想定
    const mockGenerate = vi.fn().mockResolvedValue(`{
      "shouldSave": false,
      "category": null,
      "title": null,
      "summary": null,
      "tags": [],
      "reason": "単なるありがとうのみ。文脈なき称賛のため保存しない。",
      "sessionTopic": "雑談"
    }`);

    const analyzer = new Analyzer(mockGenerate);
    const result: AnalysisResult = await analyzer.analyze({
      conversationLog: "user: ありがとう",
      latestMessage: "ありがとう",
    });

    expect(result.shouldSave).toBe(false);
    expect(result.category).toBeNull();
  });

  it("AnalysisResult.category は MemoryCategory 型として success を受け入れる（型整合性確認）", () => {
    const sample: AnalysisResult = {
      shouldSave: true,
      category: "success",
      title: "成功記憶テスト",
      summary: "S2 シグナル",
      tags: [],
      reason: "test",
    };
    expect(sample.category).toBe("success");
  });
});
