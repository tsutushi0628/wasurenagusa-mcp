import { describe, expect, it } from "vitest";
import {
  buildOccurrenceMetrics,
  cleanHumanText,
  contextAtTranscriptOffset,
  countHumanInputTypes,
  extractHumanUtterance,
  extractInjectedEntries,
  transcriptContextBucket,
} from "./analysis.mjs";

describe("transcript extraction", () => {
  it("counts main and queued human utterances for population comparisons", () => {
    expect(countHumanInputTypes([
      { queued: false },
      { queued: true },
      { queued: false },
    ])).toEqual({ main: 2, queued: 1, total: 3 });
    expect(countHumanInputTypes([])).toEqual({ main: 0, queued: 0, total: 0 });
  });

  it("removes injected blocks while preserving the human text", () => {
    expect(cleanHumanText("手順を直して <system-reminder>system text</system-reminder> <ide_selection>editor text</ide_selection>続けて"))
      .toBe("手順を直して 続けて");
  });

  it("accepts main human messages and human queued prompts only", () => {
    const main = extractHumanUtterance({
      type: "user",
      isSidechain: false,
      origin: { kind: "human" },
      message: { content: [{ type: "text", text: "もう一度確認して" }] },
    });
    const queued = extractHumanUtterance({
      type: "attachment",
      isSidechain: false,
      attachment: {
        type: "queued_command",
        commandMode: "prompt",
        origin: { kind: "human" },
        prompt: [{ type: "text", text: "質問に答えて止まって" }],
      },
    });
    const peer = extractHumanUtterance({
      type: "attachment",
      isSidechain: false,
      attachment: {
        type: "queued_command",
        commandMode: "prompt",
        origin: { kind: "peer" },
        prompt: "合成の連絡",
      },
    });

    expect(main).toMatchObject({ text: "もう一度確認して", queued: false });
    expect(queued).toMatchObject({ text: "質問に答えて止まって", queued: true });
    expect(peer).toBeNull();
  });

  it("reads only indexed titles from hook output", () => {
    const injection = [
      "## 記憶インデックス",
      "### 最小索引",
      "[dont] 質問後は止まる (memory-a)",
      "## メモリ活用ルール",
    ].join("\n");

    expect(extractInjectedEntries(injection)).toEqual([
      { category: "dont", title: "質問後は止まる", id: "memory-a" },
    ]);
  });

  it("measures context from a deterministic transcript byte offset", () => {
    expect(contextAtTranscriptOffset(204800)).toEqual({ contextByteOffset: 204800, contextKB: 200 });
    expect(contextAtTranscriptOffset(undefined)).toEqual({ contextByteOffset: null, contextKB: null });
    expect([
      transcriptContextBucket(199.99),
      transcriptContextBucket(200),
      transcriptContextBucket(500),
      transcriptContextBucket(1024),
      transcriptContextBucket(null),
    ]).toEqual(["<200KB", "200–500KB", "500KB–1MB", "1MB+", "未計測"]);
  });
});

describe("recurrence metrics", () => {
  it("uses visible, pre-existing memory and cumulative transcript bytes", () => {
    const sessions = [
      {
        sessionId: "session-one",
        startAt: "2026-09-22T00:00:00.000Z",
        humanInputs: [
          {
            order: 1,
            timestamp: "2026-09-22T00:01:00.000Z",
            transcriptByteOffset: 1024,
            text: "質問に答えて止まって",
            queued: false,
          },
        ],
        stopEvents: [],
        injectionEvents: [],
      },
      {
        sessionId: "session-two",
        startAt: "2026-09-22T00:02:00.000Z",
        humanInputs: [
          {
            order: 3,
            timestamp: "2026-09-22T00:05:00.000Z",
            transcriptByteOffset: 204800,
            text: "質問に答えて止まって",
            queued: true,
          },
        ],
        stopEvents: [],
        injectionEvents: [
          {
            order: 2,
            timestamp: "2026-09-22T00:04:00.000Z",
            entries: [{ category: "dont", title: "質問後の返答を待つ", id: "memory-a" }],
            text: "[dont] 質問後の返答を待つ (memory-a)",
          },
        ],
      },
    ];
    const memories = [
      {
        store: "central",
        timestamp: "2026-09-22T00:00:30.000Z",
        title: "質問後の返答を待つ",
        content: "質問にまず答え、返事を待ってから次の作業を進める。",
        tags: "[]",
        category: "dont",
        project: "unknown",
        scope: "general",
      },
    ];

    const metrics = buildOccurrenceMetrics(sessions, memories);
    const b8 = metrics.themes.find((theme) => theme.id === "B8");

    expect(b8?.occurrences).toHaveLength(2);
    expect(b8?.occurrences[1]).toMatchObject({
      recurrenceIndex: 2,
      previousSessionId: "session-one",
      sessionRepeatType: "cross-session",
      storedAtRecurrence: true,
      injectedAtRecurrence: true,
      leakStage: "S3",
      humanOrdinal: 1,
      contextByteOffset: 204800,
      contextKB: 200,
    });
    expect(b8?.occurrences[1]).not.toHaveProperty("remainingTokens");
  });

  it("counts other-project memory separately from records visible in firebase-kit", () => {
    const sessions = [
      {
        sessionId: "session-one",
        startAt: "2026-09-22T00:00:00.000Z",
        humanInputs: [
          { order: 1, timestamp: "2026-09-22T00:01:00.000Z", transcriptByteOffset: 512, text: "質問に答えて止まって" },
        ],
        stopEvents: [],
        injectionEvents: [],
      },
      {
        sessionId: "session-two",
        startAt: "2026-09-22T00:02:00.000Z",
        humanInputs: [
          { order: 3, timestamp: "2026-09-22T00:05:00.000Z", transcriptByteOffset: 1024, text: "質問に答えて止まって" },
        ],
        stopEvents: [],
        injectionEvents: [
          {
            order: 2,
            timestamp: "2026-09-22T00:04:00.000Z",
            entries: [{ category: "dont", title: "質問後の返答を待つ", id: "memory-b" }],
            text: "[dont] 質問後の返答を待つ (memory-b)",
          },
        ],
      },
    ];
    const memories = [
      {
        store: "central",
        timestamp: "2026-09-22T00:00:30.000Z",
        title: "質問後の返答を待つ",
        content: "質問に答えてから返事を待ち、別作業に進まない。",
        tags: "[]",
        category: "dont",
        project: "legaltech-lab",
        scope: "ai",
      },
    ];

    const metrics = buildOccurrenceMetrics(sessions, memories);
    const b8 = metrics.themes.find((theme) => theme.id === "B8");

    expect(b8?.occurrences[1]).toMatchObject({
      storedAtRecurrence: false,
      otherProjectOnlyAtRecurrence: true,
      injectedAtRecurrence: false,
      leakStage: "S1",
    });
  });
});
