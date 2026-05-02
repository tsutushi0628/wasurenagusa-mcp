import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { readFile } from "fs/promises";

import {
  runDreamGenerationForProject,
  buildDreamPrompt,
  parseDreamLLMResponse,
  isDreamFreshEnough,
  sanitizeSeedsForPrompt,
  type DreamSeed,
} from "./dream-worker.js";
import { SQLiteStorage } from "../storage/sqlite.js";
import { config } from "../config.js";
import type { MemoryEntry } from "../types.js";

/**
 * heart-extension F3: dream-worker のユニットテスト。
 *
 * - prompts/dream.txt が存在し、必須セクション（出力JSON仕様）を含む
 * - シード3件 → モックLLM → category='dream' でSQLiteへsaveされる
 * - 直近24h以内に dream があれば save をスキップ（重複防御）
 * - LLM 失敗時は exit 0 相当（save 呼ばれない、stderr に1行）
 */
describe("dream-worker: prompts/dream.txt の存在と内容", () => {
  const __filename = fileURLToPath(import.meta.url);
  const promptsDir = resolve(__filename, "../../../prompts");

  it("prompts/dream.txt が存在する", async () => {
    const promptPath = join(promptsDir, "dream.txt");
    const content = await readFile(promptPath, "utf-8");
    expect(content.length).toBeGreaterThan(0);
  });

  it("dream.txt は出力JSON形式（title/content）を指示している", async () => {
    const promptPath = join(promptsDir, "dream.txt");
    const content = await readFile(promptPath, "utf-8");
    expect(content).toContain("title");
    expect(content).toContain("content");
  });

  it("dream.txt は機密情報抽象化の指示を含む", async () => {
    const promptPath = join(promptsDir, "dream.txt");
    const content = await readFile(promptPath, "utf-8");
    // パス／個人名／APIキーの抽象化指示
    expect(content).toMatch(/抽象化|含めない|機密|キー/);
  });
});

describe("buildDreamPrompt", () => {
  it("シード3件が含まれた1つのプロンプト文字列を返す", () => {
    const template = "あなたは夢を見る。以下のシードから夢を生成。\n{{seeds}}";
    const seeds: DreamSeed[] = [
      { title: "本番DB保護", content: "本番に直接接続するな", category: "dont", intensity: 5 },
      { title: "プロト着手", content: "リファクタを開始した", category: "log", intensity: 2 },
      { title: "命名規則", content: "kebab-caseに統一", category: "decision", intensity: 3 },
    ];
    const prompt = buildDreamPrompt(template, seeds);
    expect(prompt).toContain("本番DB保護");
    expect(prompt).toContain("プロト着手");
    expect(prompt).toContain("命名規則");
  });

  it("シード0件でもプロンプトを返す（空セクション）", () => {
    const template = "テンプレ\n{{seeds}}";
    const prompt = buildDreamPrompt(template, []);
    expect(prompt).toContain("テンプレ");
  });
});

describe("parseDreamLLMResponse", () => {
  it("正常な JSON 応答から title/content を抽出する", () => {
    const raw = `\`\`\`json\n{"title":"森のささやき","content":"細い道で誰かが手を振った気がした"}\n\`\`\``;
    const parsed = parseDreamLLMResponse(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.title).toBe("森のささやき");
    expect(parsed!.content).toBe("細い道で誰かが手を振った気がした");
  });

  it("プレーン JSON も読める", () => {
    const raw = `{"title":"星の音","content":"水面に光が躍っていた"}`;
    const parsed = parseDreamLLMResponse(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.title).toBe("星の音");
  });

  it("JSON でない応答は null を返す", () => {
    const raw = "not a json";
    const parsed = parseDreamLLMResponse(raw);
    expect(parsed).toBeNull();
  });

  it("title/content が欠落していたら null", () => {
    const raw = `{"title":"x"}`;
    const parsed = parseDreamLLMResponse(raw);
    expect(parsed).toBeNull();
  });
});

