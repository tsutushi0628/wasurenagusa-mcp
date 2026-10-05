import Database from "better-sqlite3";
import { Writable } from "node:stream";
import { describe, it, expect, vi } from "vitest";

import {
  isDirectRun as contextIsDirectRun,
  parseContextHookInput,
  getContextInjectionPlan,
  emitContextOutput,
  writeStdoutOnce,
  detectPendingCorrectionCandidates,
  addUserPromptPendingReceipt,
  shouldProcessPromptCorrectionWork,
  estimateTokens,
  enforceInjectionTokenBudget,
  logInjectionBudgetWarning,
  DEFAULT_INJECTION_TOKEN_BUDGET,
} from "./context.js";
import { isDirectRun as sharedIsDirectRun } from "../utils/cli-entry.js";
import { renderCorrectionRules } from "../corrections/render.js";
import { hashRawText, hashSessionId } from "../corrections/session-store.js";
import { resolveSessionProject } from "../corrections/session-store.js";
import { extractOwnerEvent, isAutomatedPrompt } from "../corrections/events.js";
import { initializeCorrectionSchema } from "../storage/correction-schema.js";

describe("context.ts: isDirectRun export compatibility", () => {
  it("shares the implementation exported by cli-entry.ts", () => {
    expect(contextIsDirectRun).toBe(sharedIsDirectRun);
  });
});

describe("context.ts: hook input contract", () => {
  it("accepts a valid event at the 1 MiB stdin limit", () => {
    const prefix = JSON.stringify({
      session_id: "synthetic-session",
      cwd: "/synthetic/project",
      hook_event_name: "UserPromptSubmit",
      prompt: "合成入力",
    }).slice(0, -1);
    const input = `${prefix},"padding":"${"x".repeat(1024 * 1024 - Buffer.byteLength(prefix) - 14)}"}`;

    expect(Buffer.byteLength(input)).toBe(1024 * 1024);
    expect(parseContextHookInput(input).hook_event_name).toBe("UserPromptSubmit");
  });

  it("rejects an input over 1 MiB and an unknown hook event", () => {
    const oversized = JSON.stringify({
      session_id: "synthetic-session",
      cwd: "/synthetic/project",
      hook_event_name: "SessionStart",
      padding: "x".repeat(1024 * 1024),
    });
    const unknownEvent = JSON.stringify({
      session_id: "synthetic-session",
      cwd: "/synthetic/project",
      hook_event_name: "OtherEvent",
    });

    expect(() => parseContextHookInput(oversized)).toThrow();
    expect(() => parseContextHookInput(unknownEvent)).toThrow();
  });
});

describe("context.ts: event injection route", () => {
  it("starts refresh at human turn 31 and keeps turn 30 on the prompt path", () => {
    const input = {
      session_id: "synthetic-session",
      cwd: "/synthetic/project",
      hook_event_name: "UserPromptSubmit" as const,
      prompt: "合成の質問",
    };

    expect(getContextInjectionPlan(input, 30, 2000)).toEqual({
      requestTrigger: "prompt",
      renderTrigger: "prompt",
      ledgerTrigger: "prompt",
      budgetTokens: 800,
    });
    expect(getContextInjectionPlan(input, 31, 2000)).toEqual({
      requestTrigger: "refresh",
      renderTrigger: "refresh",
      ledgerTrigger: "refresh",
      budgetTokens: 800,
    });
  });

  it("uses the compact frame for PreCompact and a fresh start frame after compact", () => {
    const compactInput = {
      session_id: "synthetic-session",
      cwd: "/synthetic/project",
      hook_event_name: "PreCompact" as const,
    };
    const resumedInput = {
      session_id: "synthetic-session",
      cwd: "/synthetic/project",
      hook_event_name: "SessionStart" as const,
      source: "compact",
    };

    expect(getContextInjectionPlan(compactInput, 12, 2000)).toEqual({
      requestTrigger: "compact",
      renderTrigger: "precompact",
      ledgerTrigger: "compact",
      budgetTokens: 450,
    });
    expect(getContextInjectionPlan(resumedInput, 12, 2000)).toEqual({
      requestTrigger: "start",
      renderTrigger: "compact",
      ledgerTrigger: "start",
      budgetTokens: 1800,
    });
  });
});

