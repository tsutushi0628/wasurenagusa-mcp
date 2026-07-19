import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, rmSync } from "fs";
import { dirname, resolve, join } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { readServerVersion } from "./version.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_PATH = resolve(__dirname, "../package.json");

describe("readServerVersion（サーバ自己申告版数の単一真実源）", () => {
  it("package.json の version をそのまま返す（版数を上げれば自己申告も追従する）", () => {
    const expected = (JSON.parse(readFileSync(PKG_PATH, "utf-8")) as { version: string })
      .version;
    expect(typeof expected).toBe("string");
    expect(expected.length).toBeGreaterThan(0);
    expect(readServerVersion()).toBe(expected);
  });

  it("package.json が存在しない場合でも例外を投げず、実在しない既定版数へフォールバックする", () => {
    const missing = join(tmpdir(), `wasurenagusa-no-such-${Date.now()}.json`);
    expect(() => readServerVersion(missing)).not.toThrow();
    expect(readServerVersion(missing)).toBe("0.0.0-unknown");
  });

  it("version フィールドを欠く JSON でも安全な既定版数へ落とす", () => {
    const tmp = join(tmpdir(), `wasurenagusa-pkg-noversion-${Date.now()}.json`);
    writeFileSync(tmp, JSON.stringify({ name: "x" }), "utf-8");
    try {
      expect(readServerVersion(tmp)).toBe("0.0.0-unknown");
    } finally {
      rmSync(tmp, { force: true });
    }
  });
});
