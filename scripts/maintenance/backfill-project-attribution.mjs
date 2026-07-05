#!/usr/bin/env node
// プロジェクト帰属の後付け仕分け（backfill）スクリプト。
//
// 背景: memory_save の project 値は起動プロジェクト名（basename(projectRoot)）
// 一本で刻まれていたため、firebase-kit から起動して別プロジェクトの作業をした
// 記憶もすべて project='firebase-kit' で保存されていた。結果 project=<他名> の
// 単一プロジェクト絞り込み検索が常に0件化する。保存側は save.ts の任意 project
// 引数で以後は正しく刻めるが、既存行は本スクリプトで後付け仕分けする。
//
// 方針は全面決定論・precision優先（LLM不使用）。記憶の title/tags（推奨ティア）に
// 既知プロジェクト名が「ちょうど1個」出現し、かつ起動プロジェクト名（base）が
// 共起していないものだけを、その1プロジェクトへ再帰属する。0個/2個以上/base共起/
// 明示signal無しは base のまま保留する（誤仕分けは単一プロジェクト検索から
// 記憶を消す害があるため recall より precision を優先）。
//
// 個人ホーム絶対パスはハードコードしない。プロジェクトレジストリの所在は dbPath
// から導出する（dbPath = <projectsRoot>/<project>/.wasurenagusa/memory.db）。
// --projects-root で明示上書きも可。
//
// 既定は dry-run（対象件数・帰属先内訳・ID+titleサンプルのみ報告・DBは書き換えない）。
// 記憶の生content全文は出力しない。--apply を明示したときのみ実際に project 列を更新する。
//
// 使い方:
//   node scripts/maintenance/backfill-project-attribution.mjs <dbPath>                       # dry-run（既定・推奨ティア）
//   node scripts/maintenance/backfill-project-attribution.mjs <dbPath> --tier=strict         # 別ティアで試算
//   node scripts/maintenance/backfill-project-attribution.mjs <dbPath> --apply               # 実更新（推奨ティア）
//   node scripts/maintenance/backfill-project-attribution.mjs <dbPath> --projects-root=<dir> # レジストリ所在を明示

import { existsSync, readdirSync, statSync } from "fs";
import { dirname, basename, join } from "path";
import Database from "better-sqlite3";

const NON_PROJECT_DIRS = new Set(["data", "docs", "scripts"]);
const TIERS = new Set(["recommended", "strict", "loose"]);

function parseArgs(argv) {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const apply = argv.includes("--apply");
  const tierArg = argv.find((a) => a.startsWith("--tier="));
  const rootArg = argv.find((a) => a.startsWith("--projects-root="));
  const samplesArg = argv.find((a) => a.startsWith("--samples="));
  const tier = tierArg ? tierArg.split("=")[1] : "recommended";
  const projectsRoot = rootArg ? rootArg.split("=")[1] : undefined;
  const samples = samplesArg ? parseInt(samplesArg.split("=")[1], 10) : 5;
  return { dbPath: positional[0], apply, tier, projectsRoot, samples };
}

