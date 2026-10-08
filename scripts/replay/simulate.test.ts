import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

function createMeasurementBuild(compiledRoot: string, measurementRoot: string): void {
  mkdirSync(measurementRoot, { recursive: true });
  for (const entry of readdirSync(compiledRoot, { withFileTypes: true })) {
    const sourcePath = join(compiledRoot, entry.name);
    const targetPath = join(measurementRoot, entry.name);
    if (entry.name !== "corrections") {
      symlinkSync(sourcePath, targetPath, entry.isDirectory() ? "dir" : "file");
      continue;
    }
    mkdirSync(targetPath, { recursive: true });
    for (const correctionEntry of readdirSync(sourcePath, { withFileTypes: true })) {
      const correctionSourcePath = join(sourcePath, correctionEntry.name);
      const correctionTargetPath = join(targetPath, correctionEntry.name);
      if (correctionEntry.name === "store.js") {
        writeFileSync(correctionTargetPath, "export function storedBundleKey() { return 'measurement-stored-key'; }\n");
      } else {
        symlinkSync(correctionSourcePath, correctionTargetPath, correctionEntry.isDirectory() ? "dir" : "file");
      }
    }
  }
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
      "--measurement-root", ".tmp/measurement",
      "--until", "2026-10-01",
    ]);
    expect(options).toMatchObject({ mode: "online", until: "2026-10-01", measurementRoot: ".tmp/measurement" });
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

describe("台帳を使う再訂正元", () => {
  it("recurrence=yes かつ intent が単位と一致する行だけを再訂正にする", () => {
    const sessionHash = "a".repeat(64);
    const events = [
      { event_id: "synthetic-yes", session_id_hash: sessionHash, human_ordinal: 2 },
      { event_id: "synthetic-no", session_id_hash: sessionHash, human_ordinal: 3 },
      { event_id: "synthetic-other-intent", session_id_hash: sessionHash, human_ordinal: 4 },
    ];
    const eventHash = (eventId: string) => createHash("sha256").update(eventId).digest("hex");
    const ledgerRows = [
      { event_hash: eventHash("synthetic-yes"), session_hash: sessionHash, recurrence: "yes", intent_id: "intent-match" },
      { event_hash: eventHash("synthetic-no"), session_hash: sessionHash, recurrence: "no", intent_id: "intent-match" },
      { event_hash: eventHash("synthetic-other-intent"), session_hash: sessionHash, recurrence: "yes", intent_id: "intent-other" },
    ];
    const eventIntents = internal.buildLedgerEventIntentMap(events, ledgerRows);
    const unitIntents = new Map([["oc:synthetic", new Set(["intent-match"])] ]);
    const source = internal.buildLedgerRecorrectionSource(events, eventIntents, unitIntents);

    expect(source(sessionHash, 2)).toEqual(new Set(["oc:synthetic"]));
    expect(source(sessionHash, 3)).toEqual(new Set());
    expect(source(sessionHash, 4)).toEqual(new Set());
  });
});

