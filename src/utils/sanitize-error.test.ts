import { describe, it, expect } from "vitest";
import { sanitizeErrorMessage } from "./sanitize-error.js";

describe("sanitizeErrorMessage", () => {
  it("パスを含まないメッセージはそのまま返す", () => {
    expect(sanitizeErrorMessage("Unknown tool: foo")).toBe("Unknown tool: foo");
  });

  it("/Users/... 形式のパスを [path] に置換する", () => {
    const msg = "ENOENT: no such file or directory, open '/Users/testuser/projects/wasurenagusa-mcp/data.json'";
    const result = sanitizeErrorMessage(msg);
    expect(result).not.toContain("/Users/");
    expect(result).toContain("[path]");
  });

  it("/home/... 形式のパスを [path] に置換する", () => {
    const msg = "Failed to read /home/user/.wasurenagusa/config.md";
    const result = sanitizeErrorMessage(msg);
    expect(result).not.toContain("/home/");
    expect(result).toContain("[path]");
  });

  it(".wasurenagusa/ を含む内部パス構造を隠蔽する", () => {
    const msg = "Error in .wasurenagusa/dont.md at line 5";
    const result = sanitizeErrorMessage(msg);
    expect(result).not.toContain(".wasurenagusa/");
    expect(result).toContain("[path]");
  });

  it("複数のパスを全て置換する", () => {
    const msg = "Cannot copy /Users/a/src to /Users/a/dest";
    const result = sanitizeErrorMessage(msg);
    expect(result).not.toContain("/Users/");
    expect(result.match(/\[path\]/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("Windows風パスはそのまま（対象外）", () => {
    const msg = "Error at C:\\Users\\test\\file.txt";
    expect(sanitizeErrorMessage(msg)).toBe(msg);
  });

  it("空文字列はそのまま返す", () => {
    expect(sanitizeErrorMessage("")).toBe("");
  });

  it("/var/... 形式のパスも置換する", () => {
    const msg = "Permission denied: /var/folders/xx/wasurenagusa/tmp";
    const result = sanitizeErrorMessage(msg);
    expect(result).not.toContain("/var/");
    expect(result).toContain("[path]");
  });

  it("/tmp/... 形式のパスも置換する", () => {
    const msg = "File not found: /tmp/wasurenagusa-test-abc123/data";
    const result = sanitizeErrorMessage(msg);
    expect(result).not.toContain("/tmp/");
    expect(result).toContain("[path]");
  });
});
