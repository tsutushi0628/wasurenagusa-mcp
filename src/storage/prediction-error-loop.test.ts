import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SQLiteStorage } from "./sqlite.js";
import { computePredictionError } from "../vector/prediction-error.js";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, rmSync } from "fs";

describe("予測誤差ループ（SQLiteStorage 往復・後方互換・getContext）", () => {
  let storage: SQLiteStorage;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-pe-loop-test-"));
    storage = new SQLiteStorage(join(tmpDir, "test.db"));
    storage.initialize();
  });

  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("save→getDetail で予測4フィールドが正しく復元される", () => {
    const predicted = ["auth", "rate-limit"];
    const actual = ["db", "rate-limit"];
    const expectedError = computePredictionError(predicted, actual);

    const saved = storage.save({
      category: "log",
      title: "見立てズレの記録",
      content: "認証だと踏んだが実際はDBだった",
      tags: [],
      predictedFactors: predicted,
      actualFactors: actual,
      predictionError: expectedError,
      predictionDelta: "認証起因と見立てたが実体はDB側の負荷だった",
    });

    const detail = storage.getDetail({ ids: [saved.id] });
    expect(detail.entries.length).toBe(1);
    const e = detail.entries[0];
    expect(e.predictedFactors).toEqual(predicted);
    expect(e.actualFactors).toEqual(actual);
    // コード算出の誤差値と一致する
    expect(e.predictionError).toBe(expectedError);
    expect(e.predictionDelta).toBe("認証起因と見立てたが実体はDB側の負荷だった");
  });

  it("予測フィールド未指定の save は従来通り（4フィールドが undefined）", () => {
    const saved = storage.save({
      category: "config",
      title: "ポート設定",
      content: "backendは5001",
      tags: [],
    });

    const detail = storage.getDetail({ ids: [saved.id] });
    const e = detail.entries[0];
    expect(e.predictedFactors).toBeUndefined();
    expect(e.actualFactors).toBeUndefined();
    expect(e.predictionError).toBeUndefined();
    expect(e.predictionDelta).toBeUndefined();
    // 既存フィールドは正常
    expect(e.title).toBe("ポート設定");
  });

  it("後方互換: 予測4列がNULLの既存row相当を rowToEntry が例外なく読む", () => {
    // 旧データ相当（予測フィールド未指定）を保存し、フル取得して読める
    const saved = storage.save({
      category: "dont",
      title: "旧データ相当",
      content: "予測フィールド無しのエントリ",
      tags: ["legacy"],
      intensity: 4,
    });

    expect(() => storage.getDetail({ ids: [saved.id] })).not.toThrow();
    const e = storage.getDetail({ ids: [saved.id] }).entries[0];
    expect(e.predictionError).toBeUndefined();
    expect(e.intensity).toBe(4);
  });

  it("getContext: 誤差が閾値超のエントリは worldModelUpdates に出る", () => {
    // 閾値(0.5)超
    storage.save({
      category: "log",
      title: "大きく外したケース",
      content: "全外し",
      tags: [],
      predictedFactors: ["a"],
      actualFactors: ["b"],
      predictionError: computePredictionError(["a"], ["b"]), // 1
      predictionDelta: "見立てが全く違った",
    });

    const ctx = storage.getContext();
    expect(ctx.worldModelUpdates).toBeDefined();
    expect(ctx.worldModelUpdates).toContain("大きく外したケース");
    expect(ctx.worldModelUpdates).toContain("見立てが全く違った");
  });

  it("getContext: 閾値未満・予測無しのエントリは worldModelUpdates に出ない", () => {
    // 閾値未満（的中＝0）
    storage.save({
      category: "log",
      title: "ほぼ的中ケース",
      content: "見立て当たり",
      tags: [],
      predictedFactors: ["a", "b"],
      actualFactors: ["a", "b"],
      predictionError: computePredictionError(["a", "b"], ["a", "b"]), // 0
    });
    // 予測フィールド無し
    storage.save({
      category: "config",
      title: "予測なしconfig",
      content: "設定",
      tags: [],
    });

    const ctx = storage.getContext();
    // worldModelUpdates 自体が undefined（閾値超エントリゼロ）か、少なくとも該当タイトルを含まない
    if (ctx.worldModelUpdates) {
      expect(ctx.worldModelUpdates).not.toContain("ほぼ的中ケース");
      expect(ctx.worldModelUpdates).not.toContain("予測なしconfig");
    } else {
      expect(ctx.worldModelUpdates).toBeUndefined();
    }
  });

  it("getPredictionErrors: 予測誤差のあるIDだけ Map に載る", () => {
    const withErr = storage.save({
      category: "log",
      title: "誤差あり",
      content: "x",
      tags: [],
      predictedFactors: ["a"],
      actualFactors: ["b"],
      predictionError: computePredictionError(["a"], ["b"]),
    });
    const withoutErr = storage.save({
      category: "log",
      title: "誤差なし",
      content: "y",
      tags: [],
    });

    const map = storage.getPredictionErrors([withErr.id, withoutErr.id]);
    expect(map.get(withErr.id)).toBe(1);
    expect(map.has(withoutErr.id)).toBe(false);
  });
});
