import type Database from "better-sqlite3";
import { extractShortCjkTokens, SQLiteStorage, tokenizeForFts } from "../storage/sqlite.js";

const MAX_QUERY_CHARACTERS = 2000;
const MAX_QUERY_TERMS = 8;
const MAX_FTS_CANDIDATES = 40;
const MAX_VISIBILITY_CANDIDATES = 20;
const MIN_RELEVANCE = 0.55;
const TOPIC_KEY_TERMS: Record<string, readonly string[]> = {
  tone: ["口調", "文体", "敬体", "常体", "敬語"],
  response_policy: ["質問", "回答", "返答", "待機"],
  document_delivery: ["文書", "文章", "本文", "全文", "提示", "文案", "報告", "資料", "文書作成"],
  expression_policy: ["言葉", "用語", "略号", "略語", "比喩"],
  summary_constraints: ["要約", "字数", "文字数", "長さ"],
  design_components: ["デザイン", "部品", "フォント", "css"],
  verification: ["検証", "確認", "出典", "原本"],
  delegation_roles: ["設計", "実装", "作業", "委譲"],
  storage_location: ["保存", "配置", "一時", "成果物"],
  model_routing: ["モデル", "経路", "担当", "利用枠"],
};

export interface CorrectionQuery {
  text: string;
  terms: string[];
  searchText: string;
}

export interface CorrectionRetrievalInput {
  project: string;
  scope: string;
  query: string;
  at: string;
  topicKeys?: readonly string[];
  toolNames?: readonly string[];
}

export interface RetrievedCorrectionRule {
  bundleKey: string;
  version: number;
  title: string;
  ruleText: string;
  topicKey: string;
  conditionKey: string;
  visibility: "owner" | "project";
  project: string;
  scope: string;
  intensity: number;
  sessionCount: number;
  lastSeenAt: string;
  expiresAt: string | null;
  lifetimeKind: "explicit_continuing" | "inferred" | "task" | "routing";
  continuationBasis: string;
}

export interface RelatedCorrectionRule extends RetrievedCorrectionRule {
  relevance: number;
}

export interface CorrectionRetrievalResult {
  query: CorrectionQuery;
  alwaysOn: RetrievedCorrectionRule[];
  projectRules: RetrievedCorrectionRule[];
  related: RelatedCorrectionRule[];
  ftsCandidateCount: number;
}

interface CorrectionRow {
  bundle_key: string;
  version: number;
  rule_text: string;
  title: string;
  topic_key: string;
  condition_key: string;
  visibility: "owner" | "project";
  project: string;
  scope: string;
  intensity: number;
  session_count: number;
  last_seen_at: string;
  expires_at: string | null;
  lifetime_kind: "explicit_continuing" | "inferred" | "task" | "routing";
  continuation_basis: string;
}

