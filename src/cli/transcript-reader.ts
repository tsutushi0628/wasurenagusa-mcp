/**
 * トランスクリプトJSONL読み込み
 * analyze.tsから抽出。テスト可能にするため独立モジュール化。
 */

import { createHash } from "node:crypto";
import { open, readFile } from "fs/promises";
import { ParsedMessage } from "../analyzer/conversation-meta.js";

export const MAX_TRANSCRIPT_DELTA_BYTES = 2 * 1024 * 1024;
export const MAX_TRANSCRIPT_HUMAN_MESSAGES = 200;
const TRANSCRIPT_IDENTITY_WINDOW_BYTES = 64;

export interface TranscriptCursor {
  offset: number;
  identity: string;
}

export interface TranscriptEntry {
  type?: string;
  uuid?: string;
  message?: {
    role?: string;
    content?: string | Array<{ type: string; text?: string }>;
  };
  [key: string]: unknown;
}

export interface TranscriptRecord {
  byteOffset: number;
  byteEndOffset: number;
  entry: TranscriptEntry;
}

export interface TranscriptDelta {
  records: TranscriptRecord[];
  nextCursor: TranscriptCursor;
  bytesRead: number;
  humanMessagesRead: number;
  incompleteTail: boolean;
  reset: boolean;
  hasMore: boolean;
}

interface LegacyTranscriptEntry {
  type: string;
  message?: {
    role: string;
    content: string | Array<{ type: string; text?: string }>;
  };
}

export interface TranscriptResult {
  conversationLog: string;
  parsedMessages: ParsedMessage[];
}

