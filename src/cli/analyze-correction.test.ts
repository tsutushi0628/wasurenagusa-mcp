import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable, Writable } from "node:stream";
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
import { addUserPromptPendingReceipt, emitContextOutput } from "./context.js";
import { renderCorrectionRules, type CorrectionRule } from "../corrections/render.js";
import { selectCorrectionInjections, type CorrectionInjectionTrigger } from "../corrections/injection-policy.js";
import { migrateV11ToV12, migrateV12ToV13, migrateV13ToV14 } from "../storage/migration.js";

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

  async function runStopCorrection(sessionId: string, uuid: string, content: string, timestamp: string): Promise<void> {
    const assistantTimestamp = new Date(Date.parse(timestamp) + 1000).toISOString();
    const transcript = writeTranscript([
      user(uuid, content, timestamp, sessionId),
      assistant(`${uuid}-response`, "合成の応答", assistantTimestamp, sessionId),
    ]);
    attachStdin(transcript, { session_id: sessionId });
    await runMain();
  }

  function readCorrectionState() {
    const storage = SQLiteStorage.openExistingForHook(join(memoryPath, "memory.db"));
    try {
      return storage.runCorrectionTransaction(({ db }) => ({
        session: db.prepare("SELECT human_ordinal, transcript_offset FROM owner_correction_sessions").get(),
        events: db.prepare("SELECT event_id, human_ordinal, source_kind, previous_action FROM owner_correction_events ORDER BY human_ordinal").all(),
        bundles: db.prepare("SELECT bundle_key, memory_id, rule_text, topic_key, polarity, condition_key, status, visibility, occurrence_count, session_count, lifetime_kind, expires_at FROM owner_correction_bundles ORDER BY bundle_key").all(),
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

  describe.each([13, 14])("matched pending output ledger on schema v%s", (schemaVersion) => {
    const prompt = "合成の作業を続けてください";

    beforeEach(async () => {
      const database = new Database(join(memoryPath, "memory.db"));
      migrateV11ToV12(database);
      migrateV12ToV13(database);
      if (schemaVersion >= 14) migrateV13ToV14(database);
      database.close();
      await runStopCorrection("seed-answer", "seed-answer", "今後は質問に答えてください", "2026-10-03T00:00:00.000Z");
      await runStopCorrection("seed-tone", "seed-tone", "今後は常体で答えて", "2026-10-03T00:00:00.000Z");
    });

    async function emitPendingRules(
      ruleCount: number,
      writeSucceeds: boolean,
      trigger: CorrectionInjectionTrigger,
      uuid = "pending-human",
    ) {
      const storage = SQLiteStorage.openExistingForHook(join(memoryPath, "memory.db"));
      const stdout = new Writable({
        write(_chunk, _encoding, callback) {
          if (!writeSucceeds) {
            callback(Object.assign(new Error("synthetic pipe failure"), { code: "EPIPE" }));
            return;
          }
          callback();
        },
      });
      try {
        const rules = storage.runCorrectionTransaction(({ db }) => db.prepare(`
          SELECT bundle_key AS bundleKey, version, rule_text AS ruleText, topic_key AS title,
            'restore' AS delivery
          FROM owner_correction_bundles WHERE status = 'confirmed' ORDER BY bundle_key LIMIT ?
        `).all(ruleCount) as CorrectionRule[]);
        expect(rules).toHaveLength(ruleCount);
        const receiptId = addUserPromptPendingReceipt(
          storage, hashSessionId("fixture-session"), "fixture-session", uuid, 0,
          prompt, "2026-10-03T00:01:00.000Z", true,
        );
        const rendered = renderCorrectionRules({ trigger, rules });
        expect(rendered.ledger).toHaveLength(ruleCount);
        const result = await emitContextOutput({
          output: rendered.text + "\n合成の追加コンテキスト", rendered, storage,
          sessionIdHash: hashSessionId("fixture-session"), compactEpoch: 2, humanOrdinal: 0,
          trigger, pendingReceiptId: receiptId, deadlineAt: Date.now() + 3500, stdout,
        });
        return { receiptId, result };
      } finally {
        stdout.destroy();
        storage.close();
      }
    }

    function readInjections() {
      const storage = SQLiteStorage.openExistingForHook(join(memoryPath, "memory.db"));
      try {
        return storage.runCorrectionTransaction(({ db }) => db.prepare(`
          SELECT * FROM owner_correction_injections WHERE session_id_hash = ? ORDER BY output_order
        `).all(hashSessionId("fixture-session")));
      } finally {
        storage.close();
      }
    }

    async function stopPendingPrompt(content: string): Promise<void> {
      const transcript = writeTranscript([
        user("pending-human", content, "2026-10-03T00:01:00.000Z"),
        assistant("pending-response", "合成の応答", "2026-10-03T00:01:01.000Z"),
      ]);
      attachStdin(transcript);
      await runMain();
    }

    it("confirms emitted output at Stop and suppresses the same version on the next prompt", async () => {
      const request = {
        projectRoot,
        sessionIdHash: hashSessionId("fixture-session"), compactEpoch: 2, humanOrdinal: 2,
        trigger: "prompt" as const, project: "fixture-project", scope: "general", query: prompt,
        at: new Date(Date.now() + 1000).toISOString(),
        featureModes: {
          correctionLoop: "on" as const, correctionInject: "on" as const, compliance: "off" as const,
          principles: "off" as const, graduation: "off" as const, strength: "off" as const,
          reinjection: "off" as const, candidateInjection: "off" as const, ownerScopeBehavior: "off" as const,
        },
      };
      const before = SQLiteStorage.openExistingForHook(join(memoryPath, "memory.db"));
      let selectedBundleKeys: string[];
      try {
        selectedBundleKeys = selectCorrectionInjections(before, request).rules.map((rule) => rule.bundleKey);
      } finally {
        before.close();
      }
      const { receiptId, result } = await emitPendingRules(1, true, "prompt");
      expect(result.status).toBe("emitted");
      const entry = result.rendered.ledger[0];
      expect(selectedBundleKeys).toContain(entry.bundleKey);
      let outputHumanOrdinal = 1;
      if (schemaVersion === 13) {
        expect(readInjections()).toHaveLength(1);
        outputHumanOrdinal = 0;
      } else {
        expect(readInjections()).toEqual([]);
      }
      await stopPendingPrompt(prompt);
      expect(readInjections()).toEqual([expect.objectContaining({
        session_id_hash: hashSessionId("fixture-session"), compact_epoch: 2,
        bundle_key: entry.bundleKey, version: entry.version, human_ordinal: outputHumanOrdinal, trigger: "prompt",
        emitted_at: expect.any(String), output_order: entry.outputOrder,
        body_hash: entry.bodyHash, output_hash: result.rendered.outputHash,
        token_estimate: result.rendered.tokenCount, body_included: 1, stdout_status: "emitted",
      })]);
      expect(readCorrectionState().pending).toContainEqual({ receipt_id: receiptId, matched_event_id: expect.any(String) });
      const storage = SQLiteStorage.openExistingForHook(join(memoryPath, "memory.db"));
      try {
        const selection = selectCorrectionInjections(storage, request);
        expect(selection.rules.map((rule) => rule.bundleKey)).not.toContain(entry.bundleKey);
        expect(selection.unreached.map((rule) => rule.bundleKey)).not.toContain(entry.bundleKey);
      } finally {
        storage.close();
      }
    });

    it.skipIf(schemaVersion === 13)("confirms every rule in a two-rule refresh output with its original metadata", async () => {
      const { receiptId, result } = await emitPendingRules(2, true, "refresh");
      expect(result.status).toBe("emitted");
      await stopPendingPrompt(prompt);
      expect(readInjections()).toEqual(result.rendered.ledger.map((entry) => expect.objectContaining({
        bundle_key: entry.bundleKey, version: entry.version, human_ordinal: 1, trigger: "refresh",
        compact_epoch: 2, output_order: entry.outputOrder, body_hash: entry.bodyHash,
        output_hash: entry.outputHash, token_estimate: entry.tokenEstimate,
        body_included: 1, stdout_status: "emitted",
      })));
      const database = new Database(join(memoryPath, "memory.db"));
      try {
        const pending = database.prepare(`
          SELECT output_callback_succeeded_at FROM owner_correction_pending WHERE receipt_id = ?
        `).get(receiptId) as { output_callback_succeeded_at: string | null };
        expect(pending.output_callback_succeeded_at).toEqual(expect.any(String));
        expect(readInjections()).toEqual([
          expect.objectContaining({ emitted_at: pending.output_callback_succeeded_at }),
          expect.objectContaining({ emitted_at: pending.output_callback_succeeded_at }),
        ]);
      } finally {
        database.close();
      }
    });

    it("does not add ledger rows when Stop runs twice", async () => {
      await emitPendingRules(2, true, "prompt");
      await stopPendingPrompt(prompt);
      const first = readInjections();
      expect(first).toHaveLength(2);
      attachStdin(transcriptPath);
      await runMain();
      expect(readInjections()).toEqual(first);
    });

    it("does not confirm a pending output whose stdout callback failed", async () => {
      const { receiptId, result } = await emitPendingRules(1, false, "prompt");
      expect(result.status).toBe("write_failed");
      await stopPendingPrompt(prompt);
      expect(readInjections()).toEqual([]);
      expect(readCorrectionState().pending).toContainEqual({ receipt_id: receiptId, matched_event_id: expect.any(String) });
    });

    it.skipIf(schemaVersion === 13)("does not confirm a successful pending output that did not match the transcript", async () => {
      const { receiptId, result } = await emitPendingRules(1, true, "prompt");
      expect(result.status).toBe("emitted");
      await stopPendingPrompt("別の合成発話");
      expect(readInjections()).toEqual([]);
      expect(readCorrectionState().pending).toContainEqual({ receipt_id: receiptId, matched_event_id: null });
    });

    it.skipIf(schemaVersion === 13).each([
      { name: "null output", assignment: "output_ledger = 'null'", reason: "output ledger has invalid shape" },
      { name: "array output", assignment: "output_ledger = '[]'", reason: "output ledger has invalid shape" },
      { name: "scalar output", assignment: "output_ledger = '1'", reason: "output ledger has invalid shape" },
      { name: "missing entries", assignment: "output_ledger = json_remove(output_ledger, '$.entries')", reason: "output ledger has invalid shape" },
      { name: "null entries", assignment: "output_ledger = json_set(output_ledger, '$.entries', NULL)", reason: "output ledger has invalid shape" },
      { name: "object entries", assignment: "output_ledger = json_set(output_ledger, '$.entries', json('{}'))", reason: "output ledger has invalid shape" },
      { name: "string entries", assignment: "output_ledger = json_set(output_ledger, '$.entries', 'invalid')", reason: "output ledger has invalid shape" },
      { name: "missing trigger", assignment: "output_ledger = json_remove(output_ledger, '$.trigger')", reason: "output ledger has invalid shape" },
      { name: "invalid trigger", assignment: "output_ledger = json_set(output_ledger, '$.trigger', 'invalid')", reason: "output ledger has invalid shape" },
      { name: "null entry", assignment: "output_ledger = json_set(output_ledger, '$.entries[1]', NULL)", reason: "output ledger has invalid shape" },
      { name: "missing bundle key", assignment: "output_ledger = json_remove(output_ledger, '$.entries[1].bundleKey')", reason: "output ledger has invalid shape" },
      { name: "invalid version", assignment: "output_ledger = json_set(output_ledger, '$.entries[1].version', '1')", reason: "output ledger has invalid shape" },
      { name: "missing body hash", assignment: "output_ledger = json_remove(output_ledger, '$.entries[1].bodyHash')", reason: "output ledger has invalid shape" },
      { name: "invalid output hash", assignment: "output_ledger = json_set(output_ledger, '$.entries[1].outputHash', 1)", reason: "output ledger has invalid shape" },
      { name: "negative output order", assignment: "output_ledger = json_set(output_ledger, '$.entries[1].outputOrder', -1)", reason: "output ledger has invalid shape" },
      { name: "invalid token estimate", assignment: "output_ledger = json_set(output_ledger, '$.entries[1].tokenEstimate', 1.5)", reason: "output ledger has invalid shape" },
      { name: "missing output epoch", assignment: "output_epoch = NULL", reason: "output is incomplete" },
      { name: "missing output hash", assignment: "output_hash = NULL", reason: "output is incomplete" },
      {
        name: "empty ledger",
        assignment: "output_ledger = json_set(output_ledger, '$.entries', json('[]'))",
        reason: "output has no ledger entries",
      },
      {
        name: "second rule without a body",
        assignment: "output_ledger = json_set(output_ledger, '$.entries[1].bodyIncluded', json('false'))",
        reason: "output ledger is inconsistent",
      },
      {
        name: "second rule with a different output hash",
        assignment: "output_ledger = json_set(output_ledger, '$.entries[1].outputHash', 'synthetic-mismatch')",
        reason: "output ledger is inconsistent",
      },
    ])("skips only the inconsistent receipt and completes Stop: $name", async ({ assignment, reason }) => {
      const inconsistent = await emitPendingRules(2, true, "prompt");
      const valid = await emitPendingRules(1, true, "prompt", "valid-pending-human");
      const database = new Database(join(memoryPath, "memory.db"));
      try {
        database.prepare(`UPDATE owner_correction_pending SET ${assignment} WHERE receipt_id = ?`)
          .run(inconsistent.receiptId);
      } finally {
        database.close();
      }
      const transcriptRecords = [
        user("pending-human", prompt, "2026-10-03T00:01:00.000Z"),
        assistant("pending-response", "合成の応答", "2026-10-03T00:01:01.000Z"),
        user("valid-pending-human", prompt, "2026-10-03T00:01:02.000Z"),
        assistant("valid-pending-response", "合成の応答", "2026-10-03T00:01:03.000Z"),
        user("next-correction", "今後は質問に答えてください", "2026-10-03T00:01:04.000Z"),
        assistant("next-response", "合成の応答", "2026-10-03T00:01:05.000Z"),
      ];
      const transcript = writeTranscript(transcriptRecords);
      attachStdin(transcript);
      consoleErrorSpy.mockClear();

      await expect(runMain()).resolves.toBeUndefined();

      const entry = valid.result.rendered.ledger[0];
      const injections = readInjections();
      expect(injections).toEqual([expect.objectContaining({
        bundle_key: entry.bundleKey, version: entry.version, human_ordinal: 2,
        output_hash: valid.result.rendered.outputHash, body_included: 1, stdout_status: "emitted",
      })]);
      const state = readCorrectionState();
      expect(state.pending).toEqual(expect.arrayContaining([
        { receipt_id: inconsistent.receiptId, matched_event_id: expect.any(String) },
        { receipt_id: valid.receiptId, matched_event_id: expect.any(String) },
      ]));
      expect(state.events).toHaveLength(5);
      expect(state.bundles).toContainEqual(expect.objectContaining({ occurrence_count: 2 }));
      const progressDatabase = new Database(join(memoryPath, "memory.db"));
      let progress: unknown;
      try {
        progress = progressDatabase.prepare(`
          SELECT human_ordinal, transcript_offset FROM owner_correction_sessions WHERE session_id_hash = ?
        `).get(hashSessionId("fixture-session"));
      } finally {
        progressDatabase.close();
      }
      expect(progress).toEqual({
        human_ordinal: 3,
        transcript_offset: Buffer.byteLength(transcriptRecords.map((record) => JSON.stringify(record)).join("\n") + "\n"),
      });
      expect(consoleErrorSpy.mock.calls).toEqual([
        [`[analyze] pending correction ${inconsistent.receiptId}: ${reason}`],
      ]);

      attachStdin(transcriptPath);
      await expect(runMain()).resolves.toBeUndefined();
      expect(readInjections()).toEqual(injections);
      expect(readCorrectionState()).toEqual(state);
      expect(consoleErrorSpy).toHaveBeenCalledOnce();
    });

    it.skipIf(schemaVersion === 13)("rolls back matching and every ledger row if confirming the second rule fails", async () => {
      const { receiptId } = await emitPendingRules(2, true, "prompt");
      const database = new Database(join(memoryPath, "memory.db"));
      database.exec(`
        CREATE TRIGGER reject_second_injection BEFORE INSERT ON owner_correction_injections
        WHEN NEW.output_order = 2 BEGIN SELECT RAISE(ABORT, 'synthetic ledger failure'); END
      `);
      database.close();
      await expect(stopPendingPrompt(prompt)).rejects.toThrow("synthetic ledger failure");
      expect(readInjections()).toEqual([]);
      expect(readCorrectionState().pending).toContainEqual({ receipt_id: receiptId, matched_event_id: null });
      expect(readCorrectionState().events).toHaveLength(2);
    });
  });

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
      evidence: [{ detector_version: "owner-correction-v4", conditions: expect.stringContaining('"version":2') }],
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
      evidence: [{ detector_version: "owner-correction-v4" }],
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

  it("schema v12相当のDBでも合成pr規則IDの取消を反映する", async () => {
    const principleKey = `pr:v1:${"d".repeat(64)}`;
    const ruleText = "合成原則";
    const createdAt = "2026-10-03T00:00:01.000Z";
    const database = new Database(join(memoryPath, "memory.db"));
    database.exec(`
      DROP TABLE IF EXISTS owner_correction_principle_members;
      DROP TABLE IF EXISTS owner_correction_strength_events;
      DROP TABLE IF EXISTS owner_correction_graduations;
      DROP TABLE IF EXISTS owner_correction_abstraction_runs;
    `);
    database.prepare(`
      INSERT INTO owner_correction_bundles (
        bundle_key, rule_text, topic_key, polarity, condition_key, project, scope, visibility,
        status, intensity, occurrence_count, session_count, first_seen_at, last_seen_at, expires_at,
        lifetime_kind, continuation_basis, confirmed_at, version, counterevidence_event_id,
        last_confirmation_asked_at, confirmation_state
      ) VALUES (?, ?, 'principle', 'negative', 'general', 'owner', 'owner', 'owner',
        'confirmed', 1, 2, 2, ?, ?, NULL, 'inferred', 'principle_abstraction', ?, 1,
        NULL, NULL, 'none')
    `).run(principleKey, ruleText, createdAt, createdAt, createdAt);
    database.prepare(`
      INSERT INTO owner_correction_versions (
        bundle_key, version, rule_text, body_hash, conditions, condition_key, polarity,
        visibility, status, confirmed_at, expires_at, lifetime_kind, continuation_basis,
        evidence_event_ids, effective_from, change_reason
      ) VALUES (?, 1, ?, 'synthetic-hash', '{}', 'general', 'negative', 'owner',
        'confirmed', ?, NULL, 'inferred', 'principle_abstraction', '[]', ?, 'synthetic')
    `).run(principleKey, ruleText, createdAt, createdAt);
    database.close();

    const sessionId = "cancel-principle-session";
    const transcript = writeTranscript([
      user("human-pr-cancel", `規則ID: ${principleKey} を取り消して`, createdAt, sessionId),
      assistant("assistant-pr-cancel", "取り消しました。", "2026-10-03T00:00:02.000Z", sessionId),
    ]);
    attachStdin(transcript, { session_id: sessionId });
    await runMain();

    expect(readCorrectionState().bundles.find((bundle) => bundle.bundle_key === principleKey))
      .toMatchObject({ status: "rejected" });
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
      const prompt = "前回も言ったけれど、質問に答えてください";
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

  it("普通の依頼は二つのSessionで反復しても本文なし候補に留まり、全文訂正は型文で注入する", async () => {
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
      const requestPrompt = "記事の下書きを書いて";
      const correctionPrompt = "全文出してって前も言ったよね、毎回全文出して";
      const sessions = ["ordinary-request-session-one", "ordinary-request-session-two"];

      for (const [index, sessionId] of sessions.entries()) {
        const requestUuid = `${sessionId}-request`;
        const correctionUuid = `${sessionId}-correction`;
        const requestTranscript = writeTranscript([]);
        attachContextStdin(requestTranscript, sessionId, "UserPromptSubmit", {
          uuid: requestUuid,
          prompt: requestPrompt,
        });
        expect(await context.main()).toBe("emitted");

        const afterRequest = [
          user(requestUuid, requestPrompt, `2026-10-03T00:0${index}:01.000Z`, sessionId),
          assistant(`${sessionId}-draft`, "記事の下書きを作成しました。", `2026-10-03T00:0${index}:02.000Z`, sessionId),
        ];
        attachStdin(writeTranscript(afterRequest), { session_id: sessionId });
        await runMain();

        attachContextStdin(writeTranscript(afterRequest), sessionId, "UserPromptSubmit", {
          uuid: correctionUuid,
          prompt: correctionPrompt,
        });
        expect(await context.main()).toBe("emitted");

        const completeTranscript = writeTranscript([
          ...afterRequest,
          user(correctionUuid, correctionPrompt, `2026-10-03T00:0${index}:03.000Z`, sessionId),
          assistant(`${sessionId}-correction-response`, "全文を表示します。", `2026-10-03T00:0${index}:04.000Z`, sessionId),
        ]);
        attachStdin(completeTranscript, { session_id: sessionId });
        await runMain();
      }

      const state = readCorrectionState();
      const ordinaryBundle = state.bundles.find((bundle) => bundle.topic_key === "unknown");
      const documentBundle = state.bundles.find((bundle) => bundle.topic_key === "document_delivery");

      expect(ordinaryBundle).toMatchObject({
        rule_text: "",
        status: "candidate",
        occurrence_count: 2,
        session_count: 2,
      });
      expect(documentBundle).toMatchObject({
        rule_text: "文章は毎回全文を表示する",
        status: "confirmed",
        occurrence_count: 2,
        session_count: 2,
      });
      expect(state.memories).toEqual([{ id: expect.any(String), content: "文章は毎回全文を表示する", state: "active" }]);

      attachContextStdin(writeTranscript([]), "ordinary-request-next-session", "SessionStart", { source: "startup" });
      expect(await context.main()).toBe("emitted");
      expect(stdoutChunks.join("")).toContain("文章は毎回全文を表示する");
      expect(stdoutChunks.join("")).not.toContain("記事の下書きを書いて");
      expect(stdoutChunks.join("")).not.toMatch(/前も言ったよね|何回言わせる/u);
    } finally {
      stdoutWriteSpy.mockRestore();
    }
  });

  it("一般方針だけをowner可視にし、unknownは素文の否定命令に限る", async () => {
    const longNegativeCommand = `${"あ".repeat(41)}使うな`;
    const ownerCases: Array<{
      topicKey: string;
      content: string;
      visibility: "project" | "owner";
      condition?: string;
    }> = [
      { topicKey: "verification", content: "今後、成果物を原本と照合して", visibility: "owner" },
      { topicKey: "delegation_roles", content: "今後、実装はbackend-engineerに任せて", visibility: "owner" },
      { topicKey: "storage_location", content: "今後、成果物をリポジトリ直下に置いて", visibility: "owner" },
      { topicKey: "verification", content: "今日だけ成果物を原本と照合して", visibility: "project", condition: "task:" },
      { topicKey: "storage_location", content: "今後、成果物は docs/requests の場合だけに保存して", visibility: "project", condition: "unparsed:" },
      { topicKey: "design_components", content: "今後、CSS部品を再利用して", visibility: "project" },
      { topicKey: "model_routing", content: "Codexを使って", visibility: "project" },
      { topicKey: "model_routing", content: "今後、設計はClaudeで担当して", visibility: "project" },
      { topicKey: "unknown", content: "今後、それを作成して", visibility: "project" },
      { topicKey: "unknown", content: longNegativeCommand, visibility: "project", condition: "general" },
    ];

    for (const [index, item] of ownerCases.entries()) {
      const timestamp = `2026-10-03T00:${String(index).padStart(2, "0")}:00.000Z`;
      await runStopCorrection(`visibility-session-${index}`, `visibility-event-${index}`, item.content, timestamp);
      const bundles = readCorrectionState().bundles.filter((candidate) => candidate.topic_key === item.topicKey);
      const bundle = item.condition
        ? bundles.find((candidate) => candidate.condition_key.includes(item.condition!))
        : bundles[0];

      expect(bundle).toMatchObject({ topic_key: item.topicKey, visibility: item.visibility });
    }

    await runStopCorrection("model-route-confirm-two", "model-route-confirm-two-event", "Codexを使って", "2026-10-03T00:10:00.000Z");
    expect(readCorrectionState().bundles.find((bundle) => bundle.topic_key === "model_routing" && bundle.rule_text === "Codexを使って"))
      .toMatchObject({ status: "confirmed", visibility: "owner", lifetime_kind: "routing", expires_at: "2026-10-04T00:10:00.000Z" });

    const longNegativeEvidence = readCorrectionState().evidence.find((entry) => entry.conditions.includes(longNegativeCommand));
    if (!longNegativeEvidence) throw new Error("synthetic unknown evidence was not stored");
    expect(JSON.parse(longNegativeEvidence.conditions)).toMatchObject({ polarity: "negative", plainCommandEligible: false });

    const negativeCommand = "その形式は使うな";
    for (const [index, sessionId] of ["unknown-negative-one", "unknown-negative-two"].entries()) {
      const timestamp = `2026-10-04T00:0${index}:00.000Z`;
      await runStopCorrection(sessionId, `unknown-negative-${index}`, negativeCommand, timestamp);
      if (index === 0) {
        expect(readCorrectionState().bundles.find((candidate) => candidate.topic_key === "unknown" && candidate.polarity === "negative" && candidate.rule_text === negativeCommand))
          .toMatchObject({ status: "candidate", visibility: "project", occurrence_count: 1, session_count: 1 });
      }
    }

    const negativeUnknown = readCorrectionState().bundles.find((candidate) => candidate.topic_key === "unknown" && candidate.polarity === "negative" && candidate.rule_text === negativeCommand);
    expect(negativeUnknown).toMatchObject({
      topic_key: "unknown",
      polarity: "negative",
      rule_text: negativeCommand,
      status: "confirmed",
      visibility: "owner",
      occurrence_count: 2,
      session_count: 2,
    });
  });

  it("disputes opposite-polarity short model routes in the same session", async () => {
    const sessionId = "short-model-route-conflict";
    const transcript = writeTranscript([
      user("route-positive", "Codexを使って", "2026-10-04T00:00:00.000Z", sessionId),
      assistant("route-positive-response", "合成の応答", "2026-10-04T00:00:01.000Z", sessionId),
      user("route-negative", "Codexをやめて", "2026-10-04T00:01:00.000Z", sessionId),
      assistant("route-negative-response", "合成の応答", "2026-10-04T00:01:01.000Z", sessionId),
    ]);
    attachStdin(transcript, { session_id: sessionId });

    await runMain();

    const routeBundles = readCorrectionState().bundles.filter((bundle) => bundle.topic_key === "model_routing");
    expect(routeBundles).toHaveLength(2);
    expect(routeBundles.map((bundle) => bundle.status)).toEqual(["disputed", "disputed"]);
  });

  it("expires a short model route after a same-session retraction within five human utterances", async () => {
    const sessionId = "short-model-route-retraction";
    const transcript = writeTranscript([
      user("route-root", "Codexを使って", "2026-10-04T00:00:00.000Z", sessionId),
      assistant("route-root-response", "合成の応答", "2026-10-04T00:00:01.000Z", sessionId),
      user("route-retraction", "今回はCodexじゃない", "2026-10-04T00:01:00.000Z", sessionId),
      assistant("route-retraction-response", "合成の応答", "2026-10-04T00:01:01.000Z", sessionId),
    ]);
    attachStdin(transcript, { session_id: sessionId });

    await runMain();

    expect(readCorrectionState().bundles).toMatchObject([
      { topic_key: "model_routing", rule_text: "Codexを使って", status: "expired", lifetime_kind: "routing" },
    ]);
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
      evidence: [{ detector_version: "owner-correction-v4", conditions: expect.stringContaining('"version":2') }],
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
