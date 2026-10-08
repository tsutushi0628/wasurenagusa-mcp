import type Database from "better-sqlite3";
import {
  activeVersionAt,
  createEffectiveCheckerRuleReader,
  getComplianceChecker,
  isEvidenceOnlyVersionContinuity,
  readEffectiveCheckerRuleSnapshot,
  tableExists,
} from "./compliance.js";
import { extractCorrectionQuery, scoreCorrectionRelevance } from "./retrieval.js";

const PRINCIPLE_PREFIX = "pr:v1:";

interface VersionRow {
  bundle_key: string;
  version: number;
  rule_text: string;
  body_hash: string;
  conditions: string;
  condition_key: string;
  polarity: string;
  visibility: string;
  status: string;
  confirmed_at: string | null;
  expires_at: string | null;
  lifetime_kind: string;
  continuation_basis: string;
  evidence_event_ids: string;
  effective_from: string;
}

interface BundleRow {
  bundle_key: string;
  topic_key: string;
  rule_text: string;
}

interface PrincipleMemberRow {
  principle_key: string;
  member_key: string;
  attached_at: string;
}

interface EventRow {
  event_id: string;
  session_id_hash: string;
  human_ordinal: number;
  observed_at: string;
  excerpt: string;
}

interface InjectionRow {
  bundleKey: string;
  version: number;
  sessionHash: string;
  humanOrdinal: number;
  emittedAt: string;
}

interface EvidenceRow {
  eventId: string;
  bundleKey: string;
  sessionHash: string;
  humanOrdinal: number;
  observedAt: string;
}

interface LegacyVersionRow extends VersionRow {
  effective_from: string;
}

interface TurnSource {
  keys: ReadonlySet<string>;
  isUnitKey: boolean;
  observedAt: string;
}

interface UnitDefinition {
  unitKey: string;
  kind: "bundle" | "principle";
  topicKey: string;
  ruleText: string;
  versions: VersionRow[];
}

interface ActiveUnit {
  definition: UnitDefinition;
  version: VersionRow;
  memberKeys: string[];
  memberVersions: Map<string, VersionRow>;
  rules: Array<Pick<VersionRow, "rule_text" | "condition_key" | "polarity"> & { topic_key: string }>;
}

interface ResultCounts {
  recorrected: number;
  violationOnly: number;
  kept: number;
  keptChecked: number;
  keptUnchecked: number;
}

export interface MutableFunnelCounts {
  opportunities: number;
  deliveredCount: number;
  undeliveredCount: number;
  delivered: ResultCounts;
  undelivered: ResultCounts;
  recorrectedTotal: number;
  recorrectedCaptured: number;
}

interface UnitFunnelCounts extends MutableFunnelCounts {
  opportunitySources: { o1Only: number; o2Only: number; both: number };
  metadata: { kind: "bundle" | "principle"; topicKey: string; ruleText: string; memberCount: number; effectiveFrom: string };
}

export interface FunnelOptions {
  since: string;
  until: string;
  recorrectionSource?: (sessionIdHash: string, humanOrdinal: number) => ReadonlySet<string>;
  turnEpoch?: (sessionIdHash: string, humanOrdinal: number) => number | null;
  sessionOrderByHash?: ReadonlyMap<string, number>;
  includeEvidenceComparison?: boolean;
  versionSnapshot?: ReturnType<typeof readEffectiveCheckerRuleSnapshot>;
}

export interface FunnelCountReport {
  opportunities: number;
  deliveredCount: number;
  undeliveredCount: number;
  delivered: ResultCounts;
  undelivered: ResultCounts;
  recorrectedTotal: number;
  recorrectedCaptured: number;
  gap: number;
  captureRate: number | null;
  deliveryRate: number | null;
  recorrectRate: number | null;
  recorrectRateDelivered: number | null;
  recorrectRateUndelivered: number | null;
}

export interface FunnelReport {
  definition: "v1-20261008";
  window: { since: string; until: string };
  recorrectionSource: "ledger" | "evidence";
  overall: FunnelCountReport;
  opportunitySources: { o1Only: number; o2Only: number; both: number };
  byUnit: Array<FunnelCountReport & {
    unitKey: string;
    kind: "bundle" | "principle";
    topicKey: string;
    ruleText: string;
    memberCount: number;
    effectiveFrom: string;
  }>;
  legacyA8: { numerator: number; denominator: number; rate: number | null };
  evidenceComparison?: { overall: FunnelCountReport; recorrectedDiff: number };
}

