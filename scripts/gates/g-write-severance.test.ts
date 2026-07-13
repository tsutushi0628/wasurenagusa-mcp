import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import {
  stripComments,
  collectMergeCallSites,
  evaluateMergeDeadCode,
  collectV1WriteReferences,
  evaluateV1WriteSevered,
  collectConsolidateAllWrites,
  evaluateConsolidateAllNoWrite,
  resolveLocalImport,
  collectImportClosureWrites,
  evaluateImportClosureNoWrite,
  runGWriteSeverance,
} from "./g-write-severance.js";

/**
 * g-write-severance（破壊型書き込み再発ガード）のテスト。
 *
 * 業務要件（このゲートが守るもの）:
 * - 破壊型 merge / v1 書込ワーカーの再配線 / 夜間統合本体の memories 書き込みを、ソース走査で
 *   FAIL として捕捉する。
 * - 逆に、コメント言及・テストからの severance 検証参照・別系統の夢生成 save では誤検知しない。
 *
 * 検証方針: 実リポジトリに対しては 4 検査すべて PASS することを固定し（現状の severance を守る）、
 * 合成フィクスチャに違反を注入したときに各検査が FAIL へ転じることを固定する。
 * Check D（import 閉包走査）は、Check C の盲点（破壊挙動を別名ヘルパーへ移設して素通りさせる攻撃）を
 * 閉包全体の走査で捕捉することを固定する。
 */

