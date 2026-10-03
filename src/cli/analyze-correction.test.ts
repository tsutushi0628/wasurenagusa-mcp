import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { SQLiteStorage } from "../storage/sqlite.js";
import { initializeCorrectionSchema } from "../storage/correction-schema.js";
import { initializeSchema } from "../storage/schema.js";
import {
  createPendingReceiptId,
  hashRawText,
  hashSessionId,
  queuePendingReceipt,
} from "../corrections/session-store.js";
import { detectOwnerCorrections } from "../corrections/detector.js";
import { extractOwnerEvent } from "../corrections/events.js";

const { mockState } = vi.hoisted(() => ({
  mockState: {
    memoryPath: "",
    analyze: vi.fn(),
    checkDuplicate: vi.fn(),
  },
}));

vi.mock("dotenv", () => ({ config: vi.fn() }));
vi.mock("../config.js", () => ({
  config: {
    sqliteFile: "memory.db",
    geminiApiKey: "",
    openaiApiKey: "",
    anthropicApiKey: "",
  },
  getMemoryPath: () => mockState.memoryPath,
}));
vi.mock("../utils/projectRoot.js", () => ({ findProjectRoot: (cwd: string) => cwd }));
vi.mock("../analyzer/index.js", () => ({
  Analyzer: class {
    analyze(input: unknown) {
      return mockState.analyze(input);
    }

    checkDuplicate(input: unknown) {
      return mockState.checkDuplicate(input);
    }
  },
}));
vi.mock("../scheduler/change-logger.js", () => ({
  ChangeLogger: class {
    async recordChanges() {}
  },
}));

const ENV_KEYS = [
  "GEMINI_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "WASURENAGUSA_STOP_LLM",
  "WASURENAGUSA_STOP_LLM_BILLING_APPROVED",
  "WASURENAGUSA_SCHEDULER",
  "WASURENAGUSA_CORRECTION_LOOP",
  "WASURENAGUSA_CORRECTION_INJECT",
] as const;

