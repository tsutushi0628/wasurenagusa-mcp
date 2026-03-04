import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { existsSync } from "fs";
import { MarkdownStorage } from "./markdown.js";

describe("MarkdownStorage", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "wasurenagusa-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("save() - project/scope", () => {
    it("project/scopeありで保存するとMarkdownにproject/scope行が含まれる", async () => {
      const storage = new MarkdownStorage(tempDir);

      const result = await storage.save({
        category: "config",
        title: "API URL",
        content: "https://api.example.com",
        tags: ["API"],
        project: "yakusoku",
        scope: "backend",
      });

      expect(result.success).toBe(true);

      const fileContent = await readFile(result.path, "utf-8");
      expect(fileContent).toContain("- **project**: yakusoku");
      expect(fileContent).toContain("- **scope**: backend");
    });

    it("project/scopeなしで保存しても正常動作（後方互換性）", async () => {
      const storage = new MarkdownStorage(tempDir);

      const result = await storage.save({
        category: "dont",
        title: "テスト",
        content: "内容",
      });

      expect(result.success).toBe(true);

      const fileContent = await readFile(result.path, "utf-8");
      expect(fileContent).not.toContain("- **project**:");
      expect(fileContent).not.toContain("- **scope**:");
    });
  });

  describe("search() - project/scopeフィルタ", () => {
    async function seedEntries(storage: MarkdownStorage) {
      await storage.save({
        category: "config",
        title: "yakusoku API URL",
        content: "https://yakusoku.example.com",
        tags: ["API"],
        project: "yakusoku",
        scope: "backend",
      });
      await storage.save({
        category: "config",
        title: "bl-labo API URL",
        content: "https://bl-labo.example.com",
        tags: ["API"],
        project: "bl-labo",
        scope: "backend",
      });
      await storage.save({
        category: "config",
        title: "共通設定",
        content: "全プロジェクト共通",
        tags: ["common"],
        // project未指定 = 全プロジェクト共通
      });
    }

    it("projectフィルタ: 指定プロジェクト + project未指定エントリのみ", async () => {
      const storage = new MarkdownStorage(tempDir);
      await seedEntries(storage);

      const result = await storage.search({
        query: "API",
        project: "yakusoku",
      });

      const titles = result.results.map(r => r.title);
      expect(titles).toContain("yakusoku API URL");
      expect(titles).not.toContain("bl-labo API URL");
    });

    it("projectフィルタ: project未指定エントリは常に含まれる", async () => {
      const storage = new MarkdownStorage(tempDir);
      await seedEntries(storage);

      const result = await storage.search({
        query: "共通",
        project: "yakusoku",
      });

      expect(result.results).toHaveLength(1);
      expect(result.results[0].title).toBe("共通設定");
    });

    it("projectフィルタなし: 全プロジェクトのエントリを返す", async () => {
      const storage = new MarkdownStorage(tempDir);
      await seedEntries(storage);

      const result = await storage.search({ query: "API" });

      expect(result.results.length).toBeGreaterThanOrEqual(2);
    });

    it("scopeフィルタ: 指定scope + general + scope未指定エントリのみ", async () => {
      const storage = new MarkdownStorage(tempDir);

      await storage.save({
        category: "config",
        title: "バックエンド設定",
        content: "バックエンド用",
        project: "test",
        scope: "backend",
      });
      await storage.save({
        category: "config",
        title: "フロントエンド設定",
        content: "フロントエンド用",
        project: "test",
        scope: "frontend",
      });
      await storage.save({
        category: "config",
        title: "一般設定",
        content: "general scope",
        project: "test",
        scope: "general",
      });
      await storage.save({
        category: "config",
        title: "scope未指定の設定",
        content: "no scope",
        project: "test",
      });

      const result = await storage.search({
        query: "設定",
        scope: "backend",
      });

      const titles = result.results.map(r => r.title);
      expect(titles).toContain("バックエンド設定");
      expect(titles).toContain("一般設定");
      expect(titles).toContain("scope未指定の設定");
      expect(titles).not.toContain("フロントエンド設定");
    });

    it("検索結果のindexEntryにproject/scopeが含まれる", async () => {
      const storage = new MarkdownStorage(tempDir);

      await storage.save({
        category: "config",
        title: "テスト設定",
        content: "テスト",
        project: "myproject",
        scope: "infra",
      });

      const result = await storage.search({ query: "テスト" });

      expect(result.results[0].project).toBe("myproject");
      expect(result.results[0].scope).toBe("infra");
    });
  });

  describe("save() - replaceIdによる既存エントリ置換", () => {
    it("replaceId指定時: 既存エントリを置換する", async () => {
      const storage = new MarkdownStorage(tempDir);

      // まず保存
      const original = await storage.save({
        category: "dont",
        title: "ログ未読への怒り",
        content: "ログを読め",
        project: "test",
      });
      expect(original.success).toBe(true);

      // 同じIDで置換
      const replaced = await storage.save({
        category: "dont",
        title: "ログ未読への怒り（更新）",
        content: "❌ ログを読まずに質問した。💡 何度も同じことを聞かれるのはストレス。✅ まずログを確認してから質問する",
        project: "test",
        replaceId: original.id,
      });
      expect(replaced.success).toBe(true);

      // 検索して1件のみ存在することを確認
      const result = await storage.search({ query: "ログ", category: "dont" });
      expect(result.totalCount).toBe(1);
      expect(result.results[0].title).toBe("ログ未読への怒り（更新）");
    });

    it("replaceId指定時: 元のエントリの内容が残っていない", async () => {
      const storage = new MarkdownStorage(tempDir);

      const original = await storage.save({
        category: "dont",
        title: "古い内容",
        content: "古いcontent",
        project: "test",
      });

      await storage.save({
        category: "dont",
        title: "新しい内容",
        content: "新しいcontent",
        project: "test",
        replaceId: original.id,
      });

      const fileContent = await readFile(
        join(tempDir, ".wasurenagusa", "dont.md"),
        "utf-8"
      );
      expect(fileContent).not.toContain("古い内容");
      expect(fileContent).not.toContain("古いcontent");
      expect(fileContent).toContain("新しい内容");
      expect(fileContent).toContain("新しいcontent");
    });

    it("replaceIdが存在しないIDの場合: 新規追加として保存する", async () => {
      const storage = new MarkdownStorage(tempDir);

      await storage.save({
        category: "dont",
        title: "既存エントリ",
        content: "既存の内容",
      });

      const result = await storage.save({
        category: "dont",
        title: "新規エントリ",
        content: "新規の内容",
        replaceId: "nonexistent-id",
      });
      expect(result.success).toBe(true);

      // 両方存在する
      const search = await storage.search({ query: "エントリ", category: "dont" });
      expect(search.totalCount).toBe(2);
    });
  });

  describe("delete() - エントリ削除", () => {
    it("指定IDのエントリを削除する", async () => {
      const storage = new MarkdownStorage(tempDir);

      const entry1 = await storage.save({
        category: "dont",
        title: "削除対象",
        content: "消すやつ",
      });
      await storage.save({
        category: "dont",
        title: "残す対象",
        content: "残すやつ",
      });

      const result = await storage.delete({ ids: [entry1.id] });

      expect(result.deleted).toContain(entry1.id);
      expect(result.notFound).toHaveLength(0);

      const search = await storage.search({ query: "対象", category: "dont" });
      expect(search.totalCount).toBe(1);
      expect(search.results[0].title).toBe("残す対象");
    });

    it("複数IDを一括削除する", async () => {
      const storage = new MarkdownStorage(tempDir);

      const entry1 = await storage.save({
        category: "dont",
        title: "削除1",
        content: "消す1",
      });
      const entry2 = await storage.save({
        category: "dont",
        title: "削除2",
        content: "消す2",
      });
      await storage.save({
        category: "dont",
        title: "残す",
        content: "残すやつ",
      });

      const result = await storage.delete({ ids: [entry1.id, entry2.id] });

      expect(result.deleted).toHaveLength(2);
      expect(result.notFound).toHaveLength(0);

      const search = await storage.search({ query: "", category: "dont" });
      expect(search.totalCount).toBe(1);
      expect(search.results[0].title).toBe("残す");
    });

    it("存在しないIDはnotFoundに入る", async () => {
      const storage = new MarkdownStorage(tempDir);

      await storage.save({
        category: "dont",
        title: "既存",
        content: "既存内容",
      });

      const result = await storage.delete({ ids: ["nonexistent-id"] });

      expect(result.deleted).toHaveLength(0);
      expect(result.notFound).toContain("nonexistent-id");
    });

    it("複数カテゴリにまたがるIDを削除できる", async () => {
      const storage = new MarkdownStorage(tempDir);

      const configEntry = await storage.save({
        category: "config",
        title: "消す設定",
        content: "消す",
      });
      const dontEntry = await storage.save({
        category: "dont",
        title: "消すルール",
        content: "消す",
      });

      const result = await storage.delete({ ids: [configEntry.id, dontEntry.id] });

      expect(result.deleted).toHaveLength(2);

      const configSearch = await storage.search({ query: "消す", category: "config" });
      expect(configSearch.totalCount).toBe(0);

      const dontSearch = await storage.search({ query: "消す", category: "dont" });
      expect(dontSearch.totalCount).toBe(0);
    });

    it("logカテゴリのエントリも削除できる", async () => {
      const storage = new MarkdownStorage(tempDir);

      const logEntry = await storage.save({
        category: "log",
        title: "削除するログ",
        content: "消すログ",
      });

      const result = await storage.delete({ ids: [logEntry.id] });

      expect(result.deleted).toContain(logEntry.id);
    });

    it("削除後にファイル内容から該当エントリが消えている", async () => {
      const storage = new MarkdownStorage(tempDir);

      const entry = await storage.save({
        category: "dont",
        title: "消すエントリ",
        content: "完全に消える内容",
      });

      await storage.delete({ ids: [entry.id] });

      const fileContent = await readFile(
        join(tempDir, ".wasurenagusa", "dont.md"),
        "utf-8"
      );
      expect(fileContent).not.toContain("消すエントリ");
      expect(fileContent).not.toContain("完全に消える内容");
    });
  });

  describe("getContext() - dont全件+configタイトル一覧", () => {
    it("dontは全件の内容を返却する", async () => {
      const storage = new MarkdownStorage(tempDir);

      await storage.save({
        category: "dont",
        title: "ログ未読への怒り",
        content: "ログを読んでから質問すること",
        project: "yakusoku",
      });

      const context = await storage.getContext("yakusoku");

      expect(context.dont).toContain("ログ未読への怒り");
      expect(context.dont).toContain("ログを読んでから質問すること");
    });

    it("configはタイトルと内容を両方返却する", async () => {
      const storage = new MarkdownStorage(tempDir);

      await storage.save({
        category: "config",
        title: "API URL設定",
        content: "https://api.example.com",
        project: "yakusoku",
      });

      const context = await storage.getContext("yakusoku");

      expect(context.config).toContain("API URL設定");
      expect(context.config).toContain("https://api.example.com");
    });

    it("projectフィルタ: 別プロジェクトのエントリは含まない", async () => {
      const storage = new MarkdownStorage(tempDir);

      await storage.save({
        category: "dont",
        title: "yakusokuルール",
        content: "yakusoku専用",
        project: "yakusoku",
      });
      await storage.save({
        category: "dont",
        title: "bl-laboルール",
        content: "bl-labo専用",
        project: "bl-labo",
      });

      const context = await storage.getContext("yakusoku");

      expect(context.dont).toContain("yakusokuルール");
      expect(context.dont).not.toContain("bl-laboルール");
    });

    it("project未指定エントリは常に含まれる", async () => {
      const storage = new MarkdownStorage(tempDir);

      await storage.save({
        category: "dont",
        title: "共通ルール",
        content: "全プロジェクト共通のルール",
      });

      const context = await storage.getContext("yakusoku");

      expect(context.dont).toContain("共通ルール");
    });

    it("currentProject未指定時は全エントリ対象", async () => {
      const storage = new MarkdownStorage(tempDir);

      await storage.save({
        category: "config",
        title: "yakusoku設定",
        content: "yakusoku用",
        project: "yakusoku",
      });
      await storage.save({
        category: "config",
        title: "bl-labo設定",
        content: "bl-labo用",
        project: "bl-labo",
      });

      const context = await storage.getContext();

      expect(context.config).toContain("yakusoku設定");
      expect(context.config).toContain("bl-labo設定");
    });
  });

  describe("rotateOldLogs() - 不正なファイル名の無視", () => {
    it("日付形式でないファイル名はrotate対象から除外する", async () => {
      const storage = new MarkdownStorage(tempDir);
      await storage.initialize();

      const logsPath = join(tempDir, ".wasurenagusa", "logs");
      // 不正なファイル名を配置
      await writeFile(join(logsPath, "not-a-date.md"), "invalid");
      await writeFile(join(logsPath, "malicious-file.md"), "bad content");

      // rotateしても例外が飛ばない（initializeが内部でrotateOldLogsを呼ぶ）
      await storage.initialize();

      // 不正ファイルは削除されずに残る（日付形式でないため無視される）
      expect(existsSync(join(logsPath, "not-a-date.md"))).toBe(true);
      expect(existsSync(join(logsPath, "malicious-file.md"))).toBe(true);
    });
  });

  describe("getFilePath() - timestampの日付バリデーション", () => {
    it("正常な日付形式のログは保存できる", async () => {
      const storage = new MarkdownStorage(tempDir);

      const result = await storage.save({
        category: "log",
        title: "テストログ",
        content: "テスト内容",
      });

      expect(result.success).toBe(true);
      expect(result.path).toMatch(/\d{4}-\d{2}-\d{2}\.md$/);
    });
  });
});
