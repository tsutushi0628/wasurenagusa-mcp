#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { readRecurrenceLedger } from "../replay/lib/recurrence-ledger.mjs";

const MAX_SAME_GROUP_COUNT = 30;
const MAX_MIXED_GROUP_COUNT = 30;
const MAX_GROUP_COUNT = MAX_SAME_GROUP_COUNT + MAX_MIXED_GROUP_COUNT;
const MAX_SAME_GROUP_ITEMS = 4;
const MAX_TEMPLATE_LINES = 100;
const MAX_PRINCIPLE_LENGTH = 120;
const MAX_GROUP_ITEMS = 10;
const MAX_QUOTA_CONSUMPTION_POINTS = 3;
const MIN_REMAINING_QUOTA_PERCENT = 30;
const CODEX_TIMEOUT_MS = 20 * 60 * 1000;
const GROUPS_PLACEHOLDER = "{{GROUPS_JSON}}";
const NEGATIVE_POLARITY_PATTERN = /(?:ないで|しない|さない|わない|するな|(?:使|出|示|提示|表示|見せ)(?:うな|すな)|やめ|禁止|避け|省(?:く|いて|か)|除外)/u;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countPromptLines(prompt) {
  if (typeof prompt !== "string" || prompt.trim() === "") return 0;
  return prompt.trim().split(/\r?\n/u).length;
}

function countPromptTemplateLines(template) {
  return countPromptLines(template);
}

function groupCombinationKey(items) {
  return items.map((item) => item.bundle_key).sort().join("+");
}

function nearMissBasis(items) {
  for (let leftIndex = 0; leftIndex < items.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < items.length; rightIndex += 1) {
      const left = items[leftIndex];
      const right = items[rightIndex];
      if (left.intent_id !== right.intent_id && left.topic_key === right.topic_key) {
        return "same_topic_different_intent";
      }
      if (left.condition_key === right.condition_key && left.condition_key !== "general"
        && left.polarity !== right.polarity) {
        return "same_target_opposite_polarity";
      }
    }
  }
  return null;
}

function groupStatistics(groups) {
  const kindCounts = { same_intent: 0, mixed_intent: 0 };
  const intentGroupCounts = new Map();
  const bundleKeys = new Set();
  const intentIds = new Set();
  const sameIntentGroupIntentTypeCounts = [];
  let nearMissMixedGroupCount = 0;

  for (const group of groups) {
    kindCounts[group.kind] += 1;
    const groupIntentIds = new Set(group.items.map((item) => item.intent_id));
    if (group.kind === "same_intent") sameIntentGroupIntentTypeCounts.push(groupIntentIds.size);
    if (group.kind === "mixed_intent" && nearMissBasis(group.items) !== null) nearMissMixedGroupCount += 1;
    for (const intentId of groupIntentIds) {
      intentIds.add(intentId);
      if (!intentGroupCounts.has(intentId)) {
        intentGroupCounts.set(intentId, { same_intent: 0, mixed_intent: 0, total: 0 });
      }
      const counts = intentGroupCounts.get(intentId);
      counts[group.kind] += 1;
      counts.total += 1;
    }
    for (const item of group.items) {
      bundleKeys.add(item.bundle_key);
    }
  }

  return {
    group_count: groups.length,
    kind_counts: kindCounts,
    intent_count: intentIds.size,
    intent_group_counts: Object.fromEntries([...intentGroupCounts.entries()].sort(([left], [right]) => left.localeCompare(right))),
    same_intent_group_intent_type_counts: sameIntentGroupIntentTypeCounts,
    unique_bundle_count: bundleKeys.size,
    mixed_candidate_group_count: kindCounts.mixed_intent,
    near_miss_mixed_group_count: nearMissMixedGroupCount,
    near_miss_mixed_ratio_pct: kindCounts.mixed_intent === 0
      ? null
      : rounded((nearMissMixedGroupCount / kindCounts.mixed_intent) * 100),
  };
}

