import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importCorrectionMemories } from "./import.js";
import { migrateV10ToV11 } from "../storage/migration.js";
import { initializeSchema } from "../storage/schema.js";

function createDatabase(path: string, correctionSchema = false): void {
  const db = new Database(path);
  initializeSchema(db);
  if (correctionSchema) {
    migrateV10ToV11(db);
  }
  db.close();
}

function memoryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "synthetic-memory-id",
    timestamp: "2024-02-03T04:05:06.000Z",
    category: "dont",
    title: "Synthetic condition",
    content: "Synthetic content with an explicit condition",
    tags: '["synthetic","condition"]',
    project: "synthetic-project",
    scope: "backend",
    intensity: 4,
    knowledge_gap: "Synthetic gap",
    positive_action: "Preserve the synthetic condition",
    scenario: "Synthetic scenario",
    why_core: "Synthetic reason",
    predicted_factors: '["synthetic-factor"]',
    actual_factors: '["observed-factor"]',
    prediction_error: 0.25,
    prediction_delta: "Synthetic delta",
    deleted_at: null,
    state: "active",
    project_confidence: "confirmed",
    content_hash: "synthetic-content-hash",
    last_read_at: "2024-03-04T05:06:07.000Z",
    created_at: "2024-02-03 04:05:06",
    updated_at: "2024-02-04 05:06:07",
    ...overrides,
  };
}

