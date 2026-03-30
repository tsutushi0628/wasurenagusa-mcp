import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ThemeRegistry } from "./theme-registry.js";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

describe("ThemeRegistry", () => {
  let tempDir: string;
  let registry: ThemeRegistry;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "theme-registry-test-"));
    registry = new ThemeRegistry(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("returns empty themes when file does not exist", async () => {
    const themes = await registry.getThemes();
    expect(themes).toEqual([]);
  });

  it("adds themes and retrieves them", async () => {
    await registry.addThemes(["rate-limit", "認証"]);
    const themes = await registry.getThemes();
    expect(themes).toContain("rate-limit");
    expect(themes).toContain("認証");
  });

  it("deduplicates themes on add", async () => {
    await registry.addThemes(["rate-limit", "認証"]);
    await registry.addThemes(["rate-limit", "デプロイ"]);
    const themes = await registry.getThemes();
    expect(themes.filter(t => t === "rate-limit")).toHaveLength(1);
    expect(themes).toContain("デプロイ");
  });

  it("isNewTheme returns true for unknown theme", async () => {
    expect(await registry.isNewTheme("新テーマ")).toBe(true);
  });

  it("isNewTheme returns false for known theme", async () => {
    await registry.addThemes(["既知テーマ"]);
    expect(await registry.isNewTheme("既知テーマ")).toBe(false);
  });
});
