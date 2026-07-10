/**
 * scripts/gates/type-check.test.ts
 *
 * ゲートスクリプト（G0/G1）が、CLI直接実行（ts-node/esmローダー。完全型チェックを伴う）で
 * クラッシュしないことを保証するリグレッションテスト（2026-07-10 QA差し戻し対応）。
 *
 * 背景: g1-foundation.tsのCLI直接実行が独立QA環境で3回連続クラッシュした。原因は
 * `measured: t`（TombstoneCounts型の裸変数を、インデックスシグネチャを持たないまま
 * Record<string, unknown>へ代入）という構造的に不適合なTS2322型エラーだった。
 * tsconfig.jsonのincludeがsrc/**\/*のみでscripts/を型チェック対象から除外しており、かつ
 * vitestはesbuildで型情報を読み飛ばして実行するため、`npm run build`にも`npx vitest run`にも
 * この型エラーは一切現れず、ts-node/esmの既定（完全型チェックあり）モードでCLI起動した
 * ときだけ表面化していた。
 *
 * このテストは、G0/G1双方のゲートスクリプトをTypeScriptコンパイラAPIで直接・完全型チェックし、
 * 同種の「buildにもvitestにも映らずCLI実行時のみ顕在化する型エラー」を再発時に検出する。
 * ゲートスクリプトの検査ロジック自体の正しさ（PASS/FAIL判定）は各*.test.tsが別途担保する。
 * このテストの責務は型の健全性のみである。
 */
import { describe, it, expect } from "vitest";
import ts from "typescript";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// scripts/gates/ 配下の非テストスクリプトのみを対象にする（scripts/eval/ 等の他ディレクトリ・
// 拡張子は一切含まない。将来ゲートが増えたら都度この配列へ追記する）。
const GATE_FILES = [
  resolve(REPO_ROOT, "scripts/gates/g0-hemostasis.ts"),
  resolve(REPO_ROOT, "scripts/gates/g1-foundation.ts"),
];

describe("ゲートスクリプトの型チェック（CLI実行時のみ顕在化する型エラーの回帰防止）", () => {
  it("g0-hemostasis.ts / g1-foundation.ts は完全型チェック（tsconfig.jsonのstrict設定相当）でエラーゼロである", () => {
    const compilerOptions: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
      noEmit: true,
    };

    const program = ts.createProgram(GATE_FILES, compilerOptions);
    const diagnostics = ts.getPreEmitDiagnostics(program).filter((d) => {
      if (!d.file) return false;
      return GATE_FILES.includes(resolve(d.file.fileName));
    });

    const formatted = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (f) => f,
      getCurrentDirectory: () => REPO_ROOT,
      getNewLine: () => "\n",
    });

    expect(
      diagnostics.map((d) => ({ file: d.file?.fileName, message: ts.flattenDiagnosticMessageText(d.messageText, "\n") })),
      `ゲートスクリプトに型エラーがあります（CLI直接実行がクラッシュします）:\n${formatted}`,
    ).toEqual([]);
  });
});
