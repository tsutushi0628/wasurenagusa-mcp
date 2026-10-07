import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeManifest } from "./make-manifest.mjs";
import { readManifest } from "./lib/simulate-engine.mjs";
import { internal } from "./lib/simulate-engine.mjs";
import { parseReplayArguments } from "./simulate.mjs";

const projectScratchRoot = join(process.cwd(), ".tmp", "fd31f1b6-ac90-4336-a1e7-260faaa28f1e", "tests");
const projectScratchDirectories: string[] = [];

function createProjectScratchDirectory(): string {
  mkdirSync(projectScratchRoot, { recursive: true });
  const scratch = mkdtempSync(join(projectScratchRoot, "replay-project-"));
  projectScratchDirectories.push(scratch);
  return scratch;
}

afterEach(() => {
  for (const directory of projectScratchDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("online再生の引数とsession順", () => {
  it("untilを必須にし、first human時刻順に並べて日付境界後の発話を除く", () => {
    const options = parseReplayArguments([
      "--mode", "online",
      "--manifest", "manifest.json",
      "--compiled-root", ".tmp/build",
      "--scratch", ".tmp/online",
      "--until", "2026-10-01",
    ]);
    expect(options).toMatchObject({ mode: "online", until: "2026-10-01" });
    expect(() => parseReplayArguments([
      "--mode", "online",
      "--manifest", "manifest.json",
      "--compiled-root", ".tmp/build",
      "--scratch", ".tmp/online",
    ])).toThrow("online mode requires --until YYYY-MM-DD");
    expect(() => parseReplayArguments([
      "--mode", "online",
      "--manifest", "manifest.json",
      "--compiled-root", ".tmp/build",
      "--scratch", ".tmp/online",
      "--until", "2026-02-30",
    ])).toThrow("online mode requires --until YYYY-MM-DD");

    const first = Date.parse("2026-10-01T00:00:00.000Z");
    const second = Date.parse("2026-10-01T01:00:00.000Z");
    const cutoff = Date.parse("2026-10-01T14:59:59.999Z");
    const afterCutoff = Date.parse("2026-10-01T16:00:00.000Z");
    const sourceSessions = [
      { sessionId: "session-3", sessionHash: "hash-3", firstHumanMs: afterCutoff, humanInputs: [], timeline: [], transcriptRecords: [] },
      { sessionId: "session-2", sessionHash: "hash-2", firstHumanMs: second, humanInputs: [
        { lineOrder: 1, availableMs: second },
        { lineOrder: 2, availableMs: cutoff },
        { lineOrder: 3, availableMs: afterCutoff },
      ], timeline: [
        { kind: "human", lineOrder: 1, availableMs: second, byteEndOffset: 10 },
        { kind: "human", lineOrder: 2, availableMs: cutoff, byteEndOffset: 20 },
        { kind: "human", lineOrder: 3, availableMs: afterCutoff, byteEndOffset: 30 },
      ], transcriptRecords: [{ lineOrder: 1 }, { lineOrder: 2 }, { lineOrder: 3 }] },
      { sessionId: "session-1", sessionHash: "hash-1", firstHumanMs: first, humanInputs: [
        { lineOrder: 1, availableMs: first },
      ], timeline: [{ kind: "human", lineOrder: 1, availableMs: first, byteEndOffset: 10 }], transcriptRecords: [{ lineOrder: 1 }] },
      { sessionId: "session-1a", sessionHash: "hash-1a", firstHumanMs: first, humanInputs: [
        { lineOrder: 1, availableMs: first },
      ], timeline: [{ kind: "human", lineOrder: 1, availableMs: first, byteEndOffset: 10 }], transcriptRecords: [{ lineOrder: 1 }] },
    ];

    const sessions = internal.selectOnlineSessions(sourceSessions, "2026-10-01");
    expect(sessions.map((session: { sessionId: string }) => session.sessionId)).toEqual(["session-1", "session-1a", "session-2"]);
    const truncatedSession = sessions.find((session: { sessionId: string }) => session.sessionId === "session-2");
    expect(truncatedSession.humanInputs).toHaveLength(2);
    expect(truncatedSession.transcriptRecords).toHaveLength(2);
    expect(truncatedSession.snapshotMeta.size).toBe(20);
  });
});

describe("scratchストア初期化", () => {
  it("v13へ移行して強度イベント表を作る", async () => {
    const tempRoot = createProjectScratchDirectory();
    const compiledRoot = join(tempRoot, "build");
    const scratchRoot = join(tempRoot, "store");
    const originalEnv = {
      HOME: process.env.HOME,
      MEMORY_DIR: process.env.MEMORY_DIR,
      WASURENAGUSA_CORRECTION_LOOP: process.env.WASURENAGUSA_CORRECTION_LOOP,
      WASURENAGUSA_CORRECTION_INJECT: process.env.WASURENAGUSA_CORRECTION_INJECT,
    };
    let runtime;
    try {
      execFileSync("pnpm", ["exec", "tsc", "--outDir", compiledRoot, "--declaration", "false"], {
        cwd: process.cwd(),
        stdio: "pipe",
      });
      runtime = await internal.initializeBlankStore(compiledRoot, scratchRoot);
      const version = runtime.storage.db.prepare(
        "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1",
      ).get();
      const violationsTable = runtime.storage.db.prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get("owner_correction_violations");
      const strengthEventsTable = runtime.storage.db.prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get("owner_correction_strength_events");

      expect(version?.version).toBe(13);
      expect(violationsTable).toEqual({ present: 1 });
      expect(strengthEventsTable).toEqual({ present: 1 });
    } finally {
      runtime?.storage.close();
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("再生 project の session 分離", () => {
  it("session index の project を event に使い、index 不在は起動フォルダへ戻して記録する", async () => {
    const scratch = createProjectScratchDirectory();
    const archiveRoot = join(scratch, "archive");
    const transcriptsDirectory = join(archiveRoot, "firebase-kit");
    const manifestPath = join(scratch, "manifest.json");
    const sessionRows = [
      { sessionId: "synthetic-alpha", project: "alpha", basis: "written_files" },
      { sessionId: "synthetic-beta", project: "beta", basis: "worklog_only" },
      { sessionId: "synthetic-fallback", project: null, basis: null },
    ];
    mkdirSync(transcriptsDirectory, { recursive: true });
    for (const session of sessionRows) {
      writeFileSync(join(transcriptsDirectory, `${session.sessionId}.jsonl`), JSON.stringify({
        type: "user",
        sessionId: session.sessionId,
        timestamp: "2026-10-01T00:00:00.000Z",
        origin: { kind: "human" },
        message: { content: [{ type: "text", text: `synthetic input ${session.sessionId}` }] },
      }) + "\n");
    }
    writeFileSync(join(archiveRoot, "sessions-index.json"), JSON.stringify({
      version: 1,
      sessions: sessionRows.filter((session) => session.project).map((session) => ({
        sessionId: session.sessionId,
        launchDir: "firebase-kit",
        project: session.project,
        basis: session.basis,
        projects: { [session.project as string]: 1 },
      })),
    }) + "\n");

    await makeManifest({
      transcriptsDirectory,
      outputPath: manifestPath,
      dateStart: "2026-10-01",
      dateEnd: "2026-10-01",
    });
    const manifest = await readManifest(manifestPath);
    const events = manifest.sessions.map((session) => internal.makeSessionEvent(
      session.humanInputs[0],
      { latestAssistantText: "", previousAssistantToolName: "" },
      {
        events: { extractOwnerEvent: (event: { message: { content: Array<{ text: string }> } }) => ({ text: event.message.content[0].text }) },
        sessionStore: {
          hashRawText: () => "synthetic-hash",
          hashTranscriptPosition: () => "synthetic-locator",
        },
      },
      "2026-10-01T00:00:00.000Z",
    ));

    expect(events.map((event: { project: string }) => event.project)).toEqual(["alpha", "beta", "firebase-kit"]);
    expect(manifest.sessions.map((session) => session.projectBasis)).toEqual([
      "written_files",
      "worklog_only",
      "launch_dir",
    ]);
    expect(internal.reportPopulation(manifest)).toMatchObject({
      projectCounts: { alpha: 1, beta: 1, "firebase-kit": 1 },
      projectFallbackSessionCount: 1,
    });
    expect(internal.flattenNumericMetrics({
      population: {
        sessionCount: 3,
        projectCounts: { alpha: 2, beta: 1 },
        projectBasisCounts: { written_files: 2, worklog_only: 1 },
        projectFallbackSessionCount: 1,
      },
    })).toEqual({ "population.sessionCount": 3 });
  });
});
