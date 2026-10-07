import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  auditGroupSources,
  buildAbstractionPrompt,
  countPromptLines,
  countPromptTemplateLines,
  createCodexArgs,
  generateAbstractionGroups,
  makeDryRunReport,
  makeReplaySidecar,
  parseArguments,
  parseAbstractionOutput,
  parseReplaySidecar,
  scoreAbstractionResults,
  validateAbstractionResult,
} from "./abstraction-check.mjs";

const promptTemplate = readFileSync(new URL("../../prompts/principle-abstraction.md", import.meta.url), "utf8");

function makeItem(id: number, ruleText: string, intentId: string, polarity = "positive", topicKey = "response_policy") {
  return {
    id,
    rule_text: ruleText,
    intent_id: intentId,
    polarity,
    topic_key: topicKey,
    condition_key: "condition-" + intentId,
    bundle_key: "bundle-" + intentId + "-" + id,
    bundle_status: "confirmed",
    source_klasses: ["a"],
    source_event_hashes: ["a".repeat(64)],
  };
}

function makeGroup(groupId: string, kind: "same_intent" | "mixed_intent", items: ReturnType<typeof makeItem>[]) {
  return { group_id: groupId, kind, items };
}

function makeGroups() {
  return [
    makeGroup("same-001", "same_intent", [
      makeItem(1, "質問には回答する", "answer-question"),
      makeItem(2, "質問へ回答する", "answer-question"),
    ]),
    makeGroup("same-002", "same_intent", [
      makeItem(3, "確認した質問に回答する", "answer-question"),
      makeItem(4, "質問へ先に回答する", "answer-question"),
    ]),
    makeGroup("mixed-001", "mixed_intent", [
      makeItem(1, "質問には回答する", "answer-question"),
      makeItem(5, "全文を表示する", "full-text", "positive", "document_delivery"),
    ]),
  ];
}

function makeResponse(groupId: string, verdict: "merge" | "none") {
  return {
    group_id: groupId,
    verdict,
    principle: verdict === "merge" ? "質問には回答する" : "",
    odd_ids: verdict === "none" ? [5] : [],
  };
}

function hashEventId(eventId: string) {
  return createHash("sha256").update(eventId).digest("hex");
}