function assertValidGroups(groups) {
  if (!Array.isArray(groups) || groups.length === 0
    || groups.length > MAX_GROUP_COUNT) {
    throw new Error("groups must contain between 1 and 60 groups");
  }

  const groupIds = new Set();
  const combinations = new Set();
  let sameCount = 0;
  let mixedCount = 0;

  for (const group of groups) {
    if (!isRecord(group) || typeof group.group_id !== "string" || group.group_id.length === 0
      || groupIds.has(group.group_id) || !Array.isArray(group.items)
      || group.items.length < 2 || group.items.length > MAX_GROUP_ITEMS) {
      throw new Error("invalid abstraction group");
    }
    groupIds.add(group.group_id);

    const intentIds = new Set();
    const polarities = new Set();
    const itemIds = new Set();
    const bundleKeys = new Set();
    for (const item of group.items) {
      if (!isRecord(item) || !Number.isInteger(item.id) || item.id < 1 || itemIds.has(item.id)
        || typeof item.rule_text !== "string" || item.rule_text.trim() === ""
        || typeof item.intent_id !== "string" || item.intent_id === ""
        || typeof item.topic_key !== "string" || item.topic_key === ""
        || typeof item.condition_key !== "string" || item.condition_key === ""
        || typeof item.bundle_key !== "string" || item.bundle_key === "" || bundleKeys.has(item.bundle_key)
        || (item.bundle_status !== "candidate" && item.bundle_status !== "confirmed")
        || !Array.isArray(item.source_klasses) || item.source_klasses.length === 0
        || item.source_klasses.some((klass) => klass !== "a" && klass !== "c")
        || !Array.isArray(item.source_event_hashes) || item.source_event_hashes.length === 0
        || item.source_event_hashes.some((hash) => typeof hash !== "string" || !/^[a-f0-9]{64}$/u.test(hash))
        || (item.polarity !== "positive" && item.polarity !== "negative")) {
        throw new Error("invalid abstraction group item");
      }
      itemIds.add(item.id);
      bundleKeys.add(item.bundle_key);
      intentIds.add(item.intent_id);
      polarities.add(item.polarity);
    }

    if (group.kind === "same_intent") {
      if (intentIds.size !== 1 || group.items.length > MAX_SAME_GROUP_ITEMS
        || new Set(group.items.map((item) => item.topic_key)).size !== 1 || polarities.size !== 1) {
        throw new Error("same_intent group must contain 2-4 items with one intent, topic, and polarity");
      }
      sameCount += 1;
    } else if (group.kind === "mixed_intent") {
      if (intentIds.size < 2) throw new Error("mixed_intent group must combine intents");
      const expectedNearMissBasis = nearMissBasis(group.items);
      if (group.near_miss !== undefined && group.near_miss !== (expectedNearMissBasis !== null)) {
        throw new Error("mixed group near-miss label does not match its source items");
      }
      if (group.near_miss_basis !== undefined && group.near_miss_basis !== expectedNearMissBasis) {
        throw new Error("mixed group near-miss basis does not match its source items");
      }
      mixedCount += 1;
    } else {
      throw new Error("unsupported abstraction group kind");
    }

    const combinationKey = groupCombinationKey(group.items);
    if (group.combination_key !== undefined && group.combination_key !== combinationKey) {
      throw new Error("group combination key does not match its items");
    }
    const uniqueCombinationKey = group.kind + ":" + combinationKey;
    if (combinations.has(uniqueCombinationKey)) throw new Error("duplicate abstraction group combination");
    combinations.add(uniqueCombinationKey);
  }

  if (sameCount > MAX_SAME_GROUP_COUNT || mixedCount > MAX_MIXED_GROUP_COUNT) {
    throw new Error("group kind count exceeds the supported limit");
  }
  return {
    ...groupStatistics(groups),
    same_count: sameCount,
    mixed_count: mixedCount,
  };
}

function combinations(items, minimumSize, maximumSize, maximumCount) {
  const result = [];
  const selected = [];

  function visit(startIndex, targetSize) {
    if (result.length >= maximumCount) return;
    if (selected.length === targetSize) {
      result.push([...selected]);
      return;
    }
    const remaining = targetSize - selected.length;
    for (let index = startIndex; index <= items.length - remaining; index += 1) {
      selected.push(items[index]);
      visit(index + 1, targetSize);
      selected.pop();
      if (result.length >= maximumCount) return;
    }
  }

  for (let size = minimumSize; size <= Math.min(maximumSize, items.length); size += 1) {
    visit(0, size);
    if (result.length >= maximumCount) break;
  }
  return result;
}

function roundRobinGroups(groupBuckets, maximumCount) {
  const selected = [];
  const cursors = new Map(groupBuckets.map(([key]) => [key, 0]));
  let hasMore = true;
  while (selected.length < maximumCount && hasMore) {
    hasMore = false;
    for (const [key, candidates] of groupBuckets) {
      const cursor = cursors.get(key);
      if (cursor >= candidates.length) continue;
      selected.push(candidates[cursor]);
      cursors.set(key, cursor + 1);
      hasMore = true;
      if (selected.length >= maximumCount) break;
    }
  }
  return selected;
}

