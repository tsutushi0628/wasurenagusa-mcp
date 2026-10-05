import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { measureRepeatClasses, parseRepeatClassesArguments } from "../repeat-classes.mjs";

type SyntheticUtterance = {
  sessionId: string;
  timestamp: string;
  text: string;
};

function createSyntheticInput(utterances: SyntheticUtterance[]) {
  const baseDirectory = join(process.cwd(), ".tmp", "codex-T3b");
  mkdirSync(baseDirectory, { recursive: true });
  const scratch = mkdtempSync(join(baseDirectory, "test-"));
  const transcriptsDirectory = join(scratch, "transcripts");
  const compiledRoot = join(scratch, "build");
  mkdirSync(transcriptsDirectory, { recursive: true });
  mkdirSync(join(compiledRoot, "corrections"), { recursive: true });
  const extractorSource = [
    "export function extractOwnerEvent(value) {",
    "  if (value?.type !== 'user' || value?.origin?.kind !== 'human') return null;",
    "  const text = value.message?.content;",
    "  if (typeof text !== 'string' || text.trim() === '') return null;",
    "  const normalized = text.normalize('NFKC').trim();",
    "  const firstLine = normalized.split('\\n', 1)[0].trim();",
    "  return {",
    "    sourceType: 'user',",
    "    text: normalized,",
    "    sessionId: value.sessionId,",
    "    timestamp: value.timestamp,",
    "    isHandoffPaste: /(?:復帰ブロック|引継ぎ命令テキスト)/u.test(normalized),",
    "    isSlashCommand: /^\\/[a-z][a-z0-9-]*(?:\\s|$)/iu.test(firstLine),",
    "  };",
    "}",
  ].join("\n");
  writeFileSync(join(compiledRoot, "corrections", "events.js"), extractorSource);
  utterances.forEach((utterance) => {
    const row = {
      type: "user",
      origin: { kind: "human" },
      sessionId: utterance.sessionId,
      timestamp: utterance.timestamp,
      message: { content: utterance.text },
    };
    writeFileSync(join(transcriptsDirectory, `${utterance.sessionId}.jsonl`), `${JSON.stringify(row)}\n`);
  });
  return { scratch, transcriptsDirectory, compiledRoot };
}

