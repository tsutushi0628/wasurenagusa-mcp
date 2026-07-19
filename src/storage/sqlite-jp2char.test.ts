import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SQLiteStorage, extractShortCjkTokens, tokenizeForFts } from "./sqlite.js";

// 384次元のスパースベクトル（既存 sqlite-search-relevance.test.ts と同じ作り方）。
function makeVector(values: Record<number, number>): number[] {
  const vec = new Array(384).fill(0);
  for (const [idx, val] of Object.entries(values)) vec[Number(idx)] = val;
  return vec;
}

// ============================================================
// 純粋関数（DB不要）
// ============================================================

describe("extractShortCjkTokens（純粋関数）", () => {
  it("2文字の漢字・カタカナ連続だけを拾い、1文字/3文字以上/ひらがな/英数字は拾わない", () => {
    // 決算(漢字2)=拾う, とは(かな2)=捨てる, 何(漢字1)=捨てる
    expect(extractShortCjkTokens("決算とは何か")).toEqual(["決算"]);
    // バグ(カナ2)=拾う, 契約書(漢字3)=捨てる（FTSが拾える）
    expect(extractShortCjkTokens("契約書のバグ")).toEqual(["バグ"]);
    // AB(英数2)=捨てる, 顧客(漢字2)=拾う
    expect(extractShortCjkTokens("AB顧客")).toEqual(["顧客"]);
    // 同一語は1回だけ（重複LIKEを避ける）
    expect(extractShortCjkTokens("決算 決算")).toEqual(["決算"]);
    // 3文字以上の語しか無ければ空（=救済不要でFTSに任せる）
    expect(extractShortCjkTokens("検索性能")).toEqual([]);
    // 手がかりが1文字漢字/ひらがな/英数字のみなら空（誤救済しない）
    expect(extractShortCjkTokens("とはABと何か")).toEqual([]);
  });
});

describe("tokenizeForFts（run分割一本化リファクタ後の出力不変）", () => {
  it("3文字未満を捨てる仕様と語分割の観測出力が変わらない", () => {
    // 2文字漢字/かなだけのクエリは空（trigramで拾えない語を捨てる従来仕様）
    expect(tokenizeForFts("決算とは何か")).toEqual([]);
    // 契約書(漢字3)=残る, の(かな1)=捨てる, レビュー(カナ4)=残る
    expect(tokenizeForFts("契約書のレビュー")).toEqual(["契約書", "レビュー"]);
  });
});

// ============================================================
// search()（非ハイブリッド・実FTS経路）
// ============================================================

