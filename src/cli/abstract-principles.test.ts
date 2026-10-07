import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateV10ToV11, migrateV11ToV12, migrateV12ToV13 } from "../storage/migration.js";
import { initializeSchema } from "../storage/schema.js";
import { SQLiteStorage } from "../storage/sqlite.js";
import { selectCorrectionInjections } from "../corrections/injection-policy.js";
import { persistCorrectionComplianceViolations } from "../corrections/compliance.js";
import { cancelCorrectionPrinciple } from "../corrections/principles.js";
import { runStrengthJob } from "../corrections/strength.js";
import { runAbstractPrinciplesCli, runAbstractPrinciplesJob } from "./abstract-principles.js";

const at = "2026-10-03T04:00:00.000Z";
const validMerge = {
  group_id: "g-0001",
  verdict: "merge",
  principle: "合成記録を先に確認する",
  odd_ids: [],
};

describe("abstract-principles", () => {
  let directory: string;
  let memoryPath: string;
  let storage: SQLiteStorage;
  let previousMode: string | undefined;
  let previousLoopMode: string | undefined;
  let previousComplianceMode: string | undefined;
  let previousMemoryPath: string | undefined;

  beforeEach(() => {
    previousMode = process.env.WASURENAGUSA_PRINCIPLES;
    previousLoopMode = process.env.WASURENAGUSA_CORRECTION_LOOP;
    previousComplianceMode = process.env.WASURENAGUSA_CORRECTION_COMPLIANCE;
    previousMemoryPath = process.env.WASURENAGUSA_MEMORY_PATH;
    process.env.WASURENAGUSA_PRINCIPLES = "shadow";
    process.env.WASURENAGUSA_CORRECTION_COMPLIANCE = "on";
    directory = mkdtempSync(join(tmpdir(), "wasurenagusa-abstract-principles-test-"));
    memoryPath = join(directory, ".wasurenagusa");
    const dbPath = join(memoryPath, "memory.db");
    const initialStorage = new SQLiteStorage(dbPath);
    initialStorage.initialize();
    initialStorage.close();
    const migrationDb = new Database(dbPath);
    migrateV10ToV11(migrationDb);
    migrateV11ToV12(migrationDb);
    migrateV12ToV13(migrationDb);
    migrationDb.close();
    storage = new SQLiteStorage(dbPath);
    storage.initialize();
    seedRules();
  });

  afterEach(() => {
    storage.close();
    rmSync(directory, { recursive: true, force: true });
    if (previousMode === undefined) delete process.env.WASURENAGUSA_PRINCIPLES;
    else process.env.WASURENAGUSA_PRINCIPLES = previousMode;
    if (previousLoopMode === undefined) delete process.env.WASURENAGUSA_CORRECTION_LOOP;
    else process.env.WASURENAGUSA_CORRECTION_LOOP = previousLoopMode;
    if (previousComplianceMode === undefined) delete process.env.WASURENAGUSA_CORRECTION_COMPLIANCE;
    else process.env.WASURENAGUSA_CORRECTION_COMPLIANCE = previousComplianceMode;
    if (previousMemoryPath === undefined) delete process.env.WASURENAGUSA_MEMORY_PATH;
    else process.env.WASURENAGUSA_MEMORY_PATH = previousMemoryPath;
  });

  function seedRules(options: {
    prefix?: string;
    topicKey?: string;
    conditions?: string;
    texts?: string[];
  } = {}): void {
    const prefix = options.prefix ?? "member";
    const topicKey = options.topicKey ?? "verification";
    const conditions = options.conditions ?? "{}";
    const texts = options.texts ?? [
      "合成記録を先に確認する",
      "合成記録は先に確認する",
      "合成記録を先に確認します",
    ];
    const rules = texts.map((text, index) => ({
      key: `${prefix}-${String.fromCharCode(97 + index)}`,
      text,
      session: `${prefix}-session-${String.fromCharCode(97 + index)}`,
      minute: String(index + 1).padStart(2, "0"),
    }));
    for (const [index, rule] of rules.entries()) {
      const observedAt = "2026-10-03T00:" + rule.minute + ":10.000Z";
      storage.runCorrectionTransaction(({ db }) => {
        db.prepare(`
          INSERT INTO owner_correction_bundles (
            bundle_key, memory_id, rule_text, topic_key, polarity, condition_key, project, scope,
            visibility, status, intensity, occurrence_count, session_count, first_seen_at, last_seen_at,
            expires_at, lifetime_kind, continuation_basis, confirmed_at, version, counterevidence_event_id,
            last_confirmation_asked_at, confirmation_state
          ) VALUES (?, NULL, ?, ?, 'positive', 'general', 'fixture-project', 'backend',
            'owner', 'confirmed', 3, 1, 1, ?, ?, NULL, 'inferred', 'synthetic', ?, 1, NULL, NULL, 'none')
        `).run(rule.key, rule.text, topicKey, observedAt, observedAt, observedAt);
        db.prepare(`
          INSERT INTO owner_correction_versions (
            bundle_key, version, rule_text, body_hash, conditions, condition_key, polarity, visibility,
            status, confirmed_at, expires_at, lifetime_kind, continuation_basis, evidence_event_ids,
            effective_from, change_reason
          ) VALUES (?, 1, ?, 'synthetic-hash', ?, 'general', 'positive', 'owner', 'confirmed', ?, NULL,
            'inferred', 'synthetic', '[]', ?, 'synthetic-fixture')
        `).run(rule.key, rule.text, conditions, observedAt, observedAt);
        db.prepare(`
          INSERT INTO owner_correction_events (
            event_id, session_id_hash, source_uuid_hash, human_ordinal, observed_at, available_at,
            source_kind, excerpt, previous_action, action_first_locator_hash, action_last_locator_hash,
            project, scope, raw_text_hash, source_locator_hash, processed_at
          ) VALUES (?, ?, NULL, 1, ?, ?, 'user', '合成発話', 'action_unknown', NULL, NULL,
            'fixture-project', 'backend', ?, ?, ?)
        `).run(`event-${rule.key}`, rule.session, observedAt, observedAt, `hash-${index}`, `locator-${rule.key}`, observedAt);
        db.prepare(`
          INSERT INTO owner_correction_evidence (
            event_id, bundle_key, source, score, detector_version, conditions, polarity
          ) VALUES (?, ?, 'request_repeat', 2, 'fixture-v1', ?, 'positive')
        `).run(`event-${rule.key}`, rule.key, conditions);
      });
    }
  }

  function batchResult(output: unknown) {
    return {
      status: "called" as const,
      calls: 1 as const,
      output: JSON.stringify(output),
      skippedReason: null,
      quotaBeforePct: 50,
      quotaAfterPct: 47,
      failureReason: null,
    };
  }

  it("dry-runは候補群と群数だけ返し、CodexもDB書き込みも行わない", async () => {
    const runBatch = vi.fn();

    const result = await runAbstractPrinciplesJob(storage, {
      mode: "shadow",
      at,
      memoryPath,
      runId: "dry-run-fixture",
      dryRun: true,
      promptTemplate: "{{GROUPS_JSON}}",
      runBatch,
    });

    expect(result).toMatchObject({ dryRun: true, groups: 1, calls: 0, adopted: 0 });
    expect(result.candidateGroups).toHaveLength(1);
    expect(runBatch).not.toHaveBeenCalled();
    expect(storage.runCorrectionTransaction(({ db }) => db.prepare(
      "SELECT COUNT(*) AS count FROM owner_correction_abstraction_runs",
    ).get().count)).toBe(0);
    expect(storage.runCorrectionTransaction(({ db }) => db.prepare(
      "SELECT COUNT(*) AS count FROM owner_correction_bundles WHERE bundle_key LIKE 'pr:v1:%'",
    ).get().count)).toBe(0);
  });

  it("WASURENAGUSA_MEMORY_PATHだけを指定した子CLIが保存先のmemory.dbを開く", () => {
    const childMemoryDir = join(directory, "cli-memory");
    const dbPath = join(childMemoryDir, "memory.db");
    const initialStorage = new SQLiteStorage(dbPath);
    initialStorage.initialize();
    initialStorage.close();
    const db = new Database(dbPath);
    migrateV10ToV11(db);
    migrateV11ToV12(db);
    db.close();
    const childEnv = {
      ...process.env,
      WASURENAGUSA_MEMORY_PATH: childMemoryDir,
      WASURENAGUSA_CORRECTION_LOOP: "on",
      WASURENAGUSA_PRINCIPLES: "shadow",
    };
    delete childEnv.MEMORY_DIR;

    const output = execFileSync(process.execPath, [
      "--loader",
      "ts-node/esm",
      "src/cli/abstract-principles.ts",
    ], {
      cwd: resolve("."),
      env: childEnv,
      encoding: "utf8",
    });

    expect(JSON.parse(output.trim())).toMatchObject({
      mode: "shadow",
      skippedReason: "schema_unavailable",
    });
  });

  it("shadowではmergeだけをcandidateで保存し、同じ1プロンプト内で一度だけ判定する", async () => {
    const runBatch = vi.fn(async (prompt: string) => {
      expect(prompt).toContain('"group_id":"g-0001"');
      expect(prompt.match(/合成記録/g)).not.toBeNull();
      return batchResult([validMerge]);
    });

    const result = await runAbstractPrinciplesJob(storage, {
      mode: "shadow",
      at,
      memoryPath,
      runId: "shadow-fixture",
      promptTemplate: "{{GROUPS_JSON}}",
      runBatch,
    });

    expect(runBatch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ groups: 1, calls: 1, adopted: 1, rejectedGuard: 0, rejectedNone: 0 });
    const principle = storage.runCorrectionTransaction(({ db }) => db.prepare(`
      SELECT bundle_key, status FROM owner_correction_bundles WHERE bundle_key LIKE 'pr:v1:%'
    `).get());
    expect(principle.status).toBe("candidate");
    expect(storage.runCorrectionTransaction(({ db }) => db.prepare(
      "SELECT COUNT(*) AS count FROM owner_correction_principle_members WHERE principle_key = ?",
    ).get(principle.bundle_key).count)).toBe(3);
    expect(storage.runCorrectionTransaction(({ db }) => db.prepare(
      "SELECT COUNT(*) AS count FROM owner_correction_injections",
    ).get().count)).toBe(0);
  });

  it("同じJST日付の手動再実行は予約済みとしてCodexを呼ばない", async () => {
    const noMergeBatch = vi.fn(async (prompt: string) => {
      const groups = JSON.parse(prompt) as Array<{ group_id: string; items: Array<{ id: number }> }>;
      return batchResult(groups.map((group) => ({
        group_id: group.group_id,
        verdict: "none",
        principle: "",
        odd_ids: group.items.map((item) => item.id),
      })));
    });
    const firstRun = await runAbstractPrinciplesJob(storage, {
      mode: "shadow",
      at,
      memoryPath,
      runId: "first-manual-run",
      promptTemplate: "{{GROUPS_JSON}}",
      runBatch: noMergeBatch,
    });
    const repeatedBatch = vi.fn(async () => batchResult([validMerge]));
    const repeatedRun = await runAbstractPrinciplesJob(storage, {
      mode: "shadow",
      at: "2026-10-03T04:30:00.000Z",
      memoryPath,
      runId: "second-manual-run",
      promptTemplate: "{{GROUPS_JSON}}",
      runBatch: repeatedBatch,
    });

    expect(firstRun).toMatchObject({ calls: 1, rejectedNone: 1 });
    expect(repeatedRun).toMatchObject({ groups: 1, calls: 0, skippedReason: "already_ran_today" });
    expect(repeatedBatch).not.toHaveBeenCalled();
    expect(storage.runCorrectionTransaction(({ db }) => db.prepare(`
      SELECT run_id, calls FROM owner_correction_abstraction_runs
    `).all())).toEqual([{
      run_id: "principle-abstraction-2026-10-03",
      calls: 1,
    }]);

    const nextJstDayBatch = vi.fn(async (prompt: string) => {
      const groups = JSON.parse(prompt) as Array<{ group_id: string; items: Array<{ id: number }> }>;
      return batchResult(groups.map((group) => ({
        group_id: group.group_id,
        verdict: "none",
        principle: "",
        odd_ids: group.items.map((item) => item.id),
      })));
    });
    const nextJstDayRun = await runAbstractPrinciplesJob(storage, {
      mode: "shadow",
      at: "2026-10-03T15:00:00.000Z",
      memoryPath,
      runId: "next-jst-day-run",
      promptTemplate: "{{GROUPS_JSON}}",
      runBatch: nextJstDayBatch,
    });
    expect(nextJstDayRun).toMatchObject({ calls: 1, rejectedNone: 1 });
    expect(nextJstDayBatch).toHaveBeenCalledTimes(1);
    expect(storage.runCorrectionTransaction(({ db }) => db.prepare(`
      SELECT run_id FROM owner_correction_abstraction_runs ORDER BY run_id
    `).all())).toEqual([
      { run_id: "principle-abstraction-2026-10-03" },
      { run_id: "principle-abstraction-2026-10-04" },
    ]);
  });

  it("並行起動はDBの日付予約を1件だけ取りCodex呼出を1回に抑える", async () => {
    const concurrentStorage = SQLiteStorage.openExistingForHook(join(memoryPath, "memory.db"), { mode: "correction" });
    let releaseFirstBatch: (() => void) | undefined;
    const firstBatch = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        releaseFirstBatch = resolve;
      });
      return batchResult([validMerge]);
    });
    const secondBatch = vi.fn(async () => batchResult([validMerge]));

    try {
      const firstRun = runAbstractPrinciplesJob(storage, {
        mode: "shadow",
        at: "2026-10-05T04:00:00.000Z",
        memoryPath,
        runId: "concurrent-first",
        promptTemplate: "{{GROUPS_JSON}}",
        runBatch: firstBatch,
      });
      expect(firstBatch).toHaveBeenCalledTimes(1);

      const secondRun = await runAbstractPrinciplesJob(concurrentStorage, {
        mode: "shadow",
        at: "2026-10-05T04:00:00.000Z",
        memoryPath,
        runId: "concurrent-second",
        promptTemplate: "{{GROUPS_JSON}}",
        runBatch: secondBatch,
      });

      expect(secondRun).toMatchObject({ calls: 0, skippedReason: "already_ran_today" });
      expect(secondBatch).not.toHaveBeenCalled();
      if (releaseFirstBatch === undefined) throw new Error("first abstraction call did not start");
      releaseFirstBatch();
      await expect(firstRun).resolves.toMatchObject({ calls: 1 });
      expect(firstBatch).toHaveBeenCalledTimes(1);
      expect(storage.runCorrectionTransaction(({ db }) => db.prepare(`
        SELECT COUNT(*) AS count FROM owner_correction_abstraction_runs
      `).get().count)).toBe(1);
    } finally {
      concurrentStorage.close();
    }
  });

  it("shadowで作った候補はon切替後の実行で新規構成員なしに確定する", async () => {
    const shadowBatch = vi.fn(async () => batchResult([validMerge]));
    await runAbstractPrinciplesJob(storage, {
      mode: "shadow",
      at,
      memoryPath,
      runId: "shadow-promotion-fixture",
      promptTemplate: "{{GROUPS_JSON}}",
      runBatch: shadowBatch,
    });
    const candidate = storage.runCorrectionTransaction(({ db }) => db.prepare(`
      SELECT bundle_key, status FROM owner_correction_bundles WHERE bundle_key LIKE 'pr:v1:%'
    `).get()) as { bundle_key: string; status: string };
    expect(candidate.status).toBe("candidate");

    process.env.WASURENAGUSA_PRINCIPLES = "on";
    const childEnv = {
      ...process.env,
      MEMORY_DIR: memoryPath,
      WASURENAGUSA_CORRECTION_LOOP: "on",
      WASURENAGUSA_PRINCIPLES: "on",
    };
    delete childEnv.WASURENAGUSA_MEMORY_PATH;
    const output = execFileSync(process.execPath, [
      "--loader",
      "ts-node/esm",
      "src/cli/abstract-principles.ts",
      "--now",
      "2026-10-03T05:00:00.000Z",
    ], {
      cwd: resolve("."),
      env: childEnv,
      encoding: "utf8",
    });
    const result = JSON.parse(output.trim());

    expect(result).toMatchObject({ groups: 0, calls: 0, adopted: 1 });
    const promoted = storage.runCorrectionTransaction(({ db }) => db.prepare(
      "SELECT status FROM owner_correction_bundles WHERE bundle_key = ?",
    ).get(candidate.bundle_key) as { status: string });
    expect(promoted.status).toBe("confirmed");
    const injection = selectCorrectionInjections(storage, {
      project: "fixture-project",
      scope: "backend",
      query: "合成記録を先に確認する",
      at: "2026-10-03T05:01:00.000Z",
      sessionIdHash: "synthetic-shadow-promotion",
      compactEpoch: 0,
      humanOrdinal: 1,
      trigger: "start",
    });
    expect(injection.rules.map((rule) => rule.bundleKey)).toContain(candidate.bundle_key);
  });

  it("取消済み原則の再提案を記録して翌夜の残りの群も処理する", async () => {
    process.env.WASURENAGUSA_PRINCIPLES = "on";
    seedRules({
      prefix: "a-principle",
      topicKey: "tone",
      conditions: "[]",
      texts: [
        "報告書は常体で書く",
        "報告書を常体で書く",
        "報告書なら常体で書く",
      ],
    });
    const cancelledPrincipleText = "報告書を常体で書く";

    const runBatch = (includeRemaining: boolean) => vi.fn(async (prompt: string) => {
      const groups = JSON.parse(prompt) as Array<{
        group_id: string;
        items: Array<{ id: number; rule_text: string }>;
      }>;
      return batchResult(groups.map((group) => {
        const isToneGroup = group.items.some((item) => item.rule_text.includes("常体"));
        if (isToneGroup) {
          return { ...validMerge, group_id: group.group_id, principle: cancelledPrincipleText };
        }
        if (!includeRemaining) {
          return {
            group_id: group.group_id,
            verdict: "none",
            principle: "",
            odd_ids: group.items.map((item) => item.id),
          };
        }
        return {
          ...validMerge,
          group_id: group.group_id,
          principle: "合成記録を先に確認します",
        };
      }));
    });

    const firstBatch = runBatch(false);
    const firstNight = await runAbstractPrinciplesJob(storage, {
      mode: "on",
      at,
      memoryPath,
      runId: "roundtrip-first-night",
      promptTemplate: "{{GROUPS_JSON}}",
      runBatch: firstBatch,
    });
    expect(firstNight).toMatchObject({ groups: 2, calls: 1, adopted: 1, rejectedNone: 1 });

    const cancelledRule = storage.runCorrectionTransaction(({ db }) => db.prepare(`
      SELECT bundle_key, version, status FROM owner_correction_bundles
      WHERE bundle_key LIKE 'pr:v1:%' AND rule_text = ?
    `).get(cancelledPrincipleText) as { bundle_key: string; version: number; status: string });
    expect(cancelledRule).toMatchObject({ version: 2, status: "confirmed" });
    storage.runCorrectionTransaction(({ db }) => db.prepare(`
      INSERT INTO owner_correction_injections (
        session_id_hash, compact_epoch, bundle_key, version, human_ordinal, trigger, emitted_at,
        output_order, body_hash, output_hash, token_estimate, body_included, stdout_status
      ) VALUES ('synthetic-compliance-session', 0, ?, ?, 1, 'prompt', '2026-10-03T04:15:00.000Z',
        1, 'synthetic-body', 'synthetic-output', 10, 1, 'emitted')
    `).run(cancelledRule.bundle_key, cancelledRule.version));
    const violations = persistCorrectionComplianceViolations(storage, {
      sessionIdHash: "synthetic-compliance-session",
      humanOrdinal: 2,
      assistantText: "確認しました。こちらも対応しました。",
      detectedAt: "2026-10-03T04:30:00.000Z",
    });
    expect(violations).toEqual([{
      bundleKey: cancelledRule.bundle_key,
      version: cancelledRule.version,
      checker: "tone",
    }]);
    const strength = runStrengthJob(storage, { mode: "on", now: "2026-10-03T04:45:00.000Z" });
    expect(strength.failureEvents).toBe(1);

    const cancellation = storage.runCorrectionTransaction((transaction) => cancelCorrectionPrinciple(transaction, {
      principleKey: cancelledRule.bundle_key,
      eventId: "event-a-principle-a",
      at: "2026-10-03T05:00:00.000Z",
    }));
    expect(cancellation?.status).toBe("rejected");

    const secondBatch = runBatch(true);
    const secondNight = await runAbstractPrinciplesJob(storage, {
      mode: "on",
      at: "2026-10-04T04:00:00.000Z",
      memoryPath,
      runId: "roundtrip-second-night",
      promptTemplate: "{{GROUPS_JSON}}",
      runBatch: secondBatch,
    });
    expect(secondBatch).toHaveBeenCalledTimes(1);
    expect(secondNight).toMatchObject({
      groups: 2,
      calls: 1,
      adopted: 1,
      rejectedGuard: 1,
      rejectedNone: 0,
      rejectionReasons: ["terminal_principle"],
    });
    const runRecord = storage.runCorrectionTransaction(({ db }) => db.prepare(`
      SELECT adopted, rejected_guard, rejected_none, groups, calls
      FROM owner_correction_abstraction_runs WHERE run_id = ?
    `).get("principle-abstraction-2026-10-04") as {
      adopted: number;
      rejected_guard: number;
      rejected_none: number;
      groups: number;
      calls: number;
    });
    expect(runRecord).toEqual({ adopted: 1, rejected_guard: 1, rejected_none: 0, groups: 2, calls: 1 });
    const principleRows = storage.runCorrectionTransaction(({ db }) => db.prepare(`
      SELECT rule_text, status FROM owner_correction_bundles
      WHERE bundle_key LIKE 'pr:v1:%' ORDER BY rule_text
    `).all() as Array<{ rule_text: string; status: string }>);
    expect(principleRows).toEqual([
      { rule_text: "合成記録を先に確認します", status: "confirmed" },
      { rule_text: cancelledPrincipleText, status: "rejected" },
    ]);
    expect(firstBatch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["none", [{ ...validMerge, verdict: "none", principle: "", odd_ids: [1, 2, 3] }], "none", 1],
    ["added content word", [{ ...validMerge, principle: "合成記録の安全性を先に確認する" }], "unsupported_term", 0],
    ["polarity reversal", [{ ...validMerge, principle: "合成記録を先に確認しない" }], "polarity_mismatch", 0],
    ["missing group", [], "missing_group", 1],
  ])("rejects %s with a reason code", async (_label, output, reason, rejectedNone) => {
    const runBatch = vi.fn(async () => batchResult(output));

    const result = await runAbstractPrinciplesJob(storage, {
      mode: "shadow",
      at,
      memoryPath,
      runId: `reject-${String(reason)}`,
      promptTemplate: "{{GROUPS_JSON}}",
      runBatch,
    });

    expect(result).toMatchObject({ adopted: 0, rejectedNone });
    expect(result.rejectionReasons).toContain(reason);
    expect(storage.runCorrectionTransaction(({ db }) => db.prepare(
      "SELECT COUNT(*) AS count FROM owner_correction_bundles WHERE bundle_key LIKE 'pr:v1:%'",
    ).get().count)).toBe(0);
  });

  it("onでは閾値を満たす原則をconfirmedにしてretrieval対象へ移す", async () => {
    process.env.WASURENAGUSA_PRINCIPLES = "on";
    const runBatch = vi.fn(async () => batchResult([validMerge]));

    const result = await runAbstractPrinciplesJob(storage, {
      mode: "on",
      at,
      memoryPath,
      runId: "on-fixture",
      promptTemplate: "{{GROUPS_JSON}}",
      runBatch,
    });

    expect(result.adopted).toBe(1);
    const principle = storage.runCorrectionTransaction(({ db }) => db.prepare(
      "SELECT bundle_key, status FROM owner_correction_bundles WHERE bundle_key LIKE 'pr:v1:%'",
    ).get());
    expect(principle.status).toBe("confirmed");
    const injection = selectCorrectionInjections(storage, {
      project: "fixture-project",
      scope: "backend",
      query: "合成記録を先に確認する",
      at: "2026-10-03T05:00:00.000Z",
      sessionIdHash: "synthetic-session-injection",
      compactEpoch: 0,
      humanOrdinal: 1,
      trigger: "start",
    });
    expect(injection.rules.map((rule) => rule.bundleKey)).toContain(principle.bundle_key);
  });

  it("offではDBを開いていてもCodexと原則保存を行わない", async () => {
    process.env.WASURENAGUSA_PRINCIPLES = "off";
    const runBatch = vi.fn();

    const result = await runAbstractPrinciplesJob(storage, {
      mode: "off",
      at,
      memoryPath,
      runId: "off-fixture",
      promptTemplate: "{{GROUPS_JSON}}",
      runBatch,
    });

    expect(result).toMatchObject({ groups: 0, calls: 0, adopted: 0 });
    expect(runBatch).not.toHaveBeenCalled();
  });

  it("全体停止または原則機能停止なら、DBを開かず理由を返す", async () => {
    process.env.WASURENAGUSA_MEMORY_PATH = join(directory, "missing-memory");
    process.env.WASURENAGUSA_PRINCIPLES = "shadow";
    process.env.WASURENAGUSA_CORRECTION_LOOP = "off";

    const globallyStopped = await runAbstractPrinciplesCli([]);
    expect(globallyStopped).toMatchObject({ mode: "shadow", calls: 0, skippedReason: "correction_loop_off" });

    process.env.WASURENAGUSA_CORRECTION_LOOP = "on";
    process.env.WASURENAGUSA_PRINCIPLES = "off";
    const featureStopped = await runAbstractPrinciplesCli([]);
    expect(featureStopped).toMatchObject({ mode: "off", calls: 0, skippedReason: "feature_off" });
  });

  it("schema v12ではv13の表を読まず安全に見送る", async () => {
    const v12MemoryPath = join(directory, "v12-store");
    const v12DbPath = join(v12MemoryPath, "memory.db");
    const initialStorage = new SQLiteStorage(v12DbPath);
    initialStorage.initialize();
    initialStorage.close();
    const migrationDb = new Database(v12DbPath);
    migrateV10ToV11(migrationDb);
    migrateV11ToV12(migrationDb);
    migrationDb.close();
    const v12Storage = new SQLiteStorage(v12DbPath);
    v12Storage.initialize();
    const runBatch = vi.fn();
    try {
      const result = await runAbstractPrinciplesJob(v12Storage, {
        mode: "shadow",
        at,
        memoryPath: v12MemoryPath,
        runId: "schema-v12-fixture",
        promptTemplate: "{{GROUPS_JSON}}",
        runBatch,
      });

      expect(result).toMatchObject({ groups: 0, calls: 0, skippedReason: "schema_unavailable" });
      expect(runBatch).not.toHaveBeenCalled();
    } finally {
      v12Storage.close();
    }
  });

  it("呼出失敗は再試行せずoperation logへ1行記録して伝播する", async () => {
    const runBatch = vi.fn(async () => {
      throw new Error("synthetic codex failure");
    });

    await expect(runAbstractPrinciplesJob(storage, {
      mode: "shadow",
      at,
      memoryPath,
      runId: "failure-fixture",
      promptTemplate: "{{GROUPS_JSON}}",
      runBatch,
    })).rejects.toThrow("synthetic codex failure");

    expect(runBatch).toHaveBeenCalledTimes(1);
    const failureLogPath = join(memoryPath, "logs", "operation-2026-10-03.jsonl");
    const failureLines = readFileSync(failureLogPath, "utf8").trim().split("\n");
    expect(failureLines).toHaveLength(1);
    expect(JSON.parse(failureLines[0])).toMatchObject({
      operation_type: "correction_abstraction",
      status: "failed",
    });
  });

  it("hook入口からCodex呼び出しモジュールへ到達しない", () => {
    const entryPaths = [resolve("src/cli/context.ts"), resolve("src/cli/analyze.ts")];
    const visited = new Set<string>();
    const pending = [...entryPaths];
    const importPattern = /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["'](\.\.?\/[^"']+)["']|import\(["'](\.\.?\/[^"']+)["']\)/gu;

    while (pending.length > 0) {
      const currentPath = pending.pop() as string;
      if (visited.has(currentPath)) continue;
      visited.add(currentPath);
      const source = readFileSync(currentPath, "utf-8");
      for (const match of source.matchAll(importPattern)) {
        const specifier = match[1] ?? match[2];
        const resolvedPath = resolve(currentPath, "..", specifier);
        const sourcePath = resolvedPath.endsWith(".js") ? resolvedPath.slice(0, -3) + ".ts" : resolvedPath;
        try {
          readFileSync(sourcePath, "utf-8");
          pending.push(sourcePath);
        } catch {
          continue;
        }
      }
    }

    expect([...visited].some((path) => path.endsWith("/corrections/codex-batch.ts"))).toBe(false);
  });
});
