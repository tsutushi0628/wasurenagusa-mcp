import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectOwnerCorrections } from "../corrections/detector.js";
import { extractOwnerEvent } from "../corrections/events.js";
import { selectCorrectionInjections } from "../corrections/injection-policy.js";
import { applyCorrectionEvidence } from "../corrections/store.js";
import { correctionConditionKey, serializeCorrectionRuleInput } from "../corrections/rule-template.js";
import { hashSessionId } from "../corrections/session-store.js";
import { migrateV11ToV12, migrateV12ToV13, migrateV13ToV14 } from "../storage/migration.js";
import { SQLiteStorage } from "../storage/sqlite.js";
import { initializeCorrectionSchema } from "../storage/correction-schema.js";

const { memoryPathState } = vi.hoisted(() => ({ memoryPathState: { value: "" } }));

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, getMemoryPath: () => memoryPathState.value };
});

import { main } from "./context.js";

const scratchRoot = join(process.cwd(), ".tmp", "codex-T11");
const changedEnvironmentKeys = [
  "WASURENAGUSA_CORRECTION_LOOP",
  "WASURENAGUSA_CORRECTION_INJECT",
  "WASURENAGUSA_PRINCIPLES",
  "WASURENAGUSA_GRADUATION",
  "WASURENAGUSA_STRENGTH",
  "WASURENAGUSA_CORRECTION_REINJECT",
  "WASURENAGUSA_CANDIDATE_INJECT",
  "WASURENAGUSA_OWNER_SCOPE_BEHAVIOR",
  "WASURENAGUSA_CORRECTION_COMPLIANCE",
] as const;

async function runContextHook(hookInput: Record<string, unknown>): Promise<{ status: string; output: string }> {
  Object.defineProperty(process, "stdin", {
    value: Readable.from([Buffer.from(JSON.stringify(hookInput), "utf8")]),
    configurable: true,
  });
  let output = "";
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  Object.defineProperty(process, "stdout", { value: stdout, configurable: true });
  return { status: await main(), output };
}

