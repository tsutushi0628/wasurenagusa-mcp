#!/usr/bin/env node
/**
 * wasurenagusa-analyze CLI
 * Stop Hook用: 会話を分析して重要情報を自動保存
 *
 * 使い方: wasurenagusa-analyze
 * stdinからHook入力JSONを受け取る（transcript_pathを含む）
 */

import { config as dotenvConfig } from "dotenv";
import { basename, dirname, join, resolve } from "path";
import { homedir } from "os";
import { mkdir, writeFile } from "fs/promises";
import { fileURLToPath } from "url";
import {
  commitTranscriptBatch,
  createCorrectionEventId,
  hashRawText,
  hashSessionId,
  hashTranscriptPosition,
  type SessionCorrectionEvent,
  type SessionProgress,
} from "../corrections/session-store.js";
import { detectOwnerCorrections, type CorrectionCandidate } from "../corrections/detector.js";
import { extractOwnerEvent, removeQuotedAndInjectedContent } from "../corrections/events.js";
import {
  serializeCorrectionRuleInput,
} from "../corrections/rule-template.js";
import { applyCorrectionEvidence, cancelCorrectionBundle } from "../corrections/store.js";
import { Analyzer } from "../analyzer/index.js";
import { SQLiteStorage } from "../storage/index.js";
import { getMemoryPath, config } from "../config.js";
import { findProjectRoot } from "../utils/projectRoot.js";
import { redactSensitive } from "../utils/redact-sensitive-data.js";
import { isDirectRun } from "../utils/cli-entry.js";
import { SaveParams, AnalysisResult } from "../types.js";
import { computeConversationMeta } from "../analyzer/conversation-meta.js";
import {
  getPreviousAssistantContext,
  readTranscript,
  readTranscriptDelta,
  type TranscriptRecord,
} from "./transcript-reader.js";
import { ChangeLogger } from "../scheduler/change-logger.js";

export const STOP_DETERMINISTIC_TIMEOUT_MS = 2500;
export const STOP_TOTAL_TIMEOUT_MS = 25000;

const STOP_DETECTOR_VERSION = "owner-correction-v2";
const MAX_STOP_INPUT_BYTES = 1024 * 1024;
const OWNER_VISIBLE_TOPICS = new Set([
  "tone",
  "response_policy",
  "document_delivery",
  "expression_policy",
  "summary_constraints",
]);
const PREVIOUS_ACTION_TARGETS = [
  "質問", "回答", "返答", "待機", "全文", "本文", "文書", "文章", "比喩", "用語", "字数", "文字数",
  "要約", "フォント", "CSS", "デザイン", "部品", "原本", "出典", "検証", "確認", "設計", "実装", "保存",
  "配置", "成果物", "モデル",
];

type StopSessionState = {
  progress: SessionProgress;
  lastAvailableAt: number;
};

type PreparedStopEvent = {
  event: SessionCorrectionEvent;
  candidates: CorrectionCandidate[];
  cancellationBundleKey?: string;
};

type RecordValue = Record<string, unknown>;

class StopDeadlineExceededError extends Error {}

function asRecord(value: unknown): RecordValue | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as RecordValue;
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => asRecord(part))
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part?.text as string)
    .join("\n");
}

function eventTime(value: string | number | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const timestamp = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("transcript timestamp is invalid");
  return new Date(timestamp).toISOString();
}

function assistantTargetAction(value: string): string {
  const targets = PREVIOUS_ACTION_TARGETS.filter((target) => value.includes(target)).slice(0, 3);
  if (targets.length === 0) return "";
  return `assistant:${targets.join(",")}`;
}

