/**
 * 忘却（長期未参照の退避）の dry-run 判定。
 *
 * 【この関数は読み取り専用（SELECT のみ）】記憶レコードの archive/delete/update は一切しない。
 * 「もし窓（windowDays）より古い＝長期未参照の行を忘却候補にしたら何件・どの id か」を算出して
 * 返すだけの純粋関数で、実際の退避（state 変更や物理削除）は別増分（追記型再設計）まで実装しない。
 * 夜間統合 dry-run（consolidate-all）が本判定を呼び、結果をレポート JSON へ記録する用途を想定する。
 *
 * 【最終参照シグナルの所在（GroundTruth）】
 * cap-sweep.ts の JSDoc が記していた「忘却の最終参照配線が未整備（アクセス時刻が埋め込みを持つ行の
 * vector_metadata にしか無く、埋め込みの無い記憶では参照追跡が無音の no-op になる）」という先送りは
 * 本増分で解消した。memories 本体に last_read_at 列（schema v8、埋め込みの有無に依存しない）を敷き、
 * 真の読取経路（get_detail の明示取得・get_context の config/dont 自動注入）でのみ datetime('now') を
 * 刻む。memory_search（search.ts:87-91）は「読み取り副作用ゼロ」の既存設計原則に従い刻まない。
 *
 * 【移行直後の欠損（never_tracked）の扱い】
 * schema v8 適用直後は既存行が軒並み last_read_at=NULL になる。これをそのまま「NULL＝即忘却候補」に
 * すると、cap dry-run が遡及適用で大量的中したのと同型の破局的アラームになる。よって参照時刻は
 * COALESCE(last_read_at, updated_at) とし、last_read_at が NULL の行は updated_at へフォールバックする。
 * フォールバックした候補には never_tracked を立て、レポート側で neverTrackedCount として集計する。
 * これにより、どこまでが実測の最終読取時刻に基づく候補で、どこまでが移行直後の代理指標（updated_at
 * ベース）かを、欠損情報としてオーナーに見せる。
 *
 * 参照カラムの所在（GroundTruth 実地確定）:
 * - state / category / id / updated_at は memories 本体（schema.ts）に実在し WHERE/ORDER BY に直接使える。
 * - last_read_at は schema v8 で追加した memories 本体の列。NULL 許容（未計測を表す）。
 */

import type Database from "better-sqlite3";

/** 長期未参照による忘却候補（1カテゴリぶん）。 */
export interface ForgettingSweepCandidate {
  /** カテゴリ名 */
  category: string;
  /** そのカテゴリの active 行数 */
  activeCount: number;
  /** 適用した忘却窓（日数）。この日数より古い参照時刻の行を候補にする。 */
  windowDays: number;
  /** 忘却候補件数 */
  candidateCount: number;
  /**
   * 候補のうち last_read_at が NULL で updated_at へフォールバックした件数（移行直後の代理指標）。
   * candidateCount のうちこの件数ぶんは実測の最終読取時刻ではなく updated_at ベースの推定である。
   */
  neverTrackedCount: number;
  /** 忘却候補の id（参照時刻昇順 → id 昇順の決定論的順序） */
  candidateIds: string[];
}

/**
 * 忘却（長期未参照）の dry-run 判定（読み取り専用）。
 *
 * 各カテゴリの active 行のうち、参照時刻 COALESCE(last_read_at, updated_at) が
 * 「現在時刻 − windowDays 日」より古い行を忘却候補として列挙する。返すのは候補が
 * 発生したカテゴリ（candidateCount > 0）のみで、候補0件のカテゴリは配列に含めない
 * （cap-sweep.ts と同じ「退避が発生する面だけ載せる」方針）。
 *
 * category が 'config'（設定）/ 'dont'（失敗の教訓）の行は忘却対象外（保護種別）として、
 * 非参照でも候補の集計・列挙から一切除外する（SQL の WHERE で除去）。設定と失敗の教訓は
 * 永続保持すべきで、長期未参照でも退避対象にしない。
 *
 * windowDays <= 0 は「忘却無効」として空配列を返す（cap-sweep.ts の capPerCategory<=0 と同じ約束）。
 *
 * 並び順の根拠:
 * - 参照時刻 昇順: 最も長く参照されていない（最も古い）記憶を先頭に置く（忘却の優先度順）。
 * - id 昇順: 最終タイブレーク。id は base36 ミリ秒プレフィックス+乱数のため辞書順昇順が
 *   実質作成順の決定論的タイブレークになる（cap-sweep.ts と同じ根拠）。
 *
 * 破壊的操作（state 変更・削除）はこの関数からは一切呼ばない。
 */
export function computeForgettingSweep(
  db: Database.Database,
  windowDays: number,
): ForgettingSweepCandidate[] {
  if (windowDays <= 0) {
    return [];
  }

  // config（設定）/ dont（失敗の教訓）は永続保持すべき保護種別。非参照でも忘却対象にしないため、
  // 候補の集計・列挙の起点（このカテゴリ抽出）から除外する。ここで外せば以下のループにも現れない。
  const categories = db
    .prepare(
      "SELECT category, COUNT(*) as cnt FROM memories WHERE state = 'active' AND category NOT IN ('config', 'dont') GROUP BY category",
    )
    .all() as { category: string; cnt: number }[];

  const result: ForgettingSweepCandidate[] = [];

  for (const { category, cnt } of categories) {
    const rows = db
      .prepare(
        `SELECT m.id AS id, (m.last_read_at IS NULL) AS never_tracked
         FROM memories m
         WHERE m.state = 'active' AND m.category = ?
           AND COALESCE(m.last_read_at, m.updated_at) < datetime('now', '-' || ? || ' days')
         ORDER BY COALESCE(m.last_read_at, m.updated_at) ASC, m.id ASC`,
      )
      .all(category, windowDays) as { id: string; never_tracked: number }[];

    if (rows.length === 0) {
      continue;
    }

    result.push({
      category,
      activeCount: cnt,
      windowDays,
      candidateCount: rows.length,
      neverTrackedCount: rows.filter((r) => r.never_tracked === 1).length,
      candidateIds: rows.map((r) => r.id),
    });
  }

  return result;
}
