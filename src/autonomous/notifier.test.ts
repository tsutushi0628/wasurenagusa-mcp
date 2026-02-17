import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { DailySummary } from "./notifier.js";

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

  describe("notifyTaskCompleted", () => {
    it("Slack webhookにBlock Kit形式でPOSTする", async () => {
      const { SlackNotifier } = await import("./notifier.js");
      const notifier = new SlackNotifier();

      await notifier.notifyTaskCompleted("my-project", "テスト実行", "全条件クリア");

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe("https://hooks.slack.com/services/T00/B00/xxx");
      expect(options.method).toBe("POST");
      expect(options.headers["Content-Type"]).toBe("application/json");

      const body = JSON.parse(options.body);
      expect(body.blocks).toBeDefined();
      expect(body.blocks.length).toBeGreaterThanOrEqual(2);

      // header block
      expect(body.blocks[0].type).toBe("header");
      expect(body.blocks[0].text.text).toContain("Task Completed");

      // section with project and task
      expect(body.blocks[1].type).toBe("section");
      const fieldTexts = body.blocks[1].fields.map((f: { text: string }) => f.text);
      expect(fieldTexts.some((t: string) => t.includes("my-project"))).toBe(true);
      expect(fieldTexts.some((t: string) => t.includes("テスト実行"))).toBe(true);
    });
  });

  describe("notifyTaskFailed", () => {
    it("失敗通知をPOSTする", async () => {
      const { SlackNotifier } = await import("./notifier.js");
      const notifier = new SlackNotifier();

      await notifier.notifyTaskFailed("my-project", "ビルド", "Exit code: 1");

      expect(mockFetch).toHaveBeenCalledOnce();
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.blocks[0].text.text).toContain("Task Failed");
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

  describe("未設定時の挙動", () => {
    it("webhookUrl未設定時はfetchを呼ばない", async () => {
      mockWebhookUrl = "";
      const { SlackNotifier } = await import("./notifier.js");
      const notifier = new SlackNotifier();

      await notifier.notifyTaskCompleted("project", "task", "reason");

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("エラーハンドリング", () => {
    it("webhook応答がエラーでも例外をスローしない", async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: "Internal Server Error" });
      const { SlackNotifier } = await import("./notifier.js");
      const notifier = new SlackNotifier();

      // 例外なく完了する
      await expect(
        notifier.notifyTaskCompleted("project", "task", "reason"),
      ).resolves.toBeUndefined();
    });

    it("fetchが例外をスローしても例外をスローしない", async () => {
      mockFetch.mockRejectedValue(new Error("Network error"));
      const { SlackNotifier } = await import("./notifier.js");
      const notifier = new SlackNotifier();

      await expect(
        notifier.notifyTaskFailed("project", "task", "reason"),
      ).resolves.toBeUndefined();
    });
  });
});
