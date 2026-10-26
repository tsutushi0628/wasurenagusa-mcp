/**
 * オーナー指摘の明示記録。
 * AI が「次回の行動1行」「場面1行」「原文」を書き、確定済み束として保存する。
 * 保存先は owner_correction_* と memories(dont)。ID・番号はオーナーに見せない。
 */
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { SQLiteStorage } from "../storage/sqlite.js";
import { retrieveCorrectionCandidates } from "./retrieval.js";

export const EXPLICIT_TOPIC_KEY = "explicit";
export const EXPLICIT_DETECTOR_VERSION = "owner-explicit-v1";
const MAX_RULE_CHARACTERS = 240;
const MAX_SCENE_CHARACTERS = 120;

export interface ExplicitRuleInput {
  rule: string;
  scene: string;
  quote?: string;
  project?: string | null;
  at?: string;
  sourceKind?: "user" | "legacy_import";
  quoteDate?: string;
  occurrenceBonus?: number;
}

export interface ExplicitRuleResult {
  bundleKey: string;
  created: boolean;
  rule: string;
  scene: string;
}

export interface ExplicitRuleRow {
  bundle_key: string;
  memory_id: string;
  rule_text: string;
  title: string;
  project: string;
  visibility: "owner" | "project";
  occurrence_count: number;
  last_seen_at: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeLine(value: string, label: string, max: number): string {
  const text = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!text) throw new Error(`${label} is required`);
  if (text.includes("\n")) throw new Error(`${label} must be one line`);
  if (Array.from(text).length > max) throw new Error(`${label} exceeds ${max} characters`);
  return text;
}

export function explicitBundleKey(rule: string, project: string | null): string {
  const identity = JSON.stringify([EXPLICIT_TOPIC_KEY, sha256(rule), project ?? "owner"]);
  return `oc:v2:${sha256(identity)}`;
}

function explicitEventId(bundleKey: string, quote: string, at: string): string {
  return `ev:explicit:${sha256(JSON.stringify([bundleKey, quote, at]))}`;
}

type Tx = Parameters<Parameters<SQLiteStorage["runCorrectionTransaction"]>[0]>[0];

function insertEvent(
  db: Tx["db"],
  input: { eventId: string; at: string; quote: string; project: string; sourceKind: "user" | "legacy_import" },
): void {
  const excerpt = Array.from(input.quote).slice(0, 120).join("");
  db.prepare(`
    INSERT OR IGNORE INTO owner_correction_events (
      event_id, session_id_hash, source_uuid_hash, human_ordinal, observed_at, available_at,
      source_kind, excerpt, previous_action, action_first_locator_hash, action_last_locator_hash,
      project, scope, raw_text_hash, source_locator_hash, processed_at
    ) VALUES (?, ?, NULL, 1, ?, ?, ?, ?, '', NULL, NULL, ?, 'general', ?, ?, ?)
  `).run(
    input.eventId, sha256("explicit"), input.at, input.at, input.sourceKind, excerpt,
    input.project, sha256(input.quote), sha256(input.eventId), input.at,
  );
}

function insertEvidence(db: Tx["db"], eventId: string, bundleKey: string, scene: string): void {
  db.prepare(`
    INSERT OR IGNORE INTO owner_correction_evidence (event_id, bundle_key, source, score, detector_version, conditions, polarity)
    VALUES (?, ?, 'request_repeat', 10, ?, ?, 'do')
  `).run(eventId, bundleKey, EXPLICIT_DETECTOR_VERSION, JSON.stringify({ kind: EXPLICIT_TOPIC_KEY, scene }));
}