describe("repeat classes measurement", () => {
  it("NFKC後に13クラスを各1件へ分類し、生文を出力しない", async () => {
    const texts = [
      "全文を出して",
      "質問に答えて",
      "変な言葉を使うな",
      "字数制限やめて",
      "Codexに作業だけさせる",
      "勝手に切り替えるな",
      "Ｃｏｄｅｘを活用",
      "なんで敬語?",
      "一時置き場",
      "自分で確認しろ",
      "Codexは引き継ぐな",
      "まだ投稿しないで",
      "話が長い",
    ];
    const input = createSyntheticInput(texts.map((text, index) => ({
      sessionId: `synthetic-session-${index}`,
      timestamp: "2026-10-05T01:00:00.000Z",
      text,
    })));

    try {
      const report = await measureRepeatClasses(input);

      expect(report.total).toBe(13);
      expect(report.utterances).toBe(13);
      expect(Object.values(report.classes).map((item) => item.count)).toEqual(Array(13).fill(1));
      expect(report.matches).toHaveLength(13);
      expect(report.matches.every((item) => item.textPrefix === "")).toBe(true);
      expect(JSON.stringify(report)).not.toContain("全文を出して");
    } finally {
      rmSync(input.scratch, { recursive: true, force: true });
    }
  });

  it("貼付・コマンドを除外し、同一分・同文の複数sessionを1同報群に数える", async () => {
    const input = createSyntheticInput([
      { sessionId: "session-a", timestamp: "2026-10-05T01:00:10.000Z", text: "全文を出してってなに" },
      { sessionId: "session-b", timestamp: "2026-10-05T01:00:50.000Z", text: "全文を出してってなに" },
      { sessionId: "session-c", timestamp: "2026-10-05T01:00:55.000Z", text: "復帰ブロック: 全文を出して" },
      { sessionId: "session-d", timestamp: "2026-10-05T01:00:55.000Z", text: "<pasted_content>全文を出して" },
      { sessionId: "session-e", timestamp: "2026-10-05T01:00:55.000Z", text: "<command-message>全文を出して" },
      { sessionId: "session-f", timestamp: "2026-10-05T01:00:55.000Z", text: "/resume 全文を出して" },
    ]);

    try {
      const report = await measureRepeatClasses(input);

      expect(report.utterances).toBe(2);
      expect(report.total).toBe(2);
      expect(report.classes.R1.count).toBe(2);
      expect(report.classes.R3.count).toBe(0);
      expect(report.broadcastGroups).toBe(1);
      expect(report.matches.every((item) => item.classId === "R1")).toBe(true);
    } finally {
      rmSync(input.scratch, { recursive: true, force: true });
    }
  });

  it("クラス外の同一分・同文も別sessionなら同報群に数える", async () => {
    const input = createSyntheticInput([
      { sessionId: "unclassified-a", timestamp: "2026-10-05T01:00:10.000Z", text: "合成の未分類メッセージ" },
      { sessionId: "unclassified-b", timestamp: "2026-10-05T01:00:45.000Z", text: "合成の未分類メッセージ" },
    ]);

    try {
      const report = await measureRepeatClasses(input);

      expect(report.utterances).toBe(2);
      expect(report.total).toBe(0);
      expect(report.broadcastGroups).toBe(1);
    } finally {
      rmSync(input.scratch, { recursive: true, force: true });
    }
  });

  it("R7は発話の先頭にある場合だけ一致する", async () => {
    const input = createSyntheticInput([
      { sessionId: "prefixed", timestamp: "2026-10-05T01:00:00.000Z", text: "補足: Codexを活用" },
    ]);

    try {
      const report = await measureRepeatClasses(input);

      expect(report.classes.R7.count).toBe(0);
      expect(report.total).toBe(0);
    } finally {
      rmSync(input.scratch, { recursive: true, force: true });
    }
  });

  it("--sinceと--untilを日本時間の日付で両端含めて適用する", async () => {
    const input = createSyntheticInput([
      { sessionId: "before", timestamp: "2026-10-04T14:59:00.000Z", text: "全文を出して" },
      { sessionId: "start", timestamp: "2026-10-04T15:00:00.000Z", text: "全文を出して" },
      { sessionId: "end", timestamp: "2026-10-05T14:59:00.000Z", text: "全文を出して" },
      { sessionId: "after", timestamp: "2026-10-05T15:00:00.000Z", text: "全文を出して" },
    ]);

    try {
      const report = await measureRepeatClasses({
        ...input,
        since: "2026-10-05",
        until: "2026-10-05",
      });

      expect(report.total).toBe(2);
      expect(report.utterances).toBe(2);
      expect(report.activeDays).toBe(1);
      expect(report.dailyTotals).toEqual([{ date: "2026-10-05", total: 2 }]);
    } finally {
      rmSync(input.scratch, { recursive: true, force: true });
    }
  });

  it("必要な入出力と任意の日付範囲を引数として受け取る", () => {
    expect(parseRepeatClassesArguments([
      "--transcripts", "transcripts",
      "--compiled-root", "build",
      "--out", "report.json",
      "--since", "2026-09-22",
      "--until", "2026-10-05",
    ])).toEqual({
      transcriptsDirectory: "transcripts",
      compiledRoot: "build",
      outputPath: "report.json",
      since: "2026-09-22",
      until: "2026-10-05",
    });
    expect(parseRepeatClassesArguments([
      "--transcripts", "transcripts",
      "--compiled-root", "build",
      "--out", "report.json",
      "--project", "firebase-kit",
    ])).toMatchObject({ project: "firebase-kit" });
    expect(() => parseRepeatClassesArguments([
      "--transcripts", "transcripts",
      "--compiled-root", "build",
      "--out", "report.json",
      "--project", "../outside",
    ])).toThrow(/single project name/u);
  });

  it("実プロジェクト別のクラス内訳を加え、--projectで対象sessionを絞る", async () => {
    const input = createSyntheticInput([
      { sessionId: "session-a", timestamp: "2026-10-05T01:00:00.000Z", text: "全文を出して" },
      { sessionId: "session-b", timestamp: "2026-10-05T01:00:00.000Z", text: "全文を出して" },
      { sessionId: "session-c", timestamp: "2026-10-05T01:00:00.000Z", text: "質問に答えて" },
    ]);
    writeFileSync(join(input.scratch, "sessions-index.json"), JSON.stringify({
      version: 1,
      sessions: [
        { sessionId: "session-a", launchDir: "transcripts", project: "project-a", basis: "written_files", projects: { "project-a": 1 } },
        { sessionId: "session-b", launchDir: "transcripts", project: "project-b", basis: "written_files", projects: { "project-b": 1 } },
        { sessionId: "session-c", launchDir: "transcripts", project: "project-a", basis: "written_files", projects: { "project-a": 1 } },
      ],
    }));

    try {
      const report = await measureRepeatClasses(input);
      expect(report.total).toBe(3);
      expect(report.classes.R1.count).toBe(2);
      expect(report.projectBreakdown["project-a"]).toMatchObject({ R1: 1, R2: 1 });
      expect(report.projectBreakdown["project-b"]).toMatchObject({ R1: 1, R2: 0 });
      expect(JSON.stringify(report)).not.toContain("全文を出して");

      const filtered = await measureRepeatClasses({ ...input, project: "project-a" });
      expect(filtered.total).toBe(2);
      expect(filtered.utterances).toBe(2);
      expect(filtered.projectBreakdown).toHaveProperty("project-a");
      expect(filtered.projectBreakdown).not.toHaveProperty("project-b");
    } finally {
      rmSync(input.scratch, { recursive: true, force: true });
    }
  });
});
