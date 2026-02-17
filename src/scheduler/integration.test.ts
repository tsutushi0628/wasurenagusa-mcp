import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { ChangeLogger } from "./change-logger.js";
import { TaskQueue } from "./task-queue.js";
import { PromptBuilder } from "./prompt-builder.js";
import type { ProjectConfig } from "../types.js";

describe("Scheduler Integration", () => {
  let schedulerDir: string;
  let projectDir: string;

  beforeEach(async () => {
    schedulerDir = await mkdtemp(join(tmpdir(), "wasurenagusa-integration-"));
    projectDir = await mkdtemp(join(tmpdir(), "wasurenagusa-project-"));
    // .gitディレクトリをシミュレート
    await mkdir(join(projectDir, ".git"));
    // .spec-workflowディレクトリをシミュレート
    await mkdir(join(projectDir, ".spec-workflow", "steering"), { recursive: true });
    await mkdir(join(projectDir, ".spec-workflow", "specs", "feature-a"), { recursive: true });
  });

  afterEach(async () => {
    await rm(schedulerDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  describe("フロー1: 変更ログ記録 → キュービルド → タスク取得 → プロンプト生成", () => {
    it("一連のフローが正常に動作する", async () => {
      // 1. 変更ログを直接作成（git diffのモックの代わりにデータを直接挿入）
      const changeLogger = new ChangeLogger(schedulerDir);
      const changeLogPath = join(schedulerDir, "change-log.json");
      await writeFile(changeLogPath, JSON.stringify([
        {
          timestamp: new Date().toISOString(),
          project: "test-project",
          projectPath: projectDir,
          changedFiles: ["src/api/handler.ts", "src/models/user.ts"],
          specPaths: {
            steering: join(projectDir, ".spec-workflow", "steering"),
            specs: [join(projectDir, ".spec-workflow", "specs", "feature-a")],
          },
        },
      ]));

      // 2. エントリを取得できることを確認
      const entries = await changeLogger.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].changedFiles).toEqual(["src/api/handler.ts", "src/models/user.ts"]);

      // 3. TaskQueueでキュービルド
      const taskQueue = new TaskQueue(schedulerDir);
      await taskQueue.buildQueue(entries, []);

      const status = await taskQueue.getStatus();
      expect(status.pending).toBe(1);

      // 4. dequeueでタスク取得
      const task = await taskQueue.dequeue();
      expect(task).not.toBeNull();
      expect(task!.type).toBe("change-based");
      expect(task!.priority).toBe(1);
      expect(task!.changedFiles).toEqual(["src/api/handler.ts", "src/models/user.ts"]);

      // 5. PromptBuilderでプロンプト生成
      const promptBuilder = new PromptBuilder();
      const prompt = await promptBuilder.buildChangeBasedPrompt(task!);
      expect(prompt).toContain("test-project");
      expect(prompt).toContain("src/api/handler.ts");
      expect(prompt).toContain("src/models/user.ts");

      // 6. 変更ログのconsumeEntry
      await changeLogger.consumeEntry(entries[0].timestamp);
      const remainingEntries = await changeLogger.getEntries();
      expect(remainingEntries).toHaveLength(0);

      // 7. タスク完了マーク
      await taskQueue.markComplete(task!.id);
      const finalStatus = await taskQueue.getStatus();
      expect(finalStatus.completed).toBe(1);
      expect(finalStatus.pending).toBe(0);
    });
  });

  describe("フロー2: 変更ログなし → ローテーションタスク生成", () => {
    it("lastUpdatedが古いプロジェクトからrotationタスクを生成する", async () => {
      const taskQueue = new TaskQueue(schedulerDir);

      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      const configs: ProjectConfig[] = [
        {
          name: "stale-project",
          path: projectDir,
          specPaths: {
            steering: join(projectDir, ".spec-workflow", "steering"),
            specs: [join(projectDir, ".spec-workflow", "specs", "feature-a")],
          },
          lastUpdated: tenDaysAgo,
        },
      ];

      // 変更ログなし、プロジェクト設定のみ
      await taskQueue.buildQueue([], configs);

      const status = await taskQueue.getStatus();
      expect(status.pending).toBe(1);

      const task = await taskQueue.dequeue();
      expect(task).not.toBeNull();
      expect(task!.type).toBe("rotation");
      expect(task!.priority).toBe(2);

      // ローテーション用プロンプト生成
      const promptBuilder = new PromptBuilder();
      const prompt = await promptBuilder.buildRotationPrompt(task!);
      expect(prompt).toContain("stale-project");
    });
  });

  describe("フロー3: タスクなし → キューが空", () => {
    it("変更もローテーション対象もなければキューは空", async () => {
      const taskQueue = new TaskQueue(schedulerDir);

      const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
      const configs: ProjectConfig[] = [
        {
          name: "fresh-project",
          path: projectDir,
          specPaths: { steering: "", specs: [] },
          lastUpdated: oneDayAgo,
        },
      ];

      await taskQueue.buildQueue([], configs);

      const status = await taskQueue.getStatus();
      expect(status.pending).toBe(0);

      const task = await taskQueue.dequeue();
      expect(task).toBeNull();
    });
  });

  describe("フロー4: 優先度順のタスク処理", () => {
    it("change-based(1) → rotation(2) の順でdequeueされる", async () => {
      const taskQueue = new TaskQueue(schedulerDir);

      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

      // rotation を先に追加
      await taskQueue.buildQueue([], [
        {
          name: "rotation-project",
          path: "/tmp/rotation",
          specPaths: { steering: "/tmp/rotation/.spec-workflow/steering", specs: [] },
          lastUpdated: tenDaysAgo,
        },
      ]);

      // 次に change-based を追加
      await taskQueue.buildQueue(
        [
          {
            timestamp: new Date().toISOString(),
            project: "changed-project",
            projectPath: "/tmp/changed",
            changedFiles: ["src/main.ts"],
            specPaths: { steering: "/tmp/changed/.spec-workflow/steering", specs: [] },
          },
        ],
        [],
      );

      // change-based (priority 1) が先
      const first = await taskQueue.dequeue();
      expect(first).not.toBeNull();
      expect(first!.type).toBe("change-based");

      // rotation (priority 2) が後
      const second = await taskQueue.dequeue();
      expect(second).not.toBeNull();
      expect(second!.type).toBe("rotation");

      // これ以上はなし
      const third = await taskQueue.dequeue();
      expect(third).toBeNull();
    });
  });

  describe("フロー5: タスク失敗のハンドリング", () => {
    it("失敗タスクはfailed状態になりエラーが記録される", async () => {
      const taskQueue = new TaskQueue(schedulerDir);

      await taskQueue.buildQueue(
        [
          {
            timestamp: new Date().toISOString(),
            project: "fail-project",
            projectPath: "/tmp/fail",
            changedFiles: ["src/broken.ts"],
            specPaths: { steering: "", specs: [] },
          },
        ],
        [],
      );

      const task = await taskQueue.dequeue();
      expect(task).not.toBeNull();

      await taskQueue.markFailed(task!.id, "Claude CLI timeout after 600000ms");

      const status = await taskQueue.getStatus();
      expect(status.failed).toBe(1);
      expect(status.pending).toBe(0);
    });
  });
});
