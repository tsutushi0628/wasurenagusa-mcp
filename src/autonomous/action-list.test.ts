import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { ActionList } from "./action-list.js";
import type { HumanActionItem } from "../types.js";

describe("ActionList", () => {
  let schedulerDir: string;

  beforeEach(async () => {
    schedulerDir = await mkdtemp(join(tmpdir(), "wasurenagusa-actionlist-"));
  });

  afterEach(async () => {
    await rm(schedulerDir, { recursive: true, force: true });
  });

  const makeItem = (overrides: Partial<HumanActionItem> = {}): HumanActionItem => ({
    taskId: "task-1",
    project: "test-project",
    what: "テストタスク",
    reason: "リトライ上限",
    createdAt: new Date().toISOString(),
    source: "retry-limit",
    ...overrides,
  });

  describe("add()", () => {
    it("アクションアイテムを正常に追加する", async () => {
      const list = new ActionList(schedulerDir);
      await list.add(makeItem());

      const items = await list.getAll();
      expect(items.length).toBe(1);
      expect(items[0].taskId).toBe("task-1");
    });

    it("複数アイテムを追加できる", async () => {
      const list = new ActionList(schedulerDir);
      await list.add(makeItem({ taskId: "task-1" }));
      await list.add(makeItem({ taskId: "task-2", project: "other-project" }));

      const items = await list.getAll();
      expect(items.length).toBe(2);
    });
  });

  describe("getAll()", () => {
    it("ファイルが存在しない場合は空配列を返す", async () => {
      const list = new ActionList(schedulerDir);
      const items = await list.getAll();
      expect(items).toEqual([]);
    });
  });

  describe("resolve()", () => {
    it("指定taskIdのアイテムをリストから除去する", async () => {
      const list = new ActionList(schedulerDir);
      await list.add(makeItem({ taskId: "task-1" }));
      await list.add(makeItem({ taskId: "task-2" }));

      await list.resolve("task-1");

      const items = await list.getAll();
      expect(items.length).toBe(1);
      expect(items[0].taskId).toBe("task-2");
    });

    it("存在しないtaskIdでも安全に動作する", async () => {
      const list = new ActionList(schedulerDir);
      await list.add(makeItem());

      await list.resolve("nonexistent");

      const items = await list.getAll();
      expect(items.length).toBe(1);
    });
  });
});
