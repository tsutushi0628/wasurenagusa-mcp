import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { randomBytes } from "crypto";
import {
  MemoryCategory,
  MemoryEntry,
  MemoryIndexEntry,
  SaveParams,
  SaveResult,
  SearchParams,
  SearchResult,
  GetDetailParams,
  GetDetailResult,
  DeleteParams,
  DeleteResult,
  ContextResult,
  StashParams,
  StashResult,
  RestoreResult,
  ConsolidatedDont,
  ConsolidatedConfig,
} from "../types.js";
import { config } from "../config.js";
import { initializeSchema, initializeVectors, getSchemaVersion, CURRENT_SCHEMA_VERSION } from "./schema.js";
import { migrateV1ToV2, migrateV1ToV2_categoryAndKnowledgeGap } from "./migration.js";
import { existsSync } from "fs";
import { join } from "path";
import { formatEntry } from "./formatter.js";

export interface VectorSearchResult {
  id: string;
  distance: number;
}

export class SQLiteStorage {
  private db: Database.Database;
  private vecLoaded = false;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
  }

  initialize(memoryPath?: string): void {
    // 既存DB（v1スキーマ）の場合、initializeSchema は CREATE TABLE IF NOT EXISTS のため
    // CHECK制約が古いまま残る。schema_version を見て v1→v2 マイグレーションを先に走らせる。
    const preExistingVersion = getSchemaVersion(this.db);
    const memoriesTableExists = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'")
      .get() !== undefined;

    if (memoriesTableExists && preExistingVersion < 2) {
      migrateV1ToV2_categoryAndKnowledgeGap(this.db);
    }

    initializeSchema(this.db);

    // 自動マイグレーション: DB新規作成 AND v1ファイル存在 → マイグレーション実行
    if (memoryPath && this.shouldAutoMigrate(memoryPath)) {
      migrateV1ToV2(this.db, memoryPath);
    }
    this.loadVecExtension();
  }

  private loadVecExtension(): void {
    if (this.vecLoaded) return;
    try {
      sqliteVec.load(this.db);
      initializeVectors(this.db);
      this.vecLoaded = true;
    } catch (error) {
      throw error;
    }
  }

  private generateId(): string {
    const timestamp = Date.now().toString(36);
    const random = randomBytes(2).toString("hex");
    return `${timestamp}-${random}`;
  }

  private generateTimestamp(): string {
    const now = new Date();
    const jstOffset = 9 * 60 * 60 * 1000;
    const jst = new Date(now.getTime() + jstOffset);
    return jst.toISOString().replace("Z", "+09:00");
  }

  // --- MemoryEntry CRUD ---

  save(params: SaveParams): SaveResult {
    const id = this.generateId();
    const timestamp = this.generateTimestamp();
    const tags = JSON.stringify(params.tags ?? []);
    // knowledgeGap は undefined なら NULL、配列（空含む）なら JSON 文字列で保存
    const knowledgeGap = params.knowledgeGap !== undefined ? JSON.stringify(params.knowledgeGap) : null;

    if (params.replaceId) {
      const existing = this.db.prepare("SELECT id FROM memories WHERE id = ?").get(params.replaceId) as { id: string } | undefined;
      if (existing) {
        const updateStmt = this.db.prepare(`
          UPDATE memories SET
            timestamp = ?, category = ?, title = ?, content = ?, tags = ?,
            project = ?, scope = ?, intensity = ?, knowledge_gap = ?, updated_at = datetime('now')
          WHERE id = ?
        `);
        updateStmt.run(
          timestamp, params.category, params.title, params.content, tags,
          params.project ?? null, params.scope ?? null, params.intensity ?? null,
          knowledgeGap,
          params.replaceId
        );
        return {
          success: true,
          id: params.replaceId,
          path: "sqlite",
          message: `Replaced ${params.replaceId} in ${params.category}`,
        };
      }
    }

    const insertStmt = this.db.prepare(`
      INSERT INTO memories (id, timestamp, category, title, content, tags, project, scope, intensity, knowledge_gap)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertStmt.run(
      id, timestamp, params.category, params.title, params.content, tags,
      params.project ?? null, params.scope ?? null, params.intensity ?? null,
      knowledgeGap
    );

    return {
      success: true,
      id,
      path: "sqlite",
      message: `Saved to ${params.category} (id: ${id})`,
    };
  }

  getDetail(params: GetDetailParams): GetDetailResult {
    const entries: MemoryEntry[] = [];
    const notFound: string[] = [];

    for (const id of params.ids) {
      const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as MemoryRow | undefined;
      if (row) {
        entries.push(this.rowToEntry(row));
      } else {
        notFound.push(id);
      }
    }

    return { entries, notFound };
  }

  delete(params: DeleteParams): DeleteResult {
    const deleted: string[] = [];
    const notFound: string[] = [];

    const deleteMemory = this.db.prepare("DELETE FROM memories WHERE id = ?");

    for (const id of params.ids) {
      const existing = this.db.prepare("SELECT id FROM memories WHERE id = ?").get(id) as { id: string } | undefined;
      if (existing) {
        deleteMemory.run(id);
        this.db.prepare("DELETE FROM vectors WHERE id = ?").run(id);
        deleted.push(id);
      } else {
        notFound.push(id);
      }
    }

    return { deleted, notFound };
  }

  updateIntensity(id: string, intensity: number): { success: boolean; id: string; category: MemoryCategory } {
    const row = this.db.prepare("SELECT category FROM memories WHERE id = ?").get(id) as { category: MemoryCategory } | undefined;
    if (!row) {
      throw new Error(`Entry not found: ${id}`);
    }

    this.db.prepare("UPDATE memories SET intensity = ?, updated_at = datetime('now') WHERE id = ?").run(intensity, id);

    return { success: true, id, category: row.category };
  }

  search(params: SearchParams): SearchResult {
    const limit = params.limit ?? config.defaultSearchLimit;
    let query: string;
    const queryParams: (string | number)[] = [];

    const trimmedQuery = params.query ? params.query.trim() : "";
    const usesFts = trimmedQuery.length >= 3;
    const usesLike = trimmedQuery.length > 0 && trimmedQuery.length < 3;

    if (usesFts) {
      query = `
        SELECT m.* FROM memories m
        INNER JOIN memories_fts fts ON m.rowid = fts.rowid
        WHERE memories_fts MATCH ?
      `;
      queryParams.push(this.escapeFtsQuery(params.query!));
    } else if (usesLike) {
      const likePattern = `%${trimmedQuery}%`;
      query = `SELECT * FROM memories WHERE (title LIKE ? OR content LIKE ? OR tags LIKE ?)`;
      queryParams.push(likePattern, likePattern, likePattern);
    } else {
      query = "SELECT * FROM memories WHERE 1=1";
    }

    const prefix = usesFts ? "m." : "";
    if (params.category && params.category !== "all") {
      query += ` AND ${prefix}category = ?`;
      queryParams.push(params.category);
    }

    if (params.project) {
      query += ` AND (${prefix}project IS NULL OR ${prefix}project = ?)`;
      queryParams.push(params.project);
    }

    if (params.scope) {
      query += ` AND (${prefix}scope IS NULL OR ${prefix}scope = 'general' OR ${prefix}scope = ?)`;
      queryParams.push(params.scope);
    }

    const orderColumn = usesFts ? "m.timestamp" : "timestamp";
    query += ` ORDER BY ${orderColumn} DESC LIMIT ?`;
    queryParams.push(limit);

    const rows = this.db.prepare(query).all(...queryParams) as MemoryRow[];

    let countQuery: string;
    const countParams = queryParams.slice(0, -1);
    if (usesFts) {
      countQuery = `
        SELECT COUNT(*) as count FROM memories m
        INNER JOIN memories_fts fts ON m.rowid = fts.rowid
        WHERE memories_fts MATCH ?
      `;
    } else if (usesLike) {
      countQuery = "SELECT COUNT(*) as count FROM memories WHERE (title LIKE ? OR content LIKE ? OR tags LIKE ?)";
    } else {
      countQuery = "SELECT COUNT(*) as count FROM memories WHERE 1=1";
    }
    if (params.category && params.category !== "all") {
      countQuery += ` AND ${prefix}category = ?`;
    }
    if (params.project) {
      countQuery += ` AND (${prefix}project IS NULL OR ${prefix}project = ?)`;
    }
    if (params.scope) {
      countQuery += ` AND (${prefix}scope IS NULL OR ${prefix}scope = 'general' OR ${prefix}scope = ?)`;
    }

    const countRow = this.db.prepare(countQuery).get(...countParams) as { count: number };

    const indexEntries: MemoryIndexEntry[] = rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      category: row.category as MemoryCategory,
      title: row.title,
      tags: JSON.parse(row.tags),
      project: row.project ?? undefined,
      scope: row.scope ?? undefined,
      intensity: row.intensity ?? undefined,
    }));

    return {
      results: indexEntries,
      totalCount: countRow.count,
      hint: indexEntries.length > 0
        ? "詳細が必要なエントリのIDを memory_get_detail に渡してください。"
        : "該当するメモリが見つかりませんでした。",
    };
  }


  // --- ハイブリッド検索 (TASK-015) ---

  searchHybrid(params: SearchParams, queryEmbedding: number[]): SearchResult {
    const limit = params.limit ?? config.defaultSearchLimit;

    // 1. FTS5キーワード検索（3文字未満はLIKEフォールバック）
    const ftsIds = new Set<string>();
    if (params.query && params.query.trim()) {
      const trimmedQ = params.query.trim();
      let ftsQuery: string;
      const ftsParams: (string | number)[] = [];

      if (trimmedQ.length >= 3) {
        ftsQuery = `
          SELECT m.id FROM memories m
          INNER JOIN memories_fts fts ON m.rowid = fts.rowid
          WHERE memories_fts MATCH ?
        `;
        ftsParams.push(this.escapeFtsQuery(params.query));

        if (params.category && params.category !== "all") {
          ftsQuery += " AND m.category = ?";
          ftsParams.push(params.category);
        }
        if (params.project) {
          ftsQuery += " AND (m.project IS NULL OR m.project = ?)";
          ftsParams.push(params.project);
        }
        if (params.scope) {
          ftsQuery += " AND (m.scope IS NULL OR m.scope = 'general' OR m.scope = ?)";
          ftsParams.push(params.scope);
        }
      } else {
        const likePattern = `%${trimmedQ}%`;
        ftsQuery = `SELECT id FROM memories WHERE (title LIKE ? OR content LIKE ? OR tags LIKE ?)`;
        ftsParams.push(likePattern, likePattern, likePattern);

        if (params.category && params.category !== "all") {
          ftsQuery += " AND category = ?";
          ftsParams.push(params.category);
        }
        if (params.project) {
          ftsQuery += " AND (project IS NULL OR project = ?)";
          ftsParams.push(params.project);
        }
        if (params.scope) {
          ftsQuery += " AND (scope IS NULL OR scope = 'general' OR scope = ?)";
          ftsParams.push(params.scope);
        }
      }

      ftsQuery += ` LIMIT ?`;
      ftsParams.push(limit);

      const ftsRows = this.db.prepare(ftsQuery).all(...ftsParams) as { id: string }[];
      for (const row of ftsRows) {
        ftsIds.add(row.id);
      }
    }

    // 2. ベクトルKNN検索
    const vectorResults = this.searchVectors(queryEmbedding, 999, limit);
    const vectorDistanceMap = new Map<string, number>();
    for (const vr of vectorResults) {
      vectorDistanceMap.set(vr.id, vr.distance);
    }

    // 3. IDをUNION
    const allIds = new Set<string>([...ftsIds, ...vectorResults.map((r) => r.id)]);

    // 4. project/scopeフィルタ + エントリ取得
    const entries: MemoryIndexEntry[] = [];
    for (const id of allIds) {
      const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as MemoryRow | undefined;
      if (!row) continue;

      if (params.project && row.project !== null && row.project !== params.project) {
        continue;
      }
      if (params.scope && row.scope !== null && row.scope !== "general" && row.scope !== params.scope) {
        continue;
      }
      if (params.category && params.category !== "all" && row.category !== params.category) {
        continue;
      }

      entries.push({
        id: row.id,
        timestamp: row.timestamp,
        category: row.category as MemoryCategory,
        title: row.title,
        tags: JSON.parse(row.tags),
        project: row.project ?? undefined,
        scope: row.scope ?? undefined,
        intensity: row.intensity ?? undefined,
      });
    }

    entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    const limited = entries.slice(0, limit);

    return {
      results: limited,
      totalCount: entries.length,
      hint: limited.length > 0
        ? "詳細が必要なエントリのIDを memory_get_detail に渡してください。"
        : "該当するメモリが見つかりませんでした。",
    };
  }

  getContext(currentProject?: string): ContextResult {
    const configEntries = this.readConfigEntries(currentProject);
    const dedupedConfig = this.deduplicateConfigEntries(configEntries);
    const configFormatted = dedupedConfig
      .map((e) => `### ${e.title}\n${e.content}`)
      .join("\n\n");

    const dontEntries = this.readDontEntries(currentProject);
    const dontFormatted = dontEntries.map((e) => formatEntry(e)).join("");

    return {
      config: configFormatted || "（設定情報なし）",
      dont: dontFormatted || "（ルールなし）",
    };
  }

  readConfigEntries(currentProject?: string): MemoryEntry[] {
    return this.readEntriesByCategory("config", currentProject);
  }

  readDontEntries(currentProject?: string): MemoryEntry[] {
    return this.readEntriesByCategory("dont", currentProject);
  }

  // --- ベクトル操作 (TASK-011〜014) ---

  upsertVector(id: string, embedding: number[]): void {
    const buf = this.embeddingToBuffer(embedding);
    this.db.prepare("DELETE FROM vectors WHERE id = ?").run(id);
    this.db.prepare("INSERT INTO vectors (id, embedding) VALUES (?, ?)").run(id, buf);

    this.db.prepare(`
      INSERT INTO vector_metadata (id, access_count, created_at, last_accessed_at)
      VALUES (?, 0, datetime('now'), datetime('now'))
      ON CONFLICT(id) DO UPDATE SET last_accessed_at = datetime('now')
    `).run(id);
  }

  deleteVectors(ids: string[]): void {
    const deleteVec = this.db.prepare("DELETE FROM vectors WHERE id = ?");
    const deleteMeta = this.db.prepare("DELETE FROM vector_metadata WHERE id = ?");

    for (const id of ids) {
      deleteVec.run(id);
      deleteMeta.run(id);
    }
  }

  searchVectors(queryEmbedding: number[], threshold: number, limit: number): VectorSearchResult[] {
    const buf = this.embeddingToBuffer(queryEmbedding);

    const rows = this.db.prepare(
      "SELECT id, distance FROM vectors WHERE embedding MATCH ? AND k = ?"
    ).all(buf, limit) as { id: string; distance: number }[];

    return rows.filter((row) => row.distance <= threshold);
  }

  incrementAccessCount(ids: string[]): void {
    const stmt = this.db.prepare(`
      UPDATE vector_metadata
      SET access_count = access_count + 1, last_accessed_at = datetime('now')
      WHERE id = ?
    `);

    for (const id of ids) {
      stmt.run(id);
    }
  }

  getVectorMetadata(ids: string[]): Map<string, { lastAccessedAt: string; accessCount: number }> {
    const result = new Map<string, { lastAccessedAt: string; accessCount: number }>();

    for (const id of ids) {
      const row = this.db.prepare(
        "SELECT access_count, last_accessed_at FROM vector_metadata WHERE id = ?"
      ).get(id) as { access_count: number; last_accessed_at: string } | undefined;

      if (row) {
        result.set(id, {
          lastAccessedAt: row.last_accessed_at,
          accessCount: row.access_count,
        });
      }
    }

    return result;
  }

  getEntriesWithoutEmbedding(): string[] {
    const rows = this.db.prepare(`
      SELECT m.id FROM memories m
      LEFT JOIN vector_metadata vm ON m.id = vm.id
      WHERE vm.id IS NULL
    `).all() as { id: string }[];

    return rows.map((row) => row.id);
  }

  // --- Stash操作 (TASK-016) ---

  stash(params: StashParams): StashResult {
    const id = this.generateId();
    const ttlHours = params.ttlHours ?? 24;
    const lines = params.content.split("\n");
    const lineCount = lines.length;

    // ルールベース要約
    let summary: string;
    if (lineCount <= 5) {
      summary = params.content;
    } else {
      const preview = lines.slice(0, 5).join("\n");
      const fileInfo = params.fileType ? `, ${params.fileType}` : "";
      summary = `${preview}\n... (全${lineCount}行${fileInfo})`;
    }

    this.db.prepare(`
      INSERT INTO stash (id, content, summary, file_path, file_type, line_count, session_id, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '+${ttlHours} hours'))
    `).run(
      id, params.content, summary,
      params.filePath ?? null, params.fileType ?? null,
      lineCount, params.sessionId ?? null
    );

    const row = this.db.prepare("SELECT expires_at FROM stash WHERE id = ?").get(id) as { expires_at: string };

    return { id, summary, expiresAt: row.expires_at };
  }

  restore(id: string): RestoreResult {
    const row = this.db.prepare("SELECT content, expires_at FROM stash WHERE id = ?").get(id) as
      { content: string; expires_at: string } | undefined;

    if (!row) {
      return { found: false, message: `Stash entry not found: ${id}` };
    }

    // TTL確認
    const now = this.db.prepare("SELECT datetime('now') as now").get() as { now: string };
    if (row.expires_at <= now.now) {
      return { found: false, expired: true, message: `Stash entry expired: ${id}` };
    }

    return { found: true, content: row.content, message: "Restored successfully" };
  }

  cleanExpiredStash(): number {
    const result = this.db.prepare("DELETE FROM stash WHERE expires_at <= datetime('now')").run();
    return result.changes;
  }

  // --- 統合キャッシュ (TASK-019) ---

  readConsolidated(type: "dont" | "config"): ConsolidatedDont | ConsolidatedConfig | null {
    const row = this.db.prepare("SELECT data FROM consolidated WHERE type = ?").get(type) as { data: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.data);
  }

  writeConsolidated(type: "dont" | "config", data: ConsolidatedDont | ConsolidatedConfig): void {
    const sourceEntryCount = "principles" in data ? data.sourceEntryCount : data.sourceEntryCount;
    const consolidatedAt = "principles" in data ? data.consolidatedAt : data.consolidatedAt;
    const version = data.version;

    this.db.prepare(`
      INSERT INTO consolidated (type, data, source_entry_count, consolidated_at, version)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(type) DO UPDATE SET
        data = excluded.data,
        source_entry_count = excluded.source_entry_count,
        consolidated_at = excluded.consolidated_at,
        version = excluded.version
    `).run(type, JSON.stringify(data), sourceEntryCount, consolidatedAt, version);
  }

  isConsolidationStale(type: "dont" | "config"): boolean {
    const consolidated = this.db.prepare(
      "SELECT source_entry_count FROM consolidated WHERE type = ?"
    ).get(type) as { source_entry_count: number } | undefined;

    if (!consolidated) return true;

    const currentCount = this.db.prepare(
      "SELECT COUNT(*) as count FROM memories WHERE category = ?"
    ).get(type) as { count: number };

    return currentCount.count !== consolidated.source_entry_count;
  }

  // --- テーマ (TASK-020) ---

  getThemes(): string[] {
    const rows = this.db.prepare("SELECT name FROM themes ORDER BY name").all() as { name: string }[];
    return rows.map((r) => r.name);
  }

  addThemes(themes: string[]): void {
    const stmt = this.db.prepare("INSERT OR IGNORE INTO themes (name) VALUES (?)");
    for (const theme of themes) {
      stmt.run(theme);
    }
  }

  isNewTheme(theme: string): boolean {
    const row = this.db.prepare("SELECT COUNT(*) as count FROM themes WHERE name = ?").get(theme) as { count: number };
    return row.count === 0;
  }

  // --- セッショントピック (TASK-021) ---

  getSessionTopic(project: string): string | null {
    const row = this.db.prepare("SELECT topic FROM session_topics WHERE project = ?").get(project) as { topic: string } | undefined;
    return row?.topic ?? null;
  }

  setSessionTopic(project: string, topic: string): void {
    this.db.prepare(`
      INSERT INTO session_topics (project, topic, session_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(project) DO UPDATE SET
        topic = excluded.topic,
        session_at = excluded.session_at
    `).run(project, topic);
  }

  // --- DB管理 ---

  needsMigration(memoryPath?: string): boolean {
    if (!memoryPath) return false;
    return this.shouldAutoMigrate(memoryPath);
  }

  private shouldAutoMigrate(memoryPath: string): boolean {
    // memoriesテーブルにデータがある → マイグレーション済み
    const count = this.db.prepare("SELECT COUNT(*) as count FROM memories").get() as { count: number };
    if (count.count > 0) return false;

    // v1のmdファイルが存在するか確認
    const v1Files = ["config.md", "dont.md", "decisions.md", "snippets.md"];
    const hasV1Files = v1Files.some(f => existsSync(join(memoryPath, f)));
    const hasLogs = existsSync(join(memoryPath, "logs"));

    return hasV1Files || hasLogs;
  }

  close(): void {
    this.db.close();
  }

  // --- private helpers ---

  private embeddingToBuffer(embedding: number[]): Buffer {
    return Buffer.from(new Float32Array(embedding).buffer);
  }

  // 高強度dont（intensity>=minIntensity）の軽量インデックスを取得（再発防止リスト用）
  listHighIntensityDonts(minIntensity: number, limit: number): Array<{
    id: string;
    timestamp: string;
    category: MemoryCategory;
    title: string;
    tags: string[];
    project?: string;
    scope?: string;
    intensity?: number;
  }> {
    const rows = this.db
      .prepare(
        "SELECT id, timestamp, category, title, tags, project, scope, intensity FROM memories WHERE category = 'dont' AND intensity IS NOT NULL AND intensity >= ? ORDER BY intensity DESC, timestamp DESC LIMIT ?"
      )
      .all(minIntensity, limit) as Array<{
        id: string;
        timestamp: string;
        category: string;
        title: string;
        tags: string;
        project: string | null;
        scope: string | null;
        intensity: number | null;
      }>;

    return rows.map((row) => {
      const entry: {
        id: string;
        timestamp: string;
        category: MemoryCategory;
        title: string;
        tags: string[];
        project?: string;
        scope?: string;
        intensity?: number;
      } = {
        id: row.id,
        timestamp: row.timestamp,
        category: row.category as MemoryCategory,
        title: row.title,
        tags: JSON.parse(row.tags),
      };
      if (row.project) { entry.project = row.project; }
      if (row.scope) { entry.scope = row.scope; }
      if (row.intensity !== null && row.intensity !== undefined) { entry.intensity = row.intensity; }
      return entry;
    });
  }

  private readEntriesByCategory(category: MemoryCategory, currentProject?: string): MemoryEntry[] {
    let query = "SELECT * FROM memories WHERE category = ?";
    const queryParams: string[] = [category];

    if (currentProject) {
      query += " AND (project IS NULL OR project = ?)";
      queryParams.push(currentProject);
    }

    query += " ORDER BY timestamp DESC";

    const rows = this.db.prepare(query).all(...queryParams) as MemoryRow[];
    return rows.map((row) => this.rowToEntry(row));
  }

  private rowToEntry(row: MemoryRow): MemoryEntry {
    const entry: MemoryEntry = {
      id: row.id,
      timestamp: row.timestamp,
      category: row.category as MemoryCategory,
      title: row.title,
      content: row.content,
      tags: JSON.parse(row.tags),
    };
    if (row.project) { entry.project = row.project; }
    if (row.scope) { entry.scope = row.scope; }
    if (row.intensity !== null && row.intensity !== undefined) { entry.intensity = row.intensity; }
    if (row.knowledge_gap !== null && row.knowledge_gap !== undefined) {
      try {
        entry.knowledgeGap = JSON.parse(row.knowledge_gap);
      } catch {
        // パース失敗時は省略（fail-open: 既存エントリの保護）
      }
    }
    return entry;
  }

  private escapeFtsQuery(query: string): string {
    return `"${query.replace(/"/g, '""')}"`;
  }

  private deduplicateConfigEntries(entries: MemoryEntry[]): MemoryEntry[] {
    if (entries.length <= 1) return entries;

    const sorted = [...entries].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    const kept: MemoryEntry[] = [];

    for (const entry of sorted) {
      const entryTokens = this.extractTitleTokens(entry.title);

      const isDuplicate = kept.some((k) => {
        const keptTokens = this.extractTitleTokens(k.title);
        const overlap = entryTokens.filter((t) => keptTokens.includes(t));
        return (
          entryTokens.length > 0 &&
          overlap.length >= 2 &&
          overlap.length / entryTokens.length >= 0.5
        );
      });

      if (!isDuplicate) {
        kept.push(entry);
      }
    }

    return kept;
  }

  private extractTitleTokens(title: string): string[] {
    return title
      .toLowerCase()
      .replace(/[^\w\s\u3000-\u9fff]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 0);
  }
}

interface MemoryRow {
  id: string;
  timestamp: string;
  category: string;
  title: string;
  content: string;
  tags: string;
  project: string | null;
  scope: string | null;
  intensity: number | null;
  knowledge_gap: string | null;
  created_at: string;
  updated_at: string;
}
