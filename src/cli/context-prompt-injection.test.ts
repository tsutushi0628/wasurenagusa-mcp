import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { selectCorrectionInjections } from "../corrections/injection-policy.js";
import { hashSessionId } from "../corrections/session-store.js";
import { SQLiteStorage } from "../storage/sqlite.js";
import { initializeCorrectionSchema } from "../storage/correction-schema.js";

const { memoryPathState } = vi.hoisted(() => ({ memoryPathState: { value: "" } }));

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, getMemoryPath: () => memoryPathState.value };
});

import { main } from "./context.js";

const scratchRoot = join(process.cwd(), ".tmp", "codex-T11");
const changedEnvironmentKeys = ["WASURENAGUSA_CORRECTION_LOOP", "WASURENAGUSA_CORRECTION_INJECT"] as const;

describe("context.ts: 人間のコードだけのprompt", () => {
  let tempDirectory: string | undefined;
  let priorStdin: PropertyDescriptor | undefined;
  let priorStdout: PropertyDescriptor | undefined;
  let priorEnvironment = new Map<string, string | undefined>();
  let consoleErrorSpy: ReturnType<typeof vi.spyOn> | undefined;

  afterEach(() => {
    if (priorStdin) Object.defineProperty(process, "stdin", priorStdin);
    if (priorStdout) Object.defineProperty(process, "stdout", priorStdout);
    for (const [key, value] of priorEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    priorEnvironment.clear();
    memoryPathState.value = "";
    consoleErrorSpy?.mockRestore();
    consoleErrorSpy = undefined;
    if (tempDirectory) rmSync(tempDirectory, { recursive: true, force: true });
    tempDirectory = undefined;
  });

  it("抽出結果がnullでも確定済み規則をrestoreとして選び、stdoutへ注入する", async () => {
    mkdirSync(scratchRoot, { recursive: true });
    tempDirectory = mkdtempSync(join(scratchRoot, "context-code-prompt-"));
    const projectRoot = join(tempDirectory, "fixture-project");
    const memoryPath = join(projectRoot, ".wasurenagusa");
    const dbPath = join(memoryPath, "memory.db");
    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    mkdirSync(memoryPath, { recursive: true });
    memoryPathState.value = memoryPath;

    priorEnvironment = new Map(changedEnvironmentKeys.map((key) => [key, process.env[key]]));
    process.env.WASURENAGUSA_CORRECTION_LOOP = "on";
    process.env.WASURENAGUSA_CORRECTION_INJECT = "on";
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    priorStdin = Object.getOwnPropertyDescriptor(process, "stdin");
    priorStdout = Object.getOwnPropertyDescriptor(process, "stdout");

    const initialStorage = new SQLiteStorage(dbPath);
    initialStorage.initialize(memoryPath);
    initialStorage.close();
    const database = new Database(dbPath);
    initializeCorrectionSchema(database);
    database.close();

    const seedStorage = new SQLiteStorage(dbPath);
    const project = projectRoot.split("/").at(-1) ?? "fixture-project";
    const ruleText = "質問には常体で回答する";
    seedStorage.runCorrectionTransaction(({ db, save }) => {
      const memory = save({
        category: "dont",
        title: "合成の確定規則",
        content: ruleText,
        tags: ["synthetic"],
        project,
        scope: "general",
        intensity: 5,
      });
      db.prepare(`
        INSERT INTO owner_correction_bundles (
          bundle_key, memory_id, rule_text, topic_key, polarity, condition_key, project, scope,
          visibility, status, intensity, occurrence_count, session_count, first_seen_at, last_seen_at,
          expires_at, lifetime_kind, continuation_basis, confirmed_at, version, counterevidence_event_id,
          last_confirmation_asked_at, confirmation_state
        ) VALUES (?, ?, ?, 'tone', 'negative', 'general', ?, 'general', 'owner', 'confirmed',
          5, 2, 2, ?, ?, NULL, 'explicit_continuing', 'synthetic-continuation', ?, 1, NULL, NULL, 'none')
      `).run(
        "synthetic-confirmed-rule",
        memory.id,
        ruleText,
        project,
        "2026-10-01T00:00:00.000Z",
        "2026-10-01T00:00:00.000Z",
        "2026-10-01T00:00:00.000Z",
      );
      db.prepare(`
        INSERT INTO owner_correction_versions (
          bundle_key, version, rule_text, body_hash, conditions, condition_key, polarity, visibility,
          status, confirmed_at, expires_at, lifetime_kind, continuation_basis, evidence_event_ids,
          effective_from, change_reason
        ) VALUES (?, 1, ?, 'synthetic-hash', '[]', 'general', 'negative', 'owner', 'confirmed', ?, NULL,
          'explicit_continuing', 'synthetic-continuation', '[]', ?, 'synthetic-fixture')
      `).run(
        "synthetic-confirmed-rule",
        ruleText,
        "2026-10-01T00:00:00.000Z",
        "2026-10-01T00:00:00.000Z",
      );
    });

    const prompt = ["```ts", "const value = 1;", "```"].join("\n");
    const hookInput = {
      session_id: "synthetic-code-only-session",
      cwd: projectRoot,
      hook_event_name: "UserPromptSubmit",
      prompt,
    };
    const selection = selectCorrectionInjections(seedStorage, {
      project,
      scope: "general",
      query: prompt,
      at: new Date().toISOString(),
      sessionIdHash: hashSessionId(hookInput.session_id),
      compactEpoch: 0,
      humanOrdinal: 1,
      trigger: "prompt",
    });
    expect(selection.rules).toMatchObject([
      { bundleKey: "synthetic-confirmed-rule", delivery: "restore" },
    ]);
    seedStorage.close();
    Object.defineProperty(process, "stdin", {
      value: Readable.from([Buffer.from(JSON.stringify(hookInput), "utf8")]),
      configurable: true,
    });
    let stdoutText = "";
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        stdoutText += chunk.toString();
        callback();
      },
    });
    Object.defineProperty(process, "stdout", { value: stdout, configurable: true });

    expect(await main()).toBe("emitted");
    expect(stdoutText).toContain(ruleText);

    const checkDatabase = new Database(dbPath, { readonly: true });
    try {
      expect(checkDatabase.prepare(`
        SELECT bundle_key, trigger, human_ordinal, stdout_status
        FROM owner_correction_injections
      `).get()).toMatchObject({
        bundle_key: "synthetic-confirmed-rule",
        trigger: "prompt",
        human_ordinal: 1,
        stdout_status: "emitted",
      });
    } finally {
      checkDatabase.close();
    }
  });
});