describe("context.ts: 人間のコードだけのprompt", () => {
  let tempDirectory: string | undefined;
  let priorStdin: PropertyDescriptor | undefined;
  let priorStdout: PropertyDescriptor | undefined;
  let priorEnvironment = new Map<string, string | undefined>();
  let consoleErrorSpy: ReturnType<typeof vi.spyOn> | undefined;
  const stderrLines: string[] = [];

  beforeEach(() => {
    vi.stubEnv("WASURENAGUSA_RULINGS_PATH", join(scratchRoot, "missing-rulings.json"));
  });

  afterEach(() => {
    if (priorStdin) Object.defineProperty(process, "stdin", priorStdin);
    if (priorStdout) Object.defineProperty(process, "stdout", priorStdout);
    for (const [key, value] of priorEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    priorEnvironment.clear();
    vi.unstubAllEnvs();
    memoryPathState.value = "";
    consoleErrorSpy?.mockRestore();
    consoleErrorSpy = undefined;
    stderrLines.length = 0;
    if (tempDirectory) rmSync(tempDirectory, { recursive: true, force: true });
    tempDirectory = undefined;
  });

  it.each(
    (["SessionStart", "UserPromptSubmit", "PreCompact"] as const).flatMap((eventKind) =>
      (["project-root", "override"] as const).map((rulingsSource) => ({ eventKind, rulingsSource })),
    ),
  )("$eventKindで$rulingsSourceの指摘リストを照合し、再注入を省く回のログは除外0件にする", async ({ eventKind, rulingsSource }) => {
    mkdirSync(scratchRoot, { recursive: true });
    tempDirectory = mkdtempSync(join(scratchRoot, "context-rulings-"));
    const projectRoot = join(tempDirectory, "fixture-project");
    const memoryPath = join(projectRoot, ".wasurenagusa");
    const dbPath = join(memoryPath, "memory.db");
    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    mkdirSync(memoryPath, { recursive: true });
    memoryPathState.value = memoryPath;
    priorEnvironment = new Map(changedEnvironmentKeys.map((key) => [key, process.env[key]]));
    process.env.WASURENAGUSA_CORRECTION_LOOP = "on";
    process.env.WASURENAGUSA_CORRECTION_INJECT = "on";
    for (const key of changedEnvironmentKeys.slice(2)) process.env[key] = "off";
    priorStdin = Object.getOwnPropertyDescriptor(process, "stdin");
    priorStdout = Object.getOwnPropertyDescriptor(process, "stdout");

    const initialStorage = new SQLiteStorage(dbPath);
    initialStorage.initialize(memoryPath);
    initialStorage.close();
    const database = new Database(dbPath);
    initializeCorrectionSchema(database);
    migrateV11ToV12(database);
    migrateV12ToV13(database);
    migrateV13ToV14(database);
    database.close();

    const duplicateText = "おい質問に答えろ";
    const retainedText = "ちゃんと全体設計して。";
    const seedAt = new Date(Date.now() - 60_000).toISOString();
    const seedStorage = new SQLiteStorage(dbPath);
    try {
      seedStorage.runCorrectionTransaction(({ db, save }) => {
        for (const [index, ruleText] of [duplicateText, retainedText].entries()) {
          const eventId = `synthetic-rulings-event-${index}`;
          db.prepare(`
            INSERT INTO owner_correction_events (
              event_id, session_id_hash, source_uuid_hash, human_ordinal, observed_at, available_at,
              source_kind, excerpt, previous_action, action_first_locator_hash, action_last_locator_hash,
              project, scope, raw_text_hash, source_locator_hash, processed_at
            ) VALUES (?, 'synthetic-seed-session', NULL, 1, ?, ?, 'user', ?, 'action_unknown', NULL, NULL,
              'fixture-project', 'general', 'synthetic-raw-hash', ?, ?)
          `).run(eventId, seedAt, seedAt, ruleText, `locator-${index}`, seedAt);
          const bundleKey = `synthetic-ruling-${index}`;
          const memory = save({
            category: "dont",
            title: "合成の確定規則",
            content: ruleText,
            tags: ["synthetic"],
            project: "fixture-project",
            scope: "general",
            intensity: 5,
          });
          db.prepare(`
            INSERT INTO owner_correction_bundles (
              bundle_key, memory_id, rule_text, topic_key, polarity, condition_key, project, scope,
              visibility, status, intensity, occurrence_count, session_count, first_seen_at, last_seen_at,
              expires_at, lifetime_kind, continuation_basis, confirmed_at, version, counterevidence_event_id,
              last_confirmation_asked_at, confirmation_state
            ) VALUES (?, ?, ?, 'verification', 'negative', 'general', 'fixture-project', 'general', 'owner', 'confirmed',
              5, 2, 2, ?, ?, NULL, 'explicit_continuing', 'synthetic-continuation', ?, 1, NULL, NULL, 'none')
          `).run(bundleKey, memory.id, ruleText, seedAt, seedAt, seedAt);
          db.prepare(`
            INSERT INTO owner_correction_versions (
              bundle_key, version, rule_text, body_hash, conditions, condition_key, polarity, visibility,
              status, confirmed_at, expires_at, lifetime_kind, continuation_basis, evidence_event_ids,
              effective_from, change_reason
            ) VALUES (?, 1, ?, 'synthetic-hash', '[]', 'general', 'negative', 'owner', 'confirmed', ?, NULL,
              'explicit_continuing', 'synthetic-continuation', '[]', ?, 'synthetic-fixture')
          `).run(bundleKey, ruleText, seedAt, seedAt);
          db.prepare(`
            INSERT INTO owner_correction_evidence (event_id, bundle_key, source, score, detector_version, conditions, polarity)
            VALUES (?, ?, 'legacy_import', 2, 'fixture-v1', '[]', 'negative')
          `).run(eventId, bundleKey);
        }
      });
    } finally {
      seedStorage.close();
    }
    let rulingsPath: string;
    if (rulingsSource === "override") {
      rulingsPath = join(tempDirectory, "rulings.json");
      process.env.WASURENAGUSA_RULINGS_PATH = rulingsPath;
    } else {
      mkdirSync(join(projectRoot, ".claude", "rulings"), { recursive: true });
      rulingsPath = join(projectRoot, ".claude", "rulings", "rulings.json");
      delete process.env.WASURENAGUSA_RULINGS_PATH;
    }
    writeFileSync(rulingsPath, JSON.stringify({
      rulings: [{ id: "r-synthetic", rule: "合成の回答規則", quotes: [{ date: "2026-10-01", text: duplicateText }], status: "active", project: null }],
      resolved_pendings: [],
    }), "utf8");
    const nestedCwd = join(projectRoot, "nested", "src");
    mkdirSync(nestedCwd, { recursive: true });

    const result = await runContextHook({
      session_id: `synthetic-rulings-session-${eventKind}`,
      cwd: nestedCwd,
      hook_event_name: eventKind,
      source: "startup",
      prompt: "作業を続けて",
    });

    expect(result.status).toBe("emitted");
    expect(result.output).not.toContain(duplicateText);
    expect(result.output).toContain(retainedText);
    let expectedMissingCount = 0;
    const outputDatabase = new Database(dbPath);
    try {
      const injections = outputDatabase.prepare(`
        SELECT bundle_key, body_included, stdout_status FROM owner_correction_injections
        WHERE session_id_hash = ?
      `).all(hashSessionId(`synthetic-rulings-session-${eventKind}`));
      if (eventKind === "UserPromptSubmit") {
        expectedMissingCount = 1;
        expect(injections).toEqual([]);
        const pending = outputDatabase.prepare(`
          SELECT output_bundle_key, output_version, output_callback_succeeded_at
          FROM owner_correction_pending WHERE session_id_hash = ?
        `).all(hashSessionId(`synthetic-rulings-session-${eventKind}`));
        expect(pending).toEqual([{
          output_bundle_key: "synthetic-ruling-1",
          output_version: 1,
          output_callback_succeeded_at: expect.any(String),
        }]);
      } else {
        expect(injections).toEqual([{
          bundle_key: "synthetic-ruling-1", body_included: 1, stdout_status: "emitted",
        }]);
      }
    } finally {
      outputDatabase.close();
    }
    const metricsDirectory = join(memoryPath, "logs", "correction-metrics");
    const logFile = readdirSync(metricsDirectory).find((name) => name.startsWith(`${eventKind}-`) && name.endsWith(".jsonl"));
    if (logFile === undefined) throw new Error("correction metrics log was not written");
    const metrics = readFileSync(join(metricsDirectory, logFile), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(metrics.filter((entry) => entry.k === "sample")).toEqual([
      expect.objectContaining({ rulings_excluded: 1, miss: expectedMissingCount }),
    ]);
    if (eventKind !== "UserPromptSubmit") {
      const repeated = await runContextHook({
        session_id: `synthetic-rulings-session-${eventKind}`,
        cwd: nestedCwd,
        hook_event_name: eventKind,
        source: "startup",
        prompt: "作業を続けて",
      });

      expect(repeated.output).not.toContain(duplicateText);
      expect(repeated.output).not.toContain(retainedText);
      if (eventKind === "PreCompact") expect(repeated.output).toBe("");
      const repeatedMetrics = readFileSync(join(metricsDirectory, logFile), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(repeatedMetrics.filter((entry) => entry.k === "sample")).toEqual([
        expect.objectContaining({ rulings_excluded: 1 }),
        expect.objectContaining({ rulings_excluded: 0 }),
      ]);
    }
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
    process.env.WASURENAGUSA_PRINCIPLES = "shadow";
    process.env.WASURENAGUSA_GRADUATION = "off";
    process.env.WASURENAGUSA_STRENGTH = "off";
    process.env.WASURENAGUSA_CORRECTION_REINJECT = "on";
    process.env.WASURENAGUSA_CANDIDATE_INJECT = "off";
    process.env.WASURENAGUSA_OWNER_SCOPE_BEHAVIOR = "off";
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
      stderrLines.push(args.join(" "));
    });
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
      projectRoot,
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
    for (const key of changedEnvironmentKeys.slice(2)) process.env[key] = "true";
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
    const stderrText = stderrLines.join("\n");
    for (const key of changedEnvironmentKeys.slice(2)) {
      const diagnostic = stderrLines.find((line) => line.includes(key));
      expect(stderrLines.filter((line) => line.includes(key))).toHaveLength(1);
      expect(stderrText).toContain(`${key}=\"true\"`);
      expect(diagnostic).toContain("using off");
    }

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

  it.each([12, 13])("保存APIが作ったv2確定束をv%s hookで言い直し時だけ再注入する", async (schemaVersion) => {
    tempDirectory = mkdtempSync(join(tmpdir(), `context-reinjection-v${schemaVersion}-`));
    const projectRoot = join(tempDirectory, "fixture-project");
    const memoryPath = join(projectRoot, ".wasurenagusa");
    const dbPath = join(memoryPath, "memory.db");
    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    mkdirSync(memoryPath, { recursive: true });
    memoryPathState.value = memoryPath;
    priorEnvironment = new Map(changedEnvironmentKeys.map((key) => [key, process.env[key]]));
    process.env.WASURENAGUSA_CORRECTION_LOOP = "on";
    process.env.WASURENAGUSA_CORRECTION_INJECT = "on";
    process.env.WASURENAGUSA_PRINCIPLES = "shadow";
    process.env.WASURENAGUSA_GRADUATION = "off";
    process.env.WASURENAGUSA_STRENGTH = "off";
    process.env.WASURENAGUSA_CORRECTION_REINJECT = "on";
    process.env.WASURENAGUSA_CANDIDATE_INJECT = "off";
    process.env.WASURENAGUSA_OWNER_SCOPE_BEHAVIOR = "off";
    process.env.WASURENAGUSA_CORRECTION_COMPLIANCE = "on";
    priorStdin = Object.getOwnPropertyDescriptor(process, "stdin");
    priorStdout = Object.getOwnPropertyDescriptor(process, "stdout");

    const initialStorage = new SQLiteStorage(dbPath);
    initialStorage.initialize(memoryPath);
    initialStorage.close();
    const database = new Database(dbPath);
    initializeCorrectionSchema(database);
    migrateV11ToV12(database);
    if (schemaVersion === 13) migrateV12ToV13(database);
    database.close();

    const project = projectRoot.split("/").at(-1) ?? "fixture-project";
    const seedAt = new Date(Date.now() - 60_000).toISOString();
    const seedText = "だから全文出せって";
    const seedEvent = extractOwnerEvent({
      type: "user",
      origin: { kind: "human" },
      sessionId: "synthetic-correction-seed-session",
      uuid: "synthetic-correction-seed",
      timestamp: seedAt,
      message: { content: seedText },
    });
    if (!seedEvent) throw new Error("synthetic correction seed event was not extracted");
    const candidate = detectOwnerCorrections(seedEvent).find((entry) => entry.source === "utterance_detection");
    if (!candidate?.ruleText) throw new Error("synthetic correction seed bundle was not detected");
    const seedStorage = new SQLiteStorage(dbPath);
    const savedBundle = seedStorage.runCorrectionTransaction(({ db, save }) => {
      db.prepare(`
        INSERT INTO owner_correction_events (
          event_id, session_id_hash, source_uuid_hash, human_ordinal, observed_at, available_at,
          source_kind, excerpt, previous_action, action_first_locator_hash, action_last_locator_hash,
          project, scope, raw_text_hash, source_locator_hash, processed_at
        ) VALUES (?, ?, NULL, 1, ?, ?, 'user', '合成発話', 'action_unknown', NULL, NULL,
          ?, 'general', 'synthetic-raw-hash', ?, ?)
      `).run(
        "synthetic-correction-seed",
        hashSessionId("synthetic-correction-seed-session"),
        seedAt,
        seedAt,
        project,
        "synthetic-seed-locator",
        seedAt,
      );
      return applyCorrectionEvidence({ db, save }, {
        eventId: "synthetic-correction-seed",
        at: seedAt,
        bundleKey: candidate.bundleKey,
        ruleText: candidate.ruleText,
        topicKey: candidate.topicKey,
        polarity: candidate.polarity,
        conditionKey: correctionConditionKey(candidate.ruleInput),
        visibility: "owner",
        decision: "owner_confirmed",
        lifetimeKind: candidate.lifetimeKind,
        continuationBasis: candidate.ruleInput.continuationBasis,
        evidence: {
          source: candidate.source,
          score: candidate.score,
          detectorVersion: "synthetic-detector-v1",
          conditions: serializeCorrectionRuleInput(candidate.ruleInput),
          polarity: candidate.polarity,
        },
      });
    });
    expect(savedBundle.status).toBe("confirmed");
    expect(savedBundle.bundleKey).toMatch(/^oc:v2:[0-9a-f]{64}$/u);
    const seedSelection = selectCorrectionInjections(seedStorage, {
      projectRoot,
      project,
      scope: "general",
      query: "",
      at: new Date().toISOString(),
      sessionIdHash: hashSessionId(`synthetic-reinjection-session-v${schemaVersion}`),
      compactEpoch: 0,
      humanOrdinal: 1,
      trigger: "start",
    });
    expect(seedSelection.rules.map((rule) => rule.bundleKey)).toContain(savedBundle.bundleKey);
    seedStorage.close();

    const sessionId = `synthetic-reinjection-session-v${schemaVersion}`;
    const sessionIdHash = hashSessionId(sessionId);
    const sessionStart = await runContextHook({
      session_id: sessionId,
      cwd: projectRoot,
      hook_event_name: "SessionStart",
      source: "startup",
    });
    expect(sessionStart.status).toBe("emitted");
    expect(sessionStart.output).toContain(candidate.ruleText);

    const sessionDatabase = new Database(dbPath);
    sessionDatabase.prepare(`
      UPDATE owner_correction_sessions SET human_ordinal = 1 WHERE session_id_hash = ?
    `).run(sessionIdHash);
    sessionDatabase.close();

    const corrected = await runContextHook({
      session_id: sessionId,
      cwd: projectRoot,
      hook_event_name: "UserPromptSubmit",
      prompt: "だから全文出せって",
    });
    expect(corrected.output).toContain(candidate.ruleText);

    const afterCorrectionDatabase = new Database(dbPath);
    afterCorrectionDatabase.prepare(`
      UPDATE owner_correction_sessions SET human_ordinal = 2 WHERE session_id_hash = ?
    `).run(sessionIdHash);
    afterCorrectionDatabase.close();

    const unrelated = await runContextHook({
      session_id: sessionId,
      cwd: projectRoot,
      hook_event_name: "UserPromptSubmit",
      prompt: "文書の保存場所は？",
    });
    expect(unrelated.output).not.toContain(candidate.ruleText);
  });
});
