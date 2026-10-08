import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { migrateV10ToV11, migrateV11ToV12, migrateV12ToV13 } from "../storage/migration.js";
import { SQLiteStorage } from "../storage/sqlite.js";
import { addFunnelCounts, computeCorrectionFunnel, emptyFunnelCounts, makeCounterReport } from "./funnel.js";

const SINCE = "2026-10-01T00:00:00.000Z";
const UNTIL = "2026-10-02T00:00:00.000Z";
const UNIT_KEY = "oc:v2:synthetic-tone";
const SESSION_HASH = "synthetic-session";

describe("適用機会ファネル", () => {
  let tempDir: string;
  let storage: SQLiteStorage;
  let db: Database.Database;

  beforeEach(() => {
    tempDir = mkdtempSync(join(process.cwd(), ".tmp", "codex-funnel-test-"));
    const dbPath = join(tempDir, "memory.db");
    const initialStorage = new SQLiteStorage(dbPath);
    initialStorage.initialize();
    initialStorage.close();
    const migrationDb = new Database(dbPath);
    migrateV10ToV11(migrationDb);
    migrateV11ToV12(migrationDb);
    migrateV12ToV13(migrationDb);
    migrationDb.close();
    storage = new SQLiteStorage(dbPath);
    db = storage.connection;
  });

  afterEach(() => {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function addBundle(
    bundleKey = UNIT_KEY,
    versions: Array<{
      version: number;
      ruleText?: string;
      status?: "candidate" | "confirmed" | "rejected";
      effectiveFrom?: string;
      confirmedAt?: string | null;
      expiresAt?: string | null;
      evidenceEventIds?: string[];
      topicKey?: string;
      polarity?: "positive" | "negative";
      conditionKey?: string;
    }> = [{ version: 1 }],
  ): void {
    const last = versions.at(-1);
    if (!last) throw new Error("synthetic bundle requires a version");
    db.prepare(`
      INSERT INTO owner_correction_bundles (
        bundle_key, memory_id, rule_text, topic_key, polarity, condition_key, project, scope,
        visibility, status, intensity, occurrence_count, session_count, first_seen_at, last_seen_at,
        expires_at, lifetime_kind, continuation_basis, confirmed_at, version,
        counterevidence_event_id, last_confirmation_asked_at, confirmation_state
      ) VALUES (?, NULL, ?, ?, ?, ?, 'synthetic', 'owner', 'owner', ?, 3, 1, 1, ?, ?, ?,
        'explicit_continuing', 'synthetic', ?, ?, NULL, NULL, 'none')
    `).run(
      bundleKey,
      last.ruleText ?? "回答は常体で書く",
      last.topicKey ?? "tone",
      last.polarity ?? "positive",
      last.conditionKey ?? "general",
      last.status ?? "confirmed",
      last.effectiveFrom ?? SINCE,
      last.effectiveFrom ?? SINCE,
      last.expiresAt ?? null,
      last.confirmedAt === undefined ? last.effectiveFrom ?? SINCE : last.confirmedAt,
      last.version,
    );
    const insertVersion = db.prepare(`
      INSERT INTO owner_correction_versions (
        bundle_key, version, rule_text, body_hash, conditions, condition_key, polarity, visibility,
        status, confirmed_at, expires_at, lifetime_kind, continuation_basis, evidence_event_ids,
        effective_from, change_reason
      ) VALUES (?, ?, ?, ?, '[]', ?, ?, 'owner', ?, ?, ?, 'explicit_continuing', 'synthetic', ?, ?, 'fixture')
    `);
    for (const version of versions) {
      insertVersion.run(
        bundleKey,
        version.version,
        version.ruleText ?? "回答は常体で書く",
        `synthetic-body-${bundleKey}-${version.version}`,
        version.conditionKey ?? "general",
        version.polarity ?? "positive",
        version.status ?? "confirmed",
        version.confirmedAt === undefined ? version.effectiveFrom ?? SINCE : version.confirmedAt,
        version.expiresAt ?? null,
        JSON.stringify(version.evidenceEventIds ?? []),
        version.effectiveFrom ?? SINCE,
      );
    }
  }

  function addEvent(input: {
    eventId?: string;
    sessionHash?: string;
    ordinal: number;
    observedAt?: string;
    excerpt?: string;
  }): string {
    const eventId = input.eventId ?? `synthetic-event-${input.ordinal}`;
    db.prepare(`
      INSERT INTO owner_correction_events (
        event_id, session_id_hash, human_ordinal, observed_at, available_at, source_kind, excerpt,
        previous_action, project, scope, raw_text_hash, source_locator_hash, processed_at
      ) VALUES (?, ?, ?, ?, ?, 'user', ?, '', 'synthetic', 'owner', 'raw-hash', 'locator-hash', ?)
    `).run(
      eventId,
      input.sessionHash ?? SESSION_HASH,
      input.ordinal,
      input.observedAt ?? `2026-10-01T00:0${input.ordinal}:00.000Z`,
      input.observedAt ?? `2026-10-01T00:0${input.ordinal}:00.000Z`,
      input.excerpt ?? "常体の文体を確認する",
      input.observedAt ?? `2026-10-01T00:0${input.ordinal}:00.000Z`,
    );
    return eventId;
  }

  function addEvidence(eventId: string, bundleKey = UNIT_KEY): void {
    db.prepare(`
      INSERT INTO owner_correction_evidence (
        event_id, bundle_key, source, score, detector_version, conditions, polarity
      ) VALUES (?, ?, 'request_repeat', 1, 'synthetic', '[]', 'positive')
    `).run(eventId, bundleKey);
  }

  function addInjection(input: {
    bundleKey?: string;
    sessionHash?: string;
    ordinal?: number;
    epoch?: number;
    version?: number;
  } = {}): void {
    db.prepare(`
      INSERT INTO owner_correction_injections (
        session_id_hash, compact_epoch, bundle_key, version, human_ordinal, trigger, emitted_at,
        output_order, body_hash, output_hash, token_estimate, body_included, stdout_status
      ) VALUES (?, ?, ?, ?, ?, 'start', ?, 1, 'body-hash', 'output-hash', 20, 1, 'emitted')
    `).run(
      input.sessionHash ?? SESSION_HASH,
      input.epoch ?? 0,
      input.bundleKey ?? UNIT_KEY,
      input.version ?? 1,
      input.ordinal ?? 0,
      SINCE,
    );
  }

  function addCheck(input: {
    eventId?: string;
    bundleKey?: string;
    ordinal?: number;
    version?: number;
    isCompliant: 0 | 1;
    checker?: "tone" | "document_delivery" | "expression_policy";
  }): void {
    db.prepare(`
      INSERT INTO owner_correction_compliance_checks (
        session_id_hash, human_ordinal, bundle_key, version, checker, is_compliant, checked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      SESSION_HASH,
      input.ordinal ?? 1,
      input.bundleKey ?? UNIT_KEY,
      input.version ?? 1,
      input.checker ?? "tone",
      input.isCompliant,
      SINCE,
    );
  }

  function measure(options: {
    since?: string;
    until?: string;
    recorrectionSource?: (sessionIdHash: string, humanOrdinal: number) => ReadonlySet<string>;
    turnEpoch?: (sessionIdHash: string, humanOrdinal: number) => number | null;
  } = {}) {
    return computeCorrectionFunnel(db, { since: SINCE, until: UNTIL, ...options });
  }

  it("注入なしでも関連一致の機会を分母にし、届かなかった守りとして数える", () => {
    addBundle();
    addEvent({ ordinal: 1 });

    const report = measure();

    expect(report.overall.opportunities).toBe(1);
    expect(report.overall.undelivered.kept).toBe(1);
    expect(report.overall.deliveryRate).toBe(0);
  });

  it("届いた機会の検査合格を守った・検査合格へ分ける", () => {
    addBundle();
    addInjection();
    addEvent({ ordinal: 1 });
    addCheck({ isCompliant: 1 });

    const report = measure();

    expect(report.overall.delivered.keptChecked).toBe(1);
    expect(report.overall.recorrectRateDelivered).toBe(0);
  });

  it("次 ordinal の同じ束の根拠を言い直しとして捕捉する", () => {
    addBundle();
    addInjection();
    addEvent({ ordinal: 1 });
    const nextEventId = addEvent({ ordinal: 2 });
    addEvidence(nextEventId);

    const report = measure();

    expect(report.overall.delivered.recorrected).toBe(1);
    expect(report.overall.recorrectedCaptured).toBe(1);
    expect(report.overall.captureRate).toBe(1);
  });

  it("確定前の機会は除き、言い直しを捕捉漏れへ残す", () => {
    addBundle(UNIT_KEY, [
      { version: 1, status: "candidate", effectiveFrom: SINCE, confirmedAt: null },
      { version: 2, status: "confirmed", effectiveFrom: "2026-10-01T02:00:00.000Z", confirmedAt: "2026-10-01T02:00:00.000Z", evidenceEventIds: ["synthetic-event-2"] },
    ]);
    addEvent({ ordinal: 1, observedAt: "2026-10-01T01:00:00.000Z" });
    const nextEventId = addEvent({ ordinal: 2, observedAt: "2026-10-01T01:01:00.000Z" });
    addEvidence(nextEventId);

    const report = measure();

    expect(report.overall.opportunities).toBe(0);
    expect(report.overall.recorrectedTotal).toBe(1);
    expect(report.overall.gap).toBe(1);
    expect(report.overall.captureRate).toBe(0);
  });

  it("取消版の effective_from 以後は機会にしない", () => {
    addBundle(UNIT_KEY, [
      { version: 1, status: "confirmed", effectiveFrom: SINCE, confirmedAt: SINCE },
      { version: 2, status: "rejected", effectiveFrom: "2026-10-01T02:00:00.000Z", confirmedAt: null },
    ]);
    addEvent({ ordinal: 1, observedAt: "2026-10-01T03:00:00.000Z" });

    expect(measure().overall.opportunities).toBe(0);
  });

  it("期限切れ後は機会にしない", () => {
    addBundle(UNIT_KEY, [{ version: 1, expiresAt: "2026-10-01T02:00:00.000Z" }]);
    addEvent({ ordinal: 1, observedAt: "2026-10-01T03:00:00.000Z" });

    expect(measure().overall.opportunities).toBe(0);
  });

  it("O1・O2 の外にある言い直しを gap に数える", () => {
    addBundle();
    addEvent({ ordinal: 1, excerpt: "今日は天気について質問する" });
    const nextEventId = addEvent({ ordinal: 2, excerpt: "別の合成文" });
    addEvidence(nextEventId);

    const report = measure();

    expect(report.overall.opportunities).toBe(0);
    expect(report.overall.recorrectedTotal).toBe(1);
    expect(report.overall.gap).toBe(1);
  });

  it("pending の output_epoch を使い、同じ compact epoch の注入だけ届いたにする", () => {
    addBundle();
    addInjection({ epoch: 0 });
    const eventId = addEvent({ ordinal: 1 });
    db.prepare(`
      INSERT INTO owner_correction_pending (
        receipt_id, session_id_hash, received_at, last_confirmed_ordinal, raw_text_hash,
        extracted_candidates, matched_event_id, output_epoch
      ) VALUES ('synthetic-receipt', ?, ?, 0, 'raw', '[]', ?, 1)
    `).run(SESSION_HASH, SINCE, eventId);

    const undelivered = measure();
    addInjection({ epoch: 1, ordinal: 1 });
    const delivered = measure();

    expect(undelivered.overall.deliveredCount).toBe(0);
    expect(undelivered.overall.undeliveredCount).toBe(1);
    expect(delivered.overall.deliveredCount).toBe(1);
  });

  it("確定原則の構成員を一行へ畳み、構成員の根拠も原則の言い直しにする", () => {
    const principleKey = "pr:v1:synthetic-principle";
    const memberKey = "oc:v2:synthetic-member";
    addBundle(principleKey, [{ version: 1, topicKey: "principle", ruleText: "同じ書き方を続ける" }]);
    addBundle(memberKey);
    db.prepare(`
      INSERT INTO owner_correction_principle_members (
        principle_key, member_key, attached_at, attach_source
      ) VALUES (?, ?, ?, 'cluster')
    `).run(principleKey, memberKey, SINCE);
    addInjection({ bundleKey: principleKey });
    addEvent({ ordinal: 1 });
    const nextEventId = addEvent({ ordinal: 2 });
    addEvidence(nextEventId, memberKey);

    const report = measure();

    expect(report.byUnit.map((unit) => unit.unitKey)).toEqual([principleKey]);
    expect(report.overall.delivered.recorrected).toBe(1);
  });

  it("確定原則の構成員へ届いた注入を原則への配送として数える", () => {
    const principleKey = "pr:v1:synthetic-principle-delivery";
    const memberKey = "oc:v2:synthetic-member-delivery";
    addBundle(principleKey, [{ version: 1, topicKey: "principle", ruleText: "同じ書き方を続ける" }]);
    addBundle(memberKey);
    db.prepare(`
      INSERT INTO owner_correction_principle_members (
        principle_key, member_key, attached_at, attach_source
      ) VALUES (?, ?, ?, 'cluster')
    `).run(principleKey, memberKey, SINCE);
    addInjection({ bundleKey: memberKey });
    addEvent({ ordinal: 1 });

    const report = measure();

    expect(report.byUnit).toHaveLength(1);
    expect(report.byUnit[0].unitKey).toBe(principleKey);
    expect(report.overall.deliveredCount).toBe(1);
  });

  it("台帳の構成員キーを確定原則へ畳みrecorrectedTotalを一度だけ数える", () => {
    const principleKey = "pr:v1:synthetic-principle-ledger";
    const memberKey = "oc:v2:synthetic-member-ledger";
    addBundle(principleKey, [{ version: 1, topicKey: "principle", ruleText: "同じ書き方を続ける" }]);
    addBundle(memberKey);
    db.prepare(`
      INSERT INTO owner_correction_principle_members (
        principle_key, member_key, attached_at, attach_source
      ) VALUES (?, ?, ?, 'cluster')
    `).run(principleKey, memberKey, SINCE);
    addEvent({ ordinal: 1 });
    addEvent({ ordinal: 2 });

    const report = measure({
      recorrectionSource: (sessionHash, ordinal) =>
        sessionHash === SESSION_HASH && ordinal === 2 ? new Set([memberKey]) : new Set(),
    });

    expect(report.byUnit.map((unit) => unit.unitKey)).toEqual([principleKey]);
    expect(report.overall.recorrectedTotal).toBe(1);
    expect(report.overall.recorrectedCaptured).toBe(1);
  });

  it("evidence比較は通常の機会集計を再計算せず言い直し計数を返す", () => {
    addBundle();
    addEvent({ ordinal: 1 });
    const nextEventId = addEvent({ ordinal: 2 });
    addEvidence(nextEventId);

    const report = computeCorrectionFunnel(db, {
      since: SINCE,
      until: UNTIL,
      recorrectionSource: () => new Set(),
      includeEvidenceComparison: true,
    });

    expect(report.overall.recorrectedTotal).toBe(0);
    expect(report.evidenceComparison?.overall.recorrectedTotal).toBe(1);
    expect(report.evidenceComparison?.overall.recorrectedCaptured).toBe(1);
    expect(report.evidenceComparison?.recorrectedDiff).toBe(-1);
  });

  it("ファネルの共通計数関数で既存の合計値を再現する", () => {
    addBundle();
    addInjection();
    addEvent({ ordinal: 1 });
    addCheck({ isCompliant: 1 });
    const report = measure();
    const counts = emptyFunnelCounts();

    addFunnelCounts(counts, report.overall);

    expect(makeCounterReport(counts)).toEqual(report.overall);
  });

  it("関連一致しない応答でも有効な検査行があれば O2 の機会にする", () => {
    addBundle();
    addEvent({ ordinal: 1, excerpt: "今日は天気について質問する" });
    addCheck({ isCompliant: 0 });

    const report = measure();

    expect(report.overall.opportunities).toBe(1);
    expect(report.opportunitySources.o2Only).toBe(1);
    expect(report.overall.undelivered.violationOnly).toBe(1);
  });

  it("検査行がない応答はO2の機会にも違反にも数えない", () => {
    addBundle();
    addEvent({ ordinal: 1, excerpt: "今日は天気について質問する" });

    const report = measure();

    expect(report.overall.opportunities).toBe(0);
    expect(report.overall.undelivered.violationOnly).toBe(0);
  });

  it("時刻の違う複数turnでも同じ有効版を引いて機会を保つ", () => {
    addBundle();
    addEvent({ ordinal: 1, observedAt: "2026-10-01T00:01:00.000Z" });
    addEvent({ ordinal: 2, observedAt: "2026-10-01T00:02:00.000Z" });

    const report = measure();

    expect(report.overall.opportunities).toBe(2);
    expect(report.overall.undelivered.keptUnchecked).toBe(2);
  });

  it("複数turnで同じ束versionの配送連続性を保つ", () => {
    addBundle();
    addInjection();
    addEvent({ ordinal: 1, observedAt: "2026-10-01T00:01:00.000Z" });
    addEvent({ ordinal: 2, observedAt: "2026-10-01T00:02:00.000Z" });

    const report = measure();

    expect(report.overall.deliveredCount).toBe(2);
    expect(report.overall.undeliveredCount).toBe(0);
  });

  it("旧 A8 の body injection 後同束根拠を旧計算と同じ形で返す", () => {
    addBundle(UNIT_KEY, [{ version: 1, evidenceEventIds: ["synthetic-event-2"] }]);
    addInjection();
    addEvent({ ordinal: 1, observedAt: "2026-10-01T00:00:00.000Z" });
    const evidenceEventId = addEvent({ ordinal: 2, observedAt: "2026-10-01T00:01:00.000Z" });
    addEvidence(evidenceEventId);

    expect(measure().legacyA8).toEqual({ numerator: 1, denominator: 1, rate: 1 });
  });

  it("ledger source の unit key だけを言い直しとして採り、根拠 source と比較できる", () => {
    addBundle();
    addEvent({ ordinal: 1 });
    addEvent({ ordinal: 2 });
    const report = measure({
      recorrectionSource: (sessionIdHash, humanOrdinal) =>
        sessionIdHash === SESSION_HASH && humanOrdinal === 2 ? new Set([UNIT_KEY]) : new Set(),
    });

    expect(report.overall.recorrectedCaptured).toBe(1);
    expect(report.overall.recorrectRate).toBe(0.5);
    expect(report.overall.recorrectedTotal).toBe(1);
  });
});
