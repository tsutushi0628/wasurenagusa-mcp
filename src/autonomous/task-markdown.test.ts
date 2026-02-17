import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { TaskMarkdownAdapter } from "./task-markdown.js";

describe("TaskMarkdownAdapter", () => {
  let tempDir: string;
  let filePath: string;
  let adapter: TaskMarkdownAdapter;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "wasurenagusa-taskmd-"));
    filePath = join(tempDir, "tasks.md");
    adapter = new TaskMarkdownAdapter(filePath);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("parse", () => {
    it("基本的なタスクをパースする", () => {
      const content = `# Tasks

## オンボーディング追加
- project: my-app
- why: 離脱率が高い
- what: オンボーディングフロー実装
- done: E2Eテスト通過
`;
      const tasks = adapter.parse(content);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].title).toBe("オンボーディング追加");
      expect(tasks[0].project).toBe("my-app");
      expect(tasks[0].why).toBe("離脱率が高い");
      expect(tasks[0].what).toBe("オンボーディングフロー実装");
      expect(tasks[0].done).toBe("E2Eテスト通過");
      expect(tasks[0].status).toBe("pending");
    });

    it("複数タスクをパースする", () => {
      const content = `# Tasks

## タスク1
- project: app-a
- why: 理由1
- what: 作業1
- done: 条件1

## タスク2
- project: app-b
- why: 理由2
- what: 作業2
- done: 条件2
`;
      const tasks = adapter.parse(content);
      expect(tasks).toHaveLength(2);
      expect(tasks[0].what).toBe("作業1");
      expect(tasks[1].what).toBe("作業2");
    });

    it("順序不問でパースできる", () => {
      const content = `## テスト
- done: テスト通過
- what: テスト実装
- project: test-proj
- why: 品質向上
`;
      const tasks = adapter.parse(content);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].project).toBe("test-proj");
      expect(tasks[0].what).toBe("テスト実装");
    });

    it("status指定があれば反映する", () => {
      const content = `## 完了タスク
- project: my-app
- why: 理由
- what: 作業
- done: 条件
- status: completed
`;
      const tasks = adapter.parse(content);
      expect(tasks[0].status).toBe("completed");
    });

    it("無効なstatusは無視してpendingになる", () => {
      const content = `## タスク
- project: my-app
- why: 理由
- what: 作業
- done: 条件
- status: invalid-status
`;
      const tasks = adapter.parse(content);
      expect(tasks[0].status).toBe("pending");
    });

    it("4必須項目が欠けたブロックはスキップする", () => {
      const content = `## 不完全タスク
- project: my-app
- why: 理由のみ

## 完全タスク
- project: my-app
- why: 理由
- what: 作業
- done: 条件
`;
      const tasks = adapter.parse(content);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].title).toBe("完全タスク");
    });

    it("未知のキーは無視する", () => {
      const content = `## タスク
- project: my-app
- why: 理由
- what: 作業
- done: 条件
- memo: これは備忘録
- priority: high
`;
      const tasks = adapter.parse(content);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].what).toBe("作業");
    });

    it("空行が混入しても壊れない", () => {
      const content = `## タスク

- project: my-app

- why: 理由

- what: 作業
- done: 条件

`;
      const tasks = adapter.parse(content);
      expect(tasks).toHaveLength(1);
    });

    it("H1見出しやコメントは無視する", () => {
      const content = `# Tasks

<!-- テンプレート -->
<!--
## テンプレート
- project: xxx
-->

## 実タスク
- project: my-app
- why: 理由
- what: 作業
- done: 条件
`;
      const tasks = adapter.parse(content);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].title).toBe("実タスク");
    });

    it("error/reasonフィールドを読み取る", () => {
      const content = `## 失敗タスク
- project: my-app
- why: 理由
- what: 作業
- done: 条件
- status: failed
- error: Exit code: 1
`;
      const tasks = adapter.parse(content);
      expect(tasks[0].status).toBe("failed");
      expect(tasks[0].error).toBe("Exit code: 1");
    });

    it("コロン後スペース無しでもパースできる", () => {
      const content = `## タスク
- project:my-app
- why:理由
- what:作業
- done:条件
`;
      const tasks = adapter.parse(content);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].project).toBe("my-app");
    });
  });

  describe("readTasks", () => {
    it("ファイルが存在しない場合は空配列を返す", async () => {
      const tasks = await adapter.readTasks();
      expect(tasks).toEqual([]);
    });

    it("ファイルからタスクを読み込む", async () => {
      await writeFile(filePath, `## テスト
- project: test
- why: テスト
- what: テスト実装
- done: テスト通過
`);
      const tasks = await adapter.readTasks();
      expect(tasks).toHaveLength(1);
    });
  });

  describe("readPendingTasks", () => {
    it("pendingのみ返す", async () => {
      await writeFile(filePath, `## 完了
- project: app
- why: 理由
- what: 完了タスク
- done: 条件
- status: completed

## 待機中
- project: app
- why: 理由
- what: 待機タスク
- done: 条件
`);
      const pending = await adapter.readPendingTasks();
      expect(pending).toHaveLength(1);
      expect(pending[0].what).toBe("待機タスク");
    });
  });

  describe("updateStatus", () => {
    it("status行を追記する", async () => {
      await writeFile(filePath, `## タスク
- project: my-app
- why: 理由
- what: 作業
- done: 条件
`);
      const result = await adapter.updateStatus("作業", "my-app", "in-progress");
      expect(result).toBe(true);

      const content = await readFile(filePath, "utf-8");
      expect(content).toContain("- status: in-progress");
    });

    it("既存のstatus行を上書きする", async () => {
      await writeFile(filePath, `## タスク
- project: my-app
- why: 理由
- what: 作業
- done: 条件
- status: in-progress
`);
      const result = await adapter.updateStatus("作業", "my-app", "completed");
      expect(result).toBe(true);

      const content = await readFile(filePath, "utf-8");
      expect(content).toContain("- status: completed");
      expect(content).not.toContain("- status: in-progress");
    });

    it("error/reason付きで更新する", async () => {
      await writeFile(filePath, `## タスク
- project: my-app
- why: 理由
- what: 作業
- done: 条件
`);
      await adapter.updateStatus("作業", "my-app", "failed", { error: "Exit code: 1" });

      const content = await readFile(filePath, "utf-8");
      expect(content).toContain("- status: failed");
      expect(content).toContain("- error: Exit code: 1");
    });

    it("マッチしないタスクはfalseを返す", async () => {
      await writeFile(filePath, `## タスク
- project: my-app
- why: 理由
- what: 作業
- done: 条件
`);
      const result = await adapter.updateStatus("存在しない", "my-app", "completed");
      expect(result).toBe(false);
    });

    it("ファイルが存在しない場合はfalseを返す", async () => {
      const result = await adapter.updateStatus("作業", "my-app", "completed");
      expect(result).toBe(false);
    });

    it("他のタスクに影響を与えない", async () => {
      await writeFile(filePath, `## タスク1
- project: app-a
- why: 理由1
- what: 作業1
- done: 条件1

## タスク2
- project: app-b
- why: 理由2
- what: 作業2
- done: 条件2
`);
      await adapter.updateStatus("作業1", "app-a", "completed");

      const tasks = adapter.parse(await readFile(filePath, "utf-8"));
      expect(tasks[0].status).toBe("completed");
      expect(tasks[1].status).toBe("pending");
    });
  });

  describe("toSubmitParams", () => {
    it("MarkdownTaskからTaskSubmitParamsに変換する", () => {
      const mdTask = {
        title: "テスト",
        project: "my-app",
        why: "理由",
        what: "作業",
        done: "条件",
        status: "pending" as const,
        lineStart: 0,
        lineEnd: 5,
      };
      const params = TaskMarkdownAdapter.toSubmitParams(mdTask);
      expect(params).toEqual({
        why: "理由",
        what: "作業",
        done: "条件",
        project: "my-app",
      });
    });
  });
});
