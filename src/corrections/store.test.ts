import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeCorrectionSchema } from "../storage/correction-schema.js";
import { SQLiteStorage } from "../storage/sqlite.js";
import { createBundleKey } from "./bundle-key.js";
import { detectOwnerCorrections } from "./detector.js";
import { extractOwnerEvent } from "./events.js";
import {
  correctionConditionKey,
  renderCorrectionRule,
  serializeCorrectionRuleInput,
  type CorrectionRuleInput,
} from "./rule-template.js";
import {
  applyCorrectionEvidence,
  cancelCorrectionBundle,
  disputeCorrectionBundles,
  expireCorrectionBundles,
  getCorrectionVersionAt,
  prepareCorrectionBundle,
  type CorrectionEvidenceInput,
} from "./store.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const START = Date.parse("2026-01-01T00:00:00.000Z");

describe("correction evidence store", () => {
  let tempDir: string;
  let storage: SQLiteStorage;
  let alphaStoredKey: string;

  beforeEach(() => {
    alphaStoredKey = "";
    tempDir = mkdtempSync(join(tmpdir(), "correction-store-"));
    const dbPath = join(tempDir, "memory.db");
    const initialStorage = new SQLiteStorage(dbPath);
    initialStorage.initialize();
    initialStorage.close();

    const db = new Database(dbPath);
    initializeCorrectionSchema(db);
    db.close();

    storage = new SQLiteStorage(dbPath);
    storage.initialize();
  });

  afterEach(() => {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function iso(offsetMs: number): string {
    return new Date(START + offsetMs).toISOString();
  }

  function addEvent(eventId: string, sessionIdHash: string, observedAt: string, project = "fixture-project", scope = "backend"): void {
    storage.runCorrectionTransaction(({ db }) => {
      db.prepare(`
        INSERT INTO owner_correction_events (
          event_id, session_id_hash, source_uuid_hash, human_ordinal, observed_at, available_at,
          source_kind, excerpt, previous_action, action_first_locator_hash, action_last_locator_hash,
          project, scope, raw_text_hash, source_locator_hash, processed_at
        ) VALUES (?, ?, NULL, 1, ?, ?, 'user', '合成発話', 'action_unknown', NULL, NULL,
          ?, ?, 'synthetic-hash', ?, ?)
      `).run(eventId, sessionIdHash, observedAt, observedAt, project, scope, `locator-${eventId}`, observedAt);
    });
  }

  function observation(
    eventId: string,
    at: string,
    overrides: Partial<CorrectionEvidenceInput> = {},
    ruleOverrides: Partial<CorrectionRuleInput> = {},
  ): CorrectionEvidenceInput {
    const topicKey = overrides.topicKey ?? "verification";
    const polarity = overrides.polarity ?? "positive";
    const lifetimeKind = overrides.lifetimeKind ?? "inferred";
    let actionKey = "compare_source";
    let requiredValues: Record<string, string> = { subject: "合成資料", source: "合成原本" };
    if (topicKey === "document_delivery") {
      actionKey = "present_full";
      requiredValues = { documentKind: "合成文書" };
    }
    if (topicKey === "expression_policy") {
      actionKey = "use_terms";
      requiredValues = { term: "合成用語" };
    }
    if (topicKey === "model_routing") {
      actionKey = "route_task";
      requiredValues = { workType: "implementation", model: "Claude Sonnet" };
    }
    if (topicKey === "response_policy") {
      actionKey = "answer";
      requiredValues = { subject: "質問" };
    }
    if (topicKey === "tone") {
      actionKey = "use_casual";
      requiredValues = { audience: "owner", style: "常体" };
    }
    if (topicKey === "unknown") {
      actionKey = "unknown";
      requiredValues = {};
    }
    const continuationBasis = overrides.continuationBasis ?? (
      lifetimeKind === "explicit_continuing" ? "explicit-continuing-command"
        : lifetimeKind === "task" ? "task-scoped-request"
          : lifetimeKind === "routing" ? "temporary-model-routing" : "inferred-repeat"
    );
    const ruleInput: CorrectionRuleInput = {
      version: 2,
      topicKey: topicKey as CorrectionRuleInput["topicKey"],
      actionKey,
      polarity,
      requiredValues,
      conditions: [],
      boundaryKey: `lifetime:${lifetimeKind}`,
      lifetimeKind,
      continuationBasis,
      directive: true,
      question: false,
      toneException: false,
      conditionKnown: topicKey !== "unknown",
      ...ruleOverrides,
    };
    const ruleText = renderCorrectionRule(ruleInput);
    const conditionKey = correctionConditionKey(ruleInput);
    const normalizedText = (ruleInput.commandText ?? "合成規則").normalize("NFKC").replace(/\s+/gu, " ").trim();
    const bundleKey = createBundleKey({
      topicKey: ruleInput.topicKey,
      actionKey: ruleInput.actionKey,
      polarity: ruleInput.polarity,
      conditionKey,
      normalizedText,
      conditionKnown: ruleInput.conditionKnown,
    });
    return {
      eventId,
      at,
      bundleKey,
      ruleText,
      topicKey: ruleInput.topicKey,
      polarity: ruleInput.polarity,
      conditionKey,
      visibility: overrides.visibility ?? "project",
      decision: overrides.decision ?? "candidate",
      lifetimeKind: ruleInput.lifetimeKind,
      continuationBasis: ruleInput.continuationBasis,
      ...(overrides.sessionEndsAt ? { sessionEndsAt: overrides.sessionEndsAt } : {}),
      evidence: {
        source: overrides.evidence?.source ?? "request_repeat",
        score: overrides.evidence?.score ?? 2,
        detectorVersion: overrides.evidence?.detectorVersion ?? "fixture-v1",
        conditions: serializeCorrectionRuleInput(ruleInput),
        polarity: ruleInput.polarity,
      },
    };
  }

  function detectedObservation(text: string, sessionId: string, eventId: string, at: string): CorrectionEvidenceInput {
    const event = extractOwnerEvent({
      type: "user",
      origin: { kind: "human" },
      sessionId,
      uuid: eventId,
      timestamp: at,
      message: { content: text },
    });
    if (!event) throw new Error("synthetic correction event was not extracted");
    const candidate = detectOwnerCorrections(event)[0];
    if (!candidate) throw new Error("synthetic correction candidate was not detected");
    return {
      eventId,
      at,
      bundleKey: candidate.bundleKey,
      ruleText: candidate.ruleText,
      topicKey: candidate.topicKey,
      polarity: candidate.polarity,
      conditionKey: correctionConditionKey(candidate.ruleInput),
      visibility: "project",
      decision: candidate.status,
      lifetimeKind: candidate.lifetimeKind,
      continuationBasis: candidate.ruleInput.continuationBasis,
      evidence: {
        source: candidate.source,
        score: candidate.score,
        detectorVersion: "synthetic-detector-v2",
        conditions: serializeCorrectionRuleInput(candidate.ruleInput),
        polarity: candidate.polarity,
      },
    };
  }

  function apply(input: CorrectionEvidenceInput) {
    const result = storage.runCorrectionTransaction((transaction) => applyCorrectionEvidence(transaction, input));
    if (input.topicKey === "verification") alphaStoredKey = result.bundleKey;
    return result;
  }

  function readBundle(bundleKey = alphaStoredKey) {
    return storage.runCorrectionTransaction(({ db }) => ({
      bundle: db.prepare(`
        SELECT bundle_key, memory_id, rule_text, project, scope, visibility, status, intensity, occurrence_count,
          session_count, first_seen_at, last_seen_at, expires_at, lifetime_kind, continuation_basis,
          confirmed_at, version, counterevidence_event_id, confirmation_state
        FROM owner_correction_bundles WHERE bundle_key = ?
      `).get(bundleKey),
      evidence: db.prepare(`
        SELECT event_id, bundle_key, source, score, detector_version, conditions, polarity
        FROM owner_correction_evidence WHERE bundle_key = ? ORDER BY event_id
      `).all(bundleKey),
      memories: db.prepare(`
        SELECT id, category, title, content, project, scope, intensity, state
        FROM memories ORDER BY id
      `).all(),
      versions: db.prepare(`
        SELECT bundle_key, version, rule_text, body_hash, conditions, condition_key, polarity,
          visibility, status, confirmed_at, expires_at, lifetime_kind, continuation_basis,
          evidence_event_ids, effective_from, change_reason
        FROM owner_correction_versions WHERE bundle_key = ? ORDER BY version
      `).all(bundleKey),
    }));
  }

  function versionAt(bundleKey: string, at: string) {
    return storage.runCorrectionTransaction(({ db }) => getCorrectionVersionAt(db, bundleKey, at));
  }

  it("候補は7日で失効し、30日ちょうどの2件目で確定する", () => {
    const firstInput = observation("event-one", iso(0));
    addEvent("event-one", "session-one", iso(0));
    const prepared = storage.runCorrectionTransaction((transaction) => prepareCorrectionBundle(transaction, {
      firstEventId: firstInput.eventId,
      bundleKey: firstInput.bundleKey,
      ruleText: firstInput.ruleText,
      topicKey: firstInput.topicKey,
      polarity: firstInput.polarity,
      conditionKey: firstInput.conditionKey,
      project: "fixture-project",
      scope: "backend",
      visibility: firstInput.visibility,
      lifetimeKind: firstInput.lifetimeKind,
      continuationBasis: firstInput.continuationBasis,
      conditions: firstInput.evidence.conditions,
      firstSeenAt: iso(0),
    }));
    alphaStoredKey = prepared.bundleKey;
    expect(prepared).toMatchObject({ status: "candidate", occurrenceCount: 0, version: 1, memoryId: null });
    const first = apply(firstInput);
    expect(first).toMatchObject({ status: "candidate", occurrenceCount: 1, sessionCount: 1, version: 1, memoryId: null });
    expect(readBundle().memories).toEqual([]);
    expect(JSON.parse((readBundle().versions[0] as { evidence_event_ids: string }).evidence_event_ids)).toEqual(["event-one"]);

    const expiredAt = iso(7 * DAY_MS);
    const expired = storage.runCorrectionTransaction(({ db, save }) => expireCorrectionBundles({ db, save }, expiredAt));
    expect(expired).toEqual([prepared.bundleKey]);
    expect(readBundle().bundle).toMatchObject({ status: "expired", version: 2, expires_at: expiredAt });

    const secondAt = iso(30 * DAY_MS);
    addEvent("event-two", "session-two", secondAt);
    const second = apply(observation("event-two", secondAt));
    expect(second).toMatchObject({ status: "confirmed", occurrenceCount: 2, sessionCount: 2, version: 3 });
    expect(second.memoryId).toBeTruthy();
    expect(readBundle().memories).toHaveLength(1);
    expect(readBundle().memories[0]).toMatchObject({ category: "dont", content: "合成資料を合成原本と照合する", state: "active" });
    expect(readBundle().versions.map((version: { status: string }) => version.status)).toEqual([
      "candidate", "expired", "confirmed",
    ]);
  });

  it("訂正印のない全文依頼は別sessionで反復しても本文なし候補に留まる", () => {
    const firstAt = iso(0);
    const firstInput = detectedObservation("全文　出して", "session-one", "event-command-one", firstAt);
    addEvent(firstInput.eventId, "session-one", firstAt);
    const first = apply(firstInput);
    expect(first.status).toBe("candidate");

    const secondAt = iso(DAY_MS);
    const secondInput = detectedObservation("全文 出して", "session-two", "event-command-two", secondAt);
    addEvent(secondInput.eventId, "session-two", secondAt);
    expect(secondInput.bundleKey).toBe(firstInput.bundleKey);
    const second = apply(secondInput);

    expect(second).toMatchObject({ status: "candidate", occurrenceCount: 2, sessionCount: 2, memoryId: null });
    expect(readBundle(second.bundleKey).bundle).toMatchObject({ rule_text: "" });
    expect(readBundle(second.bundleKey).memories).toEqual([]);
  });

  it("旧束キーは異なる言い回しを別候補にする", () => {
    const firstAt = iso(0);
    const firstInput = detectedObservation("要約を100字以内にして", "session-one", "event-typed-one", firstAt);
    addEvent(firstInput.eventId, "session-one", firstAt);
    apply(firstInput);

    const secondAt = iso(DAY_MS);
    const secondInput = detectedObservation("要約を100字以内にまとめて", "session-two", "event-typed-two", secondAt);
    addEvent(secondInput.eventId, "session-two", secondAt);
    expect(secondInput.bundleKey).not.toBe(firstInput.bundleKey);
    const second = apply(secondInput);

    expect(second).toMatchObject({ status: "candidate", occurrenceCount: 1, sessionCount: 1, memoryId: null });
    expect(readBundle(second.bundleKey).bundle).toMatchObject({ rule_text: "" });
  });

  it("相談文と述語のないunknown反復は別sessionでも確定しない", () => {
    const consultationAt = iso(0);
    addEvent("event-consultation-one", "session-one", consultationAt);
    const consultation = apply(observation("event-consultation-one", consultationAt, {
      topicKey: "document_delivery",
    }, {
      directive: false,
      question: true,
      commandText: "全文を出すか相談したい",
    }));

    const consultationRepeatAt = iso(DAY_MS);
    addEvent("event-consultation-two", "session-two", consultationRepeatAt);
    const consultationRepeat = apply(observation("event-consultation-two", consultationRepeatAt, {
      topicKey: "document_delivery",
    }, {
      directive: false,
      question: true,
      commandText: "全文を出すか相談したい",
    }));

    const unknownAt = iso(2 * DAY_MS);
    addEvent("event-generic-one", "session-three", unknownAt);
    const generic = apply(observation("event-generic-one", unknownAt, {
      topicKey: "unknown",
    }, {
      commandText: "対応して",
    }));
    const genericRepeatAt = iso(3 * DAY_MS);
    addEvent("event-generic-two", "session-four", genericRepeatAt);
    const genericRepeat = apply(observation("event-generic-two", genericRepeatAt, {
      topicKey: "unknown",
    }, {
      commandText: "対応して",
    }));

    expect(consultationRepeat.status).toBe("candidate");
    expect(genericRepeat).toMatchObject({ status: "candidate", occurrenceCount: 2, sessionCount: 2 });
    expect(consultation.memoryId).toBeNull();
    expect(generic.memoryId).toBeNull();
    expect(readBundle(generic.bundleKey).memories).toEqual([]);
  });

  it("同じ(event,bundle)の再配信は根拠数を増やさず、強度は5で止まる", () => {
    const firstAt = iso(0);
    addEvent("event-one", "session-one", firstAt);
    apply(observation("event-one", firstAt, {
      decision: "confirmed",
      lifetimeKind: "explicit_continuing",
      continuationBasis: "explicit-continuing-command",
      visibility: "owner",
      evidence: { source: "utterance_detection", score: 6, detectorVersion: "fixture-v2", conditions: "", polarity: "positive" },
    }));

    const secondAt = iso(DAY_MS);
    addEvent("event-two", "session-one", secondAt);
    const secondInput = observation("event-two", secondAt, {
      lifetimeKind: "explicit_continuing",
      continuationBasis: "explicit-continuing-command",
      visibility: "owner",
      evidence: { source: "utterance_detection", score: 6, detectorVersion: "fixture-v2", conditions: "", polarity: "positive" },
    });
    const second = apply(secondInput);
    const repeated = apply(secondInput);

    expect(second).toMatchObject({ status: "confirmed", occurrenceCount: 2, sessionCount: 1, intensity: 5 });
    expect(repeated).toEqual(second);
    expect(readBundle().evidence).toHaveLength(2);
    expect(readBundle().memories).toHaveLength(1);
    expect(readBundle().bundle).toMatchObject({ status: "confirmed", visibility: "owner", expires_at: null, intensity: 5 });
  });

  it("推定規則は同一sessionの反復で確定し、別sessionからowner可視になる", () => {
    const firstAt = iso(0);
    addEvent("event-one", "session-one", firstAt);
    apply(observation("event-one", firstAt, { visibility: "owner" }));

    const secondAt = iso(DAY_MS);
    addEvent("event-two", "session-one", secondAt);
    const repeated = apply(observation("event-two", secondAt, { visibility: "owner" }));
    expect(repeated).toMatchObject({ status: "confirmed", occurrenceCount: 2, sessionCount: 1, version: 2 });
    expect(readBundle().bundle).toMatchObject({ visibility: "project" });
    expect(readBundle().memories).toHaveLength(1);

    const thirdAt = iso(2 * DAY_MS);
    addEvent("event-three", "session-two", thirdAt);
    const independent = apply(observation("event-three", thirdAt, { visibility: "owner" }));
    expect(independent).toMatchObject({ status: "confirmed", occurrenceCount: 3, sessionCount: 2, version: 3 });
    expect(readBundle().bundle).toMatchObject({ visibility: "owner", expires_at: iso(32 * DAY_MS) });
    expect(readBundle().memories).toHaveLength(1);
  });

  it("同一session内の異なる言い回しは旧束キーで別候補にする", () => {
    const firstAt = iso(0);
    const firstInput = detectedObservation("要約を100字以内にして", "session-one", "event-same-session-one", firstAt);
    addEvent(firstInput.eventId, "session-one", firstAt);
    apply(firstInput);

    const secondAt = iso(DAY_MS);
    const secondInput = detectedObservation("要約を100字以内にまとめて", "session-one", "event-same-session-two", secondAt);
    addEvent(secondInput.eventId, "session-one", secondAt);
    const second = apply(secondInput);

    expect(secondInput.bundleKey).not.toBe(firstInput.bundleKey);
    expect(second).toMatchObject({ status: "candidate", occurrenceCount: 1, sessionCount: 1, memoryId: null });
    expect(readBundle(second.bundleKey).memories).toEqual([]);
  });

  it("推定confirmedは最終根拠から30日で失効し、active memoryを退避する", () => {
    const observedAt = iso(0);
    addEvent("event-one", "session-one", observedAt);
    apply(observation("event-one", observedAt, { decision: "confirmed" }));

    const deadline = iso(30 * DAY_MS);
    expect(storage.runCorrectionTransaction(({ db, save }) => expireCorrectionBundles({ db, save }, deadline))).toEqual([alphaStoredKey]);
    expect(readBundle().bundle).toMatchObject({ status: "expired", expires_at: deadline, version: 3 });
    expect(readBundle().memories[0]).toMatchObject({ state: "archived" });
    expect(storage.runCorrectionTransaction(({ db, save }) => expireCorrectionBundles({ db, save }, deadline))).toEqual([]);
  });

  it("明示継続は30日を越えて有効で、空の失効走査では変化しない", () => {
    const observedAt = iso(0);
    addEvent("event-one", "session-one", observedAt);
    apply(observation("event-one", observedAt, {
      decision: "confirmed",
      lifetimeKind: "explicit_continuing",
      continuationBasis: "explicit-continuing-command",
      visibility: "owner",
    }));

    expect(storage.runCorrectionTransaction(({ db, save }) => expireCorrectionBundles({ db, save }, iso(60 * DAY_MS)))).toEqual([]);
    expect(readBundle().bundle).toMatchObject({ status: "confirmed", expires_at: null });
    expect(versionAt(alphaStoredKey, iso(60 * DAY_MS)))
      .toMatchObject({ status: "confirmed", expiresAt: null });
  });

  it("規則IDの明示確定を回答済みにし、taskとroutingの期限を守る", () => {
    const observedAt = iso(0);
    addEvent("event-owner-candidate", "session-owner-confirm", observedAt);
    apply(observation("event-owner-candidate", observedAt, {
      lifetimeKind: "inferred",
      continuationBasis: "inferred-repeat",
      visibility: "owner",
    }));
    const ownerConfirmedAt = iso(DAY_MS);
    addEvent("event-owner-confirm", "session-owner-confirm", ownerConfirmedAt);
    const ownerConfirmed = apply(observation("event-owner-confirm", ownerConfirmedAt, {
      decision: "owner_confirmed",
      lifetimeKind: "inferred",
      continuationBasis: "explicit-bundle-id-confirmation",
      visibility: "owner",
    }));
    expect(ownerConfirmed).toMatchObject({ status: "confirmed", version: 2 });
    expect(readBundle().bundle).toMatchObject({
      visibility: "owner",
      confirmation_state: "answered",
      expires_at: iso(31 * DAY_MS),
    });

    addEvent("event-task", "session-task", observedAt);
    const taskInput = observation("event-task", observedAt, {
      lifetimeKind: "task",
      sessionEndsAt: iso(3 * 60 * 60 * 1000),
      decision: "confirmed",
    });
    const task = apply(taskInput);
    expect(task.status).toBe("confirmed");
    expect(readBundle(task.bundleKey).bundle).toMatchObject({ expires_at: iso(3 * 60 * 60 * 1000) });

    const repeatAt = iso(60 * 60 * 1000);
    addEvent("event-task-repeat", "session-task", repeatAt);
    const repeatedTask = apply(observation("event-task-repeat", repeatAt, {
      lifetimeKind: "task",
    }));
    expect(repeatedTask.status).toBe("confirmed");
    expect(readBundle(task.bundleKey).bundle).toMatchObject({ expires_at: iso(3 * 60 * 60 * 1000) });

    addEvent("event-routing", "session-routing", observedAt);
    const routing = apply(observation("event-routing", observedAt, {
      lifetimeKind: "routing",
      decision: "confirmed",
    }));
    expect(readBundle(routing.bundleKey).bundle).toMatchObject({ expires_at: iso(DAY_MS) });
    expect(storage.runCorrectionTransaction(({ db, save }) => expireCorrectionBundles({ db, save }, iso(3 * 60 * 60 * 1000))))
      .toEqual([task.bundleKey]);
    expect(storage.runCorrectionTransaction(({ db, save }) => expireCorrectionBundles({ db, save }, iso(DAY_MS))))
      .toEqual([routing.bundleKey]);

    addEvent("event-model-inferred", "session-model-inferred", observedAt);
    const model = apply(observation("event-model-inferred", observedAt, {
      topicKey: "model_routing",
      lifetimeKind: "inferred",
      decision: "confirmed",
    }));
    expect(readBundle(model.bundleKey).bundle).toMatchObject({ expires_at: iso(30 * DAY_MS) });
  });

  it("取消と相反を停止版として追記し、取消前のconfirmed版を時点指定で復元する", () => {
    const firstAt = iso(0);
    addEvent("event-one", "session-one", firstAt);
    const alpha = apply(observation("event-one", firstAt, { decision: "confirmed" }));
    const secondAt = iso(10 * DAY_MS);
    addEvent("event-two", "session-two", secondAt);
    const conflictEvidence = observation("event-two", secondAt, {
      topicKey: "document_delivery",
      polarity: "positive",
      evidence: { source: "utterance_detection", score: 6, detectorVersion: "fixture-v2", conditions: "", polarity: "positive" },
      decision: "confirmed",
    });
    const beta = apply(conflictEvidence);
    addEvent("event-three", "session-three", secondAt);
    const gamma = apply(observation("event-three", secondAt, {
      topicKey: "expression_policy",
      polarity: "negative",
      evidence: { source: "utterance_detection", score: 6, detectorVersion: "fixture-v2", conditions: "", polarity: "negative" },
      decision: "confirmed",
    }));

    const cancelAt = iso(11 * DAY_MS);
    addEvent("event-cancel", "session-four", cancelAt);
    storage.runCorrectionTransaction(({ db, save }) => cancelCorrectionBundle({ db, save }, {
      bundleKey: alpha.bundleKey,
      eventId: "event-cancel",
      at: cancelAt,
    }));
    const conflictAt = iso(12 * DAY_MS);
    storage.runCorrectionTransaction(({ db, save }) => disputeCorrectionBundles({ db, save }, {
      bundleKeys: [beta.bundleKey, gamma.bundleKey],
      eventId: "event-cancel",
      at: conflictAt,
    }));

    expect(readBundle(alpha.bundleKey).bundle).toMatchObject({ status: "rejected", version: 3, counterevidence_event_id: "event-cancel" });
    expect(readBundle(alpha.bundleKey).memories[0]).toMatchObject({ state: "archived" });
    expect(readBundle(beta.bundleKey).bundle).toMatchObject({ status: "disputed", version: 3, counterevidence_event_id: "event-cancel" });
    expect(readBundle(gamma.bundleKey).bundle).toMatchObject({ status: "disputed", version: 3, counterevidence_event_id: "event-cancel" });
    expect(versionAt(alpha.bundleKey, iso(10 * DAY_MS)))
      .toMatchObject({ status: "confirmed", version: 2 });
    expect(versionAt(alpha.bundleKey, cancelAt))
      .toMatchObject({ status: "rejected", version: 3 });
    expect(versionAt("missing", cancelAt)).toBeNull();
  });

  it("同束の条件分岐を根拠別に保持し、統合した型文で確定する", () => {
    const firstAt = iso(0);
    addEvent("event-proposal", "session-proposal", firstAt);
    const first = observation("event-proposal", firstAt, {
      topicKey: "document_delivery",
      lifetimeKind: "explicit_continuing",
    }, { conditions: ["文案作成時"] });
    const firstResult = apply(first);

    const secondAt = iso(DAY_MS);
    addEvent("event-report", "session-report", secondAt);
    const second = observation("event-report", secondAt, {
      topicKey: "document_delivery",
      lifetimeKind: "explicit_continuing",
    }, { conditions: ["報告作成時"] });
    const secondResult = apply(second);

    expect(first.bundleKey).toBe(second.bundleKey);
    expect(secondResult).toMatchObject({ status: "confirmed", occurrenceCount: 2, sessionCount: 2, version: 2 });
    expect(readBundle(secondResult.bundleKey).bundle).toMatchObject({
      rule_text: "報告作成時または文案作成時は合成文書は毎回全文を表示する",
      status: "confirmed",
    });
    const state = readBundle(secondResult.bundleKey);
    expect(state.evidence.map((item: { conditions: string }) => JSON.parse(item.conditions).conditions)).toEqual([
      ["文案作成時"],
      ["報告作成時"],
    ]);
    expect(JSON.parse((state.versions[1] as { conditions: string }).conditions).conditions)
      .toEqual(["報告作成時", "文案作成時"]);
    expect(state.memories).toMatchObject([{ content: "報告作成時または文案作成時は合成文書は毎回全文を表示する" }]);
  });

  it("質問だけの根拠は2回反復と規則ID確定でもmemoryへ昇格しない", () => {
    const firstAt = iso(0);
    addEvent("event-question-one", "session-question-one", firstAt);
    const first = observation("event-question-one", firstAt, {
      decision: "owner_confirmed",
      lifetimeKind: "explicit_continuing",
      continuationBasis: "explicit-bundle-id-confirmation",
      visibility: "owner",
    }, { question: true, directive: false });
    const firstResult = apply(first);

    const secondAt = iso(DAY_MS);
    addEvent("event-question-two", "session-question-two", secondAt);
    const secondResult = apply(observation("event-question-two", secondAt, {
      decision: "confirmed",
      lifetimeKind: "explicit_continuing",
      continuationBasis: "explicit-bundle-id-confirmation",
      visibility: "owner",
    }, { question: true, directive: false }));

    expect(first.ruleText).toBe("");
    expect(firstResult.bundleKey).toBe(secondResult.bundleKey);
    expect(secondResult).toMatchObject({ status: "candidate", occurrenceCount: 2, memoryId: null });
    expect(readBundle(secondResult.bundleKey).bundle).toMatchObject({ rule_text: "", status: "candidate" });
    expect(readBundle(secondResult.bundleKey).memories).toEqual([]);
  });

  it("命令形を含む相談は即時・反復・規則ID確定でも候補に保つ", () => {
    const consultation = "今後、文書は全文を出すべきか、まず確認して";
    const createConsultation = (
      eventId: string,
      sessionId: string,
      at: string,
      decision: CorrectionEvidenceInput["decision"],
    ): CorrectionEvidenceInput => {
      addEvent(eventId, sessionId, at);
      return observation(eventId, at, {
        topicKey: "document_delivery",
        decision,
        lifetimeKind: "explicit_continuing",
        continuationBasis: "explicit-continuing-command",
        visibility: "owner",
        evidence: { source: "utterance_detection", score: 6, detectorVersion: "fixture-v2", conditions: "", polarity: "positive" },
      }, {
        requiredValues: { documentKind: "文書" },
        question: true,
        commandText: consultation,
      });
    };

    const first = apply(createConsultation("event-consult-one", "session-consult-one", iso(0), "confirmed"));
    const second = apply(createConsultation("event-consult-two", "session-consult-two", iso(DAY_MS), "confirmed"));
    const ownerConfirmed = apply(createConsultation("event-consult-three", "session-consult-three", iso(2 * DAY_MS), "owner_confirmed"));

    expect(first.bundleKey).toBe(second.bundleKey);
    expect(second.bundleKey).toBe(ownerConfirmed.bundleKey);
    expect([first, second, ownerConfirmed].map(({ status, memoryId }) => ({ status, memoryId })))
      .toEqual(Array.from({ length: 3 }, () => ({ status: "candidate", memoryId: null })));
    expect(readBundle(ownerConfirmed.bundleKey).bundle).toMatchObject({ rule_text: "", status: "candidate", occurrence_count: 3 });
    expect(readBundle(ownerConfirmed.bundleKey).memories).toEqual([]);
  });

  it("unknownと未解析条件は即時・反復・ID確定でもmemoryへ昇格しない", () => {
    for (const [label, topicKey, ruleOverrides] of [
      ["unknown", "unknown", {}],
      ["unresolved", "response_policy", { conditionKnown: false }],
    ] as const) {
      const firstAt = iso(0);
      const firstEventId = `event-${label}-one`;
      addEvent(firstEventId, `session-${label}-one`, firstAt);
      const first = observation(firstEventId, firstAt, {
        topicKey,
        decision: "confirmed",
        lifetimeKind: "explicit_continuing",
        continuationBasis: "explicit-continuing-command",
        visibility: "owner",
      }, ruleOverrides);
      const firstResult = apply(first);

      const secondAt = iso(DAY_MS);
      const secondEventId = `event-${label}-two`;
      addEvent(secondEventId, `session-${label}-two`, secondAt);
      const secondResult = apply(observation(secondEventId, secondAt, {
        topicKey,
        decision: "owner_confirmed",
        lifetimeKind: "explicit_continuing",
        continuationBasis: "explicit-bundle-id-confirmation",
        visibility: "owner",
      }, ruleOverrides));

      expect(first.ruleText).toBe("");
      expect(firstResult).toMatchObject({ status: "candidate", occurrenceCount: 1, memoryId: null });
      expect(firstResult.bundleKey).toBe(secondResult.bundleKey);
      expect(secondResult).toMatchObject({ status: "candidate", occurrenceCount: 2, memoryId: null });
      expect(readBundle(secondResult.bundleKey).bundle).toMatchObject({ rule_text: "", status: "candidate" });
      expect(readBundle(secondResult.bundleKey).memories).toEqual([]);
    }
  });

  it("同じ指示でも別projectの候補を同じ束へ混ぜない", () => {
    const firstAt = iso(0);
    addEvent("event-project-one", "session-project-one", firstAt, "project-one");
    const first = apply(observation("event-project-one", firstAt, { topicKey: "document_delivery" }));

    const secondAt = iso(DAY_MS);
    addEvent("event-project-two", "session-project-two", secondAt, "project-two");
    const second = apply(observation("event-project-two", secondAt, { topicKey: "document_delivery" }));

    expect(first.bundleKey).not.toBe(second.bundleKey);
    expect(first.status).toBe("candidate");
    expect(second.status).toBe("candidate");
    expect(readBundle(first.bundleKey).bundle).toMatchObject({ project: "project-one", occurrence_count: 1 });
    expect(readBundle(second.bundleKey).bundle).toMatchObject({ project: "project-two", occurrence_count: 1 });
    expect(readBundle(second.bundleKey).memories).toEqual([]);
  });

  it("owner可視の一般口調は別projectの独立根拠で同束へ昇格する", () => {
    const firstAt = iso(0);
    addEvent("event-tone-one", "session-tone-one", firstAt, "project-one");
    const first = apply(observation("event-tone-one", firstAt, {
      topicKey: "tone",
      visibility: "owner",
    }));

    const secondAt = iso(DAY_MS);
    addEvent("event-tone-two", "session-tone-two", secondAt, "project-two");
    const second = apply(observation("event-tone-two", secondAt, {
      topicKey: "tone",
      visibility: "owner",
    }));

    expect(first.bundleKey).toBe(second.bundleKey);
    expect(second).toMatchObject({ status: "confirmed", occurrenceCount: 2, sessionCount: 2 });
    expect(readBundle(second.bundleKey).bundle).toMatchObject({ visibility: "owner", status: "confirmed" });
    expect(readBundle(second.bundleKey).memories).toMatchObject([{ content: "オーナーへの応答は常体で書く" }]);
  });

  it("同じ動作・必須値・適用範囲の逆極性だけ両方をdisputedへ止める", () => {
    const firstAt = iso(0);
    addEvent("event-positive", "session-positive", firstAt);
    const positive = apply(observation("event-positive", firstAt, {
      topicKey: "document_delivery",
      polarity: "positive",
      decision: "confirmed",
    }));
    expect(positive.status).toBe("confirmed");

    const secondAt = iso(DAY_MS);
    addEvent("event-negative", "session-negative", secondAt);
    const negative = apply(observation("event-negative", secondAt, {
      topicKey: "document_delivery",
      polarity: "negative",
      decision: "confirmed",
    }));

    expect(negative).toMatchObject({ status: "disputed", memoryId: null });
    expect(readBundle(positive.bundleKey).bundle).toMatchObject({ status: "disputed" });
    expect(readBundle(positive.bundleKey).memories[0]).toMatchObject({ state: "archived" });
    expect(readBundle(negative.bundleKey).bundle).toMatchObject({ status: "disputed", memory_id: null });
  });

  it("重ならない条件分岐の逆極性は停止相反にしない", () => {
    const firstAt = iso(0);
    addEvent("event-branch-positive", "session-branch-positive", firstAt);
    const positive = apply(observation("event-branch-positive", firstAt, {
      topicKey: "document_delivery",
      polarity: "positive",
      decision: "confirmed",
    }, { conditions: ["文案作成時"] }));

    const secondAt = iso(DAY_MS);
    addEvent("event-branch-negative", "session-branch-negative", secondAt);
    const negative = apply(observation("event-branch-negative", secondAt, {
      topicKey: "document_delivery",
      polarity: "negative",
      decision: "confirmed",
    }, { conditions: ["報告作成時"] }));

    expect(positive.bundleKey).not.toBe(negative.bundleKey);
    expect(positive.status).toBe("confirmed");
    expect(negative.status).toBe("confirmed");
    expect(readBundle(positive.bundleKey).bundle).toMatchObject({ status: "confirmed" });
    expect(readBundle(negative.bundleKey).bundle).toMatchObject({ status: "confirmed" });
  });

  it("30日を1ms越えた単発根拠は2回目昇格に使わない", () => {
    const firstAt = iso(0);
    addEvent("event-one", "session-one", firstAt);
    apply(observation("event-one", firstAt));
    const secondAt = iso(30 * DAY_MS + 1);
    addEvent("event-two", "session-two", secondAt);
    const result = apply(observation("event-two", secondAt));
    expect(result).toMatchObject({ status: "candidate", occurrenceCount: 2, sessionCount: 2, version: 3, memoryId: null });
    expect(readBundle().memories).toEqual([]);
  });
});
