import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { CORRECTION_PRINCIPLES_SCHEMA_VERSION } from "../storage/correction-schema.js";
import { getSchemaVersion } from "../storage/schema.js";
import type { SQLiteStorage } from "../storage/sqlite.js";
import { extractCorrectionQuery, scoreCorrectionRelevance } from "./retrieval.js";
import type { CorrectionStoreTransaction } from "./store.js";
import { readEnvironmentMode } from "./environment-mode.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const FAILURE_INTERVAL_MS = 3 * DAY_MS;
const IDLE_INTERVAL_MS = 21 * DAY_MS;
const PRINCIPLE_PREFIX = "pr:v1:";

export type StrengthMode = "off" | "shadow" | "on";

export interface StrengthJobOptions {
  now: string;
  mode: StrengthMode;
}

export interface StrengthJobSummary {
  mode: StrengthMode;
  bundlesExamined: number;
  eventsRecorded: number;
  intensityChanges: number;
  failureEvents: number;
  settledEvents: number;
  idleEvents: number;
}

interface BundleRow {
  bundleKey: string;
  memoryId: string | null;
  intensity: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

interface StrengthEventRow {
  at: string;
  delta: number;
  reason: string;
  basis: string;
}

interface Basis {
  mode?: StrengthMode;
  signal?: string;
  signalHashes?: string[];
  injectionSetHash?: string;
  baseIntensity?: number;
}

interface RecentInjectionSession {
  sessionHash: string;
  emittedAt: string;
  failed: boolean;
  complianceChecked: boolean;
}

interface FailureSignalRow {
  signalId: string;
  sessionHash: string;
}

interface SignalCounts {
  eventsRecorded: number;
  intensityChanges: number;
  failureEvents: number;
  settledEvents: number;
  idleEvents: number;
}

export function resolveStrengthMode(raw: string | undefined): StrengthMode {
  return readEnvironmentMode({
    name: "WASURENAGUSA_STRENGTH",
    value: raw,
    acceptedValues: ["off", "shadow", "on"],
    defaultValue: "off",
    invalidValue: "off",
  });
}

export function runStrengthJob(
  storage: Pick<SQLiteStorage, "runCorrectionTransaction">,
  options: StrengthJobOptions,
): StrengthJobSummary {
  const nowMs = Date.parse(options.now);
  if (!Number.isFinite(nowMs)) throw new Error("strength job requires a valid --now timestamp");
  const now = new Date(nowMs).toISOString();
  const emptySummary: StrengthJobSummary = {
    mode: options.mode,
    bundlesExamined: 0,
    eventsRecorded: 0,
    intensityChanges: 0,
    failureEvents: 0,
    settledEvents: 0,
    idleEvents: 0,
  };
  if (options.mode === "off") {
    return emptySummary;
  }

  return storage.runCorrectionTransaction(({ db }) => {
    if (getSchemaVersion(db as unknown as Database.Database) < CORRECTION_PRINCIPLES_SCHEMA_VERSION) {
      return emptySummary;
    }
    db.prepare("SELECT bundle_key, at, delta, reason, basis FROM owner_correction_strength_events LIMIT 0").all();
    const complianceChecksTableExists = db.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'owner_correction_compliance_checks'",
    ).get() !== undefined;
    const bundles = db.prepare(`
      SELECT bundle_key AS bundleKey, memory_id AS memoryId, intensity,
        first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt
      FROM owner_correction_bundles
      WHERE status = 'confirmed'
      ORDER BY bundle_key
    `).all() as BundleRow[];
    const counts: SignalCounts = {
      eventsRecorded: 0,
      intensityChanges: 0,
      failureEvents: 0,
      settledEvents: 0,
      idleEvents: 0,
    };

    for (const bundle of bundles) {
      const events = db.prepare(`
        SELECT at, delta, reason, basis
        FROM owner_correction_strength_events
        WHERE bundle_key = ? AND at >= ? AND at <= ?
        ORDER BY at, reason
      `).all(bundle.bundleKey, bundle.firstSeenAt, now) as StrengthEventRow[];
      const knownFailureHashes = new Set<string>();
      let lastFailureAt = -Infinity;
      let lastIdleAt = -Infinity;
      let lastSettledAt = -Infinity;
      const settledHashes = new Set<string>();

      for (const event of events) {
        const eventAt = Date.parse(event.at);
        if (event.reason === "failure") {
          const basis = parseBasis(event.basis);
          if (basis.mode !== options.mode || basis.signal !== "failure") continue;
          if (!Array.isArray(basis.signalHashes)) throw new Error("strength failure event is missing signal hashes");
          for (const signalHash of basis.signalHashes) knownFailureHashes.add(signalHash);
          lastFailureAt = Math.max(lastFailureAt, eventAt);
          continue;
        }
        if (event.reason === "idle") {
          const basis = parseBasis(event.basis);
          if (basis.mode === options.mode && basis.signal === "idle") lastIdleAt = Math.max(lastIdleAt, eventAt);
          continue;
        }
        if (event.reason !== "manual" || !event.basis.includes('"signal":"settled"')) continue;
        const basis = parseBasis(event.basis);
        if (basis.mode !== options.mode || basis.signal !== "settled") continue;
        if (typeof basis.injectionSetHash !== "string") throw new Error("settled strength event is missing its injection hash");
        settledHashes.add(basis.injectionSetHash);
        lastSettledAt = Math.max(lastSettledAt, eventAt);
      }

      const failureRows = readFailureSignals(db, bundle, now);
      const failedSessionHashes = new Set(failureRows.map((row) => row.sessionHash));
      const newFailureHashes = failureRows
        .map((row) => hash(row.signalId))
        .filter((signalHash) => !knownFailureHashes.has(signalHash));
      if (newFailureHashes.length > 0 && nowMs - lastFailureAt >= FAILURE_INTERVAL_MS) {
        const event = recordStrengthEvent(db, bundle, now, 1, "failure", {
          mode: options.mode,
          signal: "failure",
          proposedDelta: 1,
          signalHashes: [...new Set(newFailureHashes)].sort(),
        }, options.mode);
        if (event.recorded) {
          counts.eventsRecorded += 1;
          counts.failureEvents += 1;
          counts.intensityChanges += Number(event.intensityChanged);
        }
        continue;
      }

      const recentSessions = readRecentInjectionSessions(
        db,
        bundle,
        now,
        failedSessionHashes,
        complianceChecksTableExists,
      );
      if (recentSessions.length === 5 && recentSessions.every((session) => session.complianceChecked)) {
        const sessionDays = new Set(recentSessions.map((session) => jstDay(session.emittedAt)));
        const injectionSetHash = hash(JSON.stringify(recentSessions.map((session) => [
          session.sessionHash,
          session.emittedAt,
        ])));
        const allProtected = recentSessions.every((session) => !session.failed);
        if (sessionDays.size >= 3 && allProtected && !settledHashes.has(injectionSetHash)) {
          const event = recordStrengthEvent(db, bundle, now, 0, "manual", {
            mode: options.mode,
            signal: "settled",
            proposedDelta: 0,
            injectionSetHash,
            sessionCount: recentSessions.length,
            dayCount: sessionDays.size,
          }, options.mode);
          if (event.recorded) {
            counts.eventsRecorded += 1;
            counts.settledEvents += 1;
          }
          continue;
        }
      }

      const windowStart = new Date(nowMs - IDLE_INTERVAL_MS).toISOString();
      const hasPromptInjection = db.prepare(`
        SELECT 1 AS present FROM owner_correction_injections
        WHERE bundle_key = ? AND body_included = 1 AND stdout_status = 'emitted'
          AND trigger = 'prompt' AND emitted_at > ? AND emitted_at >= ?
          AND emitted_at <= ?
        LIMIT 1
      `).get(bundle.bundleKey, windowStart, bundle.firstSeenAt, now);
      const hasRecentEvidence = db.prepare(`
        SELECT 1 AS present
        FROM owner_correction_evidence evidence
        JOIN owner_correction_events ownerEvent ON ownerEvent.event_id = evidence.event_id
        WHERE evidence.bundle_key = ? AND ownerEvent.observed_at > ?
          AND ownerEvent.observed_at >= ? AND ownerEvent.observed_at <= ?
        LIMIT 1
      `).get(bundle.bundleKey, windowStart, bundle.firstSeenAt, now);
      const hasRecentViolation = db.prepare(`
        SELECT 1 AS present FROM owner_correction_violations
        WHERE bundle_key = ? AND detected_at > ? AND detected_at >= ? AND detected_at <= ?
        LIMIT 1
      `).get(bundle.bundleKey, windowStart, bundle.firstSeenAt, now);
      if (hasPromptInjection || hasRecentEvidence || hasRecentViolation) continue;

      const idleAnchor = Math.max(
        Date.parse(bundle.lastSeenAt),
        lastIdleAt,
        lastSettledAt,
      );
      if (nowMs - idleAnchor < IDLE_INTERVAL_MS) continue;

      const event = recordStrengthEvent(db, bundle, now, -1, "idle", {
        mode: options.mode,
        signal: "idle",
        proposedDelta: -1,
        windowStart,
        anchorAt: new Date(idleAnchor).toISOString(),
      }, options.mode);
      if (event.recorded) {
        counts.eventsRecorded += 1;
        counts.idleEvents += 1;
        counts.intensityChanges += Number(event.intensityChanged);
      }
    }

    return {
      mode: options.mode,
      bundlesExamined: bundles.length,
      ...counts,
    };
  });
}