function generateAbstractionGroups(ledgerRows, bundleRows) {
  if (!Array.isArray(ledgerRows) || !Array.isArray(bundleRows)) {
    throw new Error("ledger rows and bundle rows must be arrays");
  }

  const ledgerByIdentity = new Map();
  const ledgerAcIntentIds = new Set();
  const ledgerExIntentIds = new Set();
  for (const row of ledgerRows) {
    if (!isRecord(row) || typeof row.event_hash !== "string" || !/^[a-f0-9]{64}$/u.test(row.event_hash)
      || typeof row.session_hash !== "string" || !/^[a-f0-9]{64}$/u.test(row.session_hash)
      || typeof row.intent_id !== "string" || row.intent_id === ""
      || !["a", "b", "c", "d", "e", "x"].includes(row.klass)) {
      throw new Error("invalid recurrence ledger row");
    }
    const identity = row.event_hash + "\t" + row.session_hash;
    if (!ledgerByIdentity.has(identity)) ledgerByIdentity.set(identity, []);
    ledgerByIdentity.get(identity).push(row);
    if (row.klass === "a" || row.klass === "c") ledgerAcIntentIds.add(row.intent_id);
    if (row.klass === "e" || row.klass === "x") ledgerExIntentIds.add(row.intent_id);
  }

  const bundleSources = new Map();
  for (const row of bundleRows) {
    if (!isRecord(row) || typeof row.event_id !== "string" || row.event_id === ""
      || typeof row.session_hash !== "string" || !/^[a-f0-9]{64}$/u.test(row.session_hash)
      || typeof row.bundle_key !== "string" || row.bundle_key === ""
      || typeof row.rule_text !== "string"
      || typeof row.topic_key !== "string" || row.topic_key === ""
      || typeof row.condition_key !== "string" || row.condition_key === ""
      || (row.polarity !== "positive" && row.polarity !== "negative")
      || (row.status !== "candidate" && row.status !== "confirmed")) {
      throw new Error("invalid owner correction bundle row");
    }
    const eventHash = createHash("sha256").update(row.event_id).digest("hex");
    const ledgerMatches = ledgerByIdentity.get(eventHash + "\t" + row.session_hash);
    if (!ledgerMatches) continue;
    const eligibleMatches = ledgerMatches.filter((ledgerRow) => ledgerRow.klass === "a" || ledgerRow.klass === "c");
    if (eligibleMatches.length === 0) continue;

    if (!bundleSources.has(row.bundle_key)) {
      bundleSources.set(row.bundle_key, {
        rule_text: row.rule_text,
        topic_key: row.topic_key,
        condition_key: row.condition_key,
        polarity: row.polarity,
        status: row.status,
        intent_ids: new Set(),
        klasses: new Set(),
        event_hashes: new Set(),
      });
    }
    const source = bundleSources.get(row.bundle_key);
    if (source.rule_text !== row.rule_text || source.topic_key !== row.topic_key
      || source.condition_key !== row.condition_key || source.polarity !== row.polarity
      || source.status !== row.status) {
      throw new Error("owner correction bundle has inconsistent source rows");
    }
    for (const ledgerRow of eligibleMatches) {
      source.intent_ids.add(ledgerRow.intent_id);
      source.klasses.add(ledgerRow.klass);
      source.event_hashes.add(ledgerRow.event_hash);
    }
  }

  let ambiguousIntentBundleCount = 0;
  let emptyRuleTextBundleCount = 0;
  const eligibleItems = [];
  const orderedSources = [...bundleSources.entries()].sort(([left], [right]) => left.localeCompare(right));
  for (const [bundleKey, source] of orderedSources) {
    if (source.rule_text.trim() === "") emptyRuleTextBundleCount += 1;
    if (source.intent_ids.size !== 1) {
      ambiguousIntentBundleCount += 1;
      continue;
    }
    if (source.rule_text.trim() === "") {
      continue;
    }
    eligibleItems.push({
      bundle_key: bundleKey,
      rule_text: source.rule_text,
      topic_key: source.topic_key,
      condition_key: source.condition_key,
      polarity: source.polarity,
      bundle_status: source.status,
      intent_id: [...source.intent_ids][0],
      source_klasses: [...source.klasses].sort(),
      source_event_hashes: [...source.event_hashes].sort(),
    });
  }

  eligibleItems.sort((left, right) => left.intent_id.localeCompare(right.intent_id)
    || left.topic_key.localeCompare(right.topic_key)
    || left.bundle_key.localeCompare(right.bundle_key));
  const itemIds = new Map(eligibleItems.map((item, index) => [item.bundle_key, index + 1]));

  const sameBuckets = new Map();
  for (const item of eligibleItems) {
    const key = JSON.stringify([item.intent_id, item.topic_key, item.polarity]);
    if (!sameBuckets.has(key)) sameBuckets.set(key, { intent_id: item.intent_id, items: [] });
    sameBuckets.get(key).items.push(item);
  }
  const sameGroupsByIntent = new Map();
  for (const bucket of sameBuckets.values()) {
    const candidates = combinations(bucket.items, 2, MAX_SAME_GROUP_ITEMS, MAX_SAME_GROUP_COUNT)
      .map((items) => ({ items, combination_key: groupCombinationKey(items) }));
    if (candidates.length === 0) continue;
    if (!sameGroupsByIntent.has(bucket.intent_id)) sameGroupsByIntent.set(bucket.intent_id, []);
    sameGroupsByIntent.get(bucket.intent_id).push(...candidates);
  }
  const sameCandidates = roundRobinGroups(
    [...sameGroupsByIntent.entries()].sort(([left], [right]) => left.localeCompare(right)),
    MAX_SAME_GROUP_COUNT,
  );

  const nearMissCandidates = [];
  const unrelatedCandidates = [];
  for (let leftIndex = 0; leftIndex < eligibleItems.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < eligibleItems.length; rightIndex += 1) {
      const items = [eligibleItems[leftIndex], eligibleItems[rightIndex]];
      if (items[0].intent_id === items[1].intent_id) continue;
      const candidate = { items, combination_key: groupCombinationKey(items) };
      if (nearMissBasis(items) !== null) nearMissCandidates.push(candidate);
      else unrelatedCandidates.push(candidate);
    }
  }
  nearMissCandidates.sort((left, right) => left.combination_key.localeCompare(right.combination_key));
  unrelatedCandidates.sort((left, right) => left.combination_key.localeCompare(right.combination_key));
  const mixedCandidates = [...nearMissCandidates, ...unrelatedCandidates].slice(0, MAX_MIXED_GROUP_COUNT);

  const groups = [];
  for (const candidate of sameCandidates) {
    const items = candidate.items.map((item) => ({ ...item, id: itemIds.get(item.bundle_key) }));
    groups.push({
      group_id: "same-" + String(groups.length + 1).padStart(3, "0"),
      kind: "same_intent",
      combination_key: candidate.combination_key,
      items,
    });
  }
  for (const candidate of mixedCandidates) {
    const items = candidate.items.map((item) => ({ ...item, id: itemIds.get(item.bundle_key) }));
    const basis = nearMissBasis(items);
    groups.push({
      group_id: "mixed-" + String(groups.length - sameCandidates.length + 1).padStart(3, "0"),
      kind: "mixed_intent",
      combination_key: candidate.combination_key,
      near_miss: basis !== null,
      near_miss_basis: basis,
      items,
    });
  }

  const statistics = groupStatistics(groups);
  const eligibleBundleStatusCounts = { candidate: 0, confirmed: 0 };
  for (const item of eligibleItems) eligibleBundleStatusCounts[item.bundle_status] += 1;
  return {
    version: 2,
    source: {
      ledger_classes: ["a", "c"],
      excluded_ledger_classes: ["b", "d", "e", "x"],
      database_table: "owner_correction_bundles",
      database_statuses: ["candidate", "confirmed"],
      database_text_field: "rule_text",
      raw_utterances_used: false,
    },
    source_statistics: {
      ledger_ac_intent_count: ledgerAcIntentIds.size,
      eligible_intent_count: new Set(eligibleItems.map((item) => item.intent_id)).size,
      eligible_bundle_count: eligibleItems.length,
      eligible_bundle_status_counts: eligibleBundleStatusCounts,
      matched_bundle_count: bundleSources.size,
      empty_rule_text_bundle_count: emptyRuleTextBundleCount,
      ambiguous_intent_bundle_count: ambiguousIntentBundleCount,
      e_x_only_intent_count: [...ledgerExIntentIds].filter((intentId) => !ledgerAcIntentIds.has(intentId)).length,
    },
    statistics: {
      ...statistics,
      eligible_intent_count: new Set(eligibleItems.map((item) => item.intent_id)).size,
      eligible_bundle_count: eligibleItems.length,
      eligible_bundle_status_counts: eligibleBundleStatusCounts,
      empty_rule_text_bundle_count: emptyRuleTextBundleCount,
      ambiguous_intent_bundle_count: ambiguousIntentBundleCount,
    },
    groups,
  };
}

