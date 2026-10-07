#!/usr/bin/env node
/**
 * wasurenagusa-context CLI
 * SessionStart / UserPromptSubmit / PreCompact Hook用: 記憶索引と確認済み訂正を注入
 *
 * 使い方: wasurenagusa-context
 * Hooks設定で呼び出される（stdoutがClaudeのコンテキストに注入される）
 *
 * Hook入力（stdin JSON）:
 * {
 *   "session_id": "...",
  *   "transcript_path": "...",
 *   "cwd": "/path/to/project",
  *   "hook_event_name": "SessionStart" | "UserPromptSubmit" | "PreCompact",
 *   "source": "startup" | "resume" | "clear" | "compact",
  *   "model": "...",
  *   "prompt": "..."
 * }
 */

import { basename, join } from "path";
import { isDirectRun } from "../utils/cli-entry.js";
export { isDirectRun } from "../utils/cli-entry.js";
import { findProjectRoot } from "../utils/projectRoot.js";
import { SQLiteStorage } from "../storage/index.js";
import { getMemoryPath, config } from "../config.js";
import { readCorrectionFeatureModes } from "../corrections/environment-mode.js";
import { storedBundleKey } from "../corrections/store.js";

import { loadOwnerProfile } from "../utils/owner-profile.js";
import { increment } from "../observability/counters.js";
import {
  recordCorrectionMetric,
  type CorrectionHookEventKind,
  type CorrectionMetricStageDurations,
} from "../observability/correction-metrics.js";
import { buildInjection, BENIGN_SKIP_LABELS } from "../injection/builder.js";
import {
  DEFAULT_INJECTION_TOKEN_BUDGET,
  enforceInjectionTokenBudget,
  estimateTokens,
  logInjectionBudgetWarning,
} from "../injection/budget.js";
import { readTranscriptDelta, type TranscriptCursor, type TranscriptRecord } from "./transcript-reader.js";
import { extractOwnerEvent, isAutomatedPrompt } from "../corrections/events.js";
import { detectOwnerCorrections, type CorrectionCandidate } from "../corrections/detector.js";
import {
  selectCorrectionInjections,
  type CorrectionInjectionTrigger,
  type CorrectionInjectionSelection,
} from "../corrections/injection-policy.js";
import {
  finalizeCorrectionRender,
  renderCorrectionRules,
  type CorrectionRenderResult,
  type CorrectionRenderTrigger,
} from "../corrections/render.js";
import {
  createCorrectionEventId,
  createPendingReceiptId,
  hashRawText,
  hashSessionId,
  queuePendingReceipt,
  resolveSessionProject,
} from "../corrections/session-store.js";

export const CONTEXT_HOOK_STDIN_LIMIT_BYTES = 1024 * 1024;
export const CONTEXT_HOOK_TIMEOUT_MS = 3500;
export const CONTEXT_HOOK_OUTPUT_RESERVE_MS = 300;

export type ContextHookEventName = "SessionStart" | "UserPromptSubmit" | "PreCompact";

export interface HookInput {
  session_id: string;
  transcript_path?: string;
  cwd: string;
  hook_event_name: ContextHookEventName;
  source?: string;
  model?: string;
  prompt?: string;
  uuid?: string;
}

export function parseContextHookInput(inputData: string): HookInput {
  if (Buffer.byteLength(inputData, "utf8") > CONTEXT_HOOK_STDIN_LIMIT_BYTES) {
    throw new Error("hook stdin exceeds the 1 MiB limit");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(inputData);
  } catch {
    throw new Error("hook stdin is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("hook stdin must be an object");
  }

  const input = parsed as Record<string, unknown>;
  if (typeof input.session_id !== "string" || input.session_id.length === 0) {
    throw new Error("hook session id is invalid");
  }
  if (typeof input.cwd !== "string" || input.cwd.length === 0) {
    throw new Error("hook cwd is invalid");
  }
  if (input.transcript_path !== undefined && typeof input.transcript_path !== "string") {
    throw new Error("hook transcript path is invalid");
  }
  if (input.source !== undefined && typeof input.source !== "string") {
    throw new Error("hook source is invalid");
  }
  if (input.model !== undefined && typeof input.model !== "string") {
    throw new Error("hook model is invalid");
  }
  const eventNames: readonly string[] = ["SessionStart", "UserPromptSubmit", "PreCompact"];
  if (typeof input.hook_event_name !== "string" || !eventNames.includes(input.hook_event_name)) {
    throw new Error("hook event name is unsupported");
  }

  let prompt: unknown = input.prompt;
  if (prompt === undefined && typeof input.stdin === "object" && input.stdin !== null && !Array.isArray(input.stdin)) {
    prompt = (input.stdin as Record<string, unknown>).prompt;
  }
  if (input.hook_event_name === "UserPromptSubmit" && typeof prompt !== "string") {
    throw new Error("hook prompt is invalid");
  }
  if (prompt !== undefined && typeof prompt !== "string") {
    throw new Error("hook prompt is invalid");
  }
  if (input.uuid !== undefined && typeof input.uuid !== "string") {
    throw new Error("hook uuid is invalid");
  }

  const result: HookInput = {
    session_id: input.session_id,
    cwd: input.cwd,
    hook_event_name: input.hook_event_name as ContextHookEventName,
  };
  if (typeof input.transcript_path === "string") result.transcript_path = input.transcript_path;
  if (typeof input.source === "string") result.source = input.source;
  if (typeof input.model === "string") result.model = input.model;
  if (typeof prompt === "string") result.prompt = prompt;
  if (typeof input.uuid === "string") result.uuid = input.uuid;
  return result;
}

class HookTimeoutError extends Error {}

function requireHookTime(deadlineAt: number): void {
  if (deadlineAt - Date.now() <= CONTEXT_HOOK_OUTPUT_RESERVE_MS) {
    throw new HookTimeoutError("context hook deadline reached");
  }
}

async function readStdin(deadlineAt: number): Promise<string> {
  requireHookTime(deadlineAt);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let byteLength = 0;
    let settled = false;
    const timeoutMs = Math.max(0, deadlineAt - Date.now() - CONTEXT_HOOK_OUTPUT_RESERVE_MS);
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      process.stdin.removeListener("error", onError);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      byteLength += buffer.length;
      if (byteLength > CONTEXT_HOOK_STDIN_LIMIT_BYTES) {
        process.stdin.pause();
        finish(new Error("hook stdin exceeds the 1 MiB limit"));
        return;
      }
      chunks.push(buffer);
      if (deadlineAt - Date.now() <= CONTEXT_HOOK_OUTPUT_RESERVE_MS) {
        process.stdin.pause();
        finish(new HookTimeoutError("hook stdin deadline reached"));
      }
    };
    const onEnd = (): void => finish();
    const onError = (): void => finish(new Error("hook stdin read failed"));
    const timeout = setTimeout(() => {
      process.stdin.pause();
      finish(new HookTimeoutError("hook stdin deadline reached"));
    }, timeoutMs);
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.once("error", onError);
  });
}

