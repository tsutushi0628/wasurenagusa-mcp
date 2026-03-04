/**
 * LLMプロンプトテンプレートに埋め込む変数値をエスケープする。
 * テンプレートリテラル構造を壊す可能性のある文字を無害化する。
 */
export function escapePromptVariable(value: string): string {
  if (value.length === 0) return value;

  // 1. 制御文字を除去（改行 \n, キャリッジリターン \r, タブ \t は保持）
  let escaped = value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

  // 2. テンプレートリテラル式 ${...} をエスケープ
  escaped = escaped.replace(/\$\{/g, "\\${");

  // 3. バッククォートをエスケープ
  escaped = escaped.replace(/`/g, "\\`");

  return escaped;
}
