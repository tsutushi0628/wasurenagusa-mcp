import type Database from "better-sqlite3";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { MemoryCategory, MemoryEntry } from "../types.js";
import { parseMarkdown } from "./parser.js";

interface MigrationResult {
  entriesCount: number;
  vectorMetadataCount: number;
}

interface V1VectorsJson {
  version: number;
  entries: Record<string, {
    embedding: number[];
    accessCount: number;
    createdAt: string;
    lastAccessedAt: string;
  }>;
}

const CATEGORY_FILES: Record<string, MemoryCategory> = {
  "config.md": "config",
  "dont.md": "dont",
  "decisions.md": "decision",
  "snippets.md": "snippet",
};

/**
 * v1のマークダウンファイルとvectors.jsonからSQLiteへ移行する。
 * 全体をトランザクションで実行し、失敗時はロールバック。
 */
export function migrateV1ToV2(
  db: Database.Database,
  memoryPath: string,
): MigrationResult {
  if (!existsSync(memoryPath)) {
    return { entriesCount: 0, vectorMetadataCount: 0 };
  }

  // v1のエントリを全て読み出す
  const allEntries = readAllV1Entries(memoryPath);

  if (allEntries.length === 0) {
    return { entriesCount: 0, vectorMetadataCount: 0 };
  }

  // トランザクションで一括INSERT
  const insertMemory = db.prepare(`
    INSERT OR IGNORE INTO memories (id, timestamp, category, title, content, tags, project, scope, intensity)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let entriesCount = 0;
  let vectorMetadataCount = 0;

  const transaction = db.transaction(() => {
    // エントリの挿入
    const seenIds = new Set<string>();
    for (const entry of allEntries) {
      if (seenIds.has(entry.id)) {
        continue;
      }
      seenIds.add(entry.id);

      const result = insertMemory.run(
        entry.id,
        entry.timestamp,
        entry.category,
        entry.title,
        entry.content,
        JSON.stringify(entry.tags),
        entry.project ?? null,
        entry.scope ?? null,
        entry.intensity ?? null,
      );
      if (result.changes > 0) {
        entriesCount++;
      }
    }

    // vectors.jsonのメタデータ移行（embeddingはスキップ）
    vectorMetadataCount = migrateVectorMetadata(db, memoryPath, seenIds);
  });

  transaction();

  return { entriesCount, vectorMetadataCount };
}

/**
 * v1の全カテゴリからMemoryEntry[]を読み出す
 */
function readAllV1Entries(memoryPath: string): MemoryEntry[] {
  const entries: MemoryEntry[] = [];

  // 固定ファイル（config, dont, decision, snippet）
  for (const [filename, category] of Object.entries(CATEGORY_FILES)) {
    const filePath = join(memoryPath, filename);
    if (!existsSync(filePath)) {
      continue;
    }
    const content = readFileSync(filePath, "utf-8");
    const parsed = parseMarkdown(content, category);
    entries.push(...parsed);
  }

  // ログファイル（logs/YYYY-MM-DD.md）
  const logsDir = join(memoryPath, "logs");
  if (existsSync(logsDir)) {
    const logFiles = readdirSync(logsDir).filter(f => f.endsWith(".md"));
    for (const file of logFiles) {
      const content = readFileSync(join(logsDir, file), "utf-8");
      const parsed = parseMarkdown(content, "log");
      entries.push(...parsed);
    }
  }

  return entries;
}

/**
 * vectors.jsonからメタデータ（accessCount等）のみをvector_metadataテーブルに移行。
 * v1のembeddingは768次元（Gemini）、v2は384次元（ローカル）で互換性がないためスキップ。
 */
function migrateVectorMetadata(
  db: Database.Database,
  memoryPath: string,
  migratedIds: Set<string>,
): number {
  const vectorsPath = join(memoryPath, "vectors.json");
  if (!existsSync(vectorsPath)) {
    return 0;
  }

  const raw = readFileSync(vectorsPath, "utf-8");
  const vectorsData: V1VectorsJson = JSON.parse(raw);

  const insertMetadata = db.prepare(`
    INSERT OR IGNORE INTO vector_metadata (id, access_count, created_at, last_accessed_at)
    VALUES (?, ?, ?, ?)
  `);

  let count = 0;
  for (const [id, meta] of Object.entries(vectorsData.entries)) {
    // memoriesに存在するエントリのメタデータのみ移行
    if (!migratedIds.has(id)) {
      continue;
    }

    const result = insertMetadata.run(
      id,
      meta.accessCount,
      meta.createdAt,
      meta.lastAccessedAt,
    );
    if (result.changes > 0) {
      count++;
    }
  }

  return count;
}
