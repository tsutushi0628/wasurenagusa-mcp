import { describe, it, expect } from "vitest";
import { validateWebhookUrl } from "./validate-webhook-url.js";

describe("validateWebhookUrl", () => {
  it("空文字列は有効（webhook無効を意味する）", () => {
    expect(validateWebhookUrl("")).toEqual({ valid: true, url: "" });
  });

  it("正しいSlack Webhook URLは有効", () => {
    const url = "https://hooks.slack.com/services/TEST/TEST/test";
    expect(validateWebhookUrl(url)).toEqual({ valid: true, url });
  });

  it("hooks.slack.com の別パスも有効", () => {
    const url = "https://hooks.slack.com/workflows/T00000000/something";
    expect(validateWebhookUrl(url)).toEqual({ valid: true, url });
  });

  it("HTTPプロトコルは無効", () => {
    const url = "http://hooks.slack.com/services/T00000000/B00000000/XXX";
    const result = validateWebhookUrl(url);
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("hooks.slack.com 以外のドメインは無効", () => {
    const url = "https://evil.example.com/services/T00000000/B00000000/XXX";
    const result = validateWebhookUrl(url);
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("hooks.slack.com のサブドメインは無効", () => {
    const url = "https://evil.hooks.slack.com/services/T00000000/B00000000/XXX";
    const result = validateWebhookUrl(url);
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("不正なURLフォーマットは無効", () => {
    const result = validateWebhookUrl("not-a-url");
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("javascript: スキームは無効", () => {
    const result = validateWebhookUrl("javascript:alert(1)");
    expect(result.valid).toBe(false);
  });

  it("file: スキームは無効", () => {
    const result = validateWebhookUrl("file:///etc/passwd");
    expect(result.valid).toBe(false);
  });
});
