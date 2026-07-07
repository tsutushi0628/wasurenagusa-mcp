/**
 * spike-token-counter: トークン計数ライブラリの実在確認と較正スパイク（タスク0.3）
 *
 * 目的: 消費側モデル（Claude Code）のトークン数で注入バジェットを管理するための
 * 計数手段を確定する（R-C1）。候補ライブラリをローカルで実行し、日本語テキストの
 * トークン数を計測できることを確認したうえで、較正係数（安全係数）を決めて記録する。
 *
 * 確定したライブラリ: @anthropic-ai/tokenizer（Anthropic公式、tiktoken系実装を内包、
 * オフライン・外部API送信なしで動作）。exact pinで package.json へ追加済み。
 *
 * 既知の限界: 本ライブラリが内蔵する語彙表はClaude 3以降の実際のトークナイザとは
 * 完全一致しない近似（Anthropic公式ドキュメントもcount_tokens API使用を推奨し、本
 * ライブラリを「概算」と位置付けている）。オフライン制約（外部API送信をしない）を
 * 優先し、近似であることを較正係数（安全マージン）で補う設計とする。
 *
 * Usage:
 *   npx ts-node --esm scripts/spikes/spike-token-counter.ts [任意: 計測対象テキストファイルパス]
 *   引数省略時はスクリプト内蔵の合成日本語サンプルで計測する（機密ゼロ）。
 */

import { countTokens } from "@anthropic-ai/tokenizer";
import { readFileSync } from "fs";

interface CheckResult {
  label: string;
  ok: boolean;
  detail: string;
}

const results: CheckResult[] = [];

function record(label: string, fn: () => string): void {
  try {
    const detail = fn();
    results.push({ label, ok: true, detail });
  } catch (error) {
    results.push({ label, ok: false, detail: `NG: ${(error as Error).message}` });
  }
}

// 合成日本語サンプル（機密ゼロ・スクリプト内蔵）。実測較正は本番同等サイズの
// 実サンプルで別途実行し、結果本文（バイト数・トークン数・係数のみ）を
// Implementation Log に記録する。
const SYNTHETIC_SAMPLE_JA = `
### 行動原則（サマリ）
- 本番デプロイ前には必ずコードレビューとセキュリティレビューを実施すること。
- エラーハンドリングは握りつぶさず、文脈を付与して再スローすること。
- Firestoreのコレクション名はcamelCase複数形で統一すること。
### 重要な行動原則 トップ3
- **APIキーの直書き禁止**: 環境変数経由で管理し、コード内にハードコードしない。
- **破壊的操作の事前確認**: git push --force やDB書き換えは必ずy/n確認を取る。
- **テストの業務意図検証**: 実装の途中計算を写しただけのアサーションは書かない。
### 直近の注意事項（最新5件）
- ログ未読のまま「直った」と報告しない
- 同じAPIエンドポイントを短時間に3回以上叩かない
- 空配列フォールバックで失敗を握りつぶさない
`.trim();

async function main() {
  // --- 1. ライブラリが実際にロードできるか ---
  record("countTokens 関数のロード確認", () => {
    if (typeof countTokens !== "function") {
      throw new Error("countTokens is not a function");
    }
    return "@anthropic-ai/tokenizer から countTokens をロード成功";
  });

  // --- 2. 英数字テキストでの基本動作確認 ---
  record("英語テキストの計数", () => {
    const text = "The quick brown fox jumps over the lazy dog.";
    const n = countTokens(text);
    if (n <= 0) throw new Error(`トークン数が0以下: ${n}`);
    return `"${text}" → ${n} トークン`;
  });

  // --- 3. 日本語テキストでの計数確認（オフライン動作・例外なし） ---
  record("日本語テキストの計数（合成サンプル）", () => {
    const n = countTokens(SYNTHETIC_SAMPLE_JA);
    const byteLen = Buffer.byteLength(SYNTHETIC_SAMPLE_JA, "utf-8");
    const charLen = SYNTHETIC_SAMPLE_JA.length;
    const bytesPerToken = (byteLen / n).toFixed(2);
    const charsPerToken = (charLen / n).toFixed(2);
    return `文字数=${charLen}, バイト数=${byteLen}, トークン数=${n}（${bytesPerToken} bytes/token, ${charsPerToken} chars/token）`;
  });

  // --- 4. 空文字列 ---
  record("空文字列の計数", () => {
    const n = countTokens("");
    return `空文字列 → ${n} トークン`;
  });

  // --- 5. 較正: 引数で渡された実サンプル（本番同等サイズ）があれば計測 ---
  const sampleArg = process.argv[2];
  if (sampleArg) {
    record(`実サンプル計測（${sampleArg}、内容はログに出さない）`, () => {
      const content = readFileSync(sampleArg, "utf-8");
      const n = countTokens(content);
      const byteLen = Buffer.byteLength(content, "utf-8");
      const charLen = content.length;
      const estimateTokensFn = (t: string) => {
        // src/cli/context.ts の estimateTokens と同じ保守的概算式
        const charEstimate = Math.ceil(t.length / 2);
        const byteEstimate = Math.ceil(Buffer.byteLength(t, "utf-8") / 3);
        return Math.max(charEstimate, byteEstimate);
      };
      const currentEstimate = estimateTokensFn(content);
      const ratio = (n / currentEstimate).toFixed(3);
      return `文字数=${charLen}, バイト数=${byteLen} (${(byteLen / 1024).toFixed(2)}KB), tokenizer実測=${n}トークン, 既存概算式(estimateTokens)=${currentEstimate}トークン, 実測/概算比=${ratio}`;
    });
  } else {
    results.push({
      label: "実サンプル計測",
      ok: true,
      detail: "引数省略のためスキップ（合成サンプルのみで基本動作を確認済み）",
    });
  }

  console.log("=== spike-token-counter 実行結果 ===");
  for (const r of results) {
    console.log(`[${r.ok ? "OK" : "NG"}] ${r.label}: ${r.detail}`);
  }
  const failCount = results.filter((r) => !r.ok).length;
  console.log(`\n合計 ${results.length}件中 ${failCount}件が想定外エラー`);

  console.log(`
=== 較正結果の記録（design.mdタスク0.3） ===
確定ライブラリ: @anthropic-ai/tokenizer@0.0.4（exact pin, package.json dependencies）
安全係数: 0.8（バジェット上限に乗算し、実際のClaude 3以降のトークナイザとの語彙差分・
  近似誤差を見込んだ安全マージンとする。根拠: 本ライブラリは公式ドキュメント上も
  「概算」と位置付けられており、実測/概算比が1.0から乖離する可能性があるため、
  過小評価によるバジェット超過を避ける側に倒す）
`);
}

main().catch((error) => {
  console.error("spike-token-counter 実行失敗:", error);
  process.exit(1);
});
