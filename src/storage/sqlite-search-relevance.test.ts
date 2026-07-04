import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  SQLiteStorage,
  tokenizeForFts,
  escapeFtsQuery,
  computeRrfScores,
  SEARCH_CANDIDATE_POOL,
} from "./sqlite.js";

function makeVector(values: Record<number, number>): number[] {
  const vec = new Array(384).fill(0);
  for (const [idx, val] of Object.entries(values)) {
    vec[Number(idx)] = val;
  }
  return vec;
}

// ============================================================
// 純粋関数の単体テスト（DB不要）
// ============================================================

describe("tokenizeForFts", () => {
  it("ひらがな連続・カタカナ連続・漢字連続・英数字連続をそれぞれ1語として拾う", () => {
    // 漢字は3文字以上の複合語（記憶装置・検索性能・初期問題）で検証する
    // （「記憶」のような2文字複合語は3文字未満フィルタで別途除外される仕様のため）
    const tokens = tokenizeForFts("wasurenagusaの記憶装置ストアの検索性能がうまくいかない初期問題");
    expect(tokens).toContain("wasurenagusa");
    expect(tokens).toContain("ストア");
    // 「が」+「うまくいかない」はどちらもひらがなで連続するため1語にまとまる
    expect(tokens).toContain("がうまくいかない");
    // スクリプトが変わる箇所（漢字→カタカナ・カタカナ→ひらがな等）で語が分かれている
    expect(tokens).toContain("記憶装置");
    expect(tokens).toContain("検索性能");
    expect(tokens).toContain("初期問題");
  });

  it("3文字未満の語は捨てる（trigramトークナイザは3文字未満を絶対にマッチさせないため）", () => {
    // "AB" (2文字alnum) は捨てられ、"検索性能"(4文字kanji)だけが残る
    const tokens = tokenizeForFts("AB検索性能");
    expect(tokens).not.toContain("AB");
    expect(tokens).toContain("検索性能");
  });

  it("記号は語の区切りとして扱われ、語そのものには含まれない。スクリプトが変わる境界（漢字→カタカナ等）でも語が分かれる", () => {
    const tokens = tokenizeForFts("design-system表現ティア増築");
    expect(tokens).not.toContain("design-system表現ティア増築");
    expect(tokens).toContain("design");
    expect(tokens).toContain("system");
    expect(tokens).toContain("ティア");
    // 「表現」「増築」は2文字の漢字連続で3文字未満のため候補から除外される
    expect(tokens).not.toContain("表現");
    expect(tokens).not.toContain("増築");
  });

  it("有効な語が1つも無ければ空配列を返す", () => {
    // 全て記号 or 3文字未満の語のみ
    const tokens = tokenizeForFts("a-b-c");
    expect(tokens).toEqual([]);
  });
});

describe("escapeFtsQuery", () => {
  it("トークンが複数ある場合、二重引用したフレーズをORで結合したMATCH式を作る", () => {
    const result = escapeFtsQuery("wasurenagusaの記憶ストアの検索がうまくいかない問題");
    expect(result).toContain(" OR ");
    expect(result).toContain('"wasurenagusa"');
    expect(result).toContain('"ストア"');
    // クエリ全体を1フレーズにするフレーズ化（旧実装）にはなっていない
    expect(result).not.toBe(`"wasurenagusaの記憶ストアの検索がうまくいかない問題"`);
  });

  it("トークンが1個だけの場合はORを使わずそのフレーズのみを返す", () => {
    const result = escapeFtsQuery("データベース");
    expect(result).toBe('"データベース"');
  });

  it("トークンが0個（フォールバック条件）の場合は従来通りクエリ全体を1フレーズにする", () => {
    const result = escapeFtsQuery("a-b-c");
    expect(result).toBe('"a-b-c"');
  });

  it("ダブルクォートを含む語はエスケープされる", () => {
    const result = escapeFtsQuery('データベース"注入');
    // 各トークン内の " は "" にエスケープされる
    expect(result).not.toContain('データベース"注入');
  });
});

