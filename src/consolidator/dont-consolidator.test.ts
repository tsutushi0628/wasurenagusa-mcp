import { describe, it, expect, vi } from "vitest";
import { DontConsolidator } from "./dont-consolidator.js";
import { MemoryEntry } from "../types.js";

function createDontEntries(count: number): MemoryEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `test-${i + 1}`,
    timestamp: "2026-02-09T12:00:00.000+09:00",
    category: "dont" as const,
    title: `テスト教訓${i + 1}`,
    content: `❌ テスト行動${i + 1} 💡 テスト理由${i + 1} ✅ テスト対策${i + 1}`,
    tags: ["test"],
  }));
}

const VALID_GEMINI_RESPONSE = JSON.stringify({
  principles: [
    {
      theme: "テスト統合",
      rule: "❌ 統合された問題 💡 統合された理由 ✅ 統合された対策",
      tags: ["test", "統合"],
      sourceCount: 3,
      sourceIds: ["test-1", "test-2", "test-3"],
    },
  ],
});

describe("DontConsolidator", () => {
  it("Gemini応答をConsolidatedDontにパースできる", async () => {
    const mockGenerate = vi.fn().mockResolvedValue(VALID_GEMINI_RESPONSE);
    const consolidator = new DontConsolidator(mockGenerate);

    const result = await consolidator.consolidate(createDontEntries(3));

    expect(result).not.toBeNull();
    expect(result!.principles).toHaveLength(1);
    expect(result!.principles[0].theme).toBe("テスト統合");
    expect(result!.principles[0].sourceIds).toEqual(["test-1", "test-2", "test-3"]);
    expect(result!.version).toBe(1);
  });

  it("Gemini応答がJSON以外の場合はnullを返す", async () => {
    const mockGenerate = vi.fn().mockResolvedValue("これはJSONではない応答です");
    const consolidator = new DontConsolidator(mockGenerate);

    const result = await consolidator.consolidate(createDontEntries(3));

    expect(result).toBeNull();
  });

  it("空のエントリ配列ではGeminiを呼ばずnullを返す", async () => {
    const mockGenerate = vi.fn();
    const consolidator = new DontConsolidator(mockGenerate);

    const result = await consolidator.consolidate([]);

    expect(result).toBeNull();
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("Geminiエラー時はnullを返す（例外を投げない）", async () => {
    const mockGenerate = vi.fn().mockRejectedValue(new Error("API Error"));
    const consolidator = new DontConsolidator(mockGenerate);

    const result = await consolidator.consolidate(createDontEntries(3));

    expect(result).toBeNull();
  });

  it("プロンプトに全エントリの内容が含まれている", async () => {
    let capturedPrompt = "";
    const mockGenerate = vi.fn().mockImplementation((prompt: string) => {
      capturedPrompt = prompt;
      return Promise.resolve(VALID_GEMINI_RESPONSE);
    });
    const consolidator = new DontConsolidator(mockGenerate);

    const entries = createDontEntries(3);
    await consolidator.consolidate(entries);

    expect(capturedPrompt).toContain("テスト教訓1");
    expect(capturedPrompt).toContain("テスト教訓2");
    expect(capturedPrompt).toContain("テスト教訓3");
    expect(capturedPrompt).toContain("テスト行動1");
  });

  it("結果のsourceEntryCountが入力エントリ数と一致する", async () => {
    const mockGenerate = vi.fn().mockResolvedValue(VALID_GEMINI_RESPONSE);
    const consolidator = new DontConsolidator(mockGenerate);

    const result = await consolidator.consolidate(createDontEntries(5));

    expect(result).not.toBeNull();
    expect(result!.sourceEntryCount).toBe(5);
  });

  it("consolidatedAtにJSTタイムスタンプが設定される", async () => {
    const mockGenerate = vi.fn().mockResolvedValue(VALID_GEMINI_RESPONSE);
    const consolidator = new DontConsolidator(mockGenerate);

    const result = await consolidator.consolidate(createDontEntries(3));

    expect(result).not.toBeNull();
    expect(result!.consolidatedAt).toContain("+09:00");
  });

  it("LLM出力にguardPattern/guardMessageが含まれていても、consolidated結果からは常に除去される（ガード自動生成の再混入防止）", async () => {
    const responseWithGuardPattern = JSON.stringify({
      principles: [
        {
          theme: "テスト統合",
          rule: "❌ 統合された問題 💡 統合された理由 ✅ 統合された対策",
          tags: ["test", "統合"],
          sourceCount: 3,
          sourceIds: ["test-1", "test-2", "test-3"],
          // LLMが指示に反して自動生成したガードパターン（過剰に広い例: アルファベット全般）
          guardPattern: "[a-zA-Z]+",
          guardMessage: "アルファベットを使うな",
        },
      ],
    });
    const mockGenerate = vi.fn().mockResolvedValue(responseWithGuardPattern);
    const consolidator = new DontConsolidator(mockGenerate);

    const result = await consolidator.consolidate(createDontEntries(3));

    expect(result).not.toBeNull();
    expect(result!.principles).toHaveLength(1);
    expect(result!.principles[0].guardPattern).toBeUndefined();
    expect(result!.principles[0].guardMessage).toBeUndefined();
    expect("guardPattern" in result!.principles[0]).toBe(false);
    expect("guardMessage" in result!.principles[0]).toBe(false);
  });

  it("50件超のchunk分割経路でも、各chunkのLLM出力に含まれるguardPatternが結合後の全principleから除去される", async () => {
    const responseWithGuardPattern = (id: string) =>
      JSON.stringify({
        principles: [
          {
            theme: `テスト統合${id}`,
            rule: "❌〜 💡〜 ✅〜",
            tags: ["test"],
            sourceCount: 1,
            sourceIds: [id],
            guardPattern: "NG",
            guardMessage: "NGを使うな",
          },
        ],
      });
    let callCount = 0;
    const mockGenerate = vi.fn().mockImplementation(() => {
      callCount += 1;
      return Promise.resolve(responseWithGuardPattern(`chunk-${callCount}`));
    });
    const consolidator = new DontConsolidator(mockGenerate);

    const result = await consolidator.consolidate(createDontEntries(51));

    expect(result).not.toBeNull();
    expect(result!.principles.length).toBeGreaterThan(0);
    for (const principle of result!.principles) {
      expect(principle.guardPattern).toBeUndefined();
      expect(principle.guardMessage).toBeUndefined();
    }
  });

  it("mergeClusterでもLLM出力にguardPattern/guardMessageが含まれていれば常に除去される", async () => {
    const responseWithGuardPattern = JSON.stringify({
      principle: {
        theme: "クラスタ統合",
        rule: "❌〜 💡〜 ✅〜",
        positiveRule: "正しく行動する",
        tags: ["test"],
        sourceCount: 2,
        sourceIds: ["test-1", "test-2"],
        guardPattern: "NG",
        guardMessage: "NGを使うな",
      },
    });
    const mockGenerate = vi.fn().mockResolvedValue(responseWithGuardPattern);
    const consolidator = new DontConsolidator(mockGenerate);

    const result = await consolidator.mergeCluster(createDontEntries(2));

    expect(result).not.toBeNull();
    expect(result!.guardPattern).toBeUndefined();
    expect(result!.guardMessage).toBeUndefined();
    expect("guardPattern" in result!).toBe(false);
    expect("guardMessage" in result!).toBe(false);
  });
});
