import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { TaskStore } from "./task-store.js";
import { ActionList } from "./action-list.js";
import { MAX_RETRY_COUNT } from "./constants.js";
import type { TaskSubmitParams } from "../types.js";

/**
 * オーケストレーション統合テスト
 * 各モジュールを組み合わせた全体フローを検証する。
 * CommandGenerator/TaskEvaluator/Executorは本テストでは直接使用せず、
 * TaskStoreとActionListの状態遷移に集中する。
 */
describe("Orchestration Integration", () => {
  let schedulerDir: string;

  beforeEach(async () => {
    schedulerDir = await mkdtemp(join(tmpdir(), "wasurenagusa-orchestration-"));
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

  describe("正常フロー: submit → dequeue → completed", () => {
    it("タスク投入→取得→命令文記録→評価OK→完了の全体フロー", async () => {
      const store = new TaskStore(schedulerDir);

      // 1. submit
      const task = await store.submit(makeParams(), "/tmp/test");
      expect(task.status).toBe("pending");

      // 2. dequeue
      const dequeued = await store.dequeue();
      expect(dequeued).not.toBeNull();
      expect(dequeued!.status).toBe("in-progress");

      // 3. setGeneratedCommand（命令文生成後に記録）
      await store.setGeneratedCommand(dequeued!.id, "テスト命令文");

      // 4. 評価OK記録
      await store.addEvaluation(dequeued!.id, {
        timestamp: new Date().toISOString(),
        result: "ok",
        reason: "全Done条件クリア",
        executionDurationMs: 5000,
      });

      // 5. markCompleted
      await store.markCompleted(dequeued!.id);

      // 検証
      const status = await store.getStatus();
      expect(status.summary.completed).toBe(1);
      expect(status.summary.pending).toBe(0);
      expect(status.summary.inProgress).toBe(0);
    });
  });

  describe("NGフロー: 3回NG → human-required", () => {
    it("NG判定がMAX_RETRY_COUNT回に到達するとhuman-requiredに遷移する", async () => {
      const store = new TaskStore(schedulerDir);
      const actionList = new ActionList(schedulerDir);

      const task = await store.submit(makeParams(), "/tmp/test");

      for (let attempt = 0; attempt < MAX_RETRY_COUNT; attempt++) {
        // dequeue
        const dequeued = await store.dequeue();
        expect(dequeued).not.toBeNull();
        expect(dequeued!.status).toBe("in-progress");

        // 評価NG記録
        await store.addEvaluation(dequeued!.id, {
          timestamp: new Date().toISOString(),
          result: "ng",
          reason: `テスト失敗 (試行${attempt + 1})`,
          suggestion: "テストを修正",
          executionDurationMs: 3000,
        });

        // incrementRetry → statusがpendingに戻る
        const updated = await store.incrementRetry(dequeued!.id);

        if (updated.retryCount >= MAX_RETRY_COUNT) {
          // 上限到達 → human-required
          const reason = `${MAX_RETRY_COUNT}回リトライ上限到達`;
          await store.markHumanRequired(dequeued!.id, reason);
          await actionList.add({
            taskId: dequeued!.id,
            project: dequeued!.project,
            what: dequeued!.what,
            reason,
            createdAt: new Date().toISOString(),
            source: "retry-limit",
          });
        }
      }

      // 検証: human-requiredになっている
      const status = await store.getStatus();
      expect(status.summary.humanRequired).toBe(1);
      expect(status.summary.pending).toBe(0);

      // アクションリストに登録されている
      const actions = await actionList.getAll();
      expect(actions.length).toBe(1);
      expect(actions[0].source).toBe("retry-limit");
    });
  });

  describe("human-requiredフロー: 評価者がhuman-required判定", () => {
    it("評価者のhuman-required判定→アクションリスト登録", async () => {
      const store = new TaskStore(schedulerDir);
      const actionList = new ActionList(schedulerDir);

      const task = await store.submit(makeParams(), "/tmp/test");
      const dequeued = await store.dequeue();

      // 評価human-required
      await store.addEvaluation(dequeued!.id, {
        timestamp: new Date().toISOString(),
        result: "human-required",
        reason: "ライセンス選択が必要",
        executionDurationMs: 10000,
      });

      await store.markHumanRequired(dequeued!.id, "ライセンス選択が必要");
      await actionList.add({
        taskId: dequeued!.id,
        project: dequeued!.project,
        what: dequeued!.what,
        reason: "ライセンス選択が必要",
        createdAt: new Date().toISOString(),
        source: "evaluation",
      });

      // 検証
      const status = await store.getStatus();
      expect(status.summary.humanRequired).toBe(1);

      const actions = await actionList.getAll();
      expect(actions.length).toBe(1);
      expect(actions[0].source).toBe("evaluation");
    });
  });

  describe("resolveAction フロー", () => {
    it("human-required → retry でpendingに戻り再実行可能になる", async () => {
      const store = new TaskStore(schedulerDir);
      const actionList = new ActionList(schedulerDir);

      const task = await store.submit(makeParams(), "/tmp/test");
      const dequeued = await store.dequeue();
      await store.markHumanRequired(dequeued!.id, "要判断");
      await actionList.add({
        taskId: dequeued!.id,
        project: dequeued!.project,
        what: dequeued!.what,
        reason: "要判断",
        createdAt: new Date().toISOString(),
        source: "evaluation",
      });

      // resolve: retry
      await store.resolveAction(dequeued!.id, "retry");
      await actionList.resolve(dequeued!.id);

      // 検証: pendingに戻っている
      const status = await store.getStatus();
      expect(status.summary.pending).toBe(1);
      expect(status.summary.humanRequired).toBe(0);

      // アクションリストから除去されている
      const actions = await actionList.getAll();
      expect(actions.length).toBe(0);

      // 再dequeueが可能
      const reDequeued = await store.dequeue();
      expect(reDequeued).not.toBeNull();
    });

    it("human-required → cancel でcancelledになる", async () => {
      const store = new TaskStore(schedulerDir);

      const task = await store.submit(makeParams(), "/tmp/test");
      const dequeued = await store.dequeue();
      await store.markHumanRequired(dequeued!.id, "要判断");

      await store.resolveAction(dequeued!.id, "cancel");

      const status = await store.getStatus();
      expect(status.summary.cancelled).toBe(1);
    });
  });

  describe("クラッシュ復旧フロー", () => {
    it("in-progressのタスクがrecoverInProgressでfailedに復旧される", async () => {
      const store = new TaskStore(schedulerDir);

      await store.submit(makeParams({ what: "task-1" }), "/tmp/test");
      await store.submit(makeParams({ what: "task-2" }), "/tmp/test");

      // 1つをin-progressにする
      await store.dequeue();

      // 新しいTaskStoreインスタンス（再起動をシミュレート）
      const newStore = new TaskStore(schedulerDir);
      const recovered = await newStore.recoverInProgress();
      expect(recovered).toBe(1);

      const status = await newStore.getStatus();
      expect(status.summary.failed).toBe(1);
      expect(status.summary.pending).toBe(1);
      expect(status.summary.inProgress).toBe(0);
    });
  });

  describe("タスク優先度とキュー順序", () => {
    it("複数タスクがある場合、createdAt昇順でdequeueされる", async () => {
      const store = new TaskStore(schedulerDir);

      await store.submit(makeParams({ what: "first-task" }), "/tmp/test");
      await store.submit(makeParams({ what: "second-task" }), "/tmp/test");

      const first = await store.dequeue();
      expect(first!.what).toBe("first-task");

      await store.markCompleted(first!.id);

      const second = await store.dequeue();
      expect(second!.what).toBe("second-task");
    });
  });
});
