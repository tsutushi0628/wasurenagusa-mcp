// ============================================================
// 層B（order-diagnostic）合成コーパス構築器
// ============================================================
//
// design-b2b4-golden-eval-harness.md §4「層B: 合成 order-diagnostic 層」／
// design-b2-b4-ranking.md §2.1 に対応する。
//
// 目的: 「正解の順位が構成上あらかじめ判っている」合成シナリオを作り、本番
// searchHybrid が返す融合順位（searchHybrid(...).results の id 列）が期待順に
// 一致することを断定する。B2（融合重み）・B4（時間減衰）の失敗モードを制御された
// 合成データで再現し、現在の順序挙動をピン留めする。将来ここのどれかの本番係数
// （RRF_K / 半減期H / 候補プール / 段重み）が変わると、期待順が崩れて回帰が露見する。
//
// 性格づけ（build-mini-store の禁止に非抵触）: これは recall 等の「検索品質の主張」では
// なく、特定順序挙動の回帰ピン留め＝機構テスト。実値・機密ゼロの合成語のみを使う。
//
// 順位の決まり方（一次情報の要約。抜粋は hybrid-search-fusion-excerpt.md）:
//   finalScore = rrfScore × timeDecay × accessBoost
//     - rrfScore   = Σ 1/(RRF_K + position)（RRF_K=60。FTSリストとベクトルリストの各順位を合算）
//     - timeDecay  = 0.5^(ageDays / 90)（自己検索の完全一致のみ 1.0 に無効化）
//     - accessBoost= min(1.2, 1+0.04×accessCount)。新規保存直後は accessCount=0 → 1.0（全件中立）
//   最終ソートは finalScore 降順、同点のみ timestamp DESC でタイブレーク。
//
// ベクトル距離は vec0 の float[384] L2（ユークリッド）距離。クエリ e0={0:1.0} に対し:
//   V_CLOSE={0:1.0}        → L2距離 0        → ベクトル順位 0（最も関連）
//   V_MID  ={0:0.8, 1:0.6} → L2距離 0.6325   → ベクトル順位 1
//   V_FAR  ={1:1.0}        → L2距離 1.4142   → ベクトル順位 2
// 距離が相異なるためベクトル順位は決定論的。全シナリオで期待順を数値で先に確定できる。

import type { SQLiteStorage } from "./sqlite.js";

/** 384次元スパースベクトルを {index: value} から作る（sqlite-search-relevance.test.ts と同型）。 */
export function makeVector(values: Record<number, number>): number[] {
  const vec = new Array(384).fill(0);
  for (const [idx, val] of Object.entries(values)) {
    vec[Number(idx)] = val;
  }
  return vec;
}

export const QUERY_VEC = makeVector({ 0: 1.0 });
export const V_CLOSE = makeVector({ 0: 1.0 }); // ベクトル順位0（L2距離0）
export const V_MID = makeVector({ 0: 0.8, 1: 0.6 }); // ベクトル順位1（L2距離0.6325）
export const V_FAR = makeVector({ 1: 1.0 }); // ベクトル順位2（L2距離1.4142）

/** B2シナリオでのみ使うFTS一致トークン（trigramで一意に拾える合成ASCII語）。 */
const FTS_ANCHOR = "alphabravocharlie";
/** どのFTS段にも一致しない合成ASCIIクエリ（B4シナリオ用・2文字CJK救済も発火しない）。 */
const FTS_MISS_QUERY = "zzqqxx7";

/** 合成コーパスの1シナリオ。expectedOrder は本番融合順（searchHybrid().results の id 列）の期待値。 */
export interface OrderScenario {
  /** シナリオ識別ラベル（テストのメッセージ用。実値・機密を含まない）。 */
  label: string;
  /** searchHybrid に渡すクエリ文字列。 */
  query: string;
  /** searchHybrid に渡すクエリ埋め込み。 */
  queryVector: number[];
  /** このシナリオが保存した記憶id（順不同）。観測順位の射影に使う。 */
  memberIds: string[];
  /** 構成上あらかじめ判っている本番融合順（この順で返るのが正解）。 */
  expectedOrder: string[];
  /** なぜこの順になるか（finalScore内訳）の説明。回帰時の読み解き用。 */
  rationale: string;
}

/** DB上の timestamp を直接書き換えて「ageDays 日前」に設定する（時間減衰の効果を制御するため）。 */
function setAgeDays(storage: SQLiteStorage, id: string, ageDays: number): void {
  const db = (
    storage as unknown as {
      db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } };
    }
  ).db;
  const ts = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000).toISOString();
  db.prepare("UPDATE memories SET timestamp = ? WHERE id = ?").run(ts, id);
}

