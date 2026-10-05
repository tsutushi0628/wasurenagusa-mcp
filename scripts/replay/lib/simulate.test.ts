import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "crypto";
import { writeFileSync } from "fs";
import { parseReplayArguments, REPLAY_USAGE } from "../simulate.mjs";
import { detectOwnerCorrections } from "../../../src/corrections/detector.js";
import { extractOwnerEvent } from "../../../src/corrections/events.js";
import { parseCorrectionRuleInput, serializeCorrectionRuleInput } from "../../../src/corrections/rule-template.js";
import {
  adjudicatePrevention,
  claimReplayEvaluation,
  createReplayOccurrenceRows,
  freezeReplayEvaluation,
  internal,
  loadAuditResults,
  readManifest,
  splitReplaySessions,
  summarizeRound0TuneComparison,
  summarizePrevention,
} from "./simulate-engine.mjs";

describe("再生側の訂正根拠形式", () => {
  it("D3aの型付き規則JSONをそのまま保存形式へ渡す", () => {
    const event = extractOwnerEvent({ hookEventName: "UserPromptSubmit", prompt: "質問に答えてください" });
    if (!event) throw new Error("synthetic correction was not extracted");
    const candidate = detectOwnerCorrections(event)[0];
    if (!candidate) throw new Error("synthetic correction was not detected");

    const conditions = internal.confidenceConditions(candidate, { serializeCorrectionRuleInput });

    expect(parseCorrectionRuleInput(conditions)).toEqual(candidate.ruleInput);
  });
});

const occurrence = {
  eventId: "repeat",
  bundleLabel: "B8",
  sessionId: "session-a",
  compactEpoch: 0,
  humanOrdinal: 2,
  at: "2026-09-25T01:00:00.000Z",
  actionStartAt: "2026-09-25T01:00:01.000Z",
};

const detected = {
  eventId: "first",
  bundleLabel: "B8",
  bundleKey: "rule-a",
  status: "candidate",
  at: "2026-09-24T01:00:00.000Z",
};

const saved = {
  eventId: "first",
  bundleLabel: "B8",
  bundleKey: "rule-a",
  version: 1,
  status: "confirmed",
  savedAt: "2026-09-24T01:01:00.000Z",
  expiresAt: "2026-10-01T00:00:00.000Z",
  evidenceEventIds: ["first"],
};

const emitted = {
  bundleLabel: "B8",
  bundleKey: "rule-a",
  version: 1,
  sessionId: "session-a",
  compactEpoch: 0,
  trigger: "prompt",
  humanOrdinal: 1,
  emittedAt: "2026-09-25T00:59:00.000Z",
  bodyText: "本文を出す前に確認する",
  ruleText: "本文を出す前に確認する",
  bodyIncluded: true,
  stdoutStatus: "emitted",
  expiresAt: "2026-10-01T00:00:00.000Z",
  evidenceEventIds: ["first"],
};