function explicitCancellationBundleKey(entry: unknown): string | undefined {
  const transcriptEntry = asRecord(entry);
  if (!transcriptEntry) return undefined;
  const message = asRecord(transcriptEntry.message);
  const attachment = asRecord(transcriptEntry.attachment);
  const sourceText = transcriptEntry.type === "user"
    ? textFromContent(message?.content)
    : transcriptEntry.type === "attachment"
      ? textFromContent(attachment?.prompt)
      : "";
  const cleanedText = removeQuotedAndInjectedContent(sourceText).normalize("NFKC");
  const segments = cleanedText
    .split(/\n+/u)
    .flatMap((line) => line.match(/[^。！？!?]+[。！？!?]?/gu) ?? [])
    .map((segment) => segment.trim())
    .filter(Boolean);
  const bundleKeyPattern = String.raw`oc:v\d+:[a-f0-9]{64}`;
  const cancellationPattern = new RegExp(
    String.raw`(?:規則ID|ID)\s*[：:=]?\s*(${bundleKeyPattern})\s*(?:(?:を|は)\s*)?(?:取り消(?:して|す|し|します|しました)|取消(?:して|す|し)?|キャンセル(?:して|する)?|無効(?:にして|にする|化して|化する))(?:ください|下さい)?\s*[。！？!?]?\s*$`,
    "giu",
  );
  const idPattern = new RegExp(bundleKeyPattern, "giu");
  const cancellations = segments.flatMap((segment) => Array.from(segment.matchAll(cancellationPattern)));
  const bundleKeys = segments.flatMap((segment) => Array.from(segment.matchAll(idPattern), (match) => match[0]));
  if (cancellations.length !== 1 || bundleKeys.length !== 1) return undefined;
  if (cancellations[0][1]?.toLowerCase() !== bundleKeys[0].toLowerCase()) return undefined;
  return cancellations[0][1];
}

export function hasDeadlineTimeRemaining(deadline: number, now: number = Date.now()): boolean {
  return now < deadline;
}

function finishAtTotalDeadline(deadline: number): boolean {
  if (hasDeadlineTimeRemaining(deadline)) return false;
  if (isCliEntry) process.exit(0);
  return true;
}

export function shouldRunStopLlm(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WASURENAGUSA_STOP_LLM === "on" &&
    env.WASURENAGUSA_STOP_LLM_BILLING_APPROVED === "1" &&
    Boolean(env.GEMINI_API_KEY || env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY);
}

function correctionConditions(candidate: CorrectionCandidate): string {
  return serializeCorrectionRuleInput(candidate.ruleInput);
}

function correctionVisibility(candidate: CorrectionCandidate): "project" | "owner" {
  if (!OWNER_VISIBLE_TOPICS.has(candidate.topicKey)) return "project";
  const conditions = candidate.conditionKey.split(";");
  if (conditions.some((condition) => !["general", "continuing", "audience:owner"].includes(condition))) {
    return "project";
  }
  return "owner";
}

function continuationBasis(candidate: CorrectionCandidate): string {
  return candidate.ruleInput.continuationBasis;
}

function assistantContext(records: readonly TranscriptRecord[], correctionByteOffset: number, sessionId: string) {
  const previousRecords = getPreviousAssistantContext(records, correctionByteOffset);
  const assistantTexts: string[] = [];
  let previousAssistantToolName = "";

  for (const record of previousRecords) {
    const entry = record.entry;
    const message = asRecord(entry.message);
    if (entry.type === "assistant") {
      const text = textFromContent(message?.content);
      if (text) assistantTexts.push(text);
    }

    const name = entry.name ?? entry.tool_name ?? message?.name;
    if (typeof name === "string" && name) previousAssistantToolName = name;
    if (entry.type === "tool_use" && !previousAssistantToolName) previousAssistantToolName = "tool_use";
    if (entry.type === "tool_result" && !previousAssistantToolName) previousAssistantToolName = "tool_result";

    if (Array.isArray(message?.content)) {
      for (const part of message.content) {
        const contentPart = asRecord(part);
        if (contentPart?.type === "tool_use" && typeof contentPart.name === "string") {
          previousAssistantToolName = contentPart.name;
        }
      }
    }
  }

  const previousAssistantText = redactSensitive(
    removeQuotedAndInjectedContent(assistantTexts.join("\n")),
  );
  const latestAssistantText = assistantTexts.length > 0
    ? redactSensitive(removeQuotedAndInjectedContent(assistantTexts[assistantTexts.length - 1])).trim()
    : "";
  let previousAction = assistantTargetAction(latestAssistantText);
  if (!previousAction && previousAssistantToolName) previousAction = `tool:${previousAssistantToolName}`;
  if (!previousAction) previousAction = "action_unknown";

  return {
    previousAssistantText,
    previousAssistantToolName,
    previousAssistantSessionId: sessionId,
    previousAction: Array.from(previousAction).slice(0, 160).join(""),
    firstLocatorHash: previousRecords.length > 0
      ? hashTranscriptPosition(sessionId, previousRecords[0].byteOffset)
      : undefined,
    lastLocatorHash: previousRecords.length > 0
      ? hashTranscriptPosition(sessionId, previousRecords[previousRecords.length - 1].byteOffset)
      : undefined,
  };
}

