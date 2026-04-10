import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { TaskStore } from "./task-store.js";
import type { AutonomousTask, TaskSubmitParams } from "../types.js";

describe("TaskStore", () => {
  let schedulerDir: string;

  beforeEach(async () => {
    schedulerDir = await mkdtemp(join(tmpdir(), "wasurenagusa-taskstore-"));
  });

  afterEach(async () => {
    await rm(schedulerDir, { recursive: true, force: true });
  });

  const makeParams = (overrides: Partial<TaskSubmitParams> = {}): TaskSubmitParams => ({
    why: "テスト目的",
    what: "テストタスク実行",
    done: "テストが通ること",
    project: "test-project",
    ...overrides,
  });

  describe("submit()", () => {
    it("正常にタスクを投入でき、UUIDが付与される", async () => {
      const store = new TaskStore(schedulerDir);
      const task = await store.submit(makeParams(), "/tmp/test-project");

      expect(task.id).toBeDefined();
      expect(task.id.length).toBeGreaterThan(0);
      expect(task.status).toBe("pending");
      expect(task.priority).toBe(0);
      expect(task.retryCount).toBe(0);
      expect(task.evaluationHistory).toEqual([]);
    });

    it("同一project + what + status=pendingで重複投入を拒否する", async () => {
      const store = new TaskStore(schedulerDir);
      await store.submit(makeParams(), "/tmp/test-project");

      await expect(
        store.submit(makeParams(), "/tmp/test-project"),
      ).rejects.toThrow("Duplicate task");
    });

    it("異なるprojectなら同じwhatでも投入できる", async () => {
      const store = new TaskStore(schedulerDir);
      await store.submit(makeParams(), "/tmp/test-project");

      const task2 = await store.submit(
        makeParams({ project: "other-project" }),
        "/tmp/other-project",
      );
      expect(task2.id).toBeDefined();
    });

    it("異なるwhatなら同じprojectでも投入できる", async () => {
      const store = new TaskStore(schedulerDir);
      await store.submit(makeParams(), "/tmp/test-project");

      const task2 = await store.submit(
        makeParams({ what: "別のタスク" }),
        "/tmp/test-project",
      );
      expect(task2.id).toBeDefined();
    });
  });

  describe("dequeue()", () => {
    it("priority昇順→createdAt昇順で最優先pendingタスクを取得する", async () => {
      const store = new TaskStore(schedulerDir);
      await store.submit(makeParams({ what: "task-1" }), "/tmp/test");
      await store.submit(makeParams({ what: "task-2" }), "/tmp/test");

      const task = await store.dequeue();
      expect(task).not.toBeNull();
      expect(task!.what).toBe("task-1");
      expect(task!.status).toBe("in-progress");
    });

    it("dequeue後はpendingから除外される（status=in-progress）", async () => {
      const store = new TaskStore(schedulerDir);
      await store.submit(makeParams(), "/tmp/test");

      await store.dequeue();
      const second = await store.dequeue();
      expect(second).toBeNull();
    });

    it("空キュー時はnullを返す", async () => {
      const store = new TaskStore(schedulerDir);
      const task = await store.dequeue();
      expect(task).toBeNull();
    });
  });

  describe("markCompleted()", () => {
    it("タスクのstatusをcompletedに変更する", async () => {
      const store = new TaskStore(schedulerDir);
      const task = await store.submit(makeParams(), "/tmp/test");
      await store.dequeue();

      await store.markCompleted(task.id);

      const status = await store.getStatus();
      expect(status.summary.completed).toBe(1);
      expect(status.summary.inProgress).toBe(0);
    });
  });

  describe("markFailed()", () => {
    it("タスクのstatusをfailedに変更しerrorを記録する", async () => {
      const store = new TaskStore(schedulerDir);
      const task = await store.submit(makeParams(), "/tmp/test");
      await store.dequeue();

      await store.markFailed(task.id, "Exit code: 1");

      const status = await store.getStatus();
      expect(status.summary.failed).toBe(1);
    });
  });

  describe("markHumanRequired()", () => {
    it("タスクのstatusをhuman-requiredに変更しreasonを記録する", async () => {
      const store = new TaskStore(schedulerDir);
      const task = await store.submit(makeParams(), "/tmp/test");
      await store.dequeue();

      await store.markHumanRequired(task.id, "事業判断が必要");

      const status = await store.getStatus();
      expect(status.summary.humanRequired).toBe(1);
    });
  });

  describe("incrementRetry()", () => {
    it("retryCountを増加させ、statusをpendingに戻す", async () => {
      const store = new TaskStore(schedulerDir);
      const task = await store.submit(makeParams(), "/tmp/test");
      await store.dequeue();

      const updated = await store.incrementRetry(task.id);
      expect(updated.retryCount).toBe(1);
      expect(updated.status).toBe("pending");
    });

    it("存在しないtaskIdでエラーを投げる", async () => {
      const store = new TaskStore(schedulerDir);
      await expect(store.incrementRetry("nonexistent")).rejects.toThrow("Task not found");
    });
  });

  describe("resolveAction()", () => {
    it("retry: statusをpendingに変更する", async () => {
      const store = new TaskStore(schedulerDir);
      const task = await store.submit(makeParams(), "/tmp/test");
      await store.dequeue();
      await store.markHumanRequired(task.id, "要判断");

      await store.resolveAction(task.id, "retry");

      const status = await store.getStatus();
      expect(status.summary.pending).toBe(1);
    });

    it("complete: statusをcompletedに変更しcompletedAtを設定する", async () => {
      const store = new TaskStore(schedulerDir);
      const task = await store.submit(makeParams(), "/tmp/test");
      await store.dequeue();
      await store.markHumanRequired(task.id, "要判断");

      await store.resolveAction(task.id, "complete");

      const status = await store.getStatus();
      expect(status.summary.completed).toBe(1);
    });

    it("cancel: statusをcancelledに変更する", async () => {
      const store = new TaskStore(schedulerDir);
      const task = await store.submit(makeParams(), "/tmp/test");
      await store.dequeue();
      await store.markHumanRequired(task.id, "要判断");

      await store.resolveAction(task.id, "cancel");

      const status = await store.getStatus();
      expect(status.summary.cancelled).toBe(1);
    });

    it("存在しないtaskIdでエラーを投げる", async () => {
      const store = new TaskStore(schedulerDir);
      await expect(store.resolveAction("nonexistent", "retry")).rejects.toThrow("Task not found");
    });
  });

  describe("getStatus()", () => {
    it("サマリ集計と直近20件を返す", async () => {
      const store = new TaskStore(schedulerDir);
      await store.submit(makeParams({ what: "task-1" }), "/tmp/test");
      await store.submit(makeParams({ what: "task-2" }), "/tmp/test");

      const status = await store.getStatus();
      expect(status.summary.pending).toBe(2);
      expect(status.recentTasks.length).toBe(2);
    });
  });

  describe("addEvaluation()", () => {
    it("評価履歴を追加する", async () => {
      const store = new TaskStore(schedulerDir);
      const task = await store.submit(makeParams(), "/tmp/test");

      await store.addEvaluation(task.id, {
        timestamp: new Date().toISOString(),
        result: "ng",
        reason: "テスト失敗",
        executionDurationMs: 5000,
      });

      // ファイル内容を直接確認
      const content = await readFile(join(schedulerDir, "autonomous-tasks.json"), "utf-8");
      const tasks: AutonomousTask[] = JSON.parse(content);
      const updated = tasks.find((t) => t.id === task.id);
      expect(updated!.evaluationHistory.length).toBe(1);
      expect(updated!.evaluationHistory[0].result).toBe("ng");
    });
  });

  describe("requeueTask()", () => {
    it("in-progressのタスクをpendingに戻す", async () => {
      const store = new TaskStore(schedulerDir);
      const task = await store.submit(makeParams(), "/tmp/test");
      await store.dequeue(); // in-progressになる

      await store.requeueTask(task.id);

      const status = await store.getStatus();
      expect(status.summary.pending).toBe(1);
      expect(status.summary.inProgress).toBe(0);
    });

    it("存在しないtaskIdでエラーを投げる", async () => {
      const store = new TaskStore(schedulerDir);
      await expect(store.requeueTask("nonexistent")).rejects.toThrow("Task not found");
    });

    it("in-progress以外のステータスでエラーを投げる", async () => {
      const store = new TaskStore(schedulerDir);
      const task = await store.submit(makeParams(), "/tmp/test");
      // pendingのまま
      await expect(store.requeueTask(task.id)).rejects.toThrow("Task is not in-progress");
    });
  });

  describe("recoverInProgress()", () => {
    it("in-progressのタスクをfailedに復旧する", async () => {
      const store = new TaskStore(schedulerDir);
      await store.submit(makeParams(), "/tmp/test");
      await store.dequeue(); // in-progressになる

      const recovered = await store.recoverInProgress();
      expect(recovered).toBe(1);

      const status = await store.getStatus();
      expect(status.summary.failed).toBe(1);
      expect(status.summary.inProgress).toBe(0);
    });

    it("in-progressタスクがなければ0を返す", async () => {
      const store = new TaskStore(schedulerDir);
      await store.submit(makeParams(), "/tmp/test");

      const recovered = await store.recoverInProgress();
      expect(recovered).toBe(0);
    });
  });

  describe("setGeneratedCommand()", () => {
    it("生成された命令文を記録する", async () => {
      const store = new TaskStore(schedulerDir);
      const task = await store.submit(makeParams(), "/tmp/test");

      await store.setGeneratedCommand(task.id, "テスト命令文");

      const content = await readFile(join(schedulerDir, "autonomous-tasks.json"), "utf-8");
      const tasks: AutonomousTask[] = JSON.parse(content);
      const updated = tasks.find((t) => t.id === task.id);
      expect(updated!.generatedCommand).toBe("テスト命令文");
    });
  });
});
