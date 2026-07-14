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
import type { SQLiteStorage } from "../storage/sqlite.js";
import { capClusters, DEFAULT_NIGHTLY_CAP } from "./batch-cap.js";

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
  /** candidateIds のうち last_read_at が NULL（updated_at フォールバック＝移行直後の代理指標）だった id。 */
  neverTrackedIds: string[];
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
      neverTrackedIds: rows.filter((r) => r.never_tracked === 1).map((r) => r.id),
    });
  }

  return result;
}

/** 忘却の実退避（archive）結果。物理削除は一切行わず active→archived の論理退避のみ。 */
export interface ForgettingApplyResult {
  /** 適用した忘却窓（日数）。 */
  windowDays: number;
  /** archived へ遷移させた総件数（実際に state が変わった行数）。 */
  archivedCount: number;
  /**
   * archived にした行のうち last_read_at が NULL で updated_at フォールバックだった件数
   * （移行直後の代理指標ベースで退避した件数）。破局的一括退避の可視化用にオーナーへ見せる。
   */
  neverTrackedCount: number;
  /** archived へ遷移させた id（computeForgettingSweep の決定論的順序を保つ）。 */
  archivedIds: string[];
  /** カテゴリ別の退避件数。 */
  perCategory: { category: string; archivedCount: number; neverTrackedCount: number }[];
  /** この晩の退避上限（batch-cap）。この件数を超える候補は今晩は退避せず翌晩へ持ち越す。 */
  nightlyCap: number;
  /** 上限に達して打ち切ったか（true なら deferredCount 件が翌晩へ持ち越し）。 */
  capped: boolean;
  /** 上限超過で今晩は退避しなかった候補件数（翌晩へ持ち越し）。 */
  deferredCount: number;
}

/**
 * 忘却（長期未参照）の実退避。候補行を state='archived' へ遷移させる（論理退避・可逆）。
 *
 * 候補の選定は computeForgettingSweep をそのまま流用し、保護種別（config/dont）除外・
 * windowDays<=0 無効化・COALESCE(last_read_at, updated_at) 判定・決定論的順序を単一の真実源に保つ。
 * 退避は `UPDATE memories SET state='archived' WHERE id=? AND state='active'` のみで、
 * 物理削除（DELETE）も vectors 削除も他カラムの改変も行わない。archived は可視性マトリクス上
 * get_detail で読め（sqlite.ts:604）、SQLiteStorage.restoreArchived で active へ戻せる（可逆）。
 *
 * 退避の生 SQL は storage 層（SQLiteStorage.archiveMemories・可逆な active→archived の論理更新）に
 * 閉じる。ここは「候補選定（読み取り）＋ storage の名前付き退避メソッド呼び出し」だけを担い、
 * 破壊型書き込みプリミティブを consolidator 層へ持ち込まない（severance ガードの層分離と整合）。
 */
export function applyForgettingSweep(
  storage: SQLiteStorage,
  windowDays: number,
  nightlyCap: number = DEFAULT_NIGHTLY_CAP,
): ForgettingApplyResult {
  const candidates = computeForgettingSweep(storage.connection, windowDays);

  // 全カテゴリの候補を決定論的順序（computeForgettingSweep の返却順・各カテゴリ内は参照時刻昇順）で
  // 平坦化し、1晩の退避上限（batch-cap の capClusters）で切る。上限超過分は今晩は退避せず翌晩へ
  // 持ち越す。これで「初回夜間バッチが全プロジェクトの長期未参照記憶を無制限に一括退避する」暴走を
  // 防ぐ（rank3・cap を実書き込み経路へ配線）。cap<=0 は今晩は1件も退避しない（capClusters の約束）。
  const neverTrackedSet = new Set<string>();
  const flat: { id: string; category: string }[] = [];
  for (const cat of candidates) {
    for (const id of cat.neverTrackedIds) {
      neverTrackedSet.add(id);
    }
    for (const id of cat.candidateIds) {
      flat.push({ id, category: cat.category });
    }
  }

  const { toProcess, deferred, capped } = capClusters(flat, nightlyCap);

  const perCategoryMap = new Map<string, { archivedCount: number; neverTrackedCount: number }>();
  const archivedIds: string[] = [];
  let archivedCount = 0;
  let neverTrackedCount = 0;

  for (const { id, category } of toProcess) {
    const archived = storage.archiveMemories([id]);
    if (archived === 0) {
      continue;
    }
    archivedCount += archived;
    archivedIds.push(id);
    const isNeverTracked = neverTrackedSet.has(id);
    if (isNeverTracked) {
      neverTrackedCount += 1;
    }
    const acc = perCategoryMap.get(category) ?? { archivedCount: 0, neverTrackedCount: 0 };
    acc.archivedCount += archived;
    if (isNeverTracked) {
      acc.neverTrackedCount += 1;
    }
    perCategoryMap.set(category, acc);
  }

  // perCategory は候補が発生したカテゴリの並び（computeForgettingSweep の順）で決定論的に並べる。
  const perCategory: { category: string; archivedCount: number; neverTrackedCount: number }[] = [];
  for (const cat of candidates) {
    const acc = perCategoryMap.get(cat.category);
    if (acc) {
      perCategory.push({ category: cat.category, ...acc });
    }
  }

  return {
    windowDays,
    archivedCount,
    neverTrackedCount,
    archivedIds,
    perCategory,
    nightlyCap,
    capped,
    deferredCount: deferred.length,
  };
}