function auditGroupSources(groups, ledgerRows) {
  const eligibleIntentIds = new Set(ledgerRows
    .filter((row) => row.klass === "a" || row.klass === "c")
    .map((row) => row.intent_id));
  const eXOnlyIntentIds = new Set(ledgerRows
    .filter((row) => row.klass === "e" || row.klass === "x")
    .map((row) => row.intent_id)
    .filter((intentId) => !eligibleIntentIds.has(intentId)));
  const rowsByHashAndIntent = new Map();
  for (const row of ledgerRows) {
    const key = row.event_hash + "\t" + row.intent_id;
    if (!rowsByHashAndIntent.has(key)) rowsByHashAndIntent.set(key, []);
    rowsByHashAndIntent.get(key).push(row);
  }

  let invalidSourceItemCount = 0;
  let eXIntentItemCount = 0;
  for (const group of groups) {
    for (const item of group.items) {
      if (eXOnlyIntentIds.has(item.intent_id)) eXIntentItemCount += 1;
      const sourceHashes = Array.isArray(item.source_event_hashes) ? item.source_event_hashes : [];
      const sourceKlasses = Array.isArray(item.source_klasses) ? item.source_klasses : [];
      const hashesMatchLedger = sourceHashes.length > 0 && sourceHashes.every((hash) => {
        const rows = rowsByHashAndIntent.get(hash + "\t" + item.intent_id) ?? [];
        return rows.some((row) => row.klass === "a" || row.klass === "c");
      });
      const klassesAreEligible = sourceKlasses.length > 0
        && sourceKlasses.every((klass) => klass === "a" || klass === "c");
      if (!eligibleIntentIds.has(item.intent_id) || !hashesMatchLedger || !klassesAreEligible) {
        invalidSourceItemCount += 1;
      }
    }
  }

  return {
    invalid_source_item_count: invalidSourceItemCount,
    e_x_intent_item_count: eXIntentItemCount,
    same_intent_group_intent_type_counts: groups
      .filter((group) => group.kind === "same_intent")
      .map((group) => new Set(group.items.map((item) => item.intent_id)).size),
  };
}

function readOwnerCorrectionBundleRows(databasePath) {
  const query = "SELECT e.event_id AS event_id, e.session_id_hash AS session_hash, x.bundle_key AS bundle_key, b.rule_text AS rule_text, b.topic_key AS topic_key, b.condition_key AS condition_key, b.polarity AS polarity, b.status AS status FROM owner_correction_events e JOIN owner_correction_evidence x ON x.event_id = e.event_id JOIN owner_correction_bundles b ON b.bundle_key = x.bundle_key WHERE b.status IN ('candidate', 'confirmed')";
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    sqliteVec.load(database);
    return database.prepare(query).all();
  } finally {
    database.close();
  }
}

function writeGroups(groupsPath, document) {
  mkdirSync(dirname(groupsPath), { recursive: true });
  writeFileSync(groupsPath, JSON.stringify(document, null, 2) + "\n", "utf8");
}

