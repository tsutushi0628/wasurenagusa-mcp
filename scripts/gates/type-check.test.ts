/**
 * scripts/gates/type-check.test.ts
 *
 * ゲートスクリプト（G0/G1）が、CLI直接実行（ts-node/esmローダー。完全型チェックを伴う）で
 * クラッシュしないことを保証するリグレッションテスト（2026-07-10 QA差し戻し対応。
 * push前コードレビュー指摘で盲点封鎖を構造化: tsconfig単一真実源化・ゲート自動収集・
 * 診断フィルタの穴閉じ）。
 *
 * 背景: g1-foundation.tsのCLI直接実行が独立QA環境で3回連続クラッシュした。原因は
 * `measured: t`（インデックスシグネチャを持たない型の裸変数をRecord<string, unknown>へ
 * 代入）というTS2322型エラーだった。tsconfig.jsonのincludeがsrc/**\/*のみでscripts/を
 * 型チェック対象から除外しており、かつvitestはesbuildで型情報を読み飛ばして実行するため、
 * `npm run build`にも`npx vitest run`にもこの型エラーは一切現れず、ts-node/esmの既定
 * （完全型チェックあり）モードでCLI起動したときだけ表面化していた。
 *
 * 封鎖する盲点: 「buildの検査範囲外（scripts/配下）かつvitestの型スキップ」でCLI実行時のみ
 * 顕在化する型エラー。このテストの守備範囲は以下で構造的に閉じる:
 * - 対象ファイルはscripts/gates/配下の.tsを自動収集する（手動列挙の追記漏れを防ぐ）
 * - compilerOptionsは実tsconfig.jsonを唯一の真実源として読み込む（手書き複製の非追随を防ぐ）。
 *   ただしemit・パス配置専用オプション（rootDir=./src等）はscripts/配下にTS6059等の偽赤を
 *   生むため中和する（型チェックの厳しさ側は一切中和しない。loadCompilerOptions参照）
 * - 診断はnode_modules配下のもののみ除外し、ゲートがimportするscripts/配下モジュール
 *   （backup-store.ts・restore-store.ts等、tsconfig include外＝build未検査）の型エラーも
 *   検出対象に含める。fileを持たないglobal診断も落とさない
 *
 * ゲートスクリプトの検査ロジック自体の正しさ（PASS/FAIL判定）は各*.test.tsが別途担保する。
 * このテストの責務は型の健全性のみである。
 */
import { describe, it, expect } from "vitest";
import ts from "typescript";
import { readdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GATES_DIR = resolve(REPO_ROOT, "scripts", "gates");

/** scripts/gates/ 配下の非テスト・非型定義 .ts を自動収集する（新ゲート追加時の追記漏れ防止）。 */
function collectGateFiles(): string[] {
  return readdirSync(GATES_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"))
    .map((f) => resolve(GATES_DIR, f))
    .sort();
}

/**
 * 実tsconfig.jsonのcompilerOptionsを唯一の真実源として読み込む。
 * 中和するのはemit・パス配置系のみ: noEmit=true（出力しない）、declaration=false、
 * rootDir/outDir/declarationMapの削除。rootDir=./srcのままだとscripts/配下のファイルが
 * TS6059（not under rootDir）で誤検出され、declaration/outDirも同様にemit都合の診断を生む。
 * strict系・noImplicit系・module解決系など型チェックの厳しさに関わる設定は一切触らず
 * 実tsconfigの値がそのまま効く（tsconfigを将来厳格化すればこのテストも自動で追随する）。
 */
function loadCompilerOptions(): ts.CompilerOptions {
  const configPath = resolve(REPO_ROOT, "tsconfig.json");
  const host: ts.ParseConfigFileHost = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(`tsconfig.json解析エラー: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
    },
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, host);
  if (!parsed) throw new Error("tsconfig.jsonの解析に失敗しました");
  const configErrors = parsed.errors.filter((e) => e.category === ts.DiagnosticCategory.Error);
  if (configErrors.length > 0) {
    throw new Error(
      `tsconfig.jsonにエラーがあります: ${configErrors.map((e) => ts.flattenDiagnosticMessageText(e.messageText, "\n")).join("; ")}`,
    );
  }
  const options: ts.CompilerOptions = { ...parsed.options, noEmit: true, declaration: false };
  delete options.rootDir;
  delete options.outDir;
  delete options.declarationMap;
  return options;
}

describe("ゲートスクリプトの型チェック（CLI実行時のみ顕在化する型エラーの回帰防止）", () => {
  it(
    "scripts/gates/配下の全ゲートとそのimport先（node_modules除く）は、実tsconfig.json相当の完全型チェックでエラーゼロである",
    () => {
      const gateFiles = collectGateFiles();
      expect(gateFiles.length, "scripts/gates/配下にゲートスクリプトが1本も見つかりません").toBeGreaterThan(0);

      const program = ts.createProgram(gateFiles, loadCompilerOptions());
      const diagnostics = ts.getPreEmitDiagnostics(program).filter((d) => {
        // fileを持たないglobal診断（オプション矛盾等）は落とさず検出対象に含める
        if (!d.file) return true;
        // node_modules配下（外部型定義）のみ除外。ゲートがimportするscripts/配下モジュール
        // （tsconfig include外＝build未検査）の診断は検出対象に含める
        return !resolve(d.file.fileName).includes("node_modules");
      });

      const formatted = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (f) => f,
        getCurrentDirectory: () => REPO_ROOT,
        getNewLine: () => "\n",
      });

      expect(
        diagnostics.map((d) => ({
          file: d.file?.fileName ?? "(global)",
          message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
        })),
        `ゲートスクリプト（またはそのimport先）に型エラーがあります（CLI直接実行がクラッシュします）:\n${formatted}`,
      ).toEqual([]);
    },
    60000,
  );
});
