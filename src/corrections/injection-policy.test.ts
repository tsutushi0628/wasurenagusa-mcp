import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeCorrectionSchema } from "../storage/correction-schema.js";
import { SQLiteStorage } from "../storage/sqlite.js";
import { selectCorrectionInjections, type CorrectionInjectionRequest } from "./injection-policy.js";

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

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "correction-injection-policy-"));
    dbPath = join(tempDir, "memory.db");
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

  function addCorrectionEvidence(bundleKey: string, humanOrdinal: number): void {
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
        ) VALUES (?, ?, 'request_repeat', 2, 'fixture-v1', '[]', 'negative')
      `).run(eventId, bundleKey);
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
    addRule({ bundleKey: "model-route-1", topicKey: "model_routing", visibility: "project" });
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

  it("同一束への再訂正は10発話冷却を解除する", () => {
    addRule({ bundleKey: "reconfirmed-rule", topicKey: "tone" });
    addEmission("reconfirmed-rule", { humanOrdinal: 1 });
    addCorrectionEvidence("reconfirmed-rule", 2);

    const result = selectCorrectionInjections(storage, request({ humanOrdinal: 2 }));

    expect(result.rules).toEqual([expect.objectContaining({
      bundleKey: "reconfirmed-rule",
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

    const cooled = selectCorrectionInjections(storage, request({ query: "全文提示", humanOrdinal: 11 }));
    const afterCooldown = selectCorrectionInjections(storage, request({ query: "全文提示", humanOrdinal: 12 }));

    expect(cooled.rules.map((rule) => rule.bundleKey)).not.toContain("always-related");
    expect(afterCooldown.rules.map((rule) => rule.bundleKey)).toContain("always-related");
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
});
