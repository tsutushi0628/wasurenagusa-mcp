import { describe, it, expect } from "vitest";
import { redactSensitive, truncateForPrompt } from "./redact-sensitive-data.js";

/**
 * dream-worker が外部LLMプロバイダにシード文字列を送る前に、
 * 機密情報を [REDACTED] に置換するサニタイザ。
 *
 * 安全側を優先：マッチ部分はまるごと [REDACTED] に置換する（部分マスクや文字数情報の保持はしない）。
 */
describe("redactSensitive", () => {
  describe("APIキーパターン", () => {
    it("OpenAI形式 sk-... を [REDACTED] に置換する", () => {
      const input = "APIキーは sk-1234567890abcdefghij です";
      const result = redactSensitive(input);
      expect(result).toBe("APIキーは [REDACTED] です");
    });

    it("Google API形式 AIza... を [REDACTED] に置換する", () => {
      const input = "GeminiキーはAIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7です";
      const result = redactSensitive(input);
      expect(result).toBe("Geminiキーは[REDACTED]です");
    });

    it("汎用32字以上の英数記号トークンを [REDACTED] に置換する", () => {
      const input = "token=abcdefghijklmnopqrstuvwxyz0123456789AB end";
      const result = redactSensitive(input);
      expect(result).toBe("token=[REDACTED] end");
    });

    it("31字以下の短い英数列は置換しない", () => {
      const input = "id=abcdefghijklmnopqrstuvwxyz12345";
      const result = redactSensitive(input);
      expect(result).toBe("id=abcdefghijklmnopqrstuvwxyz12345");
    });
  });

  describe("絶対パスパターン", () => {
    it("/Users/ から始まる macOS の絶対パスを [REDACTED] に置換する", () => {
      const input = "ファイルは /Users/foo/secret.env にある";
      const result = redactSensitive(input);
      expect(result).toBe("ファイルは [REDACTED] にある");
    });

    it("/home/ から始まる Linux の絶対パスを [REDACTED] に置換する", () => {
      const input = "Linuxは /home/user/.ssh/id_rsa にある";
      const result = redactSensitive(input);
      expect(result).toBe("Linuxは [REDACTED] にある");
    });
  });

  describe("メールアドレスパターン", () => {
    it("メールアドレスを [REDACTED] に置換する", () => {
      const input = "連絡は taro@example.com まで";
      const result = redactSensitive(input);
      expect(result).toBe("連絡は [REDACTED] まで");
    });

    it("プラス記号入りエイリアスも置換する", () => {
      const input = "alias は user.name+tag@sub.example.co.jp";
      const result = redactSensitive(input);
      expect(result).toBe("alias は [REDACTED]");
    });
  });

  describe("JWTパターン", () => {
    it("eyJ で始まる3パートのJWTを [REDACTED] に置換する", () => {
      const jwt =
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
      const input = `Authorization: Bearer ${jwt}`;
      const result = redactSensitive(input);
      expect(result).toBe("Authorization: Bearer [REDACTED]");
    });
  });

  describe("通常文字列", () => {
    it("パターンに該当しない通常の日本語文字列は変更しない", () => {
      const input = "本番に直接接続しちゃダメ。怒られた。";
      const result = redactSensitive(input);
      expect(result).toBe("本番に直接接続しちゃダメ。怒られた。");
    });

    it("短い英数字や通常の単語は変更しない", () => {
      const input = "user id is 12345 and status is ok";
      const result = redactSensitive(input);
      expect(result).toBe("user id is 12345 and status is ok");
    });

    it("空文字列はそのまま返す", () => {
      expect(redactSensitive("")).toBe("");
    });
  });

  describe("複数パターン混在", () => {
    it("APIキー・絶対パス・メアドが同一文に混在しても全部置換される", () => {
      const input =
        "本番送信した。APIキーは sk-1234567890abcdefghij で、ファイルは /Users/foo/secret.env にあった。連絡は taro@example.com まで。";
      const result = redactSensitive(input);
      expect(result).toBe(
        "本番送信した。APIキーは [REDACTED] で、ファイルは [REDACTED] にあった。連絡は [REDACTED] まで。",
      );
    });

    it("長いパターン（sk-）が短い汎用パターンに飲み込まれない（順序保証）", () => {
      // sk-XXX...は汎用32字以上にも該当しうるが、置換結果としては [REDACTED] 1つになる
      const input = "key=sk-abcdefghijklmnopqrstuvwxyz0123";
      const result = redactSensitive(input);
      expect(result).toBe("key=[REDACTED]");
    });
  });
});

describe("truncateForPrompt", () => {
  it("デフォルト200字を超える文字列を末尾「…」付きで切り詰める", () => {
    const input = "あ".repeat(250);
    const result = truncateForPrompt(input);
    expect(result.length).toBe(201); // 200字 + 「…」
    expect(result.endsWith("…")).toBe(true);
    expect(result.startsWith("あ".repeat(200))).toBe(true);
  });

  it("200字ちょうどなら切り詰めない", () => {
    const input = "あ".repeat(200);
    const result = truncateForPrompt(input);
    expect(result).toBe(input);
    expect(result.endsWith("…")).toBe(false);
  });

  it("200字未満ならそのまま返す", () => {
    const input = "短い文字列";
    const result = truncateForPrompt(input);
    expect(result).toBe("短い文字列");
  });

  it("maxChars を指定できる", () => {
    const input = "abcdefghij";
    const result = truncateForPrompt(input, 5);
    expect(result).toBe("abcde…");
  });

  it("空文字列はそのまま返す", () => {
    expect(truncateForPrompt("")).toBe("");
  });
});
