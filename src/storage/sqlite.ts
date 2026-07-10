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
import { migrateV1ToV2, migrateV1ToV2_categoryAndKnowledgeGap, migrateV2ToV3, migrateV3ToV4, migrateV4ToV5, migrateV5ToV6 } from "./migration.js";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { formatEntry } from "./formatter.js";
import { buildSearchHint } from "./search-hint.js";

export interface VectorSearchResult {
  id: string;
  distance: number;
}

// 世界モデルブロック（getContext）の閾値・件数（マジックナンバー禁止）
const WORLD_MODEL_MIN_ERROR = 0.5; // この予測誤差以上を「学ぶべき外れ」として surface
const WORLD_MODEL_LIMIT = 3;        // surface する上限件数（dream の SEED_LIMIT=3 に倣う）

// --- ハイブリッド検索: FTS5(trigram)トークナイズ + RRF関連度統合 ---
//
// 背景: memories_fts は tokenize='trigram' で構築されている（schema.ts）。
// 実測（better-sqlite3 + sqlite-vec 直接検証）で確認した trigram トークナイザの性質:
//   1. クエリ文字列も同じトークナイザでトークン化されるため、3文字未満の語句は
//      内容側にその部分文字列が存在しても絶対にヒットしない（0個のtrigramしか
//      生成できないため）。
//   2. クエリ全体を1フレーズとして二重引用すると、内容側にその「全体」が完全に
//      連続する部分文字列として存在しない限り0件になる。自然文クエリは保存済み
//      タイトル・本文の表現と完全一致することがほぼ無いため、この既存実装
//      （escapeFtsQuery が単一フレーズを返す）が検索空振りの主因だった。
//
// 対策: クエリを語（ひらがな連続・カタカナ連続・漢字連続・英数字連続）に分割し、
// 各語を独立フレーズとして OR 結合する（recall優先）。3文字未満の語はトリグラム
// では原理的にマッチしないため候補から除外し、除外の結果トークンが0個になった
// 場合のみ従来のフレーズ化にフォールバックする。

const MIN_FTS_TOKEN_LENGTH = 3; // trigramトークナイザは3文字未満の語を絶対にマッチさせない（実測済み）

// ハイブリッド検索の候補プールサイズ。FTS5のrank順・ベクトルのdistance順それぞれ
// 上位N件を取得し、その和集合をRRF統合の母集団にする（最終的な返却件数はparams.limit）。
export const SEARCH_CANDIDATE_POOL = 50;

// RRF (Reciprocal Rank Fusion) の減衰定数。値が大きいほど下位順位の寄与が緩やかに減る（一般的な既定値=60）。
const RRF_K = 60;

type FtsCharClass = "hiragana" | "katakana" | "kanji" | "alnum";

function classifyFtsChar(ch: string): FtsCharClass | null {
  if (/[\u3040-\u309f]/.test(ch)) return "hiragana";
  if (/[\u30a0-\u30ff]/.test(ch)) return "katakana";
  if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(ch)) return "kanji";
  if (/[A-Za-z0-9]/.test(ch)) return "alnum";
  return null;
}

// クエリをFTS5(trigram)向けの語に分割する。ひらがな連続・カタカナ連続・漢字連続・
// 英数字連続をそれぞれ1語として拾い（extractTitleTokens系の考え方に倣うが、スクリプト
// 境界で分割する点が異なる）、3文字未満（trigramでは絶対にマッチしない）の語は捨てる。
export function tokenizeForFts(query: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let currentClass: FtsCharClass | null = null;

  for (const ch of query) {
    const cls = classifyFtsChar(ch);
    if (cls === null) {
      if (current) tokens.push(current);
      current = "";
      currentClass = null;
      continue;
    }
    if (cls === currentClass) {
      current += ch;
    } else {
      if (current) tokens.push(current);
      current = ch;
      currentClass = cls;
    }
  }
  if (current) tokens.push(current);

  return tokens.filter((t) => t.length >= MIN_FTS_TOKEN_LENGTH);
}

