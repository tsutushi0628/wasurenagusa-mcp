import { describe, it, expect } from "vitest";
import { formatConsolidatedDont } from "./formatter.js";
import { ConsolidatedDont } from "../types.js";

function createConsolidated(overrides?: Partial<ConsolidatedDont>): ConsolidatedDont {
  return {
    principles: [
      {
        theme: "確認前行動の禁止",
        rule: "❌ ログ・コードを確認せず推測で行動した。💡 確認を怠ると同じミスを繰り返し信頼を失う。✅ 行動前にログ末尾200行・関連コードを必ず確認する。",
        tags: ["ログ確認", "推測禁止", "コード確認"],
        sourceCount: 12,
        sourceIds: ["id-1", "id-2", "id-3"],
      },
      {
        theme: "無断変更の禁止",
        rule: "❌ y/n確認なしにコードや設定を変更した。💡 ユーザーの意図を無視した変更は信頼崩壊の直接原因。✅ 変更前に内容と理由を説明しy/n確認を得る。",
        tags: ["y/n確認", "無断変更", "設定変更"],
        sourceCount: 8,
        sourceIds: ["id-4", "id-5"],
      },
    ],
    consolidatedAt: "2026-02-09T12:00:00.000+09:00",
    sourceEntryCount: 20,
    version: 1,
    ...overrides,
  };
}

describe("formatConsolidatedDont", () => {
  it("ConsolidatedDontを簡潔なMarkdownに変換する", () => {
    const result = formatConsolidatedDont(createConsolidated());

    expect(result).toContain("確認前行動の禁止");
    expect(result).toContain("無断変更の禁止");
    expect(result).toContain("12件");
    expect(result).toContain("8件");
  });

  it("出力にテーマ・ルール・tags・sourceCountが含まれる", () => {
    const result = formatConsolidatedDont(createConsolidated());

    expect(result).toContain("❌");
    expect(result).toContain("💡");
    expect(result).toContain("✅");
    expect(result).toContain("ログ確認");
    expect(result).toContain("推測禁止");
  });

  it("memory_search誘導テキストが含まれる", () => {
    const result = formatConsolidatedDont(createConsolidated());

    expect(result).toContain("memory_search");
    expect(result).toContain("memory_get_detail");
  });

  it("空principlesの場合は空文字を返す", () => {
    const result = formatConsolidatedDont(createConsolidated({ principles: [] }));

    expect(result).toBe("");
  });

  it("出力サイズが元の全文注入より十分小さい", () => {
    const result = formatConsolidatedDont(createConsolidated());

    // 2原則で数KB以内に収まるべき
    expect(result.length).toBeLessThan(2000);
  });
});
