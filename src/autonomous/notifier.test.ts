import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { DailySummary, CycleSummary } from "./notifier.js";

// fetchをモック
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// configをモック
let mockWebhookUrl = "https://hooks.slack.com/services/T00/B00/xxx";
vi.mock("../config.js", () => ({
  config: {
    get slackWebhookUrl() {
      return mockWebhookUrl;
    },
  },
}));

describe("SlackNotifier", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true });
    mockWebhookUrl = "https://hooks.slack.com/services/T00/B00/xxx";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("isEnabled", () => {
    it("webhookUrl設定時はtrueを返す", async () => {
      const { SlackNotifier } = await import("./notifier.js");
      const notifier = new SlackNotifier();
      expect(notifier.isEnabled).toBe(true);
    });

    it("webhookUrl未設定時はfalseを返す", async () => {
      mockWebhookUrl = "";
      const { SlackNotifier } = await import("./notifier.js");
      const notifier = new SlackNotifier();
      expect(notifier.isEnabled).toBe(false);
    });
  });

  describe("notifyCycleSummary", () => {
    it("成功+失敗混在のサマリーをBlock Kit形式でPOSTする", async () => {
      const { SlackNotifier } = await import("./notifier.js");
      const notifier = new SlackNotifier();

      const summary: CycleSummary = {
        results: [
          {
            project: "my-project",
            taskType: "autonomous",
            description: "テスト追加",
            exitCode: 0,
            durationMs: 192000,
          },
          {
            project: "other-project",
            taskType: "autonomous",
            description: "ビルド修正",
            exitCode: 1,
            durationMs: 5000,
            failReason: "Exit code: 1",
          },
          {
            project: "project-a",
            taskType: "change-based",
            description: "spec更新",
            summary: "structure.mdの1行修正",
            exitCode: 0,
            durationMs: 130000,
          },
        ],
        totalDurationMs: 754000,
        completedAt: "2026-02-18T18:15:00.000Z",
      };

      await notifier.notifyCycleSummary(summary);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe("https://hooks.slack.com/services/T00/B00/xxx");
      expect(options.method).toBe("POST");

      const body = JSON.parse(options.body);
      expect(body.blocks).toBeDefined();
      expect(body.blocks.length).toBe(4);

      // header block: 件数と成功/失敗数
      expect(body.blocks[0].type).toBe("header");
      expect(body.blocks[0].text.text).toContain("3件実行");
      expect(body.blocks[0].text.text).toContain("2成功");
      expect(body.blocks[0].text.text).toContain("1失敗");

      // section with total and duration
      expect(body.blocks[1].type).toBe("section");
      expect(body.blocks[1].fields[0].text).toContain("3");
      expect(body.blocks[1].fields[1].text).toContain("Duration");

      // tasks section
      expect(body.blocks[2].type).toBe("section");
      const tasksText = body.blocks[2].text.text;
      expect(tasksText).toContain("my-project");
      expect(tasksText).toContain("[autonomous]");
      expect(tasksText).toContain("テスト追加");
      expect(tasksText).toContain("other-project");
      expect(tasksText).toContain("Exit code: 1");
      expect(tasksText).toContain("project-a");
      expect(tasksText).toContain("[change-based]");
      expect(tasksText).toContain("spec更新");
      expect(tasksText).toContain("structure.mdの1行修正");

      // context block: completion time
      expect(body.blocks[3].type).toBe("context");
      expect(body.blocks[3].elements[0].text).toContain("Cycle completed at");
      expect(body.blocks[3].elements[0].text).toContain("JST");
    });

    it("全成功パターンではヘッダーに失敗数を含めない", async () => {
      const { SlackNotifier } = await import("./notifier.js");
      const notifier = new SlackNotifier();

      const summary: CycleSummary = {
        results: [
          {
            project: "my-project",
            taskType: "autonomous",
            description: "テスト追加",
            exitCode: 0,
            durationMs: 120000,
          },
        ],
        totalDurationMs: 120000,
        completedAt: "2026-02-18T18:15:00.000Z",
      };

      await notifier.notifyCycleSummary(summary);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.blocks[0].text.text).toContain("1件実行 (1成功)");
      expect(body.blocks[0].text.text).not.toContain("失敗");
    });

    it("失敗のみパターンでも正しく表示する", async () => {
      const { SlackNotifier } = await import("./notifier.js");
      const notifier = new SlackNotifier();

      const summary: CycleSummary = {
        results: [
          {
            project: "bad-project",
            taskType: "autonomous",
            description: "テスト",
            exitCode: 1,
            durationMs: 2000,
            failReason: "バリデーション失敗: フィールド \"why\" が空",
          },
        ],
        totalDurationMs: 2000,
        completedAt: "2026-02-18T18:15:00.000Z",
      };

      await notifier.notifyCycleSummary(summary);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.blocks[0].text.text).toContain("0成功 / 1失敗");
      expect(body.blocks[2].text.text).toContain("バリデーション失敗");
    });

    it("webhookUrl未設定時はfetchを呼ばない", async () => {
      mockWebhookUrl = "";
      const { SlackNotifier } = await import("./notifier.js");
      const notifier = new SlackNotifier();

      await notifier.notifyCycleSummary({
        results: [],
        totalDurationMs: 0,
        completedAt: new Date().toISOString(),
      });

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("notifyHumanRequired", () => {
    it("human-required通知をsuggestion付きでPOSTする", async () => {
      const { SlackNotifier } = await import("./notifier.js");
      const notifier = new SlackNotifier();

      await notifier.notifyHumanRequired(
        "my-project", "ライセンス選択", "人間の判断が必要", "MITがおすすめ",
      );

      expect(mockFetch).toHaveBeenCalledOnce();
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.blocks[0].text.text).toContain("Human Decision Required");

      // suggestion blockが含まれる
      const suggestionBlock = body.blocks.find(
        (b: { text?: { text: string } }) => b.text?.text?.includes("Suggestion"),
      );
      expect(suggestionBlock).toBeDefined();
    });

    it("suggestion無しでもPOSTできる", async () => {
      const { SlackNotifier } = await import("./notifier.js");
      const notifier = new SlackNotifier();

      await notifier.notifyHumanRequired("my-project", "判断必要", "理由");

      expect(mockFetch).toHaveBeenCalledOnce();
    });
  });

  describe("notifyRetryLimitReached", () => {
    it("リトライ上限通知にリトライ回数を含める", async () => {
      const { SlackNotifier } = await import("./notifier.js");
      const notifier = new SlackNotifier();

      await notifier.notifyRetryLimitReached(
        "my-project", "テスト修正", "3回失敗", 3, 3,
      );

      expect(mockFetch).toHaveBeenCalledOnce();
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.blocks[0].text.text).toContain("Retry Limit Reached");

      // context blockにリトライ回数
      const contextBlock = body.blocks.find(
        (b: { type: string }) => b.type === "context",
      );
      expect(contextBlock).toBeDefined();
      expect(contextBlock.elements[0].text).toContain("3/3");
    });
  });

  describe("notifyDailySummary", () => {
    it("日次サマリをPOSTする", async () => {
      const { SlackNotifier } = await import("./notifier.js");
      const notifier = new SlackNotifier();

      const summary: DailySummary = {
        completed: 5,
        failed: 1,
        humanRequired: 2,
        pending: 3,
        date: "2026-02-16",
      };

      await notifier.notifyDailySummary(summary);

      expect(mockFetch).toHaveBeenCalledOnce();
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.blocks[0].text.text).toContain("Daily Report");
      expect(body.blocks[0].text.text).toContain("2026-02-16");
    });
  });

  describe("エラーハンドリング", () => {
    it("webhook応答がエラーでも例外をスローしない", async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: "Internal Server Error" });
      const { SlackNotifier } = await import("./notifier.js");
      const notifier = new SlackNotifier();

      await expect(
        notifier.notifyCycleSummary({
          results: [{ project: "p", taskType: "autonomous", description: "t", exitCode: 0, durationMs: 1000 }],
          totalDurationMs: 1000,
          completedAt: new Date().toISOString(),
        }),
      ).resolves.toBeUndefined();
    });

    it("fetchが例外をスローしても例外をスローしない", async () => {
      mockFetch.mockRejectedValue(new Error("Network error"));
      const { SlackNotifier } = await import("./notifier.js");
      const notifier = new SlackNotifier();

      await expect(
        notifier.notifyHumanRequired("project", "task", "reason"),
      ).resolves.toBeUndefined();
    });
  });
});
