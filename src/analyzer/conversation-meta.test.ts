import { describe, it, expect } from "vitest";
import { computeConversationMeta, ParsedMessage } from "./conversation-meta.js";

describe("computeConversationMeta()", () => {
  it("ユーザーメッセージの平均文字数と現在の文字数を計算する", () => {
    const messages: ParsedMessage[] = [
      { role: "user", text: "こんにちは" },          // 5文字
      { role: "assistant", text: "はい、何でしょう？" },
      { role: "user", text: "APIのURLを教えて" },    // 10文字
      { role: "assistant", text: "はい、こちらです" },
      { role: "user", text: "ありがとう！動いた" },    // 9文字
    ];

    const meta = computeConversationMeta(messages);

    expect(meta.currentMessageLength).toBe(9);
    // 平均: (5 + 10 + 9) / 3 = 8
    expect(meta.avgUserMessageLength).toBe(8);
  });

  it("直近5件のみで平均を計算する", () => {
    const messages: ParsedMessage[] = [
      { role: "user", text: "a".repeat(100) },  // 古い - 平均に含まれない
      { role: "user", text: "a".repeat(10) },
      { role: "user", text: "a".repeat(10) },
      { role: "user", text: "a".repeat(10) },
      { role: "user", text: "a".repeat(10) },
      { role: "user", text: "a".repeat(10) },  // 直近5件
    ];

    const meta = computeConversationMeta(messages);

    // 直近5件はすべて10文字
    expect(meta.avgUserMessageLength).toBe(10);
    expect(meta.currentMessageLength).toBe(10);
  });

  it("ポジティブ反応の直後はturnsSinceLastPositiveが0", () => {
    const messages: ParsedMessage[] = [
      { role: "user", text: "これやって" },
      { role: "assistant", text: "やりました" },
      { role: "user", text: "ありがとう！" },  // ポジティブ = 最新
    ];

    const meta = computeConversationMeta(messages);

    expect(meta.turnsSinceLastPositive).toBe(0);
  });

  it("ポジティブ反応から離れるとturnsSinceLastPositiveが増える", () => {
    const messages: ParsedMessage[] = [
      { role: "user", text: "いいね！" },       // ポジティブ
      { role: "assistant", text: "..." },
      { role: "user", text: "次はこれ" },       // +1
      { role: "assistant", text: "..." },
      { role: "user", text: "あとこれも" },      // +2
    ];

    const meta = computeConversationMeta(messages);

    expect(meta.turnsSinceLastPositive).toBe(2);
  });

  it("ポジティブ反応が一度もない場合はユーザーメッセージ数と同じ", () => {
    const messages: ParsedMessage[] = [
      { role: "user", text: "これやって" },
      { role: "assistant", text: "..." },
      { role: "user", text: "違う" },
      { role: "assistant", text: "..." },
      { role: "user", text: "だからさ" },
    ];

    const meta = computeConversationMeta(messages);

    expect(meta.turnsSinceLastPositive).toBe(3);
  });

  it("空配列の場合はデフォルト値を返す", () => {
    const meta = computeConversationMeta([]);

    expect(meta.avgUserMessageLength).toBe(0);
    expect(meta.currentMessageLength).toBe(0);
    expect(meta.turnsSinceLastPositive).toBe(0);
  });

  it("assistantメッセージのみの場合もデフォルト値を返す", () => {
    const messages: ParsedMessage[] = [
      { role: "assistant", text: "何かお手伝いしましょうか？" },
    ];

    const meta = computeConversationMeta(messages);

    expect(meta.avgUserMessageLength).toBe(0);
    expect(meta.currentMessageLength).toBe(0);
    expect(meta.turnsSinceLastPositive).toBe(0);
  });

  it("日本語のポジティブ表現を検出する（よさそう、おけ、素晴らしい）", () => {
    const messages: ParsedMessage[] = [
      { role: "user", text: "よさそうやね" },  // ポジティブ
      { role: "assistant", text: "..." },
      { role: "user", text: "次はこっち" },
    ];

    const meta = computeConversationMeta(messages);

    expect(meta.turnsSinceLastPositive).toBe(1);
  });

  it("諦めシグナル: currentがavgの50%以下かを判定できる", () => {
    const messages: ParsedMessage[] = [
      { role: "user", text: "a".repeat(100) },
      { role: "user", text: "a".repeat(100) },
      { role: "user", text: "a".repeat(100) },
      { role: "user", text: "a".repeat(100) },
      { role: "user", text: "もういい" },  // 4文字 → 100の50%以下
    ];

    const meta = computeConversationMeta(messages);

    // avgは直近5件: (100+100+100+100+4)/5 = 80.8 → 81
    expect(meta.avgUserMessageLength).toBe(81);
    expect(meta.currentMessageLength).toBe(4);
    // current (4) < avg (81) * 0.5 (40.5) → 諦めシグナル
    expect(meta.currentMessageLength < meta.avgUserMessageLength * 0.5).toBe(true);
  });
});
