import { describe, it, expect } from "vitest";
import { parseMarkdown } from "./parser.js";

describe("parser.ts weighted tag support", () => {
  it("parses legacy format tags as string[]", () => {
    const md = `## テスト記憶

- **id**: test-001
- **timestamp**: 2024-01-01T00:00:00+09:00
- **category**: config
- **tags**: Gemini, API, 設定
- **content**: テスト内容

---

`;
    const entries = parseMarkdown(md, "config");
    expect(entries).toHaveLength(1);
    expect(entries[0].tags).toEqual(["Gemini", "API", "設定"]);
  });

  it("parses weighted format tags preserving weight in string", () => {
    const md = `## テスト記憶

- **id**: test-002
- **timestamp**: 2024-01-01T00:00:00+09:00
- **category**: config
- **tags**: Gemini:0.3, rate-limit:0.9, API制限:0.8, 1000RPM:1.0
- **content**: テスト内容

---

`;
    const entries = parseMarkdown(md, "config");
    expect(entries).toHaveLength(1);
    expect(entries[0].tags).toEqual([
      "Gemini:0.3",
      "rate-limit:0.9",
      "API制限:0.8",
      "1000RPM:1.0",
    ]);
  });

  it("parses mixed format (legacy + weighted) tags", () => {
    const md = `## テスト記憶

- **id**: test-003
- **timestamp**: 2024-01-01T00:00:00+09:00
- **category**: config
- **tags**: Gemini, rate-limit:0.9, API
- **content**: テスト内容

---

`;
    const entries = parseMarkdown(md, "config");
    expect(entries).toHaveLength(1);
    expect(entries[0].tags).toEqual(["Gemini", "rate-limit:0.9", "API"]);
  });
});