// FTS5 MATCH式を構築する。トークン分割してOR結合することで、自然文クエリでも
// 「クエリ全体と完全一致する部分文字列が保存内容に無い限り0件」だった問題を解消する
// （recall優先）。トークンが0個（記号のみ・短い語のみ等）の場合は従来通りクエリ
// 全体を1フレーズとして扱う（空クエリ呼び出しはしない前提＝呼び出し元でガード済み）。
export function escapeFtsQuery(query: string): string {
  const escapeToken = (t: string): string => `"${t.replace(/"/g, '""')}"`;
  const tokens = tokenizeForFts(query);

  if (tokens.length === 0) {
    return escapeToken(query);
  }

  return tokens.map(escapeToken).join(" OR ");
}

// 複数の順位付きIDリスト（各リストは関連度が高い順に並んでいる前提、0始まりindex）を
// RRF (Reciprocal Rank Fusion) で統合する。片方のリストにしか出現しないIDは、出現した
// リストの項のみ加算する（もう片方を満点扱いしたり0点扱いしたりしない）。
export function computeRrfScores(rankedLists: string[][]): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of rankedLists) {
    list.forEach((id, position) => {
      const contribution = 1 / (RRF_K + position);
      scores.set(id, (scores.get(id) ?? 0) + contribution);
    });
  }
  return scores;
}

export class SQLiteStorage {
  private db: Database.Database;
  private vecLoaded = false;
  private readonly dbPath: string;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.dbPath = dbPath;
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

    // v2→v3: positive_action カラム追加（カラム存在チェックで冪等）
    if (memoriesTableExists) {
      migrateV2ToV3(this.db);
    }

    // v3→v4: scenario / why_core カラム追加（カラム存在チェックで冪等）
    if (memoriesTableExists) {
      migrateV3ToV4(this.db);
    }

    // v4→v5: 予測誤差ループの4カラム追加（カラム存在チェックで冪等）
    if (memoriesTableExists) {
      migrateV4ToV5(this.db);
    }

    // 論理削除カラム migration（既存DBに対しても idempotent。consolidator が source エントリを論理削除する用途）
    try { this.db.exec("ALTER TABLE memories ADD COLUMN deleted_at TEXT"); } catch { /* duplicate column → 既に追加済み */ }

    // v5→v6: 状態機械(state)・project帰属信頼度(project_confidence)・埋め込みモデル版数
    // (embedding_model) の土台列を追加（カラム存在チェックで冪等）。
    // memoryPath省略呼び出し（get_detail等の一部ツール）に備え、dbPathの親ディレクトリで
    // フォールバックする（バックアップ先の解決に memoryPath が必須なため）。
    if (memoriesTableExists) {
      migrateV5ToV6(this.db, memoryPath ?? dirname(this.dbPath));
    }

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
    const positiveAction = params.positiveAction ?? null;
    const scenario = params.scenario ?? null;
    const whyCore = params.whyCore ?? null;
    // 予測誤差ループ: 配列2つは undefined なら NULL、配列（空含む）なら JSON 文字列で保存（knowledgeGap と同じパターン）
    const predictedFactors = params.predictedFactors !== undefined ? JSON.stringify(params.predictedFactors) : null;
    const actualFactors = params.actualFactors !== undefined ? JSON.stringify(params.actualFactors) : null;
    const predictionError = params.predictionError ?? null;
    const predictionDelta = params.predictionDelta ?? null;
    // project_confidence列はNOT NULL（DEFAULT 'unknown'）。呼び出し側（save.ts）が
    // 明示指定しない場合は列の既定値と同じ'unknown'を明示的に渡す（関数引数の既定値相当）。
    const projectConfidence = params.projectConfidence ?? "unknown";

