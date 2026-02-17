/**
 * トランスクリプトJSONL読み込み
 * analyze.tsから抽出。テスト可能にするため独立モジュール化。
 */

import { readFile } from "fs/promises";
import { ParsedMessage } from "../analyzer/conversation-meta.js";

interface TranscriptEntry {
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

export async function readTranscript(transcriptPath: string): Promise<TranscriptResult> {
  const content = await readFile(transcriptPath, "utf-8");
  const lines = content.trim().split("\n");

  // 全行をパースし、user/assistantメッセージだけを抽出してから直近50件を取る
  // （tool_use/tool_resultがJSONLを埋め尽くすため、先にフィルタリングが必要）
  const messageEntries: Array<{ role: string; text: string }> = [];

  for (const line of lines) {
    try {
      const entry: TranscriptEntry = JSON.parse(line);
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
