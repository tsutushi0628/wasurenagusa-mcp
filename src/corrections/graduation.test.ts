import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeCorrectionSchema } from "../storage/correction-schema.js";
import { migrateV11ToV12, migrateV12ToV13 } from "../storage/migration.js";
import { SQLiteStorage } from "../storage/sqlite.js";
import { persistCorrectionComplianceViolations } from "./compliance.js";
import {
  createCorrectionGraduationProposal,
  recordSuccessfulCorrectionGraduationImport,
  resolveGraduationMode,
} from "./graduation.js";
import { addCorrectionPrincipleMembers, confirmCorrectionPrinciple, createCorrectionPrinciple } from "./principles.js";
import { runStrengthJob } from "./strength.js";

// 秘密値らしき合成文字列。コミット時の秘密値検査に実値と誤認されないよう実行時に組み立てる。
const SYNTHETIC_SECRET_LIKE = ["sk", "abcdefghijklmnopqrstuvwx"].join("-");

interface BundleInput {
  bundleKey: string;
  topicKey: string;
  lifetimeKind: "explicit_continuing" | "inferred" | "task" | "routing";
  confirmedAt: string;
  requiredValues?: Record<string, string>;
  conditionsJson?: string;
  ruleText?: string;
  status?: "candidate" | "confirmed";
}