describe("B1-jp2char: 2文字漢字語の検索漏れ（search）", () => {
  let tmpDir: string;
  let storage: SQLiteStorage;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-jp2char-"));
    storage = new SQLiteStorage(join(tmpDir, "test.db"));
    storage.initialize();
  });
  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("業務意図: 2文字漢字語しか手がかりが無い自然文クエリでも、その語を含む記憶が見つかる", () => {
    storage.save({
      category: "config",
      title: "四半期決算の数値確認",
      content: "決算グラフを誤読しないよう数値を三重確認する注意",
    });
    // 「決算」以外に3文字以上の一致語が無いクエリ。長さ9でFTS経路に入るが、trigramは
    // 2文字語を1件も一致させられず、未修正では0件になる（=このバグ）。修正後はLIKE救済で拾う。
    const result = storage.search({ query: "決算とは何かを確認" });
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.results.some((r) => r.title.includes("決算"))).toBe(true);
    expect(result.totalCount).toBeGreaterThanOrEqual(1);
  });

  it("業務意図: 2文字カタカナ語（バグ等）も同様に拾える", () => {
    storage.save({ category: "config", title: "既知のバグ一覧", content: "起動時のバグを暫定回避する手順" });
    const result = storage.search({ query: "バグって何" }); // バグ(カナ2)のみが手がかり
    expect(result.results.some((r) => r.title.includes("バグ"))).toBe(true);
  });

  it("業務安全: 3文字以上でFTSがヒットする既存クエリは救済を発火させず結果に出る", () => {
    storage.save({ category: "config", title: "導入手順ガイド", content: "導入手順を丁寧に説明する。導入手順が重要。" });
    const result = storage.search({ query: "導入手順" });
    // FTSが正常ヒット → 短語救済に落ちない（従来どおり）
    expect(result.results.some((r) => r.title.includes("導入手順"))).toBe(true);
  });

  it("業務安全: FTSが非空のクエリでは救済が発火せず、同クエリ内の2文字語で別記憶を巻き込まない", () => {
    // 導入手順(3文字+)でFTSがヒットする記憶Aと、決算(2文字)しか一致しない記憶B。
    const a = storage.save({ category: "config", title: "導入手順ガイド", content: "導入手順を詳しく説明する導入手順の資料" });
    const b = storage.save({ category: "config", title: "決算の注意メモ", content: "決算グラフの誤読に注意" });
    // 「導入手順と決算」→ 導入手順(FTS一致)でrowsが非空 → rows.length===0ゲートが救済を止める。
    // その結果、クエリに「決算」が含まれていてもBは巻き込まれない（既存の非空結果を不変に保つ安全性）。
    const result = storage.search({ query: "導入手順と決算" });
    const ids = result.results.map((r) => r.id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
  });

  it("業務安全: 手がかりが1文字漢字/ひらがな/英数字のみのクエリは誤救済しない（無関係な記憶を拾わない）", () => {
    storage.save({ category: "config", title: "全く無関係なメモ", content: "これは検索対象外にしたい内容" });
    // 「とは」「AB」「何」「か」だけ→ extractShortCjkTokens=[] → 救済も発火せず、無関係記憶は出ない
    const result = storage.search({ query: "とはABと何か" });
    expect(result.results.some((r) => r.title.includes("無関係"))).toBe(false);
  });

  it("業務意図: project フィルタが短語救済経路でも効く（別projectの同語記憶を返さない）", () => {
    storage.save({ category: "config", title: "config側の決算メモ", content: "決算の設定を控える", project: "projA" });
    storage.save({ category: "config", title: "別プロジェクトの決算メモ", content: "決算の教訓を控える", project: "projB" });
    const result = storage.search({ query: "決算とは", project: "projA" });
    expect(result.results.some((r) => r.title.includes("config側"))).toBe(true);
    expect(result.results.every((r) => !r.title.includes("別プロジェクト"))).toBe(true);
  });
});

// ============================================================
// searchHybrid()（B1-additive: ハイブリッド救済は純加算・並び替えゼロ）
//
// 是正要件: (1)ベクトル/FTSの融合結果を先に確定 → (2)救済(2文字CJK語のLIKE)で得たIDのうち
// 融合結果に含まれないnet-newだけを末尾へ timestamp DESC で limit まで追補 → (3)融合結果に既に
// 在るIDには触れない(2つ目のRRF項を与えず順位も動かさない) → (4)救済はcomputeRrfScoresの入力を
// 書き換えない。旧実装（救済IDを ftsRankedIds へ注入しRRF加点）は「字面が意味に勝つ」再発のため不可。
// ============================================================

