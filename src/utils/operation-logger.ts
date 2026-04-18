import * as fs from "fs";
import { join } from "path";
import { randomBytes } from "crypto";

export interface SearchLogEntry {
  ts: string;
  operation_type: "search";
  session_id: string;
  query: string;
  category: string;
  hit_count: number;
  project: string;
  duration_ms: number;
}

export interface GetDetailLogEntry {
  ts: string;
  operation_type: "get_detail";
  session_id: string;
  parent_session_id: string | null;
  requested_ids: string[];
  found_count: number;
  project: string;
  duration_ms: number;
}

export type OperationLogEntry = SearchLogEntry | GetDetailLogEntry;

function generateSessionId(): string {
  return `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

function generateJstTimestamp(): string {
  const now = new Date();
  const jstOffset = 9 * 60 * 60 * 1000;
  const jst = new Date(now.getTime() + jstOffset);
  return jst.toISOString().replace("Z", "+09:00");
}

function getLogFilePath(memoryPath: string): string {
  const now = new Date();
  const jstOffset = 9 * 60 * 60 * 1000;
  const jst = new Date(now.getTime() + jstOffset);
  const datePart = jst.toISOString().slice(0, 10);
  return join(memoryPath, "logs", `operation-${datePart}.jsonl`);
}

export function generateSearchSessionId(): string {
  return generateSessionId();
}

export function generateGetDetailSessionId(): string {
  return generateSessionId();
}

export { generateJstTimestamp };

export async function logOperation(entry: OperationLogEntry, memoryPath: string): Promise<void> {
  const logFilePath = getLogFilePath(memoryPath);
  const logsDir = join(memoryPath, "logs");
  const line = JSON.stringify(entry) + "\n";

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("logOperation timeout")), 100)
  );

  try {
    await fs.promises.mkdir(logsDir, { recursive: true });
    await Promise.race([fs.promises.appendFile(logFilePath, line, "utf-8"), timeoutPromise]);
  } catch (error) {
    console.error("[operation-logger] ログ書き込み失敗:", error);
  }
}

// TASK-OL-06: session_idキャッシュ
interface LastSearchCache {
  sessionId: string;
  timestamp: number;
  resultIds: string[];
}

const WINDOW_MS = 5 * 60 * 1000; // 5分

const lastSearchCache = new Map<string, LastSearchCache>();

export function setLastSearch(project: string, sessionId: string, resultIds: string[]): void {
  lastSearchCache.set(project, { sessionId, timestamp: Date.now(), resultIds });
}

export function resolveParentSessionId(project: string, requestedIds: string[]): string | null {
  const cache = lastSearchCache.get(project);
  if (!cache) return null;

  const elapsed = Date.now() - cache.timestamp;
  if (elapsed > WINDOW_MS) return null;

  const hasIntersection = requestedIds.some(id => cache.resultIds.includes(id));
  if (!hasIntersection) return null;

  return cache.sessionId;
}
