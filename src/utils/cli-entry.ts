import { realpathSync } from "fs";
import { fileURLToPath } from "url";

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
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}
