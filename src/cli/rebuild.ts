#!/usr/bin/env node
/**
 * wasurenagusa-rebuild CLI
 * 壊れたメモリデータを修復する
 *
 * 使い方: wasurenagusa-rebuild /path/to/project
 *
 * 処理内容:
 * 1. 全カテゴリのエントリを新パーサーで読み込み
 * 2. IDベースで重複排除（同一IDは最初の出現のみ保持）
 * 3. ログはタイムスタンプの日付ごとに正しいファイルへ再配置
 * 4. 各ファイルをクリーンに再書き込み
 */
import { readFile, writeFile, readdir, unlink } from "fs/promises";
import { existsSync } from "fs";
import { join, basename } from "path";
import { getMemoryPath, config } from "../config.js";
import { parseMarkdown } from "../storage/parser.js";
import { formatEntry, getFileHeader } from "../storage/formatter.js";
import { MemoryCategory, MemoryEntry } from "../types.js";

async function main(): Promise<void> {
  const projectRoot = process.argv[2];
  if (!projectRoot) {
    console.error("Usage: wasurenagusa-rebuild /path/to/project");
    process.exit(1);
  }

  const memoryPath = getMemoryPath(projectRoot);
  if (!existsSync(memoryPath)) {
    console.error(`Memory directory not found: ${memoryPath}`);
    process.exit(1);
  }

  console.log(`Rebuilding: ${memoryPath}`);

  // 単一ファイルカテゴリの再構築
  const singleFileCategories: { category: MemoryCategory; file: string }[] = [
    { category: "config", file: "config.md" },
    { category: "dont", file: "dont.md" },
    { category: "decision", file: "decisions.md" },
    { category: "snippet", file: "snippets.md" },
  ];

  for (const { category, file } of singleFileCategories) {
    const filePath = join(memoryPath, file);
    if (!existsSync(filePath)) { continue; }

    const content = await readFile(filePath, "utf-8");
    const entries = parseMarkdown(content, category);

    // ID重複排除
    const seenIds = new Set<string>();
    const unique = entries.filter(e => {
      if (seenIds.has(e.id)) { return false; }
      seenIds.add(e.id);
      return true;
    });

    const removed = entries.length - unique.length;
    const header = getFileHeader(file);
    const body = unique.map(e => formatEntry(e)).join("");
    await writeFile(filePath, header + body, "utf-8");

    console.log(`  ${file}: ${entries.length} → ${unique.length} entries (${removed} duplicates removed)`);
  }

  // ログの再構築
  const logsPath = join(memoryPath, "logs");
  if (existsSync(logsPath)) {
    const logFiles = (await readdir(logsPath)).filter(f => f.endsWith(".md"));
    const allLogEntries: MemoryEntry[] = [];
    const seenIds = new Set<string>();

    for (const file of logFiles) {
      const content = await readFile(join(logsPath, file), "utf-8");
      const entries = parseMarkdown(content, "log");
      for (const entry of entries) {
        if (!seenIds.has(entry.id)) {
          seenIds.add(entry.id);
          allLogEntries.push(entry);
        }
      }
    }

    const totalBefore = logFiles.length;

    // 日付ごとにグループ化
    const byDate = new Map<string, MemoryEntry[]>();
    for (const entry of allLogEntries) {
      const date = entry.timestamp.split("T")[0];
      if (!byDate.has(date)) { byDate.set(date, []); }
      byDate.get(date)!.push(entry);
    }

    // 既存のログファイルを全削除
    for (const file of logFiles) {
      await unlink(join(logsPath, file));
    }

    // 正しい日付ファイルに再書き込み
    for (const [date, entries] of byDate) {
      const filePath = join(logsPath, `${date}.md`);
      const header = `# Log: ${date}\n\n---\n\n`;
      const body = entries.map(e => formatEntry(e)).join("");
      await writeFile(filePath, header + body, "utf-8");
    }

    const totalLogEntries = allLogEntries.length;
    const dateFiles = byDate.size;
    console.log(`  logs/: ${totalBefore} files → ${dateFiles} files, ${totalLogEntries} unique entries`);
  }

  console.log("Rebuild complete.");
}

main().catch(err => {
  console.error("Rebuild failed:", err);
  process.exit(1);
});
