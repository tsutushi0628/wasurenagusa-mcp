import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { TaskQueue } from "./task-queue.js";
import type { ChangeLogEntry, ProjectConfig, SchedulerTask } from "../types.js";

describe("TaskQueue", () => {
  let schedulerDir: string;

  beforeEach(async () => {
    schedulerDir = await mkdtemp(join(tmpdir(), "wasurenagusa-queue-"));
  });

  afterEach(async () => {
    await rm(schedulerDir, { recursive: true, force: true });
  });

  const makeChangeEntry = (overrides: Partial<ChangeLogEntry> = {}): ChangeLogEntry => ({
    timestamp: "2026-02-14T10:00:00+09:00",
    project: "my-project",
    projectPath: "/tmp/my-project",
    changedFiles: ["src/index.ts"],
    specPaths: { steering: "/tmp/my-project/.spec-workflow/steering", specs: [] },
    ...overrides,
  });

  const makeProjectConfig = (overrides: Partial<ProjectConfig> = {}): ProjectConfig => ({
    name: "my-project",
    path: "/tmp/my-project",
    specPaths: { steering: "/tmp/my-project/.spec-workflow/steering", specs: [] },
    lastUpdated: new Date().toISOString(),
    ...overrides,
  });

  describe("buildQueue()", () => {
    it("変更ログエントリからchange-basedタスク（priority:1）を生成できる", async () => {
      const queue = new TaskQueue(schedulerDir);
      const entries = [makeChangeEntry()];
      const configs: ProjectConfig[] = [];

      await queue.buildQueue(entries, configs);

      const status = await queue.getStatus();
      expect(status.pending).toBe(1);

      const task = await queue.dequeue();
      expect(task).not.toBeNull();
      expect(task!.type).toBe("change-based");
      expect(task!.priority).toBe(1);
      expect(task!.project).toBe("my-project");
      expect(task!.changedFiles).toEqual(["src/index.ts"]);
    });

    it("変更ログが空でlastUpdatedが7日以上前のプロジェクトからrotationタスク（priority:2）を生成できる", async () => {
      const queue = new TaskQueue(schedulerDir);

      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      const configs = [
        makeProjectConfig({ lastUpdated: eightDaysAgo }),
      ];

      await queue.buildQueue([], configs);

      const status = await queue.getStatus();
      expect(status.pending).toBe(1);

      const task = await queue.dequeue();
      expect(task).not.toBeNull();
      expect(task!.type).toBe("rotation");
      expect(task!.priority).toBe(2);
    });

    it("lastUpdatedが7日未満のプロジェクトからはrotationタスクを生成しない", async () => {
      const queue = new TaskQueue(schedulerDir);

      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      const configs = [
        makeProjectConfig({ lastUpdated: twoDaysAgo }),
      ];

      await queue.buildQueue([], configs);

      const status = await queue.getStatus();
      expect(status.pending).toBe(0);
    });

    it("既存のpendingタスクがあれば重複追加しない", async () => {
      const queue = new TaskQueue(schedulerDir);
      const entries = [makeChangeEntry()];

      await queue.buildQueue(entries, []);
      // 同じエントリで再度buildQueue
      await queue.buildQueue(entries, []);

      const status = await queue.getStatus();
      expect(status.pending).toBe(1);
    });
  });

  describe("dequeue()", () => {
    it("優先度が高い順にタスクを取り出す", async () => {
      const queue = new TaskQueue(schedulerDir);

      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

      // rotation (priority:2) を先にbuild
      await queue.buildQueue([], [
        makeProjectConfig({ name: "project-b", path: "/tmp/project-b", lastUpdated: eightDaysAgo }),
      ]);

      // change-based (priority:1) を後にbuild
      await queue.buildQueue(
        [makeChangeEntry({ project: "project-a", projectPath: "/tmp/project-a" })],
        [],
      );

      // priority:1 (change-based) が先に出る
      const first = await queue.dequeue();
      expect(first).not.toBeNull();
      expect(first!.type).toBe("change-based");
      expect(first!.priority).toBe(1);

      // 次にpriority:2 (rotation)
      const second = await queue.dequeue();
      expect(second).not.toBeNull();
      expect(second!.type).toBe("rotation");
      expect(second!.priority).toBe(2);
    });

    it("キューが空ならnullを返す", async () => {
      const queue = new TaskQueue(schedulerDir);

      const task = await queue.dequeue();

      expect(task).toBeNull();
    });

    it("dequeue時にstatusがin-progressに変更される", async () => {
      const queue = new TaskQueue(schedulerDir);
      await queue.buildQueue([makeChangeEntry()], []);

      const task = await queue.dequeue();
      expect(task).not.toBeNull();
      expect(task!.status).toBe("in-progress");

      // 再度dequeueするとnull（pendingがもうない）
      const next = await queue.dequeue();
      expect(next).toBeNull();
    });
  });

  describe("dequeueAll()", () => {
    it("全pendingタスクを一括取得し、全てin-progressに変更される", async () => {
      const queue = new TaskQueue(schedulerDir);
      await queue.buildQueue([
        makeChangeEntry({ timestamp: "2026-02-14T10:00:00+09:00", project: "p1", projectPath: "/tmp/p1" }),
        makeChangeEntry({ timestamp: "2026-02-14T11:00:00+09:00", project: "p2", projectPath: "/tmp/p2" }),
        makeChangeEntry({ timestamp: "2026-02-14T12:00:00+09:00", project: "p3", projectPath: "/tmp/p3" }),
      ], []);

      const tasks = await queue.dequeueAll();
      expect(tasks).toHaveLength(3);
      for (const task of tasks) {
        expect(task.status).toBe("in-progress");
      }

      // 再度dequeueAllすると空
      const empty = await queue.dequeueAll();
      expect(empty).toHaveLength(0);
    });

    it("キューが空なら空配列を返す", async () => {
      const queue = new TaskQueue(schedulerDir);

      const tasks = await queue.dequeueAll();
      expect(tasks).toHaveLength(0);
    });

    it("change-basedとrotationが混在していても全て取得できる", async () => {
      const queue = new TaskQueue(schedulerDir);
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

      await queue.buildQueue(
        [makeChangeEntry({ project: "p1", projectPath: "/tmp/p1" })],
        [makeProjectConfig({ name: "p2", path: "/tmp/p2", lastUpdated: eightDaysAgo })],
      );

      const tasks = await queue.dequeueAll();
      expect(tasks).toHaveLength(2);
      expect(tasks.map((t) => t.type).sort()).toEqual(["change-based", "rotation"]);
    });
  });

  describe("markComplete()", () => {
    it("タスクを完了にマークできる", async () => {
      const queue = new TaskQueue(schedulerDir);
      await queue.buildQueue([makeChangeEntry()], []);

      const task = await queue.dequeue();
      expect(task).not.toBeNull();

      await queue.markComplete(task!.id);

      const status = await queue.getStatus();
      expect(status.completed).toBe(1);
      expect(status.pending).toBe(0);
    });
  });

  describe("markFailed()", () => {
    it("タスクを失敗にマーク（error付き）できる", async () => {
      const queue = new TaskQueue(schedulerDir);
      await queue.buildQueue([makeChangeEntry()], []);

      const task = await queue.dequeue();
      expect(task).not.toBeNull();

      await queue.markFailed(task!.id, "Something went wrong");

      const status = await queue.getStatus();
      expect(status.failed).toBe(1);

      // ファイル内容を直接確認してerrorフィールドを検証
      const content = await readFile(join(schedulerDir, "queue.json"), "utf-8");
      const tasks: SchedulerTask[] = JSON.parse(content);
      const failedTask = tasks.find((t) => t.id === task!.id);
      expect(failedTask).toBeDefined();
      expect(failedTask!.error).toBe("Something went wrong");
      expect(failedTask!.status).toBe("failed");
    });
  });

  describe("getStatus()", () => {
    it("pending/completed/failedの件数を返す", async () => {
      const queue = new TaskQueue(schedulerDir);

      // 3つのchange-basedタスクを作成
      await queue.buildQueue([
        makeChangeEntry({ timestamp: "2026-02-14T10:00:00+09:00", project: "p1", projectPath: "/tmp/p1" }),
        makeChangeEntry({ timestamp: "2026-02-14T11:00:00+09:00", project: "p2", projectPath: "/tmp/p2" }),
        makeChangeEntry({ timestamp: "2026-02-14T12:00:00+09:00", project: "p3", projectPath: "/tmp/p3" }),
      ], []);

      // 1つをcomplete、1つをfailed
      const task1 = await queue.dequeue();
      await queue.markComplete(task1!.id);

      const task2 = await queue.dequeue();
      await queue.markFailed(task2!.id, "timeout");

      const status = await queue.getStatus();
      expect(status.pending).toBe(1);
      expect(status.completed).toBe(1);
      expect(status.failed).toBe(1);
    });

    it("キューファイルが存在しない場合、全て0を返す", async () => {
      const queue = new TaskQueue(schedulerDir);

      const status = await queue.getStatus();
      expect(status.pending).toBe(0);
      expect(status.completed).toBe(0);
      expect(status.failed).toBe(0);
    });
  });
});