function isProjectDir(root, name) {
  if (name.startsWith(".")) return false;
  if (NON_PROJECT_DIRS.has(name)) return false;
  if (name.endsWith(".code-workspace")) return false;
  if (name.includes(".backup")) return false;
  try {
    return statSync(join(root, name)).isDirectory();
  } catch {
    return false;
  }
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// レジストリ名を語境界アンカーで検出する正規表現を1本組む。長い名を先に並べ、
// 最長一致で ai-management-dx-fanout が ai-management-dx より先に当たるようにする。
function buildDetector(names) {
  const sorted = [...names].sort((a, b) => b.length - a.length);
  const alt = sorted.map(escapeRegex).join("|");
  // 前後が英数字・ハイフンでない位置でのみ一致（ハイフンを境界クラスに含めることで
  // 'app-kit-migration' が 'app-kit' に誤マッチするのを防ぐ）。
  // 長い名を先に並べる長さ降順alternationは維持（ai-management-dx-fanout を
  // ai-management-dx より先に当てる最長一致は上のsortで担保される）。
  return new RegExp(`(?<![-a-z0-9])(?:${alt})(?![-a-z0-9])`, "g");
}

function detectNames(haystack, detector) {
  const found = new Set();
  detector.lastIndex = 0;
  let m;
  while ((m = detector.exec(haystack)) !== null) {
    found.add(m[0]);
    if (m.index === detector.lastIndex) detector.lastIndex++;
  }
  return found;
}

// 1レコードを分類し、再帰属先（base以外の唯一名）または null（保留）を返す。
function classify(row, base, detector, tier) {
  const title = (row.title || "").toLowerCase();
  const tags = (row.tags || "").toLowerCase();
  const content = (row.content || "").toLowerCase();

  const detectField = tier === "loose" || tier === "strict"
    ? `${title} ${tags} ${content}`
    : `${title} ${tags}`; // recommended: title/tags のみ

  const matched = detectNames(detectField, detector);
  const baseCoOccurs = matched.has(base);
  const nonBase = [...matched].filter((n) => n !== base);

  if (nonBase.length !== 1) return null; // 0個/2個以上は保留
  if (tier !== "loose" && baseCoOccurs) return null; // strict/recommended は base共起で保留
  return nonBase[0];
}

function main() {
  const { dbPath, apply, tier, projectsRoot: rootOverride, samples } = parseArgs(process.argv.slice(2));

  if (!dbPath) {
    console.error("[backfill-attribution] 対象DBパスを引数で指定してください");
    console.error("使い方: node scripts/maintenance/backfill-project-attribution.mjs <dbPath> [--apply] [--tier=recommended|strict|loose] [--projects-root=<dir>]");
    process.exit(1);
  }
  if (!existsSync(dbPath)) {
    console.error(`[backfill-attribution] DBが見つかりません: ${dbPath}`);
    process.exit(1);
  }
  if (!TIERS.has(tier)) {
    console.error(`[backfill-attribution] 不正な --tier: ${tier}（recommended|strict|loose）`);
    process.exit(1);
  }

  // dbPath = <projectsRoot>/<project>/.wasurenagusa/memory.db から base と projectsRoot を導出。
  const wasurenagusaDir = dirname(dbPath);
  const projectRoot = dirname(wasurenagusaDir);
  const base = basename(projectRoot);
  const projectsRoot = rootOverride || dirname(projectRoot);

  if (!existsSync(projectsRoot)) {
    console.error(`[backfill-attribution] プロジェクトレジストリの所在が見つかりません: ${projectsRoot}`);
    console.error("--projects-root=<dir> で明示してください");
    process.exit(1);
  }

  const registry = readdirSync(projectsRoot).filter((n) => isProjectDir(projectsRoot, n));
  if (!registry.includes(base)) registry.push(base); // base は共起検出用に含める
  const detector = buildDetector(registry.map((n) => n.toLowerCase()));
  const baseLower = base.toLowerCase();
  // detector/classify は小文字化名で照合するため、書き戻し用に小文字→元の大文字小文字表記へのMapを持つ
  // （save.ts は project を basename(projectRoot) の元表記で刻むため、DB書き込みも元表記に揃える）。
  const lowerToOriginal = new Map(registry.map((n) => [n.toLowerCase(), n]));

  console.log(`[backfill-attribution] 対象DB: ${dbPath}`);
  console.log(`[backfill-attribution] 起動プロジェクト(base): ${base}`);
  console.log(`[backfill-attribution] レジストリ: ${registry.length}件（projectsRoot=${projectsRoot}）`);
  console.log(`[backfill-attribution] ティア: ${tier}`);
  console.log(`[backfill-attribution] モード: ${apply ? "APPLY（project列を更新する）" : "DRY-RUN（数えるだけ・DBは書き換えない）"}`);

  const db = new Database(dbPath, { readonly: !apply });
  try {
    db.pragma("busy_timeout = 5000");

    const rows = db
      .prepare("SELECT id, title, content, tags, project FROM memories WHERE project = ? AND deleted_at IS NULL")
      .all(base);
    console.log(`[backfill-attribution] base帰属の生存記憶: ${rows.length}件`);

    // 3ティアの試算（設計の1727/1615/1456相当が出るかを併せて確認できるように全ティア数えて表示）。
    const tierCounts = { loose: 0, strict: 0, recommended: 0 };
    for (const t of Object.keys(tierCounts)) {
      for (const row of rows) {
        if (classify(row, baseLower, detector, t)) tierCounts[t]++;
      }
    }
    console.log(`[backfill-attribution] 試算 - loose: ${tierCounts.loose}件 / strict: ${tierCounts.strict}件 / recommended: ${tierCounts.recommended}件`);

    // 選択ティアの再帰属対象を確定。
    const targets = []; // { id, target }
    const byProject = new Map(); // target -> [{id,title}]
    for (const row of rows) {
      const target = classify(row, baseLower, detector, tier);
      if (!target) continue;
      // classify は小文字化名を返すため、DB書き込み・レポートは元の大文字小文字表記に戻す。
      const targetOriginal = lowerToOriginal.get(target) ?? target;
      targets.push({ id: row.id, target: targetOriginal });
      if (!byProject.has(targetOriginal)) byProject.set(targetOriginal, []);
      byProject.get(targetOriginal).push({ id: row.id, title: row.title });
    }

    console.log(`[backfill-attribution] 選択ティア(${tier})の再帰属対象: ${targets.length}件 / 保留(base据置): ${rows.length - targets.length}件`);
    console.log(`[backfill-attribution] 帰属先内訳:`);
    const breakdown = [...byProject.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [proj, list] of breakdown) {
      const samplesText = list.slice(0, samples).map((e) => `${e.id} | ${e.title}`).join("  //  ");
      console.log(`  - ${proj}: ${list.length}件  [例] ${samplesText}`);
    }

    if (!apply) {
      console.log("[backfill-attribution] dry-runのためDBは書き換えていません。実更新するには --apply を指定してください。");
      return;
    }

    // --apply: 冪等UPDATE（project=base かつ 未削除 の行のみ対象＝再実行しても移動済みは対象外）。
    const update = db.prepare(
      "UPDATE memories SET project = @target, updated_at = datetime('now') WHERE id = @id AND project = @base AND deleted_at IS NULL"
    );
    const runAll = db.transaction((items) => {
      let updated = 0;
      for (const it of items) {
        const info = update.run({ target: it.target, id: it.id, base });
        updated += info.changes;
      }
      return updated;
    });
    const updated = runAll(targets);
    console.log(`[backfill-attribution] 更新実行: ${updated}件（対象${targets.length}件）`);

    const integrity = db.prepare("PRAGMA integrity_check").get();
    console.log(`[backfill-attribution] integrity_check: ${integrity.integrity_check}`);

    const dist = db
      .prepare("SELECT project, COUNT(*) as c FROM memories WHERE deleted_at IS NULL GROUP BY project ORDER BY c DESC")
      .all();
    console.log(`[backfill-attribution] 適用後のproject別生存件数:`);
    for (const r of dist) console.log(`  - ${r.project}: ${r.c}件`);
  } finally {
    db.close();
  }
}

main();
