import { describe, it, expect, vi, beforeEach } from "vitest";
import { hasContent, compactOwnerProfile } from "./owner-profile.js";

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

  describe("compactOwnerProfile", () => {
    it("イントロ文を除去する", () => {
      const md = `# Owner Profile

あなたの判断基準をAIに教えるためのプロファイルです。
AIが自律タスクを実行する際、ここに書かれた基準で判断を下します。
未記入のセクションはデフォルト値が適用されます。

---

## 1. 優先順位と投資判断

> AIがタスクの優先順位をつける際の基準になります。

### パフォーマンス改善の判断

- [x] クレームが来てからでいい (デフォルト)`;
      const result = compactOwnerProfile(md);
      expect(result).not.toContain("あなたの判断基準をAI");
      expect(result).not.toContain("AIがタスクの優先順位");
      expect(result).toContain("# Owner Profile");
    });

    it("未チェック選択肢を除去する", () => {
      const md = `# Owner Profile

## 1. テスト

### 選択

- [ ] オプションA
- [x] オプションB
- [ ] オプションC`;
      const result = compactOwnerProfile(md);
      expect(result).not.toContain("オプションA");
      expect(result).toContain("オプションB");
      expect(result).not.toContain("オプションC");
    });

    it("デフォルトのみのサブセクションを除外する", () => {
      const md = `# Owner Profile

## 1. テスト

### デフォルトだけ

- [ ] 選択肢A
- [x] 選択肢B (デフォルト)
- [ ] 選択肢C

### カスタム設定

- [ ] 選択肢X
- [x] 選択肢Y
- [ ] 選択肢Z`;
      const result = compactOwnerProfile(md);
      expect(result).not.toContain("デフォルトだけ");
      expect(result).not.toContain("選択肢B");
      expect(result).toContain("カスタム設定");
      expect(result).toContain("選択肢Y");
    });

    it("空セルのテーブル行を除去する", () => {
      const md = `# Owner Profile

## 1. テスト

### 緊急度

| 状況 | 緊急度 |
|------|--------|
| 本番障害 | 即対応 |
| セキュリティ | |
| CI/CD | |`;
      const result = compactOwnerProfile(md);
      expect(result).toContain("本番障害");
      expect(result).not.toContain("セキュリティ");
      expect(result).not.toContain("CI/CD");
    });

    it("(デフォルト) マーカーを除去する", () => {
      const md = `# Owner Profile

## 1. テスト

### カスタム

- [x] カスタム選択

### デフォルト含む

- [x] これはデフォルト (デフォルト)
- [x] これはカスタム`;
      const result = compactOwnerProfile(md);
      // カスタムセクションにはデフォルトマーカーなし
      expect(result).toContain("カスタム選択");
      // デフォルト含むセクションはカスタムがあるので出力されるが、マーカーは消える
      expect(result).toContain("これはデフォルト");
      expect(result).not.toContain("(デフォルト)");
    });

    it("空のh2セクションを除去する", () => {
      const md = `# Owner Profile

## 1. すべてデフォルト

### 選択

- [x] デフォルト値 (デフォルト)

## 2. 記入あり

### 選択

- [x] カスタム値`;
      const result = compactOwnerProfile(md);
      expect(result).not.toContain("すべてデフォルト");
      expect(result).toContain("記入あり");
      expect(result).toContain("カスタム値");
    });

    it("自由記述が記入されていれば含む", () => {
      const md = `# Owner Profile

## 自由記述

上の選択肢でカバーできない判断基準があれば、ここに自由に記述してください。

> テスト駆動開発を重視する。コードレビューは必ず行う。`;
      const result = compactOwnerProfile(md);
      expect(result).toContain("テスト駆動開発");
    });

    it("実際のbengo4-laboプロファイルで大幅に圧縮される", () => {
      // 全部デフォルトのプロファイル → ほぼ空になるはず
      const fullProfile = `# Owner Profile

あなたの判断基準をAIに教えるためのプロファイルです。
AIが自律タスクを実行する際、ここに書かれた基準で判断を下します。
未記入のセクションはデフォルト値が適用されます。

---

## 1. 優先順位と投資判断

> AIがタスクの優先順位をつける際の基準になります。

### パフォーマンス改善の判断

「ユーザーからクレームはないが、最適化できる」場合:

- [ ] 体感できる改善なら今すぐやる
- [x] クレームが来てからでいい (デフォルト)
- [ ] 他にやることがなければやる
- [ ] その他:

### 緊急度の定義

それぞれ「即対応 / 当日中 / 翌営業日 / 今週中 / バックログ」を記入:

| 状況 | 緊急度 |
|------|--------|
| 本番障害（全ユーザー影響） | 即対応 |
| 本番障害（一部ユーザー、回避策あり） | 当日中 |
| セキュリティ脆弱性（high） | |
| セキュリティ脆弱性（medium） | |

### タスクの時間制限

1つのタスクに許容する最大時間:

- [ ] 30分。それ以上は分割すべき
- [x] 1時間。ただし進捗報告は欲しい (デフォルト)
- [ ] 3時間まではOK

---

## 2. 設計・コード品質

> AIがコードを書くときの判断基準になります。

### 抽象化の判断

同じ処理が3箇所にある場合:

- [x] 本当に「同じ」か検討してから判断 (デフォルト)
- [ ] 4箇所目が出てきたら抽出

## 自由記述

上の選択肢でカバーできない判断基準があれば、ここに自由に記述してください。
AIはこのセクションの内容も判断の参考にします。

>`;
      const result = compactOwnerProfile(fullProfile);
      // テーブルに記入があるセクションだけ残る
      expect(result).toContain("即対応");
      expect(result).toContain("当日中");
      // デフォルトのみのセクションは消える
      expect(result).not.toContain("抽象化の判断");
      expect(result).not.toContain("パフォーマンス改善");
      expect(result).not.toContain("タスクの時間制限");
      // 圧縮率の確認
      expect(result.length).toBeLessThan(fullProfile.length * 0.3);
    });
  });
});
