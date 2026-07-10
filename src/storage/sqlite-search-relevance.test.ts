import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  SQLiteStorage,
  tokenizeForFts,
  computeRrfScores,
  SEARCH_CANDIDATE_POOL,
  buildFtsFallbackStages,
  computeAgeDays,
  computeTimeDecay,
} from "./sqlite.js";

// 可観測性カウンタ（counters.ts）のJSONL追記はfire-and-forget（非同期I/O）のため、
// search()/searchHybrid()の同期呼び出し直後には書き込みが完了していないことがある。
// ディスク上に反映されるまで短時間ポーリングする（G2検証ゲート項目5「fallback-counters」用）。
async function readCountersLogWithRetry(memoryPath: string, timeoutMs = 500): Promise<string> {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const datePart = jst.toISOString().slice(0, 10);
  const logPath = join(memoryPath, "logs", `counters-${datePart}.jsonl`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(logPath)) {
      const content = readFileSync(logPath, "utf-8");
      if (content.trim().length > 0) return content;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";
}

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

// escapeFtsQuery（単一フレーズをORで結合するだけの旧実装）はbuildFtsFallbackStages
// （フレーズ→AND→OR段、OR段は等価な式を生成する）に統合され、design.md Phase2定義1の
// 段階フォールバックへ一本化した（旧実装は削除・呼び出し元なし）。テストはbuildFtsFallbackStages
// のdescribeブロックへ移設済み（OR段の式構築ロジックはそちらで検証する）。

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

// ============================================================
// 段階フォールバック（design.md Phase2定義1: フレーズ→AND→OR）
// ============================================================

describe("buildFtsFallbackStages（純粋関数）", () => {
  it("トークンが複数ある場合、フレーズ→AND→ORの3段を順に返す", () => {
    const stages = buildFtsFallbackStages("決め手キーワード 検索性能");
    expect(stages.map((s) => s.stage)).toEqual(["phrase", "and", "or"]);
    // フレーズ段はクエリ全体の連続一致を要求する（トークン結合ではなく原文そのもの）
    expect(stages[0].matchExpr).toBe('"決め手キーワード 検索性能"');
    expect(stages[1].matchExpr).toContain(" AND ");
    expect(stages[2].matchExpr).toContain(" OR ");
  });

  it("トークンが1個だけの場合はAND段を省く（OR段と同一結果になり無意味なため）フレーズ→ORの2段", () => {
    const stages = buildFtsFallbackStages("データベース");
    expect(stages.map((s) => s.stage)).toEqual(["phrase", "or"]);
  });

  it("有効な語が0個の場合はフレーズ段（クエリ全体の1フレーズ化）のみを返す", () => {
    const stages = buildFtsFallbackStages("a-b-c");
    expect(stages.map((s) => s.stage)).toEqual(["phrase"]);
    expect(stages[0].matchExpr).toBe('"a-b-c"');
  });

  it("ダブルクォートを含むクエリはフレーズ段・AND/OR段のいずれもエスケープされる", () => {
    const stages = buildFtsFallbackStages('データベース"注入 検索性能"攻撃');
    for (const { matchExpr } of stages) {
      expect(matchExpr).not.toContain('データベース"注入');
    }
  });
});

describe("SQLiteStorage - 段階フォールバック（業務意図: 厳しい段を優先し、無ければ緩い段へ落ちる）", () => {
  let storage: SQLiteStorage;
  let tmpDir: string;
  let memoryPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-fallback-test-"));
    // recordWriteFailure等と同じ規約でmemoryPath=dirname(dbPath)になるよう、
    // dbPathをtmpDir直下に置く（tmpDirはmkdtempSyncが既に作成済みのディレクトリ）。
    memoryPath = tmpDir;
    storage = new SQLiteStorage(join(memoryPath, "test.db"));
    storage.initialize();
  });

  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("業務意図: クエリ全体が連続する部分文字列として存在すれば、フレーズ段の結果が採用される（AND/OR段の誤ヒットを混ぜない）", async () => {
    // クエリ全体「導入手順の詳細」がそのまま連続して現れるエントリ（フレーズ段でヒット）
    const exact = storage.save({
      category: "config",
      title: "導入手順の詳細ガイド",
      content: "導入手順の詳細を丁寧に説明する資料",
    });
    // 個々の語は含むが、クエリ全体の連続一致はしない decoy（AND/OR段でしかヒットしない）
    const decoy = storage.save({
      category: "config",
      title: "別件メモ",
      content: "導入は完了した。手順書は別途、詳細は次回共有する。",
    });

    const result = storage.search({ query: "導入手順の詳細" });
    const ids = result.results.map((r) => r.id);

    expect(ids).toContain(exact.id);
    // フレーズ段で採用されるため、decoy（フレーズ段では0件）は候補に含まれない
    expect(ids).not.toContain(decoy.id);

    const counters = await readCountersLogWithRetry(memoryPath);
    expect(counters).toContain('"metric":"search_fallback_phrase"');
  });

  it("業務意図: フレーズ段が0件でも、トークンが全て個別に存在すればAND段で拾える（OR段の雑音混入より精度が高い）", async () => {
    // クエリ全体の連続一致（フレーズ段）はしないが、2語("keywordAlpha"と"keywordBeta")が
    // どちらも別々の位置に存在する（AND段でヒットする）
    const bothTokens = storage.save({
      category: "config",
      title: "検索候補メモ",
      content: "この記憶にはkeywordAlphaという識別子が含まれ、別の話題としてkeywordBetaにも触れる",
    });
    // 片方の語（keywordBeta）しか含まないdecoy（AND段では0件、OR段でのみヒットする）。
    // 「keywordAlphaには触れない」等の否定文でも書かない＝decoyの本文にkeywordAlphaという
    // 部分文字列を一切含めない（含めるとtrigram一致してしまいAND段でも拾われてしまうため）。
    const onlyOneToken = storage.save({
      category: "config",
      title: "無関係メモ",
      content: "この記憶はkeywordBetaについてだけ書いてあり、他の識別子には触れていない",
    });

    const result = storage.search({ query: "keywordAlpha keywordBeta" });
    const ids = result.results.map((r) => r.id);

    expect(ids).toContain(bothTokens.id);
    // AND段が採用されるため、片方の語しか無いdecoyは候補に含まれない
    expect(ids).not.toContain(onlyOneToken.id);

    const counters = await readCountersLogWithRetry(memoryPath);
    expect(counters).toContain('"metric":"search_fallback_and"');
  });

  it("業務意図: フレーズ・AND段がどちらも0件のときだけOR段（現行既定＝いずれかの語が一致）まで落ちる", async () => {
    // "termGamma"のみを含み"termDelta"は一切含まない＝フレーズ段・AND段はどちらも0件になり、
    // OR段（いずれかの語が一致）まで落ちて初めて拾われる
    const partialMatch = storage.save({
      category: "config",
      title: "検索候補メモ",
      content: "このメモにはtermGammaという語だけが登場し、別語には触れない",
    });

    const result = storage.search({ query: "termGamma termDelta" });
    const ids = result.results.map((r) => r.id);
    expect(ids).toContain(partialMatch.id);

    const counters = await readCountersLogWithRetry(memoryPath);
    expect(counters).toContain('"metric":"search_fallback_or"');
  });

  it("業務意図: searchHybridでもFTS候補プールの段階フォールバックが働く（フレーズ段優先）", () => {
    const exact = storage.save({
      category: "config",
      title: "決め手キーワード連呼テスト",
      content: "決め手キーワード 決め手キーワード 決め手キーワード",
    });
    storage.upsertVector(exact.id, makeVector({ 200: 1.0 }));

    const decoy = storage.save({
      category: "config",
      title: "無関係メモ",
      content: "決め手は特に無いが、キーワードという言葉だけは登場する雑談",
    });
    storage.upsertVector(decoy.id, makeVector({ 201: 1.0 }));

    const result = storage.searchHybrid(
      { query: "決め手キーワード" },
      makeVector({ 300: 1.0 })
    );
    const ids = result.results.map((r) => r.id);
    expect(ids).toContain(exact.id);
  });
});