export function writeStdoutOnce(
  text: string,
  stdout: NodeJS.WriteStream = process.stdout,
  timeoutMs = Number.POSITIVE_INFINITY,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let streamError: Error | null = null;
    let timer: NodeJS.Timeout | undefined;
    const cleanupErrorListener = (): void => {
      stdout.removeListener("error", onError);
    };
    const finish = (success: boolean, keepErrorListener = false): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (!keepErrorListener) cleanupErrorListener();
      resolve(success);
    };
    const onError = (error: Error): void => {
      streamError = error;
      if (settled) {
        cleanupErrorListener();
        return;
      }
      finish(false);
    };

    stdout.once("error", onError);
    if (Number.isFinite(timeoutMs)) {
      timer = setTimeout(() => finish(false, true), Math.max(0, timeoutMs));
    }
    try {
      stdout.write(text, (error?: Error | null) => {
        if (settled) {
          cleanupErrorListener();
          return;
        }
        if (error) {
          streamError = error;
          finish(false, true);
          return;
        }
        finish(streamError === null);
      });
    } catch {
      finish(false);
    }
  });
}

export type ContextLedgerTrigger = CorrectionInjectionTrigger;

export interface EmitContextOutputInput {
  output: string;
  rendered: CorrectionRenderResult;
  storage: SQLiteStorage;
  sessionIdHash: string;
  compactEpoch: number;
  humanOrdinal: number;
  trigger: ContextLedgerTrigger;
  deadlineAt: number;
  pendingReceiptId?: string;
  stdout?: NodeJS.WriteStream;
  lap?: CorrectionMetricLap;
}

export interface EmitContextOutputResult {
  status: "emitted" | "write_failed" | "ledger_unknown" | "timeout";
  rendered: CorrectionRenderResult;
  writeAttempted: boolean;
}

export async function emitContextOutput({
  output,
  rendered,
  storage,
  sessionIdHash,
  compactEpoch,
  humanOrdinal,
  trigger,
  deadlineAt,
  pendingReceiptId,
  stdout = process.stdout,
  lap,
}: EmitContextOutputInput): Promise<EmitContextOutputResult> {
  const finalRender = finalizeCorrectionRender(rendered, output);
  if (deadlineAt - Date.now() <= CONTEXT_HOOK_OUTPUT_RESERVE_MS) {
    return { status: "timeout", rendered: finalRender, writeAttempted: false };
  }

  const writeSucceeded = await writeStdoutOnce(
    output,
    stdout,
    deadlineAt - Date.now() - CONTEXT_HOOK_OUTPUT_RESERVE_MS,
  );
  const writeCompletedAt = Date.now();
  lap?.("write");
  if (!writeSucceeded) {
    const status = deadlineAt - writeCompletedAt <= CONTEXT_HOOK_OUTPUT_RESERVE_MS
      ? "timeout"
      : "write_failed";
    return { status, rendered: finalRender, writeAttempted: true };
  }
  if (deadlineAt - writeCompletedAt <= CONTEXT_HOOK_OUTPUT_RESERVE_MS) {
    return { status: "timeout", rendered: finalRender, writeAttempted: true };
  }
  if (finalRender.ledger.length === 0) {
    return { status: "emitted", rendered: finalRender, writeAttempted: true };
  }

  if (pendingReceiptId) {
    try {
      recordPendingOutput(storage, pendingReceiptId, compactEpoch, finalRender);
      const status = finalRender.ledger.length === 1 ? "emitted" : "ledger_unknown";
      return { status, rendered: finalRender, writeAttempted: true };
    } catch {
      return { status: "ledger_unknown", rendered: finalRender, writeAttempted: true };
    } finally {
      lap?.("store");
    }
  }

  try {
    storage.runCorrectionTransaction(({ db }) => {
      const insert = db.prepare(`
        INSERT INTO owner_correction_injections (
          session_id_hash, compact_epoch, bundle_key, version, human_ordinal, trigger,
          emitted_at, output_order, body_hash, output_hash, token_estimate, body_included, stdout_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'emitted')
        ON CONFLICT(session_id_hash, compact_epoch, bundle_key, version, human_ordinal, trigger) DO NOTHING
      `);
      const select = db.prepare(`
        SELECT output_order, body_hash, output_hash, token_estimate, body_included, stdout_status
        FROM owner_correction_injections
        WHERE session_id_hash = ? AND compact_epoch = ? AND bundle_key = ? AND version = ? AND human_ordinal = ? AND trigger = ?
      `);
      for (const entry of finalRender.ledger) {
        requireHookTime(deadlineAt);
        const result = insert.run(
          sessionIdHash,
          compactEpoch,
          entry.bundleKey,
          entry.version,
          humanOrdinal,
          trigger,
          new Date().toISOString(),
          entry.outputOrder,
          entry.bodyHash,
          finalRender.outputHash,
          finalRender.tokenCount,
        ) as { changes?: number };
        if (result.changes === 0) {
          const row = select.get(
            sessionIdHash,
            compactEpoch,
            entry.bundleKey,
            entry.version,
            humanOrdinal,
            trigger,
          ) as {
            output_order: number;
            body_hash: string;
            output_hash: string;
            token_estimate: number;
            body_included: number;
            stdout_status: string;
          } | undefined;
          if (
            !row ||
            row.output_order !== entry.outputOrder ||
            row.body_hash !== entry.bodyHash ||
            row.output_hash !== finalRender.outputHash ||
            row.token_estimate !== finalRender.tokenCount ||
            row.body_included !== 1 ||
            row.stdout_status !== "emitted"
          ) {
            throw new Error("correction injection ledger row does not match stdout");
          }
        }
      }
      requireHookTime(deadlineAt);
    });
  } catch {
    return { status: "ledger_unknown", rendered: finalRender, writeAttempted: true };
  } finally {
    lap?.("store");
  }

  return { status: "emitted", rendered: finalRender, writeAttempted: true };
}

