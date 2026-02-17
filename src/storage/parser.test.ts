import { describe, it, expect } from "vitest";
import { parseMarkdown } from "./parser.js";

describe("parseMarkdown", () => {
  it("project/scopeなしの既存フォーマットをパースできる", () => {
    const markdown = `# Config Memory

---

## テスト設定

- **id**: test-id-001
- **timestamp**: 2026-02-06T16:00:00.000+09:00
- **category**: config
- **tags**: test, config
- **content**: テスト内容です

---
`;

    const entries = parseMarkdown(markdown, "config");

    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("test-id-001");
    expect(entries[0].title).toBe("テスト設定");
    expect(entries[0].content).toBe("テスト内容です");
    expect(entries[0].project).toBeUndefined();
    expect(entries[0].scope).toBeUndefined();
  });

  it("project/scopeありのフォーマットをパースできる", () => {
    const markdown = `## API URLの指定

- **id**: test-id-002
- **timestamp**: 2026-02-06T17:32:13.389+09:00
- **category**: config
- **project**: yakusoku
- **scope**: backend
- **tags**: API, URL, config
- **content**: APIのベースURLは https://api.example.com/v1

---
`;

    const entries = parseMarkdown(markdown, "config");

    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("test-id-002");
    expect(entries[0].project).toBe("yakusoku");
    expect(entries[0].scope).toBe("backend");
    expect(entries[0].tags).toEqual(["API", "URL", "config"]);
  });

  it("projectのみ、scopeなしのフォーマットをパースできる", () => {
    const markdown = `## 実装完了

- **id**: test-id-003
- **timestamp**: 2026-02-06T16:00:00.000+09:00
- **category**: log
- **project**: myproject
- **content**: 認証機能を実装

---
`;

    const entries = parseMarkdown(markdown, "log");

    expect(entries).toHaveLength(1);
    expect(entries[0].project).toBe("myproject");
    expect(entries[0].scope).toBeUndefined();
  });

  it("scopeのみ、projectなしのフォーマットをパースできる", () => {
    const markdown = `## React採用

- **id**: test-id-004
- **timestamp**: 2026-02-06T16:00:00.000+09:00
- **category**: decision
- **scope**: frontend
- **content**: フロントはReactで統一

---
`;

    const entries = parseMarkdown(markdown, "decision");

    expect(entries).toHaveLength(1);
    expect(entries[0].project).toBeUndefined();
    expect(entries[0].scope).toBe("frontend");
  });

  it("project/scopeあり・なし混在のファイルをパースできる", () => {
    const markdown = `# Config Memory

---

## 旧エントリ

- **id**: old-001
- **timestamp**: 2026-01-01T00:00:00.000+09:00
- **category**: config
- **tags**: old
- **content**: 古いエントリ

---

## 新エントリ

- **id**: new-001
- **timestamp**: 2026-02-06T16:00:00.000+09:00
- **category**: config
- **project**: yakusoku
- **scope**: backend
- **tags**: new
- **content**: 新しいエントリ

---
`;

    const entries = parseMarkdown(markdown, "config");

    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBe("old-001");
    expect(entries[0].project).toBeUndefined();
    expect(entries[0].scope).toBeUndefined();
    expect(entries[1].id).toBe("new-001");
    expect(entries[1].project).toBe("yakusoku");
    expect(entries[1].scope).toBe("backend");
  });

  it("formatEntry → parseMarkdownのラウンドトリップ", async () => {
    // formatEntryのインポートはテスト内で直接
    const { formatEntry } = await import("./formatter.js");
    const { MemoryEntry } = await import("../types.js") as any;

    const original = {
      id: "roundtrip-001",
      timestamp: "2026-02-06T16:00:00.000+09:00",
      category: "dont" as const,
      title: "ラウンドトリップテスト",
      content: "保存→パースで情報が失われないこと",
      tags: ["test", "roundtrip"],
      project: "yakusoku",
      scope: "backend",
    };

    const formatted = formatEntry(original);
    const parsed = parseMarkdown(formatted, "dont");

    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe(original.id);
    expect(parsed[0].title).toBe(original.title);
    expect(parsed[0].content).toBe(original.content);
    expect(parsed[0].project).toBe(original.project);
    expect(parsed[0].scope).toBe(original.scope);
    expect(parsed[0].tags).toEqual(original.tags);
  });
});
