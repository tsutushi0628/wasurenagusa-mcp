import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export const MAX_PENDING_CANDIDATES = 3;

export interface SessionProgress {
  humanOrdinal: number;
  transcriptOffset: number;
  transcriptIdentity: string;
}

export interface SessionCorrectionEvidence {
  bundleKey: string;
  source: "utterance_detection" | "request_repeat" | "legacy_import";
  score: number;
  detectorVersion: string;
  conditions: string;
  polarity: string;
}

export interface SessionCorrectionEvent {
  eventId: string;
  sourceUuidHash?: string | null;
  observedAt: string;
  availableAt: string;
  sourceKind: "user" | "queued_command" | "hook" | "legacy_import";
  excerpt: string;
  previousAction: string;
  actionFirstLocatorHash?: string | null;
  actionLastLocatorHash?: string | null;
  project: string;
  scope: string;
  rawTextHash: string;
  sourceLocatorHash: string;
  processedAt: string;
  evidence?: readonly SessionCorrectionEvidence[];
}

export interface PendingReceiptInput {
  receiptId: string;
  sessionIdHash: string;
  receivedAt: string;
  lastConfirmedOrdinal: number;
  rawTextHash: string;
  extractedCandidates: readonly unknown[];
  actionFirstLocatorHash?: string | null;
  actionLastLocatorHash?: string | null;
}

export interface CommitTranscriptBatchInput {
  sessionIdHash: string;
  expected: SessionProgress;
  nextCursor: {
    transcriptOffset: number;
    transcriptIdentity: string;
    reset?: boolean;
  };
  lastSeenAt: string;
  events: readonly SessionCorrectionEvent[];
}

export interface PendingMatch {
  receiptId: string;
  eventId: string;
  humanOrdinal: number;
}

export type CommitTranscriptBatchResult =
  | {
      committed: false;
      reason: "stale_cursor";
      humanOrdinal: number;
      insertedEventIds: [];
      matchedReceipts: [];
    }
  | {
      committed: true;
      humanOrdinal: number;
      insertedEventIds: string[];
      matchedReceipts: PendingMatch[];
    };

type SessionRow = {
  human_ordinal: number;
  transcript_offset: number;
  transcript_identity: string;
};

type PendingRow = {
  receipt_id: string;
  last_confirmed_ordinal: number;
  raw_text_hash: string;
  matched_event_id: string | null;
};

