#!/usr/bin/env node
/**
 * wasurenagusa-spec-update CLI
 * cron/launchd timer用: Specドキュメントの自動更新
 *
 * サブコマンド:
 *   --run    全タスクを並行実行（デフォルト）
 *   --status キュー状態・最終実行結果の表示
 *   --setup  cron/launchd設定の生成
 */

import { existsSync } from "fs";
import { mkdir, readFile, writeFile, unlink, open } from "fs/promises";
import { join, dirname } from "path";
import { homedir } from "os";
import { ChangeLogger } from "../scheduler/change-logger.js";
import { TaskQueue } from "../scheduler/task-queue.js";
import { PromptBuilder } from "../scheduler/prompt-builder.js";
import { Executor } from "../scheduler/executor.js";
import { TaskStore } from "../autonomous/task-store.js";
import { CommandGenerator } from "../autonomous/command-generator.js";
import { TaskEvaluator } from "../autonomous/evaluator.js";
import { ProjectInitializer } from "../autonomous/project-initializer.js";
import { ProjectScanner } from "../autonomous/project-scanner.js";
import { ActionList } from "../autonomous/action-list.js";
import { AUTONOMOUS_DEFAULT_OPTIONS, MAX_RETRY_COUNT, TEMPLATE_PATTERNS } from "../autonomous/constants.js";
import { SlackNotifier, type CycleTaskResult } from "../autonomous/notifier.js";
import { TaskMarkdownAdapter } from "../autonomous/task-markdown.js";
import type { SchedulerConfig, ExecutionLogEntry, AutonomousTask, AutonomousTaskStatus } from "../types.js";

const TASKS_MD_PATH = join(homedir(), ".wasurenagusa", "scheduler", "tasks.md");

const SCHEDULER_DIR = join(homedir(), ".wasurenagusa", "scheduler");
const CONFIG_PATH = join(SCHEDULER_DIR, "config.json");
const LOCK_PATH = join(SCHEDULER_DIR, ".lock");
const LOGS_DIR = join(SCHEDULER_DIR, "logs");

const LAST_SESSION_PATH = join(SCHEDULER_DIR, "last-session.json");

const DEFAULT_CONFIG: SchedulerConfig = {
  projects: [],
  cycleMinutes: 305,
  taskTimeoutMs: 600000,
  pingTimeoutMs: 30000,
  rotationThresholdDays: 7,
  idleThresholdMinutes: 150,
  maxConcurrentTasks: 3,
  subProjectParents: ["my-org", "my-org-v2"],
};

/**
 * タスクファクトリ配列を並列数制限付きで実行する。
 * 最大 maxConcurrent 個のタスクを同時実行し、1つ完了するたびに次を開始する。
 */
