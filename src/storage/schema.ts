import type Database from "better-sqlite3";

export const CURRENT_SCHEMA_VERSION = 4;

export const DDL = `
-- メモリエントリ本体
CREATE TABLE IF NOT EXISTS memories (
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
    scenario TEXT,
    why_core TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);
CREATE INDEX IF NOT EXISTS idx_memories_timestamp ON memories(timestamp DESC);

-- FTS5全文検索（日本語の部分文字列マッチに対応するためtrigramを採用）
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    title,
    content,
    tags,
    content=memories,
    content_rowid=rowid,
    tokenize='trigram'
);

-- FTS5同期トリガー
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, title, content, tags)
    VALUES (new.rowid, new.title, new.content, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, title, content, tags)
    VALUES ('delete', old.rowid, old.title, old.content, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, title, content, tags)
    VALUES ('delete', old.rowid, old.title, old.content, old.tags);
    INSERT INTO memories_fts(rowid, title, content, tags)
    VALUES (new.rowid, new.title, new.content, new.tags);
END;

-- ベクトルメタデータ（アクセス追跡）
CREATE TABLE IF NOT EXISTS vector_metadata (
    id TEXT PRIMARY KEY,
    access_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_accessed_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (id) REFERENCES memories(id) ON DELETE CASCADE
);

-- 短期退避テーブル
CREATE TABLE IF NOT EXISTS stash (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    summary TEXT NOT NULL,
    file_path TEXT,
    file_type TEXT,
    line_count INTEGER,
    session_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stash_expires ON stash(expires_at);

-- 統合キャッシュ
CREATE TABLE IF NOT EXISTS consolidated (
    type TEXT PRIMARY KEY CHECK(type IN ('dont','config')),
    data TEXT NOT NULL,
    source_entry_count INTEGER NOT NULL,
    consolidated_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
);

-- テーマレジストリ
CREATE TABLE IF NOT EXISTS themes (
    name TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- セッショントピック
CREATE TABLE IF NOT EXISTS session_topics (
    project TEXT NOT NULL,
    topic TEXT NOT NULL,
    session_at TEXT NOT NULL,
    PRIMARY KEY (project)
);

-- スキーマバージョン管理
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export function initializeSchema(db: Database.Database): void {
  // WALモード有効化
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");

  // DDL実行
  db.exec(DDL);

  // スキーマバージョン記録（冪等）
  const currentVersion = getSchemaVersion(db);
  if (currentVersion < CURRENT_SCHEMA_VERSION) {
    db.prepare(
      "INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, datetime('now'))"
    ).run(CURRENT_SCHEMA_VERSION);
  }
}

export function getSchemaVersion(db: Database.Database): number {
  try {
    const row = db.prepare("SELECT MAX(version) as version FROM schema_version").get() as { version: number | null } | undefined;
    return row?.version ?? 0;
  } catch {
    // schema_versionテーブルが存在しない場合
    return 0;
  }
}

export const VECTORS_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS vectors USING vec0(
    id TEXT PRIMARY KEY,
    embedding float[384]
);
`;

export function initializeVectors(db: Database.Database): void {
  db.exec(VECTORS_DDL);
}
