import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname } from "path";
import type { AutonomousTaskStatus, ProjectEntry, TaskSubmitParams } from "../types.js";

const PROJECT_LIST_START_MARKER = "<!-- PROJECT_LIST_START";
const PROJECT_LIST_END_MARKER = "<!-- PROJECT_LIST_END -->";

/**
 * MDから読み取ったタスク（JSONのAutonomousTaskより軽量）
 */
export interface MarkdownTask {
  /** H2見出しテキスト（人間用ラベル） */
  title: string;
  project: string;
  why: string;
  what: string;
  done: string;
  status: AutonomousTaskStatus;
  /** システムが追記するフィールド */
  error?: string;
  reason?: string;
  /** パース元の行範囲（書き戻し用） */
  lineStart: number;
  lineEnd: number;
}

/**
 * tasks.md のパーサー＆ライター
 *
 * フォーマット仕様:
 * - `## タスク名` でタスク境界
 * - `- key: value` でフラットキーバリュー
 * - status未指定 → pending（デフォルト）
 * - 順序不問、未知キー無視
 */
export class TaskMarkdownAdapter {
  constructor(private filePath: string) {}

  /**
   * tasks.md を読み込み、パースしてタスク配列を返す
   */
  async readTasks(): Promise<MarkdownTask[]> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf-8");
    } catch {
      return [];
    }
    return this.parse(content);
  }

  /**
   * pendingタスクだけ抽出（スケジューラー用）
   */
  async readPendingTasks(): Promise<MarkdownTask[]> {
    const tasks = await this.readTasks();
    return tasks.filter((t) => t.status === "pending");
  }

  /**
   * タスクのstatusを更新してMDに書き戻す
   */
  async updateStatus(
    what: string,
    project: string,
    status: AutonomousTaskStatus,
    extra?: { error?: string; reason?: string },
  ): Promise<boolean> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf-8");
    } catch {
      return false;
    }

    const lines = content.split("\n");
    const tasks = this.parse(content);

    // what + project でマッチ
    const target = tasks.find(
      (t) => t.what === what && t.project === project,
    );
    if (!target) {
      return false;
    }

    // 該当ブロックの行を操作
    const blockLines = lines.slice(target.lineStart, target.lineEnd + 1);
    const newBlockLines = this.updateBlockLines(blockLines, status, extra);

    // 元の行を置換
    const before = lines.slice(0, target.lineStart);
    const after = lines.slice(target.lineEnd + 1);
    const newContent = [...before, ...newBlockLines, ...after].join("\n");

    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, newContent, "utf-8");
    return true;
  }

  /**
   * Markdownコンテンツをパースしてタスク配列に変換する
   */
  parse(content: string): MarkdownTask[] {
    const tasks: MarkdownTask[] = [];
    const lines = content.split("\n");

    let currentTitle = "";
    let currentLineStart = -1;
    let currentFields: Map<string, string> = new Map();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // H2見出しを検出
      if (line.startsWith("## ")) {
        // 前のブロックを確定
        if (currentTitle && currentLineStart >= 0) {
          const task = this.fieldsToTask(currentTitle, currentFields, currentLineStart, i - 1);
          if (task) {
            tasks.push(task);
          }
        }

        currentTitle = line.slice(3).trim();
        currentLineStart = i;
        currentFields = new Map();
        continue;
      }

      // `- key: value` パターンを抽出
      if (currentLineStart >= 0) {
        const match = line.match(/^- (\w+):\s*(.*)$/);
        if (match) {
          currentFields.set(match[1], match[2].trim());
        }
      }
    }

    // 最後のブロックを確定
    if (currentTitle && currentLineStart >= 0) {
      const task = this.fieldsToTask(currentTitle, currentFields, currentLineStart, lines.length - 1);
      if (task) {
        tasks.push(task);
      }
    }

    return tasks;
  }

  /**
   * フィールドMapからMarkdownTaskを構築（4必須項目チェック）
   */
  private fieldsToTask(
    title: string,
    fields: Map<string, string>,
    lineStart: number,
    lineEnd: number,
  ): MarkdownTask | null {
    const project = fields.get("project");
    const why = fields.get("why");
    const what = fields.get("what");
    const done = fields.get("done");

    // 4項目すべて必須
    if (!project || !why || !what || !done) {
      return null;
    }

    // status未指定ならpending
    const rawStatus = fields.get("status");
    let status: AutonomousTaskStatus = "pending";
    if (rawStatus && isValidStatus(rawStatus)) {
      status = rawStatus;
    }

    return {
      title,
      project,
      why,
      what,
      done,
      status,
      error: fields.get("error"),
      reason: fields.get("reason"),
      lineStart,
      lineEnd,
    };
  }

  /**
   * ブロック内の行を更新（status追記/更新、extra追記）
   */
  private updateBlockLines(
    blockLines: string[],
    status: AutonomousTaskStatus,
    extra?: { error?: string; reason?: string },
  ): string[] {
    const result: string[] = [];
    let statusFound = false;
    let errorFound = false;
    let reasonFound = false;

    for (const line of blockLines) {
      // 既存のstatus行を書き換え
      if (line.match(/^- status:\s*/)) {
        result.push(`- status: ${status}`);
        statusFound = true;
        continue;
      }
      // 既存のerror行を書き換え
      if (line.match(/^- error:\s*/) && extra?.error) {
        result.push(`- error: ${extra.error}`);
        errorFound = true;
        continue;
      }
      // 既存のreason行を書き換え
      if (line.match(/^- reason:\s*/) && extra?.reason) {
        result.push(`- reason: ${extra.reason}`);
        reasonFound = true;
        continue;
      }
      result.push(line);
    }

    // status行がなかった場合は追記
    if (!statusFound) {
      result.push(`- status: ${status}`);
    }

    // extra追記
    if (extra?.error && !errorFound) {
      result.push(`- error: ${extra.error}`);
    }
    if (extra?.reason && !reasonFound) {
      result.push(`- reason: ${extra.reason}`);
    }

    return result;
  }

  /**
   * MarkdownTaskをTaskSubmitParams形式に変換（TaskStore連携用）
   */
  static toSubmitParams(task: MarkdownTask): TaskSubmitParams {
    return {
      why: task.why,
      what: task.what,
      done: task.done,
      project: task.project,
    };
  }

  /**
   * tasks.mdのプロジェクト一覧コメントブロックを動的更新する
   * マーカーコメント（PROJECT_LIST_START / PROJECT_LIST_END）で囲まれた区間を差し替え
   */
  async updateProjectList(projects: ProjectEntry[]): Promise<boolean> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf-8");
    } catch {
      return false;
    }

    const startIdx = content.indexOf(PROJECT_LIST_START_MARKER);
    const endIdx = content.indexOf(PROJECT_LIST_END_MARKER);

    // マーカーが見つからなければスキップ
    if (startIdx === -1 || endIdx === -1) {
      return false;
    }

    const timestamp = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
    const projectNames = projects.map((p) => `  ${p.name}`);
    const newSection = [
      `${PROJECT_LIST_START_MARKER} (自動更新: 手動編集禁止) -->`,
      `<!-- 利用可能プロジェクト（${timestamp} 更新）`,
      ...projectNames,
      `-->`,
      PROJECT_LIST_END_MARKER,
    ].join("\n");

    const newContent =
      content.slice(0, startIdx) +
      newSection +
      content.slice(endIdx + PROJECT_LIST_END_MARKER.length);

    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, newContent, "utf-8");
    return true;
  }
}

function isValidStatus(value: string): value is AutonomousTaskStatus {
  const validStatuses: AutonomousTaskStatus[] = [
    "pending",
    "in-progress",
    "completed",
    "failed",
    "human-required",
    "cancelled",
  ];
  return validStatuses.includes(value as AutonomousTaskStatus);
}
