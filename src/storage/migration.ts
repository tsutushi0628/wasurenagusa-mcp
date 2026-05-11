import type Database from "better-sqlite3";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { MemoryCategory, MemoryEntry } from "../types.js";
import { parseMarkdown } from "./parser.js";
import { getSchemaVersion } from "./schema.js";

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
 * memories テーブルの idx と FTS5 トリガーを再作成する。
 * テーブル再構築（DROP → RENAME）後の整合性回復に使う。
 */
function recreateMemoriesIndexesAndTriggers(db: Database.Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
    CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);
    CREATE INDEX IF NOT EXISTS idx_memories_timestamp ON memories(timestamp DESC);

    DROP TRIGGER IF EXISTS memories_ai;
    DROP TRIGGER IF EXISTS memories_ad;
    DROP TRIGGER IF EXISTS memories_au;

    CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, title, content, tags)
        VALUES (new.rowid, new.title, new.content, new.tags);
    END;
    CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, title, content, tags)
        VALUES ('delete', old.rowid, old.title, old.content, old.tags);
    END;
    CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, title, content, tags)
        VALUES ('delete', old.rowid, old.title, old.content, old.tags);
        INSERT INTO memories_fts(rowid, title, content, tags)
        VALUES (new.rowid, new.title, new.content, new.tags);
    END;
  `);
}

/**
 * v1→v2 マイグレーション（heart-extension spec）
 *
 * 変更内容:
 *   - memories.category の CHECK 制約を 5値→7値（dream, success 追加）に拡張
 *   - memories に knowledge_gap TEXT カラムを追加（NULL 許容）
 *   - 関連 idx と FTS5 トリガーを再作成
 *
 * 動作:
 *   - schema_version >= 2 ならスキップ（冪等）
 *   - SQLite はテーブル再作成方式（CREATE NEW → INSERT SELECT → DROP OLD → RENAME）
 *   - 全操作を `db.transaction()` 内で実行し、失敗時は自動ロールバック
 */
export function migrateV1ToV2_categoryAndKnowledgeGap(db: Database.Database): void {
  // 冪等チェック: 既に v2 以上なら何もしない
  if (getSchemaVersion(db) >= 2) {
    return;
  }

  const transaction = db.transaction(() => {
    // 既存 FTS5 トリガーを先に落とす（INSERT SELECT 中の FTS 同期を避ける）
    db.exec(`
      DROP TRIGGER IF EXISTS memories_ai;
      DROP TRIGGER IF EXISTS memories_ad;
      DROP TRIGGER IF EXISTS memories_au;
    `);

    // 新スキーマで memories_new を作成
    db.exec(`
      CREATE TABLE memories_new (
          id TEXT PRIMARY KEY,
          timestamp TEXT NOT NULL,
          category TEXT NOT NULL CHECK(category IN ('config','dont','decision','log','snippet','dream','success')),
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          tags TEXT NOT NULL DEFAULT '[]',
          project TEXT,
          scope TEXT,
          intensity INTEGER,
          knowledge_gap TEXT,
          positive_action TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // 旧データをコピー（knowledge_gap は NULL で初期化）
    db.exec(`
      INSERT INTO memories_new (id, timestamp, category, title, content, tags, project, scope, intensity, knowledge_gap, created_at, updated_at)
      SELECT id, timestamp, category, title, content, tags, project, scope, intensity, NULL, created_at, updated_at
      FROM memories;
    `);

    // 旧テーブル削除 → リネーム
    db.exec(`DROP TABLE memories;`);
    db.exec(`ALTER TABLE memories_new RENAME TO memories;`);

    // FTS5 索引と memories_fts の整合再構築
    // memories_fts は外部 content テーブルとして memories を参照しているので
    // rowid が変わった可能性に備えて rebuild する
    db.exec(`INSERT INTO memories_fts(memories_fts) VALUES('rebuild');`);

    // idx と FTS5 トリガーを再作成
    recreateMemoriesIndexesAndTriggers(db);

    // schema_version を 2 に更新
    db.prepare(
      "INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, datetime('now'))"
    ).run(2);
  });

  transaction();
}

/**
 * v2→v3 マイグレーション
 *
 * 変更内容:
 *   - memories に positive_action TEXT カラムを追加（NULL 許容）
 *
 * 動作:
 *   - positive_action カラムが既に存在するならスキップ（冪等）
 *   - SQLite の ALTER TABLE ADD COLUMN で安全に追加（既存データ保持）
 */
export function migrateV2ToV3(db: Database.Database): void {
  const columnExists = (db.prepare(
    "SELECT COUNT(*) as cnt FROM pragma_table_info('memories') WHERE name = 'positive_action'"
  ).get() as { cnt: number }).cnt > 0;

  if (columnExists) {
    return;
  }

  const transaction = db.transaction(() => {
    db.exec(`ALTER TABLE memories ADD COLUMN positive_action TEXT`);

    db.prepare(
      "INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, datetime('now'))"
    ).run(3);
  });

  transaction();
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