function insertMemory(path: string, row: ReturnType<typeof memoryRow>): void {
  const db = new Database(path);
  const columns = Object.keys(row);
  const values = Object.values(row);
  db.prepare(`INSERT INTO memories (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...values);
  db.close();
}

function selectMemory(path: string, id: string): unknown {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
  } finally {
    db.close();
  }
}

describe("訂正記憶の忠実な取込", () => {
  let directory: string;
  let sourcePath: string;
  let targetPath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "correction-import-"));
    sourcePath = join(directory, "source.db");
    targetPath = join(directory, "target.db");
    createDatabase(sourcePath);
    createDatabase(targetPath, true);
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("dry-runは両DBを変更せず、DDLも作らない", () => {
    insertMemory(sourcePath, memoryRow());
    const sourceBefore = readFileSync(sourcePath);
    const targetBefore = readFileSync(targetPath);

    const result = importCorrectionMemories({ sourcePath, targetPath, importedAt: "2026-10-03T00:00:00.000Z" });

    expect(result).toMatchObject({ sourceCount: 1, addedCount: 1, duplicateCount: 0, alreadyImportedCount: 0 });
    expect(readFileSync(sourcePath)).toEqual(sourceBefore);
    expect(readFileSync(targetPath)).toEqual(targetBefore);
    const db = new Database(targetPath, { readonly: true, fileMustExist: true });
    try {
      expect(db.prepare("SELECT MAX(version) AS version FROM schema_version").get()).toEqual({ version: 11 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM owner_correction_imports").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("空の入力は0件の計画で終わる", () => {
    const result = importCorrectionMemories({ sourcePath, targetPath });

    expect(result).toEqual({
      sourceCount: 0,
      skippedCount: 0,
      addedCount: 0,
      duplicateCount: 0,
      alreadyImportedCount: 0,
      idCollisionCount: 0,
      generatedCandidates: 0,
      expiryChanges: 0,
      migrationRequired: false,
    });
  });

  it("applyは原時刻と条件を保持し、再実行で追加しない", () => {
    const source = memoryRow();
    const archived = memoryRow({
      id: "synthetic-archived-memory-id",
      timestamp: "2022-03-04T05:06:07.000Z",
      title: "Synthetic archived condition",
      content: "Synthetic archived content",
      content_hash: "synthetic-archived-content-hash",
      state: "archived",
    });
    insertMemory(sourcePath, source);
    insertMemory(sourcePath, archived);

    const first = importCorrectionMemories({ sourcePath, targetPath, apply: true, importedAt: "2026-10-03T00:00:00.000Z" });
    const repeated = importCorrectionMemories({ sourcePath, targetPath, apply: true, importedAt: "2026-10-04T00:00:00.000Z" });

    expect(first).toMatchObject({ sourceCount: 2, addedCount: 2, duplicateCount: 0, alreadyImportedCount: 0, generatedCandidates: 0, expiryChanges: 0 });
    expect(repeated).toMatchObject({ sourceCount: 2, addedCount: 0, duplicateCount: 0, alreadyImportedCount: 2 });
    expect(selectMemory(targetPath, source.id)).toMatchObject(source);
    expect(selectMemory(targetPath, archived.id)).toMatchObject(archived);
    const db = new Database(targetPath, { readonly: true, fileMustExist: true });
    try {
      expect(db.prepare("SELECT imported_at, source_timestamp FROM owner_correction_imports WHERE source_memory_id = ?").get(source.id)).toEqual({
        imported_at: "2026-10-03T00:00:00.000Z",
        source_timestamp: source.timestamp,
      });
      expect(db.prepare("SELECT COUNT(*) AS count FROM owner_correction_bundles").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("一致記憶は全列不変で対応表だけ追加する", () => {
    const source = memoryRow({ id: "second-source-id" });
    const target = memoryRow({
      id: "target-duplicate-id",
      timestamp: "2023-01-02T03:04:05.000Z",
      title: "Synthetic target title",
      tags: '["target"]',
      positive_action: "Target condition stays unchanged",
      updated_at: "2023-01-03 04:05:06",
    });
    insertMemory(sourcePath, source);
    insertMemory(targetPath, target);
    const before = selectMemory(targetPath, target.id);

    const result = importCorrectionMemories({ sourcePath, targetPath, apply: true, importedAt: "2026-10-03T00:00:00.000Z" });

    expect(result).toMatchObject({ duplicateCount: 1, addedCount: 0 });
    expect(selectMemory(targetPath, target.id)).toEqual(before);
    const db = new Database(targetPath, { readonly: true, fileMustExist: true });
    try {
      expect(db.prepare("SELECT target_memory_id, source_timestamp FROM owner_correction_imports").get()).toEqual({
        target_memory_id: target.id,
        source_timestamp: source.timestamp,
      });
    } finally {
      db.close();
    }
  });

  it("異内容のID衝突では既存行を保ち新しいIDへ取り込む", () => {
    const source = memoryRow();
    const target = memoryRow({ content: "Different synthetic content", content_hash: "different-synthetic-hash" });
    insertMemory(sourcePath, source);
    insertMemory(targetPath, target);
    const before = selectMemory(targetPath, target.id);

    const result = importCorrectionMemories({ sourcePath, targetPath, apply: true, importedAt: "2026-10-03T00:00:00.000Z" });

    expect(result).toMatchObject({ addedCount: 1, idCollisionCount: 1 });
    expect(selectMemory(targetPath, target.id)).toEqual(before);
    const db = new Database(targetPath, { readonly: true, fileMustExist: true });
    try {
      const imported = db.prepare("SELECT target_memory_id FROM owner_correction_imports").get() as { target_memory_id: string };
      expect(imported.target_memory_id).not.toBe(source.id);
      expect(db.prepare("SELECT * FROM memories WHERE id = ?").get(imported.target_memory_id)).toMatchObject({
        ...source,
        id: imported.target_memory_id,
      });
    } finally {
      db.close();
    }
  });

  it("既取込IDの内容変更は対応を上書きせず拒否する", () => {
    insertMemory(sourcePath, memoryRow());
    importCorrectionMemories({ sourcePath, targetPath, apply: true, importedAt: "2026-10-03T00:00:00.000Z" });
    const sourceDb = new Database(sourcePath);
    sourceDb.prepare("UPDATE memories SET content = ? WHERE id = ?").run("Changed synthetic content", "synthetic-memory-id");
    sourceDb.close();
    const targetBefore = readFileSync(targetPath);

    expect(() => importCorrectionMemories({ sourcePath, targetPath, apply: true, importedAt: "2026-10-04T00:00:00.000Z" })).toThrow();
    expect(readFileSync(targetPath)).toEqual(targetBefore);
  });

  it("入力と中央が同じ実体なら拒否する", () => {
    expect(() => importCorrectionMemories({ sourcePath: targetPath, targetPath })).toThrow();
  });

  it("v10中央へのapplyは移行前に拒否する", () => {
    const v10TargetPath = join(directory, "v10-target.db");
    createDatabase(v10TargetPath);
    insertMemory(sourcePath, memoryRow());
    const before = readFileSync(v10TargetPath);

    expect(() => importCorrectionMemories({ sourcePath, targetPath: v10TargetPath, apply: true })).toThrow();
    expect(readFileSync(v10TargetPath)).toEqual(before);
  });
});