interface HookSessionState {
  humanOrdinal: number;
  transcriptOffset: number;
  transcriptIdentity: string;
  compactEpoch: number;
  lastRefreshOrdinal: number;
  lastSeenAt: string | null;
  project: string;
}

const EMPTY_HOOK_SESSION_STATE: HookSessionState = {
  humanOrdinal: 0,
  transcriptOffset: 0,
  transcriptIdentity: "",
  compactEpoch: 0,
  lastRefreshOrdinal: 0,
  lastSeenAt: null,
  project: "",
};

function readHookSessionState(
  storage: SQLiteStorage,
  sessionIdHash: string,
  cwdProject: string,
): HookSessionState {
  return storage.runCorrectionTransaction(({ db }) => {
    const row = db.prepare(`
      SELECT human_ordinal, transcript_offset, transcript_identity, compact_epoch,
        last_refresh_ordinal, last_seen_at
      FROM owner_correction_sessions WHERE session_id_hash = ?
    `).get(sessionIdHash) as {
      human_ordinal: number;
      transcript_offset: number;
      transcript_identity: string;
      compact_epoch: number;
      last_refresh_ordinal: number;
      last_seen_at: string;
    } | undefined;
    const project = resolveSessionProject(db, sessionIdHash, cwdProject);
    if (!row) return { ...EMPTY_HOOK_SESSION_STATE, project };
    return {
      humanOrdinal: row.human_ordinal,
      transcriptOffset: row.transcript_offset,
      transcriptIdentity: row.transcript_identity,
      compactEpoch: row.compact_epoch,
      lastRefreshOrdinal: row.last_refresh_ordinal,
      lastSeenAt: row.last_seen_at,
      project,
    };
  });
}

function prepareSessionStartEpoch(
  storage: SQLiteStorage,
  sessionIdHash: string,
  source: string | undefined,
  now: string,
  cwdProject: string,
): HookSessionState {
  return storage.runCorrectionTransaction(({ db }) => {
    const row = db.prepare(`
      SELECT human_ordinal, transcript_offset, transcript_identity, compact_epoch,
        last_refresh_ordinal, last_seen_at
      FROM owner_correction_sessions WHERE session_id_hash = ?
    `).get(sessionIdHash) as {
      human_ordinal: number;
      transcript_offset: number;
      transcript_identity: string;
      compact_epoch: number;
      last_refresh_ordinal: number;
      last_seen_at: string;
    } | undefined;
    const project = resolveSessionProject(db, sessionIdHash, cwdProject);
    const state = row ? {
      humanOrdinal: row.human_ordinal,
      transcriptOffset: row.transcript_offset,
      transcriptIdentity: row.transcript_identity,
      compactEpoch: row.compact_epoch,
      lastRefreshOrdinal: row.last_refresh_ordinal,
      lastSeenAt: row.last_seen_at,
      project,
    } : { ...EMPTY_HOOK_SESSION_STATE, project };
    if (source !== "compact" && source !== "clear" && source !== "resume") return state;

    const latestStart = db.prepare(`
      SELECT MAX(emitted_at) AS emitted_at FROM owner_correction_injections
      WHERE session_id_hash = ? AND compact_epoch = ? AND trigger = 'start' AND stdout_status = 'emitted'
    `).get(sessionIdHash, state.compactEpoch) as { emitted_at: string | null };
    const alreadyStarted = state.lastSeenAt !== null && latestStart.emitted_at !== null &&
      Date.parse(latestStart.emitted_at) >= Date.parse(state.lastSeenAt);
    if (alreadyStarted) return state;

    const compactEpoch = state.compactEpoch + 1;
    db.prepare(`
      INSERT INTO owner_correction_sessions (
        session_id_hash, human_ordinal, transcript_offset, transcript_identity,
        compact_epoch, last_refresh_ordinal, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id_hash) DO UPDATE SET compact_epoch = excluded.compact_epoch, last_seen_at = excluded.last_seen_at
    `).run(
      sessionIdHash,
      state.humanOrdinal,
      state.transcriptOffset,
      state.transcriptIdentity,
      compactEpoch,
      state.lastRefreshOrdinal,
      now,
    );
    return { ...state, compactEpoch, lastSeenAt: now };
  });
}