/** 規則を確定済み束として保存。同じ規則文が既にあれば根拠だけ足す。 */
export function recordExplicitRule(storage: SQLiteStorage, input: ExplicitRuleInput): ExplicitRuleResult {
  const rule = normalizeLine(input.rule, "rule", MAX_RULE_CHARACTERS);
  const scene = normalizeLine(input.scene, "scene", MAX_SCENE_CHARACTERS);
  const project = input.project && input.project.trim() ? input.project.trim() : null;
  const at = input.at ?? new Date().toISOString();
  const quote = (input.quote ?? "").replace(/\s+/gu, " ").trim();
  const sourceKind = input.sourceKind ?? "user";
  const bundleKey = explicitBundleKey(rule, project);
  const visibility = project ? "project" : "owner";
  const projectColumn = project ?? "owner";

  return storage.runCorrectionTransaction(({ db, save }) => {
    const existing = db.prepare("SELECT bundle_key, occurrence_count FROM owner_correction_bundles WHERE bundle_key = ?")
      .get(bundleKey) as { bundle_key: string; occurrence_count: number } | undefined;
    const quoteAt = input.quoteDate ? `${input.quoteDate}T00:00:00.000Z` : at;
    if (existing) {
      if (quote) {
        const eventId = explicitEventId(bundleKey, quote, quoteAt);
        insertEvent(db, { eventId, at: quoteAt, quote, project: projectColumn, sourceKind });
        insertEvidence(db, eventId, bundleKey, scene);
      }
      db.prepare(`
        UPDATE owner_correction_bundles
        SET occurrence_count = occurrence_count + ?, last_seen_at = CASE WHEN datetime(?) > datetime(last_seen_at) THEN ? ELSE last_seen_at END
        WHERE bundle_key = ?
      `).run((quote ? 1 : 0) + (input.occurrenceBonus ?? 0), at, at, bundleKey);
      return { bundleKey, created: false, rule, scene };
    }

    const saved = save({
      category: "dont",
      title: scene,
      content: rule,
      tags: ["owner-rule"],
      ...(project ? { project, projectConfidence: "confirmed" as const } : {}),
      scope: "general",
      intensity: 8,
      positiveAction: rule,
    });
    const memoryId = saved.id;
    const eventQuote = quote || rule;
    const eventId = explicitEventId(bundleKey, eventQuote, quoteAt);
    insertEvent(db, { eventId, at: quoteAt, quote: eventQuote, project: projectColumn, sourceKind });
    const occurrence = (quote ? 1 : 0) + (input.occurrenceBonus ?? 0);
    db.prepare(`
      INSERT INTO owner_correction_bundles (
        bundle_key, memory_id, rule_text, topic_key, polarity, condition_key, project, scope,
        visibility, status, intensity, occurrence_count, session_count, first_seen_at, last_seen_at,
        expires_at, lifetime_kind, continuation_basis, confirmed_at, version, counterevidence_event_id,
        last_confirmation_asked_at, confirmation_state
      ) VALUES (?, ?, ?, ?, 'do', ?, ?, 'general', ?, 'confirmed', 4, ?, 1, ?, ?, NULL, 'inferred', '', ?, 1, NULL, NULL, 'answered')
    `).run(bundleKey, memoryId, rule, EXPLICIT_TOPIC_KEY, `scene:${sha256(scene)}`, projectColumn, visibility, occurrence, quoteAt, at, at);
    db.prepare(`
      INSERT INTO owner_correction_versions (
        bundle_key, version, rule_text, body_hash, conditions, condition_key, polarity, visibility, status,
        confirmed_at, expires_at, lifetime_kind, continuation_basis, evidence_event_ids, effective_from, change_reason
      ) VALUES (?, 1, ?, ?, ?, ?, 'do', ?, 'confirmed', ?, NULL, 'inferred', '', ?, ?, 'owner_explicit')
    `).run(bundleKey, rule, sha256(rule), JSON.stringify({ kind: EXPLICIT_TOPIC_KEY, scene }), `scene:${sha256(scene)}`, visibility, at, JSON.stringify([eventId]), at);
    insertEvidence(db, eventId, bundleKey, scene);
    return { bundleKey, created: true, rule, scene };
  });
}