describe("sanitizeSeedsForPrompt", () => {
  it("seed の title/content から APIキー・絶対パス・メアドを [REDACTED] に置換する", () => {
    const seeds: DreamSeed[] = [
      {
        title: "オーナーが激怒したケース",
        content:
          "本番送信した。APIキーは sk-1234567890abcdefghij で、ファイルは /Users/foo/secret.env にあった。連絡は taro@example.com まで。",
        category: "dont",
        intensity: 5,
      },
    ];
    const sanitized = sanitizeSeedsForPrompt(seeds);
    expect(sanitized[0].title).toBe("オーナーが激怒したケース");
    expect(sanitized[0].content).toBe(
      "本番送信した。APIキーは [REDACTED] で、ファイルは [REDACTED] にあった。連絡は [REDACTED] まで。",
    );
    // 元のオブジェクトは破壊しない
    expect(seeds[0].content).toContain("sk-1234567890abcdefghij");
  });

  it("buildDreamPrompt と組み合わせて最終プロンプト文字列に [REDACTED] が含まれる", () => {
    const template = "シード: {{seeds}}";
    const seeds: DreamSeed[] = [
      {
        title: "認証フロー",
        content: "JWT は eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c だった",
        category: "log",
        intensity: 4,
      },
    ];
    const sanitized = sanitizeSeedsForPrompt(seeds);
    const prompt = buildDreamPrompt(template, sanitized);
    expect(prompt).toContain("[REDACTED]");
    expect(prompt).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });
});

describe("isDreamFreshEnough", () => {
  it("直近24時間以内の dream があれば true（=スキップ判定）", () => {
    const now = new Date("2026-05-02T22:00:00+09:00");
    const recent: MemoryEntry = {
      id: "dream-1",
      timestamp: "2026-05-02T08:00:00+09:00",
      category: "dream",
      title: "朝靄",
      content: "靄の中を歩いた",
      tags: ["dream"],
    };
    expect(isDreamFreshEnough(recent, now)).toBe(true);
  });

  it("25時間以上前の dream は false（=新しく作る）", () => {
    const now = new Date("2026-05-02T22:00:00+09:00");
    const old: MemoryEntry = {
      id: "dream-1",
      timestamp: "2026-05-01T20:00:00+09:00",
      category: "dream",
      title: "古い夢",
      content: "...",
      tags: ["dream"],
    };
    expect(isDreamFreshEnough(old, now)).toBe(false);
  });

  it("null（dream エントリなし）は false", () => {
    const now = new Date();
    expect(isDreamFreshEnough(null, now)).toBe(false);
  });
});