describe("B1-additive ハイブリッド救済（純加算・並び替えゼロ）", () => {
  let tmpDir: string;
  let storage: SQLiteStorage;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-jp2char-hy-"));
    storage = new SQLiteStorage(join(tmpDir, "test.db"));
    storage.initialize();
  });
  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // (a) recall — ベクトルが limit 未満しか返さない状況で、2文字語しか手がかりの無いnet-new記憶が
  //     空きスロットへ浮上する。救済を無効化すると target が消えて赤になる真の弁別器。
  it("(a) recall: ベクトルがlimit未満しか埋めない時、2文字語だけが手がかりのnet-new記憶が空きスロットへ純加算で浮上する", () => {
    // ベクトルpoolを2件だけ埋める（クエリ方向に近い・「決算」を一切含まない）。dim1で距離を離し順序を確定。
    const d0 = storage.save({ category: "config", title: "無縁メモ0", content: "決め手と無縁の雑談その0" });
    storage.upsertVector(d0.id, makeVector({ 0: 1.0 }));
    const d1 = storage.save({ category: "config", title: "無縁メモ1", content: "決め手と無縁の雑談その1" });
    storage.upsertVector(d1.id, makeVector({ 0: 1.0, 1: 0.1 }));

    // 本命: 「決算」(2文字)だけが手がかり。ベクトルを付けない＝ベクトルpoolに居ないnet-new記憶。
    const target = storage.save({ category: "config", title: "決算の注意メモ", content: "決算グラフの誤読に注意する" });

    // FTSは phrase のみで空振り（tokenizeForFts("決算とは何か")=[]）。ベクトルarmはd0/d1の2件のみで
    // 既定limit=5に3スロット空く。救済は融合結果[d0,d1]を1件も動かさず、net-new(target)を末尾へ追補する。
    const result = storage.searchHybrid({ query: "決算とは何か" }, makeVector({ 0: 1.0 }));
    expect(result.results.map((r) => r.id)).toEqual([d0.id, d1.id, target.id]);
  });

  // (b) no-displacement — ベクトルが limit 個の強一致で埋まり、その中の1件が2文字LIKEにも一致する状況で、
  //     救済ありでも上位 limit の顔ぶれと順序が不変。旧RRF注入実装なら m2 が押し上がって赤になる弁別器。
  it("(b) no-displacement: ベクトルがlimit個の強一致で埋まりその1件が2文字LIKEにも一致しても、上位limitの顔ぶれと順序が不変", () => {
    // ベクトルpoolを5件で満たす。dim1で距離を単調に離し、近傍順 m0<m1<m2<m3<m4 を確定させる。
    const m0 = storage.save({ category: "config", title: "強一致0", content: "決算に無縁な資料メモその0" });
    storage.upsertVector(m0.id, makeVector({ 0: 1.0 }));
    const m1 = storage.save({ category: "config", title: "強一致1", content: "決算に無縁な資料メモその1" });
    storage.upsertVector(m1.id, makeVector({ 0: 1.0, 1: 0.1 }));
    // m2 は融合結果の一員でありながら「決算」(2文字)にも一致する＝旧RRF注入なら先頭へ押し上がる弁別点。
    const m2 = storage.save({ category: "config", title: "強一致2", content: "決算を含む資料メモその2" });
    storage.upsertVector(m2.id, makeVector({ 0: 1.0, 1: 0.2 }));
    const m3 = storage.save({ category: "config", title: "強一致3", content: "無縁な資料メモその3" });
    storage.upsertVector(m3.id, makeVector({ 0: 1.0, 1: 0.3 }));
    const m4 = storage.save({ category: "config", title: "強一致4", content: "無縁な資料メモその4" });
    storage.upsertVector(m4.id, makeVector({ 0: 1.0, 1: 0.4 }));

    // FTSは空振り（決算とは何か→tokenizeForFts=[]）。ベクトルarmが5件で上位limit=5を満たす。空きスロットが
    // 無いため純加算救済は発火せず、m2は「決算」に一致してもベクトル順位(index2)から一切動かない。
    const result = storage.searchHybrid({ query: "決算とは何か" }, makeVector({ 0: 1.0 }));
    expect(result.results.map((r) => r.id)).toEqual([m0.id, m1.id, m2.id, m3.id, m4.id]);
  });

  // (c) ガード負側 — 3文字以上でFTSヒットするクエリでは救済不発火。FTS空振りゲートを外すと、クエリ内の
  //     2文字語(バグ/確認)で別記憶bが空きスロットへ巻き込まれて赤になる真の弁別器。
  it("(c) ガード負側: 3文字以上でFTSがヒットするクエリでは救済が不発火し、2文字語だけの別記憶を巻き込まない", () => {
    // FTSでヒットする本命a（契約書=3文字）。ベクトルも付けて確実に結果へ入れる。
    const a = storage.save({ category: "config", title: "契約書レビュー手順", content: "契約書のレビュー手順を確認する" });
    storage.upsertVector(a.id, makeVector({ 0: 1.0 }));
    // 「バグ」(2文字)だけに一致する別記憶b。ベクトルは付けない＝救済が発火した時だけ浮上し得る。
    const b = storage.save({ category: "config", title: "既知のバグ", content: "起動時のバグを暫定回避する" });

    // 「契約書のバグ確認」→ 契約書(3文字)でFTSヒット → staged非空 → 救済ゲートが閉じ、クエリ内の
    // 「バグ」「確認」(2文字)でのLIKE救済は発火しない → bは巻き込まれない（融合結果はaのみで空きが在っても）。
    const result = storage.searchHybrid({ query: "契約書のバグ確認" }, makeVector({ 0: 1.0 }));
    const ids = result.results.map((r) => r.id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
  });
});
