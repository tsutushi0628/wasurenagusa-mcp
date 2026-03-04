/**
 * エラーメッセージからファイルパス情報をサニタイズする。
 * MCPクライアントに返すエラーメッセージで内部パス構造が漏洩するのを防ぐ。
 */
export function sanitizeErrorMessage(message: string): string {
  if (message.length === 0) return message;

  let sanitized = message;

  // /Users/..., /home/..., /var/..., /tmp/... 等の絶対パスを置換
  // パスは空白またはクォートまでの連続する非空白文字
  sanitized = sanitized.replace(/(?:\/(?:Users|home|var|tmp|opt|etc|usr))\S*/g, "[path]");

  // .wasurenagusa/ を含む相対パス的な文字列を置換
  sanitized = sanitized.replace(/\.wasurenagusa\/\S*/g, "[path]");

  return sanitized;
}