function prepareStopEvents(
  records: readonly TranscriptRecord[],
  sessionId: string,
  project: string,
  now: string,
  previousAvailableAt: number,
  deadline: number,
): { prepared: PreparedStopEvent[]; lastAvailableAt: number } {
  const prepared: PreparedStopEvent[] = [];
  let lastAvailableAt = previousAvailableAt;

  for (const record of records) {
    if (!hasDeadlineTimeRemaining(deadline)) throw new StopDeadlineExceededError();
    const recordSessionId = record.entry.sessionId;
    if (typeof recordSessionId === "string" && recordSessionId !== sessionId) {
      throw new Error("transcript session id does not match Stop input");
    }

    const ownerEvent = extractOwnerEvent({
      ...record.entry,
      sessionId: typeof recordSessionId === "string" ? recordSessionId : sessionId,
      transcriptByteOffset: record.byteOffset,
    });
    if (!ownerEvent) continue;

    const locator = ownerEvent.uuid
      ? { uuid: ownerEvent.uuid }
      : { transcriptPosition: record.byteOffset };
    const eventId = createCorrectionEventId(sessionId, locator);
    const context = assistantContext(records, record.byteOffset, sessionId);
    const cancellationBundleKey = explicitCancellationBundleKey(record.entry);
    const candidates = cancellationBundleKey ? [] : detectOwnerCorrections(ownerEvent, context);
    const observedAt = eventTime(ownerEvent.timestamp, now);
    const observedMs = Date.parse(observedAt);
    const availableAt = eventTime(ownerEvent.availableAt ?? ownerEvent.timestamp, now);
    const availableAtMs = Math.max(lastAvailableAt, observedMs, Date.parse(availableAt));
    lastAvailableAt = availableAtMs;

    prepared.push({
      event: {
        eventId,
        ...(ownerEvent.uuid ? { sourceUuidHash: hashRawText(ownerEvent.uuid) } : {}),
        observedAt,
        availableAt: new Date(Math.max(observedMs, availableAtMs)).toISOString(),
        sourceKind: ownerEvent.sourceType,
        excerpt: Array.from(ownerEvent.text).slice(0, 120).join(""),
        previousAction: context.previousAction,
        ...(context.firstLocatorHash ? { actionFirstLocatorHash: context.firstLocatorHash } : {}),
        ...(context.lastLocatorHash ? { actionLastLocatorHash: context.lastLocatorHash } : {}),
        project,
        scope: "general",
        rawTextHash: hashRawText(ownerEvent.text),
        sourceLocatorHash: hashTranscriptPosition(sessionId, record.byteOffset),
        processedAt: now,
      },
      candidates,
      ...(cancellationBundleKey ? { cancellationBundleKey } : {}),
    });
  }

  return { prepared, lastAvailableAt };
}

