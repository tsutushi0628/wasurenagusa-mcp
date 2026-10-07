import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateV10ToV11, migrateV11ToV12, migrateV12ToV13 } from "../storage/migration.js";
import { initializeSchema } from "../storage/schema.js";
import { SQLiteStorage } from "../storage/sqlite.js";
import { selectCorrectionInjections } from "./injection-policy.js";
import { cancelCorrectionBundle } from "./store.js";
import {
  addCorrectionPrincipleMembers,
  buildCorrectionPrincipleAbstractionGroups,
  cancelCorrectionPrinciple,
  confirmCorrectionPrinciple,
  confirmEligibleCorrectionPrinciples,
  createCorrectionPrinciple,
  guardCorrectionPrincipleAbstraction,
  getCorrectionPrincipleEvidence,
  getCorrectionPrinciplesMode,
  shouldConfirmCorrectionPrinciple,
} from "./principles.js";
import { retrieveCorrectionCandidates } from "./retrieval.js";

interface PrincipleRuleInput {
  bundleKey: string;
  sessionIdHash: string;
  observedAt: string;
  rawTextHash: string;
  duplicate?: boolean;
  duplicateSessionIdHash?: string;
  ruleText?: string;
  evidenceConditions?: string;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("訂正原則", () => {
  let directory: string;
  let dbPath: string;
  let storage: SQLiteStorage;
  let previousPrinciplesMode: string | undefined;
  let previousComplianceMode: string | undefined;

  it("PRINCIPLESの不正値はoffに倒して変数名と値をstderrへ出す", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(getCorrectionPrinciplesMode({ WASURENAGUSA_PRINCIPLES: "invalid-principles" })).toBe("off");
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("WASURENAGUSA_PRINCIPLES"));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("invalid-principles"));
    } finally {
      errorSpy.mockRestore();
    }
  });

  beforeEach(() => {
    previousPrinciplesMode = process.env.WASURENAGUSA_PRINCIPLES;
    previousComplianceMode = process.env.WASURENAGUSA_CORRECTION_COMPLIANCE;
    process.env.WASURENAGUSA_PRINCIPLES = "on";
    process.env.WASURENAGUSA_CORRECTION_COMPLIANCE = "on";
    directory = mkdtempSync(join(tmpdir(), "wasurenagusa-principles-test-"));
    dbPath = join(directory, "memory.db");
    const initialStorage = new SQLiteStorage(dbPath);
    initialStorage.initialize();
    initialStorage.close();
    const db = new Database(dbPath);
    migrateV10ToV11(db);
    migrateV11ToV12(db);
    migrateV12ToV13(db);
    db.close();
    storage = new SQLiteStorage(dbPath);
    storage.initialize();
  });

  afterEach(() => {
    storage.close();
    rmSync(directory, { recursive: true, force: true });
    restoreEnvironment("WASURENAGUSA_PRINCIPLES", previousPrinciplesMode);
    restoreEnvironment("WASURENAGUSA_CORRECTION_COMPLIANCE", previousComplianceMode);
  });

  function addConfirmedRule(input: PrincipleRuleInput): void {
    storage.runCorrectionTransaction(({ db, save }) => {
      const ruleText = input.ruleText ?? `合成規則 ${input.bundleKey}`;
      const evidenceConditions = input.evidenceConditions ?? "[]";
      const saved = save({
        category: "dont",
        title: `Synthetic ${input.bundleKey}`,
        content: ruleText,
        tags: ["synthetic"],
        project: "fixture-project",
        scope: "backend",
        intensity: 3,
      });
      db.prepare(`
        INSERT INTO owner_correction_bundles (
          bundle_key, memory_id, rule_text, topic_key, polarity, condition_key, project, scope,
          visibility, status, intensity, occurrence_count, session_count, first_seen_at, last_seen_at,
          expires_at, lifetime_kind, continuation_basis, confirmed_at, version, counterevidence_event_id,
          last_confirmation_asked_at, confirmation_state
        ) VALUES (?, ?, ?, 'verification', 'negative', 'general', 'fixture-project', 'backend',
          'owner', 'confirmed', 3, 2, 2, ?, ?, NULL, 'inferred', 'synthetic-continuation', ?, 1, NULL, NULL, 'none')
      `).run(input.bundleKey, saved.id, ruleText, input.observedAt, input.observedAt, input.observedAt);
      db.prepare(`
        INSERT INTO owner_correction_versions (
          bundle_key, version, rule_text, body_hash, conditions, condition_key, polarity, visibility,
          status, confirmed_at, expires_at, lifetime_kind, continuation_basis, evidence_event_ids,
          effective_from, change_reason
        ) VALUES (?, 1, ?, 'synthetic-body-hash', '[]', 'general', 'negative', 'owner', 'confirmed', ?, NULL,
          'inferred', 'synthetic-continuation', '[]', ?, 'synthetic-fixture')
      `).run(input.bundleKey, ruleText, input.observedAt, input.observedAt);
      const insertEvent = db.prepare(`
        INSERT INTO owner_correction_events (
          event_id, session_id_hash, source_uuid_hash, human_ordinal, observed_at, available_at,
          source_kind, excerpt, previous_action, action_first_locator_hash, action_last_locator_hash,
          project, scope, raw_text_hash, source_locator_hash, processed_at
        ) VALUES (?, ?, NULL, ?, ?, ?, 'user', '合成発話', 'action_unknown', NULL, NULL,
          'fixture-project', 'backend', ?, ?, ?)
      `);
      const insertEvidence = db.prepare(`
        INSERT INTO owner_correction_evidence (
          event_id, bundle_key, source, score, detector_version, conditions, polarity
        ) VALUES (?, ?, 'request_repeat', 2, 'fixture-v1', ?, 'negative')
      `);
      const baseTime = input.observedAt;
      insertEvent.run(
        `event-${input.bundleKey}`,
        input.sessionIdHash,
        1,
        baseTime,
        baseTime,
        input.rawTextHash,
        `locator-${input.bundleKey}`,
        baseTime,
      );
      insertEvidence.run(`event-${input.bundleKey}`, input.bundleKey, evidenceConditions);
      if (input.duplicate) {
        const duplicateAt = baseTime.replace(/:\d{2}\.\d{3}Z$/u, ":45.000Z");
        insertEvent.run(
        `event-${input.bundleKey}-duplicate`,
        input.duplicateSessionIdHash ?? input.sessionIdHash,
          2,
          duplicateAt,
          duplicateAt,
          input.rawTextHash,
          `locator-${input.bundleKey}-duplicate`,
          duplicateAt,
        );
        insertEvidence.run(`event-${input.bundleKey}-duplicate`, input.bundleKey, evidenceConditions);
      }
    });
  }

  function inputFor(sessionIdHash: string, trigger: "start" | "prompt" = "start") {
    return {
      project: "fixture-project",
      scope: "backend",
      query: "合成検証規則",
      at: "2026-10-03T06:00:00.000Z",
      sessionIdHash,
      compactEpoch: 0,
      humanOrdinal: 5,
      trigger,
    } as const;
  }

  it("根拠を別sessionで集計し、重複を1件にして原則を確定する", () => {
    addConfirmedRule({
      bundleKey: "member-one",
      sessionIdHash: "synthetic-session-one",
      observedAt: "2026-10-03T00:01:10.000Z",
      rawTextHash: "same-synthetic-text",
      duplicate: true,
      duplicateSessionIdHash: "synthetic-session-broadcast-copy",
    });
    addConfirmedRule({
      bundleKey: "member-two",
      sessionIdHash: "synthetic-session-two",
      observedAt: "2026-10-03T00:02:10.000Z",
      rawTextHash: "synthetic-text-two",
    });
    addConfirmedRule({
      bundleKey: "member-three",
      sessionIdHash: "synthetic-session-three",
      observedAt: "2026-10-03T00:03:10.000Z",
      rawTextHash: "synthetic-text-three",
    });

    const creation = storage.runCorrectionTransaction((transaction) =>
      createCorrectionPrinciple(transaction, {
        ruleText: "  合成  原則を守る  ", polarity: "negative", at: "2026-10-03T04:00:00.000Z",
      }),
    );
    expect(creation.status).toBe("ready");
    if (creation.status !== "ready") throw new Error("synthetic principle was not created");
    const principleKey = creation.principleKey;
    expect(principleKey).toMatch(/^pr:v1:[0-9a-f]{64}$/u);
    storage.runCorrectionTransaction((transaction) => addCorrectionPrincipleMembers(transaction, {
      principleKey,
      memberBundleKeys: ["member-one", "member-two"],
      attachedAt: "2026-10-03T04:01:00.000Z",
      attachSource: "cluster",
    }));
    storage.runCorrectionTransaction((transaction) => addCorrectionPrincipleMembers(transaction, {
      principleKey,
      memberBundleKeys: ["member-three"],
      attachedAt: "2026-10-03T04:02:00.000Z",
      attachSource: "later_attach",
    }));

    const evidence = storage.runCorrectionTransaction(({ db }) => getCorrectionPrincipleEvidence(db, principleKey));
    expect(evidence).toMatchObject({ evidenceCount: 3, sessionCount: 3 });
    expect(storage.runCorrectionTransaction(({ db }) => shouldConfirmCorrectionPrinciple(db, principleKey)))
      .toBe(true);
    const confirmed = storage.runCorrectionTransaction((transaction) => confirmCorrectionPrinciple(
      transaction,
      { principleKey, at: "2026-10-03T05:00:00.000Z" },
    ));
    expect(confirmed?.status).toBe("confirmed");

    const memberStatuses = storage.runCorrectionTransaction(({ db }) => db.prepare(`
      SELECT status FROM owner_correction_bundles WHERE bundle_key IN ('member-one', 'member-two', 'member-three')
      ORDER BY bundle_key
    `).all());
    expect(memberStatuses).toEqual([{ status: "confirmed" }, { status: "confirmed" }, { status: "confirmed" }]);

    const retrieval = retrieveCorrectionCandidates(storage, inputFor("synthetic-session-check"));
    expect(retrieval.alwaysOn.map((rule) => rule.bundleKey)).toContain(principleKey);
    expect(retrieval.alwaysOn.map((rule) => rule.bundleKey)).not.toContain("member-one");
    expect(retrieval.alwaysOn.map((rule) => rule.bundleKey)).not.toContain("member-two");
    expect(retrieval.alwaysOn.map((rule) => rule.bundleKey)).not.toContain("member-three");

    storage.runCorrectionTransaction(({ db }) => db.prepare(`
      INSERT INTO owner_correction_violations (
        session_id_hash, human_ordinal, bundle_key, version, checker, detected_at
      ) VALUES ('synthetic-session-one', 3, 'member-one', 1, 'tone', '2026-10-03T04:30:00.000Z')
    `).run());
    const injection = selectCorrectionInjections(storage, inputFor("synthetic-session-one", "prompt"));
    expect(injection.rules.map((rule) => rule.bundleKey)).toContain(principleKey);
    expect(injection.rules.map((rule) => rule.bundleKey)).not.toContain("member-one");

    process.env.WASURENAGUSA_PRINCIPLES = "off";
    const disabledRetrieval = retrieveCorrectionCandidates(storage, inputFor("synthetic-session-check"));
    expect(disabledRetrieval.alwaysOn.map((rule) => rule.bundleKey)).not.toContain(principleKey);
    expect(disabledRetrieval.alwaysOn.map((rule) => rule.bundleKey)).toContain("member-one");
    const disabledInjection = selectCorrectionInjections(storage, inputFor("synthetic-session-one", "prompt"));
    expect(disabledInjection.rules.map((rule) => rule.bundleKey)).not.toContain(principleKey);
    expect(disabledInjection.rules.map((rule) => rule.bundleKey)).toContain("member-one");
    process.env.WASURENAGUSA_PRINCIPLES = "on";

    storage.runCorrectionTransaction(({ db }) => db.prepare(`
      INSERT INTO owner_correction_violations (
        session_id_hash, human_ordinal, bundle_key, version, checker, detected_at
      ) VALUES ('synthetic-session-check', 3, ?, 2, 'tone', '2026-10-03T04:30:00.000Z')
    `).run(principleKey));
    storage.runCorrectionTransaction(({ db }) => db.prepare(`
      INSERT INTO owner_correction_injections (
        session_id_hash, compact_epoch, bundle_key, version, human_ordinal, trigger, emitted_at,
        output_order, body_hash, output_hash, token_estimate, body_included, stdout_status
      ) VALUES ('synthetic-session-check', 0, ?, 2, 1, 'start', '2026-10-03T05:30:00.000Z',
        1, 'synthetic-body', 'synthetic-output', 10, 1, 'emitted')
    `).run(principleKey));
    expect(storage.runCorrectionTransaction(({ db }) => db.prepare("PRAGMA foreign_key_check").all()))
      .toEqual([]);

    const cancelled = storage.runCorrectionTransaction((transaction) => cancelCorrectionPrinciple(transaction, {
      principleKey,
      eventId: "event-member-one",
      at: "2026-10-03T06:00:00.000Z",
    }));
    expect(cancelled?.status).toBe("rejected");
    const restored = selectCorrectionInjections(storage, inputFor("synthetic-session-one", "prompt"));
    expect(restored.rules.map((rule) => rule.bundleKey)).toContain("member-one");
  });

  it("shadow候補の構成元が取り消された後はonでも原則を確定しない", () => {
    addConfirmedRule({
      bundleKey: "cancelled-source",
      sessionIdHash: "cancelled-source-session",
      observedAt: "2026-10-03T00:01:10.000Z",
      rawTextHash: "cancelled-source-text",
    });
    addConfirmedRule({
      bundleKey: "active-source",
      sessionIdHash: "active-source-session",
      observedAt: "2026-10-03T00:02:10.000Z",
      rawTextHash: "active-source-text",
    });
    process.env.WASURENAGUSA_PRINCIPLES = "shadow";
    const creation = storage.runCorrectionTransaction((transaction) => createCorrectionPrinciple(transaction, {
      ruleText: "取り消された根拠を使わない",
      polarity: "negative",
      at: "2026-10-03T03:00:00.000Z",
    }));
    if (creation.status !== "ready") throw new Error("synthetic principle was not created");
    const principleKey = creation.principleKey;
    storage.runCorrectionTransaction((transaction) => addCorrectionPrincipleMembers(transaction, {
      principleKey,
      memberBundleKeys: ["cancelled-source", "active-source"],
      attachedAt: "2026-10-03T03:01:00.000Z",
      attachSource: "cluster",
    }));
    storage.runCorrectionTransaction((transaction) => cancelCorrectionBundle(transaction, {
      bundleKey: "cancelled-source",
      eventId: "event-cancelled-source",
      at: "2026-10-03T04:00:00.000Z",
    }));

    process.env.WASURENAGUSA_PRINCIPLES = "on";
    expect(storage.runCorrectionTransaction(({ db }) => getCorrectionPrincipleEvidence(db, principleKey)))
      .toMatchObject({ evidenceCount: 1, sessionCount: 1, eventIds: ["event-active-source"] });
    expect(storage.runCorrectionTransaction(({ db }) => shouldConfirmCorrectionPrinciple(db, principleKey)))
      .toBe(false);
    expect(storage.runCorrectionTransaction((transaction) => confirmEligibleCorrectionPrinciples(
      transaction,
      "2026-10-03T05:00:00.000Z",
    ))).toEqual([]);
    expect(storage.runCorrectionTransaction(({ db }) => db.prepare(`
      SELECT status, memory_id FROM owner_correction_bundles WHERE bundle_key = ?
    `).get(principleKey))).toEqual({ status: "candidate", memory_id: null });
  });

  it("offでは原則を作らず、構成員除外も行わない", () => {
    addConfirmedRule({
      bundleKey: "member-off",
      sessionIdHash: "synthetic-session-off",
      observedAt: "2026-10-03T00:01:10.000Z",
      rawTextHash: "synthetic-text-off",
    });
    process.env.WASURENAGUSA_PRINCIPLES = "off";

    const before = storage.runCorrectionTransaction(({ db }) =>
      db.prepare("SELECT COUNT(*) AS count FROM owner_correction_bundles").get() as { count: number },
    );
    const principleKey = storage.runCorrectionTransaction((transaction) =>
      createCorrectionPrinciple(transaction, {
        ruleText: "合成 原則", polarity: "negative", at: "2026-10-03T04:00:00.000Z",
      }),
    );
    const after = storage.runCorrectionTransaction(({ db }) =>
      db.prepare("SELECT COUNT(*) AS count FROM owner_correction_bundles").get() as { count: number },
    );

    expect(principleKey).toMatchObject({ status: "disabled", principleKey: null });
    expect(after.count).toBe(before.count);
    expect(retrieveCorrectionCandidates(storage, inputFor("synthetic-session-check")).alwaysOn
      .map((rule) => rule.bundleKey)).toContain("member-off");
  });

  it("同報を除いた3 session以上の同趣旨候補を最大10件の群にする", () => {
    const candidates = Array.from({ length: 3 }, (_, index) => ({
      bundleKey: `cluster-${index}`,
      ruleText: ["記録は先に確認する", "記録は先に確認します", "記録は先に確認すること"][index],
      sessionIdHash: `cluster-session-${index}`,
      observedAt: `2026-10-03T00:0${index + 1}:10.000Z`,
      rawTextHash: `cluster-text-${index}`,
    }));
    for (const [index, candidate] of candidates.entries()) {
      addConfirmedRule(index === 0 ? {
        ...candidate,
        duplicate: true,
        duplicateSessionIdHash: "cluster-session-broadcast",
      } : candidate);
    }

    const groups = storage.runCorrectionTransaction(({ db }) => buildCorrectionPrincipleAbstractionGroups(
      db,
      "2026-10-03T04:00:00.000Z",
    ));

    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe("cluster");
    expect(groups[0].memberBundleKeys).toHaveLength(3);
    expect(groups[0].distinctSessionCount).toBe(3);
    expect(groups[0].items.length).toBeLessThanOrEqual(10);
  });

  it("10件を超える連結成分を分割し、全群を10件以内に保つ", () => {
    for (let index = 0; index < 12; index += 1) {
      addConfirmedRule({
        bundleKey: `large-cluster-${index}`,
        sessionIdHash: `large-session-${index}`,
        observedAt: `2026-10-03T00:${String(index + 1).padStart(2, "0")}:10.000Z`,
        rawTextHash: `large-text-${index}`,
      });
    }

    const groups = storage.runCorrectionTransaction(({ db }) => buildCorrectionPrincipleAbstractionGroups(
      db,
      "2026-10-03T04:00:00.000Z",
    ));

    expect(groups).toHaveLength(2);
    expect(groups.every((group) => group.memberBundleKeys.length <= 10)).toBe(true);
    expect(groups.every((group) => group.distinctSessionCount >= 3)).toBe(true);
  });

  it("規則文の類似度が低くてもrequiredValuesKey共有で群を作る", () => {
    const evidenceConditions = JSON.stringify({
      version: 2,
      topicKey: "verification",
      actionKey: "show_evidence",
      polarity: "negative",
      requiredValues: { subject: "合成対象" },
      conditions: [],
      boundaryKey: "general",
      lifetimeKind: "inferred",
      continuationBasis: "synthetic",
      directive: true,
      plainCommandEligible: false,
      question: false,
      toneException: false,
      conditionKnown: true,
    });
    const rules = [
      { key: "value-key-a", text: "赤い表紙を記録しない" },
      { key: "value-key-b", text: "青い箱を保存しない" },
      { key: "value-key-c", text: "緑の資料を保管しない" },
    ];
    for (const [index, rule] of rules.entries()) {
      addConfirmedRule({
        bundleKey: rule.key,
        ruleText: rule.text,
        sessionIdHash: `value-session-${index}`,
        observedAt: `2026-10-03T00:0${index + 1}:10.000Z`,
        rawTextHash: `value-text-${index}`,
        evidenceConditions,
      });
    }

    const groups = storage.runCorrectionTransaction(({ db }) => buildCorrectionPrincipleAbstractionGroups(
      db,
      "2026-10-03T04:00:00.000Z",
    ));

    expect(groups).toHaveLength(1);
    expect(groups[0].memberBundleKeys).toHaveLength(3);
  });

  it("後から来た候補を既存原則へのlater_attach群にする", () => {
    addConfirmedRule({
      bundleKey: "later-old",
      ruleText: "合成対象を保存しない",
      sessionIdHash: "later-session-old",
      observedAt: "2026-10-03T00:01:10.000Z",
      rawTextHash: "later-text-old",
    });
    addConfirmedRule({
      bundleKey: "later-new",
      ruleText: "合成対象は保存しない",
      sessionIdHash: "later-session-new",
      observedAt: "2026-10-03T00:02:10.000Z",
      rawTextHash: "later-text-new",
    });
    const creation = storage.runCorrectionTransaction((transaction) => createCorrectionPrinciple(transaction, {
      ruleText: "合成対象を保存しない",
      polarity: "negative",
      at: "2026-10-03T03:00:00.000Z",
    }));
    if (creation.status !== "ready") throw new Error("synthetic principle was not created");
    const principleKey = creation.principleKey;
    storage.runCorrectionTransaction((transaction) => addCorrectionPrincipleMembers(transaction, {
      principleKey,
      memberBundleKeys: ["later-old"],
      attachedAt: "2026-10-03T03:01:00.000Z",
      attachSource: "cluster",
    }));

    const groups = storage.runCorrectionTransaction(({ db }) => buildCorrectionPrincipleAbstractionGroups(
      db,
      "2026-10-03T04:00:00.000Z",
    ));

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ kind: "later_attach", principleKey, memberBundleKeys: ["later-new"] });
    expect(groups[0].items.map((item) => item.bundleKey)).toEqual([principleKey, "later-new"]);
  });

  it("原則出力は入力由来の語・極性・120字を満たさなければ理由コード付きで拒否する", () => {
    const group = {
      groupId: "g-0001",
      kind: "cluster" as const,
      principleKey: null,
      memberBundleKeys: ["member-a", "member-b"],
      distinctSessionCount: 3,
      items: [
        { id: 1, bundleKey: "member-a", ruleText: "記録を先に確認する" },
        { id: 2, bundleKey: "member-b", ruleText: "記録は先に確認する" },
      ],
    };

    expect(guardCorrectionPrincipleAbstraction(group, {
      group_id: group.groupId,
      verdict: "merge",
      principle: "記録を先に確認する",
      odd_ids: [],
    }, "positive")).toEqual({ accepted: true, reason: null, principle: "記録を先に確認する" });
    expect(guardCorrectionPrincipleAbstraction(group, {
      group_id: group.groupId,
      verdict: "merge",
      principle: "記録の安全性を先に確認する",
      odd_ids: [],
    }, "positive").reason).toBe("unsupported_term");
    expect(guardCorrectionPrincipleAbstraction(group, {
      group_id: group.groupId,
      verdict: "merge",
      principle: "記録を先に確認しない",
      odd_ids: [],
    }, "positive").reason).toBe("polarity_mismatch");
    expect(guardCorrectionPrincipleAbstraction(group, {
      group_id: group.groupId,
      verdict: "merge",
      principle: "記録を先に確認する",
      odd_ids: [2],
    }, "positive").reason).toBe("mixed_intents");
    expect(guardCorrectionPrincipleAbstraction(group, {
      group_id: group.groupId,
      verdict: "merge",
      principle: "記録".repeat(121),
      odd_ids: [],
    }, "positive").reason).toBe("principle_too_long");
  });
});