function saveWithVector(
  storage: SQLiteStorage,
  title: string,
  content: string,
  vector: number[],
  ageDays: number
): string {
  const { id } = storage.save({ category: "config", title, content });
  storage.upsertVector(id, vector);
  setAgeDays(storage, id, ageDays);
  return id;
}

// ------------------------------------------------------------
// B4シナリオ（時間減衰が主ソート軸）
// ------------------------------------------------------------

/**
 * B4-1（沈み込みモード）: 最も関連度が高い（ベクトル順位0）が古い記憶は、関連度で劣るが
 * 新しい2件の下に沈む。health-audit の「2倍超の関連度優位でも約114日差で新記憶に逆転」を
 * 合成で再現。
 *   relevantOld : V_CLOSE(rank0) rrf=1/60=0.016667, age=200d decay=0.2143 → 0.003572
 *   freshMid    : V_MID(rank1)   rrf=1/61=0.016393, age=1d   decay=0.9923 → 0.016268
 *   freshFar    : V_FAR(rank2)   rrf=1/62=0.016129, age=1d   decay=0.9923 → 0.016006
 * 期待順: [freshMid, freshFar, relevantOld]
 * ピン: 時間減衰を定数化（減衰無効）すると relevantOld が先頭に来て崩れる。
 */
export function buildB4Sink(storage: SQLiteStorage): OrderScenario {
  const relevantOld = saveWithVector(storage, "関連度優位だが古い", "B4沈み込み検証の関連度優位側の合成本文", V_CLOSE, 200);
  const freshMid = saveWithVector(storage, "関連度中位で新しい", "B4沈み込み検証の中位関連度の合成本文", V_MID, 1);
  const freshFar = saveWithVector(storage, "関連度下位で新しい", "B4沈み込み検証の下位関連度の合成本文", V_FAR, 1);
  return {
    label: "B4-1 沈み込みモード（新しさが関連度を上書き）",
    query: FTS_MISS_QUERY,
    queryVector: QUERY_VEC,
    memberIds: [relevantOld, freshMid, freshFar],
    expectedOrder: [freshMid, freshFar, relevantOld],
    rationale:
      "FTS非該当でRRFはベクトル順位のみ。200日減衰(0.214)が関連度優位を打ち消し、1日物の中位>下位>古い関連優位となる。",
  };
}

/**
 * B4-2（同経過日数なら関連度が順序を決める）: 全件を同じ age=1日にすると減衰が同一係数になり、
 * finalScore は rrfScore（=ベクトル順位）だけで決まる。候補プールが関連度で門番されていること
 * （「関連度が順位を一切決めない」わけではない）をピン。
 *   close(rank0) 1/60×0.9923=0.016539 > mid(rank1) 0.016268 > far(rank2) 0.016006
 * 期待順: [close, mid, far]
 */
export function buildB4RecencyTie(storage: SQLiteStorage): OrderScenario {
  const close = saveWithVector(storage, "関連度上位・同新しさ", "B4同経過日数検証の上位関連度の合成本文", V_CLOSE, 1);
  const mid = saveWithVector(storage, "関連度中位・同新しさ", "B4同経過日数検証の中位関連度の合成本文", V_MID, 1);
  const far = saveWithVector(storage, "関連度下位・同新しさ", "B4同経過日数検証の下位関連度の合成本文", V_FAR, 1);
  return {
    label: "B4-2 同経過日数なら関連度が順序を決める",
    query: FTS_MISS_QUERY,
    queryVector: QUERY_VEC,
    memberIds: [close, mid, far],
    expectedOrder: [close, mid, far],
    rationale: "減衰係数が全件同一のため finalScore はベクトル順位（RRF基底）で決まる。",
  };
}

// ------------------------------------------------------------
// B2シナリオ（融合の段品質）
// ------------------------------------------------------------

/**
 * B2-1（二段一致が単段一致に勝つ・減衰予算内）: FTSとベクトルの両方に載る記憶は、片方だけの
 * 新しい記憶より上位（30日程度の減衰なら二段の融合強度が勝つ）。
 *   dual   : FTS(rank0)+V_CLOSE(rank0) rrf=2/60=0.033333, age=30d decay=0.7937 → 0.026457
 *   single : V_MID(rank1)              rrf=1/61=0.016393, age=1d  decay=0.9923 → 0.016268
 * 期待順: [dual, single]
 */
export function buildB2DualBeatsSingle(storage: SQLiteStorage): OrderScenario {
  const dual = saveWithVector(storage, "二段一致（やや古い）", `B2二段一致の合成本文 ${FTS_ANCHOR} を含む`, V_CLOSE, 30);
  const single = saveWithVector(storage, "単段一致（新しい）", "B2単段一致のベクトルのみ合成本文", V_MID, 1);
  return {
    label: "B2-1 二段一致がやや古くても単段一致の新しい記憶に勝つ",
    query: FTS_ANCHOR,
    queryVector: QUERY_VEC,
    memberIds: [dual, single],
    expectedOrder: [dual, single],
    rationale: "dual=FTS+ベクトルでrrf=2/60。30日減衰(0.794)後も 0.0265 > 単段新規 0.0163。",
  };
}