/** 規則文か場面の一部で既存の明示規則を探す（FTS → 部分一致）。 */
export function findExplicitRules(storage: SQLiteStorage, query: string, project: string, limit = 5): ExplicitRuleRow[] {
  const text = query.normalize("NFKC").trim();
  return storage.runCorrectionTransaction(({ db }) => {
    const base = `
      SELECT b.bundle_key, b.memory_id, b.rule_text, m.title, b.project, b.visibility, b.occurrence_count, b.last_seen_at
      FROM owner_correction_bundles b JOIN memories m ON m.id = b.memory_id
      WHERE b.topic_key = ? AND b.status = 'confirmed' AND m.state = 'active'
        AND (b.visibility = 'owner' OR b.project = ?)
    `;
    if (!text) {
      return db.prepare(`${base} ORDER BY datetime(b.last_seen_at) DESC LIMIT ?`).all(EXPLICIT_TOPIC_KEY, project, limit) as ExplicitRuleRow[];
    }
    const exact = db.prepare(`${base} AND (b.rule_text = ? OR m.title = ?) LIMIT ?`).all(EXPLICIT_TOPIC_KEY, project, text, text, limit) as ExplicitRuleRow[];
    if (exact.length > 0) return exact;
    const like = `%${text}%`;
    const partial = db.prepare(`${base} AND (b.rule_text LIKE ? OR m.title LIKE ?) ORDER BY datetime(b.last_seen_at) DESC LIMIT ?`)
      .all(EXPLICIT_TOPIC_KEY, project, like, like, limit) as ExplicitRuleRow[];
    if (partial.length > 0) return partial;
    const search = storage.searchCorrectionCandidates({ query: text, project });
    const ids = search.results.map((entry) => entry.id).slice(0, limit);
    if (ids.length === 0) return [];
    return db.prepare(`${base} AND b.memory_id IN (${ids.map(() => "?").join(",")})`).all(EXPLICIT_TOPIC_KEY, project, ...ids) as ExplicitRuleRow[];
  });
}

/** 既存の規則に根拠（原文）を足す。見つからなければ null。 */
export function recurExplicitRule(
  storage: SQLiteStorage,
  input: { query: string; quote: string; project: string; at?: string },
): ExplicitRuleRow | null {
  const matches = findExplicitRules(storage, input.query, input.project, 1);
  const target = matches[0];
  if (!target) return null;
  const at = input.at ?? new Date().toISOString();
  const quote = input.quote.replace(/\s+/gu, " ").trim();
  storage.runCorrectionTransaction(({ db }) => {
    if (quote) {
      const eventId = explicitEventId(target.bundle_key, quote, at);
      insertEvent(db, { eventId, at, quote, project: target.project, sourceKind: "user" });
      insertEvidence(db, eventId, target.bundle_key, target.title);
    }
    db.prepare("UPDATE owner_correction_bundles SET occurrence_count = occurrence_count + 1, last_seen_at = ? WHERE bundle_key = ?")
      .run(at, target.bundle_key);
    db.prepare("UPDATE memories SET updated_at = datetime('now') WHERE id = ?").run(target.memory_id);
  });
  return { ...target, occurrence_count: target.occurrence_count + 1, last_seen_at: at };
}

/** 原始人調の注入本文。ID なし、1規則1行。 */
export function renderRuleLines(rules: ReadonlyArray<{ ruleText: string }>): string {
  return rules.map((rule) => `- ${rule.ruleText}`).join("\n");
}

/** サブ・Codex 招聘向け: 依頼文に関係する規則を規則文だけで返す。 */
export function renderRulesForSubagent(
  storage: SQLiteStorage,
  input: { project: string; query: string; at?: string; limit?: number },
): string {
  const limit = input.limit ?? 5;
  const at = input.at ?? new Date().toISOString();
  const retrieval = retrieveCorrectionCandidates(storage, { project: input.project, scope: "general", query: input.query, at });
  const seen = new Set<string>();
  const picked: Array<{ ruleText: string }> = [];
  for (const rule of [...retrieval.related, ...retrieval.projectRules]) {
    if (seen.has(rule.bundleKey) || !rule.ruleText.trim()) continue;
    seen.add(rule.bundleKey);
    picked.push({ ruleText: rule.ruleText });
    if (picked.length >= limit) break;
  }
  if (picked.length === 0) return "";
  return `オーナーの過去の指摘（今回関係）\n${renderRuleLines(picked)}`;
}

