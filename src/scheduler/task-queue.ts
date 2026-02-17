import { randomUUID } from "crypto";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import type {
  SchedulerTask,
  TaskType,
  TaskStatus,
  ChangeLogEntry,
  ProjectConfig,
  SpecPaths,
} from "../types.js";

const ROTATION_THRESHOLD_DAYS = 7;

export class TaskQueue {
  private queuePath: string;

  constructor(schedulerDir: string) {
    this.queuePath = join(schedulerDir, "queue.json");
  }

  /**
   * 変更ログ + プロジェクト設定からタスクキューを構築
   * 既存のpendingタスクがあれば重複追加しない
   */
  async buildQueue(
    changeEntries: ChangeLogEntry[],
    projectConfigs: ProjectConfig[],
  ): Promise<void> {
    const tasks = await this.loadTasks();

    // change-basedタスクの追加（重複チェック付き）
    for (const entry of changeEntries) {
      const isDuplicate = tasks.some(
        (t) =>
          t.status === "pending" &&
          t.type === "change-based" &&
          t.project === entry.project &&
          JSON.stringify(t.changedFiles) === JSON.stringify(entry.changedFiles),
      );
      if (!isDuplicate) {
        tasks.push(this.createTask("change-based", 1, entry.project, entry.projectPath, entry.specPaths, entry.changedFiles));
      }
    }

    // rotationタスクの追加（7日以上更新なしのプロジェクト）
    const now = Date.now();
    for (const config of projectConfigs) {
      if (!config.lastUpdated) {
        continue;
      }
      const lastUpdatedMs = new Date(config.lastUpdated).getTime();
      const daysSinceUpdate = (now - lastUpdatedMs) / (1000 * 60 * 60 * 24);

      if (daysSinceUpdate >= ROTATION_THRESHOLD_DAYS) {
        const isDuplicate = tasks.some(
          (t) =>
            t.status === "pending" &&
            t.type === "rotation" &&
            t.project === config.name,
        );
        if (!isDuplicate) {
          tasks.push(this.createTask("rotation", 2, config.name, config.path, config.specPaths));
        }
      }
    }

    await this.saveTasks(tasks);
  }

  /**
   * 最も優先度の高いpendingタスクを取り出す（statusをin-progressに変更）
   */
  async dequeue(): Promise<SchedulerTask | null> {
    const tasks = await this.loadTasks();

    const pendingTasks = tasks.filter((t) => t.status === "pending");
    if (pendingTasks.length === 0) {
      return null;
    }

    // 優先度が低い数値ほど高優先（priority:1 > priority:2 > priority:3）
    pendingTasks.sort((a, b) => a.priority - b.priority);
    const selected = pendingTasks[0];

    // statusをin-progressに変更
    const taskInQueue = tasks.find((t) => t.id === selected.id);
    if (taskInQueue) {
      taskInQueue.status = "in-progress";
    }

    await this.saveTasks(tasks);

    return { ...selected, status: "in-progress" };
  }

  /**
   * 全pendingタスクを取り出す（全てin-progressに変更）
   */
  async dequeueAll(): Promise<SchedulerTask[]> {
    const tasks = await this.loadTasks();

    const pendingTasks = tasks.filter((t) => t.status === "pending");
    if (pendingTasks.length === 0) {
      return [];
    }

    // 全pendingをin-progressに変更
    for (const pending of pendingTasks) {
      const taskInQueue = tasks.find((t) => t.id === pending.id);
      if (taskInQueue) {
        taskInQueue.status = "in-progress";
      }
    }

    await this.saveTasks(tasks);

    return pendingTasks.map((t) => ({ ...t, status: "in-progress" as TaskStatus }));
  }

  /**
   * タスクを完了マーク
   */
  async markComplete(taskId: string): Promise<void> {
    const tasks = await this.loadTasks();
    const task = tasks.find((t) => t.id === taskId);
    if (task) {
      task.status = "completed";
      task.completedAt = new Date().toISOString();
    }
    await this.saveTasks(tasks);
  }

  /**
   * タスクを失敗マーク
   */
  async markFailed(taskId: string, error: string): Promise<void> {
    const tasks = await this.loadTasks();
    const task = tasks.find((t) => t.id === taskId);
    if (task) {
      task.status = "failed";
      task.error = error;
      task.completedAt = new Date().toISOString();
    }
    await this.saveTasks(tasks);
  }

  /**
   * キューの状態サマリ
   */
  async getStatus(): Promise<{ pending: number; completed: number; failed: number }> {
    const tasks = await this.loadTasks();
    return {
      pending: tasks.filter((t) => t.status === "pending").length,
      completed: tasks.filter((t) => t.status === "completed").length,
      failed: tasks.filter((t) => t.status === "failed").length,
    };
  }

  private createTask(
    type: TaskType,
    priority: number,
    project: string,
    projectPath: string,
    specPaths: SpecPaths,
    changedFiles?: string[],
  ): SchedulerTask {
    const task: SchedulerTask = {
      id: randomUUID(),
      type,
      priority,
      project,
      projectPath,
      specPaths,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    if (changedFiles) {
      task.changedFiles = changedFiles;
    }
    return task;
  }

  private async loadTasks(): Promise<SchedulerTask[]> {
    try {
      const content = await readFile(this.queuePath, "utf-8");
      return JSON.parse(content) as SchedulerTask[];
    } catch {
      return [];
    }
  }

  private async saveTasks(tasks: SchedulerTask[]): Promise<void> {
    await writeFile(this.queuePath, JSON.stringify(tasks, null, 2));
  }
}