describe("scratchストア初期化", () => {
  it("compiled storeの公開関数を使い、旧ビルドでは旧v2式で束キーを計算する", () => {
    const compiledKey = internal.getCompiledStoredBundleKey({
      storedBundleKey: () => "compiled-stored-key",
    });
    expect(compiledKey(
      "synthetic-logical-key", "synthetic-project", "general", "synthetic-session", "task", "project",
    )).toBe("compiled-stored-key");

    const legacyKey = internal.getCompiledStoredBundleKey({});
    const identity = JSON.stringify([
      "synthetic-logical-key", "synthetic-project", "general", "synthetic-session",
    ]);
    expect(legacyKey(
      "synthetic-logical-key", "synthetic-project", "general", "synthetic-session", "task", "project",
    )).toBe(`oc:v2:${createHash("sha256").update(identity).digest("hex")}`);
  });

  it("v13へ移行して強度イベント表を作る", async () => {
    const tempRoot = createProjectScratchDirectory();
    const compiledRoot = join(tempRoot, "build");
    const measurementRoot = join(tempRoot, "measurement");
    const scratchRoot = join(tempRoot, "store");
    const originalEnv = {
      HOME: process.env.HOME,
      MEMORY_DIR: process.env.MEMORY_DIR,
      WASURENAGUSA_CORRECTION_LOOP: process.env.WASURENAGUSA_CORRECTION_LOOP,
      WASURENAGUSA_CORRECTION_INJECT: process.env.WASURENAGUSA_CORRECTION_INJECT,
      WASURENAGUSA_CORRECTION_COMPLIANCE: process.env.WASURENAGUSA_CORRECTION_COMPLIANCE,
    };
    let runtime;
    try {
      execFileSync("pnpm", ["exec", "tsc", "--outDir", compiledRoot, "--declaration", "false"], {
        cwd: process.cwd(),
        stdio: "pipe",
      });
      createMeasurementBuild(compiledRoot, measurementRoot);
      runtime = await internal.initializeBlankStore(compiledRoot, scratchRoot, measurementRoot);
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
      expect(runtime.keying.storedBundleKey(
        "synthetic-logical-key", "synthetic-project", "owner", "synthetic-session", "explicit_continuing", "owner",
      )).not.toBe("measurement-stored-key");
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

describe("再生の検査とターン範囲", () => {
  it("measurementは検査行だけを保存しviolationsはcompiled complianceだけが保存する", () => {
    const calls: Array<{ layer: string; persistViolations?: boolean }> = [];
    const runtime = {
      compliance: {
        persistCorrectionComplianceViolations: (_storage: unknown, input: { persistViolations?: boolean }) => {
          calls.push({ layer: "measurement", persistViolations: input.persistViolations });
        },
      },
      compiledCompliance: {
        persistCorrectionComplianceViolations: (_storage: unknown, input: { persistViolations?: boolean }) => {
          calls.push({ layer: "compiled", persistViolations: input.persistViolations });
        },
      },
    };

    internal.persistReplayCorrectionCompliance(runtime, {}, {
      sessionIdHash: "synthetic-session",
      humanOrdinal: 1,
      assistantText: "synthetic response",
      detectedAt: "2026-10-01T00:00:00.000Z",
    });

    expect(calls).toEqual([
      { layer: "measurement", persistViolations: false },
      { layer: "compiled", persistViolations: undefined },
    ]);
  });

  it("compiled complianceが無いbefore再生ではmeasurementからviolationsを書かない", () => {
    const calls: Array<{ persistViolations?: boolean }> = [];
    const runtime = {
      compliance: {
        persistCorrectionComplianceViolations: (_storage: unknown, input: { persistViolations?: boolean }) => {
          calls.push({ persistViolations: input.persistViolations });
        },
      },
      compiledCompliance: null,
    };

    internal.persistReplayCorrectionCompliance(runtime, {}, {
      sessionIdHash: "synthetic-session",
      humanOrdinal: 1,
      assistantText: "synthetic response",
      detectedAt: "2026-10-01T00:00:00.000Z",
    });

    expect(calls).toEqual([{ persistViolations: false }]);
  });

  it("人間発話ごとの transcript 範囲を一度の順走で分ける", () => {
    const recordsByEvent = internal.indexTranscriptRecordsByHumanInput([{
      humanInputs: [
        { eventId: "synthetic-event-1", lineOrder: 1 },
        { eventId: "synthetic-event-2", lineOrder: 4 },
      ],
      transcriptRecords: [
        { lineOrder: 1, kind: "human" },
        { lineOrder: 2, kind: "assistant" },
        { lineOrder: 3, kind: "tool" },
        { lineOrder: 4, kind: "human" },
        { lineOrder: 5, kind: "assistant" },
      ],
    }]);

    expect(recordsByEvent.get("synthetic-event-1")?.map((record: { lineOrder: number }) => record.lineOrder)).toEqual([1, 2, 3]);
    expect(recordsByEvent.get("synthetic-event-2")?.map((record: { lineOrder: number }) => record.lineOrder)).toEqual([4, 5]);
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
