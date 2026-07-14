/**
 * 夜間統合の上限件数と dry-run 経由の再開ガード（memory-redesign Phase 3・タスク3.9／R-A6-4,5）。
 *
 * 初回一括統合を「最大の事故日」にしないため、1晩に処理する統合クラスタ数を上限で止め、超過分は
 * 翌晩へ持ち越す。また書き込みモードへの再開は「直近の dry-run レポートを人間が確認した記録」が
 * ある場合のみ許可する（既定は dry-run のまま。切替は設定でなくコードの明示コミットで行う）。
 *
 * 純関数（DB非依存）。分岐・集計・判定はすべてコード側（LLM不使用）。破壊 SQL を持たない。
 */

/** 1晩に処理する統合クラスタ数の既定上限（design.md「1晩50クラスタ目安」）。*/
export const DEFAULT_NIGHTLY_CAP = 50;

export interface CapResult<T> {
  /** 今晩処理する分（上限まで）。*/
  toProcess: T[];
  /** 上限超過で翌晩へ持ち越す分。*/
  deferred: T[];
  /** 上限に達して打ち切ったか。*/
  capped: boolean;
}

/**
 * 統合候補クラスタを上限で切り、超過分を持ち越しへ回す。cap<=0 は「今晩は処理しない」。
 */
export function capClusters<T>(clusters: T[], cap: number = DEFAULT_NIGHTLY_CAP): CapResult<T> {
  const safeCap = Math.max(0, Math.floor(cap));
  const toProcess = clusters.slice(0, safeCap);
  const deferred = clusters.slice(safeCap);
  return { toProcess, deferred, capped: deferred.length > 0 };
}

/** dry-run レポートの人間確認記録（書き込み再開の前提）。*/
export interface DryRunConfirmation {
  /** 確認済みの dry-run レポート識別子（レポートファイルのハッシュ等）。*/
  reportId: string;
  /** 人間が確認した時刻（ISO）。*/
  confirmedAt: string;
  /** 確認者（人間）。空不可。*/
  confirmedBy: string;
}

export interface ResumeDecision {
  allowed: boolean;
  reason: string;
}

/**
 * 書き込みモードへの再開可否を判定する。直近の dry-run レポートに対する人間確認記録が
 * 揃っている場合のみ許可する。記録が無い/reportId 不一致/確認者空 は拒否（既定は dry-run 継続）。
 *
 * @param latestReportId 直近に生成された dry-run レポートの識別子
 * @param confirmation その確認記録（未確認なら null）
 */
export function canResumeWrite(
  latestReportId: string,
  confirmation: DryRunConfirmation | null,
): ResumeDecision {
  if (!confirmation) {
    return { allowed: false, reason: "dry-runレポートの確認記録が無い（既定のdry-run継続）" };
  }
  if (confirmation.reportId !== latestReportId) {
    return { allowed: false, reason: "確認記録が直近のdry-runレポートと不一致（再確認が必要）" };
  }
  if (!confirmation.confirmedBy || confirmation.confirmedBy.trim().length === 0) {
    return { allowed: false, reason: "確認者が空（人間確認の証跡が不十分）" };
  }
  if (!confirmation.confirmedAt || Number.isNaN(Date.parse(confirmation.confirmedAt))) {
    return { allowed: false, reason: "確認時刻が不正" };
  }
  return { allowed: true, reason: "直近dry-runレポートの人間確認済み" };
}
