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
      return content;
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