function isRecord(value: unknown): value is TranscriptEntry {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHumanOrigin(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const origin = (value as Record<string, unknown>).origin;
  if (!origin || typeof origin !== "object" || Array.isArray(origin)) return false;
  return (origin as Record<string, unknown>).kind === "human";
}

function isHumanTranscriptEntry(entry: TranscriptEntry): boolean {
  if (entry.isSidechain === true) return false;
  if (entry.type === "user") {
    const message = entry.message as Record<string, unknown> | undefined;
    return isHumanOrigin(entry) &&
      entry.isMeta !== true &&
      message?.isMeta !== true &&
      entry.promptSource !== "system";
  }
  if (entry.type === "attachment") {
    const attachment = entry.attachment as Record<string, unknown> | undefined;
    return attachment?.type === "queued_command" &&
      attachment.commandMode === "prompt" &&
      (isHumanOrigin(entry) || isHumanOrigin(attachment));
  }
  return false;
}

function isAssistantActionEntry(entry: TranscriptEntry): boolean {
  if (entry.isSidechain === true) return false;
  const message = entry.message as Record<string, unknown> | undefined;
  if (message?.isMeta === true) return false;
  return entry.type === "assistant" || entry.type === "tool_use" || entry.type === "tool_result";
}

function markerHash(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function transcriptIdentity(device: number, inode: number, marker: Uint8Array): string {
  return `${device}:${inode}:${markerHash(marker)}`;
}

async function readAt(
  handle: Awaited<ReturnType<typeof open>>,
  length: number,
  position: number,
): Promise<Buffer> {
  if (length === 0) return Buffer.alloc(0);
  const buffer = Buffer.alloc(length);
  let bytesRead = 0;
  while (bytesRead < length) {
    const result = await handle.read(buffer, bytesRead, length - bytesRead, position + bytesRead);
    if (result.bytesRead === 0) break;
    bytesRead += result.bytesRead;
  }
  return buffer.subarray(0, bytesRead);
}

/** 完了済みJSONL行を、2MiB・200人間発話以内で読む。 */
export async function readTranscriptDelta(
  transcriptPath: string,
  cursor: TranscriptCursor = { offset: 0, identity: "" },
): Promise<TranscriptDelta> {
  if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0) {
    throw new Error("transcript cursor offset must be a non-negative safe integer");
  }

  const handle = await open(transcriptPath, "r");
  try {
    const stats = await handle.stat();
    const baseIdentity = `${stats.dev}:${stats.ino}:`;
    let bytesRead = 0;
    let reset = cursor.offset > stats.size;
    let priorMarker: Uint8Array = Buffer.alloc(0);

    if (!reset && cursor.offset > 0) {
      if (!cursor.identity.startsWith(baseIdentity)) {
        reset = true;
      } else {
        const markerStart = Math.max(0, cursor.offset - TRANSCRIPT_IDENTITY_WINDOW_BYTES);
        priorMarker = await readAt(handle, cursor.offset - markerStart, markerStart);
        bytesRead += priorMarker.length;
        if (transcriptIdentity(stats.dev, stats.ino, priorMarker) !== cursor.identity) {
          reset = true;
        }
      }
    }

    let startOffset = cursor.offset;
    if (reset) startOffset = 0;
    const contentBudget = MAX_TRANSCRIPT_DELTA_BYTES - bytesRead;
    const contentLength = Math.max(0, Math.min(stats.size - startOffset, contentBudget));
    const content = await readAt(handle, contentLength, startOffset);
    bytesRead += content.length;

    const records: TranscriptRecord[] = [];
    let humanMessagesRead = 0;
    let consumed = 0;
    let lineStart = 0;

    while (lineStart < content.length) {
      const lineEnd = content.indexOf(0x0a, lineStart);
      if (lineEnd < 0) break;
      const line = content.subarray(lineStart, lineEnd).toString("utf8");
      const byteEndOffset = startOffset + lineEnd + 1;
      if (line.trim()) {
        try {
          const parsed: unknown = JSON.parse(line);
          if (isRecord(parsed)) {
            records.push({
              byteOffset: startOffset + lineStart,
              byteEndOffset,
              entry: parsed,
            });
            if (isHumanTranscriptEntry(parsed)) humanMessagesRead += 1;
          }
        } catch {
          consumed = lineEnd + 1;
          lineStart = lineEnd + 1;
          continue;
        }
      }
      consumed = lineEnd + 1;
      lineStart = lineEnd + 1;
      if (humanMessagesRead >= MAX_TRANSCRIPT_HUMAN_MESSAGES) break;
    }

    const nextOffset = startOffset + consumed;
    let nextMarker: Uint8Array = Buffer.alloc(0);
    if (nextOffset > 0) {
      if (nextOffset === startOffset && startOffset > 0) {
        nextMarker = priorMarker;
      } else {
        const markerEnd = nextOffset - startOffset;
        const markerStart = Math.max(0, markerEnd - TRANSCRIPT_IDENTITY_WINDOW_BYTES);
        nextMarker = content.subarray(markerStart, markerEnd);
      }
    }

    const unconsumed = content.subarray(consumed);
    const incompleteTail = unconsumed.length > 0 && unconsumed.indexOf(0x0a) < 0;

    return {
      records,
      nextCursor: {
        offset: nextOffset,
        identity: transcriptIdentity(stats.dev, stats.ino, nextMarker),
      },
      bytesRead,
      humanMessagesRead,
      incompleteTail,
      reset,
      hasMore: nextOffset < stats.size,
    };
  } finally {
    await handle.close();
  }
}

/** 発話より前の同一区間にあるassistant/tool行だけを返す。 */
export function getPreviousAssistantContext(
  records: readonly TranscriptRecord[],
  correctionByteOffset: number,
): TranscriptRecord[] {
  const preceding = records.filter((record) => record.byteOffset < correctionByteOffset);
  let previousHumanEndOffset = 0;
  for (const record of preceding) {
    if (isHumanTranscriptEntry(record.entry)) previousHumanEndOffset = record.byteEndOffset;
  }
  return preceding.filter((record) =>
    record.byteOffset >= previousHumanEndOffset &&
    isAssistantActionEntry(record.entry),
  );
}

export async function readTranscript(transcriptPath: string): Promise<TranscriptResult> {
  const content = await readFile(transcriptPath, "utf-8");
  const lines = content.trim().split("\n");

  // 全行をパースし、user/assistantメッセージだけを抽出してから直近50件を取る
  // （tool_use/tool_resultがJSONLを埋め尽くすため、先にフィルタリングが必要）
  const messageEntries: Array<{ role: string; text: string }> = [];

  for (const line of lines) {
    try {
      const entry: LegacyTranscriptEntry = JSON.parse(line);
      if ((entry.type === "user" || entry.type === "assistant") && entry.message) {
        const role = entry.message.role;
        let text = "";
        if (typeof entry.message.content === "string") {
          text = entry.message.content;
        } else if (Array.isArray(entry.message.content)) {
          text = entry.message.content
            .filter(c => c.type === "text" && c.text)
            .map(c => c.text)
            .join("\n");
        }
        if (text) {
          messageEntries.push({ role, text });
        }
      }
    } catch {
      // JSONパースエラーは無視
    }
  }

  // フィルタ済みメッセージから直近50件を取得
  const recent = messageEntries.slice(-50);

  const formatted: string[] = [];
  const parsedMessages: ParsedMessage[] = [];

  for (const msg of recent) {
    formatted.push(`[${msg.role}]: ${msg.text.slice(0, 500)}`);
    parsedMessages.push({ role: msg.role, text: msg.text });
  }

  return {
    conversationLog: formatted.join("\n\n"),
    parsedMessages,
  };
}