function readFailureSignals(
  db: CorrectionStoreTransaction["db"],
  bundle: BundleRow,
  now: string,
): FailureSignalRow[] {
  const memberBundleKeys = bundle.bundleKey.startsWith(PRINCIPLE_PREFIX)
    ? (db.prepare(`
        SELECT member_key AS bundleKey FROM owner_correction_principle_members
        WHERE principle_key = ? ORDER BY member_key
      `).all(bundle.bundleKey) as Array<{ bundleKey: string }>).map((row) => row.bundleKey)
    : [];
  const relatedBundleKeys = [bundle.bundleKey, ...memberBundleKeys];
  const relatedBundlePlaceholders = relatedBundleKeys.map(() => "?").join(", ");
  let targetBundleMatch = "evidence.bundle_key = injection.bundle_key";
  let targetBundleMatchParams: string[] = [];
  if (memberBundleKeys.length > 0) {
    const memberBundlePlaceholders = memberBundleKeys.map(() => "?").join(", ");
    targetBundleMatch = `(evidence.bundle_key = injection.bundle_key
      OR (injection.bundle_key = ? AND evidence.bundle_key IN (${memberBundlePlaceholders})))`;
    targetBundleMatchParams = [bundle.bundleKey, ...memberBundleKeys];
  }
  let targetViolationMatch = "violation.bundle_key = injection.bundle_key";
  let targetViolationMatchParams: string[] = [];
  if (memberBundleKeys.length > 0) {
    const memberBundlePlaceholders = memberBundleKeys.map(() => "?").join(", ");
    targetViolationMatch = `(violation.bundle_key = injection.bundle_key
      OR (injection.bundle_key = ? AND violation.bundle_key IN (${memberBundlePlaceholders})))`;
    targetViolationMatchParams = [bundle.bundleKey, ...memberBundleKeys];
  }
  const rows = db.prepare(`
    SELECT 'evidence:' || ownerEvent.event_id AS signalId,
      ownerEvent.session_id_hash AS sessionHash
    FROM owner_correction_injections injection
    JOIN owner_correction_events ownerEvent
      ON ownerEvent.session_id_hash = injection.session_id_hash
    JOIN owner_correction_evidence evidence
      ON evidence.event_id = ownerEvent.event_id AND ${targetBundleMatch}
    WHERE injection.bundle_key IN (${relatedBundlePlaceholders})
      AND injection.body_included = 1 AND injection.stdout_status = 'emitted'
      AND injection.emitted_at >= ? AND ownerEvent.observed_at >= ?
      AND injection.emitted_at <= ? AND ownerEvent.observed_at <= ?
      AND ownerEvent.human_ordinal > injection.human_ordinal
    UNION
    SELECT 'violation:' || violation.session_id_hash || ':' || violation.human_ordinal || ':' || violation.checker AS signalId,
      violation.session_id_hash AS sessionHash
    FROM owner_correction_injections injection
    JOIN owner_correction_violations violation
      ON violation.session_id_hash = injection.session_id_hash
      AND ${targetViolationMatch}
      AND violation.human_ordinal >= injection.human_ordinal
    WHERE injection.bundle_key IN (${relatedBundlePlaceholders})
      AND injection.body_included = 1 AND injection.stdout_status = 'emitted'
      AND injection.emitted_at >= ? AND violation.detected_at >= ?
      AND injection.emitted_at <= ? AND violation.detected_at <= ?
    ORDER BY signalId
  `).all(
    ...targetBundleMatchParams,
    ...relatedBundleKeys,
    bundle.firstSeenAt,
    bundle.firstSeenAt,
    now,
    now,
    ...targetViolationMatchParams,
    ...relatedBundleKeys,
    bundle.firstSeenAt,
    bundle.firstSeenAt,
    now,
    now,
  ) as FailureSignalRow[];
  return rows;
}