async function createGroupDocumentFromFiles(ledgerPath, databasePath) {
  const ledger = await readRecurrenceLedger(ledgerPath);
  const ledgerRows = [...ledger.rows.values()];
  const document = generateAbstractionGroups(ledgerRows, readOwnerCorrectionBundleRows(databasePath));
  document.source.ledger_path = relative(REPO_ROOT, resolve(ledgerPath));
  document.source.database_path = relative(REPO_ROOT, resolve(databasePath));
  const sourceAudit = auditGroupSources(document.groups, ledgerRows);
  if (sourceAudit.invalid_source_item_count !== 0 || sourceAudit.e_x_intent_item_count !== 0) {
    throw new Error("generated groups do not match eligible ledger sources");
  }
  assertValidGroups(document.groups);
  return document;
}

function promptPayload(groups) {
  return groups.map((group) => ({
    group_id: group.group_id,
    items: group.items.map((item) => ({ id: item.id, rule_text: item.rule_text })),
  }));
}

function buildAbstractionPrompt(template, groups) {
  assertValidGroups(groups);
  if (countPromptTemplateLines(template) > MAX_TEMPLATE_LINES) {
    throw new Error("abstraction prompt exceeds 100 template lines");
  }
  const placeholderCount = template.split(GROUPS_PLACEHOLDER).length - 1;
  if (placeholderCount !== 1) throw new Error("prompt template must contain one groups placeholder");
  return template.replace(GROUPS_PLACEHOLDER, JSON.stringify(promptPayload(groups), null, 2));
}

function createCodexArgs({ cwd, outputPath }) {
  return [
    "exec",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "-C",
    cwd,
    "-o",
    outputPath,
    "-",
  ];
}

function validateAbstractionResult(group, result) {
  if (!isRecord(result) || result.verdict !== "merge") {
    return { passed: true, reason_code: null };
  }

  const principle = result.principle;
  if (typeof principle !== "string" || principle.trim() === "") {
    return { passed: false, reason_code: "missing_principle" };
  }
  if (Array.from(principle).length > MAX_PRINCIPLE_LENGTH) {
    return { passed: false, reason_code: "principle_too_long" };
  }

  const memberPolarities = new Set(group.items.map((item) => item.polarity));
  if (memberPolarities.size !== 1) {
    return { passed: false, reason_code: "mixed_member_polarity" };
  }
  const generatedPolarity = NEGATIVE_POLARITY_PATTERN.test(principle) ? "negative" : "positive";
  if (generatedPolarity !== group.items[0].polarity) {
    return { passed: false, reason_code: "polarity_mismatch" };
  }

  const sourceTexts = group.items.map((item) => item.rule_text.normalize("NFKC"));
  const contentTerms = principle.normalize("NFKC").match(/[\p{Script=Han}\p{Script=Katakana}\p{Script=Latin}\p{Number}]{2,}/gu) ?? [];
  const hasAddedContentTerm = contentTerms.some((term) => !sourceTexts.some((sourceText) => sourceText.includes(term)));
  if (hasAddedContentTerm) return { passed: false, reason_code: "added_content_word" };
  return { passed: true, reason_code: null };
}

function parseAbstractionOutput(output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    return { results: [], parse_error: "invalid_json" };
  }
  if (!Array.isArray(parsed)) return { results: [], parse_error: "top_level_not_array" };
  return { results: parsed, parse_error: null };
}

function validResultForGroup(group, result) {
  const expectedKeys = ["group_id", "verdict", "principle", "odd_ids"];
  if (!isRecord(result) || Object.keys(result).length !== expectedKeys.length
    || expectedKeys.some((key) => !Object.hasOwn(result, key))
    || result.group_id !== group.group_id
    || (result.verdict !== "merge" && result.verdict !== "none")
    || typeof result.principle !== "string" || !Array.isArray(result.odd_ids)
    || new Set(result.odd_ids).size !== result.odd_ids.length
    || result.odd_ids.some((id) => !Number.isInteger(id) || !group.items.some((item) => item.id === id))) {
    return false;
  }
  if (result.verdict === "merge") return result.principle.trim() !== "" && result.odd_ids.length === 0;
  return result.principle === "" && result.odd_ids.length > 0;
}