describe("analyze Stop correction recovery", () => {
  let tempDir: string;
  let projectRoot: string;
  let memoryPath: string;
  let transcriptPath: string;
  let priorEnv: Map<string, string | undefined>;
  let priorStdin: PropertyDescriptor | undefined;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "analyze-correction-"));
    projectRoot = join(tempDir, "fixture-project");
    memoryPath = join(projectRoot, ".wasurenagusa");
    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    mockState.memoryPath = memoryPath;
    mockState.analyze.mockReset();
    mockState.checkDuplicate.mockReset();
    mockState.analyze.mockResolvedValue({ shouldSave: false, category: null, title: null, summary: null, tags: [] });
    mockState.checkDuplicate.mockResolvedValue(null);
    priorEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
    priorStdin = Object.getOwnPropertyDescriptor(process, "stdin");
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.WASURENAGUSA_CORRECTION_LOOP = "on";
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const initialStorage = new SQLiteStorage(join(memoryPath, "memory.db"));
    initialStorage.initialize();
    initialStorage.close();
    const database = new Database(join(memoryPath, "memory.db"));
    initializeCorrectionSchema(database);
    database.close();
  });

  afterEach(() => {
    if (priorStdin) Object.defineProperty(process, "stdin", priorStdin);
    priorStdin = undefined;
    for (const [key, value] of priorEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    consoleErrorSpy.mockRestore();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeTranscript(entries: unknown[]): string {
    transcriptPath = join(tempDir, "transcript.jsonl");
    writeFileSync(transcriptPath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf-8");
    return transcriptPath;
  }

  function user(uuid: string, content: string, timestamp: string, sessionId = "fixture-session"): unknown {
    return {
      type: "user",
      uuid,
      sessionId,
      timestamp,
      origin: { kind: "human" },
      message: { role: "user", content },
    };
  }

  function assistant(uuid: string, content: string, timestamp: string, sessionId = "fixture-session"): unknown {
    return {
      type: "assistant",
      uuid,
      sessionId,
      timestamp,
      message: { role: "assistant", content },
    };
  }

  function attachStdin(transcript: string, overrides: Record<string, unknown> = {}): void {
    const hookInput = {
      session_id: "fixture-session",
      cwd: projectRoot,
      transcript_path: transcript,
      hook_event_name: "Stop",
      ...overrides,
    };
    Object.defineProperty(process, "stdin", {
      value: Readable.from([Buffer.from(JSON.stringify(hookInput), "utf-8")]),
      configurable: true,
    });
  }

  function attachContextStdin(
    transcript: string,
    sessionId: string,
    hookEventName: "SessionStart" | "UserPromptSubmit",
    overrides: Record<string, unknown> = {},
  ): void {
    const hookInput = {
      session_id: sessionId,
      cwd: projectRoot,
      transcript_path: transcript,
      hook_event_name: hookEventName,
      ...overrides,
    };
    Object.defineProperty(process, "stdin", {
      value: Readable.from([Buffer.from(JSON.stringify(hookInput), "utf-8")]),
      configurable: true,
    });
  }

  async function runMain(): Promise<void> {
    const analyze = await import("./analyze.js");
    await analyze.main();
  }

  function readCorrectionState() {
    const storage = SQLiteStorage.openExistingForHook(join(memoryPath, "memory.db"));
    try {
      return storage.runCorrectionTransaction(({ db }) => ({
        session: db.prepare("SELECT human_ordinal, transcript_offset FROM owner_correction_sessions").get(),
        events: db.prepare("SELECT event_id, human_ordinal, source_kind, previous_action FROM owner_correction_events ORDER BY human_ordinal").all(),
        bundles: db.prepare("SELECT bundle_key, memory_id, rule_text, topic_key, status, visibility, occurrence_count, session_count FROM owner_correction_bundles ORDER BY bundle_key").all(),
        evidence: db.prepare("SELECT detector_version, conditions FROM owner_correction_evidence ORDER BY event_id").all(),
        pending: db.prepare("SELECT receipt_id, matched_event_id FROM owner_correction_pending ORDER BY receipt_id").all(),
        memories: db.prepare("SELECT id, content, state FROM memories WHERE category = 'dont' ORDER BY id").all(),
      }));
    } finally {
      storage.close();
    }
  }

  function createV10DatabaseWithIndex(): void {
    const dbPath = join(memoryPath, "memory.db");
    rmSync(dbPath, { force: true });
    const database = new Database(dbPath);
    initializeSchema(database);
    database.prepare(`
      INSERT INTO memories (id, timestamp, category, title, content, tags, project, scope)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("synthetic-index-entry", "2026-01-01T00:00:00.000Z", "dont", "synthetic-index-title", "synthetic-index-content", "[]", "fixture-project", "project");
    database.close();
  }

  it("persists a continuing correction before any API-key gated analysis", async () => {
    process.env.GEMINI_API_KEY = "fixture-api-key";
    const transcript = writeTranscript([
      user("human-before", "合成の確認依頼", "2026-10-03T00:00:00.000Z"),
      assistant("assistant-before", "質問の回答をまとめました。", "2026-10-03T00:00:01.000Z"),
      user("human-correction", "今後は質問に答えてください", "2026-10-03T00:00:02.000Z"),
      assistant("assistant-after", "全文を表示します。", "2026-10-03T00:00:03.000Z"),
    ]);
    attachStdin(transcript);

    const analyze = await import("./analyze.js");
    expect(analyze.main).toBeTypeOf("function");
    await analyze.main();

    expect(mockState.analyze).not.toHaveBeenCalled();
    expect(readCorrectionState()).toMatchObject({
      session: { human_ordinal: 2 },
      bundles: [{ bundle_key: expect.stringMatching(/^oc:v2:/u), rule_text: "毎回、質問に回答する", status: "confirmed" }],
      evidence: [{ detector_version: "owner-correction-v2", conditions: expect.stringContaining('"version":2') }],
      memories: [{ content: "毎回、質問に回答する" }],
    });
  });

  it("uses only assistant actions before the correction, never the response after it", async () => {
    const transcript = writeTranscript([
      user("human-before", "合成の確認依頼", "2026-10-03T00:00:00.000Z"),
      assistant("assistant-before", "回答内容を整理した", "2026-10-03T00:00:01.000Z"),
      user("human-correction", "なぜ敬語なのですか", "2026-10-03T00:00:02.000Z"),
      assistant("assistant-after", "承知しました。敬語で回答します。", "2026-10-03T00:00:03.000Z"),
    ]);
    attachStdin(transcript);

    await runMain();

    const state = readCorrectionState();
    expect(state.bundles).toHaveLength(1);
    expect(state.bundles[0]).toMatchObject({ status: "candidate" });
    expect(state.memories).toHaveLength(0);
    expect(state.events[1].previous_action).toContain("回答");
    expect(state.events[1].previous_action).not.toContain("敬語");
  });

  it("Stop単独では直前AIの敬体使用から常体指定を確定する", async () => {
    const sessionId = "direct-tone-session";
    const transcript = writeTranscript([
      assistant("assistant-before", "確認しました。", "2026-10-03T00:00:01.000Z", sessionId),
      user("human-tone", "なぜ敬語なの", "2026-10-03T00:00:02.000Z", sessionId),
      assistant("assistant-after", "了解しました。", "2026-10-03T00:00:03.000Z", sessionId),
    ]);
    attachStdin(transcript, { session_id: sessionId });

    await runMain();

    expect(readCorrectionState().bundles).toMatchObject([{
      rule_text: "オーナーへの応答は常体で書く",
      topic_key: "tone",
      status: "confirmed",
    }]);
  });

  it("pending照合後もStopの直前AIを再判定し、Stop単独と同じ規則を確定する", async () => {
    const sessionId = "pending-tone-session";
    const context = await import("./context.js");
    const partialTranscript = writeTranscript([
      assistant("assistant-before", "確認しました。", "2026-10-03T00:00:01.000Z", sessionId),
    ]);
    attachContextStdin(partialTranscript, sessionId, "UserPromptSubmit", {
      prompt: "なぜ敬語なの",
    });
    expect(await context.main()).toBe("emitted");

    const fullTranscript = writeTranscript([
      assistant("assistant-before", "確認しました。", "2026-10-03T00:00:01.000Z", sessionId),
      user("human-tone", "なぜ敬語なの", "2026-10-03T00:00:02.000Z", sessionId),
      assistant("assistant-after", "了解しました。", "2026-10-03T00:00:03.000Z", sessionId),
    ]);
    attachStdin(fullTranscript, { session_id: sessionId });

    await runMain();

    expect(readCorrectionState()).toMatchObject({
      bundles: [{ rule_text: "オーナーへの応答は常体で書く", topic_key: "tone", status: "confirmed" }],
      evidence: [{ detector_version: "owner-correction-v2" }],
      pending: [{ matched_event_id: expect.any(String) }],
    });
  });

  it("明示IDの取消をStopで反映し、引用取消と別IDの規則を保つ", async () => {
    process.env.WASURENAGUSA_CORRECTION_INJECT = "on";
    const sessionId = "cancel-correction-session";
    const context = await import("./context.js");
    const originalEntries = [
      user("human-answer", "今後は質問に答えてください", "2026-10-03T00:00:01.000Z", sessionId),
      assistant("assistant-answer", "質問に回答しました。", "2026-10-03T00:00:02.000Z", sessionId),
      user("human-terms", "今後は用語を説明してください", "2026-10-03T00:00:03.000Z", sessionId),
      assistant("assistant-terms", "用語を説明しました。", "2026-10-03T00:00:04.000Z", sessionId),
    ];
    attachStdin(writeTranscript(originalEntries), { session_id: sessionId });
    await runMain();

    const initial = readCorrectionState();
    const answerRule = initial.bundles.find((bundle) => bundle.rule_text.includes("質問に回答"));
    const termsRule = initial.bundles.find((bundle) => bundle.rule_text.includes("用語を説明"));
    if (!answerRule || !termsRule) throw new Error("synthetic confirmed rules were not created");
    expect([answerRule.status, termsRule.status]).toEqual(["confirmed", "confirmed"]);

    const quotedCancellation = user(
      "human-quoted-cancel",
      `「規則ID: ${answerRule.bundle_key} を取り消して」この引用文は処理しない`,
      "2026-10-03T00:00:05.000Z",
      sessionId,
    );
    const withQuote = [...originalEntries, quotedCancellation, assistant("assistant-quote", "確認しました。", "2026-10-03T00:00:06.000Z", sessionId)];
    attachStdin(writeTranscript(withQuote), { session_id: sessionId });
    await runMain();
    expect(readCorrectionState().bundles.find((bundle) => bundle.bundle_key === answerRule.bundle_key)?.status).toBe("confirmed");

    const negativeCancellation = user(
      "human-negative-cancel",
      `規則ID: ${answerRule.bundle_key} をキャンセルしないで`,
      "2026-10-03T00:00:07.000Z",
      sessionId,
    );
    const withNegative = [...withQuote, negativeCancellation, assistant("assistant-negative", "了解しました。", "2026-10-03T00:00:08.000Z", sessionId)];
    attachStdin(writeTranscript(withNegative), { session_id: sessionId });
    await runMain();
    expect(readCorrectionState().bundles.find((bundle) => bundle.bundle_key === answerRule.bundle_key)?.status).toBe("confirmed");

    const cancellation = user(
      "human-cancel",
      `規則ID: ${answerRule.bundle_key} を取り消して`,
      "2026-10-03T00:00:09.000Z",
      sessionId,
    );
    const cancelledTranscript = writeTranscript([
      ...withNegative,
      cancellation,
      assistant("assistant-cancel", "取り消しました。", "2026-10-03T00:00:10.000Z", sessionId),
    ]);
    attachStdin(cancelledTranscript, { session_id: sessionId });
    await runMain();

    const cancelled = readCorrectionState();
    expect(cancelled.bundles.find((bundle) => bundle.bundle_key === answerRule.bundle_key))
      .toMatchObject({ status: "rejected", memory_id: answerRule.memory_id });
    expect(cancelled.bundles.find((bundle) => bundle.bundle_key === termsRule.bundle_key)?.status).toBe("confirmed");
    expect(cancelled.memories.find((memory) => memory.id === answerRule.memory_id)?.state).toBe("archived");

    const stdoutChunks: string[] = [];
    const stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
      ...args: unknown[]
    ): boolean => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      const callback = args.find((argument) => typeof argument === "function") as ((error?: Error | null) => void) | undefined;
      callback?.();
      return true;
    }) as typeof process.stdout.write);
    try {
      const startTranscript = writeTranscript([
        ...withNegative,
        cancellation,
        assistant("assistant-cancel", "取り消しました。", "2026-10-03T00:00:10.000Z", sessionId),
      ]);
      attachContextStdin(startTranscript, "cancel-next-session", "SessionStart", { source: "startup" });
      expect(await context.main()).toBe("emitted");
    } finally {
      stdoutWriteSpy.mockRestore();
    }
    expect(stdoutChunks.join("")).toContain(termsRule.bundle_key);
    expect(stdoutChunks.join("")).not.toContain(answerRule.bundle_key);
  });

  it("WASURENAGUSA_CORRECTION_LOOP未設定のv10でも開始索引を出す", async () => {
    createV10DatabaseWithIndex();
    delete process.env.WASURENAGUSA_CORRECTION_LOOP;
    const context = await import("./context.js");
    const stdoutChunks: string[] = [];
    const stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
      ...args: unknown[]
    ): boolean => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      const callback = args.find((argument) => typeof argument === "function") as ((error?: Error | null) => void) | undefined;
      callback?.();
      return true;
    }) as typeof process.stdout.write);
    try {
      attachContextStdin(writeTranscript([]), "v10-start-session", "SessionStart", { source: "startup" });
      expect(await context.main()).toBe("emitted");
    } finally {
      stdoutWriteSpy.mockRestore();
    }

    expect(stdoutChunks.join("")).toContain("synthetic-index-title");
    const database = new Database(join(memoryPath, "memory.db"), { readonly: true });
    try {
      expect(database.prepare("SELECT version FROM schema_version").get()).toEqual({ version: 10 });
      expect(database.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'owner_correction_%'").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("UserPromptSubmitとStopの本番関数で反復規則を確定し、別SessionStartへ本文を出す", async () => {
    process.env.WASURENAGUSA_CORRECTION_LOOP = "on";
    process.env.WASURENAGUSA_CORRECTION_INJECT = "on";
    const stdoutChunks: string[] = [];
    const stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
      ...args: unknown[]
    ): boolean => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      const callback = args.find((argument) => typeof argument === "function") as ((error?: Error | null) => void) | undefined;
      callback?.();
      return true;
    }) as typeof process.stdout.write);

    try {
      const context = await import("./context.js");
      const prompt = "質問に答えてください";
      const turns = [
        { sessionId: "first-correction-session", uuid: "first-correction", timestamp: "2026-10-03T00:00:02.000Z" },
        { sessionId: "second-correction-session", uuid: "second-correction", timestamp: "2026-10-03T00:01:02.000Z" },
      ];

      for (const [index, turn] of turns.entries()) {
        const promptTranscript = writeTranscript([]);
        attachContextStdin(promptTranscript, turn.sessionId, "UserPromptSubmit", {
          uuid: turn.uuid,
          prompt,
        });
        expect(await context.main()).toBe("emitted");

        const stopTranscript = writeTranscript([
          user(turn.uuid, prompt, turn.timestamp, turn.sessionId),
          assistant(`assistant-${index}`, "質問への回答を確認しました。", "2026-10-03T00:00:03.000Z", turn.sessionId),
        ]);
        attachStdin(stopTranscript, { session_id: turn.sessionId });
        await runMain();

        const state = readCorrectionState();
        expect(state.events).toHaveLength(index + 1);
        expect(state.evidence).toHaveLength(index + 1);
        expect(state.bundles).toHaveLength(1);
        expect(state.bundles[0].status).toBe(index === 0 ? "candidate" : "confirmed");
      }

      const confirmed = readCorrectionState();
      expect(confirmed.bundles[0]).toMatchObject({
        rule_text: "質問に回答する",
        status: "confirmed",
        occurrence_count: 2,
        session_count: 2,
      });
      expect(confirmed.evidence.every((entry) => entry.conditions.includes('"version":2'))).toBe(true);
      expect(confirmed.memories).toHaveLength(1);

      const startTranscript = writeTranscript([]);
      attachContextStdin(startTranscript, "third-session", "SessionStart", { source: "startup" });
      expect(await context.main()).toBe("emitted");
      expect(stdoutChunks.join("")).toContain("### オーナーからの確認済み規則");
      expect(stdoutChunks.join("")).toContain("質問に回答する");
    } finally {
      stdoutWriteSpy.mockRestore();
    }
  });

  it("matches a queued command to its pending receipt and recovers the saved candidate", async () => {
    const sessionId = "fixture-session";
    const prompt = "今後は質問に答えてください";
    const hookEvent = extractOwnerEvent({ hookEventName: "UserPromptSubmit", sessionId, prompt });
    if (!hookEvent) throw new Error("synthetic hook event was not extracted");
    const candidate = detectOwnerCorrections(hookEvent)[0];
    if (!candidate) throw new Error("synthetic correction was not detected");
    const transcript = writeTranscript([{
      type: "attachment",
      uuid: "queued-correction",
      sessionId,
      timestamp: "2026-10-03T00:00:02.000Z",
      origin: { kind: "human" },
      attachment: {
        type: "queued_command",
        commandMode: "prompt",
        prompt,
        origin: { kind: "human" },
      },
    }]);
    const storage = SQLiteStorage.openExistingForHook(join(memoryPath, "memory.db"));
    try {
      storage.runCorrectionTransaction(({ db }) => queuePendingReceipt(
        db as Parameters<typeof queuePendingReceipt>[0],
        {
          receiptId: createPendingReceiptId(sessionId, { uuid: "queued-correction" }),
          sessionIdHash: hashSessionId(sessionId),
          receivedAt: "2026-10-03T00:00:01.000Z",
          lastConfirmedOrdinal: 0,
          rawTextHash: hashRawText(prompt),
          extractedCandidates: [candidate],
        },
      ));
    } finally {
      storage.close();
    }
    attachStdin(transcript);

    await runMain();

    expect(readCorrectionState()).toMatchObject({
      session: { human_ordinal: 1 },
      events: [{ source_kind: "queued_command" }],
      bundles: [{ bundle_key: expect.stringMatching(/^oc:v2:/u), rule_text: "毎回、質問に回答する", status: "confirmed" }],
      evidence: [{ detector_version: "owner-correction-v2", conditions: expect.stringContaining('"version":2') }],
      pending: [{ matched_event_id: expect.any(String) }],
    });
  });

  it("continues past the 200-human-message batch cap on the next Stop", async () => {
    const entries = Array.from({ length: 201 }, (_, index) =>
      user("human-" + index, "合成確認 " + index, "2026-10-03T00:00:00.000Z"),
    );
    const transcript = writeTranscript(entries);
    attachStdin(transcript);

    await runMain();
    expect(readCorrectionState().session).toMatchObject({ human_ordinal: 200 });

    attachStdin(transcript);
    await runMain();

    expect(readCorrectionState().session).toMatchObject({ human_ordinal: 201 });
    expect(readCorrectionState().events).toHaveLength(201);
  });

  it("advances an empty transcript without creating correction events", async () => {
    const transcript = writeTranscript([]);
    attachStdin(transcript);

    await runMain();

    expect(readCorrectionState()).toMatchObject({
      session: { human_ordinal: 0 },
      events: [],
      bundles: [],
      pending: [],
      memories: [],
    });
  });

  it("does not create correction records when the Stop loop is disabled", async () => {
    process.env.WASURENAGUSA_CORRECTION_LOOP = "off";
    const transcript = writeTranscript([
      user("human-correction", "今後は質問に答えてください", "2026-10-03T00:00:02.000Z"),
    ]);
    attachStdin(transcript);

    await runMain();

    expect(readCorrectionState()).toMatchObject({
      events: [],
      bundles: [],
      pending: [],
      memories: [],
    });
    expect(readCorrectionState().session).toBeUndefined();
  });

  it("keeps the STOP LLM opt-in separate from API-key presence and checks exact deadline boundaries", async () => {
    const analyze = await import("./analyze.js");
    expect(analyze.shouldRunStopLlm).toBeTypeOf("function");
    expect(analyze.STOP_DETERMINISTIC_TIMEOUT_MS).toBe(2500);
    expect(analyze.STOP_TOTAL_TIMEOUT_MS).toBe(25000);
    expect(analyze.hasDeadlineTimeRemaining(2500, 2499)).toBe(true);
    expect(analyze.hasDeadlineTimeRemaining(2500, 2500)).toBe(false);
    expect(analyze.hasDeadlineTimeRemaining(25000, 24999)).toBe(true);
    expect(analyze.hasDeadlineTimeRemaining(25000, 25000)).toBe(false);
    expect(analyze.shouldRunStopLlm({ GEMINI_API_KEY: "fixture-api-key" })).toBe(false);
    expect(analyze.shouldRunStopLlm({ WASURENAGUSA_STOP_LLM: "on", GEMINI_API_KEY: "fixture-api-key" })).toBe(false);
    expect(analyze.shouldRunStopLlm({
      WASURENAGUSA_STOP_LLM: "on",
      WASURENAGUSA_STOP_LLM_BILLING_APPROVED: "1",
      GEMINI_API_KEY: "fixture-api-key",
    })).toBe(true);
  });
});
