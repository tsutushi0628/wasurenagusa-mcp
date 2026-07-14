/**
 * 系譜つき追記型マージのオーケストレーション（memory-redesign Phase 3・タスク3.7/3.8／R-A6）。
 *
 * 破壊 SQL は storage 層（sqlite.ts=severance 除外集合）の名前付きプリミティブ
 * `applyAppendOnlyMerge` / `insertSupersedes` に閉じ、本モジュールはそれを「呼ぶ」だけの薄い
 * 合成層。統合結果に埋め込みベクトルを付与し、必要なら supersedes 系譜を記録する。
 *
 * severance 対策: 本モジュールは consolidate-all.ts の import 閉包に「入れない」（夜間統合の
 * dry-run 経路から到達させない）。実書き込みは明示コミット済みの適用スクリプトからのみ呼ぶ。
 * 本ファイルには `.save(` / `.softDelete(` / `.deleteVectors(` / 生 memories SQL を書かない。
 */
import type { SQLiteStorage } from "../storage/sqlite.js";
import type { SaveParams } from "../types.js";

export interface MergeCommand {
  /** 追記する統合結果（新レコードの中身）。*/
  merged: SaveParams;
  /** 吸収する原本 id（deleted へ論理遷移＋索引除去）。*/
  sourceIds: string[];
  /** 統合結果に付ける埋め込み（384次元）。未指定なら索引なしで追記のみ。*/
  embedding?: number[];
}

export interface MergeOutcome {
  mergedId: string;
  absorbedIds: string[];
}

/**
 * 系譜つき追記型マージを1件適用する。統合結果を新レコードとして追記し（100% merged_from 系譜）、
 * 原本を deleted へ論理遷移させて索引を除去し、統合結果に埋め込みを付与する。
 * 原本の本文 UPDATE も物理 DELETE もしない（append-only）。
 */
export function applyMergeWithLineage(
  storage: SQLiteStorage,
  cmd: MergeCommand,
): MergeOutcome {
  const outcome = storage.applyAppendOnlyMerge({
    merged: cmd.merged,
    sourceIds: cmd.sourceIds,
  });
  if (cmd.embedding) {
    storage.upsertVector(outcome.mergedId, cmd.embedding);
  }
  return outcome;
}

/**
 * 新版が旧版を上書きする関係（supersedes）を記録する。旧版の本文・state は変更しない
 * （検索表示側で旧版を下げるための来歴のみ）。
 */
export function recordSupersedes(
  storage: SQLiteStorage,
  newId: string,
  supersededIds: string[],
): void {
  for (const oldId of supersededIds) {
    storage.insertSupersedes(newId, oldId);
  }
}