function reserveCompactEpoch(
  storage: SQLiteStorage,
  sessionIdHash: string,
  now: string,
  cwdProject: string,
): HookSessionState {
  return storage.runCorrectionTransaction(({ db }) => {
    const row = db.prepare(`
      SELECT human_ordinal, transcript_offset, transcript_identity, compact_epoch,
        last_refresh_ordinal, last_seen_at
      FROM owner_correction_sessions WHERE session_id_hash = ?
    `).get(sessionIdHash) as {
      human_ordinal: number;
      transcript_offset: number;
      transcript_identity: string;
      compact_epoch: number;
      last_refresh_ordinal: number;
      last_seen_at: string;
    } | undefined;
    const project = resolveSessionProject(db, sessionIdHash, cwdProject);
    const state = row ? {
      humanOrdinal: row.human_ordinal,
      transcriptOffset: row.transcript_offset,
      transcriptIdentity: row.transcript_identity,
      compactEpoch: row.compact_epoch,
      lastRefreshOrdinal: row.last_refresh_ordinal,
      lastSeenAt: row.last_seen_at,
      project,
    } : { ...EMPTY_HOOK_SESSION_STATE, project };
    const existingAttempt = db.prepare(`
      SELECT 1 AS present FROM owner_correction_injections
      WHERE session_id_hash = ? AND compact_epoch = ? AND trigger = 'compact'
      LIMIT 1
    `).get(sessionIdHash, state.compactEpoch);
    if (existingAttempt) return state;

    const compactEpoch = state.compactEpoch + 1;
    db.prepare(`
      INSERT INTO owner_correction_sessions (
        session_id_hash, human_ordinal, transcript_offset, transcript_identity,
        compact_epoch, last_refresh_ordinal, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id_hash) DO UPDATE SET compact_epoch = excluded.compact_epoch, last_seen_at = excluded.last_seen_at
    `).run(
      sessionIdHash,
      state.humanOrdinal,
      state.transcriptOffset,
      state.transcriptIdentity,
      compactEpoch,
      state.lastRefreshOrdinal,
      now,
    );
    return { ...state, compactEpoch, lastSeenAt: now };
  });
}

function currentPromptIsInDelta(
  records: readonly TranscriptRecord[],
  sessionId: string,
  prompt: string,
  uuid?: string,
): boolean {
  const hookEvent = extractOwnerEvent({ hookEventName: "UserPromptSubmit", session_id: sessionId, prompt });
  if (!hookEvent) return false;
  const humanRecords = records
    .map((record) => ({ record, event: extractOwnerEvent(record.entry) }))
    .filter((entry): entry is { record: TranscriptRecord; event: NonNullable<ReturnType<typeof extractOwnerEvent>> } => entry.event !== null);
  const latest = humanRecords.at(-1);
  if (!latest) return false;
  if (uuid && latest.event.uuid) return uuid === latest.event.uuid;
  return records.at(-1) === latest.record && hashRawText(latest.event.text) === hashRawText(hookEvent.text);
}

function findStoredPromptOrdinal(
  storage: SQLiteStorage,
  sessionId: string,
  uuid: string | undefined,
): number | null {
  if (!uuid) return null;
  const eventId = createCorrectionEventId(sessionId, { uuid });
  return storage.runCorrectionTransaction(({ db }) => {
    const row = db.prepare(`
      SELECT human_ordinal FROM owner_correction_events WHERE event_id = ?
    `).get(eventId) as { human_ordinal: number } | undefined;
    if (!row) return null;
    return row.human_ordinal;
  });
}

interface HookPosition {
  humanOrdinal: number;
  currentPromptLocated: boolean;
  lastConfirmedOrdinal: number;
}

async function resolveHookPosition(
  storage: SQLiteStorage,
  input: HookInput,
  sessionIdHash: string,
  state: HookSessionState,
  deadlineAt: number,
): Promise<HookPosition> {
  let delta: Awaited<ReturnType<typeof readTranscriptDelta>> | null = null;
  if (input.transcript_path) {
    requireHookTime(deadlineAt);
    const cursor: TranscriptCursor = {
      offset: state.transcriptOffset,
      identity: state.transcriptIdentity,
    };
    delta = await readTranscriptDelta(input.transcript_path, cursor);
    requireHookTime(deadlineAt);
  }

  let observedOrdinal = state.humanOrdinal;
  if (delta && !delta.reset) observedOrdinal += delta.humanMessagesRead;
  if (input.hook_event_name !== "UserPromptSubmit") {
    return { humanOrdinal: observedOrdinal, currentPromptLocated: true, lastConfirmedOrdinal: state.humanOrdinal };
  }

  const storedOrdinal = findStoredPromptOrdinal(storage, input.session_id, input.uuid);
  requireHookTime(deadlineAt);
  if (storedOrdinal !== null) {
    return { humanOrdinal: storedOrdinal, currentPromptLocated: true, lastConfirmedOrdinal: state.humanOrdinal };
  }

  const isLocated = Boolean(
    delta &&
    !delta.reset &&
    !delta.hasMore &&
    input.prompt !== undefined &&
    currentPromptIsInDelta(delta.records, input.session_id, input.prompt, input.uuid),
  );
  const humanOrdinal = isLocated
    ? observedOrdinal
    : observedOrdinal + 1;
  return { humanOrdinal, currentPromptLocated: isLocated, lastConfirmedOrdinal: state.humanOrdinal };
}

function getHookEventKind(eventName: ContextHookEventName): CorrectionHookEventKind {
  if (eventName === "SessionStart") return "SessionStart";
  if (eventName === "UserPromptSubmit") return "UserPromptSubmit";
  return "PreCompact";
}

function createCorrectionMetricStageDurations(): CorrectionMetricStageDurations {
  return {
    stdin: 0,
    position: 0,
    detect: 0,
    store: 0,
    retrieve: 0,
    render: 0,
    write: 0,
  };
}

type CorrectionMetricLap = (stage: keyof CorrectionMetricStageDurations) => void;

