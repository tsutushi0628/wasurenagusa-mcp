import type { ClaudeCliOptions } from "../types.js";

export const AUTONOMOUS_DEFAULT_OPTIONS: ClaudeCliOptions = {
  maxTurns: 100,
  timeoutMs: 1800000,
  allowedTools: ["Edit", "Write", "Read", "Glob", "Grep", "Bash", "TodoWrite"],
};

export const MAX_RETRY_COUNT = 3;
export const MAX_STDOUT_LENGTH = 50000;