/** Stop 用: transcript の記録列に記録ツール呼び出しがあるか。 */
export function transcriptHasExplicitRecord(records: ReadonlyArray<{ entry: Record<string, unknown> }>, afterByteOffset: number, byteOffsets: ReadonlyArray<number>): boolean {
  for (let index = 0; index < records.length; index += 1) {
    if (byteOffsets[index] <= afterByteOffset) continue;
    const entry = records[index].entry;
    const message = entry.message as { content?: unknown } | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const typed = block as { type?: string; name?: string };
      if (typed.type === "tool_use" && typeof typed.name === "string" && /correction_(record|recur)$/u.test(typed.name)) return true;
    }
  }
  return false;
}

export function countExplicitRules(db: Pick<Database.Database, "prepare">): { bundles: number; evidence: number } {
  const bundles = (db.prepare("SELECT COUNT(*) AS count FROM owner_correction_bundles WHERE topic_key = ?").get(EXPLICIT_TOPIC_KEY) as { count: number }).count;
  const evidence = (db.prepare("SELECT COUNT(*) AS count FROM owner_correction_evidence WHERE detector_version = ?").get(EXPLICIT_DETECTOR_VERSION) as { count: number }).count;
  return { bundles, evidence };
}

const EXPLICIT_STOPWORDS = new Set(["ok", "はい", "うん", "keep-alive", "alive", "keep","する", "して", "ください", "下さい", "ほしい", "欲しい", "こと", "もの", "ため", "よう", "とき", "それ", "これ", "あれ", "どれ", "ので", "から", "まで", "です", "ます", "した", "いる", "ある", "なる", "できる", "お願い", "おねがい", "たい", "ない", "よろしく"]);

function normalizeText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

export interface ExplicitTerm { term: string; weight: number; latin: boolean }

/** 依頼文から照合語を取る。漢字・カタカナ・英数の連続（2文字以上）を内容語とみなし、ひらがなの助詞・活用は捨てる。 */
export function explicitQueryTerms(query: string): ExplicitTerm[] {
  const text = normalizeText(query).replace(/\s+/gu, " ").trim();
  const runs = text.match(/[\p{Script=Han}]+|[\p{Script=Katakana}ー]+|[a-z][a-z0-9_.-]+|\d+[a-z%]*/gu) ?? [];
  const unique = new Map<string, ExplicitTerm>();
  const push = (term: string, weight: number, latin: boolean): void => {
    if (Array.from(term).length < 2 || EXPLICIT_STOPWORDS.has(term) || /^\d+$/u.test(term)) return;
    if (latin && term.length < 3) return;
    if (!unique.has(term)) unique.set(term, { term, weight, latin });
  };
  for (const run of runs) {
    const latin = /^[a-z0-9_.-]+$/u.test(run);
    const characters = Array.from(run);
    push(run, Math.min(6, characters.length), latin);
    if (/^[\p{Script=Han}]+$/u.test(run) && characters.length >= 3) {
      for (let index = 0; index + 1 < characters.length; index += 1) push(characters[index] + characters[index + 1], 1, false);
    }
  }
  return [...unique.values()].slice(0, 48);
}

