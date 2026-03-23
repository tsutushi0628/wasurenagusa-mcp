import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { unlink, writeFile, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  checkGuard,
  extractGuardPrinciples,
  safeRegexTest,
  MAX_BLOCK_COUNT,
  getBlockCountPath,
  readBlockCounts,
  writeBlockCounts,
} from "./guard.js";
import type { ConsolidatedDont, ConsolidatedPrinciple } from "../types.js";
import type { BlockCounts } from "./guard.js";

function makePrinciple(overrides: Partial<ConsolidatedPrinciple> = {}): ConsolidatedPrinciple {
  return {
    theme: "テスト禁止語",
    rule: "❌ 禁止語を使う 💡 不適切 ✅ 別の表現を使う",
    positiveRule: "別の表現を使う",
    tags: ["test"],
    sourceCount: 3,
    sourceIds: ["t-1", "t-2", "t-3"],
    score: 15,
    maxIntensity: 5,
    guardPattern: "禁止ワード",
    guardMessage: "「禁止ワード」を使わず、別の表現にしてください。",
    ...overrides,
  };
}

function makeConsolidated(principles: ConsolidatedPrinciple[]): ConsolidatedDont {
  return {
    principles,
    consolidatedAt: "2026-03-23T12:00:00+09:00",
    sourceEntryCount: 10,
    version: 1,
  };
}

describe("checkGuard", () => {
  it("guardPatternにマッチする場合にblockを返す", () => {
    const principles = [makePrinciple()];
    const blockCounts: BlockCounts = {};
    const result = checkGuard("これは禁止ワードを含むメッセージです", principles, blockCounts);

    expect(result.action).toBe("block");
    expect(result.message).toContain("禁止ワード");
    expect(blockCounts["禁止ワード"]).toBe(1);
  });

  it("マッチしない場合にpassを返す", () => {
    const principles = [makePrinciple()];
    const blockCounts: BlockCounts = {};
    const result = checkGuard("問題のないメッセージです", principles, blockCounts);

    expect(result.action).toBe("pass");
    expect(result.message).toBeUndefined();
  });

  it("3回超過で通過する（pass + 警告メッセージ）", () => {
    const principles = [makePrinciple()];
    const blockCounts: BlockCounts = { "禁止ワード": MAX_BLOCK_COUNT };
    const result = checkGuard("禁止ワードを含むメッセージ", principles, blockCounts);

    expect(result.action).toBe("pass");
    expect(result.message).toContain("上限超過のため通過させます");
  });

  it("ブロックカウントが上限未満の場合はblockする", () => {
    const principles = [makePrinciple()];
    const blockCounts: BlockCounts = { "禁止ワード": MAX_BLOCK_COUNT - 1 };
    const result = checkGuard("禁止ワードを含むメッセージ", principles, blockCounts);

    expect(result.action).toBe("block");
    expect(blockCounts["禁止ワード"]).toBe(MAX_BLOCK_COUNT);
  });

  it("guardPatternがないprincipleは無視される", () => {
    const principles = [makePrinciple({ guardPattern: undefined })];
    const blockCounts: BlockCounts = {};
    const result = checkGuard("禁止ワードを含むメッセージ", principles, blockCounts);

    expect(result.action).toBe("pass");
  });

  it("不正な正規表現は無視される", () => {
    const principles = [makePrinciple({ guardPattern: "[invalid(" })];
    const blockCounts: BlockCounts = {};
    const result = checkGuard("なにかのメッセージ", principles, blockCounts);

    expect(result.action).toBe("pass");
  });

  it("guardMessageがない場合はデフォルトメッセージが使われる", () => {
    const principles = [makePrinciple({ guardMessage: undefined })];
    const blockCounts: BlockCounts = {};
    const result = checkGuard("禁止ワードを含むメッセージ", principles, blockCounts);

    expect(result.action).toBe("block");
    expect(result.message).toContain("行動原則「テスト禁止語」に違反しています");
  });

  it("複数のprincipleがある場合、最初にマッチしたものでblockする", () => {
    const principles = [
      makePrinciple({ theme: "パターンA", guardPattern: "パターンA用", guardMessage: "パターンAに違反" }),
      makePrinciple({ theme: "パターンB", guardPattern: "パターンB用", guardMessage: "パターンBに違反" }),
    ];
    const blockCounts: BlockCounts = {};
    const result = checkGuard("パターンB用のメッセージ", principles, blockCounts);

    expect(result.action).toBe("block");
    expect(result.message).toContain("パターンBに違反");
  });

  it("case insensitiveでマッチする", () => {
    const principles = [makePrinciple({ guardPattern: "FORBIDDEN" })];
    const blockCounts: BlockCounts = {};
    const result = checkGuard("this message has forbidden word", principles, blockCounts);

    expect(result.action).toBe("block");
  });

  it("空文字列メッセージの場合はpassを返す", () => {
    const principles = [makePrinciple()];
    const blockCounts: BlockCounts = {};
    const result = checkGuard("", principles, blockCounts);

    expect(result.action).toBe("pass");
  });

  it("空配列principlesの場合はpassを返す", () => {
    const blockCounts: BlockCounts = {};
    const result = checkGuard("禁止ワードを含むメッセージ", [], blockCounts);

    expect(result.action).toBe("pass");
  });

  it("should block twice then pass on third attempt for same pattern", () => {
    const principles = [makePrinciple()];
    const blockCounts: BlockCounts = {};
    const message = "禁止ワードを含むメッセージ";

    // 1回目: block
    const r1 = checkGuard(message, principles, blockCounts);
    expect(r1.action).toBe("block");
    expect(blockCounts["禁止ワード"]).toBe(1);

    // 2回目: block
    const r2 = checkGuard(message, principles, blockCounts);
    expect(r2.action).toBe("block");
    expect(blockCounts["禁止ワード"]).toBe(2);

    // 3回目: block
    const r3 = checkGuard(message, principles, blockCounts);
    expect(r3.action).toBe("block");
    expect(blockCounts["禁止ワード"]).toBe(3);

    // 4回目（MAX_BLOCK_COUNT=3超過）: pass with warning
    const r4 = checkGuard(message, principles, blockCounts);
    expect(r4.action).toBe("pass");
    expect(r4.message).toContain("上限超過のため通過させます");
  });
});

