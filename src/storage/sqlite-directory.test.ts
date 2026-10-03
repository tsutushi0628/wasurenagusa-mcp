import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SQLiteStorage } from "./sqlite.js";

describe("SQLiteStorage database directory", () => {
  it("creates missing parent directories before opening the database", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-sqlite-directory-test-"));
    const parentPath = join(tmpDir, "new", "nested");
    const dbPath = join(parentPath, "memory.db");
    let storage: SQLiteStorage | undefined;
    try {
      storage = new SQLiteStorage(dbPath);
      storage.initialize();

      expect(existsSync(parentPath)).toBe(true);
      expect(existsSync(dbPath)).toBe(true);
    } finally {
      storage?.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it.each([":memory:", ""])("opens SQLite special path %j without a parent directory", (dbPath) => {
    const storage = new SQLiteStorage(dbPath);
    storage.close();
    expect(storage).toBeDefined();
  });
});