function stripQuotedText(text: string): string {
  const openToClose = new Map<string, string>([
    ["\"", "\""],
    ["“", "”"],
    ["「", "」"],
    ["『", "』"],
    ["`", "`"],
  ]);
  let closingQuote: string | null = null;
  let insideCodeFence = false;
  const result: string[] = [];
  for (const line of text.split(/\r?\n/u)) {
    if (/^\s*```/u.test(line)) {
      insideCodeFence = !insideCodeFence;
      continue;
    }
    if (insideCodeFence || /^\s*>/u.test(line)) continue;
    let unquotedLine = "";
    for (const character of line) {
      if (closingQuote !== null) {
        if (character === closingQuote) closingQuote = null;
        continue;
      }
      const closing = openToClose.get(character);
      if (closing !== undefined) {
        closingQuote = closing;
        continue;
      }
      unquotedLine += character;
    }
    result.push(unquotedLine);
  }
  return result.join(" ");
}

export function extractCorrectionQuery(query: string): CorrectionQuery {
  const bounded = Array.from(query.normalize("NFKC")).slice(0, MAX_QUERY_CHARACTERS).join("");
  const text = Array.from(stripQuotedText(bounded).replace(/\s+/gu, " ").trim())
    .slice(0, MAX_QUERY_CHARACTERS)
    .join("");
  const terms = [...tokenizeForFts(text), ...extractShortCjkTokens(text)]
    .map((term, index) => ({ term, position: text.indexOf(term), index }))
    .filter((entry) => entry.position >= 0)
    .sort((left, right) => left.position - right.position || right.term.length - left.term.length || left.index - right.index)
    .reduce<string[]>((unique, entry) => {
      const key = entry.term.normalize("NFKC").toLocaleLowerCase("en-US");
      if (unique.some((term) => term.normalize("NFKC").toLocaleLowerCase("en-US") === key)) return unique;
      unique.push(entry.term);
      return unique;
    }, [])
    .slice(0, MAX_QUERY_TERMS);

  return { text, terms, searchText: terms.join(" ") };
}

function normalizeForDice(value: string): string[] {
  const normalized = value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]/gu, "");
  return Array.from(normalized);
}

function bigramCounts(value: string): Map<string, number> {
  const characters = normalizeForDice(value);
  const counts = new Map<string, number>();
  for (let index = 0; index + 1 < characters.length; index += 1) {
    const bigram = `${characters[index]}${characters[index + 1]}`;
    counts.set(bigram, (counts.get(bigram) ?? 0) + 1);
  }
  return counts;
}

function diceCoefficient(left: string, right: string): number {
  const leftCounts = bigramCounts(left);
  const rightCounts = bigramCounts(right);
  const leftTotal = Array.from(leftCounts.values()).reduce((total, count) => total + count, 0);
  const rightTotal = Array.from(rightCounts.values()).reduce((total, count) => total + count, 0);
  if (leftTotal === 0 || rightTotal === 0) return 0;
  let intersection = 0;
  for (const [bigram, count] of leftCounts) {
    intersection += Math.min(count, rightCounts.get(bigram) ?? 0);
  }
  return (2 * intersection) / (leftTotal + rightTotal);
}

function isModelOrToolTerm(term: string, toolNames: readonly string[]): boolean {
  const normalized = term.normalize("NFKC").toLocaleLowerCase("en-US");
  const excludedNames = new Set([
    "chatgpt", "claude", "sonnet", "opus", "haiku", "gemini", "codex", "copilot",
    "openai", "mistral", "llama", ...toolNames.map((name) => name.normalize("NFKC").toLocaleLowerCase("en-US")),
  ]);
  return excludedNames.has(normalized) || /^gpt(?:[-_.]?\w+)?$/u.test(normalized);
}

const MODEL_FIRST_ROUTE = /((?:Claude\s+(?:Sonnet|Opus|Haiku)|Claude|Codex|Sonnet|Opus|GPT(?:[- ]?\d(?:\.\d)?)?|Gemini))\s*(?:で|を使って|を利用して)\s*(設計|実装|検証|分析|レビュー|テスト|文書作成|文書|コード|作業|design|implementation|verification|analysis|review|testing|documentation|coding|work)/giu;
const TASK_FIRST_ROUTE = /(設計|実装|検証|分析|レビュー|テスト|文書作成|文書|コード|作業|design|implementation|verification|analysis|review|testing|documentation|coding|work)(?:は|を)?\s*((?:Claude\s+(?:Sonnet|Opus|Haiku)|Claude|Codex|Sonnet|Opus|GPT(?:[- ]?\d(?:\.\d)?)?|Gemini))\s*(?:で|に)\s*(?:担当|実施|実行|処理|任せ)(?:して|する|る)?/giu;
const ROUTE_TASK_TERMS: Record<string, readonly string[]> = {
  design: ["設計", "design"],
  implementation: ["実装", "implementation"],
  verification: ["検証", "verification"],
  analysis: ["分析", "analysis"],
  review: ["レビュー", "review"],
  testing: ["テスト", "testing"],
  documentation: ["文書作成", "文書", "documentation"],
  coding: ["コード", "coding"],
  work: ["作業", "work"],
};

function normalizeModelName(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function routeTaskKey(value: string): string | null {
  const normalized = value.normalize("NFKC").toLocaleLowerCase("en-US");
  for (const [key, terms] of Object.entries(ROUTE_TASK_TERMS)) {
    if (terms.some((term) => normalized.includes(term.normalize("NFKC").toLocaleLowerCase("en-US")))) return key;
  }
  return null;
}

function extractModelRoutingAssignments(query: string): string[] {
  const assignments = new Set<string>();
  const patterns = [[MODEL_FIRST_ROUTE, true], [TASK_FIRST_ROUTE, false]] as const;
  for (const [pattern, modelFirst] of patterns) {
    pattern.lastIndex = 0;
    for (const match of query.matchAll(pattern)) {
      const model = modelFirst ? match[1] : match[2];
      const task = modelFirst ? match[2] : match[1];
      const taskKey = routeTaskKey(task);
      if (taskKey) assignments.add(taskKey + "=" + normalizeModelName(model));
    }
  }
  return [...assignments].sort();
}

function modelRouteMatches(
  rule: Pick<RetrievedCorrectionRule, "topicKey" | "conditionKey">,
  assignments: readonly string[],
): boolean {
  if (rule.topicKey !== "model_routing") return true;
  if (assignments.length === 0) return false;
  const conditionParts = rule.conditionKey.split(";").map((part) => part.trim());
  return assignments.some((assignment) => conditionParts.includes("route:" + assignment));
}

function inferCorrectionTopicKeys(query: string): string[] {
  const normalized = query.normalize("NFKC").toLocaleLowerCase("en-US");
  const topics = Object.entries(TOPIC_KEY_TERMS)
    .filter(([, terms]) => terms.some((term) => normalized.includes(term.normalize("NFKC").toLocaleLowerCase("en-US"))))
    .map(([topicKey]) => topicKey);
  if (extractModelRoutingAssignments(query).length > 0) topics.push("model_routing");
  return topics;
}

export function scoreCorrectionRelevance(input: {
  query: string;
  queryTerms: readonly string[];
  ruleText: string;
  topicKey: string;
  topicKeys?: readonly string[];
  toolNames?: readonly string[];
  conditionKey?: string;
}): number | null {
  const queryTopicKeys = new Set([...inferCorrectionTopicKeys(input.query), ...(input.topicKeys ?? [])]);
  const topicMatches = queryTopicKeys.has(input.topicKey);
  if (input.topicKey === "model_routing") {
    if (!modelRouteMatches({ topicKey: input.topicKey, conditionKey: input.conditionKey ?? "" }, extractModelRoutingAssignments(input.query))) {
      return null;
    }
    return 1;
  }
  if (topicMatches) return 1;

  const targetTerms = input.queryTerms.filter((term) => !isModelOrToolTerm(term, input.toolNames ?? []));
  if (targetTerms.length === 0) return null;

  const normalizedRule = input.ruleText.normalize("NFKC").toLocaleLowerCase("en-US");
  const matchedTerms = targetTerms.filter((term) =>
    normalizedRule.includes(term.normalize("NFKC").toLocaleLowerCase("en-US")),
  );
  const longTargetMatched = matchedTerms.some((term) => Array.from(term).length >= 3);
  const shortTargetMatches = matchedTerms.filter((term) => Array.from(term).length === 2);
  if (!longTargetMatched && shortTargetMatches.length < 2) return null;

  const targetMatchRate = matchedTerms.length / targetTerms.length;
  const relevance = (0.6 * targetMatchRate) + (0.4 * diceCoefficient(input.query, input.ruleText));
  if (relevance < MIN_RELEVANCE) return null;
  return relevance;
}

function mapCorrectionRow(row: CorrectionRow): RetrievedCorrectionRule {
  return {
    bundleKey: row.bundle_key,
    version: row.version,
    title: row.title,
    ruleText: row.rule_text,
    topicKey: row.topic_key,
    conditionKey: row.condition_key,
    visibility: row.visibility,
    project: row.project,
    scope: row.scope,
    intensity: row.intensity,
    sessionCount: row.session_count,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    lifetimeKind: row.lifetime_kind,
    continuationBasis: row.continuation_basis,
  };
}

function currentCorrectionSelect(where: string): string {
  return `
    SELECT b.bundle_key, b.version, v.rule_text, m.title, b.topic_key, b.condition_key, b.visibility, b.project, b.scope,
      b.intensity, b.session_count, b.last_seen_at, b.expires_at, b.lifetime_kind, b.continuation_basis
    FROM owner_correction_bundles b
    JOIN owner_correction_versions v ON v.bundle_key = b.bundle_key AND v.version = b.version
    JOIN memories m ON m.id = b.memory_id
    WHERE b.status = 'confirmed' AND v.status = 'confirmed' AND m.state = 'active' AND m.category = 'dont'
      AND (b.expires_at IS NULL OR datetime(b.expires_at) > datetime(?))
      AND (v.expires_at IS NULL OR datetime(v.expires_at) > datetime(?))
      AND b.visibility = v.visibility ${where}
  `;
}

function readAlwaysOnRules(db: Pick<Database.Database, "prepare">, input: CorrectionRetrievalInput): RetrievedCorrectionRule[] {
  const rows = db.prepare(currentCorrectionSelect(`
    AND b.visibility = 'owner' AND b.lifetime_kind IN ('explicit_continuing','inferred')
    AND length(trim(b.continuation_basis)) > 0
  `)).all(input.at, input.at) as CorrectionRow[];
  return rows.map(mapCorrectionRow);
}

function readProjectRules(db: Pick<Database.Database, "prepare">, input: CorrectionRetrievalInput): RetrievedCorrectionRule[] {
  const rows = db.prepare(currentCorrectionSelect(`
    AND b.visibility = 'project' AND b.project = ? AND b.scope = ?
    ORDER BY b.intensity DESC, b.session_count DESC, datetime(b.last_seen_at) DESC, b.bundle_key ASC
  `)).all(input.at, input.at, input.project, input.scope) as CorrectionRow[];
  return rows.map(mapCorrectionRow);
}

function readFtsRules(
  db: Pick<Database.Database, "prepare">,
  memoryIds: readonly string[],
  input: CorrectionRetrievalInput,
): RetrievedCorrectionRule[] {
  if (memoryIds.length === 0) return [];
  const placeholders = memoryIds.map(() => "?").join(", ");
  const rows = db.prepare(currentCorrectionSelect(`
    AND b.memory_id IN (${placeholders})
    AND (b.visibility = 'owner' OR (b.visibility = 'project' AND b.project = ? AND b.scope = ?))
  `)).all(input.at, input.at, ...memoryIds, input.project, input.scope) as CorrectionRow[];
  return rows.map(mapCorrectionRow);
}

function readTopicRules(
  db: Pick<Database.Database, "prepare">,
  topicKeys: readonly string[],
  input: CorrectionRetrievalInput,
): RetrievedCorrectionRule[] {
  const requestedTopics = [...new Set(topicKeys.filter((topic) => topic !== "model_routing"))];
  const routeAssignments = topicKeys.includes("model_routing") ? extractModelRoutingAssignments(input.query) : [];
  const topicConditions: string[] = [];
  const parameters: unknown[] = [input.at, input.at];
  if (requestedTopics.length > 0) {
    topicConditions.push("b.topic_key IN (" + requestedTopics.map(() => "?").join(", ") + ")");
    parameters.push(...requestedTopics);
  }
  if (routeAssignments.length > 0) {
    topicConditions.push(
      "(b.topic_key = 'model_routing' AND (" +
      routeAssignments.map(() => "b.condition_key LIKE ?").join(" OR ") +
      "))",
    );
    parameters.push(...routeAssignments.map((assignment) => "%route:" + assignment + "%"));
  }
  if (topicConditions.length === 0) return [];

  const rows = db.prepare(currentCorrectionSelect([
    "AND (" + topicConditions.join(" OR ") + ")",
    "AND (b.visibility = 'owner' OR (b.visibility = 'project' AND b.project = ? AND b.scope = ?))",
    "ORDER BY b.intensity DESC, b.session_count DESC, datetime(b.last_seen_at) DESC, b.bundle_key ASC",
  ].join("\n"))).all(...parameters, input.project, input.scope) as CorrectionRow[];
  const rulesByVisibility = new Map<string, RetrievedCorrectionRule[]>();
  for (const rule of rows.map(mapCorrectionRow)) {
    const visibleRules = rulesByVisibility.get(rule.visibility) ?? [];
    if (visibleRules.length < MAX_VISIBILITY_CANDIDATES) visibleRules.push(rule);
    rulesByVisibility.set(rule.visibility, visibleRules);
  }
  return [...(rulesByVisibility.get("owner") ?? []), ...(rulesByVisibility.get("project") ?? [])];
}

export function retrieveCorrectionCandidates(
  storage: SQLiteStorage,
  input: CorrectionRetrievalInput,
): CorrectionRetrievalResult {
  if (!input.project || !input.scope) throw new Error("correction retrieval requires project and scope");
  if (!Number.isFinite(Date.parse(input.at))) throw new Error("correction retrieval time must be valid");

  const query = extractCorrectionQuery(input.query);
  let ftsCandidateCount = 0;
  let ftsRules: RetrievedCorrectionRule[] = [];
  let topicRules: RetrievedCorrectionRule[] = [];
  let alwaysOn: RetrievedCorrectionRule[] = [];
  let projectRules: RetrievedCorrectionRule[] = [];
  const topicKeys = [...new Set([...inferCorrectionTopicKeys(input.query), ...(input.topicKeys ?? [])])];

  storage.runCorrectionTransaction(({ db }) => {
    alwaysOn = readAlwaysOnRules(db, input);
    projectRules = readProjectRules(db, input);
    topicRules = readTopicRules(db, topicKeys, input);
    if (!query.searchText) return;
    const search = storage.searchCorrectionCandidates({ query: query.searchText, project: input.project });
    const memoryIds = search.results.map((entry) => entry.id).slice(0, MAX_FTS_CANDIDATES);
    ftsRules = readFtsRules(db, memoryIds, input);
  });

  const routeAssignments = extractModelRoutingAssignments(input.query);
  const candidateMap = new Map<string, RetrievedCorrectionRule>();
  for (const rule of [...topicRules, ...ftsRules]) {
    candidateMap.set(rule.bundleKey + ":" + rule.version, rule);
  }
  const candidateCounts = new Map<string, number>();
  ftsRules = [...candidateMap.values()].filter((rule) => modelRouteMatches(rule, routeAssignments))
    .filter((rule) => {
      const count = candidateCounts.get(rule.visibility) ?? 0;
      if (count >= MAX_VISIBILITY_CANDIDATES) return false;
      candidateCounts.set(rule.visibility, count + 1);
      return true;
    });
  ftsCandidateCount = ftsRules.length;
  const related = ftsRules
    .map((rule) => ({
      rule,
      relevance: scoreCorrectionRelevance({
        query: query.text,
        queryTerms: query.terms,
        ruleText: rule.ruleText,
        topicKey: rule.topicKey,
        conditionKey: rule.conditionKey,
        topicKeys: input.topicKeys,
        toolNames: input.toolNames,
      }),
    }))
    .filter((entry): entry is { rule: RetrievedCorrectionRule; relevance: number } => entry.relevance !== null)
    .sort((left, right) => right.relevance - left.relevance ||
      right.rule.intensity - left.rule.intensity ||
      right.rule.sessionCount - left.rule.sessionCount ||
      Date.parse(right.rule.lastSeenAt) - Date.parse(left.rule.lastSeenAt) ||
      left.rule.bundleKey.localeCompare(right.rule.bundleKey))
    .slice(0, MAX_FTS_CANDIDATES)
    .map((entry) => ({ ...entry.rule, relevance: entry.relevance }));

  return { query, alwaysOn, projectRules, related, ftsCandidateCount };
}
