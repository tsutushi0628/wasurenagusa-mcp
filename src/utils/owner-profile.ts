import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { loadPrompt } from "../analyzer/prompt-loader.js";

const PROFILE_FILENAME = "owner-profile.md";

/**
 * owner-profile.md のパスを返す
 * memoryPath = {MCPプロジェクトルート}/.wasurenagusa/
 */
export function getOwnerProfilePath(memoryPath: string): string {
  return join(memoryPath, PROFILE_FILENAME);
}

/**
 * MDテキストにユーザー記入内容があるかチェック
 * HTMLコメント・見出し・水平線・空行を除去して、残りがあれば記入済み
 */
export function hasContent(md: string): boolean {
  const stripped = md
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^#{1,3}\s.*$/gm, "")
    .replace(/^---$/gm, "")
    .replace(/^>\s*$/gm, "")
    .replace(/^\s*$/gm, "")
    .trim();
  return stripped.length > 0;
}

/**
 * owner-profileから記入済み部分だけを抽出してコンパクト化する。
 *
 * 除外するもの:
 * - イントロ文（h1直下の説明文）
 * - セクション説明のブロック引用（> AIが〜）
 * - 未チェックの選択肢（- [ ] ...）
 * - テーブルの空セル行
 * - 質問の導入文（「以下を〜」「それぞれ〜」「同じ処理が〜」等）
 * - デフォルトのみで構成されたサブセクション
 * - 「(デフォルト)」マーカー自体
 */
export function compactOwnerProfile(md: string): string {
  const lines = md.split("\n");
  const output: string[] = [];
  let skipIntro = true;
  let currentH3: string[] = [];
  let h3Title = "";
  let hasNonDefaultContent = false;

  function flushBuffer() {
    if (hasNonDefaultContent) {
      output.push(...currentH3);
    }
    currentH3 = [];
    h3Title = "";
    hasNonDefaultContent = false;
  }

  for (const line of lines) {
    // h1はタイトルとして保持、その直後のイントロはスキップ
    if (/^# /.test(line)) {
      output.push(line);
      skipIntro = true;
      continue;
    }

    // h2: セクション大見出し — flushして保留
    if (/^## /.test(line)) {
      flushBuffer();
      skipIntro = false;
      output.push("");
      output.push(line);
      continue;
    }

    // h3: サブセクション — 前のh3をflushして新しくバッファ開始
    if (/^### /.test(line)) {
      flushBuffer();
      h3Title = line;
      currentH3.push("");
      currentH3.push(line);
      continue;
    }

    // イントロ文のスキップ（h1直後〜最初のh2まで）
    if (skipIntro) continue;

    // セクション説明の引用（> AIが〜）をスキップ
    if (/^>\s*(AIが|未記入でも)/.test(line)) continue;

    // 空のブロック引用（> のみ or > 補足があれば:）をスキップ
    if (/^>\s*$/.test(line)) continue;
    if (/^>\s*補足があれば/.test(line)) continue;

    // 実コンテンツのブロック引用（> テキスト）は保持
    if (/^>\s+\S/.test(line)) {
      currentH3.push(line);
      hasNonDefaultContent = true;
      continue;
    }

    // 質問導入文をスキップ
    if (/^(以下を|それぞれ「|同じ処理が|「ユーザーから|npm等の|バグ修正中|タスク中|「ユーザー一覧|public API|外部サービス|AIの判断の確信度|内部APIの|タスク実行中|3回リトライ|1つのタスク|上の選択肢)/.test(line)) continue;

    // 水平線スキップ
    if (/^---$/.test(line)) continue;

    // 未チェック選択肢をスキップ
    if (/^- \[ \]/.test(line)) continue;

    // チェック済み選択肢
    if (/^- \[x\]/.test(line)) {
      const isDefault = /\(デフォルト\)/.test(line);
      const cleaned = line.replace(/\s*\(デフォルト\)\s*/g, "").trim();
      currentH3.push(cleaned);
      if (!isDefault) {
        hasNonDefaultContent = true;
      }
      continue;
    }

    // テーブル行の処理
    if (/^\|/.test(line)) {
      // セパレータ行（|------|--------|）はバッファに保持
      if (/^\|[-\s|]+\|$/.test(line)) {
        currentH3.push(line);
        continue;
      }
      // データ行: パイプで分割して最後のセルが空なら除外
      const cells = line.split("|").slice(1, -1); // 先頭・末尾の空文字を除く
      if (cells.length >= 2) {
        const lastCell = cells[cells.length - 1].trim();
        if (lastCell === "") {
          // 空セル行 → スキップ
          continue;
        }
        currentH3.push(line);
        hasNonDefaultContent = true;
        continue;
      }
      // ヘッダ行（列名）はバッファに保持
      currentH3.push(line);
      continue;
    }

    // 番号付きリスト（タスク優先順位の未記入チェックボックス）
    if (/^\d+\.\s*\[ \]/.test(line)) continue;

    // 空行
    if (line.trim() === "") continue;

    // その他のテキスト行（自由記述等）
    currentH3.push(line);
    hasNonDefaultContent = true;
  }

  flushBuffer();

  // 空のh2セクションを除去（h2の後にh2が来る or 末尾）
  const cleaned: string[] = [];
  for (let i = 0; i < output.length; i++) {
    if (/^## /.test(output[i])) {
      // 次の非空行がh2か末尾なら、このh2は空セクション
      let hasContent = false;
      for (let j = i + 1; j < output.length; j++) {
        if (output[j].trim() === "") continue;
        if (/^## /.test(output[j])) break;
        hasContent = true;
        break;
      }
      if (!hasContent) continue;
    }
    cleaned.push(output[i]);
  }

  // 先頭の空行を除去して返す
  const result = cleaned.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return result;
}

/**
 * owner-profile.md が存在しなければテンプレートを配置する
 * MCPサーバー起動時に呼ばれる
 */
export async function ensureOwnerProfileExists(memoryPath: string): Promise<void> {
  const profilePath = getOwnerProfilePath(memoryPath);
  try {
    await readFile(profilePath, "utf-8");
  } catch {
    try {
      const template = await loadPrompt("owner-profile-template.md");
      await writeFile(profilePath, template, "utf-8");
    } catch {
      // テンプレートコピー失敗は握りつぶす
    }
  }
}

/**
 * owner-profile.md を読み込む
 * 存在しなければテンプレートを配置して null を返す（初回はテンプレートのまま）
 */
export async function loadOwnerProfile(memoryPath: string): Promise<string | null> {
  const profilePath = getOwnerProfilePath(memoryPath);

  try {
    const content = await readFile(profilePath, "utf-8");
    if (hasContent(content)) {
      return compactOwnerProfile(content);
    }
    return null;
  } catch {
    // ファイルが存在しない → テンプレートをコピー配置
    try {
      const template = await loadPrompt("owner-profile-template.md");
      await writeFile(profilePath, template, "utf-8");
    } catch {
      // テンプレートコピー失敗は握りつぶす
    }
    return null;
  }
}
