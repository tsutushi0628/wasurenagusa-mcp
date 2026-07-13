#!/usr/bin/env node
// 既存重複メモリの掃除（重複統合）スクリプト。
//
// 背景: memory_save は保存時に content_hash（project+scope+category+正規化(title,content)の
// SHA-256、src/storage/content-hash.ts）で重複検知するが、それ以前に保存された行や
// バックフィル未実施の行には content_hash 列が入っていない/重複が既に紛れ込んでいる。
// 本スクリプトは state='active' の生存行を対象に、保存時と同じ computeContentHash
// （dist/storage/content-hash.js を import。別実装で計算をズラさない）でグループ化し、
// 各グループから1件だけ残して残りを論理削除する。
//
// 残す1件の規則（グループ内の優先順）:
//   1. accessCount（vector_metadata.access_count。無ければ0扱い）が最大
//   2. 同点なら updated_at が最新
//   3. なお同点なら id が最小
//
// 削除は論理削除のみ（memories.state='deleted' かつ deleted_at セット。softDelete()と
// 同一のSQL条件＝WHERE id = ? AND deleted_at IS NULL。物理DELETEはしない）。
// memory_restore で復元可能。
//
// 既定は dry-run（groupsWithDup / rowsToDelete / rowsKept と削除サンプル数件を報告するのみ。
// DBは読み取り専用で開き、書き換えない）。--apply を明示したときのみ実際に論理削除する。
// 記憶の生content全文は出力しない（サンプルは id/title/project/accessCount/updated_atのみ）。
//
// 使い方:
//   node scripts/maintenance/dedupe-memories.mjs <dbPath>              # dry-run（既定）
//   node scripts/maintenance/dedupe-memories.mjs <dbPath> --apply      # 実削除（論理削除）
//   node scripts/maintenance/dedupe-memories.mjs <dbPath> --samples=10 # dry-runサンプル件数を変更

import { existsSync } from "fs";
import Database from "better-sqlite3";
import { computeContentHash } from "../../dist/storage/content-hash.js";

function parseArgs(argv) {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const apply = argv.includes("--apply");
  const samplesArg = argv.find((a) => a.startsWith("--samples="));
  const samples = samplesArg ? parseInt(samplesArg.split("=")[1], 10) : 5;
  return { dbPath: positional[0], apply, samples };
}

// グループ内の残す1件を選ぶ比較関数（昇順ソートで先頭=残す1件になるように並べる）。
// 1) accessCount降順 → 2) updated_at降順（新しい方を先） → 3) id昇順（最小を先）。
function compareForKeep(a, b) {
  if (b.accessCount !== a.accessCount) return b.accessCount - a.accessCount;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  return a.id < b.id ? -1 : 1;
}

