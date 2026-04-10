import { config } from "../config.js";

export type NotificationType =
  | "cycle_summary"
  | "task_human_required"
  | "task_retry"
  | "daily_summary";

// Slack Block Kit 型定義
interface SlackTextObject {
  type: "plain_text" | "mrkdwn";
  text: string;
}

interface SlackHeaderBlock {
  type: "header";
  text: SlackTextObject;
}

interface SlackSectionBlock {
  type: "section";
  fields?: SlackTextObject[];
  text?: SlackTextObject;
}

interface SlackContextBlock {
  type: "context";
  elements: SlackTextObject[];
}

type SlackBlock = SlackHeaderBlock | SlackSectionBlock | SlackContextBlock;

export interface CycleTaskResult {
  project: string;
  taskType: "autonomous" | "change-based" | "rotation";
  description: string;
  summary?: string;
  exitCode: number;
  durationMs: number;
  failReason?: string;
}

export interface CycleSummary {
  results: CycleTaskResult[];
  totalDurationMs: number;
  completedAt: string;
  rateLimitSkipped?: number;
}

// Discriminated union: タイプ別でペイロード型を分離
type NotificationPayload =
  | {
      type: "task_human_required" | "task_retry";
      project: string;
      taskWhat: string;
      reason?: string;
      suggestion?: string;
      retryCount?: number;
      maxRetry?: number;
    }
  | {
      type: "daily_summary";
      summary: DailySummary;
    }
  | {
      type: "cycle_summary";
      cycleSummary: CycleSummary;
    };

export interface DailySummary {
  completed: number;
  failed: number;
  humanRequired: number;
  pending: number;
  date: string;
}

export class SlackNotifier {
  private webhookUrl: string;

  constructor() {
    this.webhookUrl = config.slackWebhookUrl;
  }

  get isEnabled(): boolean {
    return this.webhookUrl.length > 0;
  }

  async notifyHumanRequired(
    project: string,
    taskWhat: string,
    reason: string,
    suggestion?: string,
  ): Promise<void> {
    await this.send({
      type: "task_human_required",
      project,
      taskWhat,
      reason,
      suggestion,
    });
  }

  async notifyRetryLimitReached(
    project: string,
    taskWhat: string,
    reason: string,
    retryCount: number,
    maxRetry: number,
  ): Promise<void> {
    await this.send({
      type: "task_retry",
      project,
      taskWhat,
      reason,
      retryCount,
      maxRetry,
    });
  }

  async notifyDailySummary(summary: DailySummary): Promise<void> {
    await this.send({
      type: "daily_summary",
      summary,
    });
  }

  async notifyCycleSummary(summary: CycleSummary): Promise<void> {
    await this.send({
      type: "cycle_summary",
      cycleSummary: summary,
    });
  }

  private async send(payload: NotificationPayload): Promise<void> {
    if (!this.isEnabled) {
      return;
    }

    const blocks = this.buildSlackBlocks(payload);

    try {
      const response = await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blocks }),
      });

      if (!response.ok) {
        console.error(`[Notifier] Slack webhook failed: ${response.status} ${response.statusText}`);
      }
    } catch {
      // 通知失敗はタスク実行に影響させない
      console.error("[Notifier] Slack webhook request failed");
    }
  }

  private buildSlackBlocks(payload: NotificationPayload): SlackBlock[] {
    if (payload.type === "daily_summary") {
      return this.buildDailySummaryBlocks(payload.summary);
    }

    if (payload.type === "cycle_summary") {
      return this.buildCycleSummaryBlocks(payload.cycleSummary);
    }

    const emoji = this.getEmoji(payload.type);
    const title = this.getTitle(payload.type);

    const blocks: SlackBlock[] = [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `${emoji} ${title}`,
        },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Project:*\n${payload.project}` },
          { type: "mrkdwn", text: `*Task:*\n${payload.taskWhat}` },
        ],
      },
    ];

    if (payload.reason) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `*Reason:*\n${payload.reason}` },
      });
    }

    if (payload.suggestion) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `*Suggestion:*\n${payload.suggestion}` },
      });
    }

    if (payload.retryCount !== undefined && payload.maxRetry !== undefined) {
      blocks.push({
        type: "context",
        elements: [
          { type: "mrkdwn", text: `Retry: ${payload.retryCount}/${payload.maxRetry}` },
        ],
      });
    }

    return blocks;
  }

  private buildDailySummaryBlocks(summary: DailySummary): SlackBlock[] {
    return [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `📊 Daily Report: ${summary.date}`,
        },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Completed:*\n${summary.completed}` },
          { type: "mrkdwn", text: `*Failed:*\n${summary.failed}` },
          { type: "mrkdwn", text: `*Human Required:*\n${summary.humanRequired}` },
          { type: "mrkdwn", text: `*Pending:*\n${summary.pending}` },
        ],
      },
    ];
  }

  private buildCycleSummaryBlocks(summary: CycleSummary): SlackBlock[] {
    const total = summary.results.length;
    const succeeded = summary.results.filter((r) => r.exitCode === 0).length;
    const failed = total - succeeded;

    const headerText = failed > 0
      ? `📊 Scheduler Cycle: ${total}件実行 (${succeeded}成功 / ${failed}失敗)`
      : `📊 Scheduler Cycle: ${total}件実行 (${succeeded}成功)`;

    const taskLines = summary.results.map((r) => {
      const emoji = r.exitCode === 0 ? "✅" : "❌";
      const duration = r.exitCode === 0 ? ` (${this.formatDuration(r.durationMs)})` : "";
      const failInfo = r.failReason ? ` — ${r.failReason}` : "";
      const summaryInfo = r.summary ? ` — ${r.summary}` : "";
      const detail = r.exitCode === 0 ? summaryInfo : failInfo;
      return `${emoji} \`${r.project}\` [${r.taskType}] ${r.description}${detail}${duration}`;
    });

    const blocks: SlackBlock[] = [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: headerText,
        },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Total:*\n${total}` },
          { type: "mrkdwn", text: `*Duration:*\n${this.formatDuration(summary.totalDurationMs)}` },
        ],
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Tasks:*\n${taskLines.join("\n")}`,
        },
      },
    ];

    if (summary.rateLimitSkipped && summary.rateLimitSkipped > 0) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `⚠️ リミット到達: ${summary.rateLimitSkipped}件スキップ`,
        },
      });
    }

    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Cycle completed at ${this.formatJstDateTime(summary.completedAt)}`,
        },
      ],
    });

    return blocks;
  }

  private formatDuration(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }

  private formatJstDateTime(isoString: string): string {
    const date = new Date(isoString);
    const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
    const year = jst.getUTCFullYear();
    const month = String(jst.getUTCMonth() + 1).padStart(2, "0");
    const day = String(jst.getUTCDate()).padStart(2, "0");
    const hours = String(jst.getUTCHours()).padStart(2, "0");
    const mins = String(jst.getUTCMinutes()).padStart(2, "0");
    return `${year}-${month}-${day} ${hours}:${mins} JST`;
  }

  private getEmoji(type: NotificationType): string {
    const map: Record<NotificationType, string> = {
      cycle_summary: "📊",
      task_human_required: "🙋",
      task_retry: "🔄",
      daily_summary: "📊",
    };
    return map[type];
  }

  private getTitle(type: NotificationType): string {
    const map: Record<NotificationType, string> = {
      cycle_summary: "Scheduler Cycle Summary",
      task_human_required: "Human Decision Required",
      task_retry: "Retry Limit Reached",
      daily_summary: "Daily Summary",
    };
    return map[type];
  }
}