// ============================================================
// 時間減衰（design.md Phase2定義4: finalScore = rrfScore × 0.5^(ageDays/H)）
// ============================================================

describe("computeAgeDays / computeTimeDecay（純粋関数）", () => {
  it("computeAgeDaysはtimestampからnowまでの経過日数を返す", () => {
    const now = new Date("2026-07-11T00:00:00+09:00").getTime();
    const timestamp = new Date("2026-07-01T00:00:00+09:00").toISOString();
    expect(computeAgeDays(timestamp, now)).toBeCloseTo(10, 1);
  });

  it("computeAgeDaysは未来timestampでも負値を返さない（0床）", () => {
    const now = new Date("2026-07-01T00:00:00+09:00").getTime();
    const timestamp = new Date("2026-07-11T00:00:00+09:00").toISOString();
    expect(computeAgeDays(timestamp, now)).toBe(0);
  });

  it("computeTimeDecayはageDays=0で1.0を返す", () => {
    expect(computeTimeDecay(0)).toBeCloseTo(1.0, 10);
  });

  it("computeTimeDecayは半減期(既定90日)経過でちょうど0.5になる", () => {
    expect(computeTimeDecay(90)).toBeCloseTo(0.5, 10);
  });

  it("computeTimeDecayは半減期の2倍経過で0.25になる（指数減衰）", () => {
    expect(computeTimeDecay(180)).toBeCloseTo(0.25, 10);
  });

  it("computeTimeDecayはhalfLifeDaysを明示指定できる", () => {
    expect(computeTimeDecay(7, 7)).toBeCloseTo(0.5, 10);
  });
});