function readRecentInjectionSessions(
  db: CorrectionStoreTransaction["db"],
  bundle: BundleRow,
  now: string,
  failedSessionHashes: ReadonlySet<string>,
  complianceChecksTableExists: boolean,
): RecentInjectionSession[] {
  const rows = db.prepare(`
    SELECT injection.session_id_hash AS sessionHash, injection.emitted_at AS emittedAt,
      injection.human_ordinal AS humanOrdinal, injection.version AS injectionVersion,
      bundle.topic_key AS topicKey, version.rule_text AS ruleText,
      version.condition_key AS conditionKey, completedPrompt.excerpt AS excerpt
    FROM owner_correction_injections injection
    JOIN owner_correction_bundles bundle ON bundle.bundle_key = injection.bundle_key
    JOIN owner_correction_versions version
      ON version.bundle_key = injection.bundle_key AND version.version = injection.version
    JOIN owner_correction_events completedPrompt
      ON completedPrompt.session_id_hash = injection.session_id_hash
      AND completedPrompt.human_ordinal = injection.human_ordinal
    WHERE injection.bundle_key = ? AND injection.body_included = 1 AND injection.stdout_status = 'emitted'
      AND injection.trigger = 'prompt'
      AND injection.emitted_at >= ? AND injection.emitted_at <= ?
    ORDER BY injection.emitted_at DESC, injection.session_id_hash
  `).all(bundle.bundleKey, bundle.firstSeenAt, now) as Array<{
    sessionHash: string;
    emittedAt: string;
    humanOrdinal: number;
    injectionVersion: number;
    topicKey: string;
    ruleText: string;
    conditionKey: string;
    excerpt: string;
  }>;
  const qualifiedBySession = new Map<string, {
    emittedAt: string;
    humanOrdinal: number;
    version: number;
  }>();
  for (const row of rows) {
    const query = extractCorrectionQuery(row.excerpt);
    const relevance = scoreCorrectionRelevance({
      query: query.text,
      queryTerms: query.terms,
      ruleText: row.ruleText,
      topicKey: row.topicKey,
      conditionKey: row.conditionKey,
    });
    if (relevance === null || qualifiedBySession.has(row.sessionHash)) continue;
    qualifiedBySession.set(row.sessionHash, {
      emittedAt: row.emittedAt,
      humanOrdinal: row.humanOrdinal,
      version: row.injectionVersion,
    });
  }
  return [...qualifiedBySession.entries()].map(([sessionHash, injection]) => {
    const complianceChecked = complianceChecksTableExists && db.prepare(`
      SELECT 1 AS present FROM owner_correction_compliance_checks
      WHERE session_id_hash = ? AND bundle_key = ? AND version = ?
        AND human_ordinal >= ? AND checked_at >= ? AND checked_at <= ? AND is_compliant = 1
      LIMIT 1
    `).get(
      sessionHash,
      bundle.bundleKey,
      injection.version,
      injection.humanOrdinal,
      injection.emittedAt,
      now,
    ) !== undefined;
    return {
      sessionHash,
      emittedAt: injection.emittedAt,
      failed: failedSessionHashes.has(sessionHash),
      complianceChecked,
    };
  })
    .slice(0, 5);
}

