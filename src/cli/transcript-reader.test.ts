import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  MAX_TRANSCRIPT_DELTA_BYTES,
  MAX_TRANSCRIPT_HUMAN_MESSAGES,
  getPreviousAssistantContext,
  readTranscript,
  readTranscriptDelta,
} from "./transcript-reader.js";

describe("readTranscript", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "transcript-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function makeLine(type: string, role: string, text: string): string {
    return JSON.stringify({
      type,
      message: { role, content: text },
    });
  }

  function makeHumanLine(text: string, uuid?: string): string {
    const entry: Record<string, unknown> = {
      type: "user",
      origin: { kind: "human" },
      message: { role: "user", content: text },
    };
    if (uuid) entry.uuid = uuid;
    return JSON.stringify(entry);
  }

  function makeToolUseLine(): string {
    return JSON.stringify({
      type: "tool_use",
      tool: "Read",
      input: { file_path: "/some/file.ts" },
    });
  }

  function makeToolResultLine(): string {
    return JSON.stringify({
      type: "tool_result",
      tool: "Read",
      output: "file content here...",
    });
  }

  it("ユーザーとアシスタントのメッセージを抽出できる", async () => {
    const lines = [
      makeLine("user", "user", "こんにちは"),
      makeLine("assistant", "assistant", "はい、何かお手伝いしますか？"),
    ];
    const path = join(tempDir, "test.jsonl");
    await writeFile(path, lines.join("\n"));

    const result = await readTranscript(path);
    expect(result.parsedMessages).toHaveLength(2);
    expect(result.parsedMessages[0].text).toBe("こんにちは");
    expect(result.parsedMessages[1].text).toBe("はい、何かお手伝いしますか？");
  });

  it("tool_useエントリは無視される", async () => {
    const lines = [
      makeLine("user", "user", "ファイル読んで"),
      makeToolUseLine(),
      makeToolResultLine(),
      makeLine("assistant", "assistant", "読みました"),
    ];
    const path = join(tempDir, "test.jsonl");
    await writeFile(path, lines.join("\n"));

    const result = await readTranscript(path);
    expect(result.parsedMessages).toHaveLength(2);
  });

  it("tool_useが大量にあってもユーザーメッセージを逃さない", async () => {
    // バグ再現: 10件のユーザーメッセージ + 660件のtool_use/tool_result
    // 合計672行。lines.slice(-50)だと最後の50行しか見ない
    // → 最後の方のユーザーメッセージしか拾えない
    const lines: string[] = [];

    // 最初のユーザーメッセージ（怒りの表現）
    lines.push(makeLine("user", "user", "質問には項番しろ！"));
    lines.push(makeLine("assistant", "assistant", "承知しました"));

    // 大量のtool_use/tool_resultが間に入る（100件）
    for (let i = 0; i < 100; i++) {
      lines.push(makeToolUseLine());
      lines.push(makeToolResultLine());
    }

    // 中盤のユーザーメッセージ
    lines.push(makeLine("user", "user", "もういいよ"));
    lines.push(makeLine("assistant", "assistant", "他にお手伝いできることはありますか？"));

    // さらに大量のtool_use（100件）
    for (let i = 0; i < 100; i++) {
      lines.push(makeToolUseLine());
      lines.push(makeToolResultLine());
    }

    // 最後のユーザーメッセージ
    lines.push(makeLine("user", "user", "おしまい"));

    const path = join(tempDir, "test.jsonl");
    await writeFile(path, lines.join("\n"));

    const result = await readTranscript(path);

    // 全5件のメッセージが拾えていること（怒りのメッセージ含む）
    expect(result.parsedMessages).toHaveLength(5);
    expect(result.parsedMessages[0].text).toBe("質問には項番しろ！");
    expect(result.parsedMessages[1].text).toBe("承知しました");
    expect(result.parsedMessages[2].text).toBe("もういいよ");
    expect(result.parsedMessages[4].text).toBe("おしまい");
  });

  it("50件以上のメッセージがある場合は直近50件を返す", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 60; i++) {
      lines.push(makeLine("user", "user", `メッセージ${i}`));
    }
    const path = join(tempDir, "test.jsonl");
    await writeFile(path, lines.join("\n"));

    const result = await readTranscript(path);
    expect(result.parsedMessages).toHaveLength(50);
    // 直近50件 = メッセージ10〜メッセージ59
    expect(result.parsedMessages[0].text).toBe("メッセージ10");
    expect(result.parsedMessages[49].text).toBe("メッセージ59");
  });

  it("contentが配列形式でもテキストを抽出できる", async () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "最初の部分" },
          { type: "image", data: "..." },
          { type: "text", text: "次の部分" },
        ],
      },
    });
    const path = join(tempDir, "test.jsonl");
    await writeFile(path, line);

    const result = await readTranscript(path);
    expect(result.parsedMessages).toHaveLength(1);
    expect(result.parsedMessages[0].text).toBe("最初の部分\n次の部分");
  });

  it("空のトランスクリプトは空結果を返す", async () => {
    const path = join(tempDir, "test.jsonl");
    await writeFile(path, "");

    const result = await readTranscript(path);
    expect(result.parsedMessages).toHaveLength(0);
    expect(result.conversationLog).toBe("");
  });

  it("不正なJSONL行は無視される", async () => {
    const lines = [
      "not valid json",
      makeLine("user", "user", "正常な行"),
      "{broken",
    ];
    const path = join(tempDir, "test.jsonl");
    await writeFile(path, lines.join("\n"));

    const result = await readTranscript(path);
    expect(result.parsedMessages).toHaveLength(1);
    expect(result.parsedMessages[0].text).toBe("正常な行");
  });

  it("長いテキストは500文字で切り詰められる（conversationLog）", async () => {
    const longText = "あ".repeat(600);
    const lines = [makeLine("user", "user", longText)];
    const path = join(tempDir, "test.jsonl");
    await writeFile(path, lines.join("\n"));

    const result = await readTranscript(path);
    // parsedMessagesは全文保持
    expect(result.parsedMessages[0].text).toBe(longText);
    // conversationLogは500文字に切り詰め
    expect(result.conversationLog).toContain("あ".repeat(500));
    expect(result.conversationLog).not.toContain("あ".repeat(501));
  });

  it("増分読取は完了行だけを返し、遅れて閉じたJSONL末尾を次回読む", async () => {
    const firstLine = makeHumanLine("先行発話", "event-one");
    const delayedLine = makeHumanLine("遅延発話", "event-two");
    const path = join(tempDir, "delayed.jsonl");
    await writeFile(path, `${firstLine}\n${delayedLine.slice(0, 24)}`);

    const first = await readTranscriptDelta(path);
    expect(first.records.map((record) => record.entry.uuid)).toEqual(["event-one"]);
    expect(first.humanMessagesRead).toBe(1);
    expect(first.incompleteTail).toBe(true);

    await writeFile(path, `${firstLine}\n${delayedLine}\n`);
    const second = await readTranscriptDelta(path, first.nextCursor);
    expect(second.records.map((record) => record.entry.uuid)).toEqual(["event-two"]);
    expect(second.nextCursor.offset).toBe(Buffer.byteLength(`${firstLine}\n${delayedLine}\n`));
  });

  it("200人間発話で止め、次回は201件目から再開する", async () => {
    const lines = Array.from({ length: MAX_TRANSCRIPT_HUMAN_MESSAGES + 1 }, (_, index) =>
      makeHumanLine(`合成発話${index}`, `event-${index}`),
    );
    const path = join(tempDir, "message-limit.jsonl");
    await writeFile(path, `${lines.join("\n")}\n`);

    const first = await readTranscriptDelta(path);
    expect(first.humanMessagesRead).toBe(MAX_TRANSCRIPT_HUMAN_MESSAGES);
    expect(first.records).toHaveLength(MAX_TRANSCRIPT_HUMAN_MESSAGES);
    expect(first.records.at(-1)?.entry.uuid).toBe("event-199");

    const second = await readTranscriptDelta(path, first.nextCursor);
    expect(second.humanMessagesRead).toBe(1);
    expect(second.records[0].entry.uuid).toBe("event-200");
  });

  it("1回の増分読取を2MiBで止め、cursorを完全行の後ろに置く", async () => {
    const emptyLine = `${JSON.stringify({ type: "tool_result", output: "" })}\n`;
    const payload = "a".repeat(MAX_TRANSCRIPT_DELTA_BYTES - Buffer.byteLength(emptyLine));
    const largeLine = `${JSON.stringify({ type: "tool_result", output: payload })}\n`;
    expect(Buffer.byteLength(largeLine)).toBe(MAX_TRANSCRIPT_DELTA_BYTES);
    const path = join(tempDir, "byte-limit.jsonl");
    await writeFile(path, `${largeLine}${makeHumanLine("上限後の発話", "after-limit")}\n`);

    const first = await readTranscriptDelta(path);
    expect(first.bytesRead).toBe(MAX_TRANSCRIPT_DELTA_BYTES);
    expect(first.nextCursor.offset).toBe(MAX_TRANSCRIPT_DELTA_BYTES);
    expect(first.humanMessagesRead).toBe(0);
    expect(first.hasMore).toBe(true);

    const next = await readTranscriptDelta(path, first.nextCursor);
    expect(next.records.some((record) => record.entry.uuid === "after-limit")).toBe(true);
  });

  it("壊れた完了行を飛ばし、不完全な末尾は再読する", async () => {
    const finalLine = makeHumanLine("回復した発話", "recovered");
    const path = join(tempDir, "corrupt-tail.jsonl");
    await writeFile(path, `${makeHumanLine("先行", "before")}\n{broken}\n${finalLine.slice(0, 20)}`);

    const first = await readTranscriptDelta(path);
    expect(first.records.map((record) => record.entry.uuid)).toEqual(["before"]);
    expect(first.incompleteTail).toBe(true);

    await writeFile(path, `${makeHumanLine("先行", "before")}\n{broken}\n${finalLine}\n`);
    const second = await readTranscriptDelta(path, first.nextCursor);
    expect(second.records.map((record) => record.entry.uuid)).toEqual(["recovered"]);
  });

  it("短縮されたJSONLは先頭から読み直す", async () => {
    const path = join(tempDir, "shortened.jsonl");
    const prior = `${makeHumanLine("以前の発話".repeat(20), "old")}\n`;
    await writeFile(path, prior);
    const before = await readTranscriptDelta(path);
    const replacement = `${makeHumanLine("短縮後".repeat(80), "new")}\n`;
    expect(Buffer.byteLength(replacement)).toBeGreaterThan(before.nextCursor.offset);
    await writeFile(path, replacement);

    const after = await readTranscriptDelta(path, before.nextCursor);
    expect(after.reset).toBe(true);
    expect(after.records.map((record) => record.entry.uuid)).toEqual(["new"]);
  });

  it("訂正の前行動に、次のassistant応答を混ぜない", async () => {
    const beforeHuman = makeHumanLine("先行依頼", "before-human");
    const beforeAssistant = JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: "先行依頼への回答" },
    });
    const correction = makeHumanLine("また同じ注意", "correction");
    const correctionResponse = JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: "訂正への返答" },
    });
    const lines = [beforeHuman, beforeAssistant, correction, correctionResponse];
    const path = join(tempDir, "assistant-window.jsonl");
    await writeFile(path, `${lines.join("\n")}\n`);
    const delta = await readTranscriptDelta(path);
    const correctionRecord = delta.records.find((record) => record.entry.uuid === "correction");

    expect(correctionRecord).toBeDefined();
    const context = getPreviousAssistantContext(delta.records, correctionRecord!.byteOffset);
    expect(context.map((record) => record.entry.message?.content)).toEqual(["先行依頼への回答"]);
    expect(context.some((record) => record.entry.message?.content === "訂正への返答")).toBe(false);
  });

  it("queued_commandも人間発話として上限計数する", async () => {
    const path = join(tempDir, "queued.jsonl");
    await writeFile(path, `${JSON.stringify({
      type: "attachment",
      origin: { kind: "human" },
      attachment: { type: "queued_command", commandMode: "prompt", prompt: "合成queued発話" },
    })}\n`);

    const result = await readTranscriptDelta(path);
    expect(result.humanMessagesRead).toBe(1);
    expect(result.records).toHaveLength(1);
  });

  it("空の人間発話は上限へ数え、origin不明のuser行は数えない", async () => {
    const path = join(tempDir, "human-origin.jsonl");
    await writeFile(path, `${makeHumanLine("")}\n${makeLine("user", "user", "origin不明")}\n`);

    const result = await readTranscriptDelta(path);
    expect(result.records).toHaveLength(2);
    expect(result.humanMessagesRead).toBe(1);
  });

  it("空ファイルの増分読取はcursorを進めず空結果を返す", async () => {
    const path = join(tempDir, "empty-delta.jsonl");
    await writeFile(path, "");

    const result = await readTranscriptDelta(path);
    expect(result.records).toEqual([]);
    expect(result.humanMessagesRead).toBe(0);
    expect(result.nextCursor.offset).toBe(0);
    expect(result.hasMore).toBe(false);
  });
});
