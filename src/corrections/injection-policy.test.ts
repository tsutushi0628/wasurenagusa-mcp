import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeCorrectionSchema } from "../storage/correction-schema.js";
import { migrateV11ToV12, migrateV12ToV13, migrateV13ToV14 } from "../storage/migration.js";
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

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

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
  let projectRoot: string;
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
  let previousRulingsPath: string | undefined;
  let rulingsPath: string;

  beforeEach(() => {
    previousGraduationMode = process.env.WASURENAGUSA_GRADUATION;
    previousGraduationKnowledgePath = process.env.WASURENAGUSA_JEV_KNOWLEDGE_PATH;
    previousPrinciplesMode = process.env.WASURENAGUSA_PRINCIPLES;
    previousStrengthMode = process.env.WASURENAGUSA_STRENGTH;
    previousCorrectionReinjectMode = process.env.WASURENAGUSA_CORRECTION_REINJECT;
    previousCorrectionComplianceMode = process.env.WASURENAGUSA_CORRECTION_COMPLIANCE;
    previousCandidateInjectMode = process.env.WASURENAGUSA_CANDIDATE_INJECT;
    previousOwnerScopeBehaviorMode = process.env.WASURENAGUSA_OWNER_SCOPE_BEHAVIOR;
    previousRulingsPath = process.env.WASURENAGUSA_RULINGS_PATH;
    const scratchRoot = join(process.cwd(), ".tmp");
    mkdirSync(scratchRoot, { recursive: true });
    tempDir = mkdtempSync(join(scratchRoot, "correction-injection-policy-"));
    projectRoot = join(tempDir, "fixture-project");
    mkdirSync(projectRoot, { recursive: true });
    rulingsPath = join(tempDir, "rulings.json");
    process.env.WASURENAGUSA_RULINGS_PATH = rulingsPath;
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
    if (previousRulingsPath === undefined) delete process.env.WASURENAGUSA_RULINGS_PATH;
    else process.env.WASURENAGUSA_RULINGS_PATH = previousRulingsPath;
    vi.restoreAllMocks();
  });

  function migrateToV13(schemaVersion = 13): void {
    storage.close();
    const db = new Database(dbPath);
    migrateV12ToV13(db);
    if (schemaVersion === 14) migrateV13ToV14(db);
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
    excerpt = "synthetic correction",
  ): void {
    storage.runCorrectionTransaction(({ db }) => {
      const eventId = `synthetic-correction-${bundleKey}-${humanOrdinal}`;
      const at = "2026-10-03T00:00:00.000Z";
      db.prepare(`
        INSERT INTO owner_correction_events (
          event_id, session_id_hash, source_uuid_hash, human_ordinal, observed_at, available_at,
          source_kind, excerpt, previous_action, action_first_locator_hash, action_last_locator_hash,
          project, scope, raw_text_hash, source_locator_hash, processed_at
        ) VALUES (?, 'synthetic-session', NULL, ?, ?, ?, 'user', ?, 'action_unknown',
          NULL, NULL, 'fixture-project', 'backend', 'synthetic-raw-hash', ?, ?)
      `).run(eventId, humanOrdinal, at, at, excerpt, `locator-${eventId}`, at);
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
      projectRoot,
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

  function writeRuling(rule: string, quotes: string[], status: string, project: string | null = null, scope = "all"): void {
    writeFileSync(rulingsPath, JSON.stringify({
      rulings: [{
        id: "r-015",
        scene: "合成の回答場面",
        rule,
        quotes: quotes.map((text) => ({ date: "2026-10-01", text })),
        scope,
        project,
        sources: [],
        checks: [],
        status,
        blocked_reason: "",
        recur: 0,
        last_seen: "2026-10-01",
      }],
      resolved_pendings: [],
    }), "utf8");
  }

  describe.each(["start", "prompt", "refresh", "compact"] as const)("指摘リスト照合: %s", (trigger) => {
    it.each([13, 14].flatMap((schemaVersion) =>
      ["excerpt", "commandText", "ruleText"].map((evidenceField) => ({ schemaVersion, evidenceField })),
    ))("v$schemaVersionで束ねた訂正の$evidenceFieldが一致した確定原則も外す", ({ schemaVersion, evidenceField }) => {
      migrateToV13(schemaVersion);
      process.env.WASURENAGUSA_PRINCIPLES = "on";
      const memberKey = `oc:v2:${"1".repeat(64)}`;
      const principleKey = `pr:v1:${"2".repeat(64)}`;
      const retainedKey = `pr:v1:${"3".repeat(64)}`;
      const text = "今後は特定の場合だけ回答を100文字以内にして";
      addRule({ bundleKey: memberKey, topicKey: "verification" });
      addRule({ bundleKey: principleKey, topicKey: "verification", ruleText: "回答の条件を守る合成原則" });
      addRule({ bundleKey: retainedKey, topicKey: "verification", ruleText: "出典を確かめる合成原則" });
      if (evidenceField !== "ruleText") addCorrectionEvidence(memberKey, 1, "legacy_import");
      storage.runCorrectionTransaction(({ db }) => {
        db.prepare(`
          INSERT INTO owner_correction_principle_members (principle_key, member_key, attached_at, attach_source)
          VALUES (?, ?, '2026-10-01T00:00:00.000Z', 'cluster')
        `).run(principleKey, memberKey);
        if (evidenceField === "excerpt") {
          db.prepare("UPDATE owner_correction_events SET excerpt = ? WHERE event_id = ?")
            .run(text, `synthetic-correction-${memberKey}-1`);
        } else if (evidenceField === "commandText") {
          const candidate = detectSyntheticCandidates(text)[0];
          if (candidate === undefined) throw new Error("synthetic evidence command was not detected");
          db.prepare("UPDATE owner_correction_evidence SET conditions = ? WHERE bundle_key = ?")
            .run(serializeCorrectionRuleInput(candidate.ruleInput), memberKey);
        } else {
          db.prepare("UPDATE owner_correction_bundles SET rule_text = ? WHERE bundle_key = ?")
            .run(`　${text}！？　`, memberKey);
        }
      });
      writeRuling("合成の回答規則", [text], "active");

      const result = selectCorrectionInjections(storage, request({ trigger, humanOrdinal: 31 }));

      expect(result.rules.map((rule) => rule.bundleKey)).toEqual([retainedKey]);
      expect(result.unreached.map((rule) => rule.bundleKey)).not.toContain(principleKey);
      expect(result.rulingsExcludedCount).toBe(1);
    });

    it.each(["active", "fixed"])("%sのquotesと本文・証拠が一致した規則だけ外す", (status) => {
      const directKey = "synthetic-ruling-body";
      const evidenceKey = "synthetic-ruling-evidence";
      const retainedKey = "synthetic-design-rule";
      addRule({ bundleKey: directKey, topicKey: "response_policy", ruleText: "おい質問に答えろ" });
      addRule({ bundleKey: evidenceKey, topicKey: "response_policy", ruleText: "問いへの回答を先に示す合成規則" });
      addCorrectionEvidence(evidenceKey, 1, "legacy_import", "おい質問に答えろ");
      storage.runCorrectionTransaction(({ db }) => {
        db.prepare("UPDATE owner_correction_events SET source_kind = 'legacy_import' WHERE event_id = ?")
          .run(`synthetic-correction-${evidenceKey}-1`);
      });
      addRule({ bundleKey: retainedKey, topicKey: "verification", ruleText: "ちゃんと全体設計して。" });
      writeRuling("質問に回答する合成規則", ["おい質問に答えろ"], status);
      vi.mocked(readFileSync).mockClear();

      const result = selectCorrectionInjections(storage, request({ trigger, humanOrdinal: 31 }));

      expect(result.rules.map((rule) => rule.bundleKey)).toEqual([retainedKey]);
      expect(result.rulingsExcludedCount).toBe(2);
      const rendered = renderCorrectionRules({ trigger, rules: result.rules });
      expect(rendered.includedRules.map((rule) => rule.bundleKey)).toEqual([retainedKey]);
      if (trigger === "prompt" || trigger === "refresh") {
        expect(result.unreached).toEqual([{ bundleKey: retainedKey, version: 1, reason: "item_limit" }]);
      } else {
        expect(result.unreached).toEqual([]);
      }
      expect(vi.mocked(readFileSync).mock.calls.filter(([path]) => path === rulingsPath)).toHaveLength(1);
      const rows = storage.runCorrectionTransaction(({ db }) => db.prepare(
        "SELECT status FROM owner_correction_bundles ORDER BY bundle_key",
      ).all());
      expect(rows).toEqual([{ status: "confirmed" }, { status: "confirmed" }, { status: "confirmed" }]);
    });

    it("ruleと一致する本文・証拠も外す", () => {
      addRule({ bundleKey: "synthetic-rule-body", topicKey: "verification", ruleText: "合成の出典を確認する" });
      addRule({ bundleKey: "synthetic-rule-evidence", topicKey: "verification" });
      addCorrectionEvidence("synthetic-rule-evidence", 1, "utterance_detection", "合成の出典を確認する");
      writeRuling("合成の出典を確認する", [], "active");

      const result = selectCorrectionInjections(storage, request({ trigger, humanOrdinal: 31 }));

      expect(result.rules).toEqual([]);
      expect(result.rulingsExcludedCount).toBe(2);
    });

    it.each(["missing", "invalid-json", "invalid-shape"])("%sなら元の注入を続ける", (fileState) => {
      addRule({ bundleKey: "synthetic-preserved-rule", topicKey: "verification", ruleText: "おい質問に答えろ" });
      if (fileState === "invalid-json") writeFileSync(rulingsPath, "{broken-json", "utf8");
      if (fileState === "invalid-shape") writeFileSync(rulingsPath, JSON.stringify({ rulings: null }), "utf8");

      const result = selectCorrectionInjections(storage, request({ trigger, humanOrdinal: 31 }));

      expect(result.rules.map((rule) => rule.bundleKey)).toEqual(["synthetic-preserved-rule"]);
      expect(result.rulingsExcludedCount).toBe(0);
    });
  });

  it.each(["。", "．", ".", "！", "!", "？", "?", "。！？"])("末尾の%s・前後空白・全角半角をそろえて一致する", (suffix) => {
    addRule({ bundleKey: "normalized-body", topicKey: "verification", ruleText: `　ＡＰＩを確認して${suffix}　` });
    addRule({ bundleKey: "normalized-evidence", topicKey: "verification" });
    addCorrectionEvidence("normalized-evidence", 1, "legacy_import", `　ＡＰＩを確認して${suffix}　`);
    writeRuling("APIを確認して。", ["APIを確認して!"], "fixed");

    const result = selectCorrectionInjections(storage, request({ trigger: "start" }));

    expect(result.rules).toEqual([]);
    expect(result.rulingsExcludedCount).toBe(2);
  });

  it.each(["blocked", "open", "inactive"])("status=%sの一致では外さない", (status) => {
    addRule({ bundleKey: "inactive-ruling", topicKey: "verification", ruleText: "おい質問に答えろ" });
    writeRuling("おい質問に答えろ", ["おい質問に答えろ"], status);

    const result = selectCorrectionInjections(storage, request({ trigger: "start" }));

    expect(result.rules.map((rule) => rule.bundleKey)).toEqual(["inactive-ruling"]);
    expect(result.rulingsExcludedCount).toBe(0);
  });

  describe.each(["start", "prompt", "refresh", "compact"] as const)("指摘リストのscope絞り込み: %s", (trigger) => {
    it.each([
      { scope: "sub", excludedCount: 0 },
      { scope: "main", excludedCount: 2 },
      { scope: "all", excludedCount: 2 },
    ])("scope=$scopeなら$excludedCount件を外す", ({ scope, excludedCount }) => {
      const bundleKeys = ["scope-ruling-body", "scope-ruling-evidence"];
      addRule({ bundleKey: bundleKeys[0], topicKey: "verification", ruleText: "合成の出典を確認する" });
      addRule({ bundleKey: bundleKeys[1], topicKey: "verification" });
      addCorrectionEvidence(bundleKeys[1], 1, "legacy_import", "合成の出典を確認する");
      writeRuling("合成の出典を確認する", [], "active", null, scope);

      const result = selectCorrectionInjections(storage, request({ trigger, humanOrdinal: 31 }));

      expect(result.rulingsExcludedCount).toBe(excludedCount);
      if (excludedCount === 0) {
        expect(result.rules.map((rule) => rule.bundleKey).sort()).toEqual(bundleKeys);
      } else {
        expect(result.rules).toEqual([]);
      }
    });
  });

  it.each(["おい質問に答えて", "おい質問に答えろ、先に", "おい 質問に答えろ"])("似ているだけの文「%s」では外さない", (text) => {
    addRule({ bundleKey: "exact-match-only", topicKey: "verification", ruleText: text });
    writeRuling("おい質問に答えろ", ["おい質問に答えろ"], "active");

    const result = selectCorrectionInjections(storage, request({ trigger: "start" }));

    expect(result.rules.map((rule) => rule.bundleKey)).toEqual(["exact-match-only"]);
    expect(result.rulingsExcludedCount).toBe(0);
  });

  it("案件ルートに指摘リストが無ければ別の場所に一致があっても外さない", async () => {
    addRule({ bundleKey: "missing-project-rulings", topicKey: "verification", ruleText: "おい質問に答えろ" });
    writeRuling("おい質問に答えろ", [], "active");
    delete process.env.WASURENAGUSA_RULINGS_PATH;
    const defaultPath = join(projectRoot, ".claude", "rulings", "rulings.json");
    const actual = await vi.importActual<typeof import("fs")>("fs");
    const readRulings = vi.mocked(readFileSync).mockImplementation((...args: Parameters<typeof readFileSync>) => {
      if (args[0] === defaultPath) return actual.readFileSync(...args);
      return actual.readFileSync(rulingsPath, "utf8");
    });
    readRulings.mockClear();
    try {
      const result = selectCorrectionInjections(storage, request({ trigger: "start" }));

      expect(result.rules.map((rule) => rule.bundleKey)).toEqual(["missing-project-rulings"]);
      expect(result.rulingsExcludedCount).toBe(0);
      expect(readRulings.mock.calls).toEqual([[defaultPath, "utf8"]]);
    } finally {
      readRulings.mockImplementation(actual.readFileSync);
    }
  });

  it("セッションの案件名で絞り込み、環境変数が無ければhookの案件ルートから1回だけ読む", () => {
    addRule({ bundleKey: "default-rulings-path", topicKey: "verification", ruleText: "おい質問に答えろ" });
    delete process.env.WASURENAGUSA_RULINGS_PATH;
    rulingsPath = join(projectRoot, ".claude", "rulings", "rulings.json");
    mkdirSync(join(projectRoot, ".claude", "rulings"), { recursive: true });
    writeRuling("おい質問に答えろ", [], "active", "session-project");
    vi.mocked(readFileSync).mockClear();

    const result = selectCorrectionInjections(storage, request({ trigger: "start", project: "session-project" }));

    expect(result.rules).toEqual([]);
    expect(result.rulingsExcludedCount).toBe(1);
    expect(vi.mocked(readFileSync).mock.calls.filter(([path]) => path === rulingsPath)).toHaveLength(1);
  });

  it("案件ルートの.claudeがシンボリックリンクならリンク先の指摘リストで外す", () => {
    addRule({ bundleKey: "linked-rulings", topicKey: "verification", ruleText: "おい質問に答えろ" });
    delete process.env.WASURENAGUSA_RULINGS_PATH;
    const sharedClaudePath = join(tempDir, "shared-claude");
    mkdirSync(join(sharedClaudePath, "rulings"), { recursive: true });
    rulingsPath = join(sharedClaudePath, "rulings", "rulings.json");
    writeRuling("おい質問に答えろ", [], "active", "fixture-project");
    symlinkSync(sharedClaudePath, join(projectRoot, ".claude"), "dir");

    const result = selectCorrectionInjections(storage, request({ trigger: "start" }));

    expect(result.rules).toEqual([]);
    expect(result.rulingsExcludedCount).toBe(1);
  });

  describe.each(["start", "prompt", "refresh", "compact"] as const)("指摘リストの案件絞り込み: %s", (trigger) => {
    it.each([
      { project: "other-project", excludedCount: 0 },
      { project: null, excludedCount: 2 },
      { project: "fixture-project", excludedCount: 0 },
      { project: "session-project", excludedCount: 2 },
    ])("project=$projectなら$excludedCount件を外す", ({ project, excludedCount }) => {
      const bundleKeys = ["scoped-ruling-body", "scoped-ruling-evidence"];
      addRule({ bundleKey: bundleKeys[0], topicKey: "verification", ruleText: "合成の出典を確認する" });
      addRule({ bundleKey: bundleKeys[1], topicKey: "verification" });
      addCorrectionEvidence(bundleKeys[1], 1, "legacy_import", "合成の出典を確認する");
      writeRuling("合成の出典を確認する", [], "active", project);

      const result = selectCorrectionInjections(storage, request({ project: "session-project", trigger, humanOrdinal: 31 }));

      expect(result.rulingsExcludedCount).toBe(excludedCount);
      if (excludedCount === 0) {
        expect(result.rules.map((rule) => rule.bundleKey).sort()).toEqual(bundleKeys);
      } else {
        expect(result.rules).toEqual([]);
      }
    });
  });

  it.each([
    null,
    "invalid-ruling",
    [],
    { rule: 7, quotes: [] },
    { quotes: [] },
    { rule: "壊れた項目の本文" },
    { rule: "壊れた項目の本文", quotes: null },
    { rule: "壊れた項目の本文", quotes: {} },
    { rule: "壊れた項目の本文", quotes: [null] },
    { rule: "壊れた項目の本文", quotes: [{ text: "壊れた項目の証拠" }, { text: 7 }] },
    { rule: "壊れた項目の本文", quotes: [{ text: "壊れた項目の証拠" }], project: {} },
    { rule: "壊れた項目の本文", quotes: [{ text: "壊れた項目の証拠" }], project: undefined },
  ].map((malformed) => ({ malformed })))("形の崩れた項目$malformedだけを飛ばして前後の有効な項目では外す", ({ malformed }) => {
    addRule({ bundleKey: "valid-before", topicKey: "verification", ruleText: "前の有効な合成規則" });
    addRule({ bundleKey: "valid-after", topicKey: "verification", ruleText: "後の有効な合成規則" });
    addRule({ bundleKey: "invalid-body", topicKey: "verification", ruleText: "壊れた項目の本文" });
    addRule({ bundleKey: "invalid-evidence", topicKey: "verification" });
    addCorrectionEvidence("invalid-evidence", 1, "legacy_import", "壊れた項目の証拠");
    let malformedRuling: unknown = malformed;
    if (typeof malformed === "object" && malformed !== null && !Array.isArray(malformed)) {
      malformedRuling = { status: "active", scope: "all", project: null, ...malformed };
    }
    writeFileSync(rulingsPath, JSON.stringify({ rulings: [
      { status: "active", scope: "all", project: null, rule: "前の有効な合成規則", quotes: [] },
      malformedRuling,
      { status: "fixed", scope: "all", project: "fixture-project", rule: "後の有効な合成規則", quotes: [] },
    ] }), "utf8");

    const result = selectCorrectionInjections(storage, request({ trigger: "start" }));

    expect(result.rules.map((rule) => rule.bundleKey).sort()).toEqual(["invalid-body", "invalid-evidence"]);
    expect(result.rulingsExcludedCount).toBe(2);
  });

  it.each(["start", "compact"] as const)("%sの再注入を省く回は証拠の表を読まず本文一致の除外件数を返す", (trigger) => {
    process.env.WASURENAGUSA_CANDIDATE_INJECT = "on";
    addRule({ bundleKey: "excluded-ruling", topicKey: "verification", ruleText: "合成の出典を確認する" });
    addRule({ bundleKey: "already-emitted", topicKey: "verification" });
    addRule({ bundleKey: "unreached-rule", topicKey: "verification" });
    addCorrectionEvidence("unreached-rule", 1, "legacy_import", "合成の出典を確認する");
    addEmission("already-emitted", { trigger, humanOrdinal: 0 });
    writeRuling("合成の出典を確認する", [], "active");
    const evidenceReads = trackRulingEvidenceReads(true);
    vi.mocked(readFileSync).mockClear();

    const result = selectCorrectionInjections(storage, request({ trigger }));

    expect(result.rules).toEqual([]);
    expect(result.rulingsExcludedCount).toBe(1);
    expect(result.unreached).toEqual([{ bundleKey: "unreached-rule", version: 1, reason: "item_limit" }]);
    expect(result.alwaysOnCount).toBe(2);
    expect(evidenceReads).toEqual([]);
    expect(vi.mocked(readFileSync).mock.calls.filter(([path]) => path === rulingsPath)).toHaveLength(1);
  });

  function trackRulingEvidenceReads(includePositions = false): number[] {
    const rowCounts: number[] = [];
    const prepare = Database.prototype.prepare;
    vi.spyOn(Database.prototype, "prepare").mockImplementation(function (this: Database.Database, sql: string) {
      const statement = prepare.call(this, sql);
      if (/^\s*SELECT\s+\*\s+FROM\s+owner_correction_evidence\s+LIMIT\s+0\s*;?\s*$/iu.test(sql)) return statement;
      if ((sql.includes("event.excerpt") && sql.includes("evidence.conditions"))
        || (includePositions && sql.includes("FROM owner_correction_evidence"))) {
        const readAll = statement.all.bind(statement);
        vi.spyOn(statement, "all").mockImplementation((...parameters: unknown[]) => {
          const rows = readAll(...parameters);
          rowCounts.push(rows.length);
          return rows;
        });
      }
      return statement;
    });
    return rowCounts;
  }

  it("候補外の証拠を200行増やしても候補と所属訂正の証拠だけを2行読む", () => {
    migrateToV13();
    process.env.WASURENAGUSA_PRINCIPLES = "on";
    const memberKey = `oc:v2:${"4".repeat(64)}`;
    const principleKey = `pr:v1:${"5".repeat(64)}`;
    addRule({ bundleKey: "evidence-candidate", topicKey: "verification" });
    addRule({ bundleKey: memberKey, topicKey: "verification" });
    addRule({ bundleKey: principleKey, topicKey: "verification" });
    addCorrectionEvidence("evidence-candidate", 1, "legacy_import", "合成の出典を確認する");
    addCorrectionEvidence(memberKey, 1, "legacy_import", "合成の出典を確認する");
    storage.runCorrectionTransaction(({ db }) => {
      db.prepare(`
        INSERT INTO owner_correction_principle_members (principle_key, member_key, attached_at, attach_source)
        VALUES (?, ?, '2026-10-01T00:00:00.000Z', 'cluster')
      `).run(principleKey, memberKey);
    });
    writeRuling("合成の出典を確認する", [], "active");
    const evidenceReads = trackRulingEvidenceReads();

    const before = selectCorrectionInjections(storage, request({ trigger: "start" }));
    addRule({ bundleKey: "outside-candidate", topicKey: "unrelated", visibility: "project", project: "other-project" });
    for (let index = 1; index <= 200; index += 1) {
      addCorrectionEvidence("outside-candidate", index, "legacy_import", `候補外の合成証拠 ${index}`);
    }
    const after = selectCorrectionInjections(storage, request({ trigger: "start" }));

    expect(evidenceReads).toEqual([2, 2]);
    expect(before.rules).toEqual([]);
    expect(after.rules).toEqual([]);
    expect(before.rulingsExcludedCount).toBe(2);
    expect(after.rulingsExcludedCount).toBe(2);
  });

  it.each(["start", "compact"] as const)("%sで使わない関連候補を除外件数に数えない", (trigger) => {
    addRule({ bundleKey: "related-only", topicKey: "verification", intensity: 2, ruleText: "合成の検証を行う" });
    storage.runCorrectionTransaction(({ db }) => {
      db.prepare("UPDATE owner_correction_bundles SET lifetime_kind = 'task' WHERE bundle_key = 'related-only'").run();
      db.prepare("UPDATE owner_correction_versions SET lifetime_kind = 'task' WHERE bundle_key = 'related-only'").run();
    });
    writeRuling("合成の検証を行う", [], "active");

    const result = selectCorrectionInjections(storage, request({ trigger, query: "合成の検証を行う", topicKeys: ["verification"] }));

    expect(result.ftsCandidateCount).toBeGreaterThan(0);
    expect(result.rules).toEqual([]);
    expect(result.rulingsExcludedCount).toBe(0);
  });

  it.each(["prompt", "refresh"] as const)("%sで使わないproject規則を除外件数に数えない", (trigger) => {
    addRule({ bundleKey: "project-only", topicKey: "unrelated", visibility: "project", ruleText: "合成の案件限定規則" });
    writeRuling("合成の案件限定規則", [], "active");

    const result = selectCorrectionInjections(storage, request({ trigger }));

    expect(result.rules).toEqual([]);
    expect(result.rulingsExcludedCount).toBe(0);
  });

  it.each(["prompt", "refresh"] as const)("%sで冷却中の常時規則を除外件数に数えない", (trigger) => {
    addRule({ bundleKey: "cooling-ruling", topicKey: "verification", ruleText: "合成の出典を確認する" });
    addEmission("cooling-ruling", { humanOrdinal: 0 });
    writeRuling("合成の出典を確認する", [], "active");

    const result = selectCorrectionInjections(storage, request({ trigger, humanOrdinal: 1 }));

    expect(result.rules).toEqual([]);
    expect(result.rulingsExcludedCount).toBe(0);
  });

  it.each(["start", "compact"] as const)("%sで配送枠が埋まった後のproject規則を除外件数に数えない", (trigger) => {
    for (let index = 1; index <= 6; index += 1) {
      addRule({ bundleKey: `filled-slot-${index}`, topicKey: `topic-${index}` });
    }
    addRule({ bundleKey: "project-without-slot", topicKey: "unrelated", visibility: "project", ruleText: "合成の案件限定規則" });
    writeRuling("合成の案件限定規則", [], "active");

    const result = selectCorrectionInjections(storage, request({ trigger }));

    expect(result.rules).toHaveLength(6);
    expect(result.rulingsExcludedCount).toBe(0);
  });

  it.each(["prompt", "refresh"] as const)("%sで一致した規則を外してからtopicの配送順を決める", (trigger) => {
    addRule({ bundleKey: "excluded-topic-head", topicKey: "topic-a", intensity: 5, ruleText: "合成の出典を確認する" });
    addRule({ bundleKey: "retained-topic-a", topicKey: "topic-a", intensity: 4 });
    addRule({ bundleKey: "retained-topic-b", topicKey: "topic-b", intensity: 3 });
    writeRuling("合成の出典を確認する", [], "active");

    const result = selectCorrectionInjections(storage, request({ trigger }));

    expect(result.rules.map((rule) => rule.bundleKey)).toEqual(["retained-topic-a", "retained-topic-b"]);
    expect(result.rulingsExcludedCount).toBe(1);
  });

  it.each(["start", "compact"] as const)("%sで冷却中の規則があってもtopicの配送順を保つ", (trigger) => {
    addRule({ bundleKey: "cooling-topic-head", topicKey: "topic-a", intensity: 5 });
    addRule({ bundleKey: "retained-topic-a", topicKey: "topic-a", intensity: 4 });
    addRule({ bundleKey: "retained-topic-b", topicKey: "topic-b", intensity: 3 });
    addEmission("cooling-topic-head", { trigger: "prompt", humanOrdinal: 0 });
    writeRuling("合成の出典を確認する", [], "active");

    const result = selectCorrectionInjections(storage, request({ trigger }));

    expect(result.rules.map((rule) => rule.bundleKey)).toEqual(["retained-topic-b", "retained-topic-a"]);
    expect(result.rulingsExcludedCount).toBe(0);
  });

  it("refreshで一致した復元候補を外して早く返る回も実際の除外数を返す", () => {
    addRule({ bundleKey: "refresh-excluded", topicKey: "verification", ruleText: "合成の出典を確認する" });
    addRule({ bundleKey: "refresh-retained", topicKey: "verification" });
    writeRuling("合成の出典を確認する", [], "active");

    const result = selectCorrectionInjections(storage, request({ trigger: "refresh", humanOrdinal: 1 }));

    expect(result.rules.map((rule) => rule.bundleKey)).toEqual(["refresh-retained"]);
    expect(result.rulingsExcludedCount).toBe(1);
  });

  it("証拠の保存済みcommandTextも照合し、抜粋に含まれない発話の一致で外す", () => {
    const text = "今後は特定の場合だけ回答を100文字以内にして";
    const candidate = detectSyntheticCandidates(text)[0];
    if (candidate === undefined) throw new Error("synthetic evidence command was not detected");
    addRule({ bundleKey: "evidence-command", topicKey: "verification" });
    addCorrectionEvidence("evidence-command", 1, "legacy_import");
    storage.runCorrectionTransaction(({ db }) => {
      db.prepare("UPDATE owner_correction_evidence SET conditions = ? WHERE bundle_key = ?")
        .run(serializeCorrectionRuleInput(candidate.ruleInput), "evidence-command");
    });
    writeRuling("合成の回答規則", [text], "active");

    const result = selectCorrectionInjections(storage, request({ trigger: "start" }));

    expect(result.rules).toEqual([]);
    expect(result.rulingsExcludedCount).toBe(1);
  });

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

  it("提案・Jev受取後も指摘リストに一致しない原則の配送を続ける", () => {
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

    expect(prompt.rules.map((rule) => rule.bundleKey)).toContain(principleKey);
    expect(refresh.rules.map((rule) => rule.bundleKey)).toContain(principleKey);
    expect(start.rules.map((rule) => rule.bundleKey)).toContain(principleKey);
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

  it.each(["start", "prompt", "refresh", "compact"] as const)("卒業済みの全体設計規則も指摘リストに一致しなければ%s注入する", (trigger) => {
    migrateToV13();
    process.env.WASURENAGUSA_GRADUATION = "on";
    const bundleKey = `oc:v2:${"2".repeat(64)}`;
    addRule({ bundleKey, topicKey: "verification", ruleText: "ちゃんと全体設計して。" });
    addCorrectionEvidence(bundleKey, 1, "legacy_import", "ちゃんと全体設計して。");
    storage.runCorrectionTransaction(({ db }) => {
      db.prepare(`
        INSERT INTO owner_correction_graduations (bundle_key, graduated_at, proposal_hash)
        VALUES (?, '2026-10-02T00:00:00.000Z', 'synthetic-proposal-hash')
      `).run(bundleKey);
    });
    const knowledgePath = join(tempDir, "jev-knowledge.graduated.json");
    writeFileSync(knowledgePath, JSON.stringify({
      version: 1,
      cards: [{ id: "g-synthetic", evidence_ids: [bundleKey] }],
    }), "utf8");
    process.env.WASURENAGUSA_JEV_KNOWLEDGE_PATH = knowledgePath;
    writeRuling("合成の回答規則", ["おい質問に答えろ"], "active");

    const result = selectCorrectionInjections(storage, request({ trigger, humanOrdinal: 31 }));

    expect(result.rules.map((rule) => rule.bundleKey)).toEqual([bundleKey]);
    expect(result.rulingsExcludedCount).toBe(0);
    expect(storage.runCorrectionTransaction(({ db }) => db.prepare(
      "SELECT revoked_at FROM owner_correction_graduations WHERE bundle_key = ?",
    ).get(bundleKey))).toEqual({ revoked_at: null });
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

  it("卒業後も新根拠の有無によらず注入し、選択では卒業記録を書き換えない", () => {
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
    expect(beforeEvidence.rules.map((rule) => rule.bundleKey)).toContain(bundleKey);
    addCorrectionEvidence(bundleKey, 1);

    const result = selectCorrectionInjections(storage, request({
      at: "2026-10-04T00:00:00.000Z",
      trigger: "prompt",
      humanOrdinal: 2,
    }));
    const graduation = storage.runCorrectionTransaction(({ db }) => db.prepare(`
      SELECT revoked_at FROM owner_correction_graduations WHERE bundle_key = ?
    `).get(bundleKey) as { revoked_at: string | null });

    expect(graduation.revoked_at).toBeNull();
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

  it("卒業on/offともJev反映済みの原則をprompt注入する", () => {
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

    expect(graduated.rules.map((rule) => rule.bundleKey)).toContain(principleKey);
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
    const rendered = renderCorrectionRules({ trigger: "refresh", rules: selection.rules });
    expect(rendered.includedRules.map((rule) => rule.bundleKey)).toEqual([
      "refresh-related-cap", "refresh-restore-a",
    ]);
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
