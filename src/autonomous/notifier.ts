import { config } from "../config.js";

export type NotificationType =
  | "task_completed"
  | "task_failed"
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

// Discriminated union: daily_summaryとそれ以外でペイロード型を分離
type NotificationPayload =
  | {
      type: "task_completed" | "task_failed" | "task_human_required" | "task_retry";
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

  async notifyTaskCompleted(project: string, taskWhat: string, reason: string): Promise<void> {
    await this.send({
      type: "task_completed",
      project,
      taskWhat,
      reason,
    });
  }

  async notifyTaskFailed(project: string, taskWhat: string, reason: string): Promise<void> {
    await this.send({
      type: "task_failed",
      project,
      taskWhat,
      reason,
    });
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

  private getEmoji(type: NotificationType): string {
    const map: Record<NotificationType, string> = {
      task_completed: "✅",
      task_failed: "❌",
      task_human_required: "🙋",
      task_retry: "🔄",
      daily_summary: "📊",
    };
    return map[type];
  }

  private getTitle(type: NotificationType): string {
    const map: Record<NotificationType, string> = {
      task_completed: "Task Completed",
      task_failed: "Task Failed",
      task_human_required: "Human Decision Required",
      task_retry: "Retry Limit Reached",
      daily_summary: "Daily Summary",
    };
    return map[type];
  }
}