describe("context.ts: correction session project", () => {
  it("SessionStartとcompactは既存eventのprojectを読み、eventなしなら起動時cwdを使う", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL)");
    db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (10, 'synthetic-time')").run();
    initializeCorrectionSchema(db);
    const sessionIdHash = hashSessionId("synthetic-session");
    db.prepare(`
      INSERT INTO owner_correction_events (
        event_id, session_id_hash, human_ordinal, observed_at, available_at,
        source_kind, excerpt, previous_action, project, scope, raw_text_hash,
        source_locator_hash, processed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "event-first", sessionIdHash, 1, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z",
      "user", "合成発話", "action_unknown", "startup-project", "general", "synthetic-hash",
      "synthetic-locator", "2026-01-01T00:00:01.000Z",
    );
    try {
      expect(resolveSessionProject(db, sessionIdHash, "later-cwd-project"))
        .toBe("startup-project");
      expect(resolveSessionProject(db, hashSessionId("empty-session"), "startup-project"))
        .toBe("startup-project");
    } finally {
      db.close();
    }
  });
});

describe("context.ts: automated prompt injection gate", () => {
  it("lets a human code-only prompt reach confirmed and restore injection while skipping automated prompts", () => {
    const humanPrompt = ["```ts", "const value = 1;", "```"].join("\n");
    const humanEvent = extractOwnerEvent({ hookEventName: "UserPromptSubmit", prompt: humanPrompt });
    const automatedPrompt = "keep-alive: synthetic response";

    expect(humanEvent).toBeNull();
    expect(isAutomatedPrompt(humanPrompt)).toBe(false);
    expect(shouldProcessPromptCorrectionWork("UserPromptSubmit", isAutomatedPrompt(humanPrompt))).toBe(true);
    expect(shouldProcessPromptCorrectionWork("UserPromptSubmit", isAutomatedPrompt(automatedPrompt))).toBe(false);
  });
});

describe("context.ts: 未照合hookの訂正候補", () => {
  it("hook promptから検出した完全規則をpending保存用に返す", () => {
    const candidates = detectPendingCorrectionCandidates("今後は質問に答えてください");

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      ruleText: "毎回、質問に回答する",
      status: "confirmed",
      topicKey: "response_policy",
      actionKey: "answer",
      ruleInput: {
        version: 2,
        topicKey: "response_policy",
        actionKey: "answer",
        requiredValues: { subject: "質問" },
        conditions: [],
        lifetimeKind: "explicit_continuing",
        continuationBasis: "explicit-continuing-command",
      },
    });
    expect(candidates[0]?.ruleText).not.toBe("今後は質問に答えてください");
  });

  it("機密値を含むpromptから機密文字列を候補へ残さない", () => {
    const candidates = detectPendingCorrectionCandidates(
      "今後はtoken=synthetic-secret-value-1234567890を使って回答して",
    );

    expect(candidates.length).toBeGreaterThan(0);
    expect(JSON.stringify(candidates)).not.toContain("synthetic-secret-value-1234567890");
  });

  it("訂正でないpromptは候補を作らない", () => {
    expect(detectPendingCorrectionCandidates("合成値を検索してください")).toEqual([]);
  });

  it("自動promptは出力済みでもpending receiptを保存しない", () => {
    const storage = { runCorrectionTransaction: vi.fn() };
    const receiptId = addUserPromptPendingReceipt(
      storage as never,
      "synthetic-session-hash",
      "synthetic-session",
      "synthetic-uuid",
      0,
      "keep-alive: synthetic response",
      "2026-10-03T00:00:01.000Z",
      true,
    );

    expect(detectPendingCorrectionCandidates("keep-alive: synthetic response")).toEqual([]);
    expect(receiptId).toBe("");
    expect(storage.runCorrectionTransaction).not.toHaveBeenCalled();
  });

  it("未照合receiptへ検出候補を保存し、UUID再配信は既存時刻で冪等に扱う", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL)");
    db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (10, 'synthetic-time')").run();
    initializeCorrectionSchema(db);
    const storage = {
      runCorrectionTransaction<T>(callback: (context: { db: Database.Database }) => T): T {
        return db.transaction(() => callback({ db })).immediate();
      },
    };
    const sessionId = "synthetic-session";
    const sessionIdHash = hashSessionId(sessionId);
    const prompt = "今後は質問に答えてください";
    try {
      const receiptId = addUserPromptPendingReceipt(
        storage as never,
        sessionIdHash,
        sessionId,
        "synthetic-uuid",
        0,
        prompt,
        "2026-10-03T00:00:01.000Z",
        false,
      );
      const repeatedId = addUserPromptPendingReceipt(
        storage as never,
        sessionIdHash,
        sessionId,
        "synthetic-uuid",
        0,
        prompt,
        "2026-10-03T00:00:02.000Z",
        false,
      );
      const row = db.prepare(`
        SELECT received_at, raw_text_hash, extracted_candidates
        FROM owner_correction_pending WHERE receipt_id = ?
      `).get(receiptId) as { received_at: string; raw_text_hash: string; extracted_candidates: string };
      const extractedCandidates = JSON.parse(row.extracted_candidates);

      expect(repeatedId).toBe(receiptId);
      expect(row.received_at).toBe("2026-10-03T00:00:01.000Z");
      expect(row.raw_text_hash).toBe(hashRawText(prompt));
      expect(extractedCandidates).toMatchObject([{
        ruleText: "毎回、質問に回答する",
        status: "confirmed",
        ruleInput: {
          version: 2,
          topicKey: "response_policy",
          actionKey: "answer",
          requiredValues: { subject: "質問" },
          conditions: [],
          lifetimeKind: "explicit_continuing",
          continuationBasis: "explicit-continuing-command",
        },
      }]);
      expect(JSON.stringify(extractedCandidates)).not.toContain(prompt);
    } finally {
      db.close();
    }
  });
});

describe("context.ts: stdout と訂正注入台帳", () => {
  const rendered = renderCorrectionRules({
    trigger: "prompt",
    rules: [{
      bundleKey: "synthetic-bundle",
      version: 1,
      title: "合成の注意",
      ruleText: "合成fixtureでは条件を保つ",
      delivery: "related",
    }],
  });

  it("stdout を1回書き、その callback が成功した後に台帳を保存する", async () => {
    const order: string[] = [];
    let writtenOutput = "";
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        order.push("stdout");
        writtenOutput = chunk.toString();
        callback();
      },
    });
    const storage = {
      runCorrectionTransaction(callback: (context: { db: { prepare: () => { run: () => void } } }) => unknown) {
        return callback({ db: { prepare: () => ({ run: () => order.push("ledger") }) } });
      },
    };

    const result = await emitContextOutput({
      output: rendered.text,
      rendered,
      storage: storage as never,
      sessionIdHash: "synthetic-session-hash",
      compactEpoch: 0,
      humanOrdinal: 1,
      trigger: "prompt",
      deadlineAt: Date.now() + 3500,
      stdout,
    });

    expect(result.status).toBe("emitted");
    expect(order).toEqual(["stdout", "ledger"]);
    expect(writtenOutput).toContain("合成fixtureでは条件を保つ");
  });

  it("EPIPE callback の失敗を受けた場合は台帳を保存しない", async () => {
    const order: string[] = [];
    const stdout = new Writable({
      write(_chunk, _encoding, callback) {
        order.push("stdout");
        callback(Object.assign(new Error("synthetic pipe failure"), { code: "EPIPE" }));
      },
    });
    const storage = {
      runCorrectionTransaction(callback: (context: { db: { prepare: () => { run: () => void } } }) => unknown) {
        return callback({ db: { prepare: () => ({ run: () => order.push("ledger") }) } });
      },
    };

    const result = await emitContextOutput({
      output: rendered.text,
      rendered,
      storage: storage as never,
      sessionIdHash: "synthetic-session-hash",
      compactEpoch: 0,
      humanOrdinal: 1,
      trigger: "prompt",
      deadlineAt: Date.now() + 3500,
      stdout,
    });

    expect(result.status).toBe("write_failed");
    expect(order).toEqual(["stdout"]);
  });

  it("台帳保存が失敗した場合は出力済みでも成功を返さない", async () => {
    const stdout = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const storage = {
      runCorrectionTransaction() {
        throw new Error("synthetic ledger failure");
      },
    };

    const result = await emitContextOutput({
      output: rendered.text,
      rendered,
      storage: storage as never,
      sessionIdHash: "synthetic-session-hash",
      compactEpoch: 0,
      humanOrdinal: 1,
      trigger: "prompt",
      deadlineAt: Date.now() + 3500,
      stdout,
    });

    expect(result.status).toBe("ledger_unknown");
    stdout.destroy();
  });

  it("stdout callback が期限後に返った場合は台帳を保存しない", async () => {
    const stdout = new Writable({
      write(_chunk, _encoding, callback) {
        setTimeout(callback, 30);
      },
    });
    const storage = { runCorrectionTransaction: vi.fn() };

    const result = await emitContextOutput({
      output: rendered.text,
      rendered,
      storage: storage as never,
      sessionIdHash: "synthetic-session-hash",
      compactEpoch: 0,
      humanOrdinal: 1,
      trigger: "prompt",
      deadlineAt: Date.now() + 310,
      stdout,
    });

    expect(result.status).toBe("timeout");
    expect(storage.runCorrectionTransaction).not.toHaveBeenCalled();
    stdout.destroy();
  });

  it("期限切れなら stdout と台帳のどちらも処理しない", async () => {
    const write = vi.fn();
    const storage = { runCorrectionTransaction: vi.fn() };

    const result = await emitContextOutput({
      output: rendered.text,
      rendered,
      storage: storage as never,
      sessionIdHash: "synthetic-session-hash",
      compactEpoch: 0,
      humanOrdinal: 1,
      trigger: "prompt",
      deadlineAt: Date.now() - 1,
      stdout: { write } as never,
    });

    expect(result.status).toBe("timeout");
    expect(write).not.toHaveBeenCalled();
    expect(storage.runCorrectionTransaction).not.toHaveBeenCalled();
  });

  it("stdout 書込み関数は空本文でも1回だけ callback を待つ", async () => {
    let writes = 0;
    const stdout = new Writable({
      write(_chunk, _encoding, callback) {
        writes += 1;
        callback();
      },
    });

    await expect(writeStdoutOnce("", stdout)).resolves.toBe(true);
    expect(writes).toBe(1);
  });
});

describe("context.ts: estimateTokens (トークン概算・過小評価しない)", () => {
  it("空文字は0トークンと見積もる", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("英数字テキストは一般的な目安（4文字/トークン）を下回らない見積もりを返す", () => {
    const text = "a".repeat(400);
    const conservativeLowerBound = Math.ceil(text.length / 4);

    expect(estimateTokens(text)).toBeGreaterThanOrEqual(conservativeLowerBound);
  });

  it("日本語（マルチバイト文字主体）のテキストは、文字数を下回らない見積もりを返す（過小評価しない）", () => {
    const text = "あ".repeat(300);

    expect(estimateTokens(text)).toBeGreaterThanOrEqual(text.length);
  });

  it("テキストが長くなるほど概算トークン数は増える（短縮ミスで過小評価にならない）", () => {
    const shortText = "業務要件を確認する文章です。";
    const longText = shortText.repeat(10);

    expect(estimateTokens(longText)).toBeGreaterThan(estimateTokens(shortText));
  });
});

describe("context.ts: enforceInjectionTokenBudget (注入バジェット強制)", () => {
  it("概算トークン数が上限とちょうど一致する境界では、切り詰めずそのまま素通しする", () => {
    const text = ["line-A", "line-B", "line-C"].join("\n");
    const exactBudget = estimateTokens(text);

    const result = enforceInjectionTokenBudget(text, exactBudget);

    expect(result.truncated).toBe(false);
    expect(result.text).toBe(text);
    expect(result.omittedTokens).toBe(0);
  });

  it("上限を明確に超えるテキストは行境界で末尾から切り詰め、本文が上限内に収まる", () => {
    const lines = Array.from(
      { length: 50 },
      (_, i) => `記憶エントリ${i}: 業務上の重要な注意事項の本文です。`,
    );
    const text = lines.join("\n");
    const fullTokens = estimateTokens(text);
    const budgetTokens = Math.floor(fullTokens / 5);

    const result = enforceInjectionTokenBudget(text, budgetTokens);

    expect(result.truncated).toBe(true);
    expect(result.omittedTokens).toBeGreaterThan(0);

    const bodyLines = result.text.split("\n");
    const bodyWithoutMarker = bodyLines.slice(0, -1).join("\n");
    expect(estimateTokens(bodyWithoutMarker)).toBeLessThanOrEqual(budgetTokens);

    // 末尾側のエントリは切り捨てられ欠損している
    expect(result.text).not.toContain(lines[lines.length - 1]);
  });

  it("切り詰め時は無言にせず、末尾に省略トークン数入りの可視マーカー行を残す", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `注意事項${i}行目のテキストです。`);
    const text = lines.join("\n");
    const budgetTokens = 5;

    const result = enforceInjectionTokenBudget(text, budgetTokens);

    expect(result.text).toContain("バジェット上限で切り詰められました");
    expect(result.text).toContain(`${result.omittedTokens}`);
  });

  it("上限内のテキストは、切り詰め経路を通らず元の文字列と完全一致で返す（フォールバック全文流しと誤認しない）", () => {
    const text = "ok";

    const result = enforceInjectionTokenBudget(text, DEFAULT_INJECTION_TOKEN_BUDGET);

    expect(result.text).toBe(text);
    expect(result.truncated).toBe(false);
  });
});

describe("context.ts: logInjectionBudgetWarning (fail-loud警告・欠損の可視化)", () => {
  it("切り詰め発生時は、stderrに省略トークン数を含む警告を1行出す", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = { text: "x", truncated: true, omittedTokens: 42 };

    logInjectionBudgetWarning(1000, result);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain("42");
    spy.mockRestore();
  });

  it("上限内（切り詰めなし）のときは、警告を出さない", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = { text: "x", truncated: false, omittedTokens: 0 };

    logInjectionBudgetWarning(1000, result);

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