function createCorrectionMetricLap(
  stageDurationsMs: CorrectionMetricStageDurations,
  startedAt: number,
): CorrectionMetricLap {
  let previousLapAt = startedAt;
  return (stage) => {
    const currentLapAt = Date.now();
    stageDurationsMs[stage] += Math.max(0, currentLapAt - previousLapAt);
    previousLapAt = currentLapAt;
  };
}

export function shouldProcessPromptCorrectionWork(
  hookEventName: ContextHookEventName,
  automatedPrompt: boolean,
): boolean {
  return hookEventName !== "UserPromptSubmit" || !automatedPrompt;
}

function toStoredCorrectionBundleKeys(
  candidates: readonly CorrectionCandidate[],
  project: string,
  scope: string,
  sessionIdHash: string,
): string[] {
  if (!project || !scope || !sessionIdHash) {
    return [];
  }
  const storedKeys: string[] = [];
  for (const candidate of candidates) {
    if (
      candidate.source !== "utterance_detection" ||
      !candidate.bundleKey ||
      !/^oc:v1:[0-9a-f]{64}$/iu.test(candidate.bundleKey) ||
      !candidate.conditionKnown ||
      !candidate.conditionKey
    ) {
      continue;
    }
    for (const visibility of ["project", "owner"] as const) {
      storedKeys.push(storedBundleKey(
        candidate.bundleKey,
        project,
        scope,
        sessionIdHash,
        candidate.lifetimeKind,
        visibility,
      ));
    }
  }
  return [...new Set(storedKeys)];
}

function getRequestTrigger(input: HookInput, humanOrdinal: number): CorrectionInjectionTrigger {
  if (input.hook_event_name === "SessionStart") return "start";
  if (input.hook_event_name === "PreCompact") return "compact";
  const isRefresh = humanOrdinal >= 31 && (humanOrdinal - 31) % 30 === 0;
  return isRefresh ? "refresh" : "prompt";
}

function getRenderTrigger(input: HookInput, requestTrigger: CorrectionInjectionTrigger): CorrectionRenderTrigger {
  if (input.hook_event_name === "PreCompact") return "precompact";
  if (input.hook_event_name === "SessionStart" && input.source === "compact") return "compact";
  return requestTrigger;
}

function getLedgerTrigger(input: HookInput, requestTrigger: CorrectionInjectionTrigger): CorrectionInjectionTrigger {
  if (input.hook_event_name === "SessionStart") return "start";
  if (input.hook_event_name === "PreCompact") return "compact";
  return requestTrigger;
}

function getCorrectionBudget(input: HookInput, budgetTokens: number): number {
  if (input.hook_event_name === "SessionStart") return Math.min(1800, budgetTokens);
  if (input.hook_event_name === "PreCompact") return Math.min(450, budgetTokens);
  return Math.min(800, budgetTokens);
}

export interface ContextInjectionPlan {
  requestTrigger: CorrectionInjectionTrigger;
  renderTrigger: CorrectionRenderTrigger;
  ledgerTrigger: CorrectionInjectionTrigger;
  budgetTokens: number;
}

export function getContextInjectionPlan(
  input: HookInput,
  humanOrdinal: number,
  budgetTokens: number,
): ContextInjectionPlan {
  const requestTrigger = getRequestTrigger(input, humanOrdinal);
  return {
    requestTrigger,
    renderTrigger: getRenderTrigger(input, requestTrigger),
    ledgerTrigger: getLedgerTrigger(input, requestTrigger),
    budgetTokens: getCorrectionBudget(input, budgetTokens),
  };
}

export function detectPendingCorrectionCandidates(prompt: string): CorrectionCandidate[] {
  const event = extractOwnerEvent({ hookEventName: "UserPromptSubmit", prompt });
  if (!event) return [];
  return detectOwnerCorrections(event);
}

function getOutputForNonStart(rendered: CorrectionRenderResult): string {
  return rendered.text;
}

