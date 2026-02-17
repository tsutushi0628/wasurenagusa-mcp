import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { ChangeLogger } from "./change-logger.js";

describe("ChangeLogger", () => {
  let schedulerDir: string;
  let projectDir: string;

  beforeEach(async () => {
    schedulerDir = await mkdtemp(join(tmpdir(), "wasurenagusa-scheduler-"));
    projectDir = await mkdtemp(join(tmpdir(), "wasurenagusa-project-"));
  });

  afterEach(async () => {
    await rm(schedulerDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  describe("recordChanges()", () => {
    it("git diff HEAD --name-onlyで変更ファイル名を取得し、change-log.jsonに記録できる", async () => {
      const logger = new ChangeLogger(schedulerDir);

      // git diffの結果をモック
      vi.spyOn(logger as any, "execGit").mockResolvedValue("src/index.ts\nsrc/utils.ts\n");

      // .gitディレクトリを作成
      await mkdir(join(projectDir, ".git"));

      // .spec-workflow/steering/ を作成
      await mkdir(join(projectDir, ".spec-workflow", "steering"), { recursive: true });
      // .spec-workflow/specs/feature-a/ を作成
      await mkdir(join(projectDir, ".spec-workflow", "specs", "feature-a"), { recursive: true });

      const entry = await logger.recordChanges(projectDir);

      expect(entry).not.toBeNull();
      expect(entry!.changedFiles).toEqual(["src/index.ts", "src/utils.ts"]);
      expect(entry!.projectPath).toBe(projectDir);
      expect(entry!.project).toBe(projectDir.split("/").pop());
      expect(entry!.specPaths.steering).toBe(join(projectDir, ".spec-workflow", "steering"));
      expect(entry!.specPaths.specs).toEqual([join(projectDir, ".spec-workflow", "specs", "feature-a")]);
      expect(entry!.timestamp).toBeDefined();

      // change-log.jsonに書き込まれていることを確認
      const logContent = await readFile(join(schedulerDir, "change-log.json"), "utf-8");
      const entries = JSON.parse(logContent);
      expect(entries).toHaveLength(1);
      expect(entries[0].changedFiles).toEqual(["src/index.ts", "src/utils.ts"]);
    });

    it("変更ファイルがゼロ件の場合、記録をスキップする（nullを返す）", async () => {
      const logger = new ChangeLogger(schedulerDir);

      vi.spyOn(logger as any, "execGit").mockResolvedValue("");

      // .gitディレクトリを作成
      await mkdir(join(projectDir, ".git"));

      const entry = await logger.recordChanges(projectDir);

      expect(entry).toBeNull();
    });

    it(".gitディレクトリが存在しない場合、記録をスキップする", async () => {
      const logger = new ChangeLogger(schedulerDir);

      const entry = await logger.recordChanges(projectDir);

      expect(entry).toBeNull();
    });

    it("git diff HEAD失敗時、git status --porcelainにフォールバックする", async () => {
      const logger = new ChangeLogger(schedulerDir);

      // git diffが失敗し、git statusにフォールバック
      const execGitSpy = vi.spyOn(logger as any, "execGit");
      execGitSpy.mockRejectedValueOnce(new Error("git diff failed"));
      execGitSpy.mockResolvedValueOnce(" M src/main.ts\n?? src/new-file.ts\n");

      // .gitディレクトリを作成
      await mkdir(join(projectDir, ".git"));

      const entry = await logger.recordChanges(projectDir);

      expect(entry).not.toBeNull();
      expect(entry!.changedFiles).toEqual(["src/main.ts", "src/new-file.ts"]);

      // 2回呼ばれることを確認（diff失敗後にstatus）
      expect(execGitSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe("getEntries()", () => {
    it("既存の変更ログエントリを取得できる", async () => {
      const logger = new ChangeLogger(schedulerDir);

      const existingEntries = [
        {
          timestamp: "2026-01-01T00:00:00+09:00",
          project: "project-a",
          projectPath: "/tmp/project-a",
          changedFiles: ["file1.ts"],
          specPaths: { steering: "/tmp/project-a/.spec-workflow/steering", specs: [] },
        },
        {
          timestamp: "2026-01-02T00:00:00+09:00",
          project: "project-b",
          projectPath: "/tmp/project-b",
          changedFiles: ["file2.ts", "file3.ts"],
          specPaths: { steering: "/tmp/project-b/.spec-workflow/steering", specs: [] },
        },
      ];
      await writeFile(join(schedulerDir, "change-log.json"), JSON.stringify(existingEntries));

      const entries = await logger.getEntries();

      expect(entries).toHaveLength(2);
      expect(entries[0].project).toBe("project-a");
      expect(entries[1].changedFiles).toEqual(["file2.ts", "file3.ts"]);
    });

    it("change-log.jsonが存在しない場合、空配列を返す", async () => {
      const logger = new ChangeLogger(schedulerDir);

      const entries = await logger.getEntries();

      expect(entries).toEqual([]);
    });
  });

  describe("consumeEntry()", () => {
    it("特定のエントリを消費済みにできる（配列から除去）", async () => {
      const logger = new ChangeLogger(schedulerDir);

      const existingEntries = [
        {
          timestamp: "2026-01-01T00:00:00+09:00",
          project: "project-a",
          projectPath: "/tmp/project-a",
          changedFiles: ["file1.ts"],
          specPaths: { steering: "/tmp/project-a/.spec-workflow/steering", specs: [] },
        },
        {
          timestamp: "2026-01-02T00:00:00+09:00",
          project: "project-b",
          projectPath: "/tmp/project-b",
          changedFiles: ["file2.ts"],
          specPaths: { steering: "/tmp/project-b/.spec-workflow/steering", specs: [] },
        },
      ];
      await writeFile(join(schedulerDir, "change-log.json"), JSON.stringify(existingEntries));

      await logger.consumeEntry("2026-01-01T00:00:00+09:00");

      const remaining = await logger.getEntries();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].project).toBe("project-b");
    });
  });
});