describe("SQLiteStorage - searchHybridの時間減衰（業務意図: 同程度の一致度なら新しいエントリが優先される）", () => {
  let storage: SQLiteStorage;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-decay-test-"));
    storage = new SQLiteStorage(join(tmpDir, "test.db"));
    storage.initialize();
  });

  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("業務意図: ベクトル一致順位がわずかに劣っていても、大幅に新しいエントリはRRF単独順位を時間減衰で逆転できる", () => {
    // FTSは一切ヒットしない語（検索クエリと無関係な保存内容にする）でベクトルのみの純粋な
    // RRF順位差を作る。oldEntryをベクトル距離最小（KNN 1位）、newEntryを僅差の2位にする。
    const oldEntry = storage.save({
      category: "config",
      title: "古いエントリ",
      content: "検索クエリの語とは無関係な保存内容その1",
    });
    storage.upsertVector(oldEntry.id, makeVector({ 0: 1.0 }));

    const newEntry = storage.save({
      category: "config",
      title: "新しいエントリ",
      content: "検索クエリの語とは無関係な保存内容その2",
    });
    storage.upsertVector(newEntry.id, makeVector({ 0: 0.99, 1: 0.01 }));

    // 保存直後はtimestampがほぼ同時刻のため、DB上のtimestampを直接書き換えて
    // 「oldEntryは365日前、newEntryは1日前」という経過日数差を作る（timeDecayの効果を検証するため）。
    const db = (storage as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }).db;
    const oldTs = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    const newTs = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE memories SET timestamp = ? WHERE id = ?").run(oldTs, oldEntry.id);
    db.prepare("UPDATE memories SET timestamp = ? WHERE id = ?").run(newTs, newEntry.id);

    // クエリはFTSに一切ヒットしない語にし、RRFへの寄与をベクトル順位のみにする
    const result = storage.searchHybrid(
      { query: "xyz非該当クエリ" },
      makeVector({ 0: 1.0 })
    );
    const ids = result.results.map((r) => r.id);

    // oldEntryはベクトルKNNで1位（newEntryよりRRFスコアがわずかに高い）だが、
    // 365日 vs 1日という大幅な経過日数差により時間減衰後は逆転し、newEntryが上位に来る。
    expect(ids.indexOf(newEntry.id)).toBeLessThan(ids.indexOf(oldEntry.id));
  });
});