describe("computeRrfScores", () => {
  it("両方のリストに出現するIDは両方の順位分のスコアが加算される（単一リストのみのIDより高スコアになる）", () => {
    const scores = computeRrfScores([
      ["both", "fts-only"],   // bothは0位、fts-onlyは1位
      ["both", "vector-only"], // bothは0位、vector-onlyは1位
    ]);
    // both: 1/(60+0) [リスト1] + 1/(60+0) [リスト2] = 2 * (1/60)
    expect(scores.get("both")).toBeCloseTo(2 * (1 / 60), 10);
    // fts-onlyはリスト1の1位分のみ = 1/61（リスト2に出ていない分は加算されない）
    expect(scores.get("fts-only")).toBeCloseTo(1 / 61, 10);
    expect(scores.get("vector-only")).toBeCloseTo(1 / 61, 10);
    // 両方のリストに出たIDは、どちらか一方にしか出ていないIDより明確に高スコア
    expect(scores.get("both")!).toBeGreaterThan(scores.get("fts-only")!);
    expect(scores.get("both")!).toBeGreaterThan(scores.get("vector-only")!);
  });

  it("片方のリストにしか出現しないIDは、出現したリストの項のみが加算される（満点付与しない）", () => {
    const scores = computeRrfScores([
      ["only-in-fts"],
      ["only-in-vector"],
    ]);
    // only-in-fts: リスト1の0位分のみ = 1/60
    expect(scores.get("only-in-fts")).toBeCloseTo(1 / 60, 10);
    // only-in-vector: リスト2の0位分のみ = 1/60（リスト1に出ていない分の加算は無い）
    expect(scores.get("only-in-vector")).toBeCloseTo(1 / 60, 10);
    // 両方に出現したIDと違って、単一リスト分のスコアしか持たない
    const bothScores = computeRrfScores([["x"], ["x"]]);
    expect(bothScores.get("x")).toBeGreaterThan(scores.get("only-in-fts")!);
  });

  it("順位が下がるほどスコアは単調に下がる", () => {
    const scores = computeRrfScores([["first", "second", "third"]]);
    expect(scores.get("first")!).toBeGreaterThan(scores.get("second")!);
    expect(scores.get("second")!).toBeGreaterThan(scores.get("third")!);
  });

  it("空リストの組では空のMapを返す", () => {
    const scores = computeRrfScores([[], []]);
    expect(scores.size).toBe(0);
  });
});

// ============================================================
// SQLiteStorage統合: 実DB(FTS5 trigram + vec0)での業務挙動検証
// ============================================================

