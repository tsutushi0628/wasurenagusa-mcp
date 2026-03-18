import { MemoryCategory, MemoryEntry } from "../types.js";

/**
 * MarkdownコンテンツをパースしてMemoryEntry配列に変換する
 *
 * ラインベースで解析し、`---` をエントリ区切りとして使用する。
 * `- **content**:` 以降は次の `---` まで全行をcontent として収集するため、
 * content 内に `## ` や複数行テキストが含まれても安全にパースできる。
 */
export function parseMarkdown(content: string, category: MemoryCategory): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  const lines = content.split("\n");

  let currentTitle = "";
  let id = "";
  let timestamp = "";
  let tags: string[] = [];
  let entryContent = "";
  let project: string | undefined;
  let scope: string | undefined;
  let intensity: number | undefined;
  let inContent = false;
  let contentLines: string[] = [];

  function finalizeEntry(): void {
    if (inContent) {
      entryContent = contentLines.join("\n").trim();
      inContent = false;
      contentLines = [];
    }
    if (id && timestamp && entryContent) {
      const entry: MemoryEntry = {
        id,
        timestamp,
        category,
        content: entryContent,
        title: currentTitle,
        tags,
      };
      if (project) { entry.project = project; }
      if (scope) { entry.scope = scope; }
      if (intensity !== undefined) { entry.intensity = intensity; }
      entries.push(entry);
    }
    currentTitle = "";
    id = "";
    timestamp = "";
    tags = [];
    entryContent = "";
    project = undefined;
    scope = undefined;
    intensity = undefined;
  }

  for (const line of lines) {
    const trimmed = line.trim();

    // エントリ区切り: 現在のエントリを確定
    if (trimmed === "---") {
      finalizeEntry();
      continue;
    }

    // content収集中は `---` 以外すべてcontent行として取り込む
    if (inContent) {
      contentLines.push(line);
      continue;
    }

    // セクションヘッダー（## Title）
    if (line.startsWith("## ")) {
      currentTitle = line.replace(/^## /, "").trim();
      continue;
    }

    // ファイルヘッダー（# Config Memory 等）はスキップ
    if (line.startsWith("# ")) {
      continue;
    }

    // メタデータ行のパース
    if (trimmed.startsWith("- **id**:")) {
      id = trimmed.replace("- **id**:", "").trim();
    } else if (trimmed.startsWith("- **timestamp**:")) {
      timestamp = trimmed.replace("- **timestamp**:", "").trim();
    } else if (trimmed.startsWith("- **project**:")) {
      project = trimmed.replace("- **project**:", "").trim();
    } else if (trimmed.startsWith("- **scope**:")) {
      scope = trimmed.replace("- **scope**:", "").trim();
    } else if (trimmed.startsWith("- **importance**:")) {
      // マイグレーション: importance → intensity
      const value = trimmed.replace("- **importance**:", "").trim();
      if (value === "critical") {
        intensity = 3;
      } else {
        intensity = 2;
      }
    } else if (trimmed.startsWith("- **intensity**:")) {
      const value = parseInt(trimmed.replace("- **intensity**:", "").trim(), 10);
      if (!isNaN(value)) {
        intensity = value;
      }
    } else if (trimmed.startsWith("- **tags**:")) {
      tags = trimmed.replace("- **tags**:", "").trim().split(",").map(t => t.trim()).filter(Boolean);
    } else if (trimmed.startsWith("- **content**:")) {
      const firstLine = trimmed.replace("- **content**:", "").trim();
      contentLines = firstLine ? [firstLine] : [];
      inContent = true;
    }
  }

  // ファイル末尾に `---` がない場合の最後のエントリ
  finalizeEntry();

  return entries;
}
