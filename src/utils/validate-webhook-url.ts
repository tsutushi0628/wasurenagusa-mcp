export interface WebhookValidationResult {
  valid: boolean;
  url: string;
  reason?: string;
}

/**
 * Slack Webhook URLのバリデーション。
 * - 空文字列はOK（webhook無効）
 * - https + hooks.slack.com ドメインのみ許可
 */
export function validateWebhookUrl(url: string): WebhookValidationResult {
  if (url === "") {
    return { valid: true, url: "" };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, url, reason: "Invalid URL format" };
  }

  if (parsed.protocol !== "https:") {
    return { valid: false, url, reason: "Only HTTPS is allowed" };
  }

  if (parsed.hostname !== "hooks.slack.com") {
    return { valid: false, url, reason: "Only hooks.slack.com domain is allowed" };
  }

  return { valid: true, url };
}
