import { describe, it, expect } from "vitest";
import { escapePromptVariable } from "./prompt-escape.js";

describe("escapePromptVariable", () => {
  it("通常のテキストはそのまま返す", () => {
    expect(escapePromptVariable("テスト目的")).toBe("テスト目的");
    expect(escapePromptVariable("hello world")).toBe("hello world");
  });

  it("バッククォートをエスケープする", () => {
    expect(escapePromptVariable("foo`bar")).toBe("foo\\`bar");
    expect(escapePromptVariable("```code```")).toBe("\\`\\`\\`code\\`\\`\\`");
  });

  it("テンプレートリテラル式 ${} をエスケープする", () => {
    expect(escapePromptVariable("${process.exit(1)}")).toBe("\\${process.exit(1)}");
    expect(escapePromptVariable("value is ${x}")).toBe("value is \\${x}");
  });

  it("制御文字を除去する（改行・タブは保持）", () => {
    expect(escapePromptVariable("line1\nline2")).toBe("line1\nline2");
    expect(escapePromptVariable("col1\tcol2")).toBe("col1\tcol2");
    expect(escapePromptVariable("foo\x00bar")).toBe("foobar");
    expect(escapePromptVariable("foo\x01bar")).toBe("foobar");
    expect(escapePromptVariable("foo\x1Fbar")).toBe("foobar");
    expect(escapePromptVariable("foo\x7Fbar")).toBe("foobar");
  });

  it("複合的な攻撃文字列をエスケープする", () => {
    const malicious = '`${require("child_process").execSync("rm -rf /")}` injection';
    const result = escapePromptVariable(malicious);
    expect(result).not.toContain("`$");
    expect(result).toContain("\\`");
    expect(result).toContain("\\${");
  });

  it("空文字列はそのまま返す", () => {
    expect(escapePromptVariable("")).toBe("");
  });

  it("バックスラッシュ自体は保持する", () => {
    expect(escapePromptVariable("path\\to\\file")).toBe("path\\to\\file");
  });
});