describe("extractGuardPrinciples", () => {
  it("maxIntensity >= 5かつguardPatternありのprincipleのみ抽出する", () => {
    const consolidated = makeConsolidated([
      makePrinciple({ maxIntensity: 5, guardPattern: "pattern1" }),
      makePrinciple({ maxIntensity: 4, guardPattern: "pattern2" }),
      makePrinciple({ maxIntensity: 5, guardPattern: undefined }),
      makePrinciple({ maxIntensity: 5, guardPattern: "pattern3" }),
    ]);

    const result = extractGuardPrinciples(consolidated);

    expect(result).toHaveLength(2);
    expect(result[0].guardPattern).toBe("pattern1");
    expect(result[1].guardPattern).toBe("pattern3");
  });

  it("該当なしの場合は空配列を返す", () => {
    const consolidated = makeConsolidated([
      makePrinciple({ maxIntensity: 3, guardPattern: "pattern" }),
    ]);

    const result = extractGuardPrinciples(consolidated);
    expect(result).toHaveLength(0);
  });

  it("空配列principlesの場合は空配列を返す", () => {
    const consolidated = makeConsolidated([]);

    const result = extractGuardPrinciples(consolidated);
    expect(result).toHaveLength(0);
  });

  it("guardPatternが空文字列のエントリはフィルタされる", () => {
    const consolidated = makeConsolidated([
      makePrinciple({ maxIntensity: 5, guardPattern: "" }),
      makePrinciple({ maxIntensity: 5, guardPattern: "valid" }),
    ]);

    const result = extractGuardPrinciples(consolidated);
    expect(result).toHaveLength(1);
    expect(result[0].guardPattern).toBe("valid");
  });
});

describe("safeRegexTest", () => {
  it("正常な正規表現でマッチする場合にtrueを返す", () => {
    expect(safeRegexTest("hello", "say hello world")).toBe(true);
  });

  it("マッチしない場合にfalseを返す", () => {
    expect(safeRegexTest("hello", "say goodbye")).toBe(false);
  });

  it("case insensitiveでマッチする", () => {
    expect(safeRegexTest("HELLO", "say hello world")).toBe(true);
  });

  it("不正な正規表現の場合にfalseを返す（fail-open）", () => {
    expect(safeRegexTest("[invalid(", "test")).toBe(false);
  });

  it("タイムアウト時にfalseを返す（fail-open）", () => {
    // ReDoSパターン: (a+)+$ に対して長い非マッチ文字列
    const evilPattern = "(a+)+$";
    const evilInput = "a".repeat(30) + "!";
    // 1msタイムアウトで強制的にタイムアウトさせる
    expect(safeRegexTest(evilPattern, evilInput, 1)).toBe(false);
  });
});

describe("blockCounts persistence", () => {
  const testSessionId = `guard-test-${Date.now()}`;

  afterEach(async () => {
    try {
      await unlink(getBlockCountPath(testSessionId));
    } catch {
      // ファイルがなくてもOK
    }
  });

  it("ブロックカウントの読み書きができる", async () => {
    const counts: BlockCounts = { "pattern1": 2, "pattern2": 1 };
    await writeBlockCounts(testSessionId, counts);

    const read = await readBlockCounts(testSessionId);
    expect(read).toEqual(counts);
  });

  it("ファイルが存在しない場合は空オブジェクトを返す", async () => {
    const read = await readBlockCounts("nonexistent-session-id");
    expect(read).toEqual({});
  });
});