function parseBound(value: string, endOfDay: boolean): { output: string; time: string } {
  if (typeof value !== "string" || value.length === 0) throw new Error("funnel date bound is required");
  let timestamp = value;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    if (endOfDay) timestamp = `${value}T23:59:59.999+09:00`;
    else timestamp = `${value}T00:00:00.000+09:00`;
  }
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) throw new Error("funnel date bound is invalid");
  return { output: value, time: new Date(parsed).toISOString() };
}

function readDefinitions(db: Database.Database, versionRows: VersionRow[]): Map<string, UnitDefinition> {
  const bundles = db.prepare(`
    SELECT bundle_key, topic_key, rule_text
    FROM owner_correction_bundles
    ORDER BY bundle_key
  `).all() as BundleRow[];
  const versionsByBundle = new Map<string, VersionRow[]>();
  for (const version of versionRows) {
    const rows = versionsByBundle.get(version.bundle_key) ?? [];
    rows.push(version);
    versionsByBundle.set(version.bundle_key, rows);
  }
  const definitions = new Map<string, UnitDefinition>();
  for (const bundle of bundles) {
    const versions = versionsByBundle.get(bundle.bundle_key) ?? [];
    if (!versions.some((version) => version.status === "confirmed")) continue;
    definitions.set(bundle.bundle_key, {
      unitKey: bundle.bundle_key,
      kind: bundle.bundle_key.startsWith(PRINCIPLE_PREFIX) ? "principle" : "bundle",
      topicKey: bundle.topic_key,
      ruleText: bundle.rule_text,
      versions,
    });
  }
  return definitions;
}

function readPrincipleMembers(snapshot: ReturnType<typeof readEffectiveCheckerRuleSnapshot>): PrincipleMemberRow[] {
  return snapshot.principleMembers.map(({ principle_key, member_key, attached_at }) => ({
    principle_key,
    member_key,
    attached_at,
  }));
}

function activeUnitsAt(
  definitions: ReadonlyMap<string, UnitDefinition>,
  members: readonly PrincipleMemberRow[],
  at: string,
): ActiveUnit[] {
  const activePrinciples = new Map<string, ActiveUnit>();
  const memberToPrinciple = new Map<string, string>();
  for (const definition of definitions.values()) {
    if (definition.kind !== "principle") continue;
    const version = activeVersionAt(definition.versions, at);
    if (!version) continue;
    const activeMembers = members
      .filter((member) => member.principle_key === definition.unitKey && member.attached_at <= at)
      .filter((member) => activeVersionAt(definitions.get(member.member_key)?.versions ?? [], at) !== null)
      .map((member) => member.member_key);
    const memberVersions = new Map<string, VersionRow>();
    const memberRules = activeMembers.flatMap((memberKey) => {
      const memberDefinition = definitions.get(memberKey);
      const memberVersion = activeVersionAt(memberDefinition?.versions ?? [], at);
      if (!memberDefinition || !memberVersion) return [];
      memberVersions.set(memberKey, memberVersion);
      return [{
        rule_text: memberVersion.rule_text,
        condition_key: memberVersion.condition_key,
        polarity: memberVersion.polarity,
        topic_key: memberDefinition.topicKey,
      }];
    });
    activePrinciples.set(definition.unitKey, {
      definition,
      version,
      memberKeys: activeMembers,
      memberVersions,
      rules: [{
        rule_text: version.rule_text,
        condition_key: version.condition_key,
        polarity: version.polarity,
        topic_key: definition.topicKey,
      }, ...memberRules],
    });
    for (const memberKey of activeMembers) {
      if (!memberToPrinciple.has(memberKey)) memberToPrinciple.set(memberKey, definition.unitKey);
    }
  }

  const units = [...activePrinciples.values()];
  for (const definition of definitions.values()) {
    if (definition.kind === "principle" || memberToPrinciple.has(definition.unitKey)) continue;
    const version = activeVersionAt(definition.versions, at);
    if (!version) continue;
    units.push({
      definition,
      version,
      memberKeys: [],
      memberVersions: new Map(),
      rules: [{
        rule_text: version.rule_text,
        condition_key: version.condition_key,
        polarity: version.polarity,
        topic_key: definition.topicKey,
      }],
    });
  }
  return units.sort((left, right) => left.definition.unitKey.localeCompare(right.definition.unitKey));
}

function isRelated(excerpt: string, unit: ActiveUnit): boolean {
  const query = extractCorrectionQuery(excerpt);
  return unit.rules.some((rule) => scoreCorrectionRelevance({
    query: query.text,
    queryTerms: query.terms,
    ruleText: rule.rule_text,
    topicKey: rule.topic_key,
    conditionKey: rule.condition_key,
  }) !== null);
}