async function runWithConcurrencyLimit(
  taskFns: (() => Promise<void>)[],
  maxConcurrent: number,
): Promise<PromiseSettledResult<void>[]> {
  const results: PromiseSettledResult<void>[] = [];
  let index = 0;

  async function runNext(): Promise<void> {
    while (index < taskFns.length) {
      const currentIndex = index++;
      try {
        await taskFns[currentIndex]();
        results[currentIndex] = { status: "fulfilled", value: undefined };
      } catch (error) {
        results[currentIndex] = { status: "rejected", reason: error };
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(maxConcurrent, taskFns.length) },
    () => runNext(),
  );
  await Promise.all(workers);
  return results;
}

/**
 * ユーザーがアイドル状態か判定する。
 * 最後のセッション終了から idleThresholdMinutes 以上経過していればtrue。
 * last-session.jsonが存在しない場合はアイドルとみなす（初回起動時など）。
 */
async function isUserIdle(config: SchedulerConfig): Promise<boolean> {
  try {
    const content = await readFile(LAST_SESSION_PATH, "utf-8");
    const data = JSON.parse(content) as { endedAt: string };
    const endedAt = new Date(data.endedAt).getTime();
    const elapsedMs = Date.now() - endedAt;
    const thresholdMs = config.idleThresholdMinutes * 60 * 1000;
    return elapsedMs >= thresholdMs;
  } catch {
    // ファイルなし = まだセッションが記録されていない → アイドルとみなす
    return true;
  }
}

async function loadConfig(): Promise<SchedulerConfig> {
  try {
    const content = await readFile(CONFIG_PATH, "utf-8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(content) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

async function acquireLock(): Promise<boolean> {
  try {
    await mkdir(SCHEDULER_DIR, { recursive: true });
    const fh = await open(LOCK_PATH, "wx");
    await fh.write(String(process.pid));
    await fh.close();
    return true;
  } catch {
    return false;
  }
}

async function releaseLock(): Promise<void> {
  try {
    await unlink(LOCK_PATH);
  } catch {
    // ロック解放失敗は無視
  }
}

async function logExecution(entry: ExecutionLogEntry): Promise<void> {
  try {
    await mkdir(LOGS_DIR, { recursive: true });
    const date = new Date().toISOString().split("T")[0];
    const logPath = join(LOGS_DIR, `${date}.json`);

    let executions: ExecutionLogEntry[] = [];
    try {
      const content = await readFile(logPath, "utf-8");
      executions = JSON.parse(content);
    } catch {
      // ファイルなしまたはパースエラー
    }

    executions.push(entry);
    await writeFile(logPath, JSON.stringify(executions, null, 2));
  } catch {
    // ログ記録失敗は無視
  }
}

/**
 * tasks.md → TaskStore 同期
 * MDのpendingタスクでTaskStoreに未登録のものをsubmitする
 */
async function syncMarkdownToStore(
  taskStore: TaskStore,
  projectInitializer: ProjectInitializer,
): Promise<number> {
  const mdAdapter = new TaskMarkdownAdapter(TASKS_MD_PATH);
  const pendingMdTasks = await mdAdapter.readPendingTasks();

  if (pendingMdTasks.length === 0) {
    return 0;
  }

  // 既存タスク一覧を取得（重複チェック用）
  const storeStatus = await taskStore.getStatus();
  const existingWhats = new Set(
    storeStatus.recentTasks.map((t) => `${t.project}:${t.what}`),
  );

  let synced = 0;
  for (const mdTask of pendingMdTasks) {
    const key = `${mdTask.project}:${mdTask.what}`;
    if (existingWhats.has(key)) {
      continue;
    }

    // projectPathの解決: meta登録済み → meta.projectPath、未登録 → ~/projects/{project} を自動解決
    const meta = await projectInitializer.loadProjectMeta(mdTask.project);
    let projectPath = "";
    if (meta) {
      projectPath = meta.projectPath;
    } else {
      projectPath = join(homedir(), "projects", mdTask.project);
    }

    try {
      await taskStore.submit(
        TaskMarkdownAdapter.toSubmitParams(mdTask),
        projectPath,
      );
      synced++;
    } catch {
      // 重複等のエラーは無視
    }
  }

  return synced;
}

/**
 * タスク完了/失敗時にtasks.mdのステータスも更新する
 */
async function syncStatusToMarkdown(
  what: string,
  project: string,
  status: AutonomousTaskStatus,
  extra?: { error?: string; reason?: string },
): Promise<void> {
  const mdAdapter = new TaskMarkdownAdapter(TASKS_MD_PATH);
  await mdAdapter.updateStatus(what, project, status, extra);
}


function validateAutonomousTask(task: AutonomousTask): { valid: boolean; reason?: string } {
  const fields = [
    { name: "why", value: task.why },
    { name: "what", value: task.what },
    { name: "done", value: task.done },
    { name: "project", value: task.project },
  ];

  for (const field of fields) {
    if (!field.value || field.value.trim().length === 0) {
      return { valid: false, reason: `フィールド "${field.name}" が空` };
    }
    for (const pattern of TEMPLATE_PATTERNS) {
      if (pattern.test(field.value)) {
        return { valid: false, reason: `フィールド "${field.name}" がテンプレート文面: "${field.value}"` };
      }
    }
  }

  if (!task.projectPath || !existsSync(task.projectPath)) {
    return { valid: false, reason: `projectPath が存在しない: "${task.projectPath}"` };
  }

  return { valid: true };
}

async function executeAutonomousTask(
  task: AutonomousTask,
  taskStore: TaskStore,
  executor: Executor,
  notifier: SlackNotifier,
): Promise<{ exitCode: number; durationMs: number; failReason?: string }> {
  const projectInitializer = new ProjectInitializer(SCHEDULER_DIR);
  const commandGenerator = new CommandGenerator();
  const evaluator = new TaskEvaluator();
  const actionList = new ActionList(SCHEDULER_DIR);

  // ProjectMeta取得（未設定時はデフォルト）
  const meta = await projectInitializer.loadProjectMetaOrDefault(
    task.project,
    task.projectPath,
  );

  // 命令文生成
  const command = await commandGenerator.generate({
    task,
    projectMeta: meta,
  });
  await taskStore.setGeneratedCommand(task.id, command);

  console.log(`[Autonomous] Executing task: ${task.what}`);

  // 実行
  const result = await executor.runSpecUpdate(command, task.projectPath, {
    maxTurns: AUTONOMOUS_DEFAULT_OPTIONS.maxTurns,
    timeoutMs: AUTONOMOUS_DEFAULT_OPTIONS.timeoutMs,
    allowedTools: AUTONOMOUS_DEFAULT_OPTIONS.allowedTools,
  });

  // exitCode != 0 → 即failed
  if (result.exitCode !== 0) {
    const failReason = `Exit code: ${result.exitCode}`;
    await taskStore.markFailed(task.id, failReason);
    await syncStatusToMarkdown(task.what, task.project, "failed", { error: failReason });
    console.error(`[Autonomous] Task failed with exit code ${result.exitCode}`);
    return { exitCode: result.exitCode, durationMs: result.durationMs, failReason };
  }

  // 評価
  const evaluation = await evaluator.evaluate({
    task,
    executionOutput: result.stdout,
    executionExitCode: result.exitCode,
    executionDurationMs: result.durationMs,
    projectMeta: meta,
  });

  // 評価履歴を記録
  await taskStore.addEvaluation(task.id, {
    timestamp: new Date().toISOString(),
    result: evaluation.verdict,
    reason: evaluation.reason,
    suggestion: evaluation.suggestion,
    executionDurationMs: result.durationMs,
  });

  // verdict判定
  if (evaluation.verdict === "ok") {
    await taskStore.markCompleted(task.id);
    await syncStatusToMarkdown(task.what, task.project, "completed");
    console.log(`[Autonomous] Task completed: ${evaluation.reason}`);
  } else if (evaluation.verdict === "ng") {
    const updated = await taskStore.incrementRetry(task.id);
    if (updated.retryCount >= MAX_RETRY_COUNT) {
      const reason = `${MAX_RETRY_COUNT}回リトライ上限到達: ${evaluation.reason}`;
      await taskStore.markHumanRequired(task.id, reason);
      await actionList.add({
        taskId: task.id,
        project: task.project,
        what: task.what,
        reason,
        suggestion: evaluation.suggestion,
        createdAt: new Date().toISOString(),
        source: "retry-limit",
      });
      await notifier.notifyRetryLimitReached(
        task.project, task.what, reason,
        updated.retryCount, MAX_RETRY_COUNT,
      );
      await syncStatusToMarkdown(task.what, task.project, "human-required", { reason });
      console.log(`[Autonomous] Task escalated to human: ${reason}`);
      return { exitCode: result.exitCode, durationMs: result.durationMs, failReason: reason };
    } else {
      console.log(`[Autonomous] Task will retry (${updated.retryCount}/${MAX_RETRY_COUNT}): ${evaluation.reason}`);
      return { exitCode: result.exitCode, durationMs: result.durationMs, failReason: evaluation.reason };
    }
  } else {
    // human-required
    await taskStore.markHumanRequired(task.id, evaluation.reason);
    await actionList.add({
      taskId: task.id,
      project: task.project,
      what: task.what,
      reason: evaluation.reason,
      suggestion: evaluation.suggestion,
      createdAt: new Date().toISOString(),
      source: "evaluation",
    });
    await notifier.notifyHumanRequired(
      task.project, task.what, evaluation.reason, evaluation.suggestion,
    );
    await syncStatusToMarkdown(task.what, task.project, "human-required", { reason: evaluation.reason });
    console.log(`[Autonomous] Task requires human decision: ${evaluation.reason}`);
    return { exitCode: result.exitCode, durationMs: result.durationMs, failReason: evaluation.reason };
  }

  return { exitCode: result.exitCode, durationMs: result.durationMs };
}

async function runCommand(): Promise<void> {
  const locked = await acquireLock();
  if (!locked) {
    console.error("Another instance is already running. Exiting.");
    process.exit(1);
  }

  try {
    const config = await loadConfig();
    const executor = new Executor();

    // Claude CLI存在確認
    const available = await executor.isClaudeAvailable();
    if (!available) {
      console.error("claude command not found in PATH. Please install Claude Code CLI.");
      process.exit(1);
    }

    // 自律タスク: 起動時にin-progress→failed復旧
    const taskStore = new TaskStore(SCHEDULER_DIR);
    const notifier = new SlackNotifier();
    const projectInitializer = new ProjectInitializer(SCHEDULER_DIR);
    const recovered = await taskStore.recoverInProgress();
    if (recovered > 0) {
      console.log(`[Autonomous] Recovered ${recovered} in-progress task(s) to failed state`);
    }

    // プロジェクト一覧スキャン → tasks.md のプロジェクトリスト自動更新
    const projectScanner = new ProjectScanner(
      join(homedir(), "projects"),
      config.subProjectParents,
    );
    const projectEntries = await projectScanner.scanProjects();
    const mdAdapter = new TaskMarkdownAdapter(TASKS_MD_PATH);
    const updated = await mdAdapter.updateProjectList(projectEntries);
    if (updated) {
      console.log(`[Project Scan] Updated project list in tasks.md (${projectEntries.length} projects)`);
    }

    // tasks.md → TaskStore 同期
    const synced = await syncMarkdownToStore(taskStore, projectInitializer);
    if (synced > 0) {
      console.log(`[MD Sync] Synced ${synced} new task(s) from tasks.md`);
    }

    // アイドル判定: ユーザーが最近使っていた場合はタスク実行をスキップ
    const idle = await isUserIdle(config);
    if (!idle) {
      console.log(`[Idle Check] User was active within ${config.idleThresholdMinutes} minutes. Skipping tasks, sending ping...`);
      const result = await executor.ping(config.pingTimeoutMs);
      console.log(`Ping ${result.exitCode === 0 ? "succeeded" : "failed"} (${result.durationMs}ms)`);

      await logExecution({
        timestamp: new Date().toISOString(),
        taskId: "ping",
        type: "ping",
        project: "-",
        exitCode: result.exitCode,
        durationMs: result.durationMs,
      });
      return;
    }

    // === タスク収集 → 並列数制限付き実行 ===
    const taskFns: (() => Promise<void>)[] = [];
    const cycleResults: CycleTaskResult[] = [];
    const cycleStartMs = Date.now();

    // 自律タスク: 全dequeue
    const autonomousTasks: AutonomousTask[] = [];
    let nextTask = await taskStore.dequeue();
    while (nextTask) {
      autonomousTasks.push(nextTask);
      nextTask = await taskStore.dequeue();
    }

    for (const autoTask of autonomousTasks) {
      const validation = validateAutonomousTask(autoTask);
      if (!validation.valid) {
        const reason = `バリデーション失敗: ${validation.reason}`;
        await taskStore.markFailed(autoTask.id, reason);
        cycleResults.push({
          project: autoTask.project,
          taskType: "autonomous",
          description: autoTask.what,
          exitCode: 1,
          durationMs: 0,
          failReason: reason,
        });
        await syncStatusToMarkdown(autoTask.what, autoTask.project, "failed", { error: reason });
        console.error(`[Autonomous] Task skipped (invalid): ${reason}`);
        continue;
      }

      taskFns.push(async () => {
        await syncStatusToMarkdown(autoTask.what, autoTask.project, "in-progress");
        let execResult: { exitCode: number; durationMs: number; failReason?: string } = { exitCode: -1, durationMs: 0 };
        try {
          execResult = await executeAutonomousTask(autoTask, taskStore, executor, notifier);
        } catch (error) {
          let errorMessage: string;
          if (error instanceof Error) {
            errorMessage = error.message;
          } else {
            errorMessage = String(error);
          }
          await taskStore.markFailed(autoTask.id, errorMessage);
          await syncStatusToMarkdown(autoTask.what, autoTask.project, "failed", { error: errorMessage });
          console.error(`[Autonomous] Task failed with error: ${errorMessage}`);
          execResult = { exitCode: -1, durationMs: 0, failReason: `Error: ${errorMessage}` };
        }

        cycleResults.push({
          project: autoTask.project,
          taskType: "autonomous",
          description: autoTask.what,
          exitCode: execResult.exitCode,
          durationMs: execResult.durationMs,
          failReason: execResult.failReason,
        });

        await logExecution({
          timestamp: new Date().toISOString(),
          taskId: autoTask.id,
          type: "autonomous",
          project: autoTask.project,
          exitCode: execResult.exitCode,
          durationMs: execResult.durationMs,
          summary: `Autonomous task: ${autoTask.what}`,
        });
      });
    }

    // Spec更新タスク: キュービルド → 全dequeue
    const changeLogger = new ChangeLogger(SCHEDULER_DIR);
    const taskQueue = new TaskQueue(SCHEDULER_DIR);
    const promptBuilder = new PromptBuilder();

    const changeEntries = await changeLogger.getEntries();
    await taskQueue.buildQueue(changeEntries, config.projects);

    const specTasks = await taskQueue.dequeueAll();

    for (const task of specTasks) {
      taskFns.push(async () => {
        let prompt: string;
        if (task.type === "change-based") {
          prompt = await promptBuilder.buildChangeBasedPrompt(task);
          const matchingEntry = changeEntries.find(
            (e) => e.project === task.project && e.projectPath === task.projectPath,
          );
          if (matchingEntry) {
            await changeLogger.consumeEntry(matchingEntry.timestamp);
          }
        } else {
          prompt = await promptBuilder.buildRotationPrompt(task);
        }

        console.log(`Executing ${task.type} task for ${task.project}...`);
        const result = await executor.runSpecUpdate(prompt, task.projectPath, {
          timeoutMs: config.taskTimeoutMs,
        });

        if (result.exitCode === 0) {
          await taskQueue.markComplete(task.id);
          console.log(`Task completed for ${task.project} (${result.durationMs}ms)`);
        } else {
          await taskQueue.markFailed(task.id, result.stderr.slice(0, 200));
          console.error(`Task failed for ${task.project} with exit code ${result.exitCode}`);
        }

        cycleResults.push({
          project: task.project,
          taskType: task.type as "change-based" | "rotation",
          description: "spec更新",
          summary: result.exitCode === 0 ? result.stdout.slice(0, 200) : undefined,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          failReason: result.exitCode !== 0 ? `Exit code: ${result.exitCode}` : undefined,
        });

        await logExecution({
          timestamp: new Date().toISOString(),
          taskId: task.id,
          type: task.type,
          project: task.project,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          summary: result.exitCode === 0 ? result.stdout.slice(0, 200) : undefined,
          error: result.exitCode !== 0 ? result.stderr.slice(0, 200) : undefined,
        });
      });
    }

    // 並列数制限付き実行 or ping
    if (taskFns.length > 0) {
      const maxConcurrent = config.maxConcurrentTasks;
      console.log(`[Parallel] Executing ${taskFns.length} task(s) with concurrency limit ${maxConcurrent}...`);
      const results = await runWithConcurrencyLimit(taskFns, maxConcurrent);
      const failed = results.filter((r) => r.status === "rejected");
      if (failed.length > 0) {
        console.error(`[Parallel] ${failed.length} task(s) failed unexpectedly`);
      }
      console.log(`[Parallel] All ${taskFns.length} task(s) finished`);

      // サイクルサマリー通知（全タスク統合）
      if (cycleResults.length > 0) {
        await notifier.notifyCycleSummary({
          results: cycleResults,
          totalDurationMs: Date.now() - cycleStartMs,
          completedAt: new Date().toISOString(),
        });
      }
    } else {
      console.log("No tasks in queue. Sending keep-alive ping...");
      const result = await executor.ping(config.pingTimeoutMs);
      console.log(`Ping ${result.exitCode === 0 ? "succeeded" : "failed"} (${result.durationMs}ms)`);

      await logExecution({
        timestamp: new Date().toISOString(),
        taskId: "ping",
        type: "ping",
        project: "-",
        exitCode: result.exitCode,
        durationMs: result.durationMs,
      });
    }
  } finally {
    await releaseLock();
  }
}

async function statusCommand(): Promise<void> {
  const taskQueue = new TaskQueue(SCHEDULER_DIR);
  const status = await taskQueue.getStatus();

  console.log("=== Wasurenagusa Spec Update Status ===");
  console.log(`Pending:   ${status.pending}`);
  console.log(`Completed: ${status.completed}`);
  console.log(`Failed:    ${status.failed}`);

  // 最新の実行ログを表示
  try {
    const date = new Date().toISOString().split("T")[0];
    const logPath = join(LOGS_DIR, `${date}.json`);
    const content = await readFile(logPath, "utf-8");
    const executions: ExecutionLogEntry[] = JSON.parse(content);
    if (executions.length > 0) {
      const last = executions[executions.length - 1];
      console.log(`\nLast execution:`);
      console.log(`  Type:     ${last.type}`);
      console.log(`  Project:  ${last.project}`);
      console.log(`  ExitCode: ${last.exitCode}`);
      console.log(`  Duration: ${last.durationMs}ms`);
      console.log(`  Time:     ${last.timestamp}`);
    }
  } catch {
    console.log("\nNo execution logs for today.");
  }
}

function setupCommand(): void {
  const binPath = process.argv[1] || "wasurenagusa-spec-update";

  console.log("=== Setup Instructions ===\n");

  // launchd (macOS)
  console.log("--- macOS (launchd) ---");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.wasurenagusa.spec-update</string>
  <key>ProgramArguments</key>
  <array>
    <string>${binPath}</string>
    <string>--run</string>
  </array>
  <key>StartInterval</key>
  <integer>18300</integer>
  <key>StandardOutPath</key>
  <string>${homedir()}/Library/Logs/wasurenagusa-spec-update.log</string>
  <key>StandardErrorPath</key>
  <string>${homedir()}/Library/Logs/wasurenagusa-spec-update.error.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>
</dict>
</plist>`;
  console.log(`\nSave to: ~/Library/LaunchAgents/com.wasurenagusa.spec-update.plist`);
  console.log(plist);
  console.log(`\nLoad: launchctl load ~/Library/LaunchAgents/com.wasurenagusa.spec-update.plist`);

  // crontab (Linux)
  console.log("\n--- Linux (crontab) ---");
  console.log(`Add to crontab (crontab -e):`);
  console.log(`*/305 * * * * ${binPath} --run >> ~/.wasurenagusa/scheduler/cron.log 2>&1`);
  console.log(`\nOr use systemd timer for more precise scheduling.`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] || "--run";

  switch (command) {
    case "--run":
      await runCommand();
      break;
    case "--status":
      await statusCommand();
      break;
    case "--setup":
      setupCommand();
      break;
    default:
      console.log("Usage: wasurenagusa-spec-update [--run|--status|--setup]");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
