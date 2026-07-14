import type Database from "better-sqlite3";
import { DEFAULT_MODEL } from "../vector/local-embedding.js";

export const CURRENT_SCHEMA_VERSION = 10;

// 系譜テーブル（追記型マージ・supersedes の記録。design.md「lineage」定義に厳密準拠）。
// 新規DBは DDL 経由、旧世代DBは migrateV8ToV9 経由で同一定義から作られる（単一真実源）。
export const LINEAGE_DDL = `
CREATE TABLE IF NOT EXISTS lineage (
    id TEXT PRIMARY KEY,
    child_id TEXT NOT NULL,
    parent_id TEXT NOT NULL,
    relation TEXT NOT NULL CHECK (relation IN ('merged_from','supersedes')),
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lineage_child ON lineage(child_id);
CREATE INDEX IF NOT EXISTS idx_lineage_parent ON lineage(parent_id);
`;

// 確定原則テーブル（昇格の人間ゲート。design.md「principles」定義に厳密準拠）。
export const PRINCIPLES_DDL = `
CREATE TABLE IF NOT EXISTS principles (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    origin_tier TEXT NOT NULL CHECK (origin_tier IN ('owner_confirmed','agent_observed')),
    evidence_ids TEXT NOT NULL,
    valid_until TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('proposed','approved','expired','rejected')),
    approved_at TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_principles_state ON principles(state, valid_until);
`;

// 承認制ガードレジストリテーブル（design.md「guards」定義。memory-redesign spec Phase 4）。
// 版数注記: design.md/tasks.md は「v8移行」と規定していたが、実コードでは v7=content_hash・
// v8=last_read_at・v9=lineage/principles が既に版数を占有済みのため、guards テーブルの土台は
// migrateV9ToV10 として実装する（テーブル定義・列・CHECK制約は design.md の定義に厳密に従い、
// 版数だけを繰り下げた。v8→v9 の版数注記コメントと同じ作法）。
// 新規DBは DDL 経由、旧世代DBは migrateV9ToV10 経由で同一定義から作られる（単一真実源）。
export const GUARDS_DDL = `
CREATE TABLE IF NOT EXISTS guards (
    id TEXT PRIMARY KEY,
    pattern TEXT NOT NULL,
    source_incident_id TEXT NOT NULL,
    approved_at TEXT,
    expires_at TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('proposed','active','expired','disabled')),
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_guards_state ON guards(state, expires_at);
`;

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
    predicted_factors TEXT,
    actual_factors TEXT,
    prediction_error REAL,
    prediction_delta TEXT,
    deleted_at TEXT,
    state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','archived','deleted')),
    project_confidence TEXT NOT NULL DEFAULT 'unknown' CHECK(project_confidence IN ('confirmed','inferred','unknown')),
    content_hash TEXT,
    last_read_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);
CREATE INDEX IF NOT EXISTS idx_memories_timestamp ON memories(timestamp DESC);
-- idx_memories_content_hash はここでは作らない: content_hash は state/project_confidence と同じく
-- 後発マイグレーション列のため、旧世代DB（CREATE TABLE IF NOT EXISTSがno-opでcontent_hash列が
-- まだ無い）に対してこのDDLを実行するとCREATE INDEXが未知列エラーで失敗する。新規DBには
-- initializeSchema()側でcontent_hash列存在チェック後に作成し、旧世代DBにはmigrateV6ToV7で作成する。

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
    embedding_model TEXT NOT NULL DEFAULT '${DEFAULT_MODEL}',
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
${LINEAGE_DDL}
${PRINCIPLES_DDL}
${GUARDS_DDL}
`;

export function initializeSchema(db: Database.Database): void {
  // WALモード有効化
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");

  // DDL実行
  db.exec(DDL);

  // content_hash列が存在する場合のみインデックスを作成する（新規DB＝DDLのCREATE TABLEで
  // content_hash列込みで作られた直後のケース。旧世代DBはここではまだ列が無く、
  // migrateV6ToV7が列追加とインデックス作成を担う）。
  const contentHashColumnExists = (db.prepare(
    "SELECT COUNT(*) as cnt FROM pragma_table_info('memories') WHERE name = 'content_hash'"
  ).get() as { cnt: number }).cnt > 0;
  if (contentHashColumnExists) {
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_memories_content_hash ON memories(content_hash, category, project, scope)"
    );
  }

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
