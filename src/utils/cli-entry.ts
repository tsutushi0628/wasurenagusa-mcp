import { realpathSync } from "fs";
import { fileURLToPath } from "url";

const SECRET_VALUE_PATTERN = /(?:\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{20,}\b|\bsk-[A-Za-z0-9_-]{20,}\b|\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_-]{20,}\b|\bBearer\s+\S+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b)/giu;
const SENSITIVE_ASSIGNMENT_PATTERN = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|authorization)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const MAX_CLI_ERROR_STACK_FRAMES = 3;
const MAX_CLI_ERROR_MESSAGE_LENGTH = 500;

/**
 * CLI起動時のargv1が呼び出し元モジュール自身か判定する。
 *
 * npm binのsymlink経由ではargv1とimport.meta.urlのパス表記が異なるため、両方を実体化して比べる。
 * realpath失敗時は生パス一致へ戻し、判定不能時に従来の直接実行を止めない。
 *
 * @param argv1 process.argv[1]
 * @param moduleUrl 呼び出し側モジュールの import.meta.url
 */
export function isDirectRun(argv1: string | undefined, moduleUrl: string): boolean {
  if (argv1 === undefined) return false;

  const modulePath = fileURLToPath(moduleUrl);
  try {
    return realpathSync(argv1) === realpathSync(modulePath);
  } catch {
    return argv1 === modulePath;
  }
}

/**
 * このモジュールが CLI として直接起動されたか判定する（import 時は false）。
 *
 * npm の bin はグローバル導入時に symlink になり、process.argv[1] には symlink パスが
 * そのまま渡る一方、import.meta.url は realpath に解決される。素朴な文字列一致だと
 * bin 経由の起動で一致せず main() が走らないため、両者を realpath に正規化して比較する。
 * 直叩き・Windows の .cmd shim・テストからの import のいずれでも正しく判定できる。
 *
 * @param importMetaUrl 呼び出し側モジュールの import.meta.url
 */
export function isMainModule(importMetaUrl: string): boolean {
  return isDirectRun(process.argv[1], importMetaUrl);
}

function redactCliErrorText(value: string): string {
  return value
    .replace(SENSITIVE_ASSIGNMENT_PATTERN, "$1[REDACTED]")
    .replace(SECRET_VALUE_PATTERN, "[REDACTED]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----.*$/iu, "[REDACTED PRIVATE KEY]")
    .replace(/(?<=:\/\/)[^:/@\s]+:[^@\s]+@/gu, "[REDACTED]@");
}

export function formatCliErrorDetails(error: unknown): string {
  if (!(error instanceof Error)) return "non-Error value thrown";

  let message = error.message;
  if (/[\r\n]/u.test(message)) message = "multiline error message omitted";
  if (message.length > MAX_CLI_ERROR_MESSAGE_LENGTH) {
    message = `${message.slice(0, MAX_CLI_ERROR_MESSAGE_LENGTH)}…`;
  }
  if (message === "") message = error.name;

  const stackFrames = (error.stack ?? "")
    .split(/\r?\n/u)
    .filter((line) => /^\s+at\s/u.test(line))
    .slice(0, MAX_CLI_ERROR_STACK_FRAMES)
    .map(redactCliErrorText);

  return [redactCliErrorText(message), ...stackFrames].join("\n");
}

export function reportCliFailure(command: string, error: unknown): void {
  const [message, ...stackFrames] = formatCliErrorDetails(error).split("\n");
  const details = stackFrames.length === 0 ? "" : `\n${stackFrames.join("\n")}`;
  process.stderr.write(`[${command}] 実行失敗: ${message}${details}\n`);
  process.exitCode = 1;
}
