import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeCorrectionSchema } from "../storage/correction-schema.js";
import { SQLiteStorage } from "../storage/sqlite.js";
import {
  MAX_PENDING_CANDIDATES,
  commitTranscriptBatch,
  createCorrectionEventId,
  createPendingReceiptId,
  hashRawText,
  hashSessionId,
  queuePendingReceipt,
  resolveSessionProject,
  type SessionCorrectionEvent,
  type SessionProgress,
} from "./session-store.js";

const INITIAL_PROGRESS: SessionProgress = {
  humanOrdinal: 0,
  transcriptOffset: 0,
  transcriptIdentity: "",
};

describe("correction session store", () => {
  let tempDir: string;
  let storage: SQLiteStorage;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "correction-session-store-"));
    const dbPath = join(tempDir, "memory.db");
    const initialStorage = new SQLiteStorage(dbPath);
    initialStorage.initialize();
    initialStorage.close();

    const db = new Database(dbPath);
    initializeCorrectionSchema(db);
    db.close();

    storage = new SQLiteStorage(dbPath);
    storage.initialize();
  });

  afterEach(() => {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function addBundle(bundleKey: string): void {
    storage.runCorrectionTransaction(({ db }) => {
      db.prepare(`
        INSERT INTO owner_correction_bundles (
          bundle_key, memory_id, rule_text, topic_key, polarity, condition_key, project, scope,
          visibility, status, intensity, occurrence_count, session_count, first_seen_at, last_seen_at,
          expires_at, lifetime_kind, continuation_basis, confirmed_at, version, counterevidence_event_id,
          last_confirmation_asked_at, confirmation_state
        ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, NULL, NULL, ?)
      `).run(
        bundleKey, "合成規則", "verification", "negative", "general", "fixture-project", "backend",
        "project", "candidate", 1, 0, 0, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z",
        "explicit_continuing", "fixture", 1, "none",
      );
    });
  }

  function readState(sessionIdHash: string) {
    return storage.runCorrectionTransaction(({ db }) => ({
      session: db.prepare(`
        SELECT human_ordinal, transcript_offset, transcript_identity
        FROM owner_correction_sessions WHERE session_id_hash = ?
      `).get(sessionIdHash),
      events: db.prepare(`
        SELECT event_id, human_ordinal FROM owner_correction_events
        WHERE session_id_hash = ? ORDER BY human_ordinal
      `).all(sessionIdHash),
      evidenceCount: db.prepare("SELECT COUNT(*) AS count FROM owner_correction_evidence").get(),
      pending: db.prepare(`
        SELECT receipt_id, matched_event_id FROM owner_correction_pending
        ORDER BY receipt_id
      `).all(),
    }));
  }

  function makeEvent(
    sessionId: string,
    rawText: string,
    uuid: string,
    bundleKeys: string[],
    overrides: Partial<SessionCorrectionEvent> = {},
  ): SessionCorrectionEvent {
    return {
      eventId: createCorrectionEventId(sessionId, { uuid }),
      sourceUuidHash: "uuid-hash",
      observedAt: "2026-01-01T00:00:00.000Z",
      availableAt: "2026-01-01T00:00:01.000Z",
      sourceKind: "user",
      excerpt: "合成発話",
      previousAction: "action_unknown",
      project: "fixture-project",
      scope: "backend",
      rawTextHash: hashRawText(rawText),
      sourceLocatorHash: `locator-${uuid}`,
      processedAt: "2026-01-01T00:00:02.000Z",
      evidence: bundleKeys.map((bundleKey) => ({
        bundleKey,
        source: "utterance_detection",
        score: 6,
        detectorVersion: "fixture-v1",
        conditions: "[]",
        polarity: "negative",
      })),
      ...overrides,
    };
  }

  it("複数根拠を持つ一発話のordinalは1回だけ増える", () => {
    addBundle("bundle-one");
    addBundle("bundle-two");
    const sessionId = "synthetic-session";
    const sessionIdHash = hashSessionId(sessionId);
    const event = makeEvent(sessionId, "合成注意", "event-one", ["bundle-one", "bundle-two"]);

    const result = storage.runCorrectionTransaction(({ db }) => commitTranscriptBatch(db, {
      sessionIdHash,
      expected: INITIAL_PROGRESS,
      nextCursor: { transcriptOffset: 256, transcriptIdentity: "file-one:marker-one" },
      lastSeenAt: "2026-01-01T00:00:03.000Z",
      events: [event],
    }));

    expect(result).toMatchObject({ committed: true, humanOrdinal: 1, insertedEventIds: [event.eventId] });
    expect(readState(sessionIdHash)).toMatchObject({
      session: { human_ordinal: 1, transcript_offset: 256, transcript_identity: "file-one:marker-one" },
      events: [{ event_id: event.eventId, human_ordinal: 1 }],
      evidenceCount: { count: 2 },
    });
  });

  it("同じsessionの後続発話はcwdが変わっても最初のevent projectを使う", () => {
    const sessionId = "synthetic-session";
    const sessionIdHash = hashSessionId(sessionId);
    const initialProject = storage.runCorrectionTransaction(({ db }) =>
      resolveSessionProject(db, sessionIdHash, "startup-project"),
    );
    expect(initialProject).toBe("startup-project");

    const firstEvent = makeEvent(sessionId, "合成の第一発話", "event-one", [], {
      project: initialProject,
    });
    storage.runCorrectionTransaction(({ db }) => commitTranscriptBatch(db, {
      sessionIdHash,
      expected: INITIAL_PROGRESS,
      nextCursor: { transcriptOffset: 128, transcriptIdentity: "file-one:marker-one" },
      lastSeenAt: "2026-01-01T00:00:03.000Z",
      events: [firstEvent],
    }));

    const laterProject = storage.runCorrectionTransaction(({ db }) =>
      resolveSessionProject(db, sessionIdHash, "later-cwd-project"),
    );
    const secondEvent = makeEvent(sessionId, "合成の第二発話", "event-two", [], {
      project: laterProject,
    });
    storage.runCorrectionTransaction(({ db }) => commitTranscriptBatch(db, {
      sessionIdHash,
      expected: { humanOrdinal: 1, transcriptOffset: 128, transcriptIdentity: "file-one:marker-one" },
      nextCursor: { transcriptOffset: 256, transcriptIdentity: "file-one:marker-two" },
      lastSeenAt: "2026-01-01T00:00:04.000Z",
      events: [secondEvent],
    }));

    const projects = storage.runCorrectionTransaction(({ db }) => db.prepare(`
      SELECT project FROM owner_correction_events
      WHERE session_id_hash = ? ORDER BY human_ordinal
    `).all(sessionIdHash) as { project: string }[]);
    expect(projects.map((event) => event.project)).toEqual(["startup-project", "startup-project"]);
  });

  it("同じreceiptの再配信はpendingを重複保存しない", () => {
    const sessionIdHash = hashSessionId("synthetic-session");
    const receipt = {
      receiptId: "stable-receipt",
      sessionIdHash,
      receivedAt: "2026-01-01T00:00:01.000Z",
      lastConfirmedOrdinal: 0,
      rawTextHash: hashRawText("合成発話"),
      extractedCandidates: [{ bundleKey: "bundle-one" }],
    };
    const results = storage.runCorrectionTransaction(({ db }) => [
      queuePendingReceipt(db, receipt),
      queuePendingReceipt(db, receipt),
    ]);

    expect(results).toEqual([true, false]);
    expect(readState(sessionIdHash).pending).toEqual([
      { receipt_id: "stable-receipt", matched_event_id: null },
    ]);
  });

  it("pending候補は3件まで保存し、上限超過を拒否する", () => {
    const sessionIdHash = hashSessionId("synthetic-session");
    const base = {
      sessionIdHash,
      receivedAt: "2026-01-01T00:00:01.000Z",
      lastConfirmedOrdinal: 0,
      rawTextHash: hashRawText("合成発話"),
    };
    const accepted = Array.from({ length: MAX_PENDING_CANDIDATES }, (_, index) => ({ bundleKey: `bundle-${index}` }));
    const rejected = Array.from({ length: MAX_PENDING_CANDIDATES + 1 }, (_, index) => ({ bundleKey: `bundle-${index}` }));
    const saved = storage.runCorrectionTransaction(({ db }) => queuePendingReceipt(db, {
      ...base,
      receiptId: "three-candidates",
      extractedCandidates: accepted,
    }));

    expect(saved).toBe(true);
    expect(() => storage.runCorrectionTransaction(({ db }) => queuePendingReceipt(db, {
      ...base,
      receiptId: "four-candidates",
      extractedCandidates: rejected,
    }))).toThrow("pending receipt exceeds the three-candidate limit");
  });

  it("同じeventの再配信はordinalも根拠数も増やさない", () => {
    addBundle("bundle-one");
    const sessionId = "synthetic-session";
    const sessionIdHash = hashSessionId(sessionId);
    const event = makeEvent(sessionId, "合成注意", "event-one", ["bundle-one"]);
    storage.runCorrectionTransaction(({ db }) => commitTranscriptBatch(db, {
      sessionIdHash,
      expected: INITIAL_PROGRESS,
      nextCursor: { transcriptOffset: 128, transcriptIdentity: "file-one:marker-one" },
      lastSeenAt: "2026-01-01T00:00:03.000Z",
      events: [event],
    }));

    const repeated = storage.runCorrectionTransaction(({ db }) => commitTranscriptBatch(db, {
      sessionIdHash,
      expected: { humanOrdinal: 1, transcriptOffset: 128, transcriptIdentity: "file-one:marker-one" },
      nextCursor: { transcriptOffset: 256, transcriptIdentity: "file-one:marker-two" },
      lastSeenAt: "2026-01-01T00:00:04.000Z",
      events: [event],
    }));

    expect(repeated).toMatchObject({ committed: true, humanOrdinal: 1, insertedEventIds: [] });
    expect(readState(sessionIdHash)).toMatchObject({
      session: { human_ordinal: 1, transcript_offset: 256 },
      events: [{ event_id: event.eventId, human_ordinal: 1 }],
      evidenceCount: { count: 1 },
    });
  });

  it("同文の並行pendingと連投は照合先が一意になるまで保留する", () => {
    const sessionId = "synthetic-session";
    const sessionIdHash = hashSessionId(sessionId);
    const rawTextHash = hashRawText("同じ合成発話");
    storage.runCorrectionTransaction(({ db }) => {
      queuePendingReceipt(db, {
        receiptId: "receipt-one",
        sessionIdHash,
        receivedAt: "2026-01-01T00:00:01.000Z",
        lastConfirmedOrdinal: 0,
        rawTextHash,
        extractedCandidates: [{ bundleKey: "bundle-one" }],
      });
      queuePendingReceipt(db, {
        receiptId: "receipt-two",
        sessionIdHash,
        receivedAt: "2026-01-01T00:00:01.000Z",
        lastConfirmedOrdinal: 0,
        rawTextHash,
        extractedCandidates: [{ bundleKey: "bundle-one" }],
      });
    });

    const firstEvent = makeEvent(sessionId, "同じ合成発話", "event-one", []);
    const secondEvent = makeEvent(sessionId, "同じ合成発話", "event-two", []);
    const result = storage.runCorrectionTransaction(({ db }) => commitTranscriptBatch(db, {
      sessionIdHash,
      expected: INITIAL_PROGRESS,
      nextCursor: { transcriptOffset: 128, transcriptIdentity: "file-one:marker-one" },
      lastSeenAt: "2026-01-01T00:00:03.000Z",
      events: [firstEvent, secondEvent],
    }));

    expect(result.matchedReceipts).toEqual([]);
    expect(readState(sessionIdHash).pending).toEqual([
      { receipt_id: "receipt-one", matched_event_id: null },
      { receipt_id: "receipt-two", matched_event_id: null },
    ]);
  });

  it("UUIDがある同文連投は元位置IDで対応付ける", () => {
    const sessionId = "synthetic-session";
    const sessionIdHash = hashSessionId(sessionId);
    const rawText = "同じ合成発話";
    const firstEvent = makeEvent(sessionId, rawText, "event-one", []);
    const secondEvent = makeEvent(sessionId, rawText, "event-two", []);
    storage.runCorrectionTransaction(({ db }) => queuePendingReceipt(db, {
      receiptId: createPendingReceiptId(sessionId, { uuid: "event-two" }),
      sessionIdHash,
      receivedAt: "2026-01-01T00:00:01.000Z",
      lastConfirmedOrdinal: 0,
      rawTextHash: hashRawText(rawText),
      extractedCandidates: [{ bundleKey: "bundle-one" }],
    }));

    const result = storage.runCorrectionTransaction(({ db }) => commitTranscriptBatch(db, {
      sessionIdHash,
      expected: INITIAL_PROGRESS,
      nextCursor: { transcriptOffset: 256, transcriptIdentity: "file-one:marker-one" },
      lastSeenAt: "2026-01-01T00:00:03.000Z",
      events: [firstEvent, secondEvent],
    }));

    expect(result.matchedReceipts).toEqual([
      { receiptId: secondEvent.eventId, eventId: secondEvent.eventId, humanOrdinal: 2 },
    ]);
  });

  it("queued_commandを遅延JSONL到着後にhashとordinalで対応付ける", () => {
    const sessionId = "synthetic-session";
    const sessionIdHash = hashSessionId(sessionId);
    const rawText = "合成queued発話";
    storage.runCorrectionTransaction(({ db }) => queuePendingReceipt(db, {
      receiptId: "queued-receipt",
      sessionIdHash,
      receivedAt: "2026-01-01T00:00:01.000Z",
      lastConfirmedOrdinal: 0,
      rawTextHash: hashRawText(rawText),
      extractedCandidates: [{ bundleKey: "bundle-queued" }],
    }));

    const waiting = storage.runCorrectionTransaction(({ db }) => commitTranscriptBatch(db, {
      sessionIdHash,
      expected: INITIAL_PROGRESS,
      nextCursor: { transcriptOffset: 0, transcriptIdentity: "file-one:empty" },
      lastSeenAt: "2026-01-01T00:00:02.000Z",
      events: [],
    }));
    expect(waiting.matchedReceipts).toEqual([]);

    const event = makeEvent(sessionId, rawText, "queued-event", [], { sourceKind: "queued_command" });
    const arrived = storage.runCorrectionTransaction(({ db }) => commitTranscriptBatch(db, {
      sessionIdHash,
      expected: { humanOrdinal: 0, transcriptOffset: 0, transcriptIdentity: "file-one:empty" },
      nextCursor: { transcriptOffset: 180, transcriptIdentity: "file-one:marker-one" },
      lastSeenAt: "2026-01-01T00:00:03.000Z",
      events: [event],
    }));

    expect(arrived.matchedReceipts).toEqual([
      { receiptId: "queued-receipt", eventId: event.eventId, humanOrdinal: 1 },
    ]);
    expect(readState(sessionIdHash).pending).toEqual([
      { receipt_id: "queued-receipt", matched_event_id: event.eventId },
    ]);
  });

  it("event保存に失敗したらcursorも更新しない", () => {
    const sessionId = "synthetic-session";
    const sessionIdHash = hashSessionId(sessionId);
    const event = makeEvent(sessionId, "合成注意", "event-one", ["missing-bundle"]);

    expect(() => storage.runCorrectionTransaction(({ db }) => commitTranscriptBatch(db, {
      sessionIdHash,
      expected: INITIAL_PROGRESS,
      nextCursor: { transcriptOffset: 256, transcriptIdentity: "file-one:marker-one" },
      lastSeenAt: "2026-01-01T00:00:03.000Z",
      events: [event],
    }))).toThrow();
    expect(readState(sessionIdHash)).toMatchObject({
      session: undefined,
      events: [],
      evidenceCount: { count: 0 },
    });
  });

  it("競合hookが古いcursorでcommitした場合は二重加算しない", () => {
    const sessionId = "synthetic-session";
    const sessionIdHash = hashSessionId(sessionId);
    const first = makeEvent(sessionId, "先行合成", "event-one", []);
    storage.runCorrectionTransaction(({ db }) => commitTranscriptBatch(db, {
      sessionIdHash,
      expected: INITIAL_PROGRESS,
      nextCursor: { transcriptOffset: 128, transcriptIdentity: "file-one:marker-one" },
      lastSeenAt: "2026-01-01T00:00:03.000Z",
      events: [first],
    }));

    const stale = storage.runCorrectionTransaction(({ db }) => commitTranscriptBatch(db, {
      sessionIdHash,
      expected: INITIAL_PROGRESS,
      nextCursor: { transcriptOffset: 256, transcriptIdentity: "file-one:marker-two" },
      lastSeenAt: "2026-01-01T00:00:04.000Z",
      events: [makeEvent(sessionId, "後続合成", "event-two", [])],
    }));

    expect(stale).toMatchObject({ committed: false, reason: "stale_cursor", humanOrdinal: 1 });
    expect(readState(sessionIdHash)).toMatchObject({
      session: { human_ordinal: 1, transcript_offset: 128 },
      events: [{ event_id: first.eventId, human_ordinal: 1 }],
    });
  });
});