describe("abstraction-check", () => {
  it("prompt template stays within 100 lines and hides source labels from the model", () => {
    expect(countPromptTemplateLines(promptTemplate)).toBeLessThanOrEqual(100);

    const groups = makeGroups();
    const prompt = buildAbstractionPrompt(promptTemplate, groups);

    expect(prompt).toContain('"group_id": "same-001"');
    expect(prompt).toContain('"rule_text": "質問には回答する"');
    expect(prompt).not.toContain("answer-question");
    expect(prompt).not.toContain("bundle-answer-question");
    expect(prompt).not.toContain("response_policy");
  });

  it("dry-run reports variable group counts and the assembled prompt line count", () => {
    const groups = makeGroups();
    const prompt = buildAbstractionPrompt(promptTemplate, groups);
    const promptLineCount = countPromptLines(prompt);
    const report = makeDryRunReport(groups, countPromptTemplateLines(promptTemplate), promptLineCount);

    expect(promptLineCount).toBeGreaterThan(countPromptTemplateLines(promptTemplate));
    expect(report.prompt_line_count).toBe(promptLineCount);
    expect(report.group_count).toBe(3);
    expect(report.same_intent_group_count).toBe(2);
    expect(report.mixed_intent_group_count).toBe(1);
    expect(report.unique_bundle_count).toBe(5);
    expect(report.call_count).toBe(0);
  });

  it("keeps only a/c ledger sources and builds groups from distinct bundles without duplicate combinations", () => {
    const sourceLedger = [
      { event_hash: hashEventId("a-1"), session_hash: hashEventId("session-a1"), klass: "a", intent_id: "answer-question" },
      { event_hash: hashEventId("a-2"), session_hash: hashEventId("session-a2"), klass: "a", intent_id: "answer-question" },
      { event_hash: hashEventId("c-1"), session_hash: hashEventId("session-c1"), klass: "c", intent_id: "answer-detail" },
      { event_hash: hashEventId("b-1"), session_hash: hashEventId("session-b1"), klass: "b", intent_id: "b-intent" },
      { event_hash: hashEventId("d-1"), session_hash: hashEventId("session-d1"), klass: "d", intent_id: "d-intent" },
      { event_hash: hashEventId("e-1"), session_hash: hashEventId("session-e1"), klass: "e", intent_id: "route-review" },
      { event_hash: hashEventId("x-1"), session_hash: hashEventId("session-x1"), klass: "x", intent_id: "x-question" },
    ];
    const bundleRows = [
      { event_id: "a-1", session_hash: hashEventId("session-a1"), bundle_key: "bundle-a1", rule_text: "質問へ回答する", topic_key: "response_policy", polarity: "positive", condition_key: "question", status: "candidate" },
      { event_id: "a-2", session_hash: hashEventId("session-a2"), bundle_key: "bundle-a2", rule_text: "質問には回答する", topic_key: "response_policy", polarity: "positive", condition_key: "question", status: "confirmed" },
      { event_id: "c-1", session_hash: hashEventId("session-c1"), bundle_key: "bundle-c1", rule_text: "回答に根拠を添える", topic_key: "response_policy", polarity: "negative", condition_key: "question", status: "candidate" },
      { event_id: "b-1", session_hash: hashEventId("session-b1"), bundle_key: "bundle-b1", rule_text: "除外するb規則", topic_key: "response_policy", polarity: "positive", condition_key: "question", status: "candidate" },
      { event_id: "d-1", session_hash: hashEventId("session-d1"), bundle_key: "bundle-d1", rule_text: "除外するd規則", topic_key: "response_policy", polarity: "positive", condition_key: "question", status: "candidate" },
      { event_id: "e-1", session_hash: hashEventId("session-e1"), bundle_key: "bundle-e1", rule_text: "レビュー担当へ依頼する", topic_key: "routing", polarity: "positive", condition_key: "review", status: "candidate" },
      { event_id: "x-1", session_hash: hashEventId("session-x1"), bundle_key: "bundle-x1", rule_text: "質問へ回答する", topic_key: "response_policy", polarity: "positive", condition_key: "question", status: "candidate" },
    ];
    const document = generateAbstractionGroups(sourceLedger, bundleRows);
    const items = document.groups.flatMap((group: any) => group.items);
    const selectedBundles = new Set(items.map((item: any) => item.bundle_key));
    const audit = auditGroupSources(document.groups, sourceLedger);
    const intentTypeCounts = document.groups
      .filter((group: any) => group.kind === "same_intent")
      .map((group: any) => new Set(group.items.map((item: any) => item.intent_id)).size);

    expect(document.statistics.eligible_intent_count).toBe(2);
    expect(document.statistics.near_miss_mixed_group_count).toBe(2);
    expect(document.statistics.mixed_candidate_group_count).toBe(2);
    expect(items.every((item: any) => item.source_klasses.every((klass: string) => klass === "a" || klass === "c"))).toBe(true);
    expect(document.source.excluded_ledger_classes).toEqual(["b", "d", "e", "x"]);
    expect(selectedBundles.has("bundle-b1")).toBe(false);
    expect(selectedBundles.has("bundle-d1")).toBe(false);
    expect(selectedBundles.has("bundle-e1")).toBe(false);
    expect(selectedBundles.has("bundle-x1")).toBe(false);
    expect(new Set(document.groups.map((group: any) => group.combination_key)).size).toBe(document.groups.length);
    expect(audit.invalid_source_item_count).toBe(0);
    expect(audit.e_x_intent_item_count).toBe(0);
    expect(audit.same_intent_group_intent_type_counts.every((count: number) => count === 1)).toBe(true);
  });

  it("accepts input-grounded wording and rejects added content words, polarity changes, and overlong principles", () => {
    const group = makeGroups()[0];

    expect(validateAbstractionResult(group, makeResponse("same-001", "merge"))).toEqual({
      passed: true,
      reason_code: null,
    });
    expect(validateAbstractionResult(group, {
      ...makeResponse("same-001", "merge"),
      principle: "質問には丁寧に回答する",
    })).toEqual({ passed: false, reason_code: "added_content_word" });
    expect(validateAbstractionResult(group, {
      ...makeResponse("same-001", "merge"),
      principle: "質問には回答しない",
    })).toEqual({ passed: false, reason_code: "polarity_mismatch" });
    expect(validateAbstractionResult(group, {
      ...makeResponse("same-001", "merge"),
      principle: "あ".repeat(121),
    })).toEqual({ passed: false, reason_code: "principle_too_long" });
  });

  it("parses JSON arrays and marks invalid JSON without inventing results", () => {
    const parsed = parseAbstractionOutput(JSON.stringify([makeResponse("same-001", "merge")]));
    expect(parsed.parse_error).toBeNull();
    expect(parsed.results).toHaveLength(1);

    expect(parseAbstractionOutput("not json")).toEqual({
      results: [],
      parse_error: "invalid_json",
    });
  });

  it("scores a variable number of groups and applies the five acceptance gates", () => {
    const groups = makeGroups();
    const report = scoreAbstractionResults(groups, {
      results: [
        makeResponse("same-001", "merge"),
        makeResponse("same-002", "merge"),
        makeResponse("mixed-001", "none"),
      ],
      parse_error: null,
    }, {
      call_count: 1,
      elapsed_seconds: 12.4,
      quota_before_used_percent: 50,
      quota_after_used_percent: 52.4,
    });

    expect(report.status).toBe("pass");
    expect(report.metrics.group_count).toBe(3);
    expect(report.metrics.same_intent_merge_rate_pct).toBe(100);
    expect(report.metrics.mixed_intent_none_rate_pct).toBe(100);
    expect(report.metrics.false_merge_rate_pct).toBe(0);
    expect(report.metrics.difference_guard_pass_rate_pct).toBe(100);
    expect(report.metrics.missing_group_count).toBe(0);
    expect(report.metrics.quota_consumed_points).toBeCloseTo(2.4, 2);
    expect(report.pass).toBe(true);
  });

  it("counts omitted groups as missing and fails closed", () => {
    const report = scoreAbstractionResults(makeGroups(), {
      results: [makeResponse("same-001", "merge")],
      parse_error: null,
    }, {
      call_count: 1,
      elapsed_seconds: 1,
      quota_before_used_percent: 40,
      quota_after_used_percent: 41,
    });

    expect(report.metrics.missing_group_count).toBe(2);
    expect(report.pass).toBe(false);
  });

  it("counts results with an invalid JSON shape as missing", () => {
    const invalid = {
      ...makeResponse("same-001", "merge"),
      confidence: 0.9,
    };
    const report = scoreAbstractionResults(makeGroups(), {
      results: [invalid],
      parse_error: null,
    }, {
      call_count: 1,
      elapsed_seconds: 1,
      quota_before_used_percent: 40,
      quota_after_used_percent: 41,
    });

    expect(report.metrics.missing_group_count).toBe(3);
    expect(report.metrics.malformed_result_count).toBe(1);
    expect(report.pass).toBe(false);
  });

  it("stores per-group results and replays saved responses with the original run metrics", () => {
    const groups = makeGroups();
    const parsedOutput = {
      results: [
        makeResponse("same-001", "merge"),
        makeResponse("same-002", "merge"),
        makeResponse("mixed-001", "none"),
        { group_id: "unexpected", verdict: "none" },
      ],
      parse_error: null,
    };
    const runMetrics = {
      call_count: 1,
      elapsed_seconds: 12.4,
      quota_before_used_percent: 50,
      quota_after_used_percent: 52.4,
    };
    const sidecar = makeReplaySidecar(groups, parsedOutput, runMetrics);
    const replay = parseReplaySidecar(JSON.parse(JSON.stringify(sidecar)));
    const originalReport = scoreAbstractionResults(groups, parsedOutput, runMetrics);
    const replayReport = scoreAbstractionResults(groups, replay.parsed_output, replay.run_metrics);

    expect(sidecar.groups).toEqual([
      {
        group_id: "same-001",
        kind: "same_intent",
        model_response: makeResponse("same-001", "merge"),
        verdict: "merge",
        principle: "質問には回答する",
        difference_guard: { passed: true, reason_code: null },
      },
      {
        group_id: "same-002",
        kind: "same_intent",
        model_response: makeResponse("same-002", "merge"),
        verdict: "merge",
        principle: "質問には回答する",
        difference_guard: { passed: true, reason_code: null },
      },
      {
        group_id: "mixed-001",
        kind: "mixed_intent",
        model_response: makeResponse("mixed-001", "none"),
        verdict: "none",
        principle: "",
        difference_guard: null,
      },
    ]);
    expect(replay.parsed_output).toEqual(parsedOutput);
    expect(replay.run_metrics).toEqual(runMetrics);
    expect(replayReport).toEqual(originalReport);
  });

  it("accepts replay-output alongside the group and report paths", () => {
    const options = parseArguments([
      "--groups", "groups.json",
      "--out", "report.json",
      "--replay-output", "previous.groups.json",
    ]);

    expect(options.replay_output_path).toBe(resolve("previous.groups.json"));
  });

  it("builds one read-only codex exec call without ephemeral mode or model overrides", () => {
    expect(createCodexArgs({ cwd: "/tmp/empty", outputPath: "/tmp/response.json" })).toEqual([
      "exec",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "-C",
      "/tmp/empty",
      "-o",
      "/tmp/response.json",
      "-",
    ]);
  });
});