function turnKey(sessionHash: string, ordinal: number): string {
  return `${sessionHash}\u0000${ordinal}`;
}

function makeResultCounts(): ResultCounts {
  return { recorrected: 0, violationOnly: 0, kept: 0, keptChecked: 0, keptUnchecked: 0 };
}

function makeMutableCounts(): MutableFunnelCounts {
  return {
    opportunities: 0,
    deliveredCount: 0,
    undeliveredCount: 0,
    delivered: makeResultCounts(),
    undelivered: makeResultCounts(),
    recorrectedTotal: 0,
    recorrectedCaptured: 0,
  };
}

export function emptyFunnelCounts(): MutableFunnelCounts {
  return makeMutableCounts();
}

export function addFunnelCounts(target: MutableFunnelCounts, source: FunnelCountReport): void {
  target.opportunities += source.opportunities;
  target.deliveredCount += source.deliveredCount;
  target.undeliveredCount += source.undeliveredCount;
  target.recorrectedTotal += source.recorrectedTotal;
  target.recorrectedCaptured += source.recorrectedCaptured;
  for (const outcome of ["delivered", "undelivered"] as const) {
    for (const key of ["recorrected", "violationOnly", "kept", "keptChecked", "keptUnchecked"] as const) {
      target[outcome][key] += source[outcome][key];
    }
  }
}

function makeUnitCounts(unit: ActiveUnit): UnitFunnelCounts {
  return {
    ...makeMutableCounts(),
    opportunitySources: { o1Only: 0, o2Only: 0, both: 0 },
    metadata: {
      kind: unit.definition.kind,
      topicKey: unit.definition.topicKey,
      ruleText: unit.version.rule_text,
      memberCount: unit.memberKeys.length,
      effectiveFrom: unit.version.effective_from,
    },
  };
}

function ensureUnitCounts(
  unitCounts: Map<string, UnitFunnelCounts>,
  definitions: ReadonlyMap<string, UnitDefinition>,
  unitKey: string,
): UnitFunnelCounts {
  const existing = unitCounts.get(unitKey);
  if (existing) return existing;
  const definition = definitions.get(unitKey);
  const latestConfirmed = definition?.versions.filter((version) => version.status === "confirmed").at(-1);
  const unit: ActiveUnit = {
    definition: definition ?? {
      unitKey,
      kind: unitKey.startsWith(PRINCIPLE_PREFIX) ? "principle" : "bundle",
      topicKey: "",
      ruleText: "",
      versions: [],
    },
    version: latestConfirmed ?? {
      bundle_key: unitKey,
      version: 1,
      rule_text: definition?.ruleText ?? "",
      body_hash: "",
      conditions: "",
      condition_key: "",
      polarity: "",
      visibility: "",
      status: "confirmed",
      confirmed_at: null,
      expires_at: null,
      lifetime_kind: "",
      continuation_basis: "",
      evidence_event_ids: "[]",
      effective_from: "",
    },
    memberKeys: [],
    memberVersions: new Map(),
    rules: [],
  };
  const counts = makeUnitCounts(unit);
  unitCounts.set(unitKey, counts);
  return counts;
}

export function makeCounterReport(counts: MutableFunnelCounts): FunnelCountReport {
  const gap = Math.max(0, counts.recorrectedTotal - counts.recorrectedCaptured);
  const deliveredRate = counts.deliveredCount === 0 ? null : counts.delivered.recorrected / counts.deliveredCount;
  const undeliveredRate = counts.undeliveredCount === 0 ? null : counts.undelivered.recorrected / counts.undeliveredCount;
  return {
    opportunities: counts.opportunities,
    deliveredCount: counts.deliveredCount,
    undeliveredCount: counts.undeliveredCount,
    delivered: counts.delivered,
    undelivered: counts.undelivered,
    recorrectedTotal: counts.recorrectedTotal,
    recorrectedCaptured: counts.recorrectedCaptured,
    gap,
    captureRate: counts.recorrectedTotal === 0 ? null : counts.recorrectedCaptured / counts.recorrectedTotal,
    deliveryRate: counts.opportunities === 0 ? null : counts.deliveredCount / counts.opportunities,
    recorrectRate: counts.opportunities === 0
      ? null
      : (counts.delivered.recorrected + counts.undelivered.recorrected) / counts.opportunities,
    recorrectRateDelivered: deliveredRate,
    recorrectRateUndelivered: undeliveredRate,
  };
}

