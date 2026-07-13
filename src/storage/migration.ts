import type Database from "better-sqlite3";
import { existsSync, readFileSync, readdirSync, mkdirSync, cpSync } from "fs";
import { join } from "path";
import { MemoryCategory, MemoryEntry } from "../types.js";
import { parseMarkdown } from "./parser.js";
import { getSchemaVersion } from "./schema.js";
import { DEFAULT_MODEL } from "../vector/local-embedding.js";
import { computeContentHash } from "./content-hash.js";

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
 * v3→v4 マイグレーション
 *
 * 変更内容:
 *   - memories に scenario TEXT カラムを追加（NULL 許容）
 *   - memories に why_core TEXT カラムを追加（NULL 許容）
 *
 * 動作:
 *   - scenario カラムが既に存在するならスキップ（冪等）
 */
export function migrateV3ToV4(db: Database.Database): void {
  const scenarioExists = (db.prepare(
    "SELECT COUNT(*) as cnt FROM pragma_table_info('memories') WHERE name = 'scenario'"
  ).get() as { cnt: number }).cnt > 0;

  if (scenarioExists) {
    return;
  }

  const transaction = db.transaction(() => {
    db.exec(`ALTER TABLE memories ADD COLUMN scenario TEXT`);
    db.exec(`ALTER TABLE memories ADD COLUMN why_core TEXT`);

    db.prepare(
      "INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, datetime('now'))"
    ).run(4);
  });

  transaction();
}

/**
 * v4→v5 マイグレーション（予測誤差ループ spec）
 *
 * 変更内容:
 *   - memories に predicted_factors TEXT カラムを追加（NULL 許容・JSON配列文字列）
 *   - memories に actual_factors TEXT カラムを追加（NULL 許容・JSON配列文字列）
 *   - memories に prediction_error REAL カラムを追加（NULL 許容・0〜1）
 *   - memories に prediction_delta TEXT カラムを追加（NULL 許容）
 *
 * 動作:
 *   - predicted_factors カラムが既に存在するならスキップ（冪等）
 */
export function migrateV4ToV5(db: Database.Database): void {
  const columnExists = (db.prepare(
    "SELECT COUNT(*) as cnt FROM pragma_table_info('memories') WHERE name = 'predicted_factors'"
  ).get() as { cnt: number }).cnt > 0;

  if (columnExists) {
    return;
  }

  const transaction = db.transaction(() => {
    db.exec(`ALTER TABLE memories ADD COLUMN predicted_factors TEXT`);
    db.exec(`ALTER TABLE memories ADD COLUMN actual_factors TEXT`);
    db.exec(`ALTER TABLE memories ADD COLUMN prediction_error REAL`);
    db.exec(`ALTER TABLE memories ADD COLUMN prediction_delta TEXT`);

    db.prepare(
      "INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, datetime('now'))"
    ).run(5);
  });

  transaction();
}

/**
 * 移行前バックアップ（migrateV5ToV6専用）。
 *
 * scripts/backup-store.ts の全量バックアップ（better-sqlite3のオンラインbackup() API）は
 * Promise を返す非同期APIのため、同期の migrate*系関数群からは呼べない
 * （呼び出し元 SQLiteStorage.initialize() を非同期化すると、consolidator/persistence-helper.ts
 * 等の同期呼び出し境界まで連鎖的に壊れる。Phase 1 の non-goals「触ってはいけない領域」に
 * 抵触するため、ここでは同期専用の軽量バックアップを別途用意する）。
 *
 * 手順: WALチェックポイントをTRUNCATEモードで強制実行し、mainのDBファイルにWAL内容を
 * 反映させてから、そのファイルを同期的にコピーする。コピー失敗（ディレクトリ作成不能等）は
 * そのままthrowし、呼び出し元は後続のALTER TABLEへ進まない（fail-loud、移行中止）。
 */