describe("g-write-severance", () => {
  const scratchDirs: string[] = [];

  function makeDir(): string {
    const d = mkdtempSync(join(tmpdir(), "wasurenagusa-gwrite-test-"));
    scratchDirs.push(d);
    return d;
  }

  afterEach(() => {
    while (scratchDirs.length > 0) {
      const d = scratchDirs.pop()!;
      rmSync(d, { recursive: true, force: true });
    }
  });

  describe("stripComments", () => {
    it("ブロック/行コメントを除去し行番号を保つ", () => {
      const src = ["const a = 1;", "// mergePrinciplesIntoMemories(db)", "/* block */ const b = 2;"].join(
        "\n",
      );
      const out = stripComments(src);
      const lines = out.split("\n");
      expect(lines).toHaveLength(3); // 行数（行番号）が保たれる
      expect(out).not.toContain("mergePrinciplesIntoMemories");
      expect(out).not.toContain("block");
      expect(out).toContain("const a = 1;");
      expect(out).toContain("const b = 2;");
    });
  });

  describe("Check A: merge-dead-code", () => {
    it("呼び出しが無ければ PASS（定義のみ検出）", () => {
      const dir = makeDir();
      writeFileSync(
        join(dir, "persistence-helper.ts"),
        "export function mergePrinciplesIntoMemories(db: unknown) { return db; }\n",
      );
      const scan = collectMergeCallSites(dir);
      expect(scan.callSites).toHaveLength(0);
      expect(scan.definitionSites.length).toBeGreaterThanOrEqual(1);
      expect(evaluateMergeDeadCode(scan).result).toBe("PASS");
    });

    it("呼び出し元が 1 つでもあれば FAIL", () => {
      const dir = makeDir();
      writeFileSync(
        join(dir, "def.ts"),
        "export function mergePrinciplesIntoMemories(db: unknown) { return db; }\n",
      );
      writeFileSync(
        join(dir, "caller.ts"),
        "import { mergePrinciplesIntoMemories } from './def.js';\nmergePrinciplesIntoMemories(db);\n",
      );
      const scan = collectMergeCallSites(dir);
      expect(scan.callSites.length).toBeGreaterThanOrEqual(1);
      const result = evaluateMergeDeadCode(scan);
      expect(result.result).toBe("FAIL");
      expect(result.measured.callSiteCount).toBeGreaterThanOrEqual(1);
    });

    it("コメント内の呼び出し風の記述では誤検知しない", () => {
      const dir = makeDir();
      writeFileSync(
        join(dir, "note.ts"),
        "// かつて mergePrinciplesIntoMemories(db) を呼んでいたが撤去済み\nconst x = 1;\n",
      );
      const scan = collectMergeCallSites(dir);
      expect(scan.callSites).toHaveLength(0);
      expect(evaluateMergeDeadCode(scan).result).toBe("PASS");
    });
  });

  describe("Check B: v1-write-severed", () => {
    it("生きた（非テスト）コードが v1 書込ワーカーを参照すると FAIL", () => {
      const dir = makeDir();
      writeFileSync(
        join(dir, "wired.ts"),
        "import { runDontConsolidationForProject } from './consolidate-worker.js';\nrunDontConsolidationForProject();\n",
      );
      const hits = collectV1WriteReferences(dir);
      expect(hits.length).toBeGreaterThanOrEqual(1);
      expect(evaluateV1WriteSevered(hits).result).toBe("FAIL");
    });

    it("*.test.ts からの severance 検証参照は除外され PASS（誤検知しない）", () => {
      const dir = makeDir();
      writeFileSync(
        join(dir, "context-v1-write-block.test.ts"),
        'const spawned = paths.some((p) => p.includes("consolidate-worker"));\n',
      );
      const hits = collectV1WriteReferences(dir);
      expect(hits).toHaveLength(0);
      expect(evaluateV1WriteSevered(hits).result).toBe("PASS");
    });

    it("consolidate-worker.ts 本体とコメント言及は除外され PASS", () => {
      const dir = makeDir();
      // ワーカー本体（除外対象）
      writeFileSync(
        join(dir, "consolidate-worker.ts"),
        "export function runDontConsolidationForProject() { return 1; }\n",
      );
      // 生きたコードだがコメント言及のみ（コメント除去で消える）
      writeFileSync(
        join(dir, "context.ts"),
        "// 旧: consolidate-worker を spawn していた経路（撤去済み）\nconst x = 1;\n",
      );
      const hits = collectV1WriteReferences(dir);
      expect(hits).toHaveLength(0);
      expect(evaluateV1WriteSevered(hits).result).toBe("PASS");
    });
  });

  describe("Check C: consolidate-all-no-memories-write", () => {
    it("memories 書き込みが無ければ PASS", () => {
      const dir = makeDir();
      const file = join(dir, "consolidate-all.ts");
      writeFileSync(
        file,
        "const entries = storage.readAliveDontEntries(p);\nawait writeFile(reportPath, json);\n",
      );
      const scan = collectConsolidateAllWrites(file);
      expect(scan.fileExists).toBe(true);
      expect(scan.writes).toHaveLength(0);
      expect(evaluateConsolidateAllNoWrite(scan).result).toBe("PASS");
    });

    it("storage.save() 呼び出しがあれば FAIL", () => {
      const dir = makeDir();
      const file = join(dir, "consolidate-all.ts");
      writeFileSync(file, "storage.save({ category: 'log', title: 't', content: 'c' });\n");
      const scan = collectConsolidateAllWrites(file);
      expect(scan.writes.length).toBeGreaterThanOrEqual(1);
      expect(evaluateConsolidateAllNoWrite(scan).result).toBe("FAIL");
    });

    it("UPDATE memories などの生 SQL 書き込みがあれば FAIL", () => {
      const dir = makeDir();
      const file = join(dir, "consolidate-all.ts");
      writeFileSync(file, "db.prepare(`UPDATE memories SET state='archived' WHERE id=?`).run(id);\n");
      const scan = collectConsolidateAllWrites(file);
      expect(scan.writes.length).toBeGreaterThanOrEqual(1);
      expect(evaluateConsolidateAllNoWrite(scan).result).toBe("FAIL");
    });

    it("ファイルが存在しなければ FAIL（前提破綻）", () => {
      const dir = makeDir();
      const scan = collectConsolidateAllWrites(join(dir, "does-not-exist.ts"));
      expect(scan.fileExists).toBe(false);
      expect(evaluateConsolidateAllNoWrite(scan).result).toBe("FAIL");
    });

    it("コメント内の書き込み風記述では誤検知しない", () => {
      const dir = makeDir();
      const file = join(dir, "consolidate-all.ts");
      writeFileSync(file, "// 以前は storage.save() していたが dry-run 化で撤去\nconst x = 1;\n");
      const scan = collectConsolidateAllWrites(file);
      expect(scan.writes).toHaveLength(0);
      expect(evaluateConsolidateAllNoWrite(scan).result).toBe("PASS");
    });
  });

  describe("Check D: consolidate-all-closure-no-memories-write", () => {
    it("resolveLocalImport は .js 指定子を .ts へ、ディレクトリを index.ts へ解決する", () => {
      const dir = makeDir();
      mkdirSync(join(dir, "pkg"), { recursive: true });
      writeFileSync(join(dir, "sibling.ts"), "export const a = 1;\n");
      writeFileSync(join(dir, "pkg", "index.ts"), "export const b = 2;\n");
      const from = join(dir, "entry.ts");
      writeFileSync(from, "\n");
      expect(resolveLocalImport(from, "./sibling.js")).toBe(join(dir, "sibling.ts"));
      expect(resolveLocalImport(from, "./pkg")).toBe(join(dir, "pkg", "index.ts"));
      expect(resolveLocalImport(from, "pkg-external")).toBeNull();
    });

    it("破壊挙動を別名ヘルパーへ移すと Check C は素通りするが Check D が閉包走査で FAIL", () => {
      const root = makeDir();
      const srcDir = join(root, "src");
      const cliDir = join(srcDir, "cli");
      const consDir = join(srcDir, "consolidator");
      mkdirSync(cliDir, { recursive: true });
      mkdirSync(consDir, { recursive: true });
      // consolidate-all 本文は「呼ぶだけ」— 破壊パターンは本文に現れない（Check C の盲点）
      writeFileSync(
        join(cliDir, "consolidate-all.ts"),
        "import { applyConsolidation } from '../consolidator/apply-consolidation.js';\napplyConsolidation(storage, ids);\n",
      );
      // 破壊挙動を別名ヘルパーへ移設（softDelete + deleteVectors）
      writeFileSync(
        join(consDir, "apply-consolidation.ts"),
        "export function applyConsolidation(storage: any, ids: string[]) {\n  for (const id of ids) { storage.softDelete(id); storage.deleteVectors(id); }\n}\n",
      );

      // 直接: 閉包にヘルパーが含まれ、破壊パターンを検出する
      const scan = collectImportClosureWrites(join(cliDir, "consolidate-all.ts"), srcDir);
      expect(scan.entryExists).toBe(true);
      expect(scan.closure).toContain("consolidator/apply-consolidation.ts");
      expect(scan.scanned).toContain("consolidator/apply-consolidation.ts");
      expect(scan.writes.map((w) => w.match)).toContain("storage-softDelete");
      expect(evaluateImportClosureNoWrite(scan).result).toBe("FAIL");

      // 統合: 同じ盲点攻撃で Check C は PASS（本文だけ見る）だが Check D は FAIL
      const output = runGWriteSeverance({ srcDir, consolidateAllPath: join(cliDir, "consolidate-all.ts") });
      const checkC = output.checks.find((c) => c.check === "consolidate-all-no-memories-write");
      const checkD = output.checks.find((c) => c.check === "consolidate-all-closure-no-memories-write");
      expect(checkC?.result).toBe("PASS");
      expect(checkD?.result).toBe("FAIL");
    });

    it("storage 基盤層と dream-worker の書き込みは走査対象外で PASS（誤検知しない）", () => {
      const root = makeDir();
      const srcDir = join(root, "src");
      const cliDir = join(srcDir, "cli");
      const storageDir = join(srcDir, "storage");
      mkdirSync(cliDir, { recursive: true });
      mkdirSync(storageDir, { recursive: true });
      // consolidate-all はストレージ基盤と夢生成を import（いずれも正当）
      writeFileSync(
        join(cliDir, "consolidate-all.ts"),
        "import { SqliteStorage } from '../storage/sqlite.js';\nimport { runDream } from './dream-worker.js';\nconst rows = storage.readAliveDontEntries(p);\n",
      );
      // 基盤層: memories への生 SQL 定義（除外対象）
      writeFileSync(
        join(storageDir, "sqlite.ts"),
        "export class SqliteStorage {\n  save(m: any) { this.db.prepare('INSERT INTO memories (id) VALUES (?)').run(m.id); }\n  softDelete(id: string) { this.db.prepare('UPDATE memories SET state=? WHERE id=?').run('archived', id); }\n}\n",
      );
      // 夢生成: 別系統の save（除外対象）
      writeFileSync(
        join(cliDir, "dream-worker.ts"),
        "export function runDream(storage: any) { storage.save({ category: 'dream', title: 't', content: 'c' }); }\n",
      );
      const scan = collectImportClosureWrites(join(cliDir, "consolidate-all.ts"), srcDir);
      expect(scan.closure).toContain("storage/sqlite.ts");
      expect(scan.closure).toContain("cli/dream-worker.ts");
      expect(scan.excluded).toContain("storage/sqlite.ts");
      expect(scan.excluded).toContain("cli/dream-worker.ts");
      expect(scan.writes).toHaveLength(0);
      expect(evaluateImportClosureNoWrite(scan).result).toBe("PASS");
    });

    it("storage/ 配下でも“定義ファイル以外の新規呼び出し側”に破壊挙動を置くと Check D が捕捉する（サブツリー丸ごと除外の盲点を塞ぐ）", () => {
      const root = makeDir();
      const srcDir = join(root, "src");
      const cliDir = join(srcDir, "cli");
      const storageDir = join(srcDir, "storage");
      mkdirSync(cliDir, { recursive: true });
      mkdirSync(storageDir, { recursive: true });
      // consolidate-all は「呼ぶだけ」— 破壊パターンは本文に現れない（Check C の盲点）
      writeFileSync(
        join(cliDir, "consolidate-all.ts"),
        "import { applySeverance } from '../storage/apply-severance.js';\napplySeverance(storage, ids);\n",
      );
      // 破壊プリミティブの“定義ファイル”（除外対象。実 sqlite.ts と同じ位置づけ）
      writeFileSync(
        join(storageDir, "sqlite.ts"),
        "export class SqliteStorage {\n  softDelete(id: string) { this.db.prepare('UPDATE memories SET state=? WHERE id=?').run('archived', id); }\n}\n",
      );
      // storage/ 配下の“新規呼び出し側”ファイル（定義ファイルではない＝走査対象であるべき）。
      // 破壊呼び出しを storage/ サブツリーへ隠す攻撃を、丸ごと除外していた旧実装は素通りさせた。
      writeFileSync(
        join(storageDir, "apply-severance.ts"),
        "import { SqliteStorage } from './sqlite.js';\nexport function applySeverance(storage: SqliteStorage, ids: string[]) {\n  for (const id of ids) { storage.softDelete(id); storage.deleteVectors([id]); }\n}\n",
      );

      const scan = collectImportClosureWrites(join(cliDir, "consolidate-all.ts"), srcDir);
      // 定義ファイルは従来どおり除外され、storage/ 配下の呼び出し側は走査される（除外を定義ファイルへ限定）
      expect(scan.excluded).toContain("storage/sqlite.ts");
      expect(scan.excluded).not.toContain("storage/apply-severance.ts");
      expect(scan.scanned).toContain("storage/apply-severance.ts");
      // 走査対象の呼び出し側で破壊パターンを検出する（storage/ 配下でも素通りさせない）。
      // 検出は呼び出し側ファイルに帰属し、定義ファイル(sqlite.ts)の softDelete 定義は誤検知しない。
      const flaggedFiles = scan.writes.map((w) => w.file);
      expect(flaggedFiles).toContain("storage/apply-severance.ts");
      expect(flaggedFiles).not.toContain("storage/sqlite.ts");
      expect(evaluateImportClosureNoWrite(scan).result).toBe("FAIL");

      // 統合: Check C は本文しか見ないため PASS、Check D は storage/ 配下への移設を FAIL にする
      const output = runGWriteSeverance({ srcDir, consolidateAllPath: join(cliDir, "consolidate-all.ts") });
      const checkC = output.checks.find((c) => c.check === "consolidate-all-no-memories-write");
      const checkD = output.checks.find((c) => c.check === "consolidate-all-closure-no-memories-write");
      expect(checkC?.result).toBe("PASS");
      expect(checkD?.result).toBe("FAIL");
    });

    it("エントリファイルが存在しなければ FAIL（前提破綻）", () => {
      const root = makeDir();
      const srcDir = join(root, "src");
      mkdirSync(srcDir, { recursive: true });
      const scan = collectImportClosureWrites(join(srcDir, "cli", "consolidate-all.ts"), srcDir);
      expect(scan.entryExists).toBe(false);
      expect(evaluateImportClosureNoWrite(scan).result).toBe("FAIL");
    });
  });

  describe("runGWriteSeverance（統合）", () => {
    it("実リポジトリでは前提成立かつ 4 検査すべて PASS（現状 severance を固定）", () => {
      const output = runGWriteSeverance();
      expect(output.preconditions.ok).toBe(true);
      expect(output.checks).toHaveLength(4);
      const failed = output.checks.filter((c) => c.result === "FAIL");
      expect(failed.map((f) => f.check)).toEqual([]);
    });

    it("フィクスチャに破壊型 merge 呼び出しを注入すると FAIL 検査が現れる", () => {
      const root = makeDir();
      const srcDir = join(root, "src");
      const cliDir = join(srcDir, "cli");
      mkdirSync(cliDir, { recursive: true });
      // v1・consolidate-all は健全にしておき、merge 呼び出しだけを注入する
      writeFileSync(join(cliDir, "consolidate-all.ts"), "const x = 1;\n");
      writeFileSync(
        join(srcDir, "evil.ts"),
        "import { mergePrinciplesIntoMemories } from './x.js';\nmergePrinciplesIntoMemories(db);\n",
      );

      const output = runGWriteSeverance({ srcDir, consolidateAllPath: join(cliDir, "consolidate-all.ts") });
      expect(output.preconditions.ok).toBe(true);
      const merge = output.checks.find((c) => c.check === "merge-dead-code");
      expect(merge?.result).toBe("FAIL");
    });

    it("src ディレクトリが無ければ前提不成立で checks は空（false PASS を出さない）", () => {
      const root = makeDir();
      const output = runGWriteSeverance({ srcDir: join(root, "nonexistent"), consolidateAllPath: join(root, "x.ts") });
      expect(output.preconditions.ok).toBe(false);
      expect(output.checks).toHaveLength(0);
    });
  });
});