function main() {
  const { dbPath, apply, samples } = parseArgs(process.argv.slice(2));

  if (!dbPath) {
    console.error("[dedupe-memories] 対象DBパスを引数で指定してください");
    console.error("使い方: node scripts/maintenance/dedupe-memories.mjs <dbPath> [--apply] [--samples=N]");
    process.exit(1);
  }
  if (!existsSync(dbPath)) {
    console.error(`[dedupe-memories] DBが見つかりません: ${dbPath}`);
    process.exit(1);
  }

  console.log(`[dedupe-memories] 対象DB: ${dbPath}`);
  console.log(`[dedupe-memories] モード: ${apply ? "APPLY（論理削除を実行する）" : "DRY-RUN（数えるだけ・DBは書き換えない）"}`);

  // dry-runは読み取り専用で開く（apply時のみ書き込み許可）。
  const db = new Database(dbPath, { readonly: !apply });
  try {
    db.pragma("busy_timeout = 5000");

    // content_hash列は後発マイグレーション列（schema.ts参照）。旧世代DB（v6以前・未マイグレーション）
    // には列自体が存在しないことがあるため、存在チェックしてからSELECT列を組み立てる
    // （列が無ければ常に自己計算にフォールバックする＝sqlite.ts のインデックス作成と同じ考え方）。
    const hasContentHashColumn =
      db
        .prepare("SELECT COUNT(*) as cnt FROM pragma_table_info('memories') WHERE name = 'content_hash'")
        .get().cnt > 0;
    console.log(`[dedupe-memories] content_hash列: ${hasContentHashColumn ? "存在（未バックフィル行のみ自己計算）" : "不在（旧世代DB・全行を自己計算）"}`);

    const rows = db
      .prepare(
        `SELECT m.id, m.project, m.scope, m.category, m.title, m.content,
                ${hasContentHashColumn ? "m.content_hash" : "NULL AS content_hash"}, m.updated_at,
                COALESCE(vm.access_count, 0) AS access_count
         FROM memories m
         LEFT JOIN vector_metadata vm ON vm.id = m.id
         WHERE m.state = 'active'`
      )
      .all();

    console.log(`[dedupe-memories] state='active' の生存記憶: ${rows.length}件`);

    // content_hash列が未バックフィル（NULL/空）の行は保存時と同じ関数で自己計算する。
    let selfComputed = 0;
    const groups = new Map(); // hash -> [{id, title, project, accessCount, updatedAt}]
    for (const row of rows) {
      let hash = row.content_hash;
      if (!hash) {
        hash = computeContentHash({
          project: row.project ?? undefined,
          scope: row.scope ?? undefined,
          category: row.category,
          title: row.title,
          content: row.content,
        });
        selfComputed++;
      }
      const entry = {
        id: row.id,
        title: row.title,
        project: row.project,
        accessCount: row.access_count,
        updatedAt: row.updated_at,
      };
      if (!groups.has(hash)) groups.set(hash, []);
      groups.get(hash).push(entry);
    }
    console.log(`[dedupe-memories] content_hash自己計算（未バックフィル分）: ${selfComputed}件`);

    // size>=2のグループだけが重複対象。
    const dupGroups = [...groups.entries()].filter(([, list]) => list.length >= 2);

    let rowsToDelete = 0;
    let rowsKept = 0;
    const deletionPlan = []; // { hash, keepId, deleteIds: [...] }
    for (const [hash, list] of dupGroups) {
      const sorted = [...list].sort(compareForKeep);
      const keep = sorted[0];
      const toDelete = sorted.slice(1);
      rowsKept += 1;
      rowsToDelete += toDelete.length;
      deletionPlan.push({ hash, keep, toDelete });
    }

    console.log(`[dedupe-memories] 重複グループ数(groupsWithDup): ${dupGroups.length}`);
    console.log(`[dedupe-memories] 削除対象行数(rowsToDelete): ${rowsToDelete}`);
    console.log(`[dedupe-memories] 残す行数(rowsKept・重複グループのみ): ${rowsKept}`);

    // 削除サンプル（--samples件、id/title/project/accessCount/updated_atのみ。content本文は出さない）。
    console.log(`[dedupe-memories] 削除サンプル（先頭${samples}グループ）:`);
    for (const plan of deletionPlan.slice(0, samples)) {
      const keepText = `keep=${plan.keep.id}(${plan.keep.project ?? "-"}, access=${plan.keep.accessCount}, updated=${plan.keep.updatedAt}) "${plan.keep.title}"`;
      const delText = plan.toDelete
        .map((d) => `${d.id}(access=${d.accessCount}, updated=${d.updatedAt})`)
        .join(", ");
      console.log(`  - hash=${plan.hash.slice(0, 12)}... ${keepText} / delete=[${delText}]`);
    }

    if (!apply) {
      console.log("[dedupe-memories] dry-runのためDBは書き換えていません。実削除するには --apply を指定してください。");
      return;
    }

    // --apply: softDelete()と同一のSQL条件で論理削除（state='deleted' かつ deleted_at セット。
    // WHERE id = ? AND deleted_at IS NULL＝冪等・既削除行は対象外）。物理DELETEはしない。
    const idsToDelete = deletionPlan.flatMap((plan) => plan.toDelete.map((d) => d.id));
    const now = new Date();
    const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    const ts = jst.toISOString().replace("Z", "+09:00");

    const update = db.prepare(
      "UPDATE memories SET deleted_at = ?, state = 'deleted' WHERE id = ? AND deleted_at IS NULL"
    );
    const runAll = db.transaction((ids) => {
      let updated = 0;
      for (const id of ids) {
        const info = update.run(ts, id);
        updated += info.changes;
      }
      return updated;
    });
    const updated = runAll(idsToDelete);
    console.log(`[dedupe-memories] 論理削除実行: ${updated}件（対象${idsToDelete.length}件）`);

    const integrity = db.prepare("PRAGMA integrity_check").get();
    console.log(`[dedupe-memories] integrity_check: ${integrity.integrity_check}`);

    const after = db
      .prepare("SELECT COUNT(*) as c FROM memories WHERE state = 'active'")
      .get();
    console.log(`[dedupe-memories] 適用後のstate='active'件数: ${after.c}`);
  } finally {
    db.close();
  }
}

main();