function readTurnEpoch(db: Database.Database, event: EventRow): number {
  const pending = db.prepare(`
    SELECT output_epoch AS outputEpoch
    FROM owner_correction_pending
    WHERE matched_event_id = ?
    ORDER BY received_at DESC, receipt_id
    LIMIT 1
  `).get(event.event_id) as { outputEpoch: number | null } | undefined;
  if (pending?.outputEpoch !== null && pending?.outputEpoch !== undefined) return pending.outputEpoch;
  const injection = db.prepare(`
    SELECT MAX(compact_epoch) AS compactEpoch
    FROM owner_correction_injections
    WHERE session_id_hash = ? AND human_ordinal <= ?
  `).get(event.session_id_hash, event.human_ordinal) as { compactEpoch: number | null };
  return injection.compactEpoch ?? 0;
}

function readEvidenceByTurn(db: Database.Database): Map<string, Set<string>> {
  const rows = db.prepare(`
    SELECT event.session_id_hash AS sessionHash, event.human_ordinal AS humanOrdinal,
      evidence.bundle_key AS bundleKey
    FROM owner_correction_evidence AS evidence
    JOIN owner_correction_events AS event ON event.event_id = evidence.event_id
    ORDER BY event.session_id_hash, event.human_ordinal, evidence.bundle_key
  `).all() as Array<{ sessionHash: string; humanOrdinal: number; bundleKey: string }>;
  const byTurn = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = turnKey(row.sessionHash, row.humanOrdinal);
    const bundleKeys = byTurn.get(key) ?? new Set<string>();
    bundleKeys.add(row.bundleKey);
    byTurn.set(key, bundleKeys);
  }
  return byTurn;
}

function sourceMatchesUnit(source: TurnSource | undefined, unit: ActiveUnit): boolean {
  if (!source) return false;
  if (source.isUnitKey) {
    return source.keys.has(unit.definition.unitKey) || unit.memberKeys.some((memberKey) => source.keys.has(memberKey));
  }
  if (source.keys.has(unit.definition.unitKey)) return true;
  return unit.memberKeys.some((memberKey) => source.keys.has(memberKey));
}

function resolveSourceUnitKey(
  sourceKey: string,
  at: string,
  definitions: ReadonlyMap<string, UnitDefinition>,
  members: readonly PrincipleMemberRow[],
): string {
  const activePrinciples = activeUnitsAt(definitions, members, at)
    .filter((unit) => unit.definition.kind === "principle");
  const parent = activePrinciples.find((unit) => unit.memberKeys.includes(sourceKey));
  if (parent) return parent.definition.unitKey;
  return sourceKey;
}

function createVersionContinuityChecker(db: Database.Database): (
  bundleKey: string,
  fromVersion: number,
  toVersion: number,
) => boolean {
  const cache = new Map<string, boolean>();
  return (bundleKey, fromVersion, toVersion) => {
    const key = `${bundleKey}\u0000${fromVersion}\u0000${toVersion}`;
    if (cache.has(key)) return cache.get(key) as boolean;
    const isContinuous = isEvidenceOnlyVersionContinuity(db, bundleKey, fromVersion, toVersion);
    cache.set(key, isContinuous);
    return isContinuous;
  };
}

