import { describe, it, expect, vi, beforeEach } from "vitest";
import { hasContent } from "./owner-profile.js";

describe("owner-profile", () => {
  describe("hasContent", () => {
    it("テンプレートのまま（見出し+コメントのみ）ならfalse", () => {
      const template = `# Owner Profile

## 1. 優先順位

---

## 2. コード品質
`;
      expect(hasContent(template)).toBe(false);
    });

    it("空文字列はfalse", () => {
      expect(hasContent("")).toBe(false);
    });

    it("見出しと空行だけはfalse", () => {
      expect(hasContent("# Title\n\n## Section\n\n---\n")).toBe(false);
    });

    it("ブロック引用の空行だけはfalse", () => {
      expect(hasContent("# Title\n> \n> \n")).toBe(false);
    });

    it("ユーザーが記入した内容があればtrue", () => {
      const filled = `# Owner Profile

## 1. 優先順位

品質を最優先にする。スピードは二の次。
`;
      expect(hasContent(filled)).toBe(true);
    });

    it("チェックボックスがあればtrue", () => {
      const filled = `# Owner Profile

- [x] 常に100%を目指す
- [ ] 80%で出す
`;
      expect(hasContent(filled)).toBe(true);
    });

    it("テーブルの中身があればtrue", () => {
      const filled = `# Owner Profile

| 状況 | 緊急度 |
|------|--------|
| 本番障害 | 即対応 |
`;
      expect(hasContent(filled)).toBe(true);
    });

    it("HTMLコメントだけの場合はfalse", () => {
      const commented = `# Owner Profile

<!-- これはコメント -->

## Section

<!-- もう一つのコメント -->
`;
      expect(hasContent(commented)).toBe(false);
    });

    it("ブロック引用に内容があればtrue", () => {
      const filled = `# Owner Profile

> 型安全は絶対に守る
`;
      expect(hasContent(filled)).toBe(true);
    });
  });
});