function parseHookBudget(): number {
  const rawBudget = process.env.WASURENAGUSA_INJECTION_TOKEN_BUDGET;
  if (rawBudget === undefined) return DEFAULT_INJECTION_TOKEN_BUDGET;
  const parsed = Number.parseInt(rawBudget, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return 0;
  return Math.min(parsed, DEFAULT_INJECTION_TOKEN_BUDGET);
}

function makeEmptyCorrectionRender(trigger: CorrectionRenderTrigger, budgetTokens: number): CorrectionRenderResult {
  return renderCorrectionRules({ trigger, rules: [], budgetTokens });
}

async function buildSessionStartBody(
  storage: SQLiteStorage,
  sessionProject: string,
  memoryPath: string,
  budgetTokens: number,
  correctionRender: CorrectionRenderResult,
  correctionEnabled: boolean,
  deadlineAt: number,
  onRetrievalComplete?: () => void,
): Promise<string> {
  const remainingBudget = correctionEnabled
    ? Math.max(0, budgetTokens - estimateTokens(correctionRender.text) - 1)
    : budgetTokens;
  const indexBudget = correctionEnabled ? Math.min(5000, remainingBudget) : budgetTokens;
  requireHookTime(deadlineAt);
  const injectionResult = buildInjection(storage, sessionProject, indexBudget);
  const deficiencySkips = injectionResult.skipped.filter((label) => !BENIGN_SKIP_LABELS.has(label));
  if (deficiencySkips.length > 0) {
    console.error("[injection] 素材欠損/切り詰め:", deficiencySkips.join(", "));
    await increment(memoryPath, "injection_skipped_count", deficiencySkips.length);
    requireHookTime(deadlineAt);
  }
  requireHookTime(deadlineAt);
  const [dreamContent, successContent] = await Promise.all([
    getDreamContent(storage, sessionProject),
    getSuccessContent(storage, sessionProject),
  ]);
  requireHookTime(deadlineAt);
  const ownerProfile = await loadOwnerProfile(memoryPath);
  requireHookTime(deadlineAt);

  if (onRetrievalComplete) onRetrievalComplete();

  const output: string[] = [];
  if (correctionRender.text) output.push(correctionRender.text);
  output.push("## 記憶インデックス（詳細はサブエージェント経由で memory_get_detail を使用）\n");
  output.push(injectionResult.text || "（対象なし）");
  output.push("");
  if (dreamContent) output.push(dreamContent + "\n");
  if (successContent) output.push(successContent + "\n");

  if (ownerProfile) {
    output.push("### オーナー判断基準");
    output.push(ownerProfile);
    output.push("");
  }

  output.push("## メモリ活用ルール");
  output.push("- 詳細が必要な場合はサブエージェントに memory_search / memory_get_detail を委譲すること");
  output.push("- メインコンテキストに記憶の生データを持ち込まない");
  output.push("- 「覚えろ」と言われたら memory_save で保存すること（MEMORY.mdへの書き込み禁止）");

  const body = output.join("\n");
  if (!correctionEnabled) {
    const budgetResult = enforceInjectionTokenBudget(body, budgetTokens);
    logInjectionBudgetWarning(budgetTokens, budgetResult);
    return budgetResult.text;
  }

  const legacyBody = correctionRender.text ? body.slice(correctionRender.text.length + 1) : body;
  const legacyBudget = Math.max(0, budgetTokens - estimateTokens(correctionRender.text) - 1);
  const legacyResult = enforceInjectionTokenBudget(legacyBody, legacyBudget);
  const finalBody = correctionRender.text ? `${correctionRender.text}\n${legacyResult.text}` : legacyResult.text;
  if (estimateTokens(finalBody) > budgetTokens) return correctionRender.text;
  logInjectionBudgetWarning(legacyBudget, legacyResult);
  return finalBody;
}

type ExtractedUserPromptEvent = NonNullable<ReturnType<typeof extractOwnerEvent>>;

function saveUserPromptPendingReceipt(
  storage: SQLiteStorage,
  sessionIdHash: string,
  sessionId: string,
  uuid: string | undefined,
  lastConfirmedOrdinal: number,
  event: ExtractedUserPromptEvent,
  candidates: CorrectionCandidate[],
  receivedAt: string,
  hasOutput: boolean,
): string {
  if (!hasOutput && candidates.length === 0) return "";
  const receiptId = uuid
    ? createPendingReceiptId(sessionId, { uuid })
    : createPendingReceiptId();
  storage.runCorrectionTransaction(({ db }) => {
    const existing = db.prepare(`
      SELECT received_at FROM owner_correction_pending WHERE receipt_id = ?
    `).get(receiptId) as { received_at: string } | undefined;
    queuePendingReceipt(db as never, {
      receiptId,
      sessionIdHash,
      receivedAt: existing?.received_at ?? receivedAt,
      lastConfirmedOrdinal,
      rawTextHash: hashRawText(event.text),
      extractedCandidates: candidates,
    });
  });
  return receiptId;
}

export function addUserPromptPendingReceipt(
  storage: SQLiteStorage,
  sessionIdHash: string,
  sessionId: string,
  uuid: string | undefined,
  lastConfirmedOrdinal: number,
  prompt: string,
  receivedAt: string,
  hasOutput: boolean,
): string {
  const event = extractOwnerEvent({ hookEventName: "UserPromptSubmit", prompt });
  if (!event) return "";
  return saveUserPromptPendingReceipt(
    storage,
    sessionIdHash,
    sessionId,
    uuid,
    lastConfirmedOrdinal,
    event,
    detectOwnerCorrections(event),
    receivedAt,
    hasOutput,
  );
}

function recordPendingOutput(
  storage: SQLiteStorage,
  receiptId: string,
  compactEpoch: number,
  rendered: CorrectionRenderResult,
): void {
  const entry = rendered.ledger[0];
  if (!receiptId || !entry) return;
  storage.runCorrectionTransaction(({ db }) => {
    const result = db.prepare(`
      UPDATE owner_correction_pending
      SET output_epoch = ?, output_order = ?, output_bundle_key = ?, output_version = ?,
        output_hash = ?, output_callback_succeeded_at = ?
      WHERE receipt_id = ? AND output_callback_succeeded_at IS NULL
    `).run(
      compactEpoch,
      entry.outputOrder,
      entry.bundleKey,
      entry.version,
      rendered.outputHash,
      new Date().toISOString(),
      receiptId,
    );
    if (result.changes !== 1) throw new Error("pending correction output record failed");
  });
}

/**
 * heart-extension F3: 直近24時間以内の dream エントリ1件を
 * "### 今朝の夢\n${content}" の文字列で返す。
 * 0件 / 期間外 / 失敗時は空文字（セクション省略）。
 */
export async function getDreamContent(
  storage: SQLiteStorage,
  currentProject: string,
): Promise<string> {
  try {
    const result = storage.search({
      query: "",
      category: "dream",
      project: currentProject,
      limit: 1,
    });
    if (result.results.length === 0) return "";

    const detail = storage.getDetail({ ids: [result.results[0].id] });
    const entry = detail.entries[0];
    if (!entry) return "";

    const ts = new Date(entry.timestamp).getTime();
    if (Number.isNaN(ts)) return "";
    const ageMs = Date.now() - ts;
    const ageHours = ageMs / (1000 * 60 * 60);
    if (ageHours >= 24) return "";

    return `### 今朝の夢\n${entry.content}`;
  } catch {
    return "";
  }
}

/**
 * heart-extension F4: 直近30日以内の success エントリ上位3件を
 * "### 効いた提案パターン\n- title: 1行要約" の形式で返す。
 * 0件 / 期間外 / 失敗時は空文字（セクション省略）。
 */
export async function getSuccessContent(
  storage: SQLiteStorage,
  currentProject: string,
): Promise<string> {
  try {
    const result = storage.search({
      query: "",
      category: "success",
      project: currentProject,
      limit: 30,
    });
    if (result.results.length === 0) return "";

    const detail = storage.getDetail({ ids: result.results.map((r) => r.id) });
    const cutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1000;

    const fresh = detail.entries.filter((e) => {
      const ts = new Date(e.timestamp).getTime();
      if (Number.isNaN(ts)) return false;
      return ts >= cutoffMs;
    });
    if (fresh.length === 0) return "";

    // 既に search が timestamp DESC で返してくる前提だが、念のため再ソート
    fresh.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    const top3 = fresh.slice(0, 3);

    const lines = top3.map((e) => {
      const summary = e.content.replace(/\s+/g, " ").trim();
      const oneLine = summary.length > 80 ? summary.substring(0, 80) + "…" : summary;
      return `- **${e.title}**: ${oneLine}`;
    });

    return "### 効いた提案パターン\n" + lines.join("\n");
  } catch {
    return "";
  }
}

// トークン概算・注入バジェット強制・fail-loud警告は src/injection/budget.ts が単一実装
// （タスク4.2でそちらへ移設。呼び出し側の再実装を禁止する）。既存の import 経路
// （このファイルからのimport）を壊さないよう、ここでは re-export のみ行う。
export {
  estimateTokens,
  DEFAULT_INJECTION_TOKEN_BUDGET,
  type InjectionBudgetResult,
  enforceInjectionTokenBudget,
  logInjectionBudgetWarning,
} from "../injection/budget.js";

export type ContextHookStatus = EmitContextOutputResult["status"] | "failed";

export async function main(): Promise<ContextHookStatus> {
  const startedAt = Date.now();
  const deadlineAt = startedAt + CONTEXT_HOOK_TIMEOUT_MS;
  const stageDurationsMs = createCorrectionMetricStageDurations();
  const lap = createCorrectionMetricLap(stageDurationsMs, startedAt);
  let storage: SQLiteStorage | null = null;
  try {
    const inputData = await readStdin(deadlineAt);
    lap("stdin");
    requireHookTime(deadlineAt);
    const hookInput = parseContextHookInput(inputData);
    const correctionFeatureModes = readCorrectionFeatureModes();
    const automatedPrompt = hookInput.hook_event_name === "UserPromptSubmit" &&
      typeof hookInput.prompt === "string" &&
      isAutomatedPrompt(hookInput.prompt);
    const shouldProcessPrompt = shouldProcessPromptCorrectionWork(hookInput.hook_event_name, automatedPrompt);
    requireHookTime(deadlineAt);

    const projectRoot = findProjectRoot(hookInput.cwd);
    const currentProject = basename(projectRoot);
    const memoryPath = getMemoryPath(projectRoot);
    const correctionLoopRequested = correctionFeatureModes.correctionLoop === "on";
    const dbPath = join(memoryPath, config.sqliteFile);
    requireHookTime(deadlineAt);
    storage = SQLiteStorage.openExistingForHook(dbPath, {
      mode: correctionLoopRequested ? "auto" : "index",
    });
    const correctionLoopEnabled = correctionLoopRequested && storage.supportsCorrectionHooks;
    const correctionInjectionEnabled = correctionLoopEnabled && correctionFeatureModes.correctionInject === "on";
    const eventKind = getHookEventKind(hookInput.hook_event_name);
    const stageMetricEvent = eventKind === "SessionStart" || eventKind === "UserPromptSubmit";
    const captureStageMetrics = correctionInjectionEnabled && stageMetricEvent;
    requireHookTime(deadlineAt);

    const sessionIdHash = hashSessionId(hookInput.session_id);
    const budgetTokens = parseHookBudget();
    let sessionState = { ...EMPTY_HOOK_SESSION_STATE };
    let position: HookPosition = {
      humanOrdinal: 0,
      currentPromptLocated: false,
      lastConfirmedOrdinal: 0,
    };

    if (correctionLoopEnabled && shouldProcessPrompt) {
      if (hookInput.hook_event_name === "SessionStart") {
        sessionState = prepareSessionStartEpoch(
          storage,
          sessionIdHash,
          hookInput.source,
          new Date().toISOString(),
          currentProject,
        );
      } else if (hookInput.hook_event_name === "PreCompact") {
        sessionState = reserveCompactEpoch(
          storage,
          sessionIdHash,
          new Date().toISOString(),
          currentProject,
        );
      } else {
        sessionState = readHookSessionState(storage, sessionIdHash, currentProject);
      }
      requireHookTime(deadlineAt);
    }
    if (correctionLoopEnabled && shouldProcessPrompt) {
      position = await resolveHookPosition(storage, hookInput, sessionIdHash, sessionState, deadlineAt);
      requireHookTime(deadlineAt);
    }
    if (captureStageMetrics) lap("position");

    const userPromptEvent = hookInput.hook_event_name === "UserPromptSubmit" && !automatedPrompt
      ? extractOwnerEvent({ hookEventName: "UserPromptSubmit", prompt: hookInput.prompt })
      : undefined;
    const canDetectCurrentCorrections =
      correctionLoopEnabled &&
      hookInput.hook_event_name === "UserPromptSubmit" &&
      userPromptEvent !== null &&
      userPromptEvent !== undefined;
    let detectedCandidates: CorrectionCandidate[] = [];
    if (canDetectCurrentCorrections) detectedCandidates = detectOwnerCorrections(userPromptEvent);
    let pendingCandidates: CorrectionCandidate[] | undefined;
    if (canDetectCurrentCorrections && !position.currentPromptLocated && hookInput.prompt !== undefined) {
      pendingCandidates = detectedCandidates;
    }
    if (captureStageMetrics) lap("detect");

    let sessionProject = currentProject;
    if (sessionState.project) sessionProject = sessionState.project;

    const correctionScope = "general";
    const detectedStoredCorrectionBundleKeys = toStoredCorrectionBundleKeys(
      detectedCandidates,
      sessionProject,
      correctionScope,
      sessionIdHash,
    );
    const injectionPlan = getContextInjectionPlan(hookInput, position.humanOrdinal, budgetTokens);
    let selection: CorrectionInjectionSelection = {
      rules: [],
      unreached: [],
      alwaysOnCount: 0,
      ftsCandidateCount: 0,
      correctionMatchedReinjectionKeys: [],
    };
    let correctionRender = makeEmptyCorrectionRender(injectionPlan.renderTrigger, injectionPlan.budgetTokens);
    if (correctionInjectionEnabled && shouldProcessPrompt) {
      requireHookTime(deadlineAt);
      selection = selectCorrectionInjections(storage, {
        project: sessionProject,
        scope: correctionScope,
        query: hookInput.prompt ?? "",
        at: new Date().toISOString(),
        sessionIdHash,
        compactEpoch: sessionState.compactEpoch,
        humanOrdinal: position.humanOrdinal,
        trigger: injectionPlan.requestTrigger,
        detectedStoredCorrectionBundleKeys,
        featureModes: correctionFeatureModes,
      });
      requireHookTime(deadlineAt);
    }
    if (captureStageMetrics) lap("retrieve");
    let output: string;
    if (hookInput.hook_event_name === "SessionStart") {
      if (correctionInjectionEnabled && shouldProcessPrompt) {
        correctionRender = renderCorrectionRules({
          trigger: injectionPlan.renderTrigger,
          rules: selection.rules,
          budgetTokens: injectionPlan.budgetTokens,
        });
        requireHookTime(deadlineAt);
      }
      output = await buildSessionStartBody(
        storage,
        sessionProject,
        memoryPath,
        budgetTokens,
        correctionRender,
        correctionInjectionEnabled,
        deadlineAt,
        captureStageMetrics ? () => lap("retrieve") : undefined,
      );
    } else {
      if (correctionInjectionEnabled && shouldProcessPrompt) {
        correctionRender = renderCorrectionRules({
          trigger: injectionPlan.renderTrigger,
          rules: selection.rules,
          budgetTokens: injectionPlan.budgetTokens,
        });
        requireHookTime(deadlineAt);
      }
      output = getOutputForNonStart(correctionRender);
    }
    requireHookTime(deadlineAt);
    const outputReadyAt = Date.now();
    if (captureStageMetrics) lap("render");
    const durationMs = Math.max(0, outputReadyAt - startedAt);

    const tokens = estimateTokens(output);
    const missingCount = automatedPrompt
      ? 0
      : selection.unreached.length + correctionRender.omittedBundleKeys.length;
    if (correctionInjectionEnabled && !stageMetricEvent) {
      await recordCorrectionMetric(memoryPath, {
        eventKind,
        durationMs,
        tokens,
        missingCount,
        reasonCode: automatedPrompt ? "automated_prompt" : undefined,
      });
      requireHookTime(deadlineAt);
    }

    let pendingReceiptId: string | undefined;
    if (
      correctionLoopEnabled &&
      hookInput.hook_event_name === "UserPromptSubmit" &&
      !position.currentPromptLocated &&
      hookInput.prompt !== undefined &&
      userPromptEvent !== null &&
      userPromptEvent !== undefined &&
      pendingCandidates !== undefined
    ) {
      requireHookTime(deadlineAt);
      pendingReceiptId = saveUserPromptPendingReceipt(
        storage,
        sessionIdHash,
        hookInput.session_id,
        hookInput.uuid,
        position.lastConfirmedOrdinal,
        userPromptEvent,
        pendingCandidates,
        new Date().toISOString(),
        correctionRender.ledger.length > 0,
      );
      requireHookTime(deadlineAt);
      if (captureStageMetrics) lap("store");
    }

    const result = await emitContextOutput({
      output,
      rendered: correctionRender,
      storage,
      sessionIdHash,
      compactEpoch: sessionState.compactEpoch,
      humanOrdinal: position.humanOrdinal,
      trigger: injectionPlan.ledgerTrigger,
      deadlineAt,
      pendingReceiptId,
      lap: captureStageMetrics ? lap : undefined,
    });
    const matchedCorrectionKeys = new Set(selection.correctionMatchedReinjectionKeys);
    const emittedCorrectionReinjections = result.rendered.ledger.filter((entry) =>
      matchedCorrectionKeys.has(`${entry.bundleKey}:${entry.version}`),
    ).length;
    if (
      emittedCorrectionReinjections > 0 &&
      (result.status === "emitted" || result.status === "ledger_unknown")
    ) {
      await increment(memoryPath, "correction_reinjected_correction_match", emittedCorrectionReinjections);
    }
    if (correctionInjectionEnabled && stageMetricEvent) {
      await recordCorrectionMetric(memoryPath, {
        eventKind,
        durationMs,
        tokens,
        missingCount,
        reasonCode: automatedPrompt ? "automated_prompt" : undefined,
        stageDurationsMs,
      });
    }
    if (result.status === "write_failed") console.error("[context] stdout write failed");
    if (result.status === "ledger_unknown") console.error("[context] correction ledger unknown");
    if (result.status === "timeout") console.error("[context] hook timeout");
    return result.status;
  } catch (error) {
    if (error instanceof HookTimeoutError || Date.now() >= deadlineAt - CONTEXT_HOOK_OUTPUT_RESERVE_MS) {
      console.error("[context] hook timeout");
      return "timeout";
    } else {
      console.error("[context] hook failed");
      return "failed";
    }
  } finally {
    storage?.close();
  }
}
if (isDirectRun(process.argv[1], import.meta.url)) {
  main().catch(() => console.error("[context] hook failed"));
}
