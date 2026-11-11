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

function insertBundle(dbPath: string, memoryId: string): void {
  const db = new Database(dbPath);
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
  db.close();
}

describe("delete() と指摘の記録の外部キー", () => {
  let dir: string;
  let dbPath: string;
  let storage: SQLiteStorage;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wasurenagusa-delete-fk-"));
    dbPath = join(dir, "memory.db");
    storage = openCorrectionStorage(dbPath);
  });

  afterEach(() => {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("指摘から参照される memory は外部キー違反にならず、指摘は rejected・memory は論理削除になる", () => {
    const plain = storage.save({ category: "dont", title: "plain", content: "plain content" });
    const linked = storage.save({ category: "dont", title: "linked", content: "linked content" });
    insertBundle(dbPath, linked.id);

    const result = storage.delete({ ids: [plain.id, linked.id, "missing-id"] });

    expect(result.deleted).toEqual([plain.id, linked.id]);
    expect(result.softDeleted).toEqual([linked.id]);
    expect(result.notFound).toEqual(["missing-id"]);

    const db = new Database(dbPath);
    expect(db.prepare("SELECT id FROM memories WHERE id = ?").get(plain.id)).toBeUndefined();
    const row = db.prepare("SELECT state, deleted_at FROM memories WHERE id = ?").get(linked.id) as {
      state: string; deleted_at: string | null;
    };
    expect(row.state).toBe("deleted");
    expect(row.deleted_at).not.toBeNull();
    const bundle = db.prepare("SELECT status FROM owner_correction_bundles WHERE memory_id = ?").get(linked.id) as {
      status: string;
    };
    expect(bundle.status).toBe("rejected");
    db.close();
  });

  it("途中で失敗したら1件も消さない", () => {
    const first = storage.save({ category: "dont", title: "first", content: "first content" });
    const db = new Database(dbPath);
    db.exec("CREATE TRIGGER fail_second BEFORE DELETE ON memories WHEN old.title = 'second' BEGIN SELECT RAISE(ABORT, 'boom'); END;");
    db.close();
    const second = storage.save({ category: "dont", title: "second", content: "second content" });

    expect(() => storage.delete({ ids: [first.id, second.id] })).toThrow();

    const check = new Database(dbPath);
    expect(check.prepare("SELECT id FROM memories WHERE id = ?").get(first.id)).toBeDefined();
    check.close();
  });

  it("purgeTombstones は指摘から参照される tombstone を残し、ほかは消す", () => {
    const plain = storage.save({ category: "dont", title: "plain", content: "plain content" });
    const linked = storage.save({ category: "dont", title: "linked", content: "linked content" });
    insertBundle(dbPath, linked.id);
    storage.softDelete([plain.id, linked.id]);

    const result = storage.purgeTombstones();

    expect(result.deletedMemories).toBe(1);
    const db = new Database(dbPath);
    expect(db.prepare("SELECT id FROM memories WHERE id = ?").get(plain.id)).toBeUndefined();
    expect(db.prepare("SELECT id FROM memories WHERE id = ?").get(linked.id)).toBeDefined();
    db.close();
  });
});