describe("owner correction graduation", () => {
  let tempDir: string;
  let dbPath: string;
  let storage: SQLiteStorage;
  let previousGraduationMode: string | undefined;
  let previousComplianceMode: string | undefined;
  let previousPrinciplesMode: string | undefined;

  it("GRADUATIONの不正値はoffに倒して変数名と値をstderrへ出す", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(resolveGraduationMode("invalid-graduation")).toBe("off");
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("WASURENAGUSA_GRADUATION"));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("invalid-graduation"));
    } finally {
      errorSpy.mockRestore();
    }
  });

  beforeEach(() => {
    previousGraduationMode = process.env.WASURENAGUSA_GRADUATION;
    previousComplianceMode = process.env.WASURENAGUSA_CORRECTION_COMPLIANCE;
    previousPrinciplesMode = process.env.WASURENAGUSA_PRINCIPLES;
    process.env.WASURENAGUSA_GRADUATION = "on";
    process.env.WASURENAGUSA_CORRECTION_COMPLIANCE = "on";
    process.env.WASURENAGUSA_PRINCIPLES = "on";
    tempDir = mkdtempSync(join(tmpdir(), "correction-graduation-"));
    dbPath = join(tempDir, "memory.db");
    const initialStorage = new SQLiteStorage(dbPath);
    initialStorage.initialize();
    initialStorage.close();
    const db = new Database(dbPath);
    initializeCorrectionSchema(db);
    migrateV11ToV12(db);
    migrateV12ToV13(db);
    db.close();
    storage = new SQLiteStorage(dbPath);
    storage.initialize();
  });

  afterEach(() => {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
    if (previousGraduationMode === undefined) delete process.env.WASURENAGUSA_GRADUATION;
    else process.env.WASURENAGUSA_GRADUATION = previousGraduationMode;
    if (previousComplianceMode === undefined) delete process.env.WASURENAGUSA_CORRECTION_COMPLIANCE;
    else process.env.WASURENAGUSA_CORRECTION_COMPLIANCE = previousComplianceMode;
    if (previousPrinciplesMode === undefined) delete process.env.WASURENAGUSA_PRINCIPLES;
    else process.env.WASURENAGUSA_PRINCIPLES = previousPrinciplesMode;
  });

  function addBundle(input: BundleInput): void {
    const confirmedAt = input.confirmedAt;
    const ruleText = input.ruleText === undefined ? "合成規則を検証する" : input.ruleText;
    const requiredValues = input.requiredValues === undefined ? {} : input.requiredValues;
    let conditions = input.conditionsJson;
    if (conditions === undefined) {
      conditions = JSON.stringify({
        version: 2,
        topicKey: input.topicKey,
        actionKey: "synthetic_action",
        polarity: "negative",
        requiredValues,
        conditions: [],
        boundaryKey: "general",
        lifetimeKind: input.lifetimeKind,
        continuationBasis: "synthetic-continuation",
        directive: true,
        plainCommandEligible: true,
        question: false,
        toneException: false,
        conditionKnown: true,
      });
    }
    storage.runCorrectionTransaction(({ db, save }) => {
      const status = input.status === undefined ? "confirmed" : input.status;
      let memoryId: string | null = null;
      if (status === "confirmed") {
        const memory = save({
          category: "dont",
          title: `Synthetic ${input.bundleKey}`,
          content: ruleText,
          tags: ["synthetic"],
          project: "owner",
          scope: "owner",
          intensity: 3,
        });
        memoryId = memory.id;
      }
      const confirmedAt = status === "confirmed" ? input.confirmedAt : null;
      db.prepare(`
        INSERT INTO owner_correction_bundles (
          bundle_key, memory_id, rule_text, topic_key, polarity, condition_key, project, scope,
          visibility, status, intensity, occurrence_count, session_count, first_seen_at, last_seen_at,
          expires_at, lifetime_kind, continuation_basis, confirmed_at, version, counterevidence_event_id,
          last_confirmation_asked_at, confirmation_state
        ) VALUES (?, ?, ?, ?, 'negative', 'general', 'owner', 'owner', 'owner', ?, 3,
          5, 5, ?, ?, NULL, ?, 'synthetic-continuation', ?, 1, NULL, NULL, 'none')
      `).run(
        input.bundleKey,
        memoryId,
        ruleText,
        input.topicKey,
        status,
        input.confirmedAt,
        input.confirmedAt,
        input.lifetimeKind,
        confirmedAt,
      );
      db.prepare(`
        INSERT INTO owner_correction_versions (
          bundle_key, version, rule_text, body_hash, conditions, condition_key, polarity, visibility,
          status, confirmed_at, expires_at, lifetime_kind, continuation_basis, evidence_event_ids,
          effective_from, change_reason
        ) VALUES (?, 1, ?, 'synthetic-hash', ?, 'general', 'negative', 'owner', ?, ?, NULL,
          ?, 'synthetic-continuation', '[]', ?, 'synthetic-fixture')
      `).run(input.bundleKey, ruleText, conditions, status, confirmedAt, input.lifetimeKind, input.confirmedAt);
      if (status === "confirmed") {
        const eventId = `synthetic-bundle-evidence-${input.bundleKey}`;
        const observedAt = input.confirmedAt;
        db.prepare(`
          INSERT INTO owner_correction_events (
            event_id, session_id_hash, source_uuid_hash, human_ordinal, observed_at, available_at,
            source_kind, excerpt, previous_action, action_first_locator_hash, action_last_locator_hash,
            project, scope, raw_text_hash, source_locator_hash, processed_at
          ) VALUES (?, ?, NULL, 1, ?, ?, 'user', '合成束根拠', 'action_unknown', NULL, NULL,
            'owner', 'owner', ?, ?, ?)
        `).run(eventId, `synthetic-bundle-session-${input.bundleKey}`, observedAt, observedAt,
          `synthetic-bundle-raw-${input.bundleKey}`, `synthetic-bundle-locator-${input.bundleKey}`, observedAt);
        db.prepare(`
          INSERT INTO owner_correction_evidence (
            event_id, bundle_key, source, score, detector_version, conditions, polarity
          ) VALUES (?, ?, 'request_repeat', 2, 'fixture-v1', '[]', 'negative')
        `).run(eventId, input.bundleKey);
      }
    });
  }

  function addCandidateEvidence(memberKey: string, eventId: string, sessionHash: string, observedAt: string): void {
    storage.runCorrectionTransaction(({ db }) => {
      db.prepare(`
        INSERT INTO owner_correction_events (
          event_id, session_id_hash, source_uuid_hash, human_ordinal, observed_at, available_at,
          source_kind, excerpt, previous_action, action_first_locator_hash, action_last_locator_hash,
          project, scope, raw_text_hash, source_locator_hash, processed_at
        ) VALUES (?, ?, NULL, 1, ?, ?, 'user', '合成候補根拠', 'action_unknown', NULL, NULL,
          'owner', 'owner', ?, ?, ?)
      `).run(eventId, sessionHash, observedAt, observedAt, `synthetic-raw-${eventId}`, `synthetic-locator-${eventId}`, observedAt);
      db.prepare(`
        INSERT INTO owner_correction_evidence (
          event_id, bundle_key, source, score, detector_version, conditions, polarity
        ) VALUES (?, ?, 'request_repeat', 2, 'fixture-v1', '[]', 'negative')
      `).run(eventId, memberKey);
    });
  }

  function addCandidatePrinciple(memberKey: string, candidateAt: string): string {
    const principleRuleText = "合成原則を適用して検証する";
    addBundle({
      bundleKey: memberKey,
      topicKey: "expression_policy",
      lifetimeKind: "inferred",
      confirmedAt: candidateAt,
      conditionsJson: "[]",
      ruleText: "工程略号を使わない合成規則",
      status: "candidate",
    });
    addCandidateEvidence(memberKey, `synthetic-candidate-event-${memberKey}-one`, `synthetic-candidate-session-${memberKey}-one`, candidateAt);
    addCandidateEvidence(
      memberKey,
      `synthetic-candidate-event-${memberKey}-two`,
      `synthetic-candidate-session-${memberKey}-two`,
      new Date(Date.parse(candidateAt) + 1_000).toISOString(),
    );
    const creation = storage.runCorrectionTransaction((transaction) => createCorrectionPrinciple(transaction, {
      ruleText: principleRuleText,
      polarity: "negative",
      at: new Date(Date.parse(candidateAt) + 2_000).toISOString(),
    }));
    if (creation.status !== "ready") throw new Error("synthetic principle was not created");
    const principleKey = creation.principleKey;
    storage.runCorrectionTransaction((transaction) => addCorrectionPrincipleMembers(transaction, {
      principleKey,
      memberBundleKeys: [memberKey],
      attachedAt: new Date(Date.parse(candidateAt) + 2_000).toISOString(),
      attachSource: "cluster",
    }));
    const confirmed = storage.runCorrectionTransaction((transaction) => confirmCorrectionPrinciple(transaction, {
      principleKey,
      at: new Date(Date.parse(candidateAt) + 3_000).toISOString(),
    }));
    if (confirmed?.status !== "confirmed") throw new Error("synthetic candidate did not confirm its principle");
    return principleKey;
  }

  function addComplianceOpportunity(
    principleKey: string,
    sessionNumber: number,
    emittedAt: string,
    assistantText: string,
  ): number {
    const sessionHash = `synthetic-h1-session-${sessionNumber}`;
    storage.runCorrectionTransaction(({ db }) => {
      db.prepare(`
        INSERT INTO owner_correction_events (
          event_id, session_id_hash, source_uuid_hash, human_ordinal, observed_at, available_at,
          source_kind, excerpt, previous_action, action_first_locator_hash, action_last_locator_hash,
          project, scope, raw_text_hash, source_locator_hash, processed_at
        ) VALUES (?, ?, NULL, 1, ?, ?, 'user', '合成原則を適用して検証する', 'action_unknown',
          NULL, NULL, 'owner', 'owner', ?, ?, ?)
      `).run(
        `synthetic-h1-event-${sessionNumber}`,
        sessionHash,
        emittedAt,
        emittedAt,
        `synthetic-h1-raw-${sessionNumber}`,
        `synthetic-h1-locator-${sessionNumber}`,
        emittedAt,
      );
      db.prepare(`
        INSERT INTO owner_correction_injections (
          session_id_hash, compact_epoch, bundle_key, version, human_ordinal, trigger, emitted_at,
          output_order, body_hash, output_hash, token_estimate, body_included, stdout_status
        ) VALUES (?, 0, ?, ?, 1, 'prompt', ?, 1, 'synthetic-body', 'synthetic-output', 10, 1, 'emitted')
      `).run(
        sessionHash,
        principleKey,
        (db.prepare("SELECT version FROM owner_correction_bundles WHERE bundle_key = ?").get(principleKey) as { version: number }).version,
        emittedAt,
      );
    });
    const violations = persistCorrectionComplianceViolations(storage, {
      sessionIdHash: sessionHash,
      humanOrdinal: 1,
      assistantText,
      detectedAt: new Date(Date.parse(emittedAt) + 60_000).toISOString(),
    });
    return violations.length;
  }

  function addSettledEvent(bundleKey: string, at: string): void {
    storage.runCorrectionTransaction(({ db }) => {
      db.prepare(`
        INSERT INTO owner_correction_strength_events (
          bundle_key, at, from_intensity, to_intensity, delta, reason, basis
        ) VALUES (?, ?, 3, 3, 0, 'manual', ?)
      `).run(bundleKey, at, JSON.stringify({
        mode: "on",
        signal: "settled",
        proposedDelta: 0,
        injectionSetHash: "synthetic-injection-set",
        sessionCount: 5,
        dayCount: 3,
      }));
    });
  }

  function addNewEvidence(bundleKey: string, at: string): void {
    storage.runCorrectionTransaction(({ db }) => {
      const eventId = `synthetic-event-${bundleKey}`;
      db.prepare(`
        INSERT INTO owner_correction_events (
          event_id, session_id_hash, source_uuid_hash, human_ordinal, observed_at, available_at,
          source_kind, excerpt, previous_action, action_first_locator_hash, action_last_locator_hash,
          project, scope, raw_text_hash, source_locator_hash, processed_at
        ) VALUES (?, 'synthetic-session', NULL, 1, ?, ?, 'user', '合成根拠', 'action_unknown',
          NULL, NULL, 'owner', 'owner', 'synthetic-raw-hash', 'synthetic-locator-hash', ?)
      `).run(eventId, at, at, at);
      db.prepare(`
        INSERT INTO owner_correction_evidence (
          event_id, bundle_key, source, score, detector_version, conditions, polarity
        ) VALUES (?, ?, 'request_repeat', 2, 'fixture-v1', '[]', 'negative')
      `).run(eventId, bundleKey);
    });
  }

  it("topic=principleとconditions=[]の原則を構成員topicから全役向けscene提案にする", () => {
    const confirmedAt = "2026-09-28T00:00:00.000Z";
    const principleKey = `pr:v1:${"a".repeat(64)}`;
    const memberKey = `oc:v2:${"b".repeat(64)}`;
    addBundle({
      bundleKey: principleKey,
      topicKey: "principle",
      lifetimeKind: "inferred",
      confirmedAt,
      conditionsJson: "[]",
      ruleText: "合成原則をどの役割でも適用する",
    });
    addBundle({
      bundleKey: memberKey,
      topicKey: "expression_policy",
      lifetimeKind: "inferred",
      confirmedAt,
      conditionsJson: "[]",
      ruleText: "合成原則では工程略号を使わない",
    });
    storage.runCorrectionTransaction(({ db }) => {
      db.prepare(`
        INSERT INTO owner_correction_principle_members (
          principle_key, member_key, attached_at, attach_source
        ) VALUES (?, ?, ?, 'cluster')
      `).run(principleKey, memberKey, confirmedAt);
    });
    addSettledEvent(principleKey, "2026-10-01T00:00:00.000Z");

    const proposal = createCorrectionGraduationProposal(storage, {
      at: "2026-10-07T00:00:00.000Z",
      sourceHead: "e".repeat(40),
    });
    const entry = proposal?.principles.find((principle) => principle.principle_key === principleKey);

    expect(entry).toMatchObject({
      topic_key: "principle",
      delivery: "scene",
      triggers: expect.arrayContaining(["工程略号"]),
    });
    expect(entry?.types).toEqual(Array.from({ length: 38 }, (_value, index) => `a${String(index + 1).padStart(2, "0")}`));
  });

  it("規則文から引き金語を順序どおり抽出し、一般語だけならtopic固定語に戻す", () => {
    const confirmedAt = "2026-10-01T00:00:00.000Z";
    const codexRuleKey = `oc:v2:${"1".repeat(64)}`;
    const genericRuleKey = `oc:v2:${"2".repeat(64)}`;
    const longRuleKey = `oc:v2:${"3".repeat(64)}`;
    addBundle({
      bundleKey: codexRuleKey,
      topicKey: "verification",
      lifetimeKind: "inferred",
      confirmedAt,
      ruleText: "Codexの枠を毎回確認する仕組みはいいんだが、まいかい出力するな。",
    });
    addBundle({
      bundleKey: genericRuleKey,
      topicKey: "verification",
      lifetimeKind: "inferred",
      confirmedAt,
      ruleText: "毎回出力確認する仕組みで応答し回答を使用する作業が必要な場合",
    });
    addBundle({
      bundleKey: longRuleKey,
      topicKey: "unknown",
      lifetimeKind: "inferred",
      confirmedAt,
      ruleText: "alpha テスト 漢字 beta gamma delta epsilon zeta eta theta iota",
    });

    const proposal = createCorrectionGraduationProposal(storage, {
      at: "2026-10-08T00:00:00.000Z",
      sourceHead: "a".repeat(40),
    });
    const findTriggers = (bundleKey: string): string[] | undefined =>
      proposal?.principles.find((entry) => entry.principle_key === bundleKey)?.triggers;

    expect(findTriggers(codexRuleKey)).toEqual(["Codex"]);
    expect(findTriggers(genericRuleKey)).toEqual(["出典", "原本", "検証", "確認"]);
    expect(findTriggers(longRuleKey)).toEqual(["alpha", "テスト", "漢字", "beta", "gamma", "delta", "epsilon", "zeta"]);
  });

  it("検査器のない構成元だけの原則は既存のsettled記録があっても卒業させない", () => {
    const confirmedAt = "2026-09-28T00:00:00.000Z";
    const principleKey = `pr:v1:${"c".repeat(64)}`;
    const memberKey = `oc:v2:${"d".repeat(64)}`;
    addBundle({
      bundleKey: principleKey,
      topicKey: "principle",
      lifetimeKind: "inferred",
      confirmedAt,
      conditionsJson: "[]",
      ruleText: "検証の手順を確認する",
    });
    addBundle({
      bundleKey: memberKey,
      topicKey: "verification",
      lifetimeKind: "inferred",
      confirmedAt,
      conditionsJson: "[]",
      ruleText: "検証の手順を確認する",
    });
    storage.runCorrectionTransaction(({ db }) => {
      db.prepare("INSERT INTO owner_correction_principle_members (principle_key, member_key, attached_at, attach_source) VALUES (?, ?, ?, 'cluster')").run(principleKey, memberKey, confirmedAt);
    });
    addSettledEvent(principleKey, "2026-10-01T00:00:00.000Z");

    const proposal = createCorrectionGraduationProposal(storage, {
      at: "2026-10-07T00:00:00.000Z",
      sourceHead: "f".repeat(40),
    });

    expect(proposal?.principles.map((principle) => principle.principle_key)).not.toContain(principleKey);
  });

  it("候補の構成元を持つ原則は5session・3日でH1に守られた実績があれば卒業する", () => {
    const confirmedAt = "2026-09-20T00:00:00.000Z";
    const memberKey = `oc:v2:${"b".repeat(64)}`;
    const principleKey = addCandidatePrinciple(memberKey, confirmedAt);

    const opportunityTimes = [
      "2026-10-01T09:00:00.000Z",
      "2026-10-02T09:00:00.000Z",
      "2026-10-03T09:00:00.000Z",
      "2026-10-03T10:00:00.000Z",
      "2026-10-03T11:00:00.000Z",
    ];
    for (const [index, emittedAt] of opportunityTimes.entries()) {
      expect(addComplianceOpportunity(principleKey, index, emittedAt, "略号を使わず回答する。")).toBe(0);
    }
    runStrengthJob(storage, { now: "2026-10-04T00:00:00.000Z", mode: "on" });
    const settledEvent = storage.runCorrectionTransaction(({ db }) => db.prepare(`
      SELECT basis FROM owner_correction_strength_events
      WHERE bundle_key = ? AND reason = 'manual'
    `).get(principleKey) as { basis: string } | undefined);
    if (settledEvent === undefined) throw new Error("synthetic H1 history did not settle");
    expect(JSON.parse(settledEvent.basis)).toMatchObject({ signal: "settled", sessionCount: 5, dayCount: 3 });

    const proposal = createCorrectionGraduationProposal(storage, {
      at: "2026-10-07T00:00:00.000Z",
      sourceHead: "a".repeat(40),
    });
    const sourceStatuses = storage.runCorrectionTransaction(({ db }) => db.prepare(`
      SELECT bundle.status AS bundle_status, version.status AS version_status
      FROM owner_correction_bundles AS bundle
      JOIN owner_correction_versions AS version
        ON version.bundle_key = bundle.bundle_key AND version.version = bundle.version
      WHERE bundle.bundle_key = ?
    `).get(memberKey) as { bundle_status: string; version_status: string });

    expect(proposal?.principles.find((principle) => principle.principle_key === principleKey)).toMatchObject({
      topic_key: "principle",
      delivery: "scene",
      triggers: expect.arrayContaining(["工程略号"]),
      evidence: { sessions: 2, days: 1, injected_sessions: 2, failures_after_injection: 0, violations: 0 },
    });
    expect(sourceStatuses).toEqual({ bundle_status: "candidate", version_status: "candidate" });
  });

  it("H1の適用機会がなくsettledがない原則も卒業提案に出る", () => {
    const confirmedAt = "2026-09-20T00:00:00.000Z";
    const memberKey = `oc:v2:${"d".repeat(64)}`;
    const principleKey = addCandidatePrinciple(memberKey, confirmedAt);
    runStrengthJob(storage, { now: "2026-10-04T00:00:00.000Z", mode: "on" });

    const proposal = createCorrectionGraduationProposal(storage, {
      at: "2026-10-07T00:00:00.000Z",
      sourceHead: "c".repeat(40),
    });

    expect(proposal?.principles.map((principle) => principle.principle_key)).toContain(principleKey);
    const settledEvents = storage.runCorrectionTransaction(({ db }) => db.prepare(`
      SELECT at FROM owner_correction_strength_events
      WHERE bundle_key = ? AND reason = 'manual'
    `).all(principleKey));
    expect(settledEvents).toEqual([]);
  });

  it("H1で閾値以上守られた後に直近failureがあれば卒業しない", () => {
    const confirmedAt = "2026-09-20T00:00:00.000Z";
    const memberKey = `oc:v2:${"e".repeat(64)}`;
    const principleKey = addCandidatePrinciple(memberKey, confirmedAt);

    const opportunityTimes = [
      "2026-10-01T09:00:00.000Z",
      "2026-10-02T09:00:00.000Z",
      "2026-10-03T09:00:00.000Z",
      "2026-10-03T10:00:00.000Z",
      "2026-10-03T11:00:00.000Z",
    ];
    for (const [index, emittedAt] of opportunityTimes.entries()) {
      expect(addComplianceOpportunity(principleKey, index, emittedAt, "略号を使わず回答する。")).toBe(0);
    }
    runStrengthJob(storage, { now: "2026-10-04T00:00:00.000Z", mode: "on" });
    const settledEvent = storage.runCorrectionTransaction(({ db }) => db.prepare(`
      SELECT basis FROM owner_correction_strength_events
      WHERE bundle_key = ? AND reason = 'manual'
    `).get(principleKey) as { basis: string } | undefined);
    if (settledEvent === undefined) throw new Error("synthetic H1 history did not settle before failure");
    expect(JSON.parse(settledEvent.basis)).toMatchObject({ signal: "settled", sessionCount: 5, dayCount: 3 });
    expect(addComplianceOpportunity(
      principleKey,
      opportunityTimes.length,
      "2026-10-04T01:00:00.000Z",
      "A1を含めた回答。",
    )).toBe(1);
    runStrengthJob(storage, { now: "2026-10-04T02:00:00.000Z", mode: "on" });

    const proposal = createCorrectionGraduationProposal(storage, {
      at: "2026-10-07T00:00:00.000Z",
      sourceHead: "d".repeat(40),
    });

    expect(proposal?.principles.map((principle) => principle.principle_key)).toContain(principleKey);
  });

  it("settledなし・確定後7日未満でもconfirmed owner継続束を提案する", () => {
    const bundleKey = `oc:v2:${"9".repeat(64)}`;
    addBundle({
      bundleKey,
      topicKey: "verification",
      lifetimeKind: "explicit_continuing",
      confirmedAt: "2026-10-05T00:00:00.000Z",
    });

    const proposal = createCorrectionGraduationProposal(storage, {
      at: "2026-10-08T00:00:00.000Z",
      sourceHead: "a".repeat(40),
    });

    expect(proposal?.principles.find((principle) => principle.principle_key === bundleKey)).toMatchObject({
      delivery: "scene",
      evidence: {
        sessions: 1,
        days: 1,
        injected_sessions: 1,
      },
    });
    const settledEvents = storage.runCorrectionTransaction(({ db }) => db.prepare(`
      SELECT at FROM owner_correction_strength_events
      WHERE bundle_key = ? AND reason = 'manual'
    `).all(bundleKey));
    expect(settledEvents).toEqual([]);
  });

  it("project可視・model_routing・取消・期限切れ・係争は提案しない", () => {
    const confirmedAt = "2026-10-05T00:00:00.000Z";
    const eligibleKey = `oc:v2:${"1".repeat(64)}`;
    const projectKey = `oc:v2:${"2".repeat(64)}`;
    const routingKey = `oc:v2:${"3".repeat(64)}`;
    const cancelledKey = `oc:v2:${"4".repeat(64)}`;
    const expiredKey = `oc:v2:${"5".repeat(64)}`;
    const disputedKey = `oc:v2:${"6".repeat(64)}`;
    addBundle({ bundleKey: eligibleKey, topicKey: "verification", lifetimeKind: "inferred", confirmedAt });
    addBundle({ bundleKey: projectKey, topicKey: "verification", lifetimeKind: "inferred", confirmedAt });
    addBundle({ bundleKey: routingKey, topicKey: "model_routing", lifetimeKind: "routing", confirmedAt });
    addBundle({ bundleKey: cancelledKey, topicKey: "verification", lifetimeKind: "inferred", confirmedAt });
    addBundle({ bundleKey: expiredKey, topicKey: "verification", lifetimeKind: "inferred", confirmedAt });
    addBundle({ bundleKey: disputedKey, topicKey: "verification", lifetimeKind: "inferred", confirmedAt });
    storage.runCorrectionTransaction(({ db }) => {
      db.prepare("UPDATE owner_correction_bundles SET visibility = 'project' WHERE bundle_key = ?").run(projectKey);
      db.prepare("UPDATE owner_correction_versions SET visibility = 'project' WHERE bundle_key = ?").run(projectKey);
      db.prepare("UPDATE owner_correction_bundles SET status = 'rejected' WHERE bundle_key = ?").run(cancelledKey);
      db.prepare("UPDATE owner_correction_versions SET status = 'rejected' WHERE bundle_key = ?").run(cancelledKey);
      db.prepare("UPDATE owner_correction_bundles SET expires_at = '2026-10-07T00:00:00.000Z' WHERE bundle_key = ?").run(expiredKey);
      db.prepare("UPDATE owner_correction_versions SET expires_at = '2026-10-07T00:00:00.000Z' WHERE bundle_key = ?").run(expiredKey);
      db.prepare("UPDATE owner_correction_bundles SET status = 'disputed' WHERE bundle_key = ?").run(disputedKey);
      db.prepare("UPDATE owner_correction_versions SET status = 'disputed' WHERE bundle_key = ?").run(disputedKey);
    });

    const proposal = createCorrectionGraduationProposal(storage, {
      at: "2026-10-08T00:00:00.000Z",
      sourceHead: "b".repeat(40),
    });
    const keys = proposal?.principles.map((principle) => principle.principle_key) ?? [];

    expect(keys).toContain(eligibleKey);
    expect(keys).not.toContain(projectKey);
    expect(keys).not.toContain(routingKey);
    expect(keys).not.toContain(cancelledKey);
    expect(keys).not.toContain(expiredKey);
    expect(keys).not.toContain(disputedKey);
  });

  it("settledな原則をscene提案に載せ、routing・taskの寿命は載せず、提案に生根拠を含めない", () => {
    const confirmedAt = "2026-09-28T00:00:00.000Z";
    const settledAt = "2026-10-01T00:00:00.000Z";
    const principleKey = `pr:v1:${"a".repeat(64)}`;
    const memberKey = `oc:v2:${"c".repeat(64)}`;
    addBundle({
      bundleKey: principleKey,
      topicKey: "verification",
      lifetimeKind: "inferred",
      confirmedAt,
      ruleText: "合成規則を検証する",
    });
    addBundle({
      bundleKey: memberKey,
      topicKey: "verification",
      lifetimeKind: "inferred",
      confirmedAt,
      requiredValues: {
        documentKind: "合成資料",
        source: "/tmp/synthetic-source.txt",
        term: SYNTHETIC_SECRET_LIKE,
      },
    });
    const complianceMemberKey = `oc:v2:${"b".repeat(64)}`;
    addBundle({
      bundleKey: complianceMemberKey,
      topicKey: "expression_policy",
      lifetimeKind: "inferred",
      confirmedAt,
      conditionsJson: "[]",
      ruleText: "略号を使わない合成規則",
    });
    storage.runCorrectionTransaction(({ db }) => {
      db.prepare(`
        INSERT INTO owner_correction_principle_members (
          principle_key, member_key, attached_at, attach_source
        ) VALUES (?, ?, ?, 'cluster')
      `).run(principleKey, memberKey, confirmedAt);
    });
    storage.runCorrectionTransaction(({ db }) => {
      db.prepare("INSERT INTO owner_correction_principle_members (principle_key, member_key, attached_at, attach_source) VALUES (?, ?, ?, 'cluster')").run(principleKey, complianceMemberKey, confirmedAt);
    });
    addSettledEvent(principleKey, settledAt);
    addBundle({
      bundleKey: "oc:v2:synthetic-routing",
      topicKey: "model_routing",
      lifetimeKind: "routing",
      confirmedAt,
    });
    addSettledEvent("oc:v2:synthetic-routing", settledAt);
    const routingMemberPrincipleKey = `pr:v1:${"f".repeat(64)}`;
    const routingMemberKey = `oc:v2:${"0".repeat(64)}`;
    addBundle({
      bundleKey: routingMemberPrincipleKey,
      topicKey: "verification",
      lifetimeKind: "inferred",
      confirmedAt,
    });
    addBundle({
      bundleKey: routingMemberKey,
      topicKey: "model_routing",
      lifetimeKind: "routing",
      confirmedAt,
    });
    storage.runCorrectionTransaction(({ db }) => {
      db.prepare(`
        INSERT INTO owner_correction_principle_members (
          principle_key, member_key, attached_at, attach_source
        ) VALUES (?, ?, ?, 'cluster')
      `).run(routingMemberPrincipleKey, routingMemberKey, confirmedAt);
    });
    addSettledEvent(routingMemberPrincipleKey, settledAt);
    addBundle({
      bundleKey: "oc:v2:synthetic-task",
      topicKey: "document_delivery",
      lifetimeKind: "task",
      confirmedAt,
    });
    addSettledEvent("oc:v2:synthetic-task", settledAt);
    const alwaysKey = `oc:v2:${"d".repeat(64)}`;
    addBundle({
      bundleKey: alwaysKey,
      topicKey: "unknown",
      lifetimeKind: "explicit_continuing",
      confirmedAt,
      ruleText: "毎回出力確認する仕組みが必要な場合",
    });
    addSettledEvent(alwaysKey, settledAt);
    const recentKey = `pr:v1:${"e".repeat(64)}`;
    const recentMemberKey = `oc:v2:${"f".repeat(64)}`;
    addBundle({
      bundleKey: recentKey,
      topicKey: "verification",
      lifetimeKind: "inferred",
      confirmedAt: "2026-10-02T00:00:00.000Z",
    });
    addBundle({
      bundleKey: recentMemberKey,
      topicKey: "verification",
      lifetimeKind: "inferred",
      confirmedAt: "2026-10-02T00:00:00.000Z",
    });
    storage.runCorrectionTransaction(({ db }) => {
      db.prepare(`
        INSERT INTO owner_correction_principle_members (
          principle_key, member_key, attached_at, attach_source
        ) VALUES (?, ?, ?, 'cluster')
      `).run(recentKey, recentMemberKey, "2026-10-02T00:00:00.000Z");
    });
    addSettledEvent(recentKey, "2026-10-03T00:00:00.000Z");

    const proposal = createCorrectionGraduationProposal(storage, {
      at: "2026-10-07T00:00:00.000Z",
      sourceHead: "a".repeat(40),
    });

    expect(proposal).toMatchObject({ schema: 1, generated_at: "2026-10-07T00:00:00.000Z" });
    expect(proposal?.principles).toHaveLength(5);
    expect(proposal?.principles.find((entry) => entry.principle_key === principleKey)).toMatchObject({
      principle_key: principleKey,
      topic_key: "verification",
      delivery: "scene",
      triggers: expect.arrayContaining(["検証"]),
      evidence: {
        sessions: 3,
        days: 1,
        injected_sessions: 3,
        failures_after_injection: 0,
        violations: 0,
      },
    });
    expect(proposal?.principles.find((entry) => entry.principle_key === principleKey)?.triggers).not.toContain("合成資料");
    expect(proposal?.principles.map((entry) => entry.principle_key)).not.toContain("oc:v2:synthetic-routing");
    expect(proposal?.principles.map((entry) => entry.principle_key)).not.toContain(routingMemberPrincipleKey);
    expect(proposal?.principles.map((entry) => entry.principle_key)).not.toContain("oc:v2:synthetic-task");
    expect(proposal?.principles.map((entry) => entry.principle_key)).not.toContain(recentKey);
    expect(proposal?.principles.find((entry) => entry.principle_key === alwaysKey)).toMatchObject({
      delivery: "always",
      triggers: [],
    });
    const serialized = JSON.stringify(proposal);
    expect(serialized).not.toContain("合成根拠");
    expect(serialized).not.toContain(tempDir);
    expect(serialized).not.toContain("/tmp/synthetic-source.txt");
    expect(serialized).not.toContain(SYNTHETIC_SECRET_LIKE);
  });

  it("卒業後の新根拠で取り消し、強度を上げ、次の提案から外す", () => {
    const confirmedAt = "2026-09-28T00:00:00.000Z";
    const settledAt = "2026-10-01T00:00:00.000Z";
    const principleKey = `pr:v1:${"b".repeat(64)}`;
    const memberKey = `oc:v2:${"e".repeat(64)}`;
    addBundle({ bundleKey: principleKey, topicKey: "verification", lifetimeKind: "inferred", confirmedAt });
    addBundle({
      bundleKey: memberKey,
      topicKey: "expression_policy",
      lifetimeKind: "inferred",
      confirmedAt,
      ruleText: "略号を使わない合成規則",
    });
    storage.runCorrectionTransaction(({ db }) => {
      db.prepare(`
        INSERT INTO owner_correction_principle_members (
          principle_key, member_key, attached_at, attach_source
        ) VALUES (?, ?, ?, 'cluster')
      `).run(principleKey, memberKey, confirmedAt);
    });
    addSettledEvent(principleKey, settledAt);

    const initial = createCorrectionGraduationProposal(storage, {
      at: "2026-10-07T00:00:00.000Z",
      sourceHead: "b".repeat(40),
    });
    expect(initial?.principles.map((entry) => entry.principle_key)).toContain(principleKey);
    const knowledgePath = join(tempDir, "jev-knowledge.json");
    writeFileSync(knowledgePath, JSON.stringify({
      version: 1,
      cards: [{ id: "g-synthetic", evidence_ids: [principleKey] }],
    }), "utf8");
    recordSuccessfulCorrectionGraduationImport(storage, initial!, knowledgePath, "2026-10-07T00:00:00.000Z");
    addNewEvidence(memberKey, "2026-10-08T00:00:00.000Z");

    const afterEvidence = createCorrectionGraduationProposal(storage, {
      at: "2026-10-08T01:00:00.000Z",
      sourceHead: "c".repeat(40),
    });
    const record = storage.runCorrectionTransaction(({ db }) => db.prepare(`
      SELECT revoked_at, revoke_reason FROM owner_correction_graduations WHERE bundle_key = ?
    `).get(principleKey) as { revoked_at: string | null; revoke_reason: string | null });
    const intensity = storage.runCorrectionTransaction(({ db }) => db.prepare(`
      SELECT intensity FROM owner_correction_bundles WHERE bundle_key = ?
    `).get(principleKey) as { intensity: number });
    const strengthEvent = storage.runCorrectionTransaction(({ db }) => db.prepare(`
      SELECT delta, basis FROM owner_correction_strength_events
      WHERE bundle_key = ? AND reason = 'graduation_revoke'
    `).get(principleKey) as { delta: number; basis: string });

    expect(afterEvidence?.principles.map((entry) => entry.principle_key)).not.toContain(principleKey);
    expect(record).toMatchObject({ revoked_at: "2026-10-08T01:00:00.000Z", revoke_reason: "new_evidence" });
    expect(intensity.intensity).toBe(4);
    expect(strengthEvent.delta).toBe(1);
    expect(JSON.parse(strengthEvent.basis)).toMatchObject({ baseIntensity: 3 });
  });

  it("提案ファイル書出に失敗したとき卒業記録を残さない", () => {
    const confirmedAt = "2026-09-28T00:00:00.000Z";
    const principleKey = `pr:v1:${"1".repeat(64)}`;
    const memberKey = `oc:v2:${"2".repeat(64)}`;
    addBundle({ bundleKey: principleKey, topicKey: "verification", lifetimeKind: "inferred", confirmedAt });
    addBundle({ bundleKey: memberKey, topicKey: "verification", lifetimeKind: "inferred", confirmedAt });
    storage.runCorrectionTransaction(({ db }) => {
      db.prepare(`
        INSERT INTO owner_correction_principle_members (
          principle_key, member_key, attached_at, attach_source
        ) VALUES (?, ?, ?, 'cluster')
      `).run(principleKey, memberKey, confirmedAt);
    });
    addSettledEvent(principleKey, "2026-10-01T00:00:00.000Z");

    expect(() => createCorrectionGraduationProposal(storage, {
      at: "2026-10-07T00:00:00.000Z",
      sourceHead: "d".repeat(40),
    }, () => {
      throw new Error("synthetic file write failure");
    })).toThrow("synthetic file write failure");
    const records = storage.runCorrectionTransaction(({ db }) => db.prepare(`
      SELECT bundle_key FROM owner_correction_graduations WHERE bundle_key = ?
    `).all(principleKey));

    expect(records).toEqual([]);
  });
});
