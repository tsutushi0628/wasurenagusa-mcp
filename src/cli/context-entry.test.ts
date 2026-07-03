import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { pathToFileURL } from "url";

import {
  isDirectRun,
  estimateTokens,
  enforceInjectionTokenBudget,
  logInjectionBudgetWarning,
  DEFAULT_INJECTION_TOKEN_BUDGET,
} from "./context.js";

/**
 * CLIエントリ判定（isDirectRun）と注入トークンバジェット強制の業務挙動を検証する。
 *
 * 背景: npmグローバルbin（symlink）経由の起動だと、生パス一致判定
 * （process.argv[1] === fileURLToPath(import.meta.url)）が不一致になり main() が
 * 呼ばれず、記憶ストアのコンテキスト注入が無言で0バイトになっていた。
 * realpath解決による同一性判定でsymlink経由の起動も検知できることを検証する。
 *
 * あわせて、注入の暴走（無制限の全文注入）を防ぐトークンバジェット強制が
 * 「上限内は素通し・超過時は行境界で切り詰め・欠損は必ず可視化する
 * （無言で切らない・全文フォールバック経路を作らない）」という業務要件を
 * 満たすことを検証する。
 */
describe("context.ts: isDirectRun (CLIエントリ判定・symlink経由の起動検知)", () => {
  let tmpDir: string;
  let realFile: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-isdirectrun-test-"));
    realFile = join(tmpDir, "context.js");
    writeFileSync(realFile, "// dummy module file\n");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("npmグローバルbinのsymlink経由で起動されても、実体パス解決で本人の起動と検知する", () => {
    const symlinkPath = join(tmpDir, "wasurenagusa-context-bin");
    symlinkSync(realFile, symlinkPath);
    const moduleUrl = pathToFileURL(realFile).href;

    expect(isDirectRun(symlinkPath, moduleUrl)).toBe(true);
  });

  it("symlinkを介さない直接node実行では、従来どおり起動を検知する", () => {
    const moduleUrl = pathToFileURL(realFile).href;

    expect(isDirectRun(realFile, moduleUrl)).toBe(true);
  });

  it("無関係な別ファイルから呼ばれた場合は、本人の起動と誤検知しない", () => {
    const otherFile = join(tmpDir, "other-script.js");
    writeFileSync(otherFile, "// unrelated script\n");
    const moduleUrl = pathToFileURL(realFile).href;

    expect(isDirectRun(otherFile, moduleUrl)).toBe(false);
  });

  it("argv1が未定義（importされただけ等）なら、起動と判定しない", () => {
    const moduleUrl = pathToFileURL(realFile).href;

    expect(isDirectRun(undefined, moduleUrl)).toBe(false);
  });

  it("realpath解決に失敗する場合（存在しないパス）でも、生パスが完全一致すれば起動と判定する（フォールバック）", () => {
    const missingPath = join(tmpDir, "does-not-exist.js");
    const moduleUrl = pathToFileURL(missingPath).href;

    expect(isDirectRun(missingPath, moduleUrl)).toBe(true);
  });

  it("realpath解決に失敗し、かつ生パスも不一致なら、起動と判定しない（フォールバック時も誤起動しない）", () => {
    const missingPathA = join(tmpDir, "missing-a.js");
    const missingPathB = join(tmpDir, "missing-b.js");
    const moduleUrl = pathToFileURL(missingPathB).href;

    expect(isDirectRun(missingPathA, moduleUrl)).toBe(false);
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