function readStopSessionState(storage: SQLiteStorage, sessionIdHash: string): StopSessionState {
  return storage.runCorrectionTransaction(({ db }) => {
    const row = db.prepare(`
      SELECT human_ordinal, transcript_offset, transcript_identity
      FROM owner_correction_sessions WHERE session_id_hash = ?
    `).get(sessionIdHash) as {
      human_ordinal: number;
      transcript_offset: number;
      transcript_identity: string;
    } | undefined;
    const lastEvent = db.prepare(`
      SELECT available_at FROM owner_correction_events
      WHERE session_id_hash = ? ORDER BY human_ordinal DESC, event_id DESC LIMIT 1
    `).get(sessionIdHash) as { available_at: string } | undefined;

    return {
      progress: row
        ? {
            humanOrdinal: row.human_ordinal,
            transcriptOffset: row.transcript_offset,
            transcriptIdentity: row.transcript_identity,
          }
        : { humanOrdinal: 0, transcriptOffset: 0, transcriptIdentity: "" },
      lastAvailableAt: lastEvent ? Date.parse(lastEvent.available_at) : 0,
    };
  });
}

function commitStopBatch(
  storage: SQLiteStorage,
  sessionIdHash: string,
  progress: SessionProgress,
  nextCursor: { offset: number; identity: string; reset: boolean },
  prepared: PreparedStopEvent[],
  processedAt: string,
  deadline: number,
): void {
  storage.runCorrectionTransaction(({ db, save }) => {
    if (!hasDeadlineTimeRemaining(deadline)) throw new StopDeadlineExceededError();
    const committed = commitTranscriptBatch(
      db as unknown as Parameters<typeof commitTranscriptBatch>[0],
      {
        sessionIdHash,
        expected: progress,
        nextCursor: {
          transcriptOffset: nextCursor.offset,
          transcriptIdentity: nextCursor.identity,
          reset: nextCursor.reset,
        },
        lastSeenAt: processedAt,
        events: prepared.map(({ event }) => event),
      },
    );
    if (!committed.committed) return;

    const candidatesByEvent = new Map(prepared.map(({ event, candidates }) => [event.eventId, candidates]));
    for (const match of committed.matchedReceipts) {
      if (!hasDeadlineTimeRemaining(deadline)) throw new StopDeadlineExceededError();
      const pending = db.prepare(`
        SELECT receipt_id FROM owner_correction_pending
        WHERE receipt_id = ? AND matched_event_id = ?
      `).get(match.receiptId, match.eventId) as { receipt_id: string } | undefined;
      if (!pending) throw new Error("matched pending correction receipt was not found");
    }

    const transaction = { db, save };
    for (const [eventId, candidates] of candidatesByEvent) {
      if (!hasDeadlineTimeRemaining(deadline)) throw new StopDeadlineExceededError();
      const event = db.prepare(`
        SELECT available_at FROM owner_correction_events WHERE event_id = ?
      `).get(eventId) as { available_at: string } | undefined;
      if (!event) throw new Error("correction event disappeared during Stop recovery");

      for (const candidate of candidates) {
        if (!hasDeadlineTimeRemaining(deadline)) throw new StopDeadlineExceededError();
        const conditions = correctionConditions(candidate);
        applyCorrectionEvidence(transaction, {
          eventId,
          at: event.available_at,
          bundleKey: candidate.bundleKey as string,
          ruleText: candidate.ruleText,
          topicKey: candidate.topicKey,
          polarity: candidate.polarity,
          conditionKey: candidate.conditionKey,
          visibility: correctionVisibility(candidate),
          decision: candidate.status === "confirmed" ? "confirmed" : "candidate",
          lifetimeKind: candidate.lifetimeKind,
          continuationBasis: continuationBasis(candidate),
          ...(candidate.lifetimeKind === "task" ? { sessionEndsAt: processedAt } : {}),
          evidence: {
            source: candidate.source,
            score: candidate.score,
            detectorVersion: STOP_DETECTOR_VERSION,
            conditions,
            polarity: candidate.polarity,
          },
        });
      }
    }
    for (const { event, cancellationBundleKey } of prepared) {
      if (!cancellationBundleKey) continue;
      if (!hasDeadlineTimeRemaining(deadline)) throw new StopDeadlineExceededError();
      const target = db.prepare(`
        SELECT project, scope, visibility, status FROM owner_correction_bundles WHERE bundle_key = ?
      `).get(cancellationBundleKey) as {
        project: string;
        scope: string;
        visibility: "project" | "owner";
        status: "candidate" | "confirmed" | "expired" | "rejected" | "disputed";
      } | undefined;
      if (!target || (target.status !== "candidate" && target.status !== "confirmed")) continue;
      if (target.visibility !== "owner" && (target.project !== event.project || target.scope !== event.scope)) continue;
      cancelCorrectionBundle(transaction, {
        bundleKey: cancellationBundleKey,
        eventId: event.eventId,
        at: event.processedAt,
      });
    }
    if (!hasDeadlineTimeRemaining(deadline)) throw new StopDeadlineExceededError();
  });
}

