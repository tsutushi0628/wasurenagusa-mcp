/**
 * 外部LLMプロバイダ（Gemini等）に送信する前に、
 * 過去の会話に混入しうる機密情報を [REDACTED] へ置換するサニタイザ。
 *
 * 設計方針:
 * - マッチ部分はまるごと [REDACTED] に置換する（部分マスクや文字数情報の保持はしない）
 *   →「安全側を優先」。攻撃者にトークン長やプレフィックスを推測させない。
 * - 正規表現の評価順序が重要。具体的なプレフィックス付きパターン（sk-, AIza, JWT）を
 *   汎用パターン（32字以上の英数記号トークン）より先に走らせる。
 * - 検出対象は以下：
 *   1. JWT（eyJ で始まる3パート）
 *   2. Google APIキー（AIza+30字以上）
 *   3. OpenAIキー（sk-+20字以上）
 *   4. 汎用APIキー（32字以上の英数_-）
 *   5. macOS 絶対パス（/Users/...）
 *   6. Linux 絶対パス（/home/...）
 *   7. メールアドレス
 */

interface RedactionPattern {
  readonly name: string;
  readonly pattern: RegExp;
}

// 評価順序: 具体的→汎用、長いプレフィックス付き→短いプレフィックス付き→無印
const PATTERNS: readonly RedactionPattern[] = [
  // 1. JWT（3パート構造を持つ。eyJ プレフィックスは "{" のbase64開始）
  { name: "jwt", pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  // 2. Google APIキー（プレフィックス AIza + 30字以上）
  { name: "google-api-key", pattern: /AIza[A-Za-z0-9_-]{30,}/g },
  // 3. OpenAIキー（sk- + 20字以上）。汎用32字より先に評価する。
  { name: "openai-key", pattern: /sk-[A-Za-z0-9_-]{20,}/g },
  // 4. 汎用32字以上の英数_-トークン（APIキー疑い）
  { name: "generic-token", pattern: /[A-Za-z0-9_-]{32,}/g },
  // 5. macOS 絶対パス
  { name: "macos-path", pattern: /\/Users\/[^\s'"]+/g },
  // 6. Linux 絶対パス
  { name: "linux-path", pattern: /\/home\/[^\s'"]+/g },
  // 7. メールアドレス
  { name: "email", pattern: /[\w.+-]+@[\w-]+\.[\w.-]+/g },
];

const REDACTED_PLACEHOLDER = "[REDACTED]";

/**
 * 入力文字列から機密情報パターンを検出して [REDACTED] に置換する。
 * 通常文字列は変更されない。複数パターンが混在する場合は全て置換される。
 */
export function redactSensitive(text: string): string {
  if (text.length === 0) return text;

  let result = text;
  for (const { pattern } of PATTERNS) {
    result = result.replace(pattern, REDACTED_PLACEHOLDER);
  }
  return result;
}

/**
 * プロンプト埋め込み用に長文を切り詰める。
 * maxChars を超える場合、先頭 maxChars 字を残して末尾に「…」を付与する。
 * デフォルトは 200字。
 */
export function truncateForPrompt(text: string, maxChars: number = 200): string {
  if (text.length === 0) return text;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "…";
}