describe("SQLiteStorage - 検索の関連度優先化（自然文recall・RRF統合順位）", () => {
  let storage: SQLiteStorage;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-relevance-test-"));
    storage = new SQLiteStorage(join(tmpDir, "test.db"));
    storage.initialize();
  });

  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("業務意図: 保存内容と一字一句一致しない自然文クエリでも、部分一致する語があればFTS検索で見つかる", () => {
    storage.save({
      category: "config",
      title: "wasurenagusa記憶ストア代謝再建",
      content: "監査で深刻欠陥発見、検索がうまく動かない件について調べてほしい",
    });

    // 旧実装（クエリ全体を1フレーズ化）では、この言い換えクエリは
    // 保存内容と完全一致する部分文字列が無いため0件だった。
    const result = storage.search({
      query: "wasurenagusaの記憶ストアの検索がうまくいかない問題を直したい",
    });

    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.results.some((r) => r.title.includes("wasurenagusa"))).toBe(true);
  });

  it("業務意図: FTS検索結果は関連度（一致の強さ）順に並び、単純な新しい順にはならない", () => {
    // 「導入手順」に強く関連する内容を先に保存（timestampは古い）
    const strongMatch = storage.save({
      category: "config",
      title: "導入手順の詳細ガイド",
      content: "導入手順、導入手順、導入手順を丁寧に説明する。導入手順が重要。",
    });

    // わずかにしか関連しない内容を後で保存（timestampは新しい）
    const weakMatch = storage.save({
      category: "config",
      title: "別件の完全に無関係なメモ",
      content: "本件とは別に、末尾でほんの少しだけ導入手順という語に触れる程度。",
    });

    const result = storage.search({ query: "導入手順" });
    const ids = result.results.map((r) => r.id);
    const strongIdx = ids.indexOf(strongMatch.id);
    const weakIdx = ids.indexOf(weakMatch.id);

    expect(strongIdx).toBeGreaterThanOrEqual(0);
    expect(weakIdx).toBeGreaterThanOrEqual(0);
    // timestamp DESC（新しい順）なら weakMatch(新しい)が先に来るはずだが、
    // 関連度順なら繰り返し言及されているstrongMatchが先に来る。
    expect(strongIdx).toBeLessThan(weakIdx);
  });

  it("業務意図: searchHybridはFTSとベクトル両方の順位を合成したスコアで並び、最後にtimestampで並べ直さない", () => {
    // ベクトル的には無関係だが、FTSで最上位に強くヒットするエントリ（timestampは最も古い）
    const ftsWinner = storage.save({
      category: "config",
      title: "決め手キーワード連呼テスト",
      content: "決め手キーワード 決め手キーワード 決め手キーワード",
    });
    storage.upsertVector(ftsWinner.id, makeVector({ 200: 1.0 })); // クエリベクトルから遠い

    // FTSには全くヒットしないが、ベクトル的にクエリと完全一致するエントリ（timestampは最も新しい）
    const vectorWinner = storage.save({
      category: "config",
      title: "無関係なタイトルその2",
      content: "決め手キーワードとは一切関係ない内容",
    });
    storage.upsertVector(vectorWinner.id, makeVector({ 0: 1.0 })); // クエリベクトルと完全一致

    // FTSにもベクトルにもヒットしない、最もtimestampが新しいだけのノイズエントリ
    const noise = storage.save({
      category: "config",
      title: "本当にただの雑談メモ",
      content: "今日の天気の話など、検索クエリと無関係な内容",
    });
    storage.upsertVector(noise.id, makeVector({ 300: 1.0 }));

    const result = storage.searchHybrid(
      { query: "決め手キーワード" },
      makeVector({ 0: 1.0 })
    );

    const ids = result.results.map((r) => r.id);
    // FTS単独トップ・ベクトル単独トップは、timestampの新旧に関わらずどちらも
    // ノイズより上位に来る（=最後にtimestampで並べ直していない証拠）。
    expect(ids.indexOf(ftsWinner.id)).toBeLessThan(ids.indexOf(noise.id));
    expect(ids.indexOf(vectorWinner.id)).toBeLessThan(ids.indexOf(noise.id));
  });

  it("業務意図: 候補プール拡大により、既定limitを超えて埋もれていた強い一致も統合対象に入る", () => {
    // 既定 limit=5 を超える件数、同じ語に強くヒットするエントリを保存する
    const saved = [];
    for (let i = 0; i < 8; i++) {
      const s = storage.save({
        category: "config",
        title: `候補プール検証エントリ${i}`,
        content: "対象キーワード対象キーワード対象キーワード",
      });
      saved.push(s);
    }

    // limitはデフォルト(5)のまま、8件のFTS一致がある状態でsearchHybridを呼ぶ
    const result = storage.searchHybrid(
      { query: "対象キーワード" },
      makeVector({ 123: 1.0 })
    );

    // SEARCH_CANDIDATE_POOL(50) >= 8 なので、8件全てが候補になり得る
    // （totalCountはlimitでは切り捨てられない母集団件数を表す）
    expect(SEARCH_CANDIDATE_POOL).toBeGreaterThanOrEqual(saved.length);
    expect(result.totalCount).toBeGreaterThanOrEqual(saved.length);
  });
});
