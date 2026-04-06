import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ThemeRegistry } from "./theme-registry.js";
import { SQLiteStorage } from "../storage/sqlite.js";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("ThemeRegistry", () => {
  let tmpDir: string;
  let storage: SQLiteStorage;
  let registry: ThemeRegistry;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "theme-registry-test-"));
    storage = new SQLiteStorage(join(tmpDir, "test.db"));
    storage.initialize();
    registry = new ThemeRegistry(storage);
  });

  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty themes when no themes exist", () => {
    const themes = registry.getThemes();
    expect(themes).toEqual([]);
  });

  it("adds themes and retrieves them", () => {
    registry.addThemes(["rate-limit", "認証"]);
    const themes = registry.getThemes();
    expect(themes).toContain("rate-limit");
    expect(themes).toContain("認証");
  });

  it("deduplicates themes on add", () => {
    registry.addThemes(["rate-limit", "認証"]);
    registry.addThemes(["rate-limit", "デプロイ"]);
    const themes = registry.getThemes();
    expect(themes.filter(t => t === "rate-limit")).toHaveLength(1);
    expect(themes).toContain("デプロイ");
  });

  it("isNewTheme returns true for unknown theme", () => {
    expect(registry.isNewTheme("新テーマ")).toBe(true);
  });

  it("isNewTheme returns false for known theme", () => {
    registry.addThemes(["既知テーマ"]);
    expect(registry.isNewTheme("既知テーマ")).toBe(false);
  });
});
