import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeCorrectionSchema } from "../storage/correction-schema.js";
import { migrateV11ToV12, migrateV12ToV13 } from "../storage/migration.js";
import { SQLiteStorage } from "../storage/sqlite.js";
import { detectOwnerCorrections } from "./detector.js";
import { extractOwnerEvent } from "./events.js";
import {
  createCorrectionGraduationProposal,
  recordSuccessfulCorrectionGraduationImport,
} from "./graduation.js";
import { selectCorrectionInjections, type CorrectionInjectionRequest } from "./injection-policy.js";
import { renderCorrectionRules } from "./render.js";
import { correctionConditionKey, serializeCorrectionRuleInput } from "./rule-template.js";
import { applyCorrectionEvidence, cancelCorrectionBundle, disputeCorrectionBundles, storedBundleKey } from "./store.js";

interface RuleInput {
  bundleKey: string;
  topicKey: string;
  ruleText?: string;
  visibility?: "owner" | "project";
  project?: string;
  scope?: string;
  intensity?: number;
  sessionCount?: number;
  lastSeenAt?: string;
}

describe("owner correction injection policy", () => {
  let tempDir: string;
  let dbPath: string;
  let storage: SQLiteStorage;
  let previousGraduationMode: string | undefined;
  let previousGraduationKnowledgePath: string | undefined;
  let previousPrinciplesMode: string | undefined;
  let previousStrengthMode: string | undefined;
  let previousCorrectionReinjectMode: string | undefined;
  let previousCorrectionComplianceMode: string | undefined;
  let previousCandidateInjectMode: string | undefined;
  let previousOwnerScopeBehaviorMode: string | undefined;

  beforeEach(() => {
    previousGraduationMode = process.env.WASURENAGUSA_GRADUATION;
    previousGraduationKnowledgePath = process.env.WASURENAGUSA_JEV_KNOWLEDGE_PATH;
    previousPrinciplesMode = process.env.WASURENAGUSA_PRINCIPLES;
    previousStrengthMode = process.env.WASURENAGUSA_STRENGTH;
    previousCorrectionReinjectMode = process.env.WASURENAGUSA_CORRECTION_REINJECT;
    previousCorrectionComplianceMode = process.env.WASURENAGUSA_CORRECTION_COMPLIANCE;
    previousCandidateInjectMode = process.env.WASURENAGUSA_CANDIDATE_INJECT;
    previousOwnerScopeBehaviorMode = process.env.WASURENAGUSA_OWNER_SCOPE_BEHAVIOR;
    tempDir = mkdtempSync(join(tmpdir(), "correction-injection-policy-"));
    dbPath = join(tempDir, "memory.db");
    const initialStorage = new SQLiteStorage(dbPath);
    initialStorage.initialize();
    initialStorage.close();
    const db = new Database(dbPath);
    initializeCorrectionSchema(db);
    migrateV11ToV12(db);
    db.close();
    storage = new SQLiteStorage(dbPath);
    storage.initialize();
  });

  afterEach(() => {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
    if (previousGraduationMode === undefined) delete process.env.WASURENAGUSA_GRADUATION;
    else process.env.WASURENAGUSA_GRADUATION = previousGraduationMode;
    if (previousGraduationKnowledgePath === undefined) delete process.env.WASURENAGUSA_JEV_KNOWLEDGE_PATH;
    else process.env.WASURENAGUSA_JEV_KNOWLEDGE_PATH = previousGraduationKnowledgePath;
    if (previousPrinciplesMode === undefined) delete process.env.WASURENAGUSA_PRINCIPLES;
    else process.env.WASURENAGUSA_PRINCIPLES = previousPrinciplesMode;
    if (previousStrengthMode === undefined) delete process.env.WASURENAGUSA_STRENGTH;
    else process.env.WASURENAGUSA_STRENGTH = previousStrengthMode;
    if (previousCorrectionReinjectMode === undefined) delete process.env.WASURENAGUSA_CORRECTION_REINJECT;
    else process.env.WASURENAGUSA_CORRECTION_REINJECT = previousCorrectionReinjectMode;
    if (previousCorrectionComplianceMode === undefined) delete process.env.WASURENAGUSA_CORRECTION_COMPLIANCE;
    else process.env.WASURENAGUSA_CORRECTION_COMPLIANCE = previousCorrectionComplianceMode;
    if (previousCandidateInjectMode === undefined) delete process.env.WASURENAGUSA_CANDIDATE_INJECT;
    else process.env.WASURENAGUSA_CANDIDATE_INJECT = previousCandidateInjectMode;
    if (previousOwnerScopeBehaviorMode === undefined) delete process.env.WASURENAGUSA_OWNER_SCOPE_BEHAVIOR;
    else process.env.WASURENAGUSA_OWNER_SCOPE_BEHAVIOR = previousOwnerScopeBehaviorMode;
  });

  function migrateToV13(): void {
    storage.close();
    const db = new Database(dbPath);
    migrateV12ToV13(db);
    db.close();
    storage = new SQLiteStorage(dbPath);
    storage.initialize();
  }

  function addRule(input: RuleInput): void {
    storage.runCorrectionTransaction(({ db, save }) => {
      const ruleText = input.ruleText ?? `合成規則 ${input.bundleKey}`;
      const saved = save({
        category: "dont",
        title: `Synthetic ${input.bundleKey}`,
        content: ruleText,
        tags: ["synthetic"],
        project: input.project ?? "fixture-project",
        scope: input.scope ?? "backend",
        intensity: input.intensity ?? 3,
      });
      const at = input.lastSeenAt ?? "2026-10-01T00:00:00.000Z";
      const visibility = input.visibility ?? "owner";
      db.prepare(`
        INSERT INTO owner_correction_bundles (
          bundle_key, memory_id, rule_text, topic_key, polarity, condition_key, project, scope,
          visibility, status, intensity, occurrence_count, session_count, first_seen_at, last_seen_at,
          expires_at, lifetime_kind, continuation_basis, confirmed_at, version, counterevidence_event_id,
          last_confirmation_asked_at, confirmation_state
        ) VALUES (?, ?, ?, ?, 'negative', 'general', ?, ?, ?, 'confirmed', ?, 2, ?, ?, ?, NULL,
          'explicit_continuing', 'synthetic-continuation', ?, 1, NULL, NULL, 'none')
      `).run(
        input.bundleKey,
        saved.id,
        ruleText,
        input.topicKey,
        input.project ?? "fixture-project",
        input.scope ?? "backend",
        visibility,
        input.intensity ?? 3,
        input.sessionCount ?? 2,
        at,
        at,
        at,
      );
      db.prepare(`
        INSERT INTO owner_correction_versions (
          bundle_key, version, rule_text, body_hash, conditions, condition_key, polarity, visibility,
          status, confirmed_at, expires_at, lifetime_kind, continuation_basis, evidence_event_ids,
          effective_from, change_reason
        ) VALUES (?, 1, ?, 'synthetic-hash', '[]', 'general', 'negative', ?, 'confirmed', ?, NULL,
          'explicit_continuing', 'synthetic-continuation', '[]', ?, 'synthetic-fixture')
      `).run(input.bundleKey, ruleText, visibility, at, at);
    });
  }

  function addDetectedCandidate(
    suffix: string,
    detectorVersion = "owner-correction-v4",
    project = "fixture-project",
    scope = "backend",
    visibility: "project" | "owner" = "project",
  ): string {
    const at = "2026-10-03T00:00:00.000Z";
    const eventId = `synthetic-candidate-${suffix}`;
    const sessionId = `synthetic-candidate-session-${suffix}`;
    const limit = 100 + (Number(suffix.match(/\d+/u)?.[0]) || 0);
    const text = `今後は特定の場合だけ回答を${limit}文字以内にして`;
    const ownerEvent = extractOwnerEvent({
      type: "user",
      origin: { kind: "human" },
      sessionId,
      uuid: eventId,
      timestamp: at,
      message: { content: text },
    });
    if (!ownerEvent) throw new Error("synthetic owner event was not extracted");
    const detected = detectOwnerCorrections(ownerEvent)[0];
    if (!detected || detected.status !== "candidate" || !detected.ruleText) {
      throw new Error("synthetic rule candidate was not detected");
    }

    return storage.runCorrectionTransaction(({ db, save }) => {
      db.prepare(`
        INSERT INTO owner_correction_events (
          event_id, session_id_hash, source_uuid_hash, human_ordinal, observed_at, available_at,
          source_kind, excerpt, previous_action, action_first_locator_hash, action_last_locator_hash,
          project, scope, raw_text_hash, source_locator_hash, processed_at
        ) VALUES (?, ?, NULL, 1, ?, ?, 'user', '合成発話', 'action_unknown', NULL, NULL,
          ?, ?, 'synthetic-raw-hash', ?, ?)
      `).run(eventId, sessionId, at, at, project, scope, `locator-${eventId}`, at);
      const result = applyCorrectionEvidence({ db, save }, {
        eventId,
        at,
        bundleKey: detected.bundleKey,
        ruleText: detected.ruleText,
        topicKey: detected.topicKey,
        polarity: detected.polarity,
        conditionKey: correctionConditionKey(detected.ruleInput),
        visibility,
        decision: "candidate",
        lifetimeKind: detected.lifetimeKind,
        continuationBasis: detected.ruleInput.continuationBasis,
        evidence: {
          source: detected.source,
          score: detected.score,
          detectorVersion,
          conditions: serializeCorrectionRuleInput(detected.ruleInput),
          polarity: detected.polarity,
        },
      });
      return result.bundleKey;
    });
  }

  function addEvent(eventId: string, at: string): void {
    storage.runCorrectionTransaction(({ db }) => {
      db.prepare(`
        INSERT INTO owner_correction_events (
          event_id, session_id_hash, source_uuid_hash, human_ordinal, observed_at, available_at,
          source_kind, excerpt, previous_action, action_first_locator_hash, action_last_locator_hash,
          project, scope, raw_text_hash, source_locator_hash, processed_at
        ) VALUES (?, 'synthetic-followup-session', NULL, 1, ?, ?, 'user', '合成発話', 'action_unknown', NULL, NULL,
          'fixture-project', 'backend', 'synthetic-raw-hash', ?, ?)
      `).run(eventId, at, at, `locator-${eventId}`, at);
    });
  }

  function addEmission(
    bundleKey: string,
    input: {
      sessionIdHash?: string;
      compactEpoch?: number;
      humanOrdinal: number;
      trigger?: "start" | "prompt" | "refresh" | "compact";
      outputOrder?: number;
      bodyIncluded?: 0 | 1;
      stdoutStatus?: "emitted" | "failed";
    },
  ): void {
    storage.runCorrectionTransaction(({ db }) => {
      db.prepare(`
        INSERT INTO owner_correction_injections (
          session_id_hash, compact_epoch, bundle_key, version, human_ordinal, trigger, emitted_at,
          output_order, body_hash, output_hash, token_estimate, body_included, stdout_status
        ) VALUES (?, ?, ?, 1, ?, ?, '2026-10-02T00:00:00.000Z', ?, 'synthetic-body-hash',
          'synthetic-output-hash', 20, ?, ?)
      `).run(
        input.sessionIdHash ?? "synthetic-session",
        input.compactEpoch ?? 0,
        bundleKey,
        input.humanOrdinal,
        input.trigger ?? "start",
        input.outputOrder ?? 1,
        input.bodyIncluded ?? 1,
        input.stdoutStatus ?? "emitted",
      );
    });
  }

  function addCorrectionEvidence(
    bundleKey: string,
    humanOrdinal: number,
    source: "utterance_detection" | "request_repeat" | "legacy_import" = "utterance_detection",
  ): void {
    storage.runCorrectionTransaction(({ db }) => {
      const eventId = `synthetic-correction-${bundleKey}-${humanOrdinal}`;
      const at = "2026-10-03T00:00:00.000Z";
      db.prepare(`
        INSERT INTO owner_correction_events (
          event_id, session_id_hash, source_uuid_hash, human_ordinal, observed_at, available_at,
          source_kind, excerpt, previous_action, action_first_locator_hash, action_last_locator_hash,
          project, scope, raw_text_hash, source_locator_hash, processed_at
        ) VALUES (?, 'synthetic-session', NULL, ?, ?, ?, 'user', 'synthetic correction', 'action_unknown',
          NULL, NULL, 'fixture-project', 'backend', 'synthetic-raw-hash', ?, ?)
      `).run(eventId, humanOrdinal, at, at, `locator-${eventId}`, at);
      db.prepare(`
        INSERT INTO owner_correction_evidence (
          event_id, bundle_key, source, score, detector_version, conditions, polarity
        ) VALUES (?, ?, ?, 2, 'fixture-v1', '[]', 'negative')
      `).run(eventId, bundleKey, source);
    });
  }

  function addComplianceViolation(
    bundleKey: string,
    humanOrdinal: number,
    checker: "tone" | "document_delivery" | "expression_policy" = "tone",
  ): void {
    storage.runCorrectionTransaction(({ db }) => {
      db.prepare(`
        INSERT INTO owner_correction_violations (
          session_id_hash, human_ordinal, bundle_key, version, checker, detected_at
        ) VALUES ('synthetic-session', ?, ?, 1, ?, '2026-10-03T00:00:00.000Z')
      `).run(humanOrdinal, bundleKey, checker);
    });
  }

  function request(overrides: Partial<CorrectionInjectionRequest> = {}): CorrectionInjectionRequest {
    return {
      project: "fixture-project",
      scope: "backend",
      query: "無関係な合成語",
      at: "2026-10-03T00:00:00.000Z",
      sessionIdHash: "synthetic-session",
      compactEpoch: 0,
      humanOrdinal: 1,
      trigger: "prompt",
      ...overrides,
    };
  }

  function detectSyntheticCandidates(text: string) {
    const ownerEvent = extractOwnerEvent({
      type: "user",
      origin: { kind: "human" },
      sessionId: "synthetic-session",
      uuid: "synthetic-correction-detection",
      timestamp: "2026-10-03T00:00:00.000Z",
      message: { content: text },
    });
    if (!ownerEvent) throw new Error("synthetic owner event was not extracted");
    return detectOwnerCorrections(ownerEvent);
  }

  it("初回検出したv4候補を次sessionのSessionStartと関連発話へ仮注入し、既定offでは出さない", () => {
    process.env.WASURENAGUSA_OWNER_SCOPE_BEHAVIOR = "off";
    const bundleKey = addDetectedCandidate("first-detection");
    delete process.env.WASURENAGUSA_CANDIDATE_INJECT;

    const disabled = selectCorrectionInjections(storage, request({
      sessionIdHash: "synthetic-next-session-off",
      humanOrdinal: 0,
      trigger: "start",
    }));
    expect(disabled.rules.map((rule) => rule.bundleKey)).not.toContain(bundleKey);

    process.env.WASURENAGUSA_CANDIDATE_INJECT = "on";
    const start = selectCorrectionInjections(storage, request({
      sessionIdHash: "synthetic-next-session-start",
      humanOrdinal: 0,
      trigger: "start",
    }));
    const startRender = renderCorrectionRules({ trigger: "start", rules: start.rules, budgetTokens: 8000 });
    expect(start.rules.map((rule) => rule.bundleKey)).toContain(bundleKey);
    expect(startRender.text).toContain("（仮）");

    const followup = selectCorrectionInjections(storage, request({
      sessionIdHash: "synthetic-next-session-prompt",
      humanOrdinal: 1,
      trigger: "prompt",
      query: "回答を100文字以内にする",
    }));
    expect(followup.rules.map((rule) => rule.bundleKey)).toContain(bundleKey);

    const refresh = selectCorrectionInjections(storage, request({
      sessionIdHash: "synthetic-next-session-refresh",
      humanOrdinal: 31,
      trigger: "refresh",
      query: "回答を100文字以内にする",
    }));
    expect(refresh.rules.map((rule) => rule.bundleKey)).toContain(bundleKey);
    expect(renderCorrectionRules({ trigger: "refresh", rules: refresh.rules }).text).toContain("（仮）");
  });

  it("取消・disputed・v3候補を出さず、同じ可視範囲の候補だけを選ぶ", () => {
    process.env.WASURENAGUSA_CANDIDATE_INJECT = "on";
    process.env.WASURENAGUSA_OWNER_SCOPE_BEHAVIOR = "off";
    const activeKey = addDetectedCandidate("active-10");
    const cancelledKey = addDetectedCandidate("cancelled-1");
    const beforeCancellation = selectCorrectionInjections(storage, request({
      sessionIdHash: "synthetic-before-cancellation",
      humanOrdinal: 0,
      trigger: "start",
    }));
    expect(beforeCancellation.rules.map((rule) => rule.bundleKey)).toContain(cancelledKey);
    addEvent("synthetic-candidate-cancel-event", "2026-10-03T00:00:00.000Z");
    storage.runCorrectionTransaction((transaction) => cancelCorrectionBundle(transaction, {
      bundleKey: cancelledKey,
      eventId: "synthetic-candidate-cancel-event",
      at: "2026-10-03T00:00:00.000Z",
    }));

    const disputedKey = addDetectedCandidate("disputed-2");
    const conflictKey = addDetectedCandidate("conflict-3");
    addEvent("synthetic-candidate-dispute-event", "2026-10-03T00:00:00.000Z");
    storage.runCorrectionTransaction((transaction) => disputeCorrectionBundles(transaction, {
      bundleKeys: [disputedKey, conflictKey],
      eventId: "synthetic-candidate-dispute-event",
      at: "2026-10-03T00:00:00.000Z",
    }));

    const oldKey = addDetectedCandidate("old-4", "owner-correction-v3");
    const otherProjectKey = addDetectedCandidate("other-project-5", "owner-correction-v4", "another-project");
    const otherScopeKey = addDetectedCandidate("other-scope-6", "owner-correction-v4", "fixture-project", "frontend");
    const ownerKey = addDetectedCandidate("owner-visible-7", "owner-correction-v4", "another-project", "backend", "owner");
    const selected = selectCorrectionInjections(storage, request({
      sessionIdHash: "synthetic-next-session-filtering",
      humanOrdinal: 0,
      trigger: "start",
    }));

    expect(selected.rules.map((rule) => rule.bundleKey)).toContain(activeKey);
    expect(selected.rules.map((rule) => rule.bundleKey)).toContain(ownerKey);
    expect(selected.rules.map((rule) => rule.bundleKey)).not.toContain(cancelledKey);
    expect(selected.rules.map((rule) => rule.bundleKey)).not.toContain(disputedKey);
    expect(selected.rules.map((rule) => rule.bundleKey)).not.toContain(oldKey);
    expect(selected.rules.map((rule) => rule.bundleKey)).not.toContain(otherProjectKey);
    expect(selected.rules.map((rule) => rule.bundleKey)).not.toContain(otherScopeKey);
  });

  it("候補は開始時6件の確認済み規則を押し出さない", () => {
    process.env.WASURENAGUSA_CANDIDATE_INJECT = "on";
    process.env.WASURENAGUSA_OWNER_SCOPE_BEHAVIOR = "off";
    const candidateKey = addDetectedCandidate("low-priority-8");
    for (let index = 0; index < 6; index += 1) {
      addRule({ bundleKey: `confirmed-${index}`, topicKey: "verification", intensity: 1 });
    }
    const selected = selectCorrectionInjections(storage, request({
      sessionIdHash: "synthetic-next-session-priority",
      humanOrdinal: 0,
      trigger: "start",
    }));

    expect(selected.rules).toHaveLength(6);
    expect(selected.rules.map((rule) => rule.bundleKey)).not.toContain(candidateKey);
    expect(selected.rules.every((rule) => rule.bundleKey.startsWith("confirmed-"))).toBe(true);
  });

  it("提案だけでは配送を止めず、Jev受取後にSessionStart・prompt・refreshから外す", () => {
    migrateToV13();
    process.env.WASURENAGUSA_GRADUATION = "on";
    process.env.WASURENAGUSA_PRINCIPLES = "on";
    delete process.env.WASURENAGUSA_JEV_KNOWLEDGE_PATH;
    const principleKey = `pr:v1:${"c".repeat(64)}`;
    const memberKey = `oc:v2:${"d".repeat(64)}`;
    const alwaysKey = `oc:v2:${"a".repeat(64)}`;
    addRule({ bundleKey: principleKey, topicKey: "principle", lastSeenAt: "2026-09-28T00:00:00.000Z" });
    addRule({
      bundleKey: alwaysKey,
      topicKey: "unknown",
      ruleText: "毎回出力確認する仕組みが必要な場合",
      lastSeenAt: "2026-09-28T00:00:00.000Z",
    });
    const complianceMemberKey = "oc:v2:" + "e".repeat(64);
    addRule({
      bundleKey: complianceMemberKey,
      topicKey: "expression_policy",
      ruleText: "略号を使わない合成規則",
      lastSeenAt: "2026-09-28T00:00:00.000Z",
    });
    addRule({ bundleKey: memberKey, topicKey: "verification", lastSeenAt: "2026-09-28T00:00:00.000Z" });
    storage.runCorrectionTransaction(({ db }) => {
      db.prepare(`
        INSERT INTO owner_correction_principle_members (
          principle_key, member_key, attached_at, attach_source
        ) VALUES (?, ?, '2026-09-28T00:00:00.000Z', 'cluster')
      `).run(principleKey, memberKey);
      db.prepare(`
        INSERT INTO owner_correction_strength_events (
          bundle_key, at, from_intensity, to_intensity, delta, reason, basis
        ) VALUES (?, '2026-10-01T00:00:00.000Z', 3, 3, 0, 'manual', ?)
      `).run(principleKey, JSON.stringify({ signal: "settled", sessionCount: 5, dayCount: 3 }));
    });
    storage.runCorrectionTransaction(({ db }) => {
      db.prepare("INSERT INTO owner_correction_principle_members (principle_key, member_key, attached_at, attach_source) VALUES (?, ?, '2026-09-28T00:00:00.000Z', 'cluster')").run(principleKey, complianceMemberKey);
    });
    addCorrectionEvidence(memberKey, 1, "request_repeat");
    addCorrectionEvidence(complianceMemberKey, 1, "request_repeat");
    addCorrectionEvidence(alwaysKey, 1, "request_repeat");
    const proposal = createCorrectionGraduationProposal(storage, {
      at: "2026-10-07T00:00:00.000Z",
      sourceHead: "f".repeat(40),
    });
    expect(proposal?.principles.map((principle) => principle.principle_key)).toContain(principleKey);
    expect(proposal?.principles.find((principle) => principle.principle_key === alwaysKey)).toMatchObject({
      delivery: "always",
      triggers: [],
    });

    const knowledgePath = join(tempDir, "jev-knowledge.json");
    writeFileSync(knowledgePath, JSON.stringify({ version: 1, cards: [] }), "utf8");
    process.env.WASURENAGUSA_JEV_KNOWLEDGE_PATH = knowledgePath;
    const pendingPrompt = selectCorrectionInjections(storage, request({
      at: "2026-10-08T00:00:00.000Z",
      trigger: "prompt",
      humanOrdinal: 1,
    }));
    const pendingRefresh = selectCorrectionInjections(storage, request({
      at: "2026-10-08T00:00:00.000Z",
      trigger: "refresh",
      humanOrdinal: 31,
    }));
    expect(pendingPrompt.rules.map((rule) => rule.bundleKey)).toContain(principleKey);
    expect(pendingRefresh.rules.map((rule) => rule.bundleKey)).toContain(principleKey);

    writeFileSync(knowledgePath, JSON.stringify({
      version: 1,
      cards: [{ id: "g-synthetic", evidence_ids: [principleKey] }],
    }), "utf8");
    recordSuccessfulCorrectionGraduationImport(storage, proposal!, knowledgePath, "2026-10-08T00:00:00.000Z");

    const prompt = selectCorrectionInjections(storage, request({
      at: "2026-10-08T00:00:00.000Z",
      trigger: "prompt",
      humanOrdinal: 1,
    }));
    const refresh = selectCorrectionInjections(storage, request({
      at: "2026-10-08T00:00:00.000Z",
      trigger: "refresh",
      humanOrdinal: 31,
    }));
    const start = selectCorrectionInjections(storage, request({
      at: "2026-10-08T00:00:00.000Z",
      trigger: "start",
      humanOrdinal: 0,
    }));

    expect(prompt.rules.map((rule) => rule.bundleKey)).not.toContain(principleKey);
    expect(refresh.rules.map((rule) => rule.bundleKey)).not.toContain(principleKey);
    expect(start.rules.map((rule) => rule.bundleKey)).not.toContain(principleKey);
    expect(prompt.rules.map((rule) => rule.bundleKey)).toContain(alwaysKey);
    expect(refresh.rules.map((rule) => rule.bundleKey)).toContain(alwaysKey);
    expect(start.rules.map((rule) => rule.bundleKey)).toContain(alwaysKey);

    process.env.WASURENAGUSA_JEV_KNOWLEDGE_PATH = join(tempDir, "missing-jev-knowledge.json");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const unreadable = selectCorrectionInjections(storage, request({
      at: "2026-10-08T00:00:00.000Z",
      trigger: "prompt",
      humanOrdinal: 1,
    }));
    stderrSpy.mockRestore();
    expect(unreadable.rules.map((rule) => rule.bundleKey)).toContain(principleKey);
  });

  it("schema v12では卒業表を参照せず既存の注入を続ける", () => {
    process.env.WASURENAGUSA_GRADUATION = "on";
    process.env.WASURENAGUSA_JEV_KNOWLEDGE_PATH = join(tempDir, "missing-jev-knowledge.json");
    addRule({ bundleKey: "schema-v12-rule", topicKey: "verification" });

    const result = selectCorrectionInjections(storage, request({ trigger: "start", humanOrdinal: 0 }));

    expect(result.rules.map((rule) => rule.bundleKey)).toContain("schema-v12-rule");
  });

  it("schema v12では強度補正表を参照せず既存の注入を続ける", () => {
    process.env.WASURENAGUSA_STRENGTH = "off";
    addRule({ bundleKey: "schema-v12-strength-rule", topicKey: "verification" });

    const result = selectCorrectionInjections(storage, request({ trigger: "start", humanOrdinal: 0 }));

    expect(result.rules.map((rule) => rule.bundleKey)).toContain("schema-v12-strength-rule");
  });

  it("強度offでは保存済み補正を除いて並べ、onへ戻すと補正順位を戻す", () => {
    migrateToV13();
    addRule({ bundleKey: "strength-adjusted-rule", topicKey: "verification", intensity: 2 });
    addRule({ bundleKey: "base-stronger-rule", topicKey: "verification", intensity: 4 });
    storage.runCorrectionTransaction(({ db }) => {
      const bundle = db.prepare(`
        SELECT memory_id FROM owner_correction_bundles WHERE bundle_key = ?
      `).get("strength-adjusted-rule") as { memory_id: string };
      db.prepare("UPDATE owner_correction_bundles SET intensity = 5 WHERE bundle_key = ?")
        .run("strength-adjusted-rule");
      db.prepare("UPDATE memories SET intensity = 5 WHERE id = ?").run(bundle.memory_id);
      db.prepare(`
        INSERT INTO owner_correction_strength_events (
          bundle_key, at, from_intensity, to_intensity, delta, reason, basis
        ) VALUES (?, '2026-10-02T00:00:00.000Z', 2, 5, 3, 'failure', '{"baseIntensity":2}')
      `).run("strength-adjusted-rule");
    });
    expect(storage.runCorrectionTransaction(({ db }) => db.prepare(
      "SELECT intensity FROM owner_correction_bundles WHERE bundle_key = ?",
    ).get("strength-adjusted-rule") as { intensity: number }).intensity).toBe(5);

    process.env.WASURENAGUSA_STRENGTH = "off";
    const offResult = selectCorrectionInjections(storage, request({ trigger: "start", humanOrdinal: 0 }));
    expect(offResult.rules.map((rule) => rule.bundleKey)).toEqual([
      "base-stronger-rule",
      "strength-adjusted-rule",
    ]);

    process.env.WASURENAGUSA_STRENGTH = "on";
    const onResult = selectCorrectionInjections(storage, request({ trigger: "start", humanOrdinal: 0 }));
    expect(onResult.rules.map((rule) => rule.bundleKey)).toEqual([
      "strength-adjusted-rule",
      "base-stronger-rule",
    ]);
  });

  it("卒業後に新根拠が届いた発話では取消してprompt注入へ戻す", () => {
    migrateToV13();
    process.env.WASURENAGUSA_GRADUATION = "on";
    const bundleKey = `oc:v2:${"7".repeat(64)}`;
    const knowledgePath = join(tempDir, "jev-knowledge.json");
    process.env.WASURENAGUSA_JEV_KNOWLEDGE_PATH = knowledgePath;
    addRule({ bundleKey, topicKey: "verification" });
    storage.runCorrectionTransaction(({ db }) => {
      db.prepare(`
        INSERT INTO owner_correction_graduations (bundle_key, graduated_at, proposal_hash)
        VALUES (?, '2026-10-02T00:00:00.000Z', 'synthetic-proposal-hash')
      `).run(bundleKey);
    });
    writeFileSync(knowledgePath, JSON.stringify({
      version: 1,
      cards: [{ id: "g-synthetic", evidence_ids: [bundleKey] }],
    }), "utf8");
    const beforeEvidence = selectCorrectionInjections(storage, request({
      at: "2026-10-02T12:00:00.000Z",
      trigger: "prompt",
      humanOrdinal: 1,
    }));
    expect(beforeEvidence.rules.map((rule) => rule.bundleKey)).not.toContain(bundleKey);
    addCorrectionEvidence(bundleKey, 1);

    const result = selectCorrectionInjections(storage, request({
      at: "2026-10-04T00:00:00.000Z",
      trigger: "prompt",
      humanOrdinal: 2,
    }));
    const graduation = storage.runCorrectionTransaction(({ db }) => db.prepare(`
      SELECT revoked_at FROM owner_correction_graduations WHERE bundle_key = ?
    `).get(bundleKey) as { revoked_at: string | null });

    expect(graduation.revoked_at).toBe("2026-10-04T00:00:00.000Z");
    expect(result.rules.map((rule) => rule.bundleKey)).toContain(bundleKey);

    const nextProposal = createCorrectionGraduationProposal(storage, {
      at: "2026-10-05T00:00:00.000Z",
      sourceHead: "e".repeat(40),
    });
    expect(nextProposal?.principles).toEqual([]);
    writeFileSync(knowledgePath, JSON.stringify({ version: 1, cards: [] }), "utf8");
    recordSuccessfulCorrectionGraduationImport(storage, nextProposal!, knowledgePath, "2026-10-05T00:00:00.000Z");
    const restored = selectCorrectionInjections(storage, request({
      at: "2026-10-05T00:00:00.000Z",
      trigger: "prompt",
      humanOrdinal: 3,
    }));
    expect(result.rules.map((rule) => rule.bundleKey)).toContain(bundleKey);
    expect(restored.rules.map((rule) => rule.bundleKey)).toContain(bundleKey);
  });

  it("卒業offではJev反映済みの原則をprompt注入へ戻す", () => {
    migrateToV13();
    process.env.WASURENAGUSA_GRADUATION = "on";
    process.env.WASURENAGUSA_PRINCIPLES = "on";
    const principleKey = `pr:v1:${"a".repeat(64)}`;
    const memberKey = `oc:v2:${"b".repeat(64)}`;
    addRule({ bundleKey: principleKey, topicKey: "principle" });
    addRule({ bundleKey: memberKey, topicKey: "verification" });
    storage.runCorrectionTransaction(({ db }) => {
      db.prepare(`
        INSERT INTO owner_correction_principle_members (
          principle_key, member_key, attached_at, attach_source
        ) VALUES (?, ?, '2026-10-02T00:00:00.000Z', 'cluster')
      `).run(principleKey, memberKey);
      db.prepare(`
        INSERT INTO owner_correction_graduations (bundle_key, graduated_at, proposal_hash)
        VALUES (?, '2026-10-02T00:00:00.000Z', 'synthetic-proposal-hash')
      `).run(principleKey);
    });
    const knowledgePath = join(tempDir, "jev-knowledge.json");
    writeFileSync(knowledgePath, JSON.stringify({
      version: 1,
      cards: [{ id: "g-synthetic", evidence_ids: [principleKey] }],
    }), "utf8");
    process.env.WASURENAGUSA_JEV_KNOWLEDGE_PATH = knowledgePath;

    const graduated = selectCorrectionInjections(storage, request({ humanOrdinal: 1, trigger: "prompt" }));
    process.env.WASURENAGUSA_GRADUATION = "off";
    const restored = selectCorrectionInjections(storage, request({ humanOrdinal: 1, trigger: "prompt" }));

    expect(graduated.rules.map((rule) => rule.bundleKey)).not.toContain(principleKey);
    expect(restored.rules.map((rule) => rule.bundleKey)).toContain(principleKey);
  });

  it("開始時にtopicごとに巡回し、6件を超える常時規則を未到達にする", () => {
    addRule({ bundleKey: "design-first", topicKey: "design_components", intensity: 5 });
    addRule({ bundleKey: "design-second", topicKey: "design_components", intensity: 5 });
    addRule({ bundleKey: "full-text", topicKey: "document_delivery", intensity: 4 });
    addRule({ bundleKey: "delegation", topicKey: "delegation_roles", intensity: 4 });
    addRule({ bundleKey: "tone", topicKey: "tone", intensity: 3 });
    addRule({ bundleKey: "verify", topicKey: "verification", intensity: 3 });
    addRule({ bundleKey: "storage", topicKey: "storage_location", intensity: 2 });

    const result = selectCorrectionInjections(storage, request({ trigger: "start", humanOrdinal: 0 }));

    expect(result.rules).toHaveLength(6);
    expect(result.rules.map((rule) => rule.bundleKey)).toContain("design-first");
    expect(result.rules.map((rule) => rule.bundleKey)).toContain("full-text");
    expect(result.rules.map((rule) => rule.bundleKey)).toContain("delegation");
    expect(result.rules.map((rule) => rule.bundleKey)).not.toContain("design-second");
    expect(result.unreached).toEqual([{ bundleKey: "design-second", version: 1, reason: "item_limit" }]);
  });

  it("開始で届かなかった常時規則を語一致なしで次発話へ送る", () => {
    for (let index = 1; index <= 7; index += 1) {
      addRule({ bundleKey: `always-${index}`, topicKey: `topic-${index}`, intensity: 3 });
    }
    const start = selectCorrectionInjections(storage, request({ trigger: "start", humanOrdinal: 0 }));
    start.rules.forEach((rule, index) => addEmission(rule.bundleKey, { humanOrdinal: 0, outputOrder: index + 1 }));

    const next = selectCorrectionInjections(storage, request({ query: "まったく別の検索語", humanOrdinal: 1 }));

    expect(next.rules).toHaveLength(1);
    expect(next.rules[0]).toMatchObject({ bundleKey: "always-7", delivery: "restore" });
    expect(next.unreached).toEqual([{ bundleKey: "always-7", version: 1, reason: "item_limit" }]);
  });

  it("開始6件のうちモデル経路を最大2件予約し、未到達のproject規則を後続配送する", () => {
    addRule({ bundleKey: "always-tone", topicKey: "tone" });
    addRule({ bundleKey: "always-response", topicKey: "response_policy" });
    addRule({ bundleKey: "always-document", topicKey: "document_delivery" });
    addRule({ bundleKey: "always-verify", topicKey: "verification" });
    addRule({ bundleKey: "model-route-1", topicKey: "model_routing", visibility: "owner" });
    addRule({ bundleKey: "model-route-2", topicKey: "model_routing", visibility: "project" });
    addRule({ bundleKey: "model-route-3", topicKey: "model_routing", visibility: "project" });

    const start = selectCorrectionInjections(storage, request({ trigger: "start", humanOrdinal: 0 }));
    start.rules.forEach((rule, index) => addEmission(rule.bundleKey, { humanOrdinal: 0, outputOrder: index + 1 }));
    const next = selectCorrectionInjections(storage, request({ query: "無関係な合成語", humanOrdinal: 1 }));

    expect(start.rules).toHaveLength(6);
    expect(start.rules.filter((rule) => rule.bundleKey.includes("model-route"))).toHaveLength(2);
    expect(start.unreached).toContainEqual({ bundleKey: "model-route-3", version: 1, reason: "item_limit" });
    expect(next.rules).toEqual([expect.objectContaining({ bundleKey: "model-route-3", delivery: "restore" })]);
    expect(next.unreached).toContainEqual({ bundleKey: "model-route-3", version: 1, reason: "item_limit" });
  });

  it("台帳で本文未到達の理由をtoken budgetとして残す", () => {
    addRule({ bundleKey: "budget-omitted", topicKey: "tone" });
    addEmission("budget-omitted", { humanOrdinal: 0, bodyIncluded: 0 });

    const next = selectCorrectionInjections(storage, request({ humanOrdinal: 1 }));

    expect(next.rules[0]).toMatchObject({ bundleKey: "budget-omitted", delivery: "restore" });
    expect(next.unreached).toEqual([{ bundleKey: "budget-omitted", version: 1, reason: "token_budget" }]);
  });

  it("同じsession/epochのstart再起動では二重に出さない", () => {
    addRule({ bundleKey: "one-start-only", topicKey: "tone" });
    addEmission("one-start-only", { humanOrdinal: 0, trigger: "start" });

    const restarted = selectCorrectionInjections(storage, request({ trigger: "start", humanOrdinal: 0 }));

    expect(restarted.rules).toEqual([]);
  });

  it("10発話冷却と31+30nの定期再注入を守る", () => {
    addRule({ bundleKey: "refresh-one", topicKey: "tone" });
    addRule({ bundleKey: "refresh-two", topicKey: "verification" });
    addRule({
      bundleKey: "cooling-project",
      topicKey: "document_delivery",
      visibility: "project",
      ruleText: "出典確認を行う合成規則",
    });
    addEmission("refresh-one", { humanOrdinal: 0, outputOrder: 1 });
    addEmission("refresh-two", { humanOrdinal: 0, outputOrder: 2 });
    addEmission("cooling-project", { humanOrdinal: 1, trigger: "prompt" });
    process.env.WASURENAGUSA_CORRECTION_REINJECT = "off";

    const at30 = selectCorrectionInjections(storage, request({ humanOrdinal: 30 }));
    const at31 = selectCorrectionInjections(storage, request({ humanOrdinal: 31 }));
    at31.rules.forEach((rule, index) => addEmission(rule.bundleKey, {
      humanOrdinal: 31,
      trigger: "refresh",
      outputOrder: index + 1,
    }));
    const at60 = selectCorrectionInjections(storage, request({ humanOrdinal: 60 }));
    const at61 = selectCorrectionInjections(storage, request({ humanOrdinal: 61 }));
    at61.rules.forEach((rule, index) => addEmission(rule.bundleKey, {
      humanOrdinal: 61,
      trigger: "refresh",
      outputOrder: index + 1,
    }));
    const at91 = selectCorrectionInjections(storage, request({ humanOrdinal: 91 }));

    expect(at30.rules).toHaveLength(0);
    expect(at31.rules.map((rule) => rule.bundleKey)).toEqual(["refresh-one"]);
    expect(at60.rules).toHaveLength(0);
    expect(at61.rules.map((rule) => rule.bundleKey)).toEqual(["refresh-two"]);
    expect(at91.rules.map((rule) => rule.bundleKey)).toEqual(["refresh-one"]);
    expect(selectCorrectionInjections(storage, request({ query: "出典確認", humanOrdinal: 11 })).rules).toHaveLength(0);
    expect(selectCorrectionInjections(storage, request({ query: "出典確認", humanOrdinal: 12 })).rules.map((rule) => rule.bundleKey)).toEqual(["cooling-project"]);
  });

  it("新compact epochでは常時規則の復元を関連規則より先に送る", () => {
    addRule({ bundleKey: "always-one", topicKey: "tone" });
    addRule({ bundleKey: "always-two", topicKey: "verification" });
    addRule({ bundleKey: "related-project", topicKey: "document_delivery", visibility: "project", ruleText: "出典確認を行う合成規則" });
    addEmission("always-one", { compactEpoch: 0, humanOrdinal: 0 });
    addEmission("always-two", { compactEpoch: 0, humanOrdinal: 0, outputOrder: 2 });

    const result = selectCorrectionInjections(storage, request({
      compactEpoch: 1,
      query: "出典確認",
      humanOrdinal: 1,
    }));

    expect(result.rules.slice(0, 2).map((rule) => rule.bundleKey)).toEqual(["always-one", "always-two"]);
    expect(result.rules.slice(0, 2).every((rule) => rule.delivery === "restore")).toBe(true);
    expect(result.rules[2]).toMatchObject({ bundleKey: "related-project", delivery: "related" });
  });

  it("reinjection offではrequest_repeat根拠で従来どおり10発話冷却を解除する", () => {
    process.env.WASURENAGUSA_CORRECTION_REINJECT = "off";
    addRule({ bundleKey: "reconfirmed-rule", topicKey: "tone" });
    addEmission("reconfirmed-rule", { humanOrdinal: 1 });
    addCorrectionEvidence("reconfirmed-rule", 2, "request_repeat");

    const result = selectCorrectionInjections(storage, request({ humanOrdinal: 2 }));

    expect(result.rules).toEqual([expect.objectContaining({
      bundleKey: "reconfirmed-rule",
      delivery: "restore",
    })]);
  });

  it("reinjection onでは一致したutterance_detection根拠で10発話冷却を解除する", () => {
    process.env.WASURENAGUSA_CORRECTION_REINJECT = "on";
    addRule({ bundleKey: "reconfirmed-rule-on", topicKey: "tone" });
    addEmission("reconfirmed-rule-on", { humanOrdinal: 1 });
    addCorrectionEvidence("reconfirmed-rule-on", 2, "utterance_detection");

    const result = selectCorrectionInjections(storage, request({ humanOrdinal: 2 }));

    expect(result.rules).toEqual([expect.objectContaining({
      bundleKey: "reconfirmed-rule-on",
      delivery: "restore",
    })]);
  });

  it("関連規則は2件までに制限する", () => {
    addRule({ bundleKey: "related-a", topicKey: "verification", visibility: "project", ruleText: "出典確認を行う合成規則" });
    addRule({ bundleKey: "related-b", topicKey: "tone", visibility: "project", ruleText: "出典確認の条件を残す合成規則" });
    addRule({ bundleKey: "related-c", topicKey: "document_delivery", visibility: "project", ruleText: "出典確認の結果を示す合成規則" });

    const result = selectCorrectionInjections(storage, request({ query: "出典確認" }));

    expect(result.rules).toHaveLength(2);
    expect(result.rules.every((rule) => rule.delivery === "related")).toBe(true);
  });

  it("常時規則も関連分から再提示でき、10発話冷却と束版重複除去を守る", () => {
    addRule({ bundleKey: "always-related", topicKey: "document_delivery", ruleText: "全文提示の条件を守る合成規則" });
    addEmission("always-related", { humanOrdinal: 1, trigger: "prompt" });
    process.env.WASURENAGUSA_CORRECTION_REINJECT = "off";

    const cooled = selectCorrectionInjections(storage, request({ query: "全文提示", humanOrdinal: 11 }));
    const afterCooldown = selectCorrectionInjections(storage, request({ query: "全文提示", humanOrdinal: 12 }));

    expect(cooled.rules.map((rule) => rule.bundleKey)).not.toContain("always-related");
    expect(afterCooldown.rules.map((rule) => rule.bundleKey)).toContain("always-related");
  });

  it("既定onでも話題一致だけでは冷却中の確定束を再注入しない", () => {
    addRule({ bundleKey: "repeated-related", topicKey: "document_delivery", ruleText: "全文提示の条件を守る合成規則" });
    addEmission("repeated-related", { humanOrdinal: 1, trigger: "prompt" });
    delete process.env.WASURENAGUSA_CORRECTION_REINJECT;

    const result = selectCorrectionInjections(storage, request({ query: "全文提示", humanOrdinal: 2 }));

    expect(result.rules.map((rule) => rule.bundleKey)).not.toContain("repeated-related");
  });

  it("『だから全文出せって』だけが全文注意の冷却を解除し、保存場所の質問は解除しない", () => {
    const initial = detectSyntheticCandidates("全文出して")[0];
    const correction = detectSyntheticCandidates("だから全文出せって").find((candidate) =>
      candidate.source === "utterance_detection",
    );
    if (!initial?.bundleKey || !correction?.bundleKey) throw new Error("synthetic correction bundle was not detected");
    expect(correction.bundleKey).toBe(initial.bundleKey);
    const storedKey = storedBundleKey(
      initial.bundleKey,
      "fixture-project",
      "backend",
      "synthetic-session",
      initial.lifetimeKind,
      "project",
    );
    addRule({
      bundleKey: storedKey,
      topicKey: "document_delivery",
      ruleText: "文章は全文を表示する",
      visibility: "project",
    });
    addEmission(storedKey, { humanOrdinal: 1, trigger: "prompt" });

    const corrected = selectCorrectionInjections(storage, request({
      query: "だから全文出せって",
      humanOrdinal: 2,
      detectedStoredCorrectionBundleKeys: [storedKey],
    }));
    const unrelated = detectSyntheticCandidates("文書の保存場所は？");
    const unrelatedCorrectionBundleKeys = unrelated.flatMap((candidate) => {
      if (candidate.source !== "utterance_detection" || !candidate.bundleKey) return [];
      return [candidate.bundleKey];
    });
    const askedLocation = selectCorrectionInjections(storage, request({
      query: "文書の保存場所は？",
      humanOrdinal: 2,
      detectedStoredCorrectionBundleKeys: unrelatedCorrectionBundleKeys,
    }));

    expect(corrected.rules.map((rule) => rule.bundleKey)).toContain(storedKey);
    expect(corrected.correctionMatchedReinjectionKeys).toContain(`${storedKey}:1`);
    expect(unrelated).toEqual([]);
    expect(askedLocation.rules.map((rule) => rule.bundleKey)).not.toContain(storedKey);
  });

  it("同じ話題の別注意を訂正したとき、その束だけ冷却を解除する", () => {
    const fullText = detectSyntheticCandidates("全文出して")[0];
    const externalDocument = detectSyntheticCandidates("今後は社外向け文書は全文を出して")[0];
    const correction = detectSyntheticCandidates("前にも言った、今後は社外向け文書は全文を出せ")
      .find((candidate) => candidate.source === "utterance_detection");
    if (!fullText?.bundleKey || !externalDocument?.bundleKey || !correction?.bundleKey) {
      throw new Error("synthetic correction bundles were not detected");
    }
    expect(correction.bundleKey).toBe(externalDocument.bundleKey);
    expect(correction.bundleKey).not.toBe(fullText.bundleKey);
    const fullTextStoredKey = storedBundleKey(
      fullText.bundleKey,
      "fixture-project",
      "backend",
      "synthetic-session",
      fullText.lifetimeKind,
      "project",
    );
    const externalStoredKey = storedBundleKey(
      externalDocument.bundleKey,
      "fixture-project",
      "backend",
      "synthetic-session",
      externalDocument.lifetimeKind,
      "project",
    );
    addRule({
      bundleKey: fullTextStoredKey,
      topicKey: "document_delivery",
      ruleText: "文章は全文を表示する",
      visibility: "project",
    });
    addRule({
      bundleKey: externalStoredKey,
      topicKey: "document_delivery",
      ruleText: "社外向け文書は毎回全文を表示する",
      visibility: "project",
    });
    addEmission(fullTextStoredKey, { humanOrdinal: 1, trigger: "prompt" });
    addEmission(externalStoredKey, { humanOrdinal: 1, trigger: "prompt", outputOrder: 2 });

    const result = selectCorrectionInjections(storage, request({
      query: "前にも言った、今後は社外向け文書は全文を出せ",
      humanOrdinal: 2,
      detectedStoredCorrectionBundleKeys: [externalStoredKey],
    }));

    expect(result.rules.map((rule) => rule.bundleKey)).toEqual([externalStoredKey]);
    expect(result.correctionMatchedReinjectionKeys).toEqual([`${externalStoredKey}:1`]);
  });

  it.each([
    { mode: "shadow", state: "candidate", shouldReinject: false },
    { mode: "off", state: "confirmed", shouldReinject: false },
    { mode: "on", state: "candidate", shouldReinject: false },
    { mode: "on", state: "cancelled", shouldReinject: false },
    { mode: "on", state: "confirmed", shouldReinject: true },
  ] as const)("原則構成員による冷却解除は有効なon原則だけに限る ($mode/$state)", (scenario) => {
    migrateToV13();
    process.env.WASURENAGUSA_PRINCIPLES = scenario.mode;
    process.env.WASURENAGUSA_CORRECTION_REINJECT = "on";
    process.env.WASURENAGUSA_OWNER_SCOPE_BEHAVIOR = "off";
    const memberA = `oc:v2:${"a".repeat(64)}`;
    const memberB = `oc:v2:${"b".repeat(64)}`;
    const principleKey = `pr:v1:${"c".repeat(64)}`;
    const sharedRuleText = "文章は毎回全文で表示する合成規則";
    addRule({ bundleKey: memberA, topicKey: "document_delivery", ruleText: sharedRuleText, visibility: "project" });
    addRule({ bundleKey: memberB, topicKey: "document_delivery", ruleText: sharedRuleText, visibility: "project" });
    addRule({ bundleKey: principleKey, topicKey: "principle", ruleText: sharedRuleText, visibility: "project" });
    storage.runCorrectionTransaction(({ db }) => {
      db.prepare(`
        INSERT INTO owner_correction_principle_members (
          principle_key, member_key, attached_at, attach_source
        ) VALUES (?, ?, '2026-10-02T00:00:00.000Z', 'cluster')
      `).run(principleKey, memberA);
      db.prepare(`
        INSERT INTO owner_correction_principle_members (
          principle_key, member_key, attached_at, attach_source
        ) VALUES (?, ?, '2026-10-02T00:00:00.000Z', 'cluster')
      `).run(principleKey, memberB);
      if (scenario.state === "candidate") {
        db.prepare("UPDATE owner_correction_bundles SET status = 'candidate' WHERE bundle_key = ?").run(principleKey);
        db.prepare("UPDATE owner_correction_versions SET status = 'candidate' WHERE bundle_key = ?").run(principleKey);
      }
    });
    if (scenario.state === "cancelled") {
      const eventId = "synthetic-principle-cancellation";
      addEvent(eventId, "2026-10-03T00:00:00.000Z");
      storage.runCorrectionTransaction((transaction) => cancelCorrectionBundle(transaction, {
        bundleKey: principleKey,
        eventId,
        at: "2026-10-03T00:00:00.000Z",
      }));
    }
    addEmission(memberA, { humanOrdinal: 1, trigger: "prompt" });
    addCorrectionEvidence(memberB, 2);

    const result = selectCorrectionInjections(storage, request({
      query: "だから全文出せって",
      humanOrdinal: 2,
      detectedStoredCorrectionBundleKeys: [memberB],
    }));

    expect(result.rules.map((rule) => rule.bundleKey).includes(memberA)).toBe(scenario.shouldReinject);
    expect(result.correctionMatchedReinjectionKeys.includes(`${memberA}:1`)).toBe(scenario.shouldReinject);
  });

  it("同じ原則の構成元への訂正は原則束の冷却を解除する", () => {
    migrateToV13();
    process.env.WASURENAGUSA_PRINCIPLES = "on";
    const member = detectSyntheticCandidates("だから全文出せって").find((candidate) =>
      candidate.source === "utterance_detection",
    );
    if (!member?.bundleKey) throw new Error("synthetic principle member was not detected");
    const memberStoredKey = storedBundleKey(
      member.bundleKey,
      "fixture-project",
      "backend",
      "synthetic-session",
      member.lifetimeKind,
      "project",
    );
    const principleKey = `pr:v1:${"a".repeat(64)}`;
    addRule({
      bundleKey: principleKey,
      topicKey: "document_delivery",
      ruleText: "文章は毎回全文を表示する",
      visibility: "project",
    });
    addRule({
      bundleKey: memberStoredKey,
      topicKey: "document_delivery",
      ruleText: "文章は全文を表示する",
      visibility: "project",
    });
    storage.runCorrectionTransaction(({ db }) => {
      db.prepare(`
        INSERT INTO owner_correction_principle_members (
          principle_key, member_key, attached_at, attach_source
        ) VALUES (?, ?, '2026-10-02T00:00:00.000Z', 'cluster')
      `).run(principleKey, memberStoredKey);
    });
    addEmission(principleKey, { humanOrdinal: 1, trigger: "prompt" });

    const result = selectCorrectionInjections(storage, request({
      query: "だから全文出せって",
      humanOrdinal: 2,
      detectedStoredCorrectionBundleKeys: [memberStoredKey],
    }));

    expect(result.rules.map((rule) => rule.bundleKey)).toContain(principleKey);
    expect(result.rules.map((rule) => rule.bundleKey)).not.toContain(memberStoredKey);
    expect(result.correctionMatchedReinjectionKeys).toContain(`${principleKey}:1`);
  });

  it("無関係な話題では冷却中の確定束を再注入しない", () => {
    addRule({ bundleKey: "unrelated-confirmed", topicKey: "document_delivery", ruleText: "全文提示の条件を守る合成規則" });
    addEmission("unrelated-confirmed", { humanOrdinal: 1, trigger: "prompt" });

    const result = selectCorrectionInjections(storage, request({ query: "無関係な合成検索語", humanOrdinal: 2 }));

    expect(result.rules.map((rule) => rule.bundleKey)).not.toContain("unrelated-confirmed");
  });

  it("環境変数offでは関連一致も従来どおり10発話冷却する", () => {
    addRule({ bundleKey: "disabled-reinjection", topicKey: "document_delivery", ruleText: "全文提示の条件を守る合成規則" });
    addEmission("disabled-reinjection", { humanOrdinal: 1, trigger: "prompt" });
    process.env.WASURENAGUSA_CORRECTION_REINJECT = " OFF ";

    const duringCooldown = selectCorrectionInjections(storage, request({ query: "全文提示", humanOrdinal: 11 }));
    const afterCooldown = selectCorrectionInjections(storage, request({ query: "全文提示", humanOrdinal: 12 }));

    expect(duringCooldown.rules.map((rule) => rule.bundleKey)).not.toContain("disabled-reinjection");
    expect(afterCooldown.rules.map((rule) => rule.bundleKey)).toContain("disabled-reinjection");
  });

  it("定期refreshでも冷却中の関連一致を同じ発話に再注入し、周期枠を保つ", () => {
    addRule({ bundleKey: "refresh-related", topicKey: "document_delivery", ruleText: "全文提示の条件を守る合成規則", visibility: "project" });
    addRule({ bundleKey: "refresh-routine", topicKey: "verification", ruleText: "出典を確認する合成規則" });
    addEmission("refresh-related", { humanOrdinal: 21, trigger: "prompt" });
    addEmission("refresh-routine", { humanOrdinal: 0, trigger: "start" });
    addCorrectionEvidence("refresh-related", 31);
    delete process.env.WASURENAGUSA_CORRECTION_REINJECT;

    const selection = selectCorrectionInjections(storage, request({
      query: "全文提示",
      trigger: "refresh",
      humanOrdinal: 31,
    }));
    selection.rules.forEach((rule, index) => addEmission(rule.bundleKey, {
      humanOrdinal: 31,
      trigger: "refresh",
      outputOrder: index + 1,
    }));
    const retry = selectCorrectionInjections(storage, request({
      query: "全文提示",
      trigger: "refresh",
      humanOrdinal: 31,
    }));
    const rendered = renderCorrectionRules({ trigger: "refresh", rules: selection.rules, budgetTokens: 8000 });

    expect(selection.rules).toEqual([
      expect.objectContaining({ bundleKey: "refresh-related", delivery: "refresh" }),
      expect.objectContaining({ bundleKey: "refresh-routine", delivery: "refresh" }),
    ]);
    expect(retry.rules.map((rule) => rule.bundleKey)).not.toContain("refresh-related");
    expect(rendered.includedRules.map((rule) => rule.bundleKey)).toEqual([
      "refresh-related",
      "refresh-routine",
    ]);
    expect(rendered.tokenCount).toBeLessThanOrEqual(800);
  });

  it("refreshの復元候補と冷却中の関連一致は2件枠内で関連一致を先に選ぶ", () => {
    addRule({ bundleKey: "refresh-related-cap", topicKey: "document_delivery", ruleText: "全文提示の条件を守る合成規則", visibility: "project" });
    addRule({ bundleKey: "refresh-restore-a", topicKey: "tone" });
    addRule({ bundleKey: "refresh-restore-b", topicKey: "verification" });
    addEmission("refresh-related-cap", { humanOrdinal: 21, trigger: "prompt" });
    addCorrectionEvidence("refresh-related-cap", 31);
    delete process.env.WASURENAGUSA_CORRECTION_REINJECT;

    const selection = selectCorrectionInjections(storage, request({
      query: "全文提示",
      trigger: "refresh",
      humanOrdinal: 31,
    }));

    expect(selection.rules).toEqual([
      expect.objectContaining({ bundleKey: "refresh-related-cap", delivery: "refresh" }),
      expect.objectContaining({ bundleKey: "refresh-restore-a", delivery: "restore" }),
    ]);
    expect(selection.rules).toHaveLength(2);
  });

  it("refreshではcompliance復元を先にし、関連一致を既存2件枠内で次に選ぶ", () => {
    addRule({ bundleKey: "refresh-compliance-priority", topicKey: "tone", ruleText: "常体で回答する" });
    addRule({ bundleKey: "refresh-related-after-compliance", topicKey: "document_delivery", ruleText: "全文提示の条件を守る合成規則", visibility: "project" });
    addRule({ bundleKey: "refresh-restore-after-related", topicKey: "verification" });
    addEmission("refresh-compliance-priority", { humanOrdinal: 1, trigger: "start" });
    addComplianceViolation("refresh-compliance-priority", 2);
    addEmission("refresh-related-after-compliance", { humanOrdinal: 21, trigger: "prompt" });
    addCorrectionEvidence("refresh-related-after-compliance", 31);
    process.env.WASURENAGUSA_CORRECTION_COMPLIANCE = "on";
    delete process.env.WASURENAGUSA_CORRECTION_REINJECT;

    const selection = selectCorrectionInjections(storage, request({
      query: "全文提示",
      trigger: "refresh",
      humanOrdinal: 31,
    }));
    const rendered = renderCorrectionRules({ trigger: "refresh", rules: selection.rules, budgetTokens: 8000 });

    expect(selection.rules).toEqual([
      expect.objectContaining({
        bundleKey: "refresh-compliance-priority",
        delivery: "restore",
        complianceViolation: true,
      }),
      expect.objectContaining({ bundleKey: "refresh-related-after-compliance", delivery: "refresh" }),
    ]);
    expect(selection.rules).toHaveLength(2);
    expect(rendered.includedRules.map((rule) => rule.bundleKey)).toEqual([
      "refresh-compliance-priority",
      "refresh-related-after-compliance",
    ]);
    expect(rendered.tokenCount).toBeLessThanOrEqual(800);
  });

  it("関連再注入の最終本文は発話の800 token上限を超えない", () => {
    const longRuleText = "全文提示の条件を守る合成規則" + "あ".repeat(220);
    addRule({ bundleKey: "budget-related-a", topicKey: "document_delivery", ruleText: longRuleText, visibility: "project" });
    addRule({ bundleKey: "budget-related-b", topicKey: "document_delivery", ruleText: longRuleText, visibility: "project" });
    addRule({ bundleKey: "budget-related-c", topicKey: "document_delivery", ruleText: longRuleText, visibility: "project" });
    addEmission("budget-related-a", { humanOrdinal: 1, trigger: "prompt" });
    addEmission("budget-related-b", { humanOrdinal: 1, trigger: "prompt" });
    addEmission("budget-related-c", { humanOrdinal: 1, trigger: "prompt" });
    addCorrectionEvidence("budget-related-a", 2);
    addCorrectionEvidence("budget-related-b", 2);
    addCorrectionEvidence("budget-related-c", 2);

    const selection = selectCorrectionInjections(storage, request({ query: "全文提示", humanOrdinal: 2 }));
    const rendered = renderCorrectionRules({ trigger: "prompt", rules: selection.rules, budgetTokens: 8000 });

    expect(selection.rules.filter((rule) => rule.delivery === "related")).toHaveLength(2);
    expect(rendered.tokenCount).toBeLessThanOrEqual(800);
    expect(rendered.includedRules.every((rule) => rule.ruleText.length <= 240)).toBe(true);
  });

  it("同一束版が未到達復元と関連検索に重複しても1件だけ選ぶ", () => {
    const keys = ["tone", "response_policy", "expression_policy", "verification", "delegation_roles", "storage_location"];
    keys.forEach((topicKey, index) => addRule({ bundleKey: "start-" + index, topicKey }));
    addRule({ bundleKey: "unreached-related", topicKey: "document_delivery", ruleText: "全文提示の条件を守る合成規則" });

    const start = selectCorrectionInjections(storage, request({ trigger: "start", humanOrdinal: 0 }));
    start.rules.forEach((rule, index) => addEmission(rule.bundleKey, { humanOrdinal: 0, outputOrder: index + 1 }));
    const next = selectCorrectionInjections(storage, request({ query: "全文提示", humanOrdinal: 1 }));
    const matchingRules = next.rules.filter((rule) => rule.bundleKey === "unreached-related" && rule.version === 1);

    expect(matchingRules).toHaveLength(1);
    expect(matchingRules[0].delivery).toBe("restore");
  });

  it("違反規則を次のUserPromptSubmitで冷却を無視してrestore先頭へ戻す", () => {
    addRule({ bundleKey: "violated-tone", topicKey: "tone", ruleText: "常体で回答する" });
    addRule({ bundleKey: "cooled-rule", topicKey: "verification" });
    addEmission("violated-tone", { humanOrdinal: 1, trigger: "start" });
    addEmission("cooled-rule", { humanOrdinal: 1, trigger: "prompt" });
    addComplianceViolation("violated-tone", 2);

    const result = selectCorrectionInjections(storage, request({
      query: "関係のない合成語",
      humanOrdinal: 3,
    }));

    expect(result.rules[0]).toMatchObject({
      bundleKey: "violated-tone",
      delivery: "restore",
    });
  });

  it("定期UserPromptSubmitで3種の違反規則をrestoreとして全件選ぶ", () => {
    const rules = [
      { bundleKey: "violated-tone-refresh", topicKey: "tone", checker: "tone" as const, ruleText: "常体で回答する" },
      { bundleKey: "violated-document-refresh", topicKey: "document_delivery", checker: "document_delivery" as const, ruleText: "全文を表示する" },
      { bundleKey: "violated-expression-refresh", topicKey: "expression_policy", checker: "expression_policy" as const, ruleText: "工程略号を使わない" },
    ];

    for (const rule of rules) {
      addRule({ bundleKey: rule.bundleKey, topicKey: rule.topicKey, ruleText: rule.ruleText });
      addEmission(rule.bundleKey, { humanOrdinal: 1, trigger: "start" });
      addComplianceViolation(rule.bundleKey, 2, rule.checker);
    }

    const result = selectCorrectionInjections(storage, request({
      trigger: "refresh",
      query: "関係のない合成語",
      humanOrdinal: 31,
    }));

    expect(result.rules.map((rule) => rule.bundleKey).sort()).toEqual(rules.map((rule) => rule.bundleKey).sort());
    expect(result.rules.every((rule) => rule.delivery === "restore" && rule.complianceViolation)).toBe(true);
  });

  it("同じ規則の再注入は一sessionで2回まで", () => {
    addRule({ bundleKey: "limited-tone", topicKey: "tone", ruleText: "常体で回答する" });
    addEmission("limited-tone", { humanOrdinal: 1, trigger: "start" });
    addComplianceViolation("limited-tone", 2);
    addEmission("limited-tone", { humanOrdinal: 3, trigger: "prompt" });
    addEmission("limited-tone", { humanOrdinal: 4, trigger: "prompt" });

    const result = selectCorrectionInjections(storage, request({
      query: "関係のない合成語",
      humanOrdinal: 5,
    }));

    expect(result.rules.map((rule) => rule.bundleKey)).not.toContain("limited-tone");
  });

  it("環境変数offで違反規則の再注入を止める", () => {
    addRule({ bundleKey: "disabled-tone", topicKey: "tone", ruleText: "常体で回答する" });
    addEmission("disabled-tone", { humanOrdinal: 1, trigger: "start" });
    addComplianceViolation("disabled-tone", 2);
    const previousValue = process.env.WASURENAGUSA_CORRECTION_COMPLIANCE;
    process.env.WASURENAGUSA_CORRECTION_COMPLIANCE = "off";

    try {
      const result = selectCorrectionInjections(storage, request({
        query: "関係のない合成語",
        humanOrdinal: 3,
      }));

      expect(result.rules.map((rule) => rule.bundleKey)).not.toContain("disabled-tone");
    } finally {
      if (previousValue === undefined) delete process.env.WASURENAGUSA_CORRECTION_COMPLIANCE;
      else process.env.WASURENAGUSA_CORRECTION_COMPLIANCE = previousValue;
    }
  });
});