function backupBeforeV6Migration(db: Database.Database, memoryPath: string): void {
  const dbFilePath = db.name;
  if (!dbFilePath || dbFilePath === ":memory:") {
    // インメモリDB（テストの一部）はファイルバックアップ対象外
    return;
  }

  db.pragma("wal_checkpoint(TRUNCATE)");

  const backupDir = join(memoryPath, "migration-backups");
  mkdirSync(backupDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(backupDir, `pre-v6-migration-${timestamp}.db`);
  cpSync(dbFilePath, backupPath);
}

/**
 * v5→v6 マイグレーション（memory-redesign spec Phase 1「土台」）
 *
 * 版数注記: v5は予測誤差ループ（コミット8b915a5）で占有済みのため、本Specの土台列移行は
 * v6となる（design.md版数連鎖、タスク0.0のv5ベースライン参照）。
 *
 * 変更内容:
 *   - memories に state TEXT NOT NULL DEFAULT 'active'（CHECK: active/archived/deleted）を追加
 *     既存行は deleted_at IS NULL → active、それ以外 → deleted へバックフィルする
 *   - memories に project_confidence TEXT NOT NULL DEFAULT 'unknown'（CHECK: confirmed/inferred/unknown）を追加
 *   - vector_metadata に embedding_model TEXT NOT NULL DEFAULT <現行モデル識別子> を追加し、
 *     既存行を現行モデル識別子でバックフィルする（タスク1.9で全件再埋め込み済みのため事実と一致）
 *
 * 動作:
 *   - 移行開始前に軽量バックアップ（WALチェックポイント+ファイルコピー）を実行する。
 *     バックアップに失敗したら移行を中止する（ALTER TABLEを一切実行しない）
 *   - state カラムが既に存在するならスキップ（冪等）
 *   - 全操作を db.transaction() 内で実行し、失敗時は自動ロールバック
 */
export function migrateV5ToV6(db: Database.Database, memoryPath: string): void {
  const stateColumnExists = (db.prepare(
    "SELECT COUNT(*) as cnt FROM pragma_table_info('memories') WHERE name = 'state'"
  ).get() as { cnt: number }).cnt > 0;

  if (stateColumnExists) {
    return;
  }

  // バックアップ失敗時はここでthrowし、以降のALTER TABLEには進まない（移行中止）。
  backupBeforeV6Migration(db, memoryPath);

  const transaction = db.transaction(() => {
    db.exec(
      `ALTER TABLE memories ADD COLUMN state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','archived','deleted'))`
    );
    db.exec(`UPDATE memories SET state = 'deleted' WHERE deleted_at IS NOT NULL`);

    db.exec(
      `ALTER TABLE memories ADD COLUMN project_confidence TEXT NOT NULL DEFAULT 'unknown' CHECK(project_confidence IN ('confirmed','inferred','unknown'))`
    );

    // vector_metadataは、initializeSchema()のCREATE TABLE IF NOT EXISTSが本メソッド呼び出しより
    // 前に走った際、テーブル自体が未存在だった場合は既にembedding_model込みで新規作成されている
    // ことがある（memoriesは呼び出し元でmemoriesTableExists===trueの場合のみこの関数を呼ぶため
    // 常にALTER対象になるが、vector_metadataは独立して存在有無が分かれるため個別に存在確認する）。
    const embeddingModelColumnExists = (db.prepare(
      "SELECT COUNT(*) as cnt FROM pragma_table_info('vector_metadata') WHERE name = 'embedding_model'"
    ).get() as { cnt: number }).cnt > 0;
    if (!embeddingModelColumnExists) {
      db.exec(
        `ALTER TABLE vector_metadata ADD COLUMN embedding_model TEXT NOT NULL DEFAULT '${DEFAULT_MODEL}'`
      );
    }

    db.prepare(
      "INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, datetime('now'))"
    ).run(6);
  });

  transaction();
}

/**
 * v6→v7 マイグレーション（content-hash dedup 土台）
 *
 * 変更内容:
 *   - memories に content_hash TEXT カラムを追加（NULL 許容）
 *   - 既存の全行（state問わず）へ content-hash.ts の computeContentHash() を適用してバックフィル
 *   - idx_memories_content_hash インデックスを作成（非UNIQUE。既存重複行の存在によりUNIQUE制約は
 *     移行自体を失敗させるため、今回は「これ以上増やさない」引き算機構の第一弾に留める）
 *
 * 動作:
 *   - content_hash カラムが既に存在するならスキップ（冪等）
 *   - ALTER TABLE ADD COLUMN のみでロスレスなため、v5→v6と異なりバックアップ処理は不要
 *   - バックフィルはUPDATEのみでDELETEは一切行わない（非破壊）
 */
export function migrateV6ToV7(db: Database.Database): void {
  const columnExists = (db.prepare(
    "SELECT COUNT(*) as cnt FROM pragma_table_info('memories') WHERE name = 'content_hash'"
  ).get() as { cnt: number }).cnt > 0;

  if (columnExists) {
    return;
  }

  const transaction = db.transaction(() => {
    db.exec(`ALTER TABLE memories ADD COLUMN content_hash TEXT`);

    const rows = db.prepare(
      "SELECT id, project, scope, category, title, content FROM memories"
    ).all() as Array<{
      id: string;
      project: string | null;
      scope: string | null;
      category: string;
      title: string;
      content: string;
    }>;

    const updateStmt = db.prepare("UPDATE memories SET content_hash = ? WHERE id = ?");
    for (const row of rows) {
      const hash = computeContentHash({
        project: row.project ?? undefined,
        scope: row.scope ?? undefined,
        category: row.category,
        title: row.title,
        content: row.content,
      });
      updateStmt.run(hash, row.id);
    }

    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_memories_content_hash ON memories(content_hash, category, project, scope)"
    );

    db.prepare(
      "INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, datetime('now'))"
    ).run(7);
  });

  transaction();
}

/**
 * v7→v8 マイグレーション（埋め込み非依存の最終読取時刻の土台列）
 *
 * 変更内容:
 *   - memories に last_read_at TEXT カラムを追加（NULL 許容・デフォルト値なし）
 *
 * 動作:
 *   - last_read_at カラムが既に存在するならスキップ（列存在チェックで冪等・2回目呼び出しはno-op）
 *   - ALTER TABLE ADD COLUMN のみでロスレスなため、v5→v6と異なりバックアップ処理は不要
 *   - migrateV6ToV7（content_hash）と異なり、既存行への一括UPDATEバックフィルを一切行わない。
 *     既存行は last_read_at=NULL のまま残し、「まだ最終読取時刻を計測していない」という欠損を
 *     そのまま保持する（本番DBの大規模UPDATEに伴うロック・所要時間のリスクを回避する）。
 *     忘却 dry-run（forgetting-sweep.ts）が COALESCE(last_read_at, updated_at) で updated_at へ
 *     フォールバックし、NULL 起因の候補を never_tracked として分離集計することで、移行直後の
 *     代理指標と実測の最終読取時刻に基づく候補を区別してレポートに載せる。
 */
export function migrateV7ToV8(db: Database.Database): void {
  const columnExists = (db.prepare(
    "SELECT COUNT(*) as cnt FROM pragma_table_info('memories') WHERE name = 'last_read_at'"
  ).get() as { cnt: number }).cnt > 0;

  if (columnExists) {
    return;
  }

  const transaction = db.transaction(() => {
    db.exec(`ALTER TABLE memories ADD COLUMN last_read_at TEXT`);

    db.prepare(
      "INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, datetime('now'))"
    ).run(8);
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
