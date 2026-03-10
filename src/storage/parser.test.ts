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

  it("importance行ありのMarkdownをパースしてimportanceを取得できる", () => {
    const markdown = `## 絶対禁止事項

- **id**: test-imp-001
- **timestamp**: 2026-02-06T16:00:00.000+09:00
- **category**: dont
- **scope**: backend
- **importance**: critical
- **tags**: test
- **content**: これは絶対にやってはいけない

---
`;

    const entries = parseMarkdown(markdown, "dont");

    expect(entries).toHaveLength(1);
    expect(entries[0].importance).toBe("critical");
  });

  it("importance行なしのMarkdownではimportanceがundefined", () => {
    const markdown = `## 通常事項

- **id**: test-imp-002
- **timestamp**: 2026-02-06T16:00:00.000+09:00
- **category**: dont
- **tags**: test
- **content**: 通常の注意事項

---
`;

    const entries = parseMarkdown(markdown, "dont");

    expect(entries).toHaveLength(1);
    expect(entries[0].importance).toBeUndefined();
  });

  it("content内に ## を含むエントリを正しくパースできる", () => {
    const markdown = `## Firestore問題

- **id**: test-multiline-001
- **timestamp**: 2026-02-06T03:19:06.099Z
- **category**: log
- **tags**: firestore, rules
- **content**: ## 問題
Firestoreのnamed databaseでルールがデプロイされていなかった。
## 対応
firebase deploy --only firestore:rules を実行して解決。

---
`;

    const entries = parseMarkdown(markdown, "log");

    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("test-multiline-001");
    expect(entries[0].title).toBe("Firestore問題");
    expect(entries[0].content).toContain("## 問題");
    expect(entries[0].content).toContain("## 対応");
    expect(entries[0].content).toContain("firebase deploy");
  });

  it("複数行contentを正しくパースできる", () => {
    const markdown = `## 実装ログ

- **id**: test-multiline-002
- **timestamp**: 2026-02-06T16:00:00.000+09:00
- **category**: log
- **content**: 認証機能を実装した。
主な変更点:
- Firebase Authを導入
- ソーシャルログイン対応
- セッション管理の追加

---
`;

    const entries = parseMarkdown(markdown, "log");

    expect(entries).toHaveLength(1);
    expect(entries[0].content).toContain("認証機能を実装した。");
    expect(entries[0].content).toContain("- Firebase Authを導入");
    expect(entries[0].content).toContain("- セッション管理の追加");
  });

  it("content内の ## でセクション分割されない", () => {
    const markdown = `## エントリ1

- **id**: no-split-001
- **timestamp**: 2026-02-06T16:00:00.000+09:00
- **category**: log
- **content**: ## 内部見出し

---

## エントリ2

- **id**: no-split-002
- **timestamp**: 2026-02-06T17:00:00.000+09:00
- **category**: log
- **content**: 2つ目のエントリ

---
`;

    const entries = parseMarkdown(markdown, "log");

    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBe("no-split-001");
    expect(entries[0].content).toContain("## 内部見出し");
    expect(entries[1].id).toBe("no-split-002");
    expect(entries[1].content).toBe("2つ目のエントリ");
  });

  it("formatEntry → parseMarkdownのラウンドトリップ（単一行content）", async () => {
    const { formatEntry } = await import("./formatter.js");

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

  it("formatEntry → parseMarkdownのラウンドトリップ（複数行content）", async () => {
    const { formatEntry } = await import("./formatter.js");

    const original = {
      id: "roundtrip-multi-001",
      timestamp: "2026-02-06T16:00:00.000+09:00",
      category: "log" as const,
      title: "マルチラインテスト",
      content: "## 問題\nFirestoreのルールが未デプロイ\n## 対応\ndeployコマンドで解決",
      tags: ["test"],
      project: "yakusoku",
    };

    const formatted = formatEntry(original);
    const parsed = parseMarkdown(formatted, "log");

    expect(parsed).toHaveLength(1);
    expect(parsed[0].content).toBe(original.content);
  });
});