function rounded(value, decimals = 2) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function scoreAbstractionResults(groups, parsedOutput, runMetrics) {
  const groupCounts = assertValidGroups(groups);
  const expectedById = new Map(groups.map((group) => [group.group_id, group]));
  const resultsById = new Map();
  let malformedResultCount = 0;
  let unexpectedGroupCount = 0;

  for (const result of parsedOutput.results) {
    if (!isRecord(result) || typeof result.group_id !== "string" || !expectedById.has(result.group_id)) {
      unexpectedGroupCount += 1;
      continue;
    }
    if (!resultsById.has(result.group_id)) resultsById.set(result.group_id, []);
    resultsById.get(result.group_id).push(result);
  }

  const validResults = new Map();
  let missingGroupCount = 0;
  for (const group of groups) {
    const matches = resultsById.get(group.group_id) ?? [];
    if (matches.length !== 1 || !validResultForGroup(group, matches[0])) {
      missingGroupCount += 1;
      if (matches.length > 0) malformedResultCount += matches.length;
      continue;
    }
    validResults.set(group.group_id, matches[0]);
  }

  const sameGroups = groups.filter((group) => group.kind === "same_intent");
  const mixedGroups = groups.filter((group) => group.kind === "mixed_intent");
  const sameMergeCount = sameGroups.filter((group) => validResults.get(group.group_id)?.verdict === "merge").length;
  const mixedMergeCount = mixedGroups.filter((group) => validResults.get(group.group_id)?.verdict === "merge").length;
  const mixedNoneCount = mixedGroups.filter((group) => validResults.get(group.group_id)?.verdict === "none").length;
  let guardedMergeCount = 0;
  let rejectedMergeCount = 0;
  let mergeResultCount = 0;

  for (const group of groups) {
    const result = validResults.get(group.group_id);
    if (!result || result.verdict !== "merge") continue;
    mergeResultCount += 1;
    const guard = validateAbstractionResult(group, result);
    if (guard.passed) guardedMergeCount += 1;
    else rejectedMergeCount += 1;
  }

  const sameMergeRate = groupCounts.same_count > 0 ? (sameMergeCount / groupCounts.same_count) * 100 : null;
  const mixedNoneRate = groupCounts.mixed_count > 0 ? (mixedNoneCount / groupCounts.mixed_count) * 100 : null;
  const falseMergeRate = groupCounts.mixed_count > 0 ? (mixedMergeCount / groupCounts.mixed_count) * 100 : null;
  const quotaBefore = runMetrics.quota_before_used_percent;
  const quotaAfter = runMetrics.quota_after_used_percent;
  let quotaConsumed = null;
  if (Number.isFinite(quotaBefore) && Number.isFinite(quotaAfter)) {
    quotaConsumed = quotaAfter - quotaBefore;
  }

  const acceptance = {
    same_intent_merge_rate: sameMergeRate !== null && sameMergeRate >= 70,
    mixed_intent_false_merge_rate: falseMergeRate !== null && falseMergeRate <= 5,
    missing_groups: missingGroupCount === 0,
    quota_consumption: quotaConsumed !== null && quotaConsumed >= 0
      && quotaConsumed <= MAX_QUOTA_CONSUMPTION_POINTS,
    one_call: runMetrics.call_count === 1,
  };
  const pass = parsedOutput.parse_error === null
    && Object.values(acceptance).every(Boolean);
  return {
    status: pass ? "pass" : "fail",
    pass,
    ...(parsedOutput.parse_error ? { parse_error: parsedOutput.parse_error } : {}),
    acceptance,
    metrics: {
      group_count: groups.length,
      same_intent_group_count: groupCounts.same_count,
      mixed_intent_group_count: groupCounts.mixed_count,
      same_intent_merge_rate_pct: rounded(sameMergeRate),
      mixed_intent_none_rate_pct: rounded(mixedNoneRate),
      false_merge_rate_pct: rounded(falseMergeRate),
      difference_guard_pass_rate_pct: mergeResultCount > 0
        ? rounded((guardedMergeCount / mergeResultCount) * 100)
        : null,
      difference_guard_checked_merge_count: mergeResultCount,
      difference_guard_rejected_merge_count: rejectedMergeCount,
      missing_group_count: missingGroupCount,
      malformed_result_count: malformedResultCount,
      unexpected_group_count: unexpectedGroupCount,
      elapsed_seconds: rounded(runMetrics.elapsed_seconds, 3),
      call_count: runMetrics.call_count,
      quota_before_used_percent: Number.isFinite(quotaBefore) ? rounded(quotaBefore) : null,
      quota_after_used_percent: Number.isFinite(quotaAfter) ? rounded(quotaAfter) : null,
      quota_consumed_points: rounded(quotaConsumed),
    },
  };
}

function makeReplaySidecar(groups, parsedOutput, runMetrics) {
  const responsesByGroupId = new Map();
  for (const result of parsedOutput.results) {
    if (!isRecord(result) || typeof result.group_id !== "string") continue;
    if (!responsesByGroupId.has(result.group_id)) responsesByGroupId.set(result.group_id, []);
    responsesByGroupId.get(result.group_id).push(result);
  }

  const groupResults = groups.map((group) => {
    const responses = responsesByGroupId.get(group.group_id) ?? [];
    const modelResponse = responses.length === 1 ? responses[0] : responses.length === 0 ? null : responses;
    const validResult = responses.length === 1 && validResultForGroup(group, responses[0])
      ? responses[0]
      : null;
    const verdict = isRecord(modelResponse)
      && (modelResponse.verdict === "merge" || modelResponse.verdict === "none")
      ? modelResponse.verdict
      : null;
    return {
      group_id: group.group_id,
      kind: group.kind,
      model_response: modelResponse,
      verdict,
      principle: isRecord(modelResponse) && typeof modelResponse.principle === "string"
        ? modelResponse.principle
        : null,
      difference_guard: validResult?.verdict === "merge"
        ? validateAbstractionResult(group, validResult)
        : null,
    };
  });

  return {
    format_version: 1,
    parsed_output: {
      results: parsedOutput.results,
      parse_error: parsedOutput.parse_error,
    },
    run_metrics: {
      call_count: runMetrics.call_count,
      elapsed_seconds: runMetrics.elapsed_seconds,
      quota_before_used_percent: runMetrics.quota_before_used_percent,
      quota_after_used_percent: runMetrics.quota_after_used_percent,
    },
    groups: groupResults,
  };
}