function readLegacyA8(
  db: Database.Database,
  sessionOrderByHash: ReadonlyMap<string, number>,
  versionRows: readonly VersionRow[],
  isContinuous: (bundleKey: string, fromVersion: number, toVersion: number) => boolean,
): { numerator: number; denominator: number; rate: number | null } {
  if (!tableExists(db, "owner_correction_injections") ||
    !tableExists(db, "owner_correction_evidence")) {
    return { numerator: 0, denominator: 0, rate: null };
  }
  const injections = db.prepare(`
    SELECT DISTINCT bundle_key AS bundleKey, version, session_id_hash AS sessionHash,
      human_ordinal AS humanOrdinal, emitted_at AS emittedAt
    FROM owner_correction_injections
    WHERE body_included = 1 AND stdout_status = 'emitted'
  `).all() as InjectionRow[];
  const evidence = db.prepare(`
    SELECT DISTINCT evidence.event_id AS eventId, evidence.bundle_key AS bundleKey,
      event.session_id_hash AS sessionHash, event.human_ordinal AS humanOrdinal,
      event.observed_at AS observedAt
    FROM owner_correction_evidence AS evidence
    JOIN owner_correction_events AS event ON event.event_id = evidence.event_id
  `).all() as EvidenceRow[];
  const versions = versionRows.map((row) => ({
    ...row,
    evidenceEventIds: JSON.parse(row.evidence_event_ids) as string[],
  })) as Array<LegacyVersionRow & { evidenceEventIds: string[] }>;
  const sessionsWithBodyInjection = new Set(injections.map((row) => row.sessionHash));
  const injectionsByBundle = new Map<string, InjectionRow[]>();
  const versionsByBundle = new Map<string, Array<LegacyVersionRow & { evidenceEventIds: string[] }>>();
  for (const injection of injections) {
    const rows = injectionsByBundle.get(injection.bundleKey) ?? [];
    rows.push(injection);
    injectionsByBundle.set(injection.bundleKey, rows);
  }
  for (const version of versions) {
    const rows = versionsByBundle.get(version.bundle_key) ?? [];
    rows.push(version);
    versionsByBundle.set(version.bundle_key, rows);
  }
  const sessionsWithLaterSameBundleEvidence = new Set<string>();
  for (const row of evidence) {
    const matchingInjections = injectionsByBundle.get(row.bundleKey) ?? [];
    const bundleVersions = versionsByBundle.get(row.bundleKey) ?? [];
    const observedAt = Date.parse(row.observedAt);
    const versionIncludingEvidence = bundleVersions.find((version) => version.evidenceEventIds.includes(row.eventId));
    let versionAtEvidence = versionIncludingEvidence;
    if (!versionAtEvidence) {
      versionAtEvidence = bundleVersions.filter((version) => Date.parse(version.effective_from) <= observedAt).at(-1);
    }
    if (!versionAtEvidence) continue;
    const hasEarlierInjection = matchingInjections.some((injection) => {
      const emittedAt = Date.parse(injection.emittedAt);
      if (!Number.isFinite(observedAt) || !Number.isFinite(emittedAt)) return false;
      let occurredAfterInjection = observedAt > emittedAt;
      if (observedAt === emittedAt) {
        if (row.sessionHash === injection.sessionHash) occurredAfterInjection = row.humanOrdinal > injection.humanOrdinal;
        else occurredAfterInjection = (sessionOrderByHash.get(row.sessionHash) ?? -1) >
          (sessionOrderByHash.get(injection.sessionHash) ?? -1);
      }
      return occurredAfterInjection && isContinuous(row.bundleKey, injection.version, versionAtEvidence.version);
    });
    if (hasEarlierInjection) sessionsWithLaterSameBundleEvidence.add(row.sessionHash);
  }
  const denominator = sessionsWithBodyInjection.size;
  const numerator = sessionsWithLaterSameBundleEvidence.size;
  return { numerator, denominator, rate: denominator === 0 ? null : numerator / denominator };
}

export function readCorrectionFunnelVersionSnapshot(db: Database.Database): ReturnType<typeof readEffectiveCheckerRuleSnapshot> {
  return readEffectiveCheckerRuleSnapshot(db);
}

export function getCorrectionUnitIntentMap(
  db: Database.Database,
  eventIntentById: ReadonlyMap<string, string | ReadonlySet<string>>,
  versionSnapshot = readEffectiveCheckerRuleSnapshot(db),
): Map<string, ReadonlySet<string>> {
  const definitions = readDefinitions(db, versionSnapshot.versions as VersionRow[]);
  const members = readPrincipleMembers(versionSnapshot);
  const bundleKeysByUnit = new Map<string, Set<string>>();
  for (const definition of definitions.values()) {
    const bundleKeys = new Set([definition.unitKey]);
    if (definition.kind === "principle") {
      for (const member of members) {
        if (member.principle_key === definition.unitKey) bundleKeys.add(member.member_key);
      }
    }
    bundleKeysByUnit.set(definition.unitKey, bundleKeys);
  }
  const evidenceRows = db.prepare(`
    SELECT event_id AS eventId, bundle_key AS bundleKey
    FROM owner_correction_evidence
  `).all() as Array<{ eventId: string; bundleKey: string }>;
  const intentsByBundle = new Map<string, Set<string>>();
  for (const evidence of evidenceRows) {
    const intentValue = eventIntentById.get(evidence.eventId);
    if (!intentValue) continue;
    const intentIds = typeof intentValue === "string" ? [intentValue] : intentValue;
    const intents = intentsByBundle.get(evidence.bundleKey) ?? new Set<string>();
    for (const intentId of intentIds) intents.add(intentId);
    intentsByBundle.set(evidence.bundleKey, intents);
  }
  const result = new Map<string, ReadonlySet<string>>();
  for (const [unitKey, bundleKeys] of bundleKeysByUnit) {
    const intents = new Set<string>();
    for (const bundleKey of bundleKeys) {
      for (const intentId of intentsByBundle.get(bundleKey) ?? []) intents.add(intentId);
    }
    if (intents.size > 0) result.set(unitKey, intents);
  }
  return result;
}