function bigrams(value: string): Map<string, number> {
  const characters = Array.from(normalizeText(value).replace(/[^\p{L}\p{N}]/gu, ""));
  const counts = new Map<string, number>();
  for (let index = 0; index + 1 < characters.length; index += 1) {
    const key = characters[index] + characters[index + 1];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function containsTerm(haystack: string, term: ExplicitTerm): boolean {
  if (!term.latin) return haystack.includes(term.term);
  let from = 0;
  while (from <= haystack.length) {
    const index = haystack.indexOf(term.term, from);
    if (index < 0) return false;
    const before = index === 0 ? "" : haystack[index - 1];
    const after = haystack[index + term.term.length] ?? "";
    if (!/[a-z0-9]/u.test(before) && !/[a-z0-9]/u.test(after)) return true;
    from = index + 1;
  }
  return false;
}

/** 依頼文と規則（場面＋規則文＋過去の原文）の近さ。0〜1。内容語の被覆と、場面との bigram 一致の合成。 */
export function scoreExplicitRule(query: string, scene: string, rule: string, terms: ExplicitTerm[] = explicitQueryTerms(query), excerpts = ""): number {
  const wholeTerms = terms.filter((term) => term.weight > 1);
  if (wholeTerms.length < 2) return 0;
  const haystack = normalizeText(`${scene} ${rule} ${excerpts}`);
  let matchedWeight = 0;
  let totalWeight = 0;
  let matchedWhole = 0;
  for (const term of terms) {
    totalWeight += term.weight;
    if (containsTerm(haystack, term)) {
      matchedWeight += term.weight;
      if (term.weight > 1) matchedWhole += 1;
    }
  }
  if (matchedWhole === 0) return 0;
  const coverage = totalWeight === 0 ? 0 : matchedWeight / totalWeight;
  const queryBigrams = bigrams(query);
  const sceneBigrams = bigrams(scene);
  let hit = 0;
  let sceneTotal = 0;
  for (const [key, count] of sceneBigrams) {
    sceneTotal += count;
    hit += Math.min(count, queryBigrams.get(key) ?? 0);
  }
  const sceneOverlap = sceneTotal === 0 ? 0 : hit / sceneTotal;
  return Math.min(1, 0.6 * coverage + 0.6 * sceneOverlap);
}

export const EXPLICIT_MIN_RELEVANCE = 0.3;

export interface ScoredExplicitRule { bundleKey: string; version: number; ruleText: string; scene: string; visibility: "owner" | "project"; project: string; relevance: number; lastSeenAt: string; occurrenceCount: number }

/** 明示規則を全件読んで依頼文との近さで並べる（281件程度、数ms）。 */
export function rankExplicitRules(
  db: Pick<Database.Database, "prepare">,
  input: { query: string; project: string; limit?: number; minRelevance?: number },
): ScoredExplicitRule[] {
  const terms = explicitQueryTerms(input.query);
  if (terms.length === 0) return [];
  const rows = db.prepare(`
    SELECT b.bundle_key, b.version, b.rule_text, m.title AS scene, b.visibility, b.project, b.last_seen_at, b.occurrence_count,
      (SELECT group_concat(e.excerpt, ' ') FROM owner_correction_evidence ev JOIN owner_correction_events e ON e.event_id = ev.event_id
        WHERE ev.bundle_key = b.bundle_key) AS excerpts
    FROM owner_correction_bundles b JOIN memories m ON m.id = b.memory_id
    WHERE b.topic_key = ? AND b.status = 'confirmed' AND m.state = 'active'
      AND (b.visibility = 'owner' OR b.project = ?)
  `).all(EXPLICIT_TOPIC_KEY, input.project) as Array<{ bundle_key: string; version: number; rule_text: string; scene: string; visibility: "owner" | "project"; project: string; last_seen_at: string; occurrence_count: number; excerpts: string | null }>;
  const minRelevance = input.minRelevance ?? EXPLICIT_MIN_RELEVANCE;
  return rows
    .map((row) => ({
      bundleKey: row.bundle_key, version: row.version, ruleText: row.rule_text, scene: row.scene, visibility: row.visibility,
      project: row.project, lastSeenAt: row.last_seen_at, occurrenceCount: row.occurrence_count,
      relevance: scoreExplicitRule(input.query, row.scene, row.rule_text, terms, row.excerpts ?? ""),
    }))
    .filter((row) => row.relevance >= minRelevance)
    .sort((left, right) => right.relevance - left.relevance || right.occurrenceCount - left.occurrenceCount || Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt) || left.bundleKey.localeCompare(right.bundleKey))
    .slice(0, input.limit ?? 5);
}