describe("runDreamGenerationForProject 主流フロー", () => {
  let tmpDir: string;
  let projectRoot: string;
  let memoryPath: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-dream-worker-test-"));
    projectRoot = join(tmpDir, "myproject");
    memoryPath = join(projectRoot, ".wasurenagusa");
    dbPath = join(memoryPath, config.sqliteFile);
    mkdirSync(memoryPath, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("シードあり → モックLLM呼び出し → category='dream' で save される", async () => {
    // 事前: dont/log/decision エントリを SQLite に投入（シード抽出元）
    const storage = new SQLiteStorage(dbPath);
    storage.initialize(memoryPath);
    storage.save({
      category: "dont",
      title: "本番DB保護",
      content: "本番DBに直接接続するな",
      tags: ["db"],
      project: "myproject",
      intensity: 5,
    });
    storage.save({
      category: "log",
      title: "プロト着手",
      content: "リファクタを開始した",
      tags: ["log"],
      project: "myproject",
    });
    storage.close();

    const mockGenerateText = vi
      .fn()
      .mockResolvedValue(`{"title":"霧の中の声","content":"誰かが小さく頷いた"}`);

    const result = await runDreamGenerationForProject({
      memoryPath,
      projectRoot,
      generateTextFn: mockGenerateText,
    });

    expect(result).not.toBeNull();
    expect(result!.title).toBe("霧の中の声");
    expect(mockGenerateText).toHaveBeenCalledTimes(1);

    // SQLite に dream カテゴリで保存されている
    const verifyStorage = new SQLiteStorage(dbPath);
    verifyStorage.initialize(memoryPath);
    const dreams = verifyStorage.search({ query: "", category: "dream", limit: 5 });
    verifyStorage.close();
    expect(dreams.results.length).toBe(1);
    expect(dreams.results[0].title).toBe("霧の中の声");
  });

  it("シード0件（dont/log/decision なし）でも LLM は呼ばれない（無意味な夢を作らない）", async () => {
    const mockGenerateText = vi.fn();
    const result = await runDreamGenerationForProject({
      memoryPath,
      projectRoot,
      generateTextFn: mockGenerateText,
    });

    expect(result).toBeNull();
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("直近24h以内に dream があれば save が呼ばれない（重複防御）", async () => {
    const storage = new SQLiteStorage(dbPath);
    storage.initialize(memoryPath);
    // シード材料を入れる
    storage.save({
      category: "dont",
      title: "本番DB保護",
      content: "本番DBに直接接続するな",
      tags: ["db"],
      project: "myproject",
      intensity: 5,
    });
    // 直近の dream を作っておく
    storage.save({
      category: "dream",
      title: "既存の夢",
      content: "既に見た夢",
      tags: ["dream"],
      project: "myproject",
    });
    storage.close();

    const mockGenerateText = vi.fn();
    const result = await runDreamGenerationForProject({
      memoryPath,
      projectRoot,
      generateTextFn: mockGenerateText,
    });

    expect(result).toBeNull();
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("LLM が throw しても呼び出し元には伝播しない（fail-open）", async () => {
    const storage = new SQLiteStorage(dbPath);
    storage.initialize(memoryPath);
    storage.save({
      category: "dont",
      title: "本番DB保護",
      content: "本番DBに直接接続するな",
      tags: ["db"],
      project: "myproject",
      intensity: 5,
    });
    storage.close();

    const failingFn = vi.fn().mockRejectedValue(new Error("LLM API failure"));

    const result = await runDreamGenerationForProject({
      memoryPath,
      projectRoot,
      generateTextFn: failingFn,
    });

    expect(result).toBeNull();
    expect(failingFn).toHaveBeenCalled();

    // 失敗時は dream エントリも残らない
    const verifyStorage = new SQLiteStorage(dbPath);
    verifyStorage.initialize(memoryPath);
    const dreams = verifyStorage.search({ query: "", category: "dream", limit: 5 });
    verifyStorage.close();
    expect(dreams.results.length).toBe(0);
  });

  it("シードに混入した APIキー・絶対パスはサニタイズされてから LLM に渡される", async () => {
    const storage = new SQLiteStorage(dbPath);
    storage.initialize(memoryPath);
    storage.save({
      category: "dont",
      title: "本番に直接送信した",
      content:
        "APIキー sk-1234567890abcdefghij を /Users/foo/secret.env に保存していた。連絡は admin@example.com まで。",
      tags: ["incident"],
      project: "myproject",
      intensity: 5,
    });
    storage.close();

    let capturedPrompt: string | null = null;
    const mockGenerateText = vi.fn().mockImplementation(async (prompt: string) => {
      capturedPrompt = prompt;
      return `{"title":"霧","content":"何かが揺れた"}`;
    });

    const result = await runDreamGenerationForProject({
      memoryPath,
      projectRoot,
      generateTextFn: mockGenerateText,
    });

    expect(result).not.toBeNull();
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    expect(capturedPrompt).not.toBeNull();
    // 機密情報が [REDACTED] に置換されていること
    expect(capturedPrompt!).toContain("[REDACTED]");
    // 生のシークレット文字列がプロンプトに残っていないこと
    expect(capturedPrompt!).not.toContain("sk-1234567890abcdefghij");
    expect(capturedPrompt!).not.toContain("/Users/foo/secret.env");
    expect(capturedPrompt!).not.toContain("admin@example.com");
  });

  it("LLM 応答が壊れた JSON でも throw しない（fail-open）", async () => {
    const storage = new SQLiteStorage(dbPath);
    storage.initialize(memoryPath);
    storage.save({
      category: "dont",
      title: "本番DB保護",
      content: "本番DBに直接接続するな",
      tags: ["db"],
      project: "myproject",
      intensity: 5,
    });
    storage.close();

    const brokenFn = vi.fn().mockResolvedValue("not a json");
    const result = await runDreamGenerationForProject({
      memoryPath,
      projectRoot,
      generateTextFn: brokenFn,
    });

    expect(result).toBeNull();
  });
});