function recordStrengthEvent(
  db: CorrectionStoreTransaction["db"],
  bundle: BundleRow,
  at: string,
  proposedDelta: number,
  reason: "failure" | "idle" | "manual",
  basis: Record<string, unknown>,
  mode: StrengthMode,
): { recorded: boolean; intensityChanged: boolean } {
  const baseIntensity = getStrengthBaseIntensity(db, bundle);
  const serializedBasis = JSON.stringify({ ...basis, baseIntensity });
  const existing = db.prepare(`
    SELECT basis FROM owner_correction_strength_events
    WHERE bundle_key = ? AND at = ? AND reason = ?
  `).get(bundle.bundleKey, at, reason) as { basis: string } | undefined;
  const previousCorrections = db.prepare(`
    SELECT COALESCE(SUM(delta), 0) AS delta
    FROM owner_correction_strength_events
    WHERE bundle_key = ? AND at >= ? AND NOT (at = ? AND reason = ?)
  `).get(bundle.bundleKey, bundle.firstSeenAt, at, reason) as { delta: number };
  const fromIntensity = bundle.intensity;
  const currentIntensity = clampIntensity(baseIntensity + previousCorrections.delta);
  const toIntensity = mode === "on"
    ? clampIntensity(currentIntensity + proposedDelta)
    : fromIntensity;
  const delta = mode === "on"
    ? toIntensity - baseIntensity - previousCorrections.delta
    : 0;
  if (existing) {
    const existingBasis = parseBasis(existing.basis);
    if (mode !== "on" || existingBasis.mode !== "shadow") return { recorded: false, intensityChanged: false };
    db.prepare(`
      UPDATE owner_correction_strength_events
      SET from_intensity = ?, to_intensity = ?, delta = ?, basis = ?
      WHERE bundle_key = ? AND at = ? AND reason = ?
    `).run(fromIntensity, toIntensity, delta, serializedBasis, bundle.bundleKey, at, reason);
  } else {
    db.prepare(`
      INSERT INTO owner_correction_strength_events (
        bundle_key, at, from_intensity, to_intensity, delta, reason, basis
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(bundle.bundleKey, at, fromIntensity, toIntensity, delta, reason, serializedBasis);
  }

  const intensityChanged = mode === "on" && toIntensity !== fromIntensity;
  if (intensityChanged) {
    const updated = db.prepare(
      "UPDATE owner_correction_bundles SET intensity = ? WHERE bundle_key = ?",
    ).run(toIntensity, bundle.bundleKey);
    if (updated.changes !== 1) throw new Error("strength bundle disappeared during update");
    if (bundle.memoryId !== null) {
      db.prepare("UPDATE memories SET intensity = ? WHERE id = ?").run(toIntensity, bundle.memoryId);
    }
  }
  return { recorded: true, intensityChanged };
}

export function getStrengthBaseIntensity(
  db: Pick<Database.Database, "prepare">,
  bundle: { bundleKey: string; firstSeenAt: string; intensity: number },
): number {
  const event = db.prepare(`
    SELECT basis FROM owner_correction_strength_events
    WHERE bundle_key = ? AND at >= ?
    ORDER BY datetime(at) DESC, reason ASC
    LIMIT 1
  `).get(bundle.bundleKey, bundle.firstSeenAt) as { basis: string } | undefined;
  if (!event) return bundle.intensity;
  const basis = parseBasis(event.basis);
  if (basis.baseIntensity === undefined) return bundle.intensity;
  if (!Number.isSafeInteger(basis.baseIntensity) || basis.baseIntensity < 1 || basis.baseIntensity > 5) {
    throw new Error("strength event base intensity must be between 1 and 5");
  }
  return basis.baseIntensity;
}

function parseBasis(value: string): Basis {
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("strength event basis must be a JSON object");
  }
  return parsed as Basis;
}

function clampIntensity(value: number): number {
  return Math.min(5, Math.max(1, value));
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function jstDay(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error("strength injection has an invalid timestamp");
  return new Date(time + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
