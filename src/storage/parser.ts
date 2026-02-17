import { MemoryCategory, MemoryEntry } from "../types.js";

/**
 * MarkdownコンテンツをパースしてMemoryEntry配列に変換する
 */
export function parseMarkdown(content: string, category: MemoryCategory): MemoryEntry[] {
  const entries: MemoryEntry[] = [];

  // ## で始まるセクションを分割
  const sections = content.split(/^## /gm).filter(s => s.trim());

  for (const section of sections) {
    const lines = section.split("\n");
    const title = lines[0]?.trim() || "";

    // ヘッダー行（ファイル先頭の # Config Memory 等）をスキップ
    if (!title || title.startsWith("#")) {
      continue;
    }

    let id = "";
    let timestamp = "";
    let tags: string[] = [];
    let entryContent = "";
    let project: string | undefined;
    let scope: string | undefined;

    for (const line of lines.slice(1)) {
      const trimmed = line.trim();
      if (trimmed.startsWith("- **id**:")) {
        id = trimmed.replace("- **id**:", "").trim();
      } else if (trimmed.startsWith("- **timestamp**:")) {
        timestamp = trimmed.replace("- **timestamp**:", "").trim();
      } else if (trimmed.startsWith("- **project**:")) {
        project = trimmed.replace("- **project**:", "").trim();
      } else if (trimmed.startsWith("- **scope**:")) {
        scope = trimmed.replace("- **scope**:", "").trim();
      } else if (trimmed.startsWith("- **tags**:")) {
        tags = trimmed.replace("- **tags**:", "").trim().split(",").map(t => t.trim()).filter(Boolean);
      } else if (trimmed.startsWith("- **content**:")) {
        entryContent = trimmed.replace("- **content**:", "").trim();
      }
    }

    // id か timestamp がないエントリはスキップ
    if (!id || !timestamp) {
      continue;
    }

    if (entryContent) {
      const entry: MemoryEntry = {
        id,
        timestamp,
        category,
        content: entryContent,
        title,
        tags,
      };
      if (project) { entry.project = project; }
      if (scope) { entry.scope = scope; }
      entries.push(entry);
    }
  }

  return entries;
}
