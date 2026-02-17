import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { readTranscript } from "./transcript-reader.js";

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
});