function parseReplaySidecar(document) {
  const parsedOutput = document?.parsed_output;
  const runMetrics = document?.run_metrics;
  const optionalNumber = (value) => value === null || (typeof value === "number" && Number.isFinite(value));
  if (!isRecord(document) || document.format_version !== 1 || !Array.isArray(document.groups)
    || !isRecord(parsedOutput) || !Array.isArray(parsedOutput.results)
    || (parsedOutput.parse_error !== null && typeof parsedOutput.parse_error !== "string")
    || !isRecord(runMetrics) || !Number.isInteger(runMetrics.call_count)
    || !optionalNumber(runMetrics.elapsed_seconds)
    || !optionalNumber(runMetrics.quota_before_used_percent)
    || !optionalNumber(runMetrics.quota_after_used_percent)) {
    throw new Error("invalid replay output");
  }
  return { parsed_output: parsedOutput, run_metrics: runMetrics };
}

function writeScoredOutputs(outputPath, groups, parsedOutput, runMetrics) {
  const report = scoreAbstractionResults(groups, parsedOutput, runMetrics);
  writeReport(outputPath, report);
  writeReport(outputPath + ".groups.json", makeReplaySidecar(groups, parsedOutput, runMetrics));
  return report;
}

function readCodexQuotaSnapshot() {
  const quotaReaderPath = resolve(REPO_ROOT, ".claude/hooks/scripts/codex-quota.py");
  try {
    const output = execFileSync("python3", [quotaReaderPath, "--json"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    });
    const value = JSON.parse(output);
    if (value.status !== "ok" || value.stale || typeof value.reached !== "boolean"
      || !Number.isFinite(value.used_percent) || !Number.isFinite(value.remaining_percent)) {
      return { status: "unknown", used_percent: null, remaining_percent: null, reached: false };
    }
    return {
      status: "ok",
      used_percent: value.used_percent,
      remaining_percent: value.remaining_percent,
      reached: value.reached,
    };
  } catch {
    return { status: "unknown", used_percent: null, remaining_percent: null, reached: false };
  }
}

function writeReport(outputPath, report) {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");
}

function parseArguments(args) {
  const options = { dry_run: false, generate_groups: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--dry-run") {
      options.dry_run = true;
      continue;
    }
    if (argument === "--generate-groups") {
      options.generate_groups = true;
      continue;
    }
    if (argument === "--groups" || argument === "--out" || argument === "--ledger"
      || argument === "--database" || argument === "--replay-output") {
      const value = args[index + 1];
      if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
        throw new Error(argument + " requires a path");
      }
      if (argument === "--groups") options.groups_path = resolve(value);
      if (argument === "--out") options.output_path = resolve(value);
      if (argument === "--ledger") options.ledger_path = resolve(value);
      if (argument === "--database") options.database_path = resolve(value);
      if (argument === "--replay-output") options.replay_output_path = resolve(value);
      index += 1;
      continue;
    }
    throw new Error("unsupported argument: " + argument);
  }
  if (options.generate_groups) {
    if (options.dry_run || !options.groups_path || !options.ledger_path || !options.database_path
      || options.output_path || options.replay_output_path) {
      throw new Error("usage: node scripts/spikes/abstraction-check.mjs --generate-groups --ledger <path> --database <path> --groups <path>");
    }
    return options;
  }
  if (options.dry_run && options.replay_output_path) {
    throw new Error("--dry-run cannot be combined with --replay-output");
  }
  if (!options.groups_path || !options.output_path) {
    throw new Error("usage: node scripts/spikes/abstraction-check.mjs --groups <path> --out <path> [--dry-run] [--replay-output <file>]");
  }
  return options;
}

function readGroups(groupsPath) {
  const document = JSON.parse(readFileSync(groupsPath, "utf8"));
  const groups = Array.isArray(document) ? document : document.groups;
  assertValidGroups(groups);
  return groups;
}

function makeDryRunReport(groups, templateLines, promptLineCount) {
  const groupCounts = assertValidGroups(groups);
  return {
    status: "pending_live_run",
    dry_run: true,
    pass: null,
    call_count: 0,
    prompt_template_lines: templateLines,
    prompt_line_count: promptLineCount,
    group_count: groups.length,
    same_intent_group_count: groupCounts.same_count,
    mixed_intent_group_count: groupCounts.mixed_count,
    intent_count: groupCounts.intent_count,
    intent_group_counts: groupCounts.intent_group_counts,
    unique_bundle_count: groupCounts.unique_bundle_count,
    near_miss_mixed_group_count: groupCounts.near_miss_mixed_group_count,
    mixed_candidate_group_count: groupCounts.mixed_candidate_group_count,
  };
}

function makeSkippedReport(groups, reason, quotaBefore) {
  const groupCounts = assertValidGroups(groups);
  return {
    status: "skipped",
    pass: null,
    skipped_reason: reason,
    call_count: 0,
    group_count: groups.length,
    same_intent_group_count: groupCounts.same_count,
    mixed_intent_group_count: groupCounts.mixed_count,
    quota_before_used_percent: Number.isFinite(quotaBefore.used_percent) ? rounded(quotaBefore.used_percent) : null,
  };
}

