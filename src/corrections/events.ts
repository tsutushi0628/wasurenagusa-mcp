import { redactSensitive } from "../utils/redact-sensitive-data.js";

export type OwnerEventSource = "user" | "queued_command" | "hook";

export type OwnerEvent = {
  sourceType: OwnerEventSource;
  text: string;
  segments: string[];
  hasSensitiveValue: boolean;
  isSlashCommand: boolean;
  isHandoffPaste: boolean;
  isOversized: boolean;
  isPasteCandidate: boolean;
  sessionId?: string;
  uuid?: string;
  position?: string | number;
  order?: number;
  availableOrder?: number;
  timestamp?: string | number;
  availableAt?: string | number;
  transcriptByteOffset?: number;
};

const SYSTEM_REMINDER = /<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder\s*>/giu;
const IDE_BLOCK = /<ide_[\w-]+\b[^>]*>[\s\S]*?<\/ide_[\w-]+\s*>/giu;
const IDE_EMPTY = /<ide_[\w-]+\b[^>]*\/?>/giu;
const XML_QUOTATION = /<(?:quote|quoted|quoted[-_]?text|quoted[-_]?data|citation|blockquote)\b[^>]*>[\s\S]*?<\/(?:quote|quoted|quoted[-_]?text|quoted[-_]?data|citation|blockquote)\s*>/giu;
const HANDOFF_MARKER = /(?:復帰ブロック|引継ぎ命令テキスト|引き継ぎ命令テキスト|引継ぎブロック|引き継ぎブロック|復帰用(?:ブロック|指示)|引継ぎ用(?:ブロック|指示)|handoff[- _]?text\.md|resume(?:\s|-)?block)/iu;
const SLASH_COMMAND = /^\/[a-z][a-z0-9-]*(?:\s|$)/iu;
const AUTOMATED_PROMPT_PREFIXES = ["<task-notification", "<system-reminder", "<command-message>"] as const;
const SECRET_VALUE = /\b(?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{8,}|\b(?:sk|pk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b|\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/giu;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu;
const HOME_PATH = /\/(?:Users|home)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*/gu;
const WINDOWS_HOME_PATH = /[A-Z]:\\Users\\[^\s"'<>]+/giu;
const EMAIL_ADDRESS = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const QUOTED_SPAN = /"[\s\S]*?"|'[^'\n]*'|「[\s\S]*?」|『[\s\S]*?』|“[\s\S]*?”|‘[\s\S]*?’/gu;
const INLINE_CODE = /`+[^`\n]*`+/gu;
const CONDITION_ONLY_TAIL = /(?:場合|とき|時|なら|以外|に限り|限り|条件|だけ|のみ)(?:は|に|で|なら|だけ)?$/u;
const CONDITION_ACTION = /(?:答え|回答|返事|待機|待つ|止ま|停止|出す|示す|提示|見せ|表示|使う|説明|置換|言い換|避け|控え|制限|解除|まとめ|短く|維持|再利用|変更|変え|確認|検証|照合|保存|配置|保持|保管|担当|任せ|委譲|実行|作成|書く)/u;

type RecordValue = Record<string, unknown>;

function asRecord(value: unknown): RecordValue | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as RecordValue;
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .filter((part) => {
      const record = asRecord(part);
      return record?.type === "text" && typeof record.text === "string";
    })
    .map((part) => String((part as RecordValue).text))
    .join("\n");
}

function redactSensitiveValues(value: string): { text: string; hasSensitiveValue: boolean } {
  let text = redactSensitive(value);
  let hasSensitiveValue = text !== value;
  const patterns = [SECRET_VALUE, PRIVATE_KEY, HOME_PATH, WINDOWS_HOME_PATH, EMAIL_ADDRESS];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, () => {
      hasSensitiveValue = true;
      return "[REDACTED]";
    });
  }
  return { text, hasSensitiveValue };
}

function normalizeLineEndings(value: string): string {
  return value.normalize("NFKC").replace(/\r\n?/gu, "\n");
}

export function removeQuotedAndInjectedContent(value: string): string {
  let text = value
    .replace(SYSTEM_REMINDER, " ")
    .replace(IDE_BLOCK, " ")
    .replace(IDE_EMPTY, " ")
    .replace(XML_QUOTATION, " ");
  text = text.replace(/```[\s\S]*?(?:```|$)/gu, " ").replace(/~~~[\s\S]*?(?:~~~|$)/gu, " ");
  text = text.replace(INLINE_CODE, " ");
  text = text.split("\n").filter((line) => !/^\s{0,3}>/u.test(line)).join("\n");
  text = text.replace(QUOTED_SPAN, " ");
  return text;
}

function normalizeDetectionText(value: string): string {
  return value.replace(/[\t\f\v ]+/gu, " ").replace(/ *\n */gu, "\n").trim();
}

function splitSentences(value: string): string[] {
  const fragments = value
    .split(/\n+/u)
    .flatMap((line) => line.match(/[^。！？!?]+[。！？!?]?/gu) ?? [])
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const sentences: string[] = [];
  for (const fragment of fragments) {
    const previous = sentences.at(-1);
    if (previous && CONDITION_ONLY_TAIL.test(previous) && !CONDITION_ACTION.test(previous)) {
      sentences[sentences.length - 1] = `${previous} ${fragment}`;
    } else {
      sentences.push(fragment);
    }
  }
  return sentences;
}

function isSlashCommand(value: string): boolean {
  const firstLine = value.split("\n", 1)[0].trim();
  return SLASH_COMMAND.test(firstLine);
}

export function isHandoffPaste(value: string): boolean {
  return HANDOFF_MARKER.test(value);
}

export function isAutomatedPrompt(value: string): boolean {
  const trimmedValue = value.trimStart();
  if (trimmedValue.startsWith("keep-alive:")) return true;
  const lowerCaseValue = trimmedValue.toLowerCase();
  return AUTOMATED_PROMPT_PREFIXES.some((prefix) => lowerCaseValue.startsWith(prefix));
}

function optionalString(record: RecordValue | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(record: RecordValue | null, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalPosition(record: RecordValue | null): string | number | undefined {
  const value = record?.position;
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function optionalTime(record: RecordValue | null, key: string): string | number | undefined {
  const value = record?.[key];
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function hasOriginKind(record: RecordValue | null, kind: string): boolean {
  const origin = asRecord(record?.origin);
  return origin?.kind === kind;
}

function buildOwnerEvent(
  input: RecordValue,
  sourceType: OwnerEventSource,
  rawText: string,
  fallbackRecord?: RecordValue | null,
): OwnerEvent | null {
  if (!rawText.trim() || isAutomatedPrompt(rawText)) return null;
  const redacted = redactSensitiveValues(rawText);
  const normalized = normalizeLineEndings(redacted.text);
  const cleaned = normalizeDetectionText(removeQuotedAndInjectedContent(normalized));
  const segments = splitSentences(cleaned);
  const text = normalizeDetectionText(segments.join(" "));
  if (!text) return null;

  const characterCount = Array.from(normalized).length;
  const isOversized = characterCount > 2000;
  const isSlash = isSlashCommand(text);
  const isHandoff = isHandoffPaste(normalized);
  const event: OwnerEvent = {
    sourceType,
    text,
    segments,
    hasSensitiveValue: redacted.hasSensitiveValue,
    isSlashCommand: isSlash,
    isHandoffPaste: isHandoff,
    isOversized,
    isPasteCandidate: isOversized || isHandoff,
  };

  const uuid = optionalString(input, "uuid") ?? optionalString(fallbackRecord ?? null, "uuid");
  const position = optionalPosition(input) ?? optionalPosition(fallbackRecord ?? null);
  const sessionId = optionalString(input, "sessionId") ?? optionalString(fallbackRecord ?? null, "sessionId");
  const order = optionalNumber(input, "order") ?? optionalNumber(fallbackRecord ?? null, "order");
  const availableOrder = optionalNumber(input, "availableOrder") ?? optionalNumber(fallbackRecord ?? null, "availableOrder");
  const timestamp = optionalTime(input, "timestamp") ?? optionalTime(fallbackRecord ?? null, "timestamp");
  const availableAt = optionalTime(input, "availableAt") ?? optionalTime(fallbackRecord ?? null, "availableAt");
  const transcriptByteOffset = optionalNumber(input, "transcriptByteOffset") ?? optionalNumber(fallbackRecord ?? null, "transcriptByteOffset");
  if (sessionId) event.sessionId = sessionId;
  if (uuid) event.uuid = uuid;
  if (position !== undefined) event.position = position;
  if (order !== undefined) event.order = order;
  if (availableOrder !== undefined) event.availableOrder = availableOrder;
  if (timestamp !== undefined) event.timestamp = timestamp;
  if (availableAt !== undefined) event.availableAt = availableAt;
  if (transcriptByteOffset !== undefined) event.transcriptByteOffset = transcriptByteOffset;
  return event;
}

export function extractOwnerEvent(value: unknown): OwnerEvent | null {
  const input = asRecord(value);
  if (!input || input.isSidechain === true) return null;

  if (input.type === "user") {
    if (!hasOriginKind(input, "human")) return null;
    const message = asRecord(input.message);
    if (input.isMeta === true || message?.isMeta === true || input.promptSource === "system") return null;
    const rawText = textFromContent(message?.content);
    return buildOwnerEvent(input, "user", rawText, message);
  }

  if (input.type === "attachment") {
    const attachment = asRecord(input.attachment);
    if (attachment?.type !== "queued_command" || attachment.commandMode !== "prompt") return null;
    if (!hasOriginKind(input, "human") && !hasOriginKind(attachment, "human")) return null;
    const rawText = textFromContent(attachment.prompt);
    return buildOwnerEvent(input, "queued_command", rawText, attachment);
  }

  if (input.hookEventName === "UserPromptSubmit") {
    const stdin = asRecord(input.stdin);
    const rawText = textFromContent(input.prompt ?? stdin?.prompt);
    return buildOwnerEvent(input, "hook", rawText);
  }

  return null;
}