async function recoverStopCorrections(hookInput: HookInput, deadline: number): Promise<boolean> {
  if (!hasDeadlineTimeRemaining(deadline)) return false;
  const projectRoot = findProjectRoot(hookInput.cwd);
  const project = basename(projectRoot);
  const memoryPath = getMemoryPath(projectRoot);
  const storage = SQLiteStorage.openExistingForHook(join(memoryPath, config.sqliteFile), { mode: "auto" });

  try {
    if (!storage.supportsCorrectionHooks) return true;
    if (!hasDeadlineTimeRemaining(deadline)) return false;
    const sessionIdHash = hashSessionId(hookInput.session_id);
    const state = readStopSessionState(storage, sessionIdHash);
    if (!hasDeadlineTimeRemaining(deadline)) return false;
    const delta = await readTranscriptDelta(hookInput.transcript_path, {
      offset: state.progress.transcriptOffset,
      identity: state.progress.transcriptIdentity,
    });
    if (!hasDeadlineTimeRemaining(deadline)) return false;

    const processedAt = new Date().toISOString();
    const { prepared } = prepareStopEvents(
      delta.records,
      hookInput.session_id,
      project,
      processedAt,
      state.lastAvailableAt,
      deadline,
    );
    if (!hasDeadlineTimeRemaining(deadline)) return false;

    commitStopBatch(
      storage,
      sessionIdHash,
      state.progress,
      { ...delta.nextCursor, reset: delta.reset },
      prepared,
      processedAt,
      deadline,
    );
    return hasDeadlineTimeRemaining(deadline);
  } catch (error) {
    if (error instanceof StopDeadlineExceededError) return false;
    throw error;
  } finally {
    storage.close();
  }
}