function addOpportunityOutcome(
  counts: MutableFunnelCounts,
  delivered: boolean,
  recorrected: boolean,
  violation: boolean,
  checked: boolean,
): void {
  counts.opportunities += 1;
  if (delivered) counts.deliveredCount += 1;
  else counts.undeliveredCount += 1;
  const resultCounts = delivered ? counts.delivered : counts.undelivered;
  if (recorrected) {
    resultCounts.recorrected += 1;
    return;
  }
  if (violation) {
    resultCounts.violationOnly += 1;
    return;
  }
  resultCounts.kept += 1;
  if (checked) resultCounts.keptChecked += 1;
  else resultCounts.keptUnchecked += 1;
}

function addRecorrectionTotals(
  counts: MutableFunnelCounts,
  sourceByTurn: ReadonlyMap<string, TurnSource>,
  opportunitiesByTurn: ReadonlyMap<string, ActiveUnit[]>,
  definitions: ReadonlyMap<string, UnitDefinition>,
  members: readonly PrincipleMemberRow[],
  since: string,
  until: string,
  unitCounts?: Map<string, UnitFunnelCounts>,
): void {
  for (const [sourceTurnKey, source] of sourceByTurn) {
    const separator = sourceTurnKey.lastIndexOf("\u0000");
    const sessionHash = sourceTurnKey.slice(0, separator);
    const ordinal = Number(sourceTurnKey.slice(separator + 1));
    const previousOpportunities = opportunitiesByTurn.get(turnKey(sessionHash, ordinal - 1)) ?? [];
    const capturedUnits = new Set<string>();
    if (source.isUnitKey) {
      for (const unit of previousOpportunities) {
        if (source.keys.has(unit.definition.unitKey) || unit.memberKeys.some((memberKey) => source.keys.has(memberKey))) {
          capturedUnits.add(unit.definition.unitKey);
        }
      }
    } else {
      for (const sourceKey of source.keys) {
        for (const unit of previousOpportunities) {
          if (unit.definition.unitKey === sourceKey || unit.memberKeys.includes(sourceKey)) {
            capturedUnits.add(unit.definition.unitKey);
          }
        }
      }
    }
    const recurrenceUnits = new Set<string>(capturedUnits);
    if (source.isUnitKey) {
      for (const unitKey of source.keys) recurrenceUnits.add(unitKey);
    } else {
      for (const sourceKey of source.keys) {
        const matchedPreviousUnit = previousOpportunities.some((unit) =>
          unit.definition.unitKey === sourceKey || unit.memberKeys.includes(sourceKey));
        if (!matchedPreviousUnit) recurrenceUnits.add(resolveSourceUnitKey(sourceKey, source.observedAt, definitions, members));
      }
    }
    const sourceIsInWindow = source.observedAt >= since && source.observedAt <= until;
    for (const unitKey of recurrenceUnits) {
      const captured = capturedUnits.has(unitKey);
      if (!sourceIsInWindow && !captured) continue;
      counts.recorrectedTotal += 1;
      if (captured) counts.recorrectedCaptured += 1;
      if (!unitCounts) continue;
      const unit = ensureUnitCounts(unitCounts, definitions, unitKey);
      unit.recorrectedTotal += 1;
      if (captured) unit.recorrectedCaptured += 1;
    }
  }
}

