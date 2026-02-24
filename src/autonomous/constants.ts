import type { ClaudeCliOptions } from "../types.js";

export const AUTONOMOUS_DEFAULT_OPTIONS: ClaudeCliOptions = {
  maxTurns: 100,
  timeoutMs: 1800000,
  allowedTools: ["Edit", "Write", "Read", "Glob", "Grep", "Bash", "TodoWrite"],
};

export const MAX_RETRY_COUNT = 3;
export const MAX_STDOUT_LENGTH = 50000;

/**
 * テンプレート文面の検出パターン。
 * task_submit や spec-update のバリデーションで使用。
 * テンプレをそのまま投入した場合を弾く。
 */
export const TEMPLATE_PATTERNS: RegExp[] = [
  /なぜやるか/,
  /何をやるか/,
  /完了条件/,
  /プロジェクト一覧/,
  /コピペ/,
  /（.+）$/,
  /具体的な/,
  /ここに/,
];