/**
 * B2-2（減衰が二段一致すら沈める限界帯）: 同じ二段一致でも200日経つと、単段だが新しい記憶に
 * 逆転される。B2×B4 相互作用（融合強度が時間減衰に飲まれる帯）をピン。
 *   dual   : rrf=2/60=0.033333, age=200d decay=0.2143 → 0.007144
 *   single : rrf=1/61=0.016393, age=1d   decay=0.9923 → 0.016268
 * 期待順: [single, dual]
 */
export function buildB2DecayFloodsFusion(storage: SQLiteStorage): OrderScenario {
  const dual = saveWithVector(storage, "二段一致（大幅に古い）", `B2限界帯の二段一致の合成本文 ${FTS_ANCHOR} を含む`, V_CLOSE, 200);
  const single = saveWithVector(storage, "単段一致（新しい）", "B2限界帯の単段一致のベクトルのみ合成本文", V_MID, 1);
  return {
    label: "B2-2 二段一致でも大幅に古いと単段の新しい記憶に沈む（限界帯）",
    query: FTS_ANCHOR,
    queryVector: QUERY_VEC,
    memberIds: [dual, single],
    expectedOrder: [single, dual],
    rationale: "dual=2/60でも200日減衰(0.214)で0.0071に沈み、単段新規0.0163に負ける。",
  };
}

/**
 * B2-3（新しさが同点なら融合強度が順序を決める）: dual/single を共に age=1日にすると、
 * 二段一致の rrf 優位（2/60 vs 1/61）がそのまま順序になる。融合の並べ替え底上げをピン。
 *   dual   : rrf=2/60×0.9923=0.033078
 *   single : rrf=1/61×0.9923=0.016268
 * 期待順: [dual, single]
 */
export function buildB2FusionTie(storage: SQLiteStorage): OrderScenario {
  const dual = saveWithVector(storage, "二段一致・同新しさ", `B2同新しさの二段一致の合成本文 ${FTS_ANCHOR} を含む`, V_CLOSE, 1);
  const single = saveWithVector(storage, "単段一致・同新しさ", "B2同新しさの単段一致のベクトルのみ合成本文", V_MID, 1);
  return {
    label: "B2-3 新しさが同点なら二段一致の融合強度が順序を決める",
    query: FTS_ANCHOR,
    queryVector: QUERY_VEC,
    memberIds: [dual, single],
    expectedOrder: [dual, single],
    rationale: "減衰同一のため rrf(2/60 vs 1/61)がそのまま順序になる。",
  };
}

// ------------------------------------------------------------
// 自己検索例外（R-B3）をコーパス内でピン
// ------------------------------------------------------------

/** 自己検索の本文（合成・完全一致でのみ減衰1.0例外が発火する）。 */
const SELF_TEXT = "selfmatch corpus anchor body for exact self retrieval";

/**
 * 自己検索例外: 400日前の古い自己記憶を自身の本文で検索すると、減衰無効化(1.0)例外により
 * 1日物の decoy より上位を保つ。コーパス内での例外の効きをピン。
 *   selfOld: FTS(rank0)+V_CLOSE(rank0) rrf=2/60=0.033333, 例外で decay=1.0 → 0.033333
 *   decoy  : V_MID(rank1)              rrf=1/61=0.016393, age=1d decay=0.9923 → 0.016268
 * 期待順: [selfOld, decoy]
 */
export function buildSelfMatchException(storage: SQLiteStorage): OrderScenario {
  const selfOld = saveWithVector(storage, "古い自己検索対象", SELF_TEXT, V_CLOSE, 400);
  const decoy = saveWithVector(storage, "新しい別内容の競合", "自己検索例外検証の非一致な新しい合成本文", V_MID, 1);
  return {
    label: "自己検索例外（完全一致で古い自己記憶が減衰を免れる）",
    query: SELF_TEXT,
    queryVector: QUERY_VEC,
    memberIds: [selfOld, decoy],
    expectedOrder: [selfOld, decoy],
    rationale: "query=本文の完全一致でselfOldの減衰が1.0に無効化され、400日でも新decoyより上位。",
  };
}

/** 層B全シナリオ（各テストで1シナリオ=1個のクリーンなDBに構築して使う）。 */
export const ORDER_SCENARIO_BUILDERS = [
  buildB4Sink,
  buildB4RecencyTie,
  buildB2DualBeatsSingle,
  buildB2DecayFloodsFusion,
  buildB2FusionTie,
  buildSelfMatchException,
] as const;