type EventRow = {
  event_id: string;
  human_ordinal: number;
  raw_text_hash: string;
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function inTransaction<T>(db: Database.Database, callback: () => T): T {
  if (db.inTransaction) return callback();
  return db.transaction(callback).immediate();
}

function validateOrdinal(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

function validateProgress(progress: SessionProgress): void {
  validateOrdinal(progress.humanOrdinal, "human ordinal");
  validateOrdinal(progress.transcriptOffset, "transcript offset");
}

function readSessionProgress(db: Database.Database, sessionIdHash: string): SessionRow | undefined {
  return db.prepare(`
    SELECT human_ordinal, transcript_offset, transcript_identity
    FROM owner_correction_sessions
    WHERE session_id_hash = ?
  `).get(sessionIdHash) as SessionRow | undefined;
}

type SessionProjectDatabase = Pick<Database.Database, "prepare">;

export function resolveSessionProject(
  db: SessionProjectDatabase,
  sessionIdHash: string,
  cwdProject: string,
): string {
  if (!sessionIdHash) throw new Error("session id hash is required");
  if (!cwdProject) throw new Error("cwd project is required");
  const row = db.prepare(`
    SELECT project FROM owner_correction_events
    WHERE session_id_hash = ?
    ORDER BY human_ordinal ASC, event_id ASC
    LIMIT 1
  `).get(sessionIdHash) as { project: string } | undefined;
  if (!row) return cwdProject;
  return row.project;
}

function claimSessionCursor(db: Database.Database, input: CommitTranscriptBatchInput): void {
  if (
    input.expected.humanOrdinal === 0 &&
    input.expected.transcriptOffset === 0 &&
    input.expected.transcriptIdentity === ""
  ) {
    db.prepare(`
      INSERT INTO owner_correction_sessions (
        session_id_hash, human_ordinal, transcript_offset, transcript_identity,
        compact_epoch, last_refresh_ordinal, last_seen_at
      ) VALUES (?, 0, 0, '', 0, 0, ?)
      ON CONFLICT(session_id_hash) DO NOTHING
    `).run(input.sessionIdHash, input.lastSeenAt);
  }

  db.prepare(`
    UPDATE owner_correction_sessions
    SET human_ordinal = human_ordinal
    WHERE session_id_hash = ? AND human_ordinal = ? AND transcript_offset = ? AND transcript_identity = ?
  `).run(
    input.sessionIdHash,
    input.expected.humanOrdinal,
    input.expected.transcriptOffset,
    input.expected.transcriptIdentity,
  );
}

function matchesExpected(row: SessionRow | undefined, expected: SessionProgress): boolean {
  if (!row) {
    return expected.humanOrdinal === 0 &&
      expected.transcriptOffset === 0 &&
      expected.transcriptIdentity === "";
  }
  return row.human_ordinal === expected.humanOrdinal &&
    row.transcript_offset === expected.transcriptOffset &&
    row.transcript_identity === expected.transcriptIdentity;
}

function validateEvent(event: SessionCorrectionEvent): void {
  if (!event.eventId || !event.project || !event.scope || !event.rawTextHash || !event.sourceLocatorHash) {
    throw new Error("correction event is missing an identifier or required field");
  }
  if (Array.from(event.excerpt).length > 120) throw new Error("correction excerpt exceeds 120 characters");
  if (Array.from(event.previousAction).length > 160) throw new Error("previous action exceeds 160 characters");
  let evidenceCount = 0;
  if (event.evidence) evidenceCount = event.evidence.length;
  if (evidenceCount > MAX_PENDING_CANDIDATES) {
    throw new Error("correction event exceeds the three-candidate limit");
  }
}

function insertCorrectionEvent(
  db: Database.Database,
  sessionIdHash: string,
  event: SessionCorrectionEvent,
  humanOrdinal: number,
): boolean {
  let sourceUuidHash: string | null = null;
  let actionFirstLocatorHash: string | null = null;
  let actionLastLocatorHash: string | null = null;
  if (event.sourceUuidHash !== undefined) sourceUuidHash = event.sourceUuidHash;
  if (event.actionFirstLocatorHash !== undefined) actionFirstLocatorHash = event.actionFirstLocatorHash;
  if (event.actionLastLocatorHash !== undefined) actionLastLocatorHash = event.actionLastLocatorHash;

  const result = db.prepare(`
    INSERT INTO owner_correction_events (
      event_id, session_id_hash, source_uuid_hash, human_ordinal, observed_at, available_at,
      source_kind, excerpt, previous_action, action_first_locator_hash, action_last_locator_hash,
      project, scope, raw_text_hash, source_locator_hash, processed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id) DO NOTHING
  `).run(
    event.eventId,
    sessionIdHash,
    sourceUuidHash,
    humanOrdinal,
    event.observedAt,
    event.availableAt,
    event.sourceKind,
    event.excerpt,
    event.previousAction,
    actionFirstLocatorHash,
    actionLastLocatorHash,
    event.project,
    event.scope,
    event.rawTextHash,
    event.sourceLocatorHash,
    event.processedAt,
  );

  if (result.changes === 0) {
    const existing = db.prepare(`
      SELECT session_id_hash, raw_text_hash
      FROM owner_correction_events WHERE event_id = ?
    `).get(event.eventId) as { session_id_hash: string; raw_text_hash: string } | undefined;
    if (!existing || existing.session_id_hash !== sessionIdHash || existing.raw_text_hash !== event.rawTextHash) {
      throw new Error("correction event id collision");
    }
    return false;
  }

  if (event.evidence) {
    for (const evidence of event.evidence) {
      db.prepare(`
        INSERT INTO owner_correction_evidence (
          event_id, bundle_key, source, score, detector_version, conditions, polarity
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.eventId,
        evidence.bundleKey,
        evidence.source,
        evidence.score,
        evidence.detectorVersion,
        evidence.conditions,
        evidence.polarity,
      );
    }
  }
  return true;
}

function updateSessionProgress(
  db: Database.Database,
  sessionIdHash: string,
  expected: SessionProgress,
  nextCursor: CommitTranscriptBatchInput["nextCursor"],
  humanOrdinal: number,
  lastSeenAt: string,
): void {
  const result = db.prepare(`
    UPDATE owner_correction_sessions
    SET human_ordinal = ?, transcript_offset = ?, transcript_identity = ?, last_seen_at = ?
    WHERE session_id_hash = ? AND human_ordinal = ? AND transcript_offset = ? AND transcript_identity = ?
  `).run(
    humanOrdinal,
    nextCursor.transcriptOffset,
    nextCursor.transcriptIdentity,
    lastSeenAt,
    sessionIdHash,
    expected.humanOrdinal,
    expected.transcriptOffset,
    expected.transcriptIdentity,
  );
  if (result.changes !== 1) throw new Error("correction session cursor changed during commit");
}

function attachPendingReceipts(db: Database.Database, sessionIdHash: string): PendingMatch[] {
  const pendingRows = db.prepare(`
    SELECT receipt_id, last_confirmed_ordinal, raw_text_hash, matched_event_id
    FROM owner_correction_pending
    WHERE session_id_hash = ?
    ORDER BY received_at, receipt_id
  `).all(sessionIdHash) as PendingRow[];
  const eventRows = db.prepare(`
    SELECT event_id, human_ordinal, raw_text_hash
    FROM owner_correction_events
    WHERE session_id_hash = ?
    ORDER BY human_ordinal, event_id
  `).all(sessionIdHash) as EventRow[];
  const usedEvents = new Set<string>();
  for (const pending of pendingRows) {
    if (pending.matched_event_id) usedEvents.add(pending.matched_event_id);
  }
  const assignments = new Map<string, EventRow>();
  const pendingById = new Map(pendingRows.map((pending) => [pending.receipt_id, pending]));

  for (const pending of pendingRows) {
    if (pending.matched_event_id) continue;
    const exact = eventRows.find((event) =>
      event.event_id === pending.receipt_id &&
      event.raw_text_hash === pending.raw_text_hash &&
      !usedEvents.has(event.event_id),
    );
    if (!exact) continue;
    assignments.set(pending.receipt_id, exact);
    usedEvents.add(exact.event_id);
  }

  const possibleByReceipt = new Map<string, EventRow[]>();
  const possibleByEvent = new Map<string, PendingRow[]>();
  for (const pending of pendingRows) {
    if (pending.matched_event_id || assignments.has(pending.receipt_id)) continue;
    const sameTextEvents = eventRows.filter((event) =>
      !usedEvents.has(event.event_id) &&
      event.raw_text_hash === pending.raw_text_hash &&
      event.human_ordinal > pending.last_confirmed_ordinal,
    );
    let possible: EventRow[] = [];
    if (
      sameTextEvents.length === 1 &&
      sameTextEvents[0].human_ordinal === pending.last_confirmed_ordinal + 1
    ) {
      possible = sameTextEvents;
    }
    possibleByReceipt.set(pending.receipt_id, possible);
    for (const event of possible) {
      let pendingForEvent = possibleByEvent.get(event.event_id);
      if (!pendingForEvent) pendingForEvent = [];
      pendingForEvent.push(pending);
      possibleByEvent.set(event.event_id, pendingForEvent);
    }
  }

  for (const [receiptId, possibleEvents] of possibleByReceipt) {
    if (possibleEvents.length !== 1) continue;
    const event = possibleEvents[0];
    if (possibleByEvent.get(event.event_id)?.length !== 1) continue;
    assignments.set(receiptId, event);
    usedEvents.add(event.event_id);
  }

  const matches: PendingMatch[] = [];
  for (const [receiptId, event] of assignments) {
    const pending = pendingById.get(receiptId);
    if (!pending) throw new Error("pending receipt disappeared during matching");
    const result = db.prepare(`
      UPDATE owner_correction_pending
      SET matched_event_id = ?
      WHERE receipt_id = ? AND matched_event_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM owner_correction_pending WHERE matched_event_id = ?
        )
    `).run(event.event_id, receiptId, event.event_id);
    if (result.changes === 1) {
      matches.push({ receiptId, eventId: event.event_id, humanOrdinal: event.human_ordinal });
    }
  }
  return matches;
}

/** セッションIDを保存用のSHA-256値へ変換する。 */
export function hashSessionId(sessionId: string): string {
  if (!sessionId) throw new Error("session id is required");
  return sha256(sessionId);
}

/** 発話本文の完全一致照合に使うSHA-256値を返す。 */
export function hashRawText(rawText: string): string {
  return sha256(rawText);
}

/** UUID、またはJSONL上の一意な位置から発話IDを作る。 */
export function createCorrectionEventId(
  sessionId: string,
  locator: { uuid?: string; transcriptPosition?: string | number },
): string {
  if (!sessionId) throw new Error("session id is required");
  let source: string;
  if (locator.uuid) {
    source = `uuid\u0000${locator.uuid}`;
  } else if (typeof locator.transcriptPosition === "number" && Number.isSafeInteger(locator.transcriptPosition)) {
    validateOrdinal(locator.transcriptPosition, "transcript position");
    source = `position\u0000${String(locator.transcriptPosition)}`;
  } else if (typeof locator.transcriptPosition === "string" && locator.transcriptPosition.length > 0) {
    source = `position\u0000${String(locator.transcriptPosition)}`;
  } else {
    throw new Error("correction event requires a transcript UUID or position");
  }
  return sha256(`${hashSessionId(sessionId)}\u0000${source}`);
}

/** JSONL位置の個人情報を含まないlocator hashを返す。 */
export function hashTranscriptPosition(sessionId: string, transcriptPosition: number): string {
  validateOrdinal(transcriptPosition, "transcript position");
  return sha256(`${hashSessionId(sessionId)}\u0000position\u0000${transcriptPosition}`);
}

/** 既知のUUID/位置があればeventと共通ID、無ければ一意な仮IDを作る。 */
export function createPendingReceiptId(): string;
export function createPendingReceiptId(
  sessionId: string,
  locator: { uuid?: string; transcriptPosition?: string | number },
): string;
export function createPendingReceiptId(
  sessionId?: string,
  locator?: { uuid?: string; transcriptPosition?: string | number },
): string {
  if (sessionId && locator) return createCorrectionEventId(sessionId, locator);
  if (sessionId || locator) throw new Error("session id and transcript locator must be provided together");
  return randomUUID();
}

/** 未照合receiptを保存する。既存receiptの再配信は同じ内容なら0件追加で扱う。 */
export function queuePendingReceipt(db: Database.Database, receipt: PendingReceiptInput): boolean {
  validateOrdinal(receipt.lastConfirmedOrdinal, "last confirmed ordinal");
  if (!receipt.receiptId || !receipt.sessionIdHash || !receipt.rawTextHash) {
    throw new Error("pending receipt is missing an identifier or required field");
  }
  if (receipt.extractedCandidates.length > MAX_PENDING_CANDIDATES) {
    throw new Error("pending receipt exceeds the three-candidate limit");
  }
  const extractedCandidates = JSON.stringify(receipt.extractedCandidates);
  let actionFirstLocatorHash: string | null = null;
  let actionLastLocatorHash: string | null = null;
  if (receipt.actionFirstLocatorHash !== undefined) actionFirstLocatorHash = receipt.actionFirstLocatorHash;
  if (receipt.actionLastLocatorHash !== undefined) actionLastLocatorHash = receipt.actionLastLocatorHash;

  return inTransaction(db, () => {
    const inserted = db.prepare(`
      INSERT INTO owner_correction_pending (
        receipt_id, session_id_hash, received_at, last_confirmed_ordinal, raw_text_hash,
        extracted_candidates, action_first_locator_hash, action_last_locator_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(receipt_id) DO NOTHING
    `).run(
      receipt.receiptId,
      receipt.sessionIdHash,
      receipt.receivedAt,
      receipt.lastConfirmedOrdinal,
      receipt.rawTextHash,
      extractedCandidates,
      actionFirstLocatorHash,
      actionLastLocatorHash,
    );
    if (inserted.changes === 1) return true;

    const existing = db.prepare(`
      SELECT session_id_hash, received_at, last_confirmed_ordinal, raw_text_hash,
        extracted_candidates, action_first_locator_hash, action_last_locator_hash
      FROM owner_correction_pending WHERE receipt_id = ?
    `).get(receipt.receiptId) as {
      session_id_hash: string;
      received_at: string;
      last_confirmed_ordinal: number;
      raw_text_hash: string;
      extracted_candidates: string;
      action_first_locator_hash: string | null;
      action_last_locator_hash: string | null;
    } | undefined;
    if (!existing) throw new Error("pending receipt insert failed without an existing row");
    const same = existing.session_id_hash === receipt.sessionIdHash &&
        existing.received_at === receipt.receivedAt &&
        existing.last_confirmed_ordinal === receipt.lastConfirmedOrdinal &&
        existing.raw_text_hash === receipt.rawTextHash &&
        existing.extracted_candidates === extractedCandidates &&
        existing.action_first_locator_hash === actionFirstLocatorHash &&
        existing.action_last_locator_hash === actionLastLocatorHash;
    if (!same) throw new Error("pending receipt id collision");
    return false;
  });
}

/** event/evidence、通し番号、pending照合、cursorを1 transactionで確定する。 */
export function commitTranscriptBatch(
  db: Database.Database,
  input: CommitTranscriptBatchInput,
): CommitTranscriptBatchResult {
  validateProgress(input.expected);
  validateOrdinal(input.nextCursor.transcriptOffset, "next transcript offset");
  if (!input.nextCursor.transcriptIdentity) throw new Error("next transcript identity is required");
  if (input.nextCursor.transcriptOffset < input.expected.transcriptOffset && !input.nextCursor.reset) {
    throw new Error("transcript cursor cannot move backwards without a reset");
  }
  for (const event of input.events) validateEvent(event);

  return inTransaction(db, () => {
    claimSessionCursor(db, input);
    const current = readSessionProgress(db, input.sessionIdHash);
    if (!matchesExpected(current, input.expected)) {
      let humanOrdinal = 0;
      if (current) humanOrdinal = current.human_ordinal;
      return {
        committed: false,
        reason: "stale_cursor",
        humanOrdinal,
        insertedEventIds: [],
        matchedReceipts: [],
      };
    }

    let humanOrdinal = 0;
    if (current) humanOrdinal = current.human_ordinal;
    const insertedEventIds: string[] = [];
    for (const event of input.events) {
      const inserted = insertCorrectionEvent(db, input.sessionIdHash, event, humanOrdinal + 1);
      if (inserted) {
        humanOrdinal += 1;
        insertedEventIds.push(event.eventId);
      }
    }

    updateSessionProgress(
      db,
      input.sessionIdHash,
      input.expected,
      input.nextCursor,
      humanOrdinal,
      input.lastSeenAt,
    );
    const matchedReceipts = attachPendingReceipts(db, input.sessionIdHash);
    return { committed: true, humanOrdinal, insertedEventIds, matchedReceipts };
  });
}
