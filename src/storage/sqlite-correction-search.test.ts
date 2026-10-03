import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SQLiteStorage } from "./sqlite.js";
import { initializeCorrectionSchema } from "./correction-schema.js";

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

function insertMemory(db: Database.Database, id: string, project: string, scope: string): void {
  db.prepare(`
    INSERT INTO memories (id, timestamp, category, title, content, tags, project, scope)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, "2026-01-02T03:04:05.000Z", "dont", `Synthetic retrievaltarget ${id}`, "Synthetic searchable memory", "[]", project, scope);
}

function insertBundle(
  db: Database.Database,
  id: string,
  project: string,
  visibility: "project" | "owner",
): void {
  db.prepare(`
    INSERT INTO owner_correction_bundles (
      bundle_key, memory_id, rule_text, topic_key, polarity, condition_key, project, scope,
      visibility, status, intensity, occurrence_count, session_count, first_seen_at, last_seen_at,
      expires_at, lifetime_kind, continuation_basis, confirmed_at, version, counterevidence_event_id,
      last_confirmation_asked_at, confirmation_state
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `bundle-${id}`, id, `Synthetic rule for ${id}`, "verification", "negative", "general", project, "general",
    visibility, "confirmed", 2, 2, 2, "2026-01-02T03:04:05.000Z", "2026-01-02T03:04:05.000Z",
    null, "explicit_continuing", "synthetic basis", "2026-01-02T03:04:05.000Z", 1, null, null, "none",
  );
}

describe("SQLiteStorage correction FTS visibility boundary", () => {
  let tmpDir: string;
  let dbPath: string;
  let storage: SQLiteStorage;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-correction-search-"));
    dbPath = join(tmpDir, "memory.db");
    storage = openCorrectionStorage(dbPath);
  });

  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("limits project and owner FTS to 20 visible memory ids each and excludes other-project general memories", () => {
    storage.runCorrectionTransaction(({ db }) => {
      for (let index = 0; index < 25; index += 1) {
        const projectId = `project-${index}`;
        insertMemory(db, projectId, "fixture-project", "backend");
        insertBundle(db, projectId, "fixture-project", "project");

        const ownerId = `owner-${index}`;
        insertMemory(db, ownerId, "another-project", "general");
        insertBundle(db, ownerId, "another-project", "owner");
      }

      for (let index = 0; index < 15; index += 1) {
        insertMemory(db, `unlinked-general-${index}`, "another-project", "general");
      }

      const hiddenProjectId = "other-project-correction";
      insertMemory(db, hiddenProjectId, "another-project", "backend");
      insertBundle(db, hiddenProjectId, "another-project", "project");
    });

    const result = storage.searchCorrectionCandidates({ query: "retrievaltarget", project: "fixture-project" });
    const ids = result.results.map((entry) => entry.id);

    expect(result.results).toHaveLength(40);
    expect(ids.filter((id) => id.startsWith("project-"))).toHaveLength(20);
    expect(ids.filter((id) => id.startsWith("owner-"))).toHaveLength(20);
    expect(ids).not.toContain("other-project-correction");
    expect(ids.some((id) => id.startsWith("unlinked-general-"))).toBe(false);
    expect(ids.every((id) => id.startsWith("project-") || id.startsWith("owner-"))).toBe(true);
  });

  it("returns no candidates for an empty query", () => {
    storage.runCorrectionTransaction(({ db }) => {
      insertMemory(db, "visible-empty-query", "fixture-project", "backend");
      insertBundle(db, "visible-empty-query", "fixture-project", "project");
    });

    expect(storage.searchCorrectionCandidates({ query: "   ", project: "fixture-project" }).results).toEqual([]);
  });
});
