import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SQLiteStorage } from "./sqlite.js";
import { initializeCorrectionSchema } from "./correction-schema.js";
import type { SaveParams, SearchResult } from "../types.js";

function openCorrectionStorage(dbPath: string): SQLiteStorage {
  const initialStorage = new SQLiteStorage(dbPath);
  initialStorage.initialize();
  initialStorage.close();

  const db = new Database(dbPath);
  initializeCorrectionSchema(db);
  db.close();

  const storage = new SQLiteStorage(dbPath);
  storage.initialize();
  return storage;
}

function insertCorrectionRows(db: Pick<Database.Database, "prepare">, memoryId: string): void {
  db.prepare(`
    INSERT INTO owner_correction_events (
      event_id, session_id_hash, source_uuid_hash, human_ordinal, observed_at, available_at,
      source_kind, excerpt, previous_action, action_first_locator_hash, action_last_locator_hash,
      project, scope, raw_text_hash, source_locator_hash, processed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "event-fixture", "session-hash", null, 1, "2026-01-02T03:04:05.000Z", "2026-01-02T03:04:05.000Z",
    "user", "synthetic excerpt", "action_unknown", null, null, "fixture-project", "backend",
    "raw-hash", "locator-hash", "2026-01-02T03:04:06.000Z",
  );
  db.prepare(`
    INSERT INTO owner_correction_bundles (
      bundle_key, memory_id, rule_text, topic_key, polarity, condition_key, project, scope,
      visibility, status, intensity, occurrence_count, session_count, first_seen_at, last_seen_at,
      expires_at, lifetime_kind, continuation_basis, confirmed_at, version, counterevidence_event_id,
      last_confirmation_asked_at, confirmation_state
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "bundle-fixture", memoryId, "Synthetic rule text", "verification", "negative", "general",
    "fixture-project", "backend", "project", "confirmed", 2, 1, 1,
    "2026-01-02T03:04:05.000Z", "2026-01-02T03:04:05.000Z", null,
    "explicit_continuing", "synthetic basis", "2026-01-02T03:04:05.000Z", 1, null, null, "none",
  );
  db.prepare(`
    INSERT INTO owner_correction_evidence (
      event_id, bundle_key, source, score, detector_version, conditions, polarity
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("event-fixture", "bundle-fixture", "utterance_detection", 6, "fixture-v1", "[]", "negative");
  db.prepare(`
    INSERT INTO owner_correction_versions (
      bundle_key, version, rule_text, body_hash, conditions, condition_key, polarity, visibility,
      status, confirmed_at, expires_at, lifetime_kind, continuation_basis, evidence_event_ids,
      effective_from, change_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "bundle-fixture", 1, "Synthetic rule text", "body-hash", "[]", "general", "negative", "project",
    "confirmed", "2026-01-02T03:04:05.000Z", null, "explicit_continuing", "synthetic basis",
    '["event-fixture"]', "2026-01-02T03:04:05.000Z", "fixture",
  );
}

function importedMemory(overrides: Record<string, unknown> = {}) {
  return {
    id: "source-memory-one",
    timestamp: "2020-01-02T03:04:05.000Z",
    category: "dont" as const,
    title: "Synthetic imported rule",
    content: "Synthetic content for import testing",
    tags: '["synthetic"]',
    project: "fixture-project",
    scope: "backend",
    intensity: 2,
    knowledge_gap: null,
    positive_action: "Use the synthetic path",
    scenario: "Synthetic scenario",
    why_core: "Synthetic reason",
    predicted_factors: null,
    actual_factors: null,
    prediction_error: null,
    prediction_delta: null,
    deleted_at: null,
    state: "active" as const,
    project_confidence: "confirmed" as const,
    content_hash: "fixture-content-hash",
    last_read_at: null,
    created_at: "2020-01-02 03:04:05",
    updated_at: "2020-01-02 03:04:05",
    ...overrides,
  };
}

describe("SQLiteStorage correction transaction and import boundary", () => {
  let tmpDir: string;
  let dbPath: string;
  let storage: SQLiteStorage;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-correction-access-"));
    dbPath = join(tmpDir, "memory.db");
    storage = openCorrectionStorage(dbPath);
  });

  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("saves memory, bundle, evidence, and version in one transaction", () => {
    const result = storage.runCorrectionTransaction(({ db, save }) => {
      expect(db.inTransaction).toBe(true);
      const saved = save({
        category: "dont",
        title: "Synthetic correction rule",
        content: "Synthetic correction content",
        project: "fixture-project",
        scope: "backend",
      });
      insertCorrectionRows(db, saved.id);
      return saved.id;
    });

    const db = new Database(dbPath, { readonly: true });
    try {
      expect(result).toBeTruthy();
      expect(db.prepare("SELECT COUNT(*) AS count FROM memories WHERE id = ?").get(result)).toEqual({ count: 1 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM owner_correction_bundles").get()).toEqual({ count: 1 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM owner_correction_evidence").get()).toEqual({ count: 1 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM owner_correction_versions").get()).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it("rolls back memory and correction rows when a transaction fails", () => {
    expect(() => storage.runCorrectionTransaction(({ db, save }) => {
      const saved = save({
        category: "dont",
        title: "Synthetic rollback rule",
        content: "Synthetic rollback content",
        project: "fixture-project",
        scope: "backend",
      });
      insertCorrectionRows(db, saved.id);
      throw new Error("synthetic rollback");
    })).toThrow("synthetic rollback");

    const db = new Database(dbPath, { readonly: true });
    try {
      for (const table of ["memories", "owner_correction_events", "owner_correction_bundles", "owner_correction_evidence", "owner_correction_versions"]) {
        expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
      }
    } finally {
      db.close();
    }
  });

  it("rejects asynchronous correction callbacks before execution", async () => {
    let callbackInvoked = false;
    const asyncCallback = (async ({ save }) => {
      callbackInvoked = true;
      save({
        category: "dont",
        title: "Synthetic async rule A",
        content: "Synthetic async content A",
        project: "fixture-project",
        scope: "backend",
      });
      await Promise.resolve();
      save({
        category: "dont",
        title: "Synthetic async rule B",
        content: "Synthetic async content B",
        project: "fixture-project",
        scope: "backend",
      });
    }) as unknown as Parameters<typeof storage.runCorrectionTransaction>[0];

    expect(() => storage.runCorrectionTransaction(asyncCallback)).toThrow("correction transaction callback must be synchronous");
    await Promise.resolve();
    expect(callbackInvoked).toBe(false);

    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM memories").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("rejects correction transaction capabilities after the callback returns", () => {
    let saveAfterTransaction: () => void = () => {};
    let importAfterTransaction: () => void = () => {};
    let queryAfterTransaction: () => void = () => {};
    let statementAfterTransaction: () => void = () => {};
    let iterationAfterTransaction: () => void = () => {};

    storage.runCorrectionTransaction(({ db, save, importMemory }) => {
      saveAfterTransaction = () => save({
        category: "dont",
        title: "Synthetic escaped save",
        content: "Synthetic escaped save content",
        project: "fixture-project",
        scope: "backend",
      });
      importAfterTransaction = () => importMemory({
        sourceStoreHash: "source-store-hash",
        sourceMemoryId: "source-memory-one",
        importedAt: "2026-01-03T04:05:06.000Z",
        sourceContentHash: "source-content-hash-one",
        memory: importedMemory(),
      });
      queryAfterTransaction = () => {
        db.prepare("SELECT 1").get();
      };
      const statement = db.prepare("SELECT 1");
      statementAfterTransaction = () => {
        statement.get();
      };
      const iterator = db.prepare("SELECT 1 UNION ALL SELECT 2").iterate();
      iterator.next();
      iterator.return?.();
      iterationAfterTransaction = () => {
        iterator.next();
      };
    });

    expect(saveAfterTransaction).toThrow("correction transaction access outside active transaction");
    expect(importAfterTransaction).toThrow("correction transaction access outside active transaction");
    expect(queryAfterTransaction).toThrow("correction transaction access outside active transaction");
    expect(statementAfterTransaction).toThrow("correction transaction access outside active transaction");
    expect(iterationAfterTransaction).toThrow("correction transaction access outside active transaction");

    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM memories").get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM owner_correction_imports").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("does not log correction save errors inside the transaction", () => {
    const errorLogger = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => storage.runCorrectionTransaction(({ save }) => save({
        category: "invalid" as SaveParams["category"],
        title: "Synthetic invalid correction rule",
        content: "Synthetic invalid correction content",
        project: "fixture-project",
        scope: "backend",
      }))).toThrow();
      expect(errorLogger).not.toHaveBeenCalled();

      const db = new Database(dbPath, { readonly: true });
      try {
        expect(db.prepare("SELECT COUNT(*) AS count FROM memories").get()).toEqual({ count: 0 });
      } finally {
        db.close();
      }
    } finally {
      errorLogger.mockRestore();
    }
  });

  it("imports source timestamps and leaves every duplicate memory column unchanged", () => {
    const imported = storage.runCorrectionTransaction(({ importMemory }) => importMemory({
      sourceStoreHash: "source-store-hash",
      sourceMemoryId: "source-memory-one",
      importedAt: "2026-01-03T04:05:06.000Z",
      sourceContentHash: "source-content-hash-one",
      memory: importedMemory(),
    }));
    expect(imported).toEqual({ targetMemoryId: "source-memory-one", inserted: true });

    const repeated = storage.runCorrectionTransaction(({ importMemory }) => importMemory({
      sourceStoreHash: "source-store-hash",
      sourceMemoryId: "source-memory-one",
      importedAt: "2026-01-03T04:05:06.000Z",
      sourceContentHash: "source-content-hash-one",
      memory: importedMemory(),
    }));
    expect(repeated).toEqual({ targetMemoryId: imported.targetMemoryId, inserted: false });

    const db = new Database(dbPath);
    const before = db.prepare("SELECT * FROM memories WHERE id = ?").get(imported.targetMemoryId);
    db.close();
    expect(before).toMatchObject({
      timestamp: "2020-01-02T03:04:05.000Z",
      created_at: "2020-01-02 03:04:05",
      updated_at: "2020-01-02 03:04:05",
    });

    const duplicate = storage.runCorrectionTransaction(({ importMemory }) => importMemory({
      sourceStoreHash: "another-source-store-hash",
      sourceMemoryId: "source-memory-two",
      importedAt: "2026-02-03T04:05:06.000Z",
      sourceContentHash: "source-content-hash-two",
      memory: importedMemory({
        id: "source-memory-two",
        timestamp: "2021-02-03T04:05:06.000Z",
        title: "Synthetic duplicate title",
        tags: '["synthetic","duplicate"]',
        positive_action: "Different synthetic action",
        updated_at: "2021-02-03 04:05:06",
      }),
    }));
    expect(duplicate).toEqual({ targetMemoryId: imported.targetMemoryId, inserted: false });

    const verifyDb = new Database(dbPath);
    try {
      expect(verifyDb.prepare("SELECT * FROM memories WHERE id = ?").get(imported.targetMemoryId)).toEqual(before);
      expect(verifyDb.prepare("SELECT target_memory_id, source_timestamp FROM owner_correction_imports WHERE source_store_hash = ? AND source_memory_id = ?")
        .get("source-store-hash", "source-memory-one")).toEqual({
        target_memory_id: imported.targetMemoryId,
        source_timestamp: "2020-01-02T03:04:05.000Z",
      });
      expect(verifyDb.prepare("SELECT COUNT(*) AS count FROM memories").get()).toEqual({ count: 1 });
    } finally {
      verifyDb.close();
    }
  });

  it("rejects a changed source hash for an already imported source id", () => {
    storage.runCorrectionTransaction(({ importMemory }) => importMemory({
      sourceStoreHash: "source-store-hash",
      sourceMemoryId: "source-memory-one",
      importedAt: "2026-01-03T04:05:06.000Z",
      sourceContentHash: "source-content-hash-one",
      memory: importedMemory(),
    }));

    expect(() => storage.runCorrectionTransaction(({ importMemory }) => importMemory({
      sourceStoreHash: "source-store-hash",
      sourceMemoryId: "source-memory-one",
      importedAt: "2026-01-04T04:05:06.000Z",
      sourceContentHash: "changed-source-content-hash",
      memory: importedMemory({ title: "Changed synthetic title" }),
    }))).toThrow("imported source content changed");

    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM memories").get()).toEqual({ count: 1 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM owner_correction_imports").get()).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it("keeps the MCP search result contract and refuses writes on the readonly hook connection", () => {
    const result: SearchResult = storage.search({ query: "synthetic" });
    expect(Object.keys(result).sort()).toEqual(["fallbackStage", "hint", "results", "totalCount"]);

    const readonlyStorage = SQLiteStorage.openExistingForHook(dbPath, { mode: "index" });
    let callbackCalled = false;
    try {
      expect(() => readonlyStorage.runCorrectionTransaction(() => {
        callbackCalled = true;
      })).toThrow("correction transaction requires a writable connection");
      expect(callbackCalled).toBe(false);
    } finally {
      readonlyStorage.close();
    }
  });
});
