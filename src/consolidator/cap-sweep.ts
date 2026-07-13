/**
 * 抑制装置（カテゴリ別上限）の dry-run 判定。
 *
 * 【この関数は読み取り専用（SELECT のみ）】記憶レコードの archive/delete/update は一切しない。
 * 「もし退避したら何件・どの id か」を算出して返すだけの純粋関数で、実際の退避（state 変更や
 * 物理削除）は別増分（Phase 3 の追記型再設計）まで実装しない。夜間統合 dry-run（consolidate-all）
 * が本判定を呼び、結果をレポート JSON へ記録する用途を想定する。
 *
 * 忘却（長期未参照の退避）は本増分では実装しない。忘却の高価値保護に必要な最終参照シグナル
 * （最終アクセス時刻）が現状は埋め込みを持つ行の vector_metadata にしか無く、埋め込みの無い記憶
 * では参照追跡が無音の no-op になって候補集合が信頼できない（高頻度参照の高価値記憶を過大に
 * 候補化しうる）ため。忘却は信頼できる最終参照（アクセス時刻）配線を敷く次増分で実装する。
 *
 * keep 判定に使うカラムの所在（GroundTruth 実地確定）:
 * - state / updated_at / id / category は memories 本体（schema.ts）に実在し ORDER BY に直接使える。
 * - access_count は memories には無く、別テーブル vector_metadata（id 外部キー）にしか無い。
 *   さらに埋め込み未生成の active 行には vector_metadata 行が存在しない（access_count が NULL に
 *   なり得る）ため、COALESCE(vm.access_count, 0) で NULL を 0 に正規化してから並べる。
 */

import type Database from "better-sqlite3";

/** カテゴリ別上限超過による退避候補（1カテゴリぶん）。 */
export interface CapSweepCandidate {
  /** カテゴリ名 */
  category: string;
  /** そのカテゴリの active 行数 */
  activeCount: number;
  /** 適用した上限（このカテゴリで keep する上位件数） */
  cap: number;
  /** 退避候補件数（activeCount - cap、超過分） */
  archiveCandidateCount: number;
  /** 退避候補の id（keep 順で cap 件目以降。決定論的順序） */
  candidateIds: string[];
}

/**
 * カテゴリ別上限の dry-run 判定（読み取り専用）。
 *
 * 各カテゴリの active 行を keep 順（access_count 降順 → updated_at 降順 → id 昇順）で並べ、
 * 上位 capPerCategory 件を keep、それ以降を「退避候補」として返す。返すのは上限を超過した
 * カテゴリ（archiveCandidateCount > 0）のみで、上限未満のカテゴリは配列に含めない
 * （dry-run レポートには「退避が発生する面」だけを載せる意図）。
 *
 * capPerCategory <= 0 は「上限無効（退避しない）」として空配列を返す
 * （v1 の archiveExcessEntries が maxEntries<=0 で早期 return するのと同じ約束）。
 *
 * 並び順の根拠:
 * - access_count 降順: よく参照される記憶を優先的に残す（COALESCE で NULL=0 に正規化）。
 * - updated_at 降順: 同アクセスなら新しい方を残す。
 * - id 昇順: 最終タイブレーク。id は base36 ミリ秒プレフィックス+乱数のため辞書順昇順が
 *   実質作成順の決定論的タイブレークになる。
 */
export function computeCapSweep(
  db: Database.Database,
  capPerCategory: number,
): CapSweepCandidate[] {
  if (capPerCategory <= 0) {
    return [];
  }

  const categories = db
    .prepare(
      "SELECT category, COUNT(*) as cnt FROM memories WHERE state = 'active' GROUP BY category",
    )
    .all() as { category: string; cnt: number }[];

  const result: CapSweepCandidate[] = [];

  for (const { category, cnt } of categories) {
    if (cnt <= capPerCategory) {
      continue;
    }

    // vector_metadata は id が PRIMARY KEY のため LEFT JOIN は 1:0/1:1（行が増えない）。
    const rows = db
      .prepare(
        `SELECT m.id AS id
         FROM memories m
         LEFT JOIN vector_metadata vm ON m.id = vm.id
         WHERE m.state = 'active' AND m.category = ?
         ORDER BY COALESCE(vm.access_count, 0) DESC, m.updated_at DESC, m.id ASC`,
      )
      .all(category) as { id: string }[];

    const candidateIds = rows.slice(capPerCategory).map((r) => r.id);
    result.push({
      category,
      activeCount: rows.length,
      cap: capPerCategory,
      archiveCandidateCount: candidateIds.length,
      candidateIds,
    });
  }

  return result;
}

// 忘却（長期未参照の退避）判定は本増分では未実装。忘却は信頼できる最終参照（アクセス時刻）
// 配線を敷く次増分で実装する（ファイル冒頭の JSDoc に非実装の根拠を記載）。
