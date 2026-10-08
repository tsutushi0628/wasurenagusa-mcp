import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { measureRepeatClasses, parseRepeatClassesArguments } from "./repeat-classes.mjs";

function createExtractor(compiledRoot: string): void {
  mkdirSync(join(compiledRoot, "corrections"), { recursive: true });
  writeFileSync(join(compiledRoot, "corrections", "events.js"), [
    "export function extractOwnerEvent(value) {",
    "  if (value?.type !== 'user' || value?.origin?.kind !== 'human') return null;",
    "  const text = value.message?.content;",
    "  if (typeof text !== 'string' || text.trim() === '') return null;",
    "  const normalized = text.normalize('NFKC').trim();",
    "  const firstLine = normalized.split('\\n', 1)[0].trim();",
    "  return { sourceType: 'user', text: normalized, sessionId: value.sessionId, timestamp: value.timestamp, isHandoffPaste: false, isSlashCommand: /^\\/[a-z][a-z0-9-]*(?:\\s|$)/iu.test(firstLine) };",
    "}",
  ].join("\n"));
}

function transcript(sessionId: string, timestamp: string, text: string): string {
  return `${JSON.stringify({
    type: "user",
    origin: { kind: "human" },
    sessionId,
    timestamp,
    message: { content: text },
  })}\n`;
}

describe("A15 再発自覚マーカー率", () => {
  it("固定範囲の合成 transcript だけを読み、同報を分子・分母で一度に畳む", async () => {
    const scratch = mkdtempSync(join(process.cwd(), ".tmp", "codex-a15-test-"));
    const transcriptsDirectory = join(scratch, "transcripts");
    const compiledRoot = join(scratch, "build");
    mkdirSync(transcriptsDirectory, { recursive: true });
    createExtractor(compiledRoot);

    const lines = [
      ["marker", transcript("synthetic-a", "2026-10-05T01:00:10.000Z", "さっきも言ったよね")],
      ["normal-a", transcript("synthetic-b", "2026-10-05T01:00:20.000Z", "合成の確認です")],
      ["normal-b", transcript("synthetic-c", "2026-10-05T01:00:45.000Z", "合成の確認です")],
      ["negative", transcript("synthetic-d", "2026-10-05T01:01:00.000Z", "何度も失敗する")],
    ] as const;
    const sessions = lines.map(([fileId, content]) => {
      const filename = join(transcriptsDirectory, `${fileId}.jsonl`);
      writeFileSync(filename, content + transcript("synthetic-h2", "2026-10-08T00:05:00.000+09:00", "さっきも言ったよね"));
      const prefix = Buffer.from(content);
      return {
        fileId,
        path: `${fileId}.jsonl`,
        readEndByteOffset: prefix.length,
        prefixSha256: createHash("sha256").update(prefix).digest("hex"),
      };
    });
    writeFileSync(join(transcriptsDirectory, "excluded.jsonl"), "not-json; excluded by manifest\n");
    const manifestPath = join(scratch, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ version: 1, sessions }) + "\n");

    try {
      const parsed = parseRepeatClassesArguments([
        "--transcripts", transcriptsDirectory,
        "--compiled-root", compiledRoot,
        "--out", join(scratch, "report.json"),
        "--since", "2026-09-23",
        "--until", "2026-10-05",
        "--manifest", manifestPath,
      ]);
      expect(parsed.manifestPath).toBe(manifestPath);

      const report = await measureRepeatClasses({ ...parsed, manifestPath });

      expect(report.total).toBe(0);
      expect(report.repeatSignal).toMatchObject({
        count: 1,
        utterances: 4,
        per100: 25,
        countDeduped: 1,
        utterancesDeduped: 3,
      });
      expect(report.repeatSignal.per100Deduped).toBeCloseTo(100 / 3);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("manifest pathをtranscripts root相対で読み、..x.jsonlを有効名として扱う", async () => {
    const scratch = mkdtempSync(join(process.cwd(), ".tmp", "codex-repeat-manifest-path-test-"));
    const transcriptsDirectory = join(scratch, "transcripts");
    const nestedDirectory = join(transcriptsDirectory, "nested");
    const manifestDirectory = join(scratch, "manifest");
    const compiledRoot = join(scratch, "build");
    mkdirSync(nestedDirectory, { recursive: true });
    mkdirSync(manifestDirectory, { recursive: true });
    createExtractor(compiledRoot);
    const lines = [
      ["nested-session", "nested/nested-session.jsonl", transcript("synthetic-nested", "2026-10-05T01:00:10.000Z", "さっきも言ったよね")],
      ["..x", "..x.jsonl", transcript("synthetic-dot-name", "2026-10-05T01:00:20.000Z", "合成の確認です")],
    ] as const;
    const sessions = lines.map(([fileId, relativePath, content]) => {
      const filename = join(transcriptsDirectory, relativePath);
      writeFileSync(filename, content);
      const prefix = Buffer.from(content);
      return {
        fileId,
        path: relativePath,
        readEndByteOffset: prefix.length,
        prefixSha256: createHash("sha256").update(prefix).digest("hex"),
      };
    });
    const manifestPath = join(manifestDirectory, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ version: 1, sessions }) + "\n");

    try {
      const options = parseRepeatClassesArguments([
        "--transcripts", transcriptsDirectory,
        "--compiled-root", compiledRoot,
        "--out", join(scratch, "report.json"),
        "--since", "2026-09-23",
        "--until", "2026-10-05",
        "--manifest", manifestPath,
      ]);

      const report = await measureRepeatClasses(options);

      expect(report.repeatSignal.count).toBe(1);
      expect(report.repeatSignal.utterances).toBe(2);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