async function waitUntilDeadline<T>(promise: Promise<T>, deadline: number): Promise<T | undefined> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) return undefined;

  let timeout: NodeJS.Timeout | undefined;
  const deadlinePromise = new Promise<undefined>((resolveDeadline) => {
    timeout = setTimeout(() => resolveDeadline(undefined), remainingMs);
  });
  try {
    return await Promise.race([promise, deadlinePromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * AnalysisResult から SaveParams を構築する純粋関数。
 * heart-extension B0c: analysis.knowledgeGap を SaveParams.knowledgeGap に引き渡す。
 *
 * @param analysis Analyzer.analyze の出力（shouldSave/category/title/summary が確定済みの前提）
 * @param projectName basename(projectRoot)
 * @param replaceId 重複検出で見つかった既存エントリID（無ければ undefined）
 */
export function buildSaveParamsFromAnalysis(
  analysis: AnalysisResult,
  projectName: string,
  replaceId?: string,
): SaveParams {
  if (!analysis.category || !analysis.title || !analysis.summary) {
    throw new Error("buildSaveParamsFromAnalysis: analysis must have category/title/summary");
  }
  return {
    category: analysis.category,
    title: analysis.title,
    content: analysis.summary,
    tags: analysis.tags,
    project: projectName,
    scope: analysis.scope || undefined,
    replaceId,
    intensity: analysis.intensity,
    knowledgeGap: analysis.knowledgeGap,
    positiveAction: analysis.positiveAction,
    scenario: analysis.scenario,
    whyCore: analysis.whyCore,
  };
}

// __dirnameベースで.envを探す（CWDに依存しない）
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const envPath = resolve(__dirname, "../../.env");
dotenvConfig({ path: envPath });

interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  stop_hook_active?: boolean;
}

export async function main() {
  const startedAt = Date.now();
  const deterministicDeadline = startedAt + STOP_DETERMINISTIC_TIMEOUT_MS;
  const totalDeadline = startedAt + STOP_TOTAL_TIMEOUT_MS;

  // stdinからHook入力を読み取る
  let inputData = "";
  for await (const chunk of process.stdin) {
    inputData += chunk;
    if (Buffer.byteLength(inputData, "utf8") > MAX_STOP_INPUT_BYTES) {
      throw new Error("Stop hook input exceeds 1 MiB");
    }
  }

  const parsedHookInput: unknown = JSON.parse(inputData);
  const hookRecord = asRecord(parsedHookInput);
  if (
    !hookRecord ||
    typeof hookRecord.session_id !== "string" ||
    typeof hookRecord.transcript_path !== "string" ||
    typeof hookRecord.cwd !== "string" ||
    typeof hookRecord.hook_event_name !== "string"
  ) {
    throw new Error("Stop hook input is invalid");
  }
  const hookInput = hookRecord as unknown as HookInput;

  // 無限ループ防止: stop_hook_activeがtrueなら何もしない
  if (hookInput.stop_hook_active) {
    process.exit(0);
  }

  if (hookInput.hook_event_name !== "Stop") return;

  // スケジューラー起動のClaude CLIセッションは分析をスキップ（ログ爆発防止）
  if (process.env.WASURENAGUSA_SCHEDULER === "1") {
    process.exit(0);
  }

  if (process.env.WASURENAGUSA_CORRECTION_LOOP?.trim().toLowerCase() === "on") {
    await recoverStopCorrections(hookInput, deterministicDeadline);
  }

  if (!shouldRunStopLlm() || finishAtTotalDeadline(totalDeadline)) return;

  // トランスクリプトを読み込み
  const { conversationLog, parsedMessages } = await readTranscript(hookInput.transcript_path);
  if (!conversationLog || finishAtTotalDeadline(totalDeadline)) return;

  // メタ情報を計算（諦め検知用）
  const meta = computeConversationMeta(parsedMessages);

  // LLMで分析
  const analyzer = new Analyzer();
  const analysis = await waitUntilDeadline(analyzer.analyze({
    conversationLog,
    latestMessage: conversationLog.split("\n\n").slice(-1)[0] || "",
    meta,
  }), totalDeadline);
  if (!analysis) {
    finishAtTotalDeadline(totalDeadline);
    return;
  }
  if (finishAtTotalDeadline(totalDeadline)) return;

  // 保存が必要な場合
  if (analysis.shouldSave && analysis.category && analysis.title && analysis.summary) {
    const projectRoot = findProjectRoot(hookInput.cwd);
    const memoryPath = getMemoryPath(projectRoot);
    const dbPath = join(memoryPath, config.sqliteFile);
    const storage = SQLiteStorage.openExistingForHook(dbPath);
    try {
      let replaceId: string | undefined;
      if (hasDeadlineTimeRemaining(totalDeadline)) {
        const existingSearch = storage.search({
          query: analysis.title,
          category: analysis.category,
          limit: 50,
        });
        if (existingSearch.totalCount > 0) {
          const detail = storage.getDetail({
            ids: existingSearch.results.map(r => r.id),
          });
          const existingEntries = detail.entries.map(e => ({
            id: e.id,
            title: e.title,
            content: e.content,
          }));
          try {
            const duplicateId = await waitUntilDeadline(analyzer.checkDuplicate({
              newTitle: analysis.title,
              newContent: analysis.summary,
              existingEntries,
            }), totalDeadline);
            if (duplicateId) replaceId = duplicateId;
          } catch {
            // 重複チェック失敗時は新規追加にフォールバック
          }
        }
      }

      if (finishAtTotalDeadline(totalDeadline)) return;
      const saveParams: SaveParams = buildSaveParamsFromAnalysis(
        analysis,
        basename(projectRoot),
        replaceId,
      );

      storage.save(saveParams);
    } finally {
      storage.close();
    }
  }

  if (finishAtTotalDeadline(totalDeadline)) return;

  // 変更ログ記録（Stop Hook相乗り）
  try {
    const schedulerDir = join(homedir(), ".wasurenagusa", "scheduler");
    await mkdir(schedulerDir, { recursive: true });
    const changeLogger = new ChangeLogger(schedulerDir);
    await changeLogger.recordChanges(hookInput.cwd);
  } catch {
    // 変更ログ記録の失敗は握りつぶす（既存機能を壊さない）
  }

  if (finishAtTotalDeadline(totalDeadline)) return;

  // 最終セッション終了時刻を記録（スケジューラのアイドル判定用）
  try {
    const schedulerDir = join(homedir(), ".wasurenagusa", "scheduler");
    await mkdir(schedulerDir, { recursive: true });
    const lastSessionPath = join(schedulerDir, "last-session.json");
    await writeFile(lastSessionPath, JSON.stringify({ endedAt: new Date().toISOString() }));
  } catch {
    // 記録失敗は握りつぶす
  }

  if (finishAtTotalDeadline(totalDeadline)) return;

  // セッショントピックのembedding保存（shouldSaveに関係なく毎セッション）
  if (analysis.sessionTopic) {
    try {
      const { EmbeddingService } = await import("../vector/embedding-service.js");
      const { config, getMemoryPath } = await import("../config.js");
      const topicProjectRoot = findProjectRoot(hookInput.cwd);
      const memoryPath = getMemoryPath(topicProjectRoot);
      const embeddingService = new EmbeddingService(config.geminiApiKey, memoryPath);
      if (embeddingService.isAvailable() && hasDeadlineTimeRemaining(totalDeadline)) {
        const topicEmbedding = await waitUntilDeadline(embeddingService.embed(analysis.sessionTopic), totalDeadline);
        if (!topicEmbedding) {
          finishAtTotalDeadline(totalDeadline);
          return;
        }
        if (finishAtTotalDeadline(totalDeadline)) return;

        // last-session-topic.json に保存（次のSessionStartで使用）
        const topicPath = join(memoryPath, "last-session-topic.json");

        const topicData = {
          topic: analysis.sessionTopic,
          embedding: topicEmbedding,
          project: basename(topicProjectRoot),
          sessionId: hookInput.session_id,
          timestamp: new Date().toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" }).replace(" ", "T") + "+09:00",
        };

        await writeFile(topicPath, JSON.stringify(topicData, null, 2));
      }
    } catch (error) {
      console.error("[session-topic] embedding保存失敗:", error);
    }
  }

  // アクティブプロジェクト更新（横断記憶検索用）
  try {
    const schedulerDir = join(homedir(), ".wasurenagusa", "scheduler");
    const { ActiveProjectsTracker } = await import("../active-projects.js");
    const activeTracker = new ActiveProjectsTracker(schedulerDir);
    const activeProjectRoot = findProjectRoot(hookInput.cwd);
    let topicText = "";
    if (analysis.sessionTopic) {
      topicText = analysis.sessionTopic;
    }
    await activeTracker.update({
      name: basename(activeProjectRoot),
      path: activeProjectRoot,
      lastSessionAt: new Date().toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" }).replace(" ", "T") + "+09:00",
      sessionTopic: topicText,
    });
  } catch {
    // アクティブプロジェクト更新の失敗は握りつぶす（既存機能を壊さない）
  }
}

const isCliEntry = isDirectRun(process.argv[1], import.meta.url);

if (isCliEntry) {
  main().catch((err) => {
    console.error(err);
  });
}