    if (params.replaceId) {
      const existing = this.db.prepare("SELECT id FROM memories WHERE id = ?").get(params.replaceId) as { id: string } | undefined;
      if (existing) {
        const updateStmt = this.db.prepare(`
          UPDATE memories SET
            timestamp = ?, category = ?, title = ?, content = ?, tags = ?,
            project = ?, scope = ?, intensity = ?, knowledge_gap = ?, positive_action = ?,
            scenario = ?, why_core = ?,
            predicted_factors = ?, actual_factors = ?, prediction_error = ?, prediction_delta = ?,
            project_confidence = ?,
            updated_at = datetime('now')
          WHERE id = ?
        `);
        updateStmt.run(
          timestamp, params.category, params.title, params.content, tags,
          params.project ?? null, params.scope ?? null, params.intensity ?? null,
          knowledgeGap, positiveAction, scenario, whyCore,
          predictedFactors, actualFactors, predictionError, predictionDelta,
          projectConfidence,
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
      INSERT INTO memories (id, timestamp, category, title, content, tags, project, scope, intensity, knowledge_gap, positive_action, scenario, why_core, predicted_factors, actual_factors, prediction_error, prediction_delta, project_confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertStmt.run(
      id, timestamp, params.category, params.title, params.content, tags,
      params.project ?? null, params.scope ?? null, params.intensity ?? null,
      knowledgeGap, positiveAction, scenario, whyCore,
      predictedFactors, actualFactors, predictionError, predictionDelta,
      projectConfidence
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

    // 可視性マトリクス: get_detailはactive/archivedのみ可、deletedは不可（I1）。
    for (const id of params.ids) {
      const row = this.db.prepare("SELECT * FROM memories WHERE id = ? AND state != 'deleted'").get(id) as MemoryRow | undefined;
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

  // 指定 ID の embedding を取得（クラスタリング用）
  getEmbedding(id: string): number[] | null {
    const row = this.db.prepare("SELECT embedding FROM vectors WHERE id = ?").get(id) as { embedding: Buffer } | undefined;
    if (!row) return null;
    const buf = row.embedding;
    const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    return Array.from(f32);
  }

  // dont カテゴリの全 alive エントリ取得（consolidator 用、SQLite を真実源にする）
  readAliveDontEntries(currentProject?: string): MemoryEntry[] {
    // 可視性マトリクス: 統合（夜間）はactiveのみ可。
    let query = "SELECT * FROM memories WHERE category = 'dont' AND state = 'active'";
    const params: string[] = [];
    if (currentProject) {
      query += " AND (project IS NULL OR project = 'unknown' OR project = ?)"; // R-A4 AC3: unknown帰属も既定で検索対象に残す
      params.push(currentProject);
    }
    query += " ORDER BY intensity DESC, timestamp DESC";
    const rows = this.db.prepare(query).all(...params) as MemoryRow[];
    return rows.map(row => this.rowToEntry(row));
  }

  // 論理削除: deleted_at にタイムスタンプを書き込む。memory_search の結果から外れるが、memory_get_detail では引ける（復元用に物理データは残す）。
  softDelete(ids: string[]): { softDeleted: string[]; notFound: string[] } {
    const softDeleted: string[] = [];
    const notFound: string[] = [];
    const ts = this.generateTimestamp();
    // 不変条件I4: state='deleted' と deleted_at IS NOT NULL は常に同値。書き込み経路で同期する。
    const updateStmt = this.db.prepare("UPDATE memories SET deleted_at = ?, state = 'deleted' WHERE id = ? AND deleted_at IS NULL");
    const checkStmt = this.db.prepare("SELECT id FROM memories WHERE id = ?");
    for (const id of ids) {
      const existing = checkStmt.get(id) as { id: string } | undefined;
      if (existing) {
        updateStmt.run(ts, id);
        softDeleted.push(id);
      } else {
        notFound.push(id);
      }
    }
    return { softDeleted, notFound };
  }

  // tombstone（論理削除済み=deleted_at IS NOT NULL）の件数を数える（dry-run用・DBは書き換えない）。
  // memories: 論理削除済み行数。vectors / vectorMetadata: その論理削除済みmemoriesに対応する行数。
  countTombstones(): { memories: number; vectors: number; vectorMetadata: number } {
    const memories = (this.db.prepare(
      "SELECT COUNT(*) as c FROM memories WHERE deleted_at IS NOT NULL"
    ).get() as { c: number }).c;

    const vectors = (this.db.prepare(`
      SELECT COUNT(*) as c FROM vectors
      WHERE id IN (SELECT id FROM memories WHERE deleted_at IS NOT NULL)
    `).get() as { c: number }).c;

    const vectorMetadata = (this.db.prepare(`
      SELECT COUNT(*) as c FROM vector_metadata
      WHERE id IN (SELECT id FROM memories WHERE deleted_at IS NOT NULL)
    `).get() as { c: number }).c;

    return { memories, vectors, vectorMetadata };
  }

  // tombstone（論理削除済み）のmemories行と、対応するvectors/vector_metadata行を物理削除する。
  // 実行前にPRAGMA integrity_checkで健全性を確認し、削除は1トランザクションで原子的に行う。
  purgeTombstones(): { deletedMemories: number; deletedVectors: number; deletedVectorMetadata: number } {
    const integrityRows = this.db.pragma("integrity_check") as { integrity_check: string }[];
    const isHealthy = integrityRows.length === 1 && integrityRows[0].integrity_check === "ok";
    if (!isHealthy) {
      throw new Error(`purgeTombstones中止: PRAGMA integrity_check異常 - ${JSON.stringify(integrityRows)}`);
    }

    const purge = this.db.transaction(() => {
      const tombstoneIds = (this.db.prepare(
        "SELECT id FROM memories WHERE deleted_at IS NOT NULL"
      ).all() as { id: string }[]).map((row) => row.id);

      let deletedVectors = 0;
      let deletedVectorMetadata = 0;
      const deleteVec = this.db.prepare("DELETE FROM vectors WHERE id = ?");
      const deleteMeta = this.db.prepare("DELETE FROM vector_metadata WHERE id = ?");
      for (const id of tombstoneIds) {
        deletedVectors += deleteVec.run(id).changes;
        deletedVectorMetadata += deleteMeta.run(id).changes;
      }

      const memoriesResult = this.db.prepare(
        "DELETE FROM memories WHERE deleted_at IS NOT NULL"
      ).run();

      return {
        deletedVectors,
        deletedVectorMetadata,
        deletedMemories: memoriesResult.changes,
      };
    });

    return purge();
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

    // 可視性マトリクス: 検索はactiveのみ可（I1）。
    if (usesFts) {
      query = `
        SELECT m.* FROM memories m
        INNER JOIN memories_fts fts ON m.rowid = fts.rowid
        WHERE memories_fts MATCH ? AND m.state = 'active'
      `;
      queryParams.push(escapeFtsQuery(params.query!));
    } else if (usesLike) {
      const likePattern = `%${trimmedQuery}%`;
      query = `SELECT * FROM memories WHERE (title LIKE ? OR content LIKE ? OR tags LIKE ?) AND state = 'active'`;
      queryParams.push(likePattern, likePattern, likePattern);
    } else {
      query = "SELECT * FROM memories WHERE 1=1 AND state = 'active'";
    }

    const prefix = usesFts ? "m." : "";
    if (params.category && params.category !== "all") {
      query += ` AND ${prefix}category = ?`;
      queryParams.push(params.category);
    }

    if (params.project) {
      query += ` AND (${prefix}project IS NULL OR ${prefix}project = 'unknown' OR ${prefix}project = ?)`; // R-A4 AC3: unknown帰属も既定で検索対象に残す
      queryParams.push(params.project);
    }

    if (params.scope) {
      query += ` AND (${prefix}scope IS NULL OR ${prefix}scope = 'general' OR ${prefix}scope = ?)`;
      queryParams.push(params.scope);
    }

    // FTS5経路は関連度（fts.rank昇順=最も一致する順）で並べる。timestamp単独順だと
    // 「一致度に関わらず新しい順」になり、本当に関連性の高い結果が古いという理由だけで
    // 候補から漏れる（LIMITで切り捨てられる）。LIKE/空クエリ経路には関連度シグナルが
    // 無いため、従来通りtimestamp DESCを維持する。
    const orderClause = usesFts ? "fts.rank" : "timestamp DESC";
    query += ` ORDER BY ${orderClause} LIMIT ?`;
    queryParams.push(limit);

    const rows = this.db.prepare(query).all(...queryParams) as MemoryRow[];

    let countQuery: string;
    const countParams = queryParams.slice(0, -1);
    if (usesFts) {
      countQuery = `
        SELECT COUNT(*) as count FROM memories m
        INNER JOIN memories_fts fts ON m.rowid = fts.rowid
        WHERE memories_fts MATCH ? AND m.state = 'active'
      `;
    } else if (usesLike) {
      countQuery = "SELECT COUNT(*) as count FROM memories WHERE (title LIKE ? OR content LIKE ? OR tags LIKE ?) AND state = 'active'";
    } else {
      countQuery = "SELECT COUNT(*) as count FROM memories WHERE 1=1 AND state = 'active'";
    }
    if (params.category && params.category !== "all") {
      countQuery += ` AND ${prefix}category = ?`;
    }
    if (params.project) {
      countQuery += ` AND (${prefix}project IS NULL OR ${prefix}project = 'unknown' OR ${prefix}project = ?)`;
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
      hint: buildSearchHint(indexEntries.length),
    };
  }


  // --- ハイブリッド検索 (TASK-015、関連度RRF統合) ---

  searchHybrid(params: SearchParams, queryEmbedding: number[]): SearchResult {
    const limit = params.limit ?? config.defaultSearchLimit;

    // 1. FTS5キーワード候補プール（3文字未満はLIKEフォールバック）。
    //    いずれの経路も「関連度が高い順」に並べて取得する（FTSはrank昇順、
    //    LIKEには関連度シグナルが無いのでtimestamp DESCで決定的に順序付ける）。
    //    順位（0始まりindex）がそのままRRF統合時のpositionになる。
    const ftsRankedIds: string[] = [];
    if (params.query && params.query.trim()) {
      const trimmedQ = params.query.trim();
      let ftsQuery: string;
      const ftsParams: (string | number)[] = [];

      // 可視性マトリクス: 検索(ハイブリッド)はactiveのみ可（I1）。
      if (trimmedQ.length >= 3) {
        ftsQuery = `
          SELECT m.id FROM memories m
          INNER JOIN memories_fts fts ON m.rowid = fts.rowid
          WHERE memories_fts MATCH ? AND m.state = 'active'
        `;
        ftsParams.push(escapeFtsQuery(trimmedQ));

        if (params.category && params.category !== "all") {
          ftsQuery += " AND m.category = ?";
          ftsParams.push(params.category);
        }
        if (params.project) {
          ftsQuery += " AND (m.project IS NULL OR m.project = 'unknown' OR m.project = ?)"; // R-A4 AC3
          ftsParams.push(params.project);
        }
        if (params.scope) {
          ftsQuery += " AND (m.scope IS NULL OR m.scope = 'general' OR m.scope = ?)";
          ftsParams.push(params.scope);
        }
        ftsQuery += " ORDER BY fts.rank";
      } else {
        const likePattern = `%${trimmedQ}%`;
        ftsQuery = `SELECT id FROM memories WHERE (title LIKE ? OR content LIKE ? OR tags LIKE ?) AND state = 'active'`;
        ftsParams.push(likePattern, likePattern, likePattern);

        if (params.category && params.category !== "all") {
          ftsQuery += " AND category = ?";
          ftsParams.push(params.category);
        }
        if (params.project) {
          ftsQuery += " AND (project IS NULL OR project = 'unknown' OR project = ?)"; // R-A4 AC3
          ftsParams.push(params.project);
        }
        if (params.scope) {
          ftsQuery += " AND (scope IS NULL OR scope = 'general' OR scope = ?)";
          ftsParams.push(params.scope);
        }
        ftsQuery += " ORDER BY timestamp DESC";
      }

      ftsQuery += ` LIMIT ?`;
      ftsParams.push(SEARCH_CANDIDATE_POOL);

      const ftsRows = this.db.prepare(ftsQuery).all(...ftsParams) as { id: string }[];
      for (const row of ftsRows) {
        ftsRankedIds.push(row.id);
      }
    }

    // 2. ベクトルKNN候補プール（distance昇順=関連度降順で返る。既存のsearchVectorsをそのまま使う）
    const vectorResults = this.searchVectors(queryEmbedding, 999, SEARCH_CANDIDATE_POOL);
    const vectorRankedIds = vectorResults.map((r) => r.id);

    // 3. RRF (Reciprocal Rank Fusion) で2つの順位リストをスコア付き統合する。
    //    従来はIDをSetでUNIONして関連度情報を全て捨て、最後にtimestamp DESCで
    //    並べ直していた（=関連度無視の時系列順）。ここでは順位情報を保持したまま
    //    合成スコアを持たせ、そのスコア降順を最終順位にする。
    const rrfScores = computeRrfScores([ftsRankedIds, vectorRankedIds]);

    // 4. project/scope/categoryフィルタ + エントリ取得（可視性マトリクス: 検索はactiveのみ可。
    //    FTS経路はプール取得時点で絞り込み済みだが、ベクトル側は対象外のためここで最終確認する）
    const scoredEntries: Array<{ entry: MemoryIndexEntry; score: number; timestamp: string }> = [];
    for (const [id, score] of rrfScores) {
      const row = this.db.prepare("SELECT * FROM memories WHERE id = ? AND state = 'active'").get(id) as MemoryRow | undefined;
      if (!row) continue;

      // R-A4 AC3: project未確定(NULL)とunknown明示刻印はいずれも既定で検索対象に残す
      if (params.project && row.project !== null && row.project !== "unknown" && row.project !== params.project) {
        continue;
      }
      if (params.scope && row.scope !== null && row.scope !== "general" && row.scope !== params.scope) {
        continue;
      }
      if (params.category && params.category !== "all" && row.category !== params.category) {
        continue;
      }

      scoredEntries.push({
        entry: {
          id: row.id,
          timestamp: row.timestamp,
          category: row.category as MemoryCategory,
          title: row.title,
          tags: JSON.parse(row.tags),
          project: row.project ?? undefined,
          scope: row.scope ?? undefined,
          intensity: row.intensity ?? undefined,
        },
        score,
        timestamp: row.timestamp,
      });
    }

    // 5. 関連度（RRFスコア）降順。同点の場合のみtimestamp DESCでタイブレークする。
    scoredEntries.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
    });

    const limited = scoredEntries.slice(0, limit).map((e) => e.entry);

    return {
      results: limited,
      totalCount: scoredEntries.length,
      hint: buildSearchHint(limited.length),
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

    // 世界モデル更新: 予測が大きく外れた上位N件を surface（学ぶべき外れ）
    const worldModelEntries = this.listHighErrorEntries(WORLD_MODEL_MIN_ERROR, WORLD_MODEL_LIMIT);
    const worldModelFormatted = worldModelEntries
      .map((e) => {
        const errPct = Math.round((e.predictionError ?? 0) * 100);
        const delta = e.predictionDelta ? `\n${e.predictionDelta}` : "";
        return `### ${e.title}（予測ずれ ${errPct}%）${delta}`;
      })
      .join("\n\n");

    const result: ContextResult = {
      config: configFormatted || "（設定情報なし）",
      dont: dontFormatted || "（ルールなし）",
    };
    if (worldModelFormatted) {
      result.worldModelUpdates = worldModelFormatted;
    }
    return result;
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
    // 可視性マトリクス: backfillはactiveのみ可。
    const rows = this.db.prepare(`
      SELECT m.id FROM memories m
      LEFT JOIN vector_metadata vm ON m.id = vm.id
      WHERE vm.id IS NULL AND m.state = 'active'
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

    // 生存(active)エントリのみを数える。可視性マトリクス: 統合(夜間)はactiveのみ可。
    // deleted/archived行まで数えると、統合が source を soft delete した後に件数が永久に
    // 一致せず stale=true のままになり、毎回再統合（config 側は毎晩 LLM 空振り）が起きる。
    // 鮮度の意味は「activeエントリが前回統合時から変わったか」。
    const currentCount = this.db.prepare(
      "SELECT COUNT(*) as count FROM memories WHERE category = ? AND state = 'active'"
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
    positiveAction?: string;
    scenario?: string;
    whyCore?: string;
  }> {
    // 可視性マトリクス: 注入はactiveのみ可。
    const rows = this.db
      .prepare(
        "SELECT id, timestamp, category, title, tags, project, scope, intensity, positive_action, scenario, why_core FROM memories WHERE category = 'dont' AND intensity IS NOT NULL AND intensity >= ? AND state = 'active' ORDER BY intensity DESC, timestamp DESC LIMIT ?"
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
        positive_action: string | null;
        scenario: string | null;
        why_core: string | null;
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
        positiveAction?: string;
        scenario?: string;
        whyCore?: string;
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
      if (row.positive_action !== null && row.positive_action !== undefined) { entry.positiveAction = row.positive_action; }
      if (row.scenario !== null && row.scenario !== undefined) { entry.scenario = row.scenario; }
      if (row.why_core !== null && row.why_core !== undefined) { entry.whyCore = row.why_core; }
      return entry;
    });
  }

  // 予測が大きく外れたエントリ（prediction_error >= minError）の軽量インデックスを取得（世界モデルブロック用）
  listHighErrorEntries(minError: number, limit: number): Array<{
    id: string;
    timestamp: string;
    category: MemoryCategory;
    title: string;
    tags: string[];
    project?: string;
    scope?: string;
    predictionError?: number;
    predictionDelta?: string;
  }> {
    // 可視性マトリクス: 注入はactiveのみ可。
    const rows = this.db
      .prepare(
        "SELECT id, timestamp, category, title, tags, project, scope, prediction_error, prediction_delta FROM memories WHERE prediction_error IS NOT NULL AND prediction_error >= ? AND state = 'active' ORDER BY prediction_error DESC, timestamp DESC LIMIT ?"
      )
      .all(minError, limit) as Array<{
        id: string;
        timestamp: string;
        category: string;
        title: string;
        tags: string;
        project: string | null;
        scope: string | null;
        prediction_error: number | null;
        prediction_delta: string | null;
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
        predictionError?: number;
        predictionDelta?: string;
      } = {
        id: row.id,
        timestamp: row.timestamp,
        category: row.category as MemoryCategory,
        title: row.title,
        tags: JSON.parse(row.tags),
      };
      if (row.project) { entry.project = row.project; }
      if (row.scope) { entry.scope = row.scope; }
      if (row.prediction_error !== null && row.prediction_error !== undefined) { entry.predictionError = row.prediction_error; }
      if (row.prediction_delta !== null && row.prediction_delta !== undefined) { entry.predictionDelta = row.prediction_delta; }
      return entry;
    });
  }

  // 指定IDの prediction_error を一括取得（検索スコアリングの加点用）。NULL のものは Map に載せない。
  getPredictionErrors(ids: string[]): Map<string, number> {
    const map = new Map<string, number>();
    if (ids.length === 0) {
      return map;
    }
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT id, prediction_error FROM memories WHERE id IN (${placeholders}) AND prediction_error IS NOT NULL`
      )
      .all(...ids) as Array<{ id: string; prediction_error: number | null }>;
    for (const row of rows) {
      if (row.prediction_error !== null && row.prediction_error !== undefined) {
        map.set(row.id, row.prediction_error);
      }
    }
    return map;
  }

  private readEntriesByCategory(category: MemoryCategory, currentProject?: string): MemoryEntry[] {
    // 可視性マトリクス: 注入(config/dontの読み込み)はactiveのみ可。
    let query = "SELECT * FROM memories WHERE category = ? AND state = 'active'";
    const queryParams: string[] = [category];

    if (currentProject) {
      query += " AND (project IS NULL OR project = 'unknown' OR project = ?)"; // R-A4 AC3: unknown帰属も既定で検索対象に残す
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
    if (row.positive_action !== null && row.positive_action !== undefined) {
      entry.positiveAction = row.positive_action;
    }
    if (row.scenario !== null && row.scenario !== undefined) {
      entry.scenario = row.scenario;
    }
    if (row.why_core !== null && row.why_core !== undefined) {
      entry.whyCore = row.why_core;
    }
    if (row.predicted_factors !== null && row.predicted_factors !== undefined) {
      try {
        entry.predictedFactors = JSON.parse(row.predicted_factors);
      } catch {
        // パース失敗時は省略（fail-open: 既存エントリの保護）
      }
    }
    if (row.actual_factors !== null && row.actual_factors !== undefined) {
      try {
        entry.actualFactors = JSON.parse(row.actual_factors);
      } catch {
        // パース失敗時は省略
      }
    }
    if (row.prediction_error !== null && row.prediction_error !== undefined) {
      entry.predictionError = row.prediction_error;
    }
    if (row.prediction_delta !== null && row.prediction_delta !== undefined) {
      entry.predictionDelta = row.prediction_delta;
    }
    return entry;
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
  positive_action: string | null;
  scenario: string | null;
  why_core: string | null;
  predicted_factors: string | null;
  actual_factors: string | null;
  prediction_error: number | null;
  prediction_delta: string | null;
  created_at: string;
  updated_at: string;
}
