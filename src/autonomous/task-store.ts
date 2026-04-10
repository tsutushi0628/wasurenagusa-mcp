import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { randomUUID } from "crypto";
import type {
  AutonomousTask,
  AutonomousTaskStatus,
  EvaluationEntry,
  TaskSubmitParams,
  TaskStatusResponse,
} from "../types.js";

export class TaskStore {
  private filePath: string;

  constructor(schedulerDir: string) {
    this.filePath = join(schedulerDir, "autonomous-tasks.json");
  }

  async submit(params: TaskSubmitParams, projectPath: string): Promise<AutonomousTask> {
    const tasks = await this.loadTasks();

    // 重複チェック: 同一project + what + status=pending
    const isDuplicate = tasks.some(
      (t) =>
        t.status === "pending" &&
        t.project === params.project &&
        t.what === params.what,
    );
    if (isDuplicate) {
      throw new Error(`Duplicate task: "${params.what}" for project "${params.project}" is already pending`);
    }

    const task: AutonomousTask = {
      id: randomUUID(),
      why: params.why,
      what: params.what,
      done: params.done,
      project: params.project,
      projectPath,
      status: "pending",
      priority: 0,
      retryCount: 0,
      createdAt: new Date().toISOString(),
      evaluationHistory: [],
    };

    tasks.push(task);
    await this.saveTasks(tasks);
    return task;
  }

  async dequeue(): Promise<AutonomousTask | null> {
    const tasks = await this.loadTasks();

    const pendingTasks = tasks.filter((t) => t.status === "pending");
    if (pendingTasks.length === 0) {
      return null;
    }

    // priority昇順→createdAt昇順
    pendingTasks.sort((a, b) => {
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      return a.createdAt.localeCompare(b.createdAt);
    });

    const selected = pendingTasks[0];
    const taskInQueue = tasks.find((t) => t.id === selected.id);
    if (taskInQueue) {
      taskInQueue.status = "in-progress";
    }

    await this.saveTasks(tasks);
    return { ...selected, status: "in-progress" };
  }

  async markCompleted(taskId: string): Promise<void> {
    const tasks = await this.loadTasks();
    const task = tasks.find((t) => t.id === taskId);
    if (task) {
      task.status = "completed";
      task.completedAt = new Date().toISOString();
    }
    await this.saveTasks(tasks);
  }

  async markFailed(taskId: string, error: string): Promise<void> {
    const tasks = await this.loadTasks();
    const task = tasks.find((t) => t.id === taskId);
    if (task) {
      task.status = "failed";
      task.humanRequiredReason = error;
      task.completedAt = new Date().toISOString();
    }
    await this.saveTasks(tasks);
  }

  async markHumanRequired(taskId: string, reason: string): Promise<void> {
    const tasks = await this.loadTasks();
    const task = tasks.find((t) => t.id === taskId);
    if (task) {
      task.status = "human-required";
      task.humanRequiredReason = reason;
    }
    await this.saveTasks(tasks);
  }

  async incrementRetry(taskId: string): Promise<AutonomousTask> {
    const tasks = await this.loadTasks();
    const task = tasks.find((t) => t.id === taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    task.retryCount += 1;
    task.status = "pending";
    await this.saveTasks(tasks);
    return { ...task };
  }

  async resolveAction(taskId: string, action: "retry" | "complete" | "cancel"): Promise<void> {
    const tasks = await this.loadTasks();
    const task = tasks.find((t) => t.id === taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const statusMap: Record<string, AutonomousTaskStatus> = {
      retry: "pending",
      complete: "completed",
      cancel: "cancelled",
    };
    task.status = statusMap[action];

    if (action === "complete" || action === "cancel") {
      task.completedAt = new Date().toISOString();
    }

    await this.saveTasks(tasks);
  }

  async getStatus(): Promise<TaskStatusResponse> {
    const tasks = await this.loadTasks();

    const summary = {
      pending: 0,
      inProgress: 0,
      completed: 0,
      failed: 0,
      humanRequired: 0,
      cancelled: 0,
    };

    for (const task of tasks) {
      if (task.status === "pending") summary.pending++;
      else if (task.status === "in-progress") summary.inProgress++;
      else if (task.status === "completed") summary.completed++;
      else if (task.status === "failed") summary.failed++;
      else if (task.status === "human-required") summary.humanRequired++;
      else if (task.status === "cancelled") summary.cancelled++;
    }

    // 直近20件をcreatedAt降順
    const recentTasks = [...tasks]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 20)
      .map((t) => ({
        id: t.id,
        what: t.what,
        project: t.project,
        status: t.status,
        createdAt: t.createdAt,
      }));

    return { summary, recentTasks };
  }

  async getHumanRequiredTasks(): Promise<AutonomousTask[]> {
    const tasks = await this.loadTasks();
    return tasks.filter((t) => t.status === "human-required");
  }

  async addEvaluation(taskId: string, entry: EvaluationEntry): Promise<void> {
    const tasks = await this.loadTasks();
    const task = tasks.find((t) => t.id === taskId);
    if (task) {
      task.evaluationHistory.push(entry);
    }
    await this.saveTasks(tasks);
  }

  async setGeneratedCommand(taskId: string, command: string): Promise<void> {
    const tasks = await this.loadTasks();
    const task = tasks.find((t) => t.id === taskId);
    if (task) {
      task.generatedCommand = command;
    }
    await this.saveTasks(tasks);
  }

  async requeueTask(taskId: string): Promise<void> {
    const tasks = await this.loadTasks();
    const task = tasks.find((t) => t.id === taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    if (task.status !== "in-progress") {
      throw new Error(`Task is not in-progress: ${task.status}`);
    }
    task.status = "pending";
    await this.saveTasks(tasks);
  }

  async recoverInProgress(): Promise<number> {
    const tasks = await this.loadTasks();
    let recovered = 0;
    for (const task of tasks) {
      if (task.status === "in-progress") {
        task.status = "failed";
        task.humanRequiredReason = "Recovered from in-progress state (scheduler crash)";
        task.completedAt = new Date().toISOString();
        recovered++;
      }
    }
    if (recovered > 0) {
      await this.saveTasks(tasks);
    }
    return recovered;
  }

  private async loadTasks(): Promise<AutonomousTask[]> {
    try {
      const content = await readFile(this.filePath, "utf-8");
      return JSON.parse(content) as AutonomousTask[];
    } catch {
      return [];
    }
  }

  private async saveTasks(tasks: AutonomousTask[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(tasks, null, 2));
  }
}
