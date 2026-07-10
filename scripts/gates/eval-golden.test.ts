/**
 * scripts/gates/eval-golden.test.ts
 * eval-golden.ts の評価純粋関数の業務意図テスト。
 *
 * 業務要件（tasks.md 2.3 / design.md Phase 2）:
 * - ヒット期待クエリは「正解記憶が上位k件以内に出たか」で recall@1/@5/@10 を測る
 * - 正しくゼロ件クエリは「ノイズを1件も返さないこと」が成績
 * - ゴールデンセットの形式不正・実行失敗は黙って分母から落とさない（成績の水増し防止）
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  GoldenQuery,
  bestExpectedRank,
  evaluateQueryOutcome,
  evaluateRunIntegrity,
  loadGoldenQueries,
  sanitizeErrorMessage,
  summarizeOutcomes,
} from "./eval-golden.js";

const hitQuery = (id: string, expectedIds: string[], queryClass = "natural"): GoldenQuery => ({
  id,
  query: `dummy-query-${id}`,
  queryClass,
  expect: "hit",
  expectedIds,
  expectedRankMax: 5,
});

const zeroQuery = (id: string, queryClass = "state-probe"): GoldenQuery => ({
  id,
  query: `dummy-query-${id}`,
  queryClass,
  expect: "correct-zero",
  expectedIds: [],
});

describe("bestExpectedRank: 正解記憶の最良順位", () => {
  it("複数の正解候補のうち最も上位のものの順位を返す（いずれか1つ当たれば良い、という採点定義）", () => {
    expect(bestExpectedRank(["a", "b", "c", "d"], ["d", "b"])).toBe(2);
  });

  it("正解がランキング圏外ならnull（当たり扱いにしない）", () => {
    expect(bestExpectedRank(["a", "b"], ["z"])).toBeNull();
  });
});

describe("evaluateQueryOutcome: ヒット期待クエリの採点", () => {
  it("正解が1位なら recall@1/@5/@10 すべてに数えられる", () => {
    const o = evaluateQueryOutcome(hitQuery("GQ-901", ["m1"]), ["m1", "x", "y"]);
    expect(o.bestRank).toBe(1);
    expect(o.hitAt1).toBe(true);
    expect(o.hitAt5).toBe(true);
    expect(o.hitAt10).toBe(true);
  });

  it("正解が7位なら@10のみ当たり（要求水準expectedRankMax=5は未達、@10は救済計測）", () => {
    const ranked = ["x1", "x2", "x3", "x4", "x5", "x6", "m1", "x7"];
    const o = evaluateQueryOutcome(hitQuery("GQ-902", ["m1"]), ranked);
    expect(o.bestRank).toBe(7);
    expect(o.hitAt1).toBe(false);
    expect(o.hitAt5).toBe(false);
    expect(o.hitAt10).toBe(true);
  });

  it("正解が圏外なら全recallで外れ", () => {
    const o = evaluateQueryOutcome(hitQuery("GQ-903", ["m1"]), ["x1", "x2"]);
    expect(o.bestRank).toBeNull();
    expect(o.hitAt1).toBe(false);
    expect(o.hitAt5).toBe(false);
    expect(o.hitAt10).toBe(false);
  });
});

describe("evaluateQueryOutcome: 正しくゼロ件クエリの採点", () => {
  it("0件返却なら成功（ストアに正解が構造的に無い問いへノイズを返さない）", () => {
    const o = evaluateQueryOutcome(zeroQuery("GQ-911"), []);
    expect(o.zeroCorrect).toBe(true);
  });

  it("1件でも返したら失敗（もっともらしいノイズ提示は誤答）", () => {
    const o = evaluateQueryOutcome(zeroQuery("GQ-912"), ["noise-1"]);
    expect(o.zeroCorrect).toBe(false);
    expect(o.resultCount).toBe(1);
  });
});

describe("summarizeOutcomes: recall@k と正ゼロ率の分母分離", () => {
  it("recall@kの分母はヒット期待クエリのみ、正ゼロ率の分母はcorrect-zeroクエリのみ", () => {
    const outcomes = [
      evaluateQueryOutcome(hitQuery("GQ-921", ["m1"]), ["m1"]), // rank1
      evaluateQueryOutcome(hitQuery("GQ-922", ["m2"]), ["x1", "x2", "m2"]), // rank3
      evaluateQueryOutcome(hitQuery("GQ-923", ["m3"]), ["x1"]), // 圏外
      evaluateQueryOutcome(zeroQuery("GQ-924"), []), // 正ゼロ成功
      evaluateQueryOutcome(zeroQuery("GQ-925"), ["noise"]), // 正ゼロ失敗
    ];
    const s = summarizeOutcomes(outcomes);
    expect(s.hitQueries).toBe(3);
    expect(s.recallAt1).toBeCloseTo(1 / 3, 3);
    expect(s.recallAt5).toBeCloseTo(2 / 3, 3);
    expect(s.recallAt10).toBeCloseTo(2 / 3, 3);
    expect(s.zeroQueries).toBe(2);
    expect(s.zeroCorrectCount).toBe(1);
    expect(s.zeroCorrectRate).toBe(0.5);
  });

  it("クエリクラス別の内訳が出る（G2でクラス別の劣化を見るため）", () => {
    const outcomes = [
      evaluateQueryOutcome(hitQuery("GQ-931", ["m1"], "keyword"), ["m1"]),
      evaluateQueryOutcome(hitQuery("GQ-932", ["m2"], "natural"), ["x"]),
      evaluateQueryOutcome(zeroQuery("GQ-933", "state-probe"), []),
    ];
    const s = summarizeOutcomes(outcomes);
    expect(s.byClass["keyword"]).toEqual({ total: 1, hitAt5: 1, zeroCorrect: 0 });
    expect(s.byClass["natural"]).toEqual({ total: 1, hitAt5: 0, zeroCorrect: 0 });
    expect(s.byClass["state-probe"]).toEqual({ total: 1, hitAt5: 0, zeroCorrect: 1 });
  });
});

describe("evaluateRunIntegrity: 失敗と分母欠けの不許容", () => {
  it("全問処理・失敗0のときだけPASS", () => {
    expect(evaluateRunIntegrity(52, 52, 0).result).toBe("PASS");
  });

  it("実行失敗が1件でもあればFAIL（失敗を分母から静かに落とすと成績が水増しされる）", () => {
    expect(evaluateRunIntegrity(52, 51, 1).result).toBe("FAIL");
  });

  it("処理数がゴールデン総数と合わなければFAIL", () => {
    expect(evaluateRunIntegrity(52, 50, 0).result).toBe("FAIL");
  });
});

describe("loadGoldenQueries: 形式不正の即時拒否", () => {
  const writeTemp = (content: string): { dir: string; path: string } => {
    const dir = mkdtempSync(join(tmpdir(), "eval-golden-test-"));
    const path = join(dir, "golden.jsonl");
    writeFileSync(path, content, "utf-8");
    return { dir, path };
  };

  it("正しい行は読み込める", () => {
    const { dir, path } = writeTemp(
      `${JSON.stringify(hitQuery("GQ-001", ["m1"]))}\n${JSON.stringify(zeroQuery("GQ-002"))}\n`,
    );
    try {
      const qs = loadGoldenQueries(path);
      expect(qs.length).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hit期待なのに正解ID空の行は黙ってスキップせずthrow（分母の静かな変質を防ぐ）", () => {
    const bad = { ...hitQuery("GQ-003", []), expectedIds: [] };
    const { dir, path } = writeTemp(`${JSON.stringify(bad)}\n`);
    try {
      expect(() => loadGoldenQueries(path)).toThrow(/expectedIdsが空/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("id重複はthrow（同一問題の二重計上を防ぐ）", () => {
    const { dir, path } = writeTemp(
      `${JSON.stringify(hitQuery("GQ-004", ["m1"]))}\n${JSON.stringify(hitQuery("GQ-004", ["m2"]))}\n`,
    );
    try {
      expect(() => loadGoldenQueries(path)).toThrow(/id重複/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("sanitizeErrorMessage: クエリ本文の非出力契約", () => {
  it("エラーメッセージに混入したクエリ本文を伏字にする", () => {
    expect(sanitizeErrorMessage("FTS5 error near 社外秘クエリ文", "社外秘クエリ文")).toBe(
      "FTS5 error near [query]",
    );
  });
});
