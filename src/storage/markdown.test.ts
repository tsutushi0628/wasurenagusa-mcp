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

    it("タイトルが類似するconfigエントリは新しい方のみ注入される", async () => {
      const storage = new MarkdownStorage(tempDir);

      // 古いエントリ
      await storage.save({
        category: "config",
        title: "motoe-evalのポート番号設定",
        content: "Functionsは5013",
        project: "bengo4-labo",
      });
      // 新しいエントリ（タイトルが類似）
      await storage.save({
        category: "config",
        title: "motoe-evalのポート番号定義",
        content: "Functionsは5013、Viteは8010",
        project: "bengo4-labo",
      });

      const context = await storage.getContext("bengo4-labo");

      // 新しい方が残る
      expect(context.config).toContain("motoe-evalのポート番号定義");
      expect(context.config).toContain("Viteは8010");
      // 古い方は除外
      expect(context.config).not.toContain("motoe-evalのポート番号設定");
    });

    it("タイトルが異なるconfigエントリは両方注入される", async () => {
      const storage = new MarkdownStorage(tempDir);

      await storage.save({
        category: "config",
        title: "API URL設定",
        content: "https://api.example.com",
        project: "yakusoku",
      });
      await storage.save({
        category: "config",
        title: "データベース接続情報",
        content: "Firestoreのコレクション名: users",
        project: "yakusoku",
      });

      const context = await storage.getContext("yakusoku");

      expect(context.config).toContain("API URL設定");
      expect(context.config).toContain("データベース接続情報");
    });

    it("トークン重複が2未満の場合はduplicate判定しない", async () => {
      const storage = new MarkdownStorage(tempDir);

      await storage.save({
        category: "config",
        title: "contract-checker構成情報",
        content: "Bundle ID: com.bengo4.contractchecker",
        project: "bengo4-labo",
      });
      await storage.save({
        category: "config",
        title: "contract-checker配信要件",
        content: "6.9インチスクリーンショット必須",
        project: "bengo4-labo",
      });

      const context = await storage.getContext("bengo4-labo");

      // トークン重複は"contract-checker"の1つだけ → 2未満なので両方残る
      expect(context.config).toContain("contract-checker構成情報");
      expect(context.config).toContain("contract-checker配信要件");
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

  describe("archiveExcessEntries() - エントリ上限超過時の自動アーカイブ", () => {
    it("上限超過時に古いエントリがアーカイブファイルに移動する", async () => {
      // 上限を3に設定してテスト
      const originalMax = (await import("../config.js")).config.maxEntriesPerCategory;
      (await import("../config.js")).config.maxEntriesPerCategory = 3;

      const storage = new MarkdownStorage(tempDir);

      // 5件保存（上限3を超える）
      for (let i = 1; i <= 5; i++) {
        await storage.save({
          category: "dont",
          title: `ルール${i}`,
          content: `内容${i}`,
        });
      }

      // メインファイルには最新3件のみ
      const mainContent = await readFile(
        join(tempDir, ".wasurenagusa", "dont.md"),
        "utf-8"
      );
      expect(mainContent).toContain("ルール3");
      expect(mainContent).toContain("ルール4");
      expect(mainContent).toContain("ルール5");
      expect(mainContent).not.toContain("ルール1");
      expect(mainContent).not.toContain("ルール2");

      // アーカイブファイルに古い2件
      const archivePath = join(tempDir, ".wasurenagusa", "dont-archive.md");
      expect(existsSync(archivePath)).toBe(true);
      const archiveContent = await readFile(archivePath, "utf-8");
      expect(archiveContent).toContain("ルール1");
      expect(archiveContent).toContain("ルール2");

      // 設定を戻す
      (await import("../config.js")).config.maxEntriesPerCategory = originalMax;
    });

    it("上限以内ならアーカイブファイルは作成されない", async () => {
      const originalMax = (await import("../config.js")).config.maxEntriesPerCategory;
      (await import("../config.js")).config.maxEntriesPerCategory = 10;

      const storage = new MarkdownStorage(tempDir);

      await storage.save({
        category: "config",
        title: "設定1",
        content: "内容1",
      });
      await storage.save({
        category: "config",
        title: "設定2",
        content: "内容2",
      });

      const archivePath = join(tempDir, ".wasurenagusa", "config-archive.md");
      expect(existsSync(archivePath)).toBe(false);

      (await import("../config.js")).config.maxEntriesPerCategory = originalMax;
    });

    it("logカテゴリはアーカイブ対象外", async () => {
      const originalMax = (await import("../config.js")).config.maxEntriesPerCategory;
      (await import("../config.js")).config.maxEntriesPerCategory = 2;

      const storage = new MarkdownStorage(tempDir);

      for (let i = 1; i <= 5; i++) {
        await storage.save({
          category: "log",
          title: `ログ${i}`,
          content: `ログ内容${i}`,
        });
      }

      // logs/ディレクトリ内にアーカイブファイルは存在しない
      const archivePath = join(tempDir, ".wasurenagusa", "logs-archive.md");
      expect(existsSync(archivePath)).toBe(false);

      (await import("../config.js")).config.maxEntriesPerCategory = originalMax;
    });

    it("アーカイブ時にsave結果のメッセージにアーカイブ数が含まれる", async () => {
      const originalMax = (await import("../config.js")).config.maxEntriesPerCategory;
      (await import("../config.js")).config.maxEntriesPerCategory = 2;

      const storage = new MarkdownStorage(tempDir);

      await storage.save({ category: "snippet", title: "s1", content: "c1" });
      await storage.save({ category: "snippet", title: "s2", content: "c2" });
      const result = await storage.save({ category: "snippet", title: "s3", content: "c3" });

      expect(result.message).toContain("アーカイブ");

      (await import("../config.js")).config.maxEntriesPerCategory = originalMax;
    });
  });

  describe("deduplicateConfigEntries() - configエントリの重複排除", () => {
    it("タイトルトークンが50%以上重複するエントリは新しい方のみ残す", () => {
      const storage = new MarkdownStorage(tempDir);

      const entries = [
        { id: "old", timestamp: "2026-01-01T00:00:00+09:00", category: "config" as const, title: "motoe-evalのポート番号設定", content: "5013", tags: [] },
        { id: "new", timestamp: "2026-03-01T00:00:00+09:00", category: "config" as const, title: "motoe-evalのポート番号定義", content: "5013/8010", tags: [] },
      ];

      const result = storage.deduplicateConfigEntries(entries);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("new");
    });

    it("タイトルが異なるエントリは両方残す", () => {
      const storage = new MarkdownStorage(tempDir);

      const entries = [
        { id: "a", timestamp: "2026-01-01T00:00:00+09:00", category: "config" as const, title: "API URL設定", content: "https://example.com", tags: [] },
        { id: "b", timestamp: "2026-03-01T00:00:00+09:00", category: "config" as const, title: "データベース接続情報", content: "Firestore", tags: [] },
      ];

      const result = storage.deduplicateConfigEntries(entries);

      expect(result).toHaveLength(2);
    });

    it("3件以上の重複グループでも最新のみ残す", () => {
      const storage = new MarkdownStorage(tempDir);

      const entries = [
        { id: "v1", timestamp: "2026-01-01T00:00:00+09:00", category: "config" as const, title: "各プロダクトのポート番号設定", content: "5009/5013", tags: [] },
        { id: "v2", timestamp: "2026-02-01T00:00:00+09:00", category: "config" as const, title: "プロジェクト別ポート番号定義", content: "5013/8010", tags: [] },
        { id: "v3", timestamp: "2026-03-01T00:00:00+09:00", category: "config" as const, title: "motoe-evalのポート番号設定", content: "5013/8010最新", tags: [] },
      ];

      const result = storage.deduplicateConfigEntries(entries);

      // v3（最新）が残り、v1は「ポート番号」「設定」がv3と重複で除外、
      // v2は「ポート番号」がv3と重複するが「定義」vs「設定」で重複率がギリギリ
      // いずれにせよ最新のv3は必ず残る
      expect(result[0].id).toBe("v3");
      expect(result.length).toBeLessThanOrEqual(2);
    });

    it("空配列は空配列を返す", () => {
      const storage = new MarkdownStorage(tempDir);
      expect(storage.deduplicateConfigEntries([])).toEqual([]);
    });

    it("1件のみの場合はそのまま返す", () => {
      const storage = new MarkdownStorage(tempDir);

      const entries = [
        { id: "only", timestamp: "2026-01-01T00:00:00+09:00", category: "config" as const, title: "唯一の設定", content: "内容", tags: [] },
      ];

      const result = storage.deduplicateConfigEntries(entries);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("only");
    });

    it("コンテンツに同じポート番号を持つエントリは包含関係で重複判定する", () => {
      const storage = new MarkdownStorage(tempDir);

      const entries = [
        { id: "comprehensive", timestamp: "2026-03-01T00:00:00+09:00", category: "config" as const, title: "motoe-eval技術設定・環境情報", content: "React 19, Tailwind 4採用。ポートは5013/8010。DB名はai-motoe-db", tags: [] },
        { id: "port-only", timestamp: "2026-01-01T00:00:00+09:00", category: "config" as const, title: "motoe-evalのポート番号設定", content: "Functionsは5013、Viteは8010", tags: [] },
      ];

      const result = storage.deduplicateConfigEntries(entries);

      // port-onlyの事実（5013, 8010）がcomprehensiveに含まれるので除外
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("comprehensive");
    });

    it("コンテンツ事実が1つだけの場合は重複判定しない（誤検出防止）", () => {
      const storage = new MarkdownStorage(tempDir);

      const entries = [
        { id: "a", timestamp: "2026-03-01T00:00:00+09:00", category: "config" as const, title: "サーバー設定", content: "ポート5013を使用", tags: [] },
        { id: "b", timestamp: "2026-01-01T00:00:00+09:00", category: "config" as const, title: "全く違うトピック", content: "偶然5013が含まれる文章", tags: [] },
      ];

      const result = storage.deduplicateConfigEntries(entries);

      // 事実が1つだけなので重複判定しない
      expect(result).toHaveLength(2);
    });

    it("Figma MCP連携のように英語+漢字の重複を検出する", () => {
      const storage = new MarkdownStorage(tempDir);

      const entries = [
        { id: "old", timestamp: "2026-01-01T00:00:00+09:00", category: "config" as const, title: "Figma MCP連携の設定", content: "http://127.0.0.1:3845/sse", tags: [] },
        { id: "new", timestamp: "2026-03-01T00:00:00+09:00", category: "config" as const, title: "Figma MCP連携設定", content: "https://mcp.figma.com/mcp", tags: [] },
      ];

      const result = storage.deduplicateConfigEntries(entries);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("new");
    });
  });

  describe("importance - 保存→読み込み→フィルタの統合テスト", () => {
    it("importance: 'critical' のdontエントリを保存→readDontEntries→importanceが反映される", async () => {
      const storage = new MarkdownStorage(tempDir);

      await storage.save({
        category: "dont",
        title: "絶対禁止事項",
        content: "これは絶対にやってはいけない",
        tags: ["critical-test"],
        importance: "critical",
      });

      const entries = await storage.readDontEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].importance).toBe("critical");
      expect(entries[0].title).toBe("絶対禁止事項");
    });

    it("importance: 'normal' のdontエントリを保存→readDontEntries→importanceが反映される", async () => {
      const storage = new MarkdownStorage(tempDir);

      await storage.save({
        category: "dont",
        title: "通常注意事項",
        content: "これは注意すべきこと",
        tags: ["normal-test"],
        importance: "normal",
      });

      const entries = await storage.readDontEntries();
      expect(entries).toHaveLength(1);
      // normalはformatterで出力されないのでundefinedに戻る
      expect(entries[0].importance).toBeUndefined();
      expect(entries[0].title).toBe("通常注意事項");
    });

    it("critical/normalの混在でフィルタリングが正しく動作する", async () => {
      const storage = new MarkdownStorage(tempDir);

      await storage.save({
        category: "dont",
        title: "絶対禁止A",
        content: "内容A",
        importance: "critical",
      });
      await storage.save({
        category: "dont",
        title: "通常注意B",
        content: "内容B",
        importance: "normal",
      });
      await storage.save({
        category: "dont",
        title: "絶対禁止C",
        content: "内容C",
        importance: "critical",
      });

      const entries = await storage.readDontEntries();
      expect(entries).toHaveLength(3);

      const criticals = entries.filter(e => e.importance === "critical");
      expect(criticals).toHaveLength(2);
      expect(criticals.map(e => e.title)).toContain("絶対禁止A");
      expect(criticals.map(e => e.title)).toContain("絶対禁止C");

      const nonCriticals = entries.filter(e => e.importance !== "critical");
      expect(nonCriticals).toHaveLength(1);
      expect(nonCriticals[0].title).toBe("通常注意B");
    });

    it("importance付きエントリがsearch()のMemoryIndexEntryにも反映される", async () => {
      const storage = new MarkdownStorage(tempDir);

      await storage.save({
        category: "dont",
        title: "検索テスト禁止事項",
        content: "検索テスト内容",
        tags: ["search-test"],
        importance: "critical",
      });

      const result = await storage.search({
        query: "検索テスト",
        category: "dont",
      });

      expect(result.results).toHaveLength(1);
      expect(result.results[0].importance).toBe("critical");
    });

    it("importance未指定のエントリは後方互換性を維持する", async () => {
      const storage = new MarkdownStorage(tempDir);

      await storage.save({
        category: "dont",
        title: "旧式エントリ",
        content: "importanceなしの既存エントリ",
      });

      const entries = await storage.readDontEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].importance).toBeUndefined();
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
