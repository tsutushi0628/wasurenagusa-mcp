// ============================================================
// 層B（order-diagnostic）: 本番 searchHybrid の融合順位を構成既知の合成コーパスで断定
// ============================================================
//
// design-b2b4-golden-eval-harness.md §4「層B」／ §9-7「層B順序断定」に対応。
//
// 不変条件 I1（本番順の真実）: 順序の断定は必ず本番 searchHybrid(params, emb).results の
// 「実際に返る順序」に対して行う。eval-golden.ts のレガシー再ソート（rankLikeProduction=
// 1-distance 再ソートで rrfScore/timeDecay を捨てる経路）は一切使わない。ここは
// storage.searchHybrid().results の id 列を直読する。
//
// 不変条件 I4（記録層）: これらは順序挙動の回帰ピンであり、現行の本番係数のまま PASS する
// （＝現在の挙動をピン留めする。将来の願望値ではない）。本番 searchHybrid には手を入れない。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SQLiteStorage } from "./sqlite.js";
import {
  ORDER_SCENARIO_BUILDERS,
  buildB4Sink,
  buildB4RecencyTie,
  buildB2DualBeatsSingle,
  buildB2DecayFloodsFusion,
  buildB2FusionTie,
  buildSelfMatchException,
  type OrderScenario,
} from "./order-diagnostic.fixtures.js";

describe("order-diagnostic（層B）: 本番searchHybridの融合順位を構成既知の合成コーパスでピン留め", () => {
  let storage: SQLiteStorage;
  let tmpDir: string;

  beforeEach(() => {
    // 各テストはクリーンなDBに1シナリオだけ構築する（他シナリオのベクトルが候補プールを
    // 汚さないよう分離する。全件がベクトルKNN母集団に載るため混在は順位予測を壊す）。
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-order-diag-"));
    storage = new SQLiteStorage(join(tmpDir, "test.db"));
    storage.initialize();
  });

  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** 本番searchHybridを叩き、シナリオ構成員だけを本番融合順のまま射影して返す（I1）。 */
  function observeOrder(scenario: OrderScenario): string[] {
    const result = storage.searchHybrid(
      { query: scenario.query, limit: 10 },
      scenario.queryVector
    );
    const members = new Set(scenario.memberIds);
    // searchHybrid().results の順序をそのまま使い、シナリオ構成員だけに絞る（再ソートしない）。
    return result.results.map((r) => r.id).filter((id) => members.has(id));
  }

  it("業務意図(B4沈み込み): 最も関連度が高くても大幅に古い記憶は、関連度で劣る新しい2件の下に沈む", () => {
    const scenario = buildB4Sink(storage);
    expect(observeOrder(scenario)).toEqual(scenario.expectedOrder);
  });

  it("業務意図(B4門番): 経過日数が同じなら、順序は関連度（ベクトル順位=RRF基底）で決まる", () => {
    const scenario = buildB4RecencyTie(storage);
    expect(observeOrder(scenario)).toEqual(scenario.expectedOrder);
  });

  it("業務意図(B2融合): FTSとベクトルの二段一致は、やや古くても片段だけの新しい記憶に勝つ", () => {
    const scenario = buildB2DualBeatsSingle(storage);
    expect(observeOrder(scenario)).toEqual(scenario.expectedOrder);
  });

  it("業務意図(B2限界帯): 二段一致でも大幅に古いと、単段だが新しい記憶に順位を逆転される", () => {
    const scenario = buildB2DecayFloodsFusion(storage);
    expect(observeOrder(scenario)).toEqual(scenario.expectedOrder);
  });

  it("業務意図(B2融合): 新しさが同点なら、二段一致の融合強度がそのまま順序を決める", () => {
    const scenario = buildB2FusionTie(storage);
    expect(observeOrder(scenario)).toEqual(scenario.expectedOrder);
  });

  it("業務意図(R-B3自己検索): 完全一致の自己検索では、400日前の古い自己記憶が減衰を免れ新しい競合より上位", () => {
    const scenario = buildSelfMatchException(storage);
    expect(observeOrder(scenario)).toEqual(scenario.expectedOrder);
  });

  it("全シナリオが本番融合順で期待どおり並ぶ（層Bの一括回帰ピン。将来の係数変更で崩れると露見する）", () => {
    // 各ビルダーはクリーンなDBを要求するので、シナリオごとに使い捨てDBを立てて回す。
    for (const build of ORDER_SCENARIO_BUILDERS) {
      const dir = mkdtempSync(join(tmpdir(), "wasurenagusa-order-diag-each-"));
      const s = new SQLiteStorage(join(dir, "test.db"));
      s.initialize();
      try {
        const scenario = build(s);
        const members = new Set(scenario.memberIds);
        const observed = s
          .searchHybrid({ query: scenario.query, limit: 10 }, scenario.queryVector)
          .results.map((r) => r.id)
          .filter((id) => members.has(id));
        expect(observed, scenario.label).toEqual(scenario.expectedOrder);
      } finally {
        s.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
