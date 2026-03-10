import { MemoryEntry } from "../types.js";

/**
 * MemoryEntryをMarkdown形式にフォーマットする
 */
export function formatEntry(entry: MemoryEntry): string {
  const tagsStr = entry.tags.length > 0
    ? `- **tags**: ${entry.tags.join(", ")}\n`
    : "";

  const projectStr = entry.project
    ? `- **project**: ${entry.project}\n`
    : "";

  const scopeStr = entry.scope
    ? `- **scope**: ${entry.scope}\n`
    : "";

  const importanceStr = entry.importance === "critical"
    ? `- **importance**: critical\n`
    : "";

  return `## ${entry.title}

- **id**: ${entry.id}
- **timestamp**: ${entry.timestamp}
- **category**: ${entry.category}
${projectStr}${scopeStr}${importanceStr}${tagsStr}- **content**: ${entry.content}

---

`;
}

/**
 * ファイルのヘッダーを生成する
 */
export function getFileHeader(filename: string): string {
  const headers: Record<string, string> = {
    "config.md": "# Config Memory\n\nAPI URL、ポート、認証情報など、毎回参照すべき設定情報。\n\n---\n\n",
    "dont.md": "# Don't Memory\n\nやってはいけないこと、過去のミス、ユーザーが怒ったポイント。\n\n---\n\n",
    "decisions.md": "# Decisions Memory\n\n決定事項、採用した方針、技術選定の理由。\n\n---\n\n",
    "snippets.md": "# Snippets Memory\n\nよく使うコマンド、クエリ、便利スクリプト。\n\n---\n\n"
  };
  return headers[filename] || "";
}