function writeCodexFailureReport(outputPath, groups, elapsedSeconds, quotaBefore, quotaAfter, error) {
  const groupCounts = assertValidGroups(groups);
  const code = typeof error?.code === "string" ? error.code : "codex_exec_failed";
  const before = Number.isFinite(quotaBefore.used_percent) ? quotaBefore.used_percent : null;
  const after = Number.isFinite(quotaAfter.used_percent) ? quotaAfter.used_percent : null;
  writeReport(outputPath, {
    status: "failed",
    pass: false,
    error_code: code,
    call_count: 1,
    group_count: groups.length,
    same_intent_group_count: groupCounts.same_count,
    mixed_intent_group_count: groupCounts.mixed_count,
    elapsed_seconds: rounded(elapsedSeconds, 3),
    quota_before_used_percent: before === null ? null : rounded(before),
    quota_after_used_percent: after === null ? null : rounded(after),
    quota_consumed_points: before === null || after === null ? null : rounded(after - before),
  });
}

function runCodex(prompt, cwd, outputPath) {
  const codexBinary = process.env.WASURENAGUSA_CODEX_BIN || "codex";
  const args = createCodexArgs({ cwd, outputPath });
  execFileSync(codexBinary, args, {
    cwd: REPO_ROOT,
    input: prompt,
    encoding: "utf8",
    stdio: ["pipe", "ignore", "ignore"],
    timeout: CODEX_TIMEOUT_MS,
  });
}

async function main(args) {
  const options = parseArguments(args);
  if (options.generate_groups) {
    const document = await createGroupDocumentFromFiles(options.ledger_path, options.database_path);
    writeGroups(options.groups_path, document);
    process.stdout.write(JSON.stringify({
      ...document.statistics,
      source_statistics: document.source_statistics,
    }) + "\n");
    return;
  }
  const groups = readGroups(options.groups_path);
  if (options.replay_output_path) {
    const replayDocument = JSON.parse(readFileSync(options.replay_output_path, "utf8"));
    const replay = parseReplaySidecar(replayDocument);
    const report = writeScoredOutputs(
      options.output_path,
      groups,
      replay.parsed_output,
      replay.run_metrics,
    );
    process.stdout.write(JSON.stringify(report) + "\n");
    return;
  }

  const promptPath = resolve(REPO_ROOT, "prompts/principle-abstraction.md");
  const promptTemplate = readFileSync(promptPath, "utf8");
  const templateLines = countPromptTemplateLines(promptTemplate);
  if (templateLines > MAX_TEMPLATE_LINES) throw new Error("abstraction prompt exceeds 100 template lines");
  const prompt = buildAbstractionPrompt(promptTemplate, groups);

  if (options.dry_run) {
    const report = makeDryRunReport(groups, templateLines, countPromptLines(prompt));
    writeReport(options.output_path, report);
    process.stdout.write(JSON.stringify(report) + "\n");
    return;
  }

  const quotaBefore = readCodexQuotaSnapshot();
  if (quotaBefore.status !== "ok") {
    const report = makeSkippedReport(groups, "quota_unavailable", quotaBefore);
    writeReport(options.output_path, report);
    process.stdout.write(JSON.stringify(report) + "\n");
    return;
  }
  if (quotaBefore.reached || quotaBefore.remaining_percent < MIN_REMAINING_QUOTA_PERCENT) {
    const report = makeSkippedReport(groups, "quota_below_30_percent", quotaBefore);
    writeReport(options.output_path, report);
    process.stdout.write(JSON.stringify(report) + "\n");
    return;
  }

  const groupsDirectory = dirname(options.groups_path);
  const codexCwd = join(groupsDirectory, "codex-cwd");
  mkdirSync(codexCwd, { recursive: true });
  if (readdirSync(codexCwd).length > 0) throw new Error("codex working directory must be empty");
  const responsePath = join(groupsDirectory, "luna-response-" + randomUUID() + ".json");
  const startedAt = performance.now();

  try {
    runCodex(prompt, codexCwd, responsePath);
    const elapsedSeconds = (performance.now() - startedAt) / 1000;
    const output = readFileSync(responsePath, "utf8");
    const parsedOutput = parseAbstractionOutput(output);
    const quotaAfter = readCodexQuotaSnapshot();
    const runMetrics = {
      call_count: 1,
      elapsed_seconds: elapsedSeconds,
      quota_before_used_percent: quotaBefore.used_percent,
      quota_after_used_percent: quotaAfter.status === "ok" ? quotaAfter.used_percent : null,
    };
    const report = writeScoredOutputs(options.output_path, groups, parsedOutput, runMetrics);
    process.stdout.write(JSON.stringify(report) + "\n");
  } catch (error) {
    const elapsedSeconds = (performance.now() - startedAt) / 1000;
    const quotaAfter = readCodexQuotaSnapshot();
    writeCodexFailureReport(options.output_path, groups, elapsedSeconds, quotaBefore, quotaAfter, error);
    const code = typeof error?.code === "string" ? error.code : "codex_exec_failed";
    throw new Error("codex abstraction call failed (" + code + ")");
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write((error instanceof Error ? error.message : "abstraction check failed") + "\n");
    process.exitCode = 1;
  });
}

export {
  assertValidGroups,
  auditGroupSources,
  buildAbstractionPrompt,
  countPromptLines,
  countPromptTemplateLines,
  createGroupDocumentFromFiles,
  createCodexArgs,
  generateAbstractionGroups,
  makeDryRunReport,
  makeReplaySidecar,
  parseArguments,
  parseAbstractionOutput,
  parseReplaySidecar,
  scoreAbstractionResults,
  validateAbstractionResult,
  writeGroups,
};
