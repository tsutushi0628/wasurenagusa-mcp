import { realpathSync } from "fs";
import { fileURLToPath } from "url";

/**
 * CLI起動時のargv1が呼び出し元モジュール自身か判定する。
 *
 * npm binのsymlink経由ではargv1とimport.meta.urlのパス表記が異なるため、両方を実体化して比べる。
 * realpath失敗時は生パス一致へ戻し、判定不能時に従来の直接実行を止めない。
 *
 * @param argv1 process.argv[1]
 * @param moduleUrl 呼び出し側モジュールの import.meta.url
 */
export function isDirectRun(argv1: string | undefined, moduleUrl: string): boolean {
  if (argv1 === undefined) return false;

  const modulePath = fileURLToPath(moduleUrl);
  try {
    return realpathSync(argv1) === realpathSync(modulePath);
  } catch {
    return argv1 === modulePath;
  }
}

/**
 * このモジュールが CLI として直接起動されたか判定する（import 時は false）。
 *
 * npm の bin はグローバル導入時に symlink になり、process.argv[1] には symlink パスが
 * そのまま渡る一方、import.meta.url は realpath に解決される。素朴な文字列一致だと
 * bin 経由の起動で一致せず main() が走らないため、両者を realpath に正規化して比較する。
 * 直叩き・Windows の .cmd shim・テストからの import のいずれでも正しく判定できる。
 *
 * @param importMetaUrl 呼び出し側モジュールの import.meta.url
 */
export function isMainModule(importMetaUrl: string): boolean {
  return isDirectRun(process.argv[1], importMetaUrl);
}