describe("再発前の規則到達判定", () => {
  it("再発直前の人間発話に対するAI行動開始を基準にする", () => {
    const sessionHash = "session-hash";
    const timeline = [
      {
        kind: "human",
        globalOrder: 1,
        input: { eventId: "first", sessionId: "session-a", sessionHash, labels: ["B8"], dateJst: "2026-09-24", availableAt: "2026-09-24T01:00:00.000Z" },
      },
      { kind: "assistant", sessionHash, globalOrder: 2, availableAt: "2026-09-24T01:00:01.000Z" },
      {
        kind: "human",
        globalOrder: 3,
        input: { eventId: "repeat", sessionId: "session-a", sessionHash, labels: ["B8"], dateJst: "2026-09-25", availableAt: "2026-09-25T01:00:00.000Z" },
      },
      { kind: "assistant", sessionHash, globalOrder: 4, availableAt: "2026-09-25T01:00:01.000Z" },
    ];

    expect(createReplayOccurrenceRows(timeline)).toMatchObject([
      { eventId: "repeat", actionStartAt: "2026-09-24T01:00:01.000Z", actionOrder: 2 },
    ]);
  });

  it("先行検出・確定保存・同じepochの本文出力が行動開始前なら防げたと数える", () => {
    expect(adjudicatePrevention({ occurrence, detections: [detected], saves: [saved], emissions: [emitted] }))
      .toMatchObject({ prevented: true, failedAt: null });
  });

  it("直前AI行動がない発話を到達成功にしない", () => {
    expect(adjudicatePrevention({
      occurrence: { ...occurrence, actionStartAt: null },
      detections: [detected],
      saves: [saved],
      emissions: [emitted],
    })).toMatchObject({ prevented: false, failedAt: "b", reason: "prior_ai_action_missing" });
  });

  it("未来の検出と未来の保存を根拠にしない", () => {
    const futureDetection = { ...detected, at: "2026-09-26T01:00:00.000Z" };
    expect(adjudicatePrevention({ occurrence, detections: [futureDetection], saves: [saved], emissions: [emitted] }))
      .toMatchObject({ prevented: false, failedAt: "a", reason: "no_prior_candidate" });
    expect(adjudicatePrevention({ occurrence, detections: [detected], saves: [{ ...saved, savedAt: "2026-09-25T01:00:02.000Z" }], emissions: [emitted] }))
      .toMatchObject({ prevented: false, failedAt: "b", reason: "saved_after_action_start" });
    expect(adjudicatePrevention({
      occurrence,
      detections: [{ ...detected, at: occurrence.at, sessionId: "session-b", order: 1 }],
      saves: [saved],
      emissions: [emitted],
    })).toMatchObject({ prevented: false, failedAt: "a", reason: "no_prior_candidate" });
  });

  it("同時刻は同一sessionの記録順だけで先行判定する", () => {
    const actionAt = "2026-09-25T01:00:01.000Z";
    const tiedEmission = { ...emitted, emittedAt: actionAt, order: 4 };
    expect(adjudicatePrevention({
      occurrence: { ...occurrence, actionStartAt: actionAt, actionOrder: 5 },
      detections: [detected],
      saves: [saved],
      emissions: [tiedEmission],
    })).toMatchObject({ prevented: true });
    expect(adjudicatePrevention({
      occurrence: { ...occurrence, actionStartAt: actionAt, actionOrder: 5 },
      detections: [detected],
      saves: [saved],
      emissions: [{ ...tiedEmission, order: 6 }],
    })).toMatchObject({ prevented: false, failedAt: "c", reason: "output_after_action" });
  });

  it("candidateのまま、または別eventを根拠にした保存は成功にしない", () => {
    expect(adjudicatePrevention({ occurrence, detections: [detected], saves: [{ ...saved, status: "candidate" }], emissions: [emitted] }))
      .toMatchObject({ prevented: false, failedAt: "b", reason: "not_confirmed" });
    expect(adjudicatePrevention({ occurrence, detections: [detected], saves: [{ ...saved, evidenceEventIds: ["other"] }], emissions: [emitted] }))
      .toMatchObject({ prevented: false, failedAt: "b", reason: "no_prior_confirmed_save" });
  });

  it("題名だけの出力、別session、compact epoch違いを成功にしない", () => {
    const titleOnly = { ...emitted, bodyText: "[規則] 確認する", ruleText: "本文を出す前に確認する" };
    expect(adjudicatePrevention({ occurrence, detections: [detected], saves: [saved], emissions: [titleOnly] }))
      .toMatchObject({ prevented: false, failedAt: "c", reason: "body_not_emitted" });
    expect(adjudicatePrevention({ occurrence, detections: [detected], saves: [saved], emissions: [{ ...emitted, sessionId: "session-b" }] }))
      .toMatchObject({ prevented: false, failedAt: "c", reason: "wrong_session" });
    expect(adjudicatePrevention({ occurrence, detections: [detected], saves: [saved], emissions: [{ ...emitted, compactEpoch: 1 }] }))
      .toMatchObject({ prevented: false, failedAt: "c", reason: "wrong_compact_epoch" });
  });

  it("注入時または直前行動開始時に期限切れなら成功にしない", () => {
    expect(adjudicatePrevention({ occurrence, detections: [detected], saves: [{ ...saved, expiresAt: "2026-09-24T02:00:00.000Z" }], emissions: [emitted] }))
      .toMatchObject({ prevented: false, failedAt: "c", reason: "expired_at_injection" });
    expect(adjudicatePrevention({ occurrence, detections: [detected], saves: [saved], emissions: [{ ...emitted, expiresAt: "2026-09-25T00:59:30.000Z" }] }))
      .toMatchObject({ prevented: false, failedAt: "c", reason: "expired_before_action" });
  });

  it("区間内2行動目の開始前に失効した規則を成功扱いしない", () => {
    const ruleSnapshot = {
      bundleKey: "rule-a",
      version: 1,
      status: "confirmed",
      expiresAt: "2026-09-25T01:00:15.000Z",
      evidenceEventIds: ["first"],
    };
    const timeline = [
      {
        kind: "human",
        globalOrder: 1,
        input: {
          eventId: "first",
          sessionId: "session-a",
          sessionHash: "session-hash",
          labels: ["B8"],
          dateJst: "2026-09-24",
          availableAt: "2026-09-25T01:00:00.000Z",
        },
      },
      { kind: "assistant", sessionHash: "session-hash", globalOrder: 2, availableAt: "2026-09-25T01:00:10.000Z" },
      { kind: "assistant", sessionHash: "session-hash", globalOrder: 3, availableAt: "2026-09-25T01:00:18.000Z" },
      {
        kind: "human",
        globalOrder: 4,
        input: {
          eventId: "repeat",
          sessionId: "session-a",
          sessionHash: "session-hash",
          labels: ["B8"],
          dateJst: "2026-09-25",
          availableAt: "2026-09-25T01:00:20.000Z",
        },
      },
    ];
    const replayOccurrence = createReplayOccurrenceRows(timeline)[0];
    const actionTimeline = replayOccurrence.actionRows.map((action) => ({ ...action, ruleSnapshots: [ruleSnapshot] }));

    expect(adjudicatePrevention({
      occurrence: { ...replayOccurrence, humanOrdinal: 2 },
      detections: [detected],
      saves: [saved],
      emissions: [{ ...emitted, emittedAt: "2026-09-25T01:00:09.000Z", expiresAt: ruleSnapshot.expiresAt }],
      actionRuleSnapshots: [ruleSnapshot],
      actionTimeline,
    })).toMatchObject({ prevented: false, failedAt: "c", reason: "expired_before_action" });
  });

  it("区間中の取消と版差替えを成功扱いしない", () => {
    const confirmedSnapshot = {
      bundleKey: "rule-a",
      version: 1,
      status: "confirmed",
      expiresAt: "2026-10-01T00:00:00.000Z",
      evidenceEventIds: ["first"],
    };
    const initialAction = { at: "2026-09-25T01:00:01.000Z", order: 5, compactEpoch: 0, ruleSnapshots: [confirmedSnapshot] };
    const changedActions = [
      initialAction,
      {
        at: "2026-09-25T01:00:02.000Z",
        order: 6,
        compactEpoch: 0,
        ruleSnapshots: [{ ...confirmedSnapshot, status: "rejected" }],
      },
    ];
    const replacedActions = [
      initialAction,
      {
        at: "2026-09-25T01:00:02.000Z",
        order: 6,
        compactEpoch: 0,
        ruleSnapshots: [{ ...confirmedSnapshot, version: 2, evidenceEventIds: ["second"] }],
      },
    ];

    for (const actionTimeline of [changedActions, replacedActions]) {
      expect(adjudicatePrevention({
        occurrence: {
          ...occurrence,
          at: "2026-09-25T01:00:03.000Z",
          actionStartAt: "2026-09-25T01:00:01.000Z",
          actionOrder: 5,
          order: 7,
          actionRows: actionTimeline,
        },
        detections: [detected],
        saves: [saved],
        emissions: [emitted],
        actionRuleSnapshots: [confirmedSnapshot],
        actionTimeline,
      })).toMatchObject({ prevented: false, failedAt: "c", reason: "stale_version" });
    }
  });

  it("区間内assistant行の状態が欠けた再発を成功扱いしない", () => {
    const ruleSnapshot = {
      bundleKey: "rule-a",
      version: 1,
      status: "confirmed",
      expiresAt: "2026-10-01T00:00:00.000Z",
      evidenceEventIds: ["first"],
    };

    expect(adjudicatePrevention({
      occurrence: {
        ...occurrence,
        order: 7,
        actionOrder: 5,
        actionRows: [{ at: occurrence.actionStartAt, order: 5, compactEpoch: 0 }],
      },
      detections: [detected],
      saves: [saved],
      emissions: [emitted],
      actionRuleSnapshots: [ruleSnapshot],
    })).toMatchObject({ prevented: false, failedAt: "c", reason: "action_state_unavailable" });
  });

  it("compact後の再配送が2行動目より前なら区間全体を成功扱いする", () => {
    const ruleSnapshot = {
      bundleKey: "rule-a",
      version: 1,
      status: "confirmed",
      expiresAt: "2026-10-01T00:00:00.000Z",
      evidenceEventIds: ["first"],
    };
    const actionTimeline = [
      { at: "2026-09-25T01:00:10.000Z", order: 10, compactEpoch: 0, ruleSnapshots: [ruleSnapshot] },
      { at: "2026-09-25T01:00:18.000Z", order: 12, compactEpoch: 1, ruleSnapshots: [ruleSnapshot] },
    ];

    expect(adjudicatePrevention({
      occurrence: {
        ...occurrence,
        at: "2026-09-25T01:00:20.000Z",
        actionStartAt: "2026-09-25T01:00:10.000Z",
        actionOrder: 10,
        order: 13,
        compactEpoch: 1,
        actionRows: actionTimeline,
      },
      detections: [detected],
      saves: [saved],
      emissions: [{ ...emitted, emittedAt: "2026-09-25T01:00:09.000Z", order: 9, compactEpoch: 0 }],
      actionRuleSnapshots: [ruleSnapshot],
      actionTimeline,
    })).toMatchObject({ prevented: false, failedAt: "c", reason: "wrong_compact_epoch" });

    expect(adjudicatePrevention({
      occurrence: {
        ...occurrence,
        at: "2026-09-25T01:00:20.000Z",
        actionStartAt: "2026-09-25T01:00:10.000Z",
        actionOrder: 10,
        order: 13,
        compactEpoch: 1,
        actionRows: actionTimeline,
      },
      detections: [detected],
      saves: [saved],
      emissions: [
        { ...emitted, emittedAt: "2026-09-25T01:00:09.000Z", order: 9, compactEpoch: 0 },
        { ...emitted, emittedAt: "2026-09-25T01:00:17.000Z", order: 11, compactEpoch: 1 },
      ],
      actionRuleSnapshots: [ruleSnapshot],
      actionTimeline,
    })).toMatchObject({ prevented: true, failedAt: null });
  });

  it("PreCompact出力だけでは区間の規則到達を成功にしない", () => {
    const ruleSnapshot = {
      bundleKey: "rule-a",
      version: 1,
      status: "confirmed",
      expiresAt: "2026-10-01T00:00:00.000Z",
      evidenceEventIds: ["first"],
    };
    const actionTimeline = [
      { at: "2026-09-25T01:00:10.000Z", order: 10, compactEpoch: 0, ruleSnapshots: [ruleSnapshot] },
    ];

    expect(adjudicatePrevention({
      occurrence: {
        ...occurrence,
        at: "2026-09-25T01:00:20.000Z",
        actionStartAt: "2026-09-25T01:00:10.000Z",
        actionOrder: 10,
        order: 13,
        humanOrdinal: 2,
        actionRows: actionTimeline,
      },
      detections: [detected],
      saves: [saved],
      emissions: [{ ...emitted, trigger: "compact", emittedAt: "2026-09-25T01:00:09.000Z", order: 9 }],
      actionRuleSnapshots: [ruleSnapshot],
      actionTimeline,
    })).toMatchObject({ prevented: false, failedAt: "c", reason: "not_emitted" });
  });

  it("他sessionの出力は発話時に版が無効なら別session到達と誤判定しない", () => {
    expect(adjudicatePrevention({
      occurrence,
      detections: [detected],
      saves: [saved],
      emissions: [{ ...emitted, sessionId: "session-b", expiresAt: "2026-09-25T00:58:00.000Z" }],
    })).toMatchObject({ prevented: false, failedAt: "c", reason: "expired_at_injection" });
  });

  it("再発理由へ開始時状態・枠・後続配送・観測・検索の副理由を保持する", () => {
    expect(adjudicatePrevention({
      occurrence,
      detections: [detected],
      saves: [saved],
      emissions: [{ ...emitted, sessionId: "session-b" }],
      deliveryDiagnostics: {
        secondaryReasons: [
          "version_valid_at_action",
          "confirmed_after_start",
          "start_slot_limit",
          "later_delivery_missing",
          "hook_observation_unknown",
          "related_search_miss",
        ],
      },
    })).toMatchObject({
      prevented: false,
      failedAt: "c",
      reason: "wrong_session",
      secondaryReasons: [
        "version_valid_at_action",
        "confirmed_after_start",
        "start_slot_limit",
        "later_delivery_missing",
        "hook_observation_unknown",
        "related_search_miss",
      ],
    });
  });

  it("manifestの日付範囲内にある再発を出現行へ含める", () => {
    const timeline = [
      {
        kind: "human",
        globalOrder: 1,
        input: { eventId: "first", sessionId: "session-a", sessionHash: "hash-a", labels: ["B8"], dateJst: "2026-10-03", availableAt: "2026-10-02T15:00:00.000Z" },
      },
      { kind: "assistant", sessionHash: "hash-a", globalOrder: 2, availableAt: "2026-10-02T15:00:01.000Z" },
      {
        kind: "human",
        globalOrder: 3,
        input: { eventId: "repeat", sessionId: "session-a", sessionHash: "hash-a", labels: ["B8"], dateJst: "2026-10-04", availableAt: "2026-10-03T15:00:00.000Z" },
      },
    ];

    expect(createReplayOccurrenceRows(timeline, { start: "2026-10-03", end: "2026-10-05" })).toMatchObject([
      { eventId: "repeat", bundleLabel: "B8" },
    ]);
  });

  it("B1はB2〜B10の合計から外す", () => {
    expect(summarizePrevention([
      { bundleLabel: "B1", result: { prevented: true } },
      { bundleLabel: "B2", result: { prevented: false } },
      { bundleLabel: "B8", result: { prevented: true } },
    ])).toMatchObject({
      main: { recurrenceCount: 2, preventedCount: 1 },
      b1: { recurrenceCount: 1, preventedCount: 1 },
    });
  });

  it("98sessionをseed固定で68:30に分け、session重複なしで再現する", () => {
    const sessions = Array.from({ length: 98 }, (_, index) => ({
      sessionHash: "session-" + String(index).padStart(3, "0"),
    }));

    const first = splitReplaySessions(sessions);
    const second = splitReplaySessions([...sessions].reverse());
    const tuneHashes = first.tune.map((session) => session.sessionHash);
    const evaluationHashes = first.evaluation.map((session) => session.sessionHash);

    expect(tuneHashes).toHaveLength(68);
    expect(evaluationHashes).toHaveLength(30);
    expect(new Set([...tuneHashes, ...evaluationHashes]).size).toBe(98);
    expect(tuneHashes).toEqual(second.tune.map((session) => session.sessionHash));
    expect(evaluationHashes).toEqual(second.evaluation.map((session) => session.sessionHash));
  });

  it("121sessionもmanifest件数に応じて84:37に分ける", () => {
    const sessions = Array.from({ length: 121 }, (_, index) => ({
      sessionHash: "session-" + String(index).padStart(3, "0"),
    }));
    const split = splitReplaySessions(sessions);

    expect(split.tune).toHaveLength(84);
    expect(split.evaluation).toHaveLength(37);
    expect(internal.isExpectedReplaySplit(sessions, split)).toBe(true);
    expect(internal.isExpectedReplaySplit(sessions, { tune: split.tune.slice(1), evaluation: split.evaluation })).toBe(false);
  });

  it("extractOwnerEventがnullを返す自動入力と対応するtimeline行を再生対象から除く", () => {
    const ownerInput = { lineOrder: 1, event: { prompt: "通常入力" } };
    const automatedInput = { lineOrder: 2, event: { prompt: "自動入力" } };
    const sessions = [{
      humanInputs: [ownerInput, automatedInput],
      timeline: [
        { kind: "human", lineOrder: 1, input: ownerInput },
        { kind: "human", lineOrder: 2, input: automatedInput },
        { kind: "stop", lineOrder: 3 },
      ],
    }];
    const filtered = internal.filterReplayOwnerInputs(sessions, {
      extractOwnerEvent(event) {
        if (event.prompt === "自動入力") return null;
        return { text: event.prompt };
      },
    });

    expect(filtered[0].humanInputs).toMatchObject([{ event: ownerInput.event, ownerEvent: { text: "通常入力" } }]);
    expect(filtered[0].timeline.filter((row) => row.kind === "human")).toHaveLength(1);
    expect(sessions[0].humanInputs).toHaveLength(2);
  });

  it("人口レポートはmanifestの日付範囲で発話数を数える", () => {
    const population = internal.reportPopulation({
      dateRangeJst: { start: "2026-10-03", end: "2026-10-05" },
      fileAudit: { fileCount: 3, included: 1, excluded: 2, noHuman: 1, outsidePeriod: 1 },
      sessions: [{
        humanInputs: [
          { dateJst: "2026-10-02" },
          { dateJst: "2026-10-03" },
          { dateJst: "2026-10-05" },
          { dateJst: "2026-10-06" },
        ],
      }],
    });

    expect(population).toMatchObject({ periodSessionCount: 1, periodHumanUtteranceCount: 2 });
  });

  it("評価入力をhash固定し、同じevaluationを二度開始しない", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "replay-freeze-"));
    const hashes = {
      manifestHash: "manifest-hash",
      sourceHash: "source-hash",
      compiledHash: "compiled-hash",
      splitHash: "split-hash",
      auditPromptHash: "audit-prompt-hash",
    };
    try {
      await freezeReplayEvaluation(scratch, hashes);
      await expect(claimReplayEvaluation(scratch, hashes)).resolves.toMatchObject({ claimed: true });
      await expect(claimReplayEvaluation(scratch, hashes)).rejects.toThrow(/already consumed/u);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("再生CLIはmanifest・compiled-root・scratch・splitを明示で受け取る", () => {
    expect(parseReplayArguments([
      "--mode", "cold",
      "--manifest", "fixture-manifest.json",
      "--compiled-root", "compiled",
      "--scratch", "scratch",
      "--split", "tune",
    ])).toMatchObject({
      mode: "cold",
      manifest: "fixture-manifest.json",
      compiledRoot: "compiled",
      scratchRoot: "scratch",
      split: "tune",
    });
    expect(() => parseReplayArguments(["--mode", "cold", "--compiled-root", "compiled"])).toThrow(/manifest|scratch|split/u);
    expect(() => parseReplayArguments(["--mode", "warm"])).toThrow(/unsupported|mode/u);
    expect(parseReplayArguments(["--help"])).toMatchObject({ help: true });
    expect(REPLAY_USAGE).toContain("--mode freeze");
    expect(REPLAY_USAGE).toContain("--split evaluation");
  });

  it("固定manifestはoffsetとprefix hashが一致する合成98対象だけ読む", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "replay-manifest-"));
    const sessionId = "synthetic-session-001";
    const transcript = Buffer.from(JSON.stringify({
      type: "user",
      origin: { kind: "human" },
      sessionId,
      timestamp: "2026-09-25T01:00:00.000Z",
      uuid: "synthetic-event-001",
      message: { content: "合成入力" },
    }) + "\n");
    const prefixSha256 = createHash("sha256").update(transcript).digest("hex");
    const sessionHash = createHash("sha256").update(sessionId).digest("hex");
    const manifestPath = join(scratch, "manifest.json");
    const manifest = {
      version: 1,
      fixtureKind: "synthetic",
      sessions: [{ sessionId, sessionHash, fileId: "fixture-file-001", path: "session.jsonl", readEndByteOffset: transcript.length, prefixSha256 }],
      files: [{ fileId: "fixture-file-001", readEndByteOffset: transcript.length, prefixSha256, disposition: "included", humanUtteranceCount: 1, inPeriodHumanUtteranceCount: 1 }],
      fileAudit: { fileCount: 1, included: 1, excluded: 0, noHuman: 0, outsidePeriod: 0 },
    };
    writeFileSync(join(scratch, "session.jsonl"), transcript);
    writeFileSync(manifestPath, JSON.stringify(manifest));

    try {
      const parsed = await readManifest(manifestPath);
      expect(parsed.sessions).toHaveLength(1);
      expect(parsed.sessions[0].snapshotMeta.size).toBe(transcript.length);
      expect(parsed.fixtureKind).toBe("synthetic");

      writeFileSync(join(scratch, "session.jsonl"), Buffer.concat([transcript, Buffer.from("{}\n")]));
      await expect(readManifest(manifestPath)).resolves.toMatchObject({ sessions: [{ snapshotMeta: { size: transcript.length } }] });

      writeFileSync(join(scratch, "session.jsonl"), Buffer.from("x".repeat(transcript.length - 1) + "\n"));
      await expect(readManifest(manifestPath)).rejects.toThrow(/hash mismatch/u);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("SolとOpusの監査結果を分割集計し、本文を集計結果へ漏らさない", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "replay-audit-"));
    const resultPath = join(scratch, "audit.json");
    const samples = [
      { id: "confirmed-a", group: "confirmed", human_utterance: "合成本文A" },
      { id: "confirmed-b", group: "confirmed", human_utterance: "合成本文B" },
      { id: "candidate-c", group: "candidate", human_utterance: "合成本文C" },
      { id: "negative-d", group: "negative", human_utterance: "合成本文D" },
    ];
    const payload = {
      "gpt-6.1-sol": {
        modelVersion: "GPT-6.1 Sol synthetic",
        results: [
          { id: "confirmed-a", is_correction: true, rule_ok: false, verdict: "invalid" },
          { id: "confirmed-b", is_correction: true, rule_ok: true, verdict: "valid" },
          { id: "candidate-c", is_correction: true, rule_ok: true, verdict: "valid" },
          { id: "negative-d", is_correction: false, rule_ok: true, verdict: "valid" },
        ],
      },
      "claude-opus": {
        modelVersion: "Claude Opus synthetic",
        results: [
          { id: "confirmed-a", is_correction: true, rule_ok: false, verdict: "invalid" },
          { id: "confirmed-b", is_correction: true, rule_ok: true, verdict: "valid" },
          { id: "candidate-c", is_correction: false, rule_ok: false, verdict: "invalid" },
          { id: "negative-d", is_correction: false, rule_ok: true, verdict: "valid" },
        ],
      },
    };
    writeFileSync(resultPath, JSON.stringify(payload));

    try {
      const result = await loadAuditResults(resultPath, samples);
      expect(result).toMatchObject({
        status: "監査結果読込済み",
        disagreementCount: 1,
        falseSaveUpperBound: 0.5,
        falseSaveUpperBoundNumerator: 1,
        falseSaveUpperBoundDenominator: 2,
      });
      expect(result.judges).toMatchObject([
        { label: "GPT-6.1 Sol", modelVersion: "GPT-6.1 Sol synthetic", byGroup: { confirmed: { falseSave: { errors: 1, total: 2 } } } },
        { label: "Claude Opus", modelVersion: "Claude Opus synthetic", byGroup: { candidate: { falseDetection: { errors: 1, total: 1 } } } },
      ]);
      expect(JSON.stringify(result)).not.toContain("合成本文");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("どちらかが判定不能なら監査未成立として誤保存上界へ数える", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "replay-audit-undetermined-"));
    const resultPath = join(scratch, "audit.json");
    const samples = [{ id: "confirmed-uncertain", group: "confirmed" }];
    const payload = {
      "gpt-6.1-sol": { modelVersion: "GPT-6.1 Sol synthetic", results: [{ id: samples[0].id, is_correction: null, rule_ok: null, verdict: "undetermined" }] },
      "claude-opus": { modelVersion: "Claude Opus synthetic", results: [{ id: samples[0].id, is_correction: true, rule_ok: true, verdict: "valid" }] },
    };
    writeFileSync(resultPath, JSON.stringify(payload));

    try {
      const result = await loadAuditResults(resultPath, samples);
      expect(result).toMatchObject({
        status: "audit_model_unavailable",
        unresolvedRows: 1,
        falseSaveUpperBound: 1,
        falseSaveUpperBoundNumerator: 1,
        falseSaveUpperBoundDenominator: 1,
      });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("ラウンド0比較値", () => {
  it("session別行がない集計をtune値に流用せず、全母集団値を保つ", () => {
    const perTheme = Object.fromEntries(["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8", "B9", "B10"].map((label) => [label, {
      preventedCount: label === "B5" ? 12 : 0,
      recurrenceCount: label === "B5" ? 17 : 2,
      rate: label === "B5" ? 12 / 17 : 0,
    }]));
    const report = {
      coverageRuns: ["observed", "contract"].map((coverage) => ({
        coverage,
        population: { sessionCount: 98 },
        prevention: {
          main: { preventedCount: 13, recurrenceCount: 106, rate: 13 / 106 },
          b1: { preventedCount: 0, recurrenceCount: 2, rate: 0 },
          perTheme,
        },
      })),
    };

    const comparison = summarizeRound0TuneComparison(report, 68);

    expect(comparison.tune).toMatchObject({
      sessionCount: 68,
      status: "unavailable_from_aggregate_only_report",
    });
    expect(comparison.all98[0]).toMatchObject({
      coverage: "observed",
      main: { preventedCount: 13, recurrenceCount: 106 },
      perTheme: { B5: { preventedCount: 12, recurrenceCount: 17 } },
    });
  });

  it("全sessionの基準値と照合した行だけをtune sessionへ集計する", () => {
    const labels = ["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8", "B9", "B10"];
    const perTheme = Object.fromEntries(labels.map((label) => [label, {
      preventedCount: label === "B5" ? 1 : 0,
      recurrenceCount: label === "B5" ? 2 : label === "B1" ? 1 : 0,
      rate: label === "B5" ? 0.5 : label === "B1" ? 0 : null,
    }]));
    const report = {
      coverageRuns: ["observed", "contract"].map((coverage) => ({
        coverage,
        population: { sessionCount: 98 },
        prevention: {
          main: { preventedCount: 1, recurrenceCount: 2, rate: 0.5 },
          b1: { preventedCount: 0, recurrenceCount: 1, rate: 0 },
          perTheme,
        },
      })),
    };
    const rows = ["observed", "contract"].flatMap((coverage) => [
      { coverage, sessionHash: "tune", bundleLabel: "B5", prevented: true },
      { coverage, sessionHash: "evaluation", bundleLabel: "B5", prevented: false },
      { coverage, sessionHash: "tune", bundleLabel: "B1", prevented: false },
    ]);

    const comparison = summarizeRound0TuneComparison(report, 1, rows, ["tune"]);

    expect(comparison.tune).toMatchObject({
      sessionCount: 1,
      status: "verified_from_round0_replay_store",
      perCoverage: {
        observed: {
          main: { preventedCount: 1, recurrenceCount: 1, rate: 1 },
          b1: { preventedCount: 0, recurrenceCount: 1, rate: 0 },
          perTheme: { B5: { preventedCount: 1, recurrenceCount: 1, rate: 1 } },
        },
      },
    });
  });
});
