import { describe, expect, it } from "vitest";

import {
  enforceInjectionTokenBudget,
  enforceWholeItemBudget,
  estimateTokens,
} from "./budget.js";

describe("enforceWholeItemBudget", () => {
  it("予算を超える項目は末尾から完全に除外する", () => {
    const items = ["短い規則", "長い規則".repeat(20), "後続規則"];
    const result = enforceWholeItemBudget(
      items,
      estimateTokens("短い規則"),
      (included) => included.join("\n"),
    );

    expect(result.included).toEqual(["短い規則"]);
    expect(result.omitted).toEqual(items.slice(1));
    expect(result.text).toBe("短い規則");
    expect(result.tokenCount).toBe(estimateTokens(result.text));
  });

  it("ヘッダー込みで最初の項目も収まらない極小予算では空を返す", () => {
    const result = enforceWholeItemBudget(
      ["規則"],
      1,
      (included) => `### 規則\n${included.join("\n")}`,
    );

    expect(result.included).toEqual([]);
    expect(result.omitted).toEqual(["規則"]);
    expect(result.text).toBe("");
    expect(result.tokenCount).toBe(0);
  });
});

describe("既存の索引向け予算 helper", () => {
  it("上限内の文字列と戻り値契約を維持する", () => {
    const result = enforceInjectionTokenBudget("索引", 2);

    expect(result).toEqual({
      text: "索引",
      truncated: false,
      omittedTokens: 0,
    });
  });

  it("行単位の切り詰めと可視マーカーを維持する", () => {
    const result = enforceInjectionTokenBudget(
      Array.from({ length: 30 }, (_, index) => `行${index}の合成索引`).join("\n"),
      50,
    );

    expect(result.truncated).toBe(true);
    expect(result.text).toContain("バジェット上限で切り詰められました");
    expect(result.omittedTokens).toBeGreaterThan(0);
  });
});
