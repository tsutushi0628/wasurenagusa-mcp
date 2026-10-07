import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateV11ToV12, migrateV12ToV13 } from "../storage/migration.js";
import { initializeCorrectionSchema } from "../storage/correction-schema.js";
import { SQLiteStorage } from "../storage/sqlite.js";
import { persistCorrectionComplianceViolations } from "./compliance.js";
import { serializeCorrectionRuleInput } from "./rule-template.js";
import { resolveStrengthMode, runStrengthJob } from "./strength.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const START_MS = Date.parse("2026-01-01T00:00:00.000Z");

describe("correction strength job", () => {
  let tempDir: string;
  let storage: SQLiteStorage;

  it("STRENGTHの不正値はoffに倒して変数名と値をstderrへ出す", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(resolveStrengthMode("invalid-strength")).toBe("off");
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("WASURENAGUSA_STRENGTH"));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("invalid-strength"));
    } finally {
      errorSpy.mockRestore();
    }
  });

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "correction-strength-"));
    const dbPath = join(tempDir, "memory.db");
    const initialStorage = new SQLiteStorage(dbPath);
    initialStorage.initialize();
    initialStorage.close();

    const migrationDb = new Database(dbPath);
    initializeCorrectionSchema(migrationDb);
    migrateV11ToV12(migrationDb);
    migrateV12ToV13(migrationDb);
    migrationDb.close();

    storage = new SQLiteStorage(dbPath);
  });

  afterEach(() => {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function at(day: number): string {
    return new Date(START_MS + day * DAY_MS).toISOString();
  }

  function toneRuleConditions(): string {
    return serializeCorrectionRuleInput({
      version: 2,
      topicKey: "tone",
      actionKey: "use_casual",
      polarity: "positive",
      requiredValues: { audience: "owner", style: "常体" },
      conditions: [],
      boundaryKey: "general",
      lifetimeKind: "inferred",
      continuationBasis: "synthetic-fixture",
      directive: true,
      plainCommandEligible: false,
      question: false,
      toneException: false,
      conditionKnown: true,
    });
  }

  function setToneRule(bundleKey: string): void {
    storage.runCorrectionTransaction(({ db }) => {
      db.prepare("UPDATE owner_correction_bundles SET topic_key = 'tone', rule_text = '回答は常体で書く', polarity = 'positive', condition_key = 'general' WHERE bundle_key = ?").run(bundleKey);
      db.prepare("UPDATE owner_correction_versions SET rule_text = '回答は常体で書く', conditions = ?, condition_key = 'general', polarity = 'positive' WHERE bundle_key = ? AND version = 1").run(toneRuleConditions(), bundleKey);
    });
  }

  function addToneSession(
    bundleKey: string,
    sessionHash: string,
    day: number,
    assistantText: string,
  ): ReturnType<typeof persistCorrectionComplianceViolations> {
    const observedAt = at(day);
    addInjection(bundleKey, sessionHash, 1, observedAt);
    addEvent(`tone-response-${sessionHash}`, sessionHash, 1, observedAt, "action_unknown", "常体の文体を確認する");
    return persistCorrectionComplianceViolations(storage, {
      sessionIdHash: sessionHash,
      humanOrdinal: 1,
      assistantText,
      detectedAt: observedAt,
    });
  }

  function seedBundle(bundleKey: string, intensity: number, firstSeenAt = at(0), withMemory = false): void {
    let memoryId: string | null = null;
    if (withMemory) {
      memoryId = storage.save({
        category: "dont",
        title: `owner-correction:${bundleKey}`,
        content: "合成規則",
        project: "fixture-project",
        scope: "backend",
        intensity,
      }).id;
    }
    storage.runCorrectionTransaction(({ db }) => {
      db.prepare(`
        INSERT INTO owner_correction_bundles (
          bundle_key, memory_id, rule_text, topic_key, polarity, condition_key, project, scope,
          visibility, status, intensity, occurrence_count, session_count, first_seen_at, last_seen_at,
          expires_at, lifetime_kind, continuation_basis, confirmed_at, version,
          counterevidence_event_id, last_confirmation_asked_at, confirmation_state
        ) VALUES (?, ?, '合成規則', 'verification', 'positive', 'synthetic', 'fixture-project',
          'backend', 'owner', 'confirmed', ?, 1, 1, ?, ?, NULL, 'inferred', 'inferred-repeat', ?,
          1, NULL, NULL, 'none')
      `).run(bundleKey, memoryId, intensity, firstSeenAt, firstSeenAt, firstSeenAt);
      db.prepare(`
        INSERT INTO owner_correction_versions (
          bundle_key, version, rule_text, body_hash, conditions, condition_key, polarity, visibility,
          status, confirmed_at, expires_at, lifetime_kind, continuation_basis, evidence_event_ids,
          effective_from, change_reason
        ) VALUES (?, 1, '合成規則', 'body-hash', '{}', 'synthetic', 'positive', 'owner',
          'confirmed', ?, NULL, 'inferred', 'inferred-repeat', '[]', ?, 'fixture')
      `).run(bundleKey, firstSeenAt, firstSeenAt);
    });
  }

  function addEvent(
    eventId: string,
    sessionHash: string,
    humanOrdinal: number,
    observedAt: string,
    previousAction = "action_unknown",
    excerpt = "合成発話",
  ): void {
    storage.runCorrectionTransaction(({ db }) => {
      db.prepare(`
        INSERT INTO owner_correction_events (
          event_id, session_id_hash, source_uuid_hash, human_ordinal, observed_at, available_at,
          source_kind, excerpt, previous_action, action_first_locator_hash, action_last_locator_hash,
          project, scope, raw_text_hash, source_locator_hash, processed_at
        ) VALUES (?, ?, NULL, ?, ?, ?, 'user', ?, ?, NULL, NULL,
          'fixture-project', 'backend', 'raw-hash', ?, ?)
      `).run(eventId, sessionHash, humanOrdinal, observedAt, observedAt, excerpt, previousAction, `locator-${eventId}`, observedAt);
    });
  }

  function addEvidence(bundleKey: string, eventId: string, sessionHash: string, humanOrdinal: number, observedAt: string): void {
    addEvent(eventId, sessionHash, humanOrdinal, observedAt);
    storage.runCorrectionTransaction(({ db }) => {
      db.prepare(`
        INSERT INTO owner_correction_evidence (
          event_id, bundle_key, source, score, detector_version, conditions, polarity
        ) VALUES (?, ?, 'request_repeat', 2, 'fixture-v1', '{}', 'positive')
      `).run(eventId, bundleKey);
    });
  }

  function addInjection(
    bundleKey: string,
    sessionHash: string,
    humanOrdinal: number,
    emittedAt: string,
    trigger: "start" | "prompt" = "prompt",
  ): void {
    storage.runCorrectionTransaction(({ db }) => {
      db.prepare(`
        INSERT INTO owner_correction_injections (
          session_id_hash, compact_epoch, bundle_key, version, human_ordinal, trigger, emitted_at,
          output_order, body_hash, output_hash, token_estimate, body_included, stdout_status
        ) VALUES (?, 0, ?, 1, ?, ?, ?, 0, 'body-hash', 'output-hash', 8, 1, 'emitted')
      `).run(sessionHash, bundleKey, humanOrdinal, trigger, emittedAt);
    });
  }

  function readBundleIntensity(bundleKey: string): number {
    return storage.runCorrectionTransaction(({ db }) => db.prepare(
      "SELECT intensity FROM owner_correction_bundles WHERE bundle_key = ?",
    ).get(bundleKey).intensity);
  }

  function readMemoryIntensity(bundleKey: string): number | null {
    return storage.runCorrectionTransaction(({ db }) => db.prepare(`
      SELECT memory.intensity FROM memories memory
      JOIN owner_correction_bundles bundle ON bundle.memory_id = memory.id
      WHERE bundle.bundle_key = ?
    `).get(bundleKey)?.intensity ?? null);
  }

  function readStrengthEvents(bundleKey: string): Array<{ at: string; delta: number; reason: string; basis: string }> {
    return storage.runCorrectionTransaction(({ db }) => db.prepare(`
      SELECT at, delta, reason, basis FROM owner_correction_strength_events
      WHERE bundle_key = ? ORDER BY at, reason
    `).all(bundleKey));
  }

  it("同束の新しい根拠で3日に1回だけ上げ、上限5で止める", () => {
    seedBundle("failure-bundle", 4);
    addInjection("failure-bundle", "failure-session", 1, at(1));
    addEvidence("failure-bundle", "failure-event-1", "failure-session", 2, at(1));

    runStrengthJob(storage, { now: at(1), mode: "on" });
    expect(readBundleIntensity("failure-bundle")).toBe(5);
    expect(readStrengthEvents("failure-bundle").map((event) => event.delta)).toEqual([1]);

    addEvidence("failure-bundle", "failure-event-2", "failure-session", 3, at(2));
    runStrengthJob(storage, { now: at(2), mode: "on" });
    expect(readStrengthEvents("failure-bundle")).toHaveLength(1);

    runStrengthJob(storage, { now: at(4), mode: "on" });
    expect(readStrengthEvents("failure-bundle")).toHaveLength(2);
    expect(readStrengthEvents("failure-bundle").map((event) => event.delta)).toEqual([1, 0]);
    expect(readBundleIntensity("failure-bundle")).toBe(5);
  });

  it("上限への失敗加算を溜めず、21日未使用で強度を下げる", () => {
    seedBundle("saturated-idle-bundle", 5);
    for (const day of [0, 3, 6]) {
      const sessionHash = "saturated-idle-session-" + day;
      addInjection("saturated-idle-bundle", sessionHash, 1, at(day));
      addEvidence("saturated-idle-bundle", "saturated-idle-event-" + day, sessionHash, 2, at(day));

      runStrengthJob(storage, { now: at(day), mode: "on" });
    }

    expect(readBundleIntensity("saturated-idle-bundle")).toBe(5);
    expect(
      readStrengthEvents("saturated-idle-bundle")
        .filter((event) => event.reason === "failure")
        .map((event) => event.delta),
    ).toEqual([0, 0, 0]);

    const summary = runStrengthJob(storage, { now: at(27), mode: "on" });

    expect(summary.idleEvents).toBe(1);
    expect(readBundleIntensity("saturated-idle-bundle")).toBe(4);
  });

  it("過去に上限超過した失敗補正も21日未使用で解消する", () => {
    const bundleKey = "legacy-saturated-idle-bundle";
    seedBundle(bundleKey, 5);
    storage.runCorrectionTransaction(({ db }) => {
      const insertFailure = db.prepare(
        "INSERT INTO owner_correction_strength_events (" +
        "bundle_key, at, from_intensity, to_intensity, delta, reason, basis" +
        ") VALUES (?, ?, 5, 5, 1, 'failure', ?)",
      );
      for (const day of [0, 3, 6]) {
        insertFailure.run(bundleKey, at(day), JSON.stringify({
          mode: "on",
          signal: "failure",
          signalHashes: [],
          baseIntensity: 5,
        }));
      }
      db.prepare("UPDATE owner_correction_bundles SET last_seen_at = ? WHERE bundle_key = ?")
        .run(at(6), bundleKey);
    });

    const summary = runStrengthJob(storage, { now: at(27), mode: "on" });

    expect(summary.idleEvents).toBe(1);
    expect(readBundleIntensity(bundleKey)).toBe(4);
    expect(readStrengthEvents(bundleKey).map((event) => event.delta)).toEqual([1, 1, 1, -4]);
  });

  it("注入と同じか前の human_ordinal の根拠を失敗に数えない", () => {
    seedBundle("ordinal-bundle", 2);
    addInjection("ordinal-bundle", "ordinal-session", 5, at(1));
    addEvidence("ordinal-bundle", "ordinal-event-before", "ordinal-session", 4, at(1));
    addEvidence("ordinal-bundle", "ordinal-event-equal", "ordinal-session", 5, at(1));

    runStrengthJob(storage, { now: at(2), mode: "on" });
    expect(readStrengthEvents("ordinal-bundle")).toEqual([]);

    addEvidence("ordinal-bundle", "ordinal-event-after", "ordinal-session", 6, at(2));
    runStrengthJob(storage, { now: at(2), mode: "on" });
    expect(readBundleIntensity("ordinal-bundle")).toBe(3);
  });

  it("SessionStartだけの配送は使用扱いせず、21日ごとに下げて下限1で止める", () => {
    seedBundle("idle-bundle", 2);
    addInjection("idle-bundle", "start-only-session", 0, at(20), "start");

    runStrengthJob(storage, { now: at(20), mode: "on" });
    expect(readBundleIntensity("idle-bundle")).toBe(2);
    runStrengthJob(storage, { now: at(21), mode: "on" });
    expect(readBundleIntensity("idle-bundle")).toBe(1);
    runStrengthJob(storage, { now: at(41), mode: "on" });
    expect(readStrengthEvents("idle-bundle")).toHaveLength(1);
    runStrengthJob(storage, { now: at(42), mode: "on" });
    expect(readStrengthEvents("idle-bundle")).toHaveLength(2);
    expect(readStrengthEvents("idle-bundle").map((event) => event.delta)).toEqual([-1, 0]);
    expect(readBundleIntensity("idle-bundle")).toBe(1);
  });

  it("SessionStart注入後の同session再訂正を失敗として数える", () => {
    seedBundle("start-failure-bundle", 2);
    addInjection("start-failure-bundle", "start-failure-session", 1, at(1), "start");
    addEvidence("start-failure-bundle", "start-failure-event", "start-failure-session", 2, at(1));

    const summary = runStrengthJob(storage, { now: at(1), mode: "on" });

    expect(summary.failureEvents).toBe(1);
    expect(readStrengthEvents("start-failure-bundle")).toMatchObject([
      { delta: 1, reason: "failure", basis: expect.stringContaining('"signalHashes"') },
    ]);
    expect(readBundleIntensity("start-failure-bundle")).toBe(3);
  });

  it("SessionStartだけの5 sessionをsettled扱いしない", () => {
    seedBundle("start-settled-bundle", 2);
    for (let day = 0; day < 5; day += 1) {
      addInjection("start-settled-bundle", `start-settled-session-${day}`, 0, at(day), "start");
    }

    runStrengthJob(storage, { now: at(5), mode: "on" });

    expect(readStrengthEvents("start-settled-bundle")).toEqual([]);
    expect(readBundleIntensity("start-settled-bundle")).toBe(2);
  });

  it("遵守検査が行われた直近5 session が違反なしなら settled にし、時刻から下げ時計を数える", () => {
    seedBundle("settled-bundle", 3);
    setToneRule("settled-bundle");
    const previousValue = process.env.WASURENAGUSA_CORRECTION_COMPLIANCE;
    process.env.WASURENAGUSA_CORRECTION_COMPLIANCE = "on";

    try {
      for (let day = 0; day < 5; day += 1) {
        expect(addToneSession("settled-bundle", `settled-session-${day}`, day, "常体で回答する。")).toEqual([]);
      }

      const summary = runStrengthJob(storage, { now: at(5), mode: "on" });
      expect(summary.settledEvents).toBe(1);
      expect(storage.connection.prepare(
        "SELECT COUNT(*) AS count FROM owner_correction_compliance_checks WHERE bundle_key = ? AND is_compliant = 1",
      ).get("settled-bundle")).toEqual({ count: 5 });
      expect(readBundleIntensity("settled-bundle")).toBe(3);
      expect(readStrengthEvents("settled-bundle")).toMatchObject([
        { delta: 0, reason: "manual" },
      ]);

      runStrengthJob(storage, { now: at(25), mode: "on" });
      expect(readBundleIntensity("settled-bundle")).toBe(3);
      runStrengthJob(storage, { now: at(27), mode: "on" });
      expect(readBundleIntensity("settled-bundle")).toBe(2);
    } finally {
      if (previousValue === undefined) delete process.env.WASURENAGUSA_CORRECTION_COMPLIANCE;
      else process.env.WASURENAGUSA_CORRECTION_COMPLIANCE = previousValue;
    }
  });

  it("省略記号のない短い要約は違反なしでもsettledに数えない", () => {
    const bundleKey = "short-summary-bundle";
    seedBundle(bundleKey, 3);
    storage.runCorrectionTransaction(({ db }) => {
      db.prepare("UPDATE owner_correction_bundles SET topic_key = 'document_delivery', rule_text = '文書は全文を表示する', polarity = 'positive', condition_key = 'general' WHERE bundle_key = ?").run(bundleKey);
      db.prepare("UPDATE owner_correction_versions SET rule_text = '文書は全文を表示する', conditions = '[]', condition_key = 'general', polarity = 'positive' WHERE bundle_key = ? AND version = 1").run(bundleKey);
    });
    const previousValue = process.env.WASURENAGUSA_CORRECTION_COMPLIANCE;
    process.env.WASURENAGUSA_CORRECTION_COMPLIANCE = "on";

    try {
      for (let day = 0; day < 5; day += 1) {
        const sessionHash = `short-summary-session-${day}`;
        const observedAt = at(day);
        addInjection(bundleKey, sessionHash, 1, observedAt);
        addEvent(
          `short-summary-response-${day}`,
          sessionHash,
          1,
          observedAt,
          "action_unknown",
          "文書の全文提示について確認する",
        );
        expect(persistCorrectionComplianceViolations(storage, {
          sessionIdHash: sessionHash,
          humanOrdinal: 1,
          assistantText: "要点は三つ。手続きの遅れと対応方針を簡潔にまとめた。",
          detectedAt: observedAt,
        })).toEqual([]);
      }

      expect(storage.connection.prepare(
        "SELECT is_compliant, COUNT(*) AS count FROM owner_correction_compliance_checks WHERE bundle_key = ? GROUP BY is_compliant",
      ).all(bundleKey)).toEqual([{ is_compliant: 0, count: 5 }]);
      const summary = runStrengthJob(storage, { now: at(5), mode: "on" });
      expect(summary.settledEvents).toBe(0);
      expect(readStrengthEvents(bundleKey)).toEqual([]);
    } finally {
      if (previousValue === undefined) delete process.env.WASURENAGUSA_CORRECTION_COMPLIANCE;
      else process.env.WASURENAGUSA_CORRECTION_COMPLIANCE = previousValue;
    }
  });

  it("原則も構成元の遵守検査が5 session通ったときだけsettledにする", () => {
    const principleKey = "pr:v1:synthetic-settled-principle";
    const sourceKey = "synthetic-settled-source";
    seedBundle(sourceKey, 2);
    seedBundle(principleKey, 2);
    setToneRule(sourceKey);
    storage.runCorrectionTransaction(({ db }) => {
      db.prepare("UPDATE owner_correction_bundles SET topic_key = 'principle', rule_text = '回答は常体の文体で書く', condition_key = 'general' WHERE bundle_key = ?").run(principleKey);
      db.prepare("UPDATE owner_correction_versions SET rule_text = '回答は常体の文体で書く', conditions = '[]', condition_key = 'general' WHERE bundle_key = ? AND version = 1").run(principleKey);
      db.prepare("INSERT INTO owner_correction_principle_members (principle_key, member_key, attached_at, attach_source) VALUES (?, ?, ?, 'cluster')").run(principleKey, sourceKey, at(0));
    });
    const previousValue = process.env.WASURENAGUSA_CORRECTION_COMPLIANCE;
    process.env.WASURENAGUSA_CORRECTION_COMPLIANCE = "on";

    try {
      for (let day = 0; day < 5; day += 1) {
        const sessionHash = `synthetic-settled-principle-session-${day}`;
        addInjection(principleKey, sessionHash, 1, at(day));
        addEvent(
          `synthetic-settled-principle-response-${day}`,
          sessionHash,
          1,
          at(day),
          "action_unknown",
          "回答は常体の文体で書く",
        );
        expect(persistCorrectionComplianceViolations(storage, {
          sessionIdHash: sessionHash,
          humanOrdinal: 1,
          assistantText: "常体で回答する。",
          detectedAt: at(day),
        })).toEqual([]);
      }

      expect(storage.connection.prepare(
        "SELECT COUNT(*) AS count FROM owner_correction_compliance_checks WHERE bundle_key = ? AND is_compliant = 1",
      ).get(principleKey)).toEqual({ count: 5 });
      const summary = runStrengthJob(storage, { now: at(5), mode: "on" });
      expect(summary.settledEvents).toBe(1);
    } finally {
      if (previousValue === undefined) delete process.env.WASURENAGUSA_CORRECTION_COMPLIANCE;
      else process.env.WASURENAGUSA_CORRECTION_COMPLIANCE = previousValue;
    }
  });

  it("構成元に検査器があってもoffの5 sessionをsettledに数えない", () => {
    const principleKey = "pr:v1:synthetic-compliance-off-principle";
    const sourceKey = "synthetic-compliance-off-source";
    seedBundle(sourceKey, 2);
    seedBundle(principleKey, 2);
    setToneRule(sourceKey);
    storage.runCorrectionTransaction(({ db }) => {
      db.prepare("UPDATE owner_correction_bundles SET topic_key = 'principle', rule_text = '回答は常体の文体で書く', condition_key = 'general' WHERE bundle_key = ?").run(principleKey);
      db.prepare("UPDATE owner_correction_versions SET rule_text = '回答は常体の文体で書く', conditions = '[]', condition_key = 'general' WHERE bundle_key = ? AND version = 1").run(principleKey);
      db.prepare("INSERT INTO owner_correction_principle_members (principle_key, member_key, attached_at, attach_source) VALUES (?, ?, ?, 'cluster')").run(principleKey, sourceKey, at(0));
    });
    const previousValue = process.env.WASURENAGUSA_CORRECTION_COMPLIANCE;
    process.env.WASURENAGUSA_CORRECTION_COMPLIANCE = "off";

    try {
      for (let day = 0; day < 5; day += 1) {
        const sessionHash = `compliance-off-session-${day}`;
        addInjection(principleKey, sessionHash, 1, at(day));
        addEvent(
          `compliance-off-response-${day}`,
          sessionHash,
          1,
          at(day),
          "action_unknown",
          "回答は常体の文体で書く",
        );
        expect(persistCorrectionComplianceViolations(storage, {
          sessionIdHash: sessionHash,
          humanOrdinal: 1,
          assistantText: "常体で回答する。",
          detectedAt: at(day),
        })).toEqual([]);
      }

      const summary = runStrengthJob(storage, { now: at(5), mode: "on" });
      expect(summary.settledEvents).toBe(0);
      expect(readStrengthEvents(principleKey)).toEqual([]);
      expect(storage.connection.prepare(
        "SELECT COUNT(*) AS count FROM owner_correction_compliance_checks WHERE bundle_key = ?",
      ).get(principleKey)).toEqual({ count: 0 });
    } finally {
      if (previousValue === undefined) delete process.env.WASURENAGUSA_CORRECTION_COMPLIANCE;
      else process.env.WASURENAGUSA_CORRECTION_COMPLIANCE = previousValue;
    }
  });

  it("遵守検査で1回違反した5 sessionはfailureにし、settledにしない", () => {
    seedBundle("compliance-failure-bundle", 2);
    setToneRule("compliance-failure-bundle");
    const previousValue = process.env.WASURENAGUSA_CORRECTION_COMPLIANCE;
    process.env.WASURENAGUSA_CORRECTION_COMPLIANCE = "on";

    try {
      for (let day = 0; day < 5; day += 1) {
        const assistantText = day === 0 ? "確認しました。対応します。" : "常体で回答する。";
        const violations = addToneSession(
          "compliance-failure-bundle",
          `compliance-failure-session-${day}`,
          day,
          assistantText,
        );
        expect(violations).toHaveLength(day === 0 ? 1 : 0);
      }

      const summary = runStrengthJob(storage, { now: at(5), mode: "on" });
      expect(summary.failureEvents).toBe(1);
      expect(summary.settledEvents).toBe(0);
      expect(storage.connection.prepare(
        "SELECT is_compliant, COUNT(*) AS count FROM owner_correction_compliance_checks WHERE bundle_key = ? GROUP BY is_compliant ORDER BY is_compliant",
      ).all("compliance-failure-bundle")).toEqual([
        { is_compliant: 0, count: 1 },
        { is_compliant: 1, count: 4 },
      ]);
      expect(readStrengthEvents("compliance-failure-bundle").map((event) => event.reason)).toEqual(["failure"]);
    } finally {
      if (previousValue === undefined) delete process.env.WASURENAGUSA_CORRECTION_COMPLIANCE;
      else process.env.WASURENAGUSA_CORRECTION_COMPLIANCE = previousValue;
    }
  });

  it("応答完了が記録されないprompt注入はsettledの機会に数えない", () => {
    seedBundle("unanswered-prompt-bundle", 2);
    for (let day = 0; day < 5; day += 1) {
      addInjection("unanswered-prompt-bundle", `unanswered-session-${day}`, 1, at(day));
    }

    runStrengthJob(storage, { now: at(5), mode: "on" });

    expect(readStrengthEvents("unanswered-prompt-bundle")).toEqual([]);
    expect(readBundleIntensity("unanswered-prompt-bundle")).toBe(2);
  });

  it("topicに当たらない発話はsettledの機会に数えない", () => {
    seedBundle("unrelated-prompt-bundle", 2);
    for (let day = 0; day < 5; day += 1) {
      const sessionHash = `unrelated-session-${day}`;
      addInjection("unrelated-prompt-bundle", sessionHash, 1, at(day));
      addEvent(`unrelated-response-${day}`, sessionHash, 1, at(day), "action_unknown", "天気の話をする");
    }

    runStrengthJob(storage, { now: at(5), mode: "on" });

    expect(readStrengthEvents("unrelated-prompt-bundle")).toEqual([]);
    expect(readBundleIntensity("unrelated-prompt-bundle")).toBe(2);
  });

  it("SessionStart・refresh・compact注入はsettledの機会に数えない", () => {
    seedBundle("non-prompt-bundle", 2);
    const triggers = ["start", "refresh", "compact", "refresh", "start"] as const;
    for (let day = 0; day < triggers.length; day += 1) {
      const sessionHash = `non-prompt-session-${day}`;
      addInjection("non-prompt-bundle", sessionHash, 1, at(day), triggers[day]);
      addEvent(`non-prompt-response-${day}`, sessionHash, 1, at(day), "action_unknown", "検証の手順を確認する");
    }

    runStrengthJob(storage, { now: at(5), mode: "on" });

    expect(readStrengthEvents("non-prompt-bundle")).toEqual([]);
    expect(readBundleIntensity("non-prompt-bundle")).toBe(2);
  });

  it("構成元への再訂正と違反を含む失敗を原則にも記録する", () => {
    const principleKey = "pr:v1:synthetic-principle";
    seedBundle("principle-member-bundle", 2);
    seedBundle(principleKey, 2);
    storage.runCorrectionTransaction(({ db }) => {
      db.prepare(`
        INSERT INTO owner_correction_principle_members (
          principle_key, member_key, attached_at, attach_source
        ) VALUES (?, ?, ?, 'cluster')
      `).run(principleKey, "principle-member-bundle", at(0));
    });
    addInjection("principle-member-bundle", "principle-failure-session", 1, at(1));
    addEvidence("principle-member-bundle", "principle-failure-event", "principle-failure-session", 2, at(1));
    storage.runCorrectionTransaction(({ db }) => {
      db.prepare(`
        INSERT INTO owner_correction_violations (
          session_id_hash, human_ordinal, bundle_key, version, checker, detected_at
        ) VALUES ('principle-failure-session', 3, 'principle-member-bundle', 1, 'tone', ?)
      `).run(at(1));
    });

    runStrengthJob(storage, { now: at(2), mode: "on" });

    expect(readBundleIntensity("principle-member-bundle")).toBe(3);
    expect(readBundleIntensity(principleKey)).toBe(3);
    expect(readStrengthEvents(principleKey)).toMatchObject([
      { delta: 1, reason: "failure", basis: expect.stringContaining('"signalHashes"') },
    ]);
    const principleBasis = JSON.parse(readStrengthEvents(principleKey)[0].basis);
    expect(principleBasis.signalHashes).toHaveLength(2);
  });

  it("構成元のtopic検査違反を注入済み原則のfailureへ戻す", () => {
    const principleKey = "pr:v1:synthetic-compliance-principle";
    const sourceKey = "synthetic-compliance-source";
    seedBundle(sourceKey, 2);
    seedBundle(principleKey, 2);
    storage.runCorrectionTransaction(({ db }) => {
      db.prepare("UPDATE owner_correction_bundles SET topic_key = 'tone', rule_text = '回答は常体で書く', condition_key = 'general' WHERE bundle_key = ?").run(sourceKey);
      db.prepare("UPDATE owner_correction_versions SET rule_text = '回答は常体で書く', conditions = ?, condition_key = 'general' WHERE bundle_key = ? AND version = 1").run(toneRuleConditions(), sourceKey);
      db.prepare("UPDATE owner_correction_bundles SET topic_key = 'principle', rule_text = '同じ書き方を続ける' WHERE bundle_key = ?").run(principleKey);
      db.prepare("UPDATE owner_correction_versions SET rule_text = '同じ書き方を続ける', conditions = '[]' WHERE bundle_key = ? AND version = 1").run(principleKey);
      db.prepare("INSERT INTO owner_correction_principle_members (principle_key, member_key, attached_at, attach_source) VALUES (?, ?, ?, 'cluster')").run(principleKey, sourceKey, at(0));
    });
    const sessionHash = "synthetic-principle-compliance-session";
    addInjection(principleKey, sessionHash, 1, at(1));
    addEvent("synthetic-principle-compliance-response", sessionHash, 2, at(1));
    const previousValue = process.env.WASURENAGUSA_CORRECTION_COMPLIANCE;
    process.env.WASURENAGUSA_CORRECTION_COMPLIANCE = "on";

    try {
      expect(persistCorrectionComplianceViolations(storage, {
        sessionIdHash: sessionHash,
        humanOrdinal: 2,
        assistantText: "確認しました。対応します。",
        detectedAt: at(1),
      })).toEqual([{
        bundleKey: principleKey,
        version: 1,
        checker: "tone",
      }]);

      const summary = runStrengthJob(storage, { now: at(2), mode: "on" });

      expect(summary.failureEvents).toBe(1);
      expect(readBundleIntensity(principleKey)).toBe(3);
      expect(readBundleIntensity(sourceKey)).toBe(2);
      expect(readStrengthEvents(principleKey)).toMatchObject([
        { delta: 1, reason: "failure", basis: expect.stringContaining('"signalHashes"') },
      ]);
    } finally {
      if (previousValue === undefined) delete process.env.WASURENAGUSA_CORRECTION_COMPLIANCE;
      else process.env.WASURENAGUSA_CORRECTION_COMPLIANCE = previousValue;
    }
  });

  it("検査器のない構成元だけの原則をsettledにしない", () => {
    const principleKey = "pr:v1:synthetic-unchecked-principle";
    const sourceKey = "synthetic-unchecked-source";
    seedBundle(sourceKey, 2);
    seedBundle(principleKey, 2);
    storage.runCorrectionTransaction(({ db }) => {
      db.prepare("UPDATE owner_correction_bundles SET topic_key = 'principle', rule_text = '検証の手順を確認する' WHERE bundle_key = ?").run(principleKey);
      db.prepare("UPDATE owner_correction_versions SET rule_text = '検証の手順を確認する', conditions = '[]' WHERE bundle_key = ? AND version = 1").run(principleKey);
      db.prepare("INSERT INTO owner_correction_principle_members (principle_key, member_key, attached_at, attach_source) VALUES (?, ?, ?, 'cluster')").run(principleKey, sourceKey, at(0));
    });
    for (let day = 0; day < 5; day += 1) {
      const sessionHash = "synthetic-unchecked-session-" + day;
      addInjection(principleKey, sessionHash, 1, at(day));
      addEvent("synthetic-unchecked-response-" + day, sessionHash, 1, at(day), "action_unknown", "検証の手順を確認する");
    }

    const summary = runStrengthJob(storage, { now: at(5), mode: "on" });

    expect(summary.settledEvents).toBe(0);
    expect(readStrengthEvents(principleKey)).not.toContainEqual(expect.objectContaining({ reason: "manual" }));
  });

  it("schema 12ではversion 13強度表を参照せず安全に終了する", () => {
    seedBundle("schema-12-bundle", 2);
    storage.runCorrectionTransaction(({ db }) => {
      db.prepare("DROP TABLE owner_correction_abstraction_runs").run();
      db.prepare("DROP TABLE owner_correction_graduations").run();
      db.prepare("DROP TABLE owner_correction_compliance_checks").run();
      db.prepare("DROP TABLE owner_correction_strength_events").run();
      db.prepare("DROP TABLE owner_correction_principle_members").run();
      db.prepare("DELETE FROM schema_version WHERE version > ?").run(12);
    });

    expect(runStrengthJob(storage, { now: at(1), mode: "on" })).toEqual({
      mode: "on",
      bundlesExamined: 0,
      eventsRecorded: 0,
      intensityChanges: 0,
      failureEvents: 0,
      settledEvents: 0,
      idleEvents: 0,
    });
    expect(readBundleIntensity("schema-12-bundle")).toBe(2);
  });

  it("shadowは提案根拠を記録して強度を変えず、onで実反映できる", () => {
    seedBundle("shadow-bundle", 2, at(0), true);
    addInjection("shadow-bundle", "shadow-session", 1, at(1));
    addEvidence("shadow-bundle", "shadow-event", "shadow-session", 2, at(1));

    runStrengthJob(storage, { now: at(1), mode: "shadow" });
    expect(readBundleIntensity("shadow-bundle")).toBe(2);
    expect(readMemoryIntensity("shadow-bundle")).toBe(2);
    expect(readStrengthEvents("shadow-bundle")).toMatchObject([
      { delta: 0, reason: "failure", basis: expect.stringContaining('"proposedDelta":1') },
    ]);

    runStrengthJob(storage, { now: at(1), mode: "on" });
    expect(readBundleIntensity("shadow-bundle")).toBe(3);
    expect(readMemoryIntensity("shadow-bundle")).toBe(3);
  });

  it("違反行も守られなかった信号として記録する", () => {
    seedBundle("violation-bundle", 2);
    addInjection("violation-bundle", "violation-session", 1, at(1));
    storage.runCorrectionTransaction(({ db }) => {
      db.prepare(`
        INSERT INTO owner_correction_violations (
          session_id_hash, human_ordinal, bundle_key, version, checker, detected_at
        ) VALUES ('violation-session', 1, 'violation-bundle', 1, 'tone', ?)
      `).run(at(1));
    });

    runStrengthJob(storage, { now: at(1), mode: "on" });
    expect(readBundleIntensity("violation-bundle")).toBe(3);
  });
});
