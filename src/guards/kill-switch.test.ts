import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { isKilled, getKillSwitchPath, KILL_SWITCH_FILE_NAME } from "./kill-switch.js";

describe("kill-switch（タスク4.6・R-C4）", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-kill-switch-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("guards.kill が存在しなければfalse", () => {
    expect(isKilled(tmpDir)).toBe(false);
  });

  it("ストア直下に guards.kill を touch すると即時true（全停止）", () => {
    writeFileSync(getKillSwitchPath(tmpDir), "");
    expect(isKilled(tmpDir)).toBe(true);
  });

  it("guards.kill を削除するとfalseに戻る", () => {
    writeFileSync(getKillSwitchPath(tmpDir), "");
    expect(isKilled(tmpDir)).toBe(true);
    unlinkSync(getKillSwitchPath(tmpDir));
    expect(isKilled(tmpDir)).toBe(false);
  });

  it("getKillSwitchPathはmemoryPath直下のguards.killを指す", () => {
    expect(getKillSwitchPath(tmpDir)).toBe(join(tmpDir, KILL_SWITCH_FILE_NAME));
  });

  it("存在しないディレクトリでも例外を投げずfalseを返す（fail-open）", () => {
    expect(isKilled(join(tmpDir, "not-exist-dir"))).toBe(false);
  });
});