export function computeCorrectionFunnel(db: Database.Database, options: FunnelOptions): FunnelReport {
  const since = parseBound(options.since, false);
  const until = parseBound(options.until, true);
  if (since.time > until.time) throw new Error("funnel since must not be after until");
  for (const tableName of ["owner_correction_events", "owner_correction_bundles", "owner_correction_versions", "owner_correction_injections", "owner_correction_evidence"]) {
    if (!tableExists(db, tableName)) throw new Error(`correction funnel requires ${tableName}`);
  }

  const versionSnapshot = options.versionSnapshot ?? readEffectiveCheckerRuleSnapshot(db);
  const versionRows = versionSnapshot.versions as VersionRow[];
  const definitions = readDefinitions(db, versionRows);
  const members = readPrincipleMembers(versionSnapshot);
  const readCheckerRulesAt = createEffectiveCheckerRuleReader(versionSnapshot);
  const isContinuous = createVersionContinuityChecker(db);
  const events = db.prepare(`
    SELECT event_id, session_id_hash, human_ordinal, observed_at, excerpt
    FROM owner_correction_events
    ORDER BY observed_at, session_id_hash, human_ordinal
  `).all() as EventRow[];
  const eventsInWindow = events.filter((event) => event.observed_at >= since.time && event.observed_at <= until.time);
  const evidenceByTurn = readEvidenceByTurn(db);
  const evidenceSourcesByTurn = new Map<string, TurnSource>();
  for (const event of events) {
    const key = turnKey(event.session_id_hash, event.human_ordinal);
    const bundleKeys = evidenceByTurn.get(key);
    if (bundleKeys?.size) evidenceSourcesByTurn.set(key, { keys: bundleKeys, isUnitKey: false, observedAt: event.observed_at });
  }
  const sourcesByTurn = new Map<string, TurnSource>();
  if (options.recorrectionSource) {
    for (const event of events) {
      const sourceKeys = options.recorrectionSource(event.session_id_hash, event.human_ordinal);
      const unitKeys = new Set([...sourceKeys].map((sourceKey) =>
        resolveSourceUnitKey(sourceKey, event.observed_at, definitions, members)));
      if (unitKeys.size > 0) {
        sourcesByTurn.set(turnKey(event.session_id_hash, event.human_ordinal), {
          keys: unitKeys,
          isUnitKey: true,
          observedAt: event.observed_at,
        });
      }
    }
  } else {
    for (const [key, source] of evidenceSourcesByTurn) sourcesByTurn.set(key, source);
  }

  const complianceTableExists = tableExists(db, "owner_correction_compliance_checks");
  const complianceRows = complianceTableExists
    ? db.prepare(`
      SELECT session_id_hash AS sessionHash, human_ordinal AS humanOrdinal,
        bundle_key AS bundleKey, version, checker, is_compliant AS isCompliant
      FROM owner_correction_compliance_checks
    `).all() as Array<{
      sessionHash: string;
      humanOrdinal: number;
      bundleKey: string;
      version: number;
      checker: string;
      isCompliant: number;
    }>
    : [];
  const checksByKey = new Map<string, number[]>();
  for (const row of complianceRows) {
    const key = `${turnKey(row.sessionHash, row.humanOrdinal)}\u0000${row.bundleKey}\u0000${row.version}\u0000${row.checker}`;
    const checks = checksByKey.get(key) ?? [];
    checks.push(row.isCompliant);
    checksByKey.set(key, checks);
  }
  const turnEpochCache = new Map<string, number>();
  const getTurnEpoch = (event: EventRow): number => {
    const key = turnKey(event.session_id_hash, event.human_ordinal);
    const cached = turnEpochCache.get(key);
    if (cached !== undefined) return cached;
    const epoch = options.turnEpoch?.(event.session_id_hash, event.human_ordinal);
    const resolved = epoch === null || epoch === undefined ? readTurnEpoch(db, event) : epoch;
    turnEpochCache.set(key, resolved);
    return resolved;
  };

  const injectionRows = db.prepare(`
    SELECT bundle_key AS bundleKey, version, session_id_hash AS sessionHash,
      human_ordinal AS humanOrdinal, compact_epoch AS compactEpoch
    FROM owner_correction_injections
    WHERE body_included = 1 AND stdout_status = 'emitted'
  `).all() as Array<InjectionRow & { compactEpoch: number }>;
  const injectionsBySession = new Map<string, Array<InjectionRow & { compactEpoch: number }>>();
  for (const injection of injectionRows) {
    const rows = injectionsBySession.get(injection.sessionHash) ?? [];
    rows.push(injection);
    injectionsBySession.set(injection.sessionHash, rows);
  }

  const overallCounts = makeMutableCounts();
  const evidenceComparisonCounts = options.includeEvidenceComparison ? makeMutableCounts() : null;
  const opportunitySources = { o1Only: 0, o2Only: 0, both: 0 };
  const unitCounts = new Map<string, UnitFunnelCounts>();
  const opportunitiesByTurn = new Map<string, ActiveUnit[]>();
  const checkerRulesByAt = new Map<string, ReturnType<typeof readCheckerRulesAt>>();

  for (const event of eventsInWindow) {
    const units = activeUnitsAt(definitions, members, event.observed_at);
    let checkerRules = checkerRulesByAt.get(event.observed_at);
    if (!checkerRules) {
      checkerRules = readCheckerRulesAt(event.observed_at);
      checkerRulesByAt.set(event.observed_at, checkerRules);
    }
    const epoch = getTurnEpoch(event);
    for (const unit of units) {
      const o1 = isRelated(event.excerpt, unit);
      const applicableCheckers = checkerRules
        .filter((rule) => rule.bundleKey === unit.definition.unitKey && rule.version === unit.version.version)
        .map((rule) => getComplianceChecker(rule))
        .filter((checker): checker is NonNullable<typeof checker> => checker !== null);
      const checkValues = applicableCheckers.flatMap((checker) =>
        checksByKey.get(`${turnKey(event.session_id_hash, event.human_ordinal)}\u0000${unit.definition.unitKey}\u0000${unit.version.version}\u0000${checker}`) ?? []);
      const hasProvenCheck = checkValues.some((value) => value === 0 || value === 1);
      const o2 = applicableCheckers.length > 0 && hasProvenCheck;
      if (!o1 && !o2) continue;

      const nextTurnKey = turnKey(event.session_id_hash, event.human_ordinal + 1);
      const recorrected = sourceMatchesUnit(sourcesByTurn.get(nextTurnKey), unit);
      const evidenceRecorrected = evidenceComparisonCounts !== null &&
        sourceMatchesUnit(evidenceSourcesByTurn.get(nextTurnKey), unit);
      const violation = checkValues.includes(0);
      const checked = checkValues.includes(1);
      const delivered = (injectionsBySession.get(event.session_id_hash) ?? []).some((injection) => {
        if (injection.humanOrdinal > event.human_ordinal || injection.compactEpoch !== epoch) return false;
        if (injection.bundleKey === unit.definition.unitKey) {
          return isContinuous(injection.bundleKey, injection.version, unit.version.version);
        }
        const memberVersion = unit.memberVersions.get(injection.bundleKey);
        return memberVersion !== undefined && isContinuous(injection.bundleKey, injection.version, memberVersion.version);
      });
      const counts = unitCounts.get(unit.definition.unitKey) ?? makeUnitCounts(unit);
      unitCounts.set(unit.definition.unitKey, counts);
      if (o1 && o2) {
        counts.opportunitySources.both += 1;
        opportunitySources.both += 1;
      } else if (o1) {
        counts.opportunitySources.o1Only += 1;
        opportunitySources.o1Only += 1;
      } else {
        counts.opportunitySources.o2Only += 1;
        opportunitySources.o2Only += 1;
      }
      addOpportunityOutcome(counts, delivered, recorrected, violation, checked);
      addOpportunityOutcome(overallCounts, delivered, recorrected, violation, checked);
      if (evidenceComparisonCounts) {
        addOpportunityOutcome(evidenceComparisonCounts, delivered, evidenceRecorrected, violation, checked);
      }
      const rows = opportunitiesByTurn.get(turnKey(event.session_id_hash, event.human_ordinal)) ?? [];
      rows.push(unit);
      opportunitiesByTurn.set(turnKey(event.session_id_hash, event.human_ordinal), rows);
    }
  }

  addRecorrectionTotals(
    overallCounts,
    sourcesByTurn,
    opportunitiesByTurn,
    definitions,
    members,
    since.time,
    until.time,
    unitCounts,
  );
  if (evidenceComparisonCounts) {
    addRecorrectionTotals(
      evidenceComparisonCounts,
      evidenceSourcesByTurn,
      opportunitiesByTurn,
      definitions,
      members,
      since.time,
      until.time,
    );
  }

  const orderByHash = options.sessionOrderByHash ?? new Map(
    [...new Set(events.map((event) => event.session_id_hash))]
      .sort()
      .map((sessionHash, index) => [sessionHash, index]),
  );
  const byUnit = [...unitCounts.entries()]
    .filter(([, counts]) => counts.opportunities > 0 || counts.recorrectedTotal > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([unitKey, counts]) => ({
      unitKey,
      kind: counts.metadata.kind,
      topicKey: counts.metadata.topicKey,
      ruleText: counts.metadata.ruleText,
      memberCount: counts.metadata.memberCount,
      effectiveFrom: counts.metadata.effectiveFrom,
      ...makeCounterReport(counts),
    }));

  const report: FunnelReport = {
    definition: "v1-20261008",
    window: { since: since.output, until: until.output },
    recorrectionSource: options.recorrectionSource ? "ledger" : "evidence",
    overall: makeCounterReport(overallCounts),
    opportunitySources,
    byUnit,
    legacyA8: readLegacyA8(db, orderByHash, versionRows, isContinuous),
  };
  if (evidenceComparisonCounts) {
    report.evidenceComparison = {
      overall: makeCounterReport(evidenceComparisonCounts),
      recorrectedDiff: overallCounts.recorrectedTotal - evidenceComparisonCounts.recorrectedTotal,
    };
  }
  return report;
}
