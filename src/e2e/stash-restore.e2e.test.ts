import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SQLiteStorage } from "../storage/sqlite.js";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, rmSync } from "fs";

/**
 * TASK-038: E2E統合テスト（stash→restore フロー）
 *
 * stash→即restore、TTL超過、cleanExpiredStash、複数stashの独立性を検証する。
 */
describe("E2E: stash→restore フロー", () => {
  let storage: SQLiteStorage;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-e2e-stash-"));
    const dbPath = join(tmpDir, "memory.db");
    storage = new SQLiteStorage(dbPath);
    storage.initialize();
  });

  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stash→即restore→フル内容一致", () => {
    const originalContent = `import { useState } from "react";

export function Counter() {
  const [count, setCount] = useState(0);
  return (
    <div>
      <p>Count: {count}</p>
      <button onClick={() => setCount(c => c + 1)}>+</button>
    </div>
  );
}`;

    const stashResult = storage.stash({
      content: originalContent,
      filePath: "/src/components/Counter.tsx",
      fileType: "tsx",
    });

    expect(stashResult.id).toBeTruthy();
    expect(stashResult.summary).toContain('import { useState } from "react"');
    expect(stashResult.summary).toContain("11行");
    expect(stashResult.summary).toContain("tsx");
    expect(stashResult.expiresAt).toBeTruthy();

    const restoreResult = storage.restore(stashResult.id);

    expect(restoreResult.found).toBe(true);
    expect(restoreResult.content).toBe(originalContent);
    expect(restoreResult.message).toContain("Restored");
  });

  it("stash（TTL=0）→restore→expired判定", () => {
    const stashResult = storage.stash({
      content: "This should expire immediately",
      ttlHours: 0,
    });

    const restoreResult = storage.restore(stashResult.id);

    expect(restoreResult.found).toBe(false);
    expect(restoreResult.expired).toBe(true);
    expect(restoreResult.content).toBeUndefined();
    expect(restoreResult.message).toContain("expired");
  });

  it("存在しないIDでrestore→not found", () => {
    const restoreResult = storage.restore("nonexistent-stash-id");

    expect(restoreResult.found).toBe(false);
    expect(restoreResult.expired).toBeUndefined();
    expect(restoreResult.message).toContain("not found");
  });

  it("cleanExpiredStash→期限切れデータのみ削除", () => {
    // 期限切れ3件 + 有効1件
    storage.stash({ content: "expired-1", ttlHours: 0 });
    storage.stash({ content: "expired-2", ttlHours: 0 });
    storage.stash({ content: "expired-3", ttlHours: 0 });
    const validStash = storage.stash({ content: "still-valid", ttlHours: 24 });

    const cleaned = storage.cleanExpiredStash();
    expect(cleaned).toBe(3);

    // 有効なstashはまだ復元可能
    const restoreResult = storage.restore(validStash.id);
    expect(restoreResult.found).toBe(true);
    expect(restoreResult.content).toBe("still-valid");
  });

  it("複数stash→それぞれ独立して復元可能", () => {
    const stash1 = storage.stash({
      content: "File A content",
      filePath: "/src/a.ts",
      fileType: "ts",
    });
    const stash2 = storage.stash({
      content: "File B content\nwith multiple lines\nthree total",
      filePath: "/src/b.py",
      fileType: "py",
    });
    const stash3 = storage.stash({
      content: '{"key": "value"}',
      filePath: "/config.json",
      fileType: "json",
    });

    // それぞれ独立して復元
    const restore1 = storage.restore(stash1.id);
    const restore2 = storage.restore(stash2.id);
    const restore3 = storage.restore(stash3.id);

    expect(restore1.content).toBe("File A content");
    expect(restore2.content).toBe("File B content\nwith multiple lines\nthree total");
    expect(restore3.content).toBe('{"key": "value"}');

    // IDが全て異なること
    expect(new Set([stash1.id, stash2.id, stash3.id]).size).toBe(3);
  });

  it("stashの要約はコンテキスト節約のために要点のみ含む", () => {
    const longContent = Array.from({ length: 200 }, (_, i) => `line ${i + 1}: some code here`).join("\n");

    const stashResult = storage.stash({
      content: longContent,
      fileType: "ts",
    });

    // 要約はフルコンテンツより大幅に短い
    expect(stashResult.summary.length).toBeLessThan(longContent.length);
    // 先頭5行が含まれる
    expect(stashResult.summary).toContain("line 1:");
    expect(stashResult.summary).toContain("line 5:");
    // 6行目以降は含まれない
    expect(stashResult.summary).not.toContain("line 6:");
    // 行数情報が含まれる
    expect(stashResult.summary).toContain("200行");
  });

  it("stash→restore→再度restoreでも同じ内容が返る", () => {
    const stashResult = storage.stash({ content: "idempotent content" });

    const restore1 = storage.restore(stashResult.id);
    const restore2 = storage.restore(stashResult.id);

    expect(restore1.content).toBe("idempotent content");
    expect(restore2.content).toBe("idempotent content");
  });

  it("sessionId付きstashが保存・復元される", () => {
    const stashResult = storage.stash({
      content: "session-specific content",
      sessionId: "session-abc-123",
    });

    const restoreResult = storage.restore(stashResult.id);
    expect(restoreResult.found).toBe(true);
    expect(restoreResult.content).toBe("session-specific content");
  });
});
