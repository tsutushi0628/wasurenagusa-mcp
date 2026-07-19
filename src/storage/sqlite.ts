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
  FtsFallbackStage,
  StashParams,
  StashResult,
  RestoreResult,
  ConsolidatedDont,
  ConsolidatedConfig,
} from "../types.js";
import { config } from "../config.js";
import { initializeSchema, initializeVectors, getSchemaVersion, CURRENT_SCHEMA_VERSION } from "./schema.js";
import { migrateV1ToV2, migrateV1ToV2_categoryAndKnowledgeGap, migrateV2ToV3, migrateV3ToV4, migrateV4ToV5, migrateV5ToV6, migrateV6ToV7, migrateV7ToV8, migrateV8ToV9, migrateV9ToV10 } from "./migration.js";
import { computeContentHash } from "./content-hash.js";
import { asL2Distance, l2ToCosineSim, meetsSimilarity, type CosineSimilarity, type Threshold } from "../vector/distance-types.js";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { formatEntry } from "./formatter.js";
import { buildSearchHint } from "./search-hint.js";
import { increment } from "../observability/counters.js";
import { SearchScorer } from "../vector/search-scorer.js";

export interface VectorSearchResult {
  id: string;
  distance: number;
}

// 世界モデルブロック（getContext）の閾値・件数（マジックナンバー禁止）
const WORLD_MODEL_MIN_ERROR = 0.5; // この予測誤差以上を「学ぶべき外れ」として surface
const WORLD_MODEL_LIMIT = 3;        // surface する上限件数（dream の SEED_LIMIT=3 に倣う）

// get_context（memory_get_context ツール）の件数・分量上限（タスク4.4・R-C3）。
// LIMITなしの全件読みで1呼び出し69万字ダンプが起きた事故（監査D6）の根治。
// 上限超過時は黙って切り捨てず、ContextResult.truncated と本文マーカーで必ず明示する。
export const GET_CONTEXT_MAX_ENTRIES = 200;
export const GET_CONTEXT_MAX_CHARS = 20000;

/**
 * カテゴリ1件分のエントリ配列を件数上限・文字数上限の両方でキャップする。
 * 件数超過を先に切り、それでも整形結果が文字数上限を超えていたら文字境界で切る。
 * 呼び出し側が「何件中何件を返したか」を明示できるよう総数と返却数を返す
 * （無言の切り捨て禁止・タスク4.4）。
 */
function capContextEntries<T>(
  entries: T[],
  maxEntries: number,
  maxChars: number,
  formatter: (e: T) => string,
  joiner: string,
): { formatted: string; truncated: boolean; totalEntries: number; returnedEntries: number } {
  const totalEntries = entries.length;
  const truncatedByCount = totalEntries > maxEntries;
  const sliced = entries.slice(0, maxEntries);
  let formatted = sliced.map(formatter).join(joiner);
  let returnedEntries = sliced.length;

  let truncatedByChars = false;
  if (formatted.length > maxChars) {
    truncatedByChars = true;
    formatted = formatted.slice(0, maxChars);
    // 文字上限で切った場合、返却件数の厳密なカウントは意味を失う（エントリ途中で切れるため）
    // ので「上限で切られた」ことだけを truncated フラグで表す。件数表示は上限件数を用いる。
    returnedEntries = Math.min(returnedEntries, maxEntries);
  }

  return {
    formatted,
    truncated: truncatedByCount || truncatedByChars,
    totalEntries,
    returnedEntries,
  };
}

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

// --- FTS段階フォールバック（design.md Phase2定義1: フレーズ→AND→OR） ---
//
// memories_fts は tokenize='trigram' のため、二重引用したフレーズは「その文字列が内容側に
// 連続した部分文字列として存在するか」を厳密に問う。段が進むほど条件を緩める：
//   phrase: クエリ全体を1つの連続文字列として要求する（最も厳しい）
//   and:    各トークンを独立フレーズにし、全トークンが（順不同・非連続でも）存在することを要求する
//   or:     各トークンを独立フレーズにし、いずれか1つが存在すれば良い（従来のescapeFtsQuery既定動作）
// 最初にヒットした段の結果を採用し、各段の発火を計数する（G2検証ゲート項目5 fallback-counters）。
// 段名の正本定義は types.ts の FtsFallbackStage（SearchResult.fallbackStage・search-hint.tsのラベルと
// 単一定義を共有する。タスク2.10）。既存importer互換のためここから再exportする。
export type { FtsFallbackStage };

export interface FtsFallbackStageQuery {
  stage: FtsFallbackStage;
  matchExpr: string;
}

export function buildFtsFallbackStages(query: string): FtsFallbackStageQuery[] {
  const escapeToken = (t: string): string => `"${t.replace(/"/g, '""')}"`;
  const tokens = tokenizeForFts(query);

  const phraseStage: FtsFallbackStageQuery = { stage: "phrase", matchExpr: escapeToken(query) };

  if (tokens.length === 0) {
    // 有効な語が無い場合はフレーズ段（クエリ全体の1フレーズ化）のみを返す。
    return [phraseStage];
  }
  if (tokens.length === 1) {
    // トークンが1個だけならAND段はOR段と完全に同一の式になり冗長なため省く。
    return [phraseStage, { stage: "or", matchExpr: tokens.map(escapeToken).join(" OR ") }];
  }
  return [
    phraseStage,
    { stage: "and", matchExpr: tokens.map(escapeToken).join(" AND ") },
    { stage: "or", matchExpr: tokens.map(escapeToken).join(" OR ") },
  ];
}

// --- 時間減衰（design.md Phase2定義4: finalScore = rrfScore × 0.5^(ageDays/H)） ---
//
// recencyの反映元はこのtime-decayただ一つに一本化する（既存のSearchScorer freshness項は除去済み。
// search-scorer.ts参照・二重減衰の禁止）。半減期Hは既定90日とし、ゴールデンセットで較正する。
const TIME_DECAY_HALF_LIFE_DAYS = 90;

// timestampからnow(既定=呼び出し時点の現在時刻)までの経過日数を返す。未来timestamp（時計ずれ等の
// 防御）はマイナスにせず0に床める。
export function computeAgeDays(timestamp: string, now: number = Date.now()): number {
  const ageMs = now - new Date(timestamp).getTime();
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  return Math.max(0, ageDays);
}

export function computeTimeDecay(ageDays: number, halfLifeDays: number = TIME_DECAY_HALF_LIFE_DAYS): number {
  return Math.pow(0.5, ageDays / halfLifeDays);
}

// dedup（content-hash一致）ヒット時の付帯情報マージ用ヘルパー。
// content-hash.ts の設計コメントどおり「付帯情報の差は同じ記憶への追記」として扱うため、
// 配列系フィールド（tags/knowledgeGap/predictedFactors/actualFactors）は既存値との和集合を取り、
// 既存の値を消さずに新規分だけ追加する（非破壊）。
export function safeParseStringArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function mergeUniqueStrings(existing: string[], incoming: string[]): string[] {
  const merged = [...existing];
  for (const item of incoming) {
    if (!merged.includes(item)) {
      merged.push(item);
    }
  }
  return merged;
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

    // v6→v7: content-hash dedup 土台列(content_hash)を追加し既存行をバックフィル（カラム存在チェックで冪等）。
    if (memoriesTableExists) {
      migrateV6ToV7(this.db);
    }

    // v7→v8: 埋め込み非依存の最終読取時刻の土台列(last_read_at)を追加（カラム存在チェックで冪等）。
    // 既存行へのバックフィルは行わない（NULL＝未計測を保持。migrateV7ToV8 の JSDoc 参照）。
    if (memoriesTableExists) {
      migrateV7ToV8(this.db);
    }

    // v8→v9: 代謝（統合と昇格）の土台テーブル lineage / principles を新設（テーブル存在チェックで冪等）。
    // 新規DBは initializeSchema の DDL で既に作成済みのため、本呼び出しは旧世代DBの追加を担う。
    if (memoriesTableExists) {
      migrateV8ToV9(this.db, memoryPath ?? dirname(this.dbPath));
    }

    // v9→v10: 承認制ガードレジストリの土台テーブル guards を新設（テーブル存在チェックで冪等）。
    // 新規DBは initializeSchema の DDL で既に作成済みのため、本呼び出しは旧世代DBの追加を担う。
    if (memoriesTableExists) {
      migrateV9ToV10(this.db, memoryPath ?? dirname(this.dbPath));
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
    // randomBytes(2)（16bit）だと、同一ミリ秒内で数百件挿入するバースト書き込み（バックフィル・
    // 合成fixture生成等）で誕生日問題によりUNIQUE制約違反が発生し得た（実根因）。
    // operation-logger.tsのID生成と同じrandomBytes(4)（32bit）に揃え、衝突確率を無視できる水準まで下げる。
    const random = randomBytes(4).toString("hex");
    return `${timestamp}-${random}`;
  }

  // --- 多並列アクセス耐性(R-A5)の確認固定・書き込み失敗計数(タスク1.12) ---

  /** WAL設定の確認固定（R-A5 AC1）。設定自体はschema.tsのinitializeSchema()が行う。 */
  getJournalMode(): string {
    const row = this.db.pragma("journal_mode") as Array<{ journal_mode: string }>;
    return row[0]?.journal_mode ?? "";
  }

  /** busyタイムアウトの確認固定（R-A5 AC2）。設定自体はschema.tsのinitializeSchema()が行う。 */
  getBusyTimeout(): number {
    const row = this.db.pragma("busy_timeout") as Array<{ timeout: number }>;
    return row[0]?.timeout ?? 0;
  }

  /**
   * 書き込み失敗の計数（R-A5 AC3）。失敗を握りつぶさず計数してから呼び出し元へ再throwする
   * ためのヘルパー。カウンタ自体の書き込み（JSONL追記、非同期）はfire-and-forgetで行い、
   * カウンタ書き込みの失敗が本来のエラー伝播をブロックしない（counters.ts自体がfail-open設計）。
   */
  private recordWriteFailure(operation: string, error: unknown): void {
    const memoryPath = dirname(this.dbPath);
    console.error(`[sqlite] ${operation}で書き込み失敗:`, error);
    void increment(memoryPath, "write_failure_count").catch(() => {
      // カウンタ自体の書き込み失敗はここで握りつぶす（元エラーの伝播をブロックしない）。
    });
  }

  /**
   * FTS段階フォールバック（フレーズ→AND→OR）を順に試し、最初にヒットした段を採用する。
   * 各段の実際のSQL実行はrunStageに委譲する（search()/searchHybrid()で戻り値の形が異なるため）。
   * 全段0件のときは最後の段（OR）の結果を返し、stageはnull（発火計数は行わない）。
   */
  private tryFtsFallbackStages<T>(
    query: string,
    runStage: (matchExpr: string) => T,
    hasHit: (result: T) => boolean
  ): { result: T; stage: FtsFallbackStage | null } {
    const stages = buildFtsFallbackStages(query);
    let last: T | undefined;
    for (const { stage, matchExpr } of stages) {
      const result = runStage(matchExpr);
      if (hasHit(result)) {
        return { result, stage };
      }
      last = result;
    }
    return { result: last as T, stage: null };
  }

  private recordFtsFallbackStage(stage: FtsFallbackStage | null): void {
    if (stage === null) return;
    const metric =
      stage === "phrase" ? "search_fallback_phrase" : stage === "and" ? "search_fallback_and" : "search_fallback_or";
    const memoryPath = dirname(this.dbPath);
    void increment(memoryPath, metric).catch(() => {
      // カウンタ自体の書き込み失敗はここで握りつぶす（検索本体の結果に影響させない）。
    });
  }

  /**
   * FTS段階フォールバック（search()用）。同一のcategory/project/scopeフィルタを各段に適用したうえで
   * 実行し、最初にヒットした段のSELECT結果とCOUNT結果を、発火した段（全段0件ならnull）とともに返す。
   * 段の判定・計数は従来のまま（stageを戻り値に乗せる配線のみ。タスク2.10: ヒットの経路可視化）。
   */
  private searchFtsStaged(
    trimmedQuery: string,
    params: SearchParams,
    limit: number
  ): { rows: MemoryRow[]; countRow: { count: number }; stage: FtsFallbackStage | null } {
    let filterClause = "";
    const filterParams: (string | number)[] = [];
    if (params.category && params.category !== "all") {
      filterClause += " AND m.category = ?";
      filterParams.push(params.category);
    }
    if (params.project) {
      filterClause += " AND (m.project IS NULL OR m.project = 'unknown' OR m.project = ?)"; // R-A4 AC3
      filterParams.push(params.project);
    }
    if (params.scope) {
      filterClause += " AND (m.scope IS NULL OR m.scope = 'general' OR m.scope = ?)";
      filterParams.push(params.scope);
    }

    const { result, stage } = this.tryFtsFallbackStages(
      trimmedQuery,
      (matchExpr) => {
        const selectSql =
          `SELECT m.* FROM memories m INNER JOIN memories_fts fts ON m.rowid = fts.rowid ` +
          `WHERE memories_fts MATCH ? AND m.state = 'active'${filterClause} ORDER BY fts.rank LIMIT ?`;
        const rows = this.db.prepare(selectSql).all(matchExpr, ...filterParams, limit) as MemoryRow[];

        const countSql =
          `SELECT COUNT(*) as count FROM memories m INNER JOIN memories_fts fts ON m.rowid = fts.rowid ` +
          `WHERE memories_fts MATCH ? AND m.state = 'active'${filterClause}`;
        const countRow = this.db.prepare(countSql).get(matchExpr, ...filterParams) as { count: number };

        return { rows, countRow };
      },
      (r) => r.rows.length > 0
    );

    this.recordFtsFallbackStage(stage);
    return { ...result, stage };
  }

  /**
   * FTS段階フォールバック（searchHybrid()の候補プール用）。IDのみを関連度順（fts.rank昇順）で、
   * 発火した段（全段0件ならnull）とともに返す。段の判定・計数は従来のまま（タスク2.10）。
   */
  private searchHybridFtsCandidates(
    trimmedQuery: string,
    params: SearchParams
  ): { ids: string[]; stage: FtsFallbackStage | null } {
    let filterClause = "";
    const filterParams: (string | number)[] = [];
    if (params.category && params.category !== "all") {
      filterClause += " AND m.category = ?";
      filterParams.push(params.category);
    }
    if (params.project) {
      filterClause += " AND (m.project IS NULL OR m.project = 'unknown' OR m.project = ?)"; // R-A4 AC3
      filterParams.push(params.project);
    }
    if (params.scope) {
      filterClause += " AND (m.scope IS NULL OR m.scope = 'general' OR m.scope = ?)";
      filterParams.push(params.scope);
    }

    const { result, stage } = this.tryFtsFallbackStages(
      trimmedQuery,
      (matchExpr) => {
        const sql =
          `SELECT m.id FROM memories m INNER JOIN memories_fts fts ON m.rowid = fts.rowid ` +
          `WHERE memories_fts MATCH ? AND m.state = 'active'${filterClause} ORDER BY fts.rank LIMIT ?`;
        const rows = this.db.prepare(sql).all(matchExpr, ...filterParams, SEARCH_CANDIDATE_POOL) as { id: string }[];
        return rows.map((r) => r.id);
      },
      (ids) => ids.length > 0
    );

    this.recordFtsFallbackStage(stage);
    return { ids: result, stage };
  }

  private generateTimestamp(): string {
    const now = new Date();
    const jstOffset = 9 * 60 * 60 * 1000;
    const jst = new Date(now.getTime() + jstOffset);
    return jst.toISOString().replace("Z", "+09:00");
  }

  // --- MemoryEntry CRUD ---

  save(params: SaveParams): SaveResult {
    try {
      return this.saveInternal(params);
    } catch (error) {
      this.recordWriteFailure("save", error);
      throw error;
    }
  }

  private saveInternal(params: SaveParams): SaveResult {
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
    // content-hash dedup: project + scope + category + 正規化(title, content) を軸に決定論算出（LLM不使用）。
    // replaceId経路・新規INSERT経路の両方で使うため先に算出する。
    const contentHash = computeContentHash({
      project: params.project,
      scope: params.scope,
      category: params.category,
      title: params.title,
      content: params.content,
    });

    if (params.replaceId) {
      const existing = this.db.prepare("SELECT id FROM memories WHERE id = ?").get(params.replaceId) as { id: string } | undefined;
      if (existing) {
        const updateStmt = this.db.prepare(`
          UPDATE memories SET
            timestamp = ?, category = ?, title = ?, content = ?, tags = ?,
            project = ?, scope = ?, intensity = ?, knowledge_gap = ?, positive_action = ?,
            scenario = ?, why_core = ?,
            predicted_factors = ?, actual_factors = ?, prediction_error = ?, prediction_delta = ?,
            project_confidence = ?, content_hash = ?,
            updated_at = datetime('now')
          WHERE id = ?
        `);
        updateStmt.run(
          timestamp, params.category, params.title, params.content, tags,
          params.project ?? null, params.scope ?? null, params.intensity ?? null,
          knowledgeGap, positiveAction, scenario, whyCore,
          predictedFactors, actualFactors, predictionError, predictionDelta,
          projectConfidence, contentHash,
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

    // replaceId未指定時のみ: 同一 project/scope/category/content_hash の active な既存行があれば
    // 新規INSERTせず、その行への追記（updated_at + アクセスカウント）として扱う（重複を増やさない）。
    // project/scopeはNULL許容列のためIS比較で「両方NULL」も一致とみなす。
    const duplicate = this.db.prepare(
      `SELECT id FROM memories
       WHERE state = 'active' AND category = ? AND content_hash = ?
         AND project IS ? AND scope IS ?
       LIMIT 1`
    ).get(params.category, contentHash, params.project ?? null, params.scope ?? null) as { id: string } | undefined;

    if (duplicate) {
      // dedupヒット時も付帯情報（tags/intensity/positiveAction等）は破棄せず、既存行へマージして書き込む。
      // 配列系は既存値との和集合（追加のみ・非破壊）、スカラ系は今回呼び出しで明示指定があれば上書き、
      // 未指定（undefined）なら既存値を保持する（content-hash.ts の設計コメントに合わせる）。
      const existingRow = this.db.prepare(
        `SELECT tags, knowledge_gap, intensity, positive_action, scenario, why_core,
                predicted_factors, actual_factors, prediction_error, prediction_delta
         FROM memories WHERE id = ?`
      ).get(duplicate.id) as {
        tags: string;
        knowledge_gap: string | null;
        intensity: number | null;
        positive_action: string | null;
        scenario: string | null;
        why_core: string | null;
        predicted_factors: string | null;
        actual_factors: string | null;
        prediction_error: number | null;
        prediction_delta: string | null;
      };

      const mergedTags = mergeUniqueStrings(safeParseStringArray(existingRow.tags), params.tags ?? []);
      const mergedKnowledgeGap = params.knowledgeGap !== undefined
        ? JSON.stringify(mergeUniqueStrings(safeParseStringArray(existingRow.knowledge_gap), params.knowledgeGap))
        : existingRow.knowledge_gap;
      const mergedPredictedFactors = params.predictedFactors !== undefined
        ? JSON.stringify(mergeUniqueStrings(safeParseStringArray(existingRow.predicted_factors), params.predictedFactors))
        : existingRow.predicted_factors;
      const mergedActualFactors = params.actualFactors !== undefined
        ? JSON.stringify(mergeUniqueStrings(safeParseStringArray(existingRow.actual_factors), params.actualFactors))
        : existingRow.actual_factors;
      const mergedIntensity = params.intensity !== undefined ? params.intensity : existingRow.intensity;
      const mergedPositiveAction = params.positiveAction !== undefined ? params.positiveAction : existingRow.positive_action;
      const mergedScenario = params.scenario !== undefined ? params.scenario : existingRow.scenario;
      const mergedWhyCore = params.whyCore !== undefined ? params.whyCore : existingRow.why_core;
      const mergedPredictionError = params.predictionError !== undefined ? params.predictionError : existingRow.prediction_error;
      const mergedPredictionDelta = params.predictionDelta !== undefined ? params.predictionDelta : existingRow.prediction_delta;

      this.db.prepare(`
        UPDATE memories SET
          tags = ?, knowledge_gap = ?, intensity = ?, positive_action = ?, scenario = ?, why_core = ?,
          predicted_factors = ?, actual_factors = ?, prediction_error = ?, prediction_delta = ?,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(
        JSON.stringify(mergedTags), mergedKnowledgeGap, mergedIntensity, mergedPositiveAction,
        mergedScenario, mergedWhyCore, mergedPredictedFactors, mergedActualFactors,
        mergedPredictionError, mergedPredictionDelta,
        duplicate.id
      );
      this.incrementAccessCount([duplicate.id]);
      return {
        success: true,
        id: duplicate.id,
        path: "sqlite",
        message: `Deduplicated into existing ${duplicate.id} in ${params.category}`,
      };
    }

    const insertStmt = this.db.prepare(`
      INSERT INTO memories (id, timestamp, category, title, content, tags, project, scope, intensity, knowledge_gap, positive_action, scenario, why_core, predicted_factors, actual_factors, prediction_error, prediction_delta, project_confidence, content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertStmt.run(
      id, timestamp, params.category, params.title, params.content, tags,
      params.project ?? null, params.scope ?? null, params.intensity ?? null,
      knowledgeGap, positiveAction, scenario, whyCore,
      predictedFactors, actualFactors, predictionError, predictionDelta,
      projectConfidence, contentHash
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
    try {
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
    } catch (error) {
      this.recordWriteFailure("delete", error);
      throw error;
    }
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
    try {
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
    } catch (error) {
      this.recordWriteFailure("softDelete", error);
      throw error;
    }
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
    const trimmedQuery = params.query ? params.query.trim() : "";
    const usesFts = trimmedQuery.length >= 3;
    const usesLike = trimmedQuery.length > 0 && trimmedQuery.length < 3;

    let rows: MemoryRow[];
    let countRow: { count: number };
    // 発火したフォールバック段（タスク2.10: ヒットの経路可視化）。FTS経路で段がヒットしたときのみ非null。
    // LIKE/空クエリ経路には段の概念が無いためnullのまま（hintにもラベルは付かない）。
    let fallbackStage: FtsFallbackStage | null = null;

    // 可視性マトリクス: 検索はactiveのみ可（I1）。
    if (usesFts) {
      // FTS経路は段階フォールバック（フレーズ→AND→OR）で候補を取得する（design.md Phase2定義1）。
      const staged = this.searchFtsStaged(trimmedQuery, params, limit);
      rows = staged.rows;
      countRow = staged.countRow;
      fallbackStage = staged.stage;
    } else {
      let query: string;
      const queryParams: (string | number)[] = [];
      if (usesLike) {
        const likePattern = `%${trimmedQuery}%`;
        query = `SELECT * FROM memories WHERE (title LIKE ? OR content LIKE ? OR tags LIKE ?) AND state = 'active'`;
        queryParams.push(likePattern, likePattern, likePattern);
      } else {
        query = "SELECT * FROM memories WHERE 1=1 AND state = 'active'";
      }

      if (params.category && params.category !== "all") {
        query += ` AND category = ?`;
        queryParams.push(params.category);
      }
      if (params.project) {
        query += ` AND (project IS NULL OR project = 'unknown' OR project = ?)`; // R-A4 AC3: unknown帰属も既定で検索対象に残す
        queryParams.push(params.project);
      }
      if (params.scope) {
        query += ` AND (scope IS NULL OR scope = 'general' OR scope = ?)`;
        queryParams.push(params.scope);
      }

      // LIKE/空クエリ経路には関連度シグナルが無いため、従来通りtimestamp DESCを維持する。
      query += ` ORDER BY timestamp DESC LIMIT ?`;
      queryParams.push(limit);
      rows = this.db.prepare(query).all(...queryParams) as MemoryRow[];

      let countQuery: string;
      const countParams = queryParams.slice(0, -1);
      if (usesLike) {
        countQuery = "SELECT COUNT(*) as count FROM memories WHERE (title LIKE ? OR content LIKE ? OR tags LIKE ?) AND state = 'active'";
      } else {
        countQuery = "SELECT COUNT(*) as count FROM memories WHERE 1=1 AND state = 'active'";
      }
      if (params.category && params.category !== "all") {
        countQuery += ` AND category = ?`;
      }
      if (params.project) {
        countQuery += ` AND (project IS NULL OR project = 'unknown' OR project = ?)`;
      }
      if (params.scope) {
        countQuery += ` AND (scope IS NULL OR scope = 'general' OR scope = ?)`;
      }

      countRow = this.db.prepare(countQuery).get(...countParams) as { count: number };
    }

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
      hint: buildSearchHint(indexEntries.length, fallbackStage),
      fallbackStage: fallbackStage ?? undefined,
    };
  }


  // --- ハイブリッド検索 (TASK-015、関連度RRF統合) ---

  searchHybrid(params: SearchParams, queryEmbedding: number[]): SearchResult {
    const limit = params.limit ?? config.defaultSearchLimit;

    // R-B3（自己検索性）判定に使う正規化クエリ。FTS候補生成用のtrimmedQとは別に、
    // スコアリングループ（時間減衰の自己一致例外）から参照できるメソッドスコープ変数として持つ。
    const normalizedQuery = params.query ? params.query.trim() : "";

    // 1. FTS5キーワード候補プール（3文字未満はLIKEフォールバック）。
    //    いずれの経路も「関連度が高い順」に並べて取得する（FTSはrank昇順、
    //    LIKEには関連度シグナルが無いのでtimestamp DESCで決定的に順序付ける）。
    //    順位（0始まりindex）がそのままRRF統合時のpositionになる。
    const ftsRankedIds: string[] = [];
    // 発火したフォールバック段（タスク2.10: ヒットの経路可視化）。FTS候補プールで段がヒットしたときのみ
    // 非null。LIKE経路・空クエリ・ベクトルのみのヒットには段の概念が無いためnullのまま。
    let fallbackStage: FtsFallbackStage | null = null;
    if (params.query && params.query.trim()) {
      const trimmedQ = params.query.trim();

      // 可視性マトリクス: 検索(ハイブリッド)はactiveのみ可（I1）。
      if (trimmedQ.length >= 3) {
        // FTS経路は段階フォールバック（フレーズ→AND→OR）で候補を取得する（design.md Phase2定義1）。
        const staged = this.searchHybridFtsCandidates(trimmedQ, params);
        ftsRankedIds.push(...staged.ids);
        fallbackStage = staged.stage;
      } else {
        const likePattern = `%${trimmedQ}%`;
        let ftsQuery = `SELECT id FROM memories WHERE (title LIKE ? OR content LIKE ? OR tags LIKE ?) AND state = 'active'`;
        const ftsParams: (string | number)[] = [likePattern, likePattern, likePattern];

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
        ftsQuery += " ORDER BY timestamp DESC LIMIT ?";
        ftsParams.push(SEARCH_CANDIDATE_POOL);

        const ftsRows = this.db.prepare(ftsQuery).all(...ftsParams) as { id: string }[];
        for (const row of ftsRows) {
          ftsRankedIds.push(row.id);
        }
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
    //    + 最終スコアリング（design.md Phase2定義4: finalScore = rrfScore × 0.5^(ageDays/H)）。
    //    「関連度の芯」としてrrfScore×timeDecayをSearchScorerへ渡すことで、design.mdのReuces注記
    //    （line 422: search-scorer.ts「利用実績加点」）が名指しする利用実績ブーストのみを、
    //    既存の計算式（search-scorer.ts）を重複実装せずに再利用する。
    //    タグ一致ブースト（matchedTagWeights）はdesign.md Phase2のReuses注記に記載がなく、
    //    ゴールデンセット較正の結果（recall@5 0.622→0.486への悪化を実測）から意図的に不採用とし、
    //    常に空配列を渡してtagWeightScore=1.0（中立）に固定する。クエリ×タグ照合関数
    //    （matchQueryToTags）自体もPdM裁定によりコードベースから削除済み（weighted-tag.ts参照）。
    //    predictionErrorも実データ0件（タスク0.0で物理削除決定済みの旧ループ）のため常にundefined＝中立。
    //    recencyの反映元はこのtime-decayのみに一本化済み（SearchScorerのfreshness項は除去済み・
    //    二重減衰の禁止）。
    const candidateIds = Array.from(rrfScores.keys());
    const vectorMetadataMap = this.getVectorMetadata(candidateIds);
    const predictionErrorMap = this.getPredictionErrors(candidateIds);

    const scoredEntries: Array<{ entry: MemoryIndexEntry; score: number; timestamp: string }> = [];
    for (const [id, rrfScore] of rrfScores) {
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

      const tags = JSON.parse(row.tags) as string[];
      const ageDays = computeAgeDays(row.timestamp);
      // R-B3（自己検索性）保証: クエリが記憶本文と完全一致する自己検索では、経年減衰で自己が
      // 沈まないよう当該候補のみ減衰を無効化する（timeDecay=1.0）。発火条件は「クエリ＝本文
      // （正規化後）」に限定されるため、日常検索（クエリ≠本文＝言い換え・キーワード）には一切
      // 作用しない。ゴールデン評価のrecallは減衰適用時と完全一致する（recall@1=0.324・@5=0.622・
      // @10=0.784で減衰適用時とバイト一致を実測）。発火するのは自己とその完全重複のみで、他
      // エントリの自己検索性を新たに損なわない（PT-04全生存9,596件でunique-body本文の新規失敗0を実測）。
      const isExactSelfMatch = normalizedQuery.length > 0 && row.content.trim() === normalizedQuery;
      const timeDecay = isExactSelfMatch ? 1.0 : computeTimeDecay(ageDays);
      const meta = vectorMetadataMap.get(id);
      const finalScore = SearchScorer.score({
        vectorSimilarity: rrfScore * timeDecay,
        matchedTagWeights: [],
        accessCount: meta ? meta.accessCount : 0,
        predictionError: predictionErrorMap.get(id),
      });

      scoredEntries.push({
        entry: {
          id: row.id,
          timestamp: row.timestamp,
          category: row.category as MemoryCategory,
          title: row.title,
          tags,
          project: row.project ?? undefined,
          scope: row.scope ?? undefined,
          intensity: row.intensity ?? undefined,
        },
        score: finalScore,
        timestamp: row.timestamp,
      });
    }

    // 5. 最終スコア（時間減衰込みRRF×ブースト）降順。同点の場合のみtimestamp DESCでタイブレークする。
    scoredEntries.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
    });

    const limited = scoredEntries.slice(0, limit).map((e) => e.entry);

    return {
      results: limited,
      totalCount: scoredEntries.length,
      hint: buildSearchHint(limited.length, fallbackStage),
      fallbackStage: fallbackStage ?? undefined,
    };
  }

  getContext(currentProject?: string): ContextResult {
    const configEntries = this.readConfigEntries(currentProject);
    const dedupedConfig = this.deduplicateConfigEntries(configEntries);
    const configCap = capContextEntries(
      dedupedConfig,
      GET_CONTEXT_MAX_ENTRIES,
      GET_CONTEXT_MAX_CHARS,
      (e) => `### ${e.title}\n${e.content}`,
      "\n\n",
    );

    const dontEntries = this.readDontEntries(currentProject);
    const dontCap = capContextEntries(
      dontEntries,
      GET_CONTEXT_MAX_ENTRIES,
      GET_CONTEXT_MAX_CHARS,
      (e) => formatEntry(e),
      "",
    );

    // 最終読取時刻を刻む: config/dont は SessionStart Hook で毎セッション自動注入される真の読取経路。
    // updated_at/intensity/timestamp には触れない（markLastRead は last_read_at 専用・順位付けに不干渉）。
    // この2カテゴリは毎回配信されるため、忘却 dry-run では常にほぼ0候補になる（バグではなく
    // 「毎回参照される情報」という性質の反映で、レポートのカテゴリ別内訳に自然に表れる）。
    const readIds = [
      ...configEntries.map((e) => e.id),
      ...dontEntries.map((e) => e.id),
    ];
    if (readIds.length > 0) {
      this.markLastRead(readIds);
    }

    // 世界モデル更新: 予測が大きく外れた上位N件を surface（学ぶべき外れ）
    const worldModelEntries = this.listHighErrorEntries(WORLD_MODEL_MIN_ERROR, WORLD_MODEL_LIMIT);
    const worldModelFormatted = worldModelEntries
      .map((e) => {
        const errPct = Math.round((e.predictionError ?? 0) * 100);
        const delta = e.predictionDelta ? `\n${e.predictionDelta}` : "";
        return `### ${e.title}（予測ずれ ${errPct}%）${delta}`;
      })
      .join("\n\n");

    // 上限で切られたことは黙って切り捨てず、応答本文にもマーカー行として明示する
    // （タスク4.4・design.md禁止フォールバック#6系の類型「無言の切り捨て」を避ける）。
    let configFormatted = configCap.formatted || "（設定情報なし）";
    if (configCap.truncated) {
      configFormatted += `\n\n（上限により省略: 全${configCap.totalEntries}件中${configCap.returnedEntries}件のみ表示）`;
    }
    let dontFormatted = dontCap.formatted || "（ルールなし）";
    if (dontCap.truncated) {
      dontFormatted += `\n\n（上限により省略: 全${dontCap.totalEntries}件中${dontCap.returnedEntries}件のみ表示）`;
    }

    const result: ContextResult = {
      config: configFormatted,
      dont: dontFormatted,
      truncated: configCap.truncated || dontCap.truncated,
    };
    if (worldModelFormatted) {
      result.worldModelUpdates = worldModelFormatted;
    }
    return result;
  }

  /**
   * 注入ビルダ用の最小索引を取得する（design.md「最小索引」定義・タスク4.2）。
   * state='active' のタイトル行のみを、直近アクセス上位（last_read_at）を優先しつつ
   * timestamp降順で上限 limit 件まで返す。本文（content）は含めない
   * （全文を持ち回るコード経路を作らないため。索引のみ→詳細は memory_get_detail へpull）。
   */
  getMinimalIndexEntries(currentProject: string | undefined, limit: number): Array<{
    id: string;
    title: string;
    category: MemoryCategory;
  }> {
    let query =
      "SELECT id, title, category FROM memories WHERE state = 'active'";
    const params: string[] = [];
    if (currentProject) {
      query += " AND (project IS NULL OR project = 'unknown' OR project = ?)";
      params.push(currentProject);
    }
    query += " ORDER BY last_read_at IS NULL, last_read_at DESC, timestamp DESC LIMIT ?";

    const rows = this.db.prepare(query).all(...params, limit) as Array<{
      id: string;
      title: string;
      category: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      category: row.category as MemoryCategory,
    }));
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

  /**
   * カテゴリ限定の近傍探索（統合候補生成用・タスク3.4／R-A6, R-B4）。
   *
   * 従来の統合候補生成は全カテゴリKNN（searchVectors）で近傍枠を取り、後段でカテゴリ外を捨てて
   * いた（近傍枠の浪費）。本メソッドは vec0 KNN を過剰取得したうえで active な対象カテゴリの行だけへ
   * 事前に絞り込み、L2距離を l2ToCosineSim でコサイン類似度へ変換して meetsSimilarity（型付き・
   * 尺度混同不可）で閾値判定する。返す限界件数は limit。
   *
   * vec0 は追加WHEREを後段適用（KNN後フィルタ）するため、カテゴリで削られる分を見越して
   * 内部の k を limit より大きく取る（over-fetch）。
   */
  searchVectorsByCategory(
    queryEmbedding: number[],
    category: string,
    threshold: Threshold<"cosineSim">,
    limit: number,
  ): { id: string; similarity: CosineSimilarity }[] {
    const buf = this.embeddingToBuffer(queryEmbedding);
    // カテゴリで削られる分を見越した過剰取得。テーブル総数を上限にクランプする（k>行数はエラー要因を避ける）。
    const totalVectors = (
      this.db.prepare("SELECT COUNT(*) as c FROM vectors").get() as { c: number }
    ).c;
    if (totalVectors === 0) return [];
    const overFetchK = Math.min(Math.max(limit * 10, 100), totalVectors);

    const rows = this.db.prepare(
      `SELECT v.id AS id, v.distance AS distance
       FROM vectors v
       JOIN memories m ON m.id = v.id
       WHERE v.embedding MATCH ? AND v.k = ?
         AND m.category = ? AND m.state = 'active'`
    ).all(buf, overFetchK, category) as { id: string; distance: number }[];

    const out: { id: string; similarity: CosineSimilarity }[] = [];
    for (const row of rows) {
      const sim = l2ToCosineSim(asL2Distance(row.distance));
      if (meetsSimilarity(sim, threshold)) {
        out.push({ id: row.id, similarity: sim });
      }
      if (out.length >= limit) break;
    }
    return out;
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

  /**
   * 埋め込み非依存の最終読取時刻を刻む（schema v8 の memories.last_read_at 列）。
   *
   * 真の読取経路（get_detail の明示取得・get_context の config/dont 自動注入）でのみ呼ばれ、
   * active 行の last_read_at のみを datetime('now') で更新する。updated_at / intensity / timestamp /
   * access_count には一切触れない（search.ts:87-91 が明示する「読み取りで可変状態を書き換えると
   * 時間減衰順位を汚染する」設計原則を壊さないため。last_read_at は順位付けに使わない専用列）。
   * この列は忘却 dry-run（forgetting-sweep.ts）が参照時刻の一次シグナルとして使う。
   */
  markLastRead(ids: string[]): void {
    const stmt = this.db.prepare(
      "UPDATE memories SET last_read_at = datetime('now') WHERE id = ? AND state = 'active'"
    );

    for (const id of ids) {
      stmt.run(id);
    }
  }

  /**
   * 忘却の実退避: 長期未参照の active 行を archived へ論理退避する（物理削除しない・可逆）。
   *
   * active 行のみを対象にし（WHERE state='active'）、archived/deleted 行や last_read_at 等の
   * 他カラムには一切触れない。呼び出し側（forgetting-sweep.ts applyForgettingSweep）は
   * computeForgettingSweep が選定した候補 id（config/dont 保護・窓判定済み）だけを渡す。
   * 物理削除・vectors 削除はしないため archived は get_detail で読め、restoreArchived で戻せる。
   *
   * @returns 実際に archived へ遷移させた件数。
   */
  archiveMemories(ids: string[]): number {
    const stmt = this.db.prepare(
      "UPDATE memories SET state = 'archived' WHERE id = ? AND state = 'active'"
    );

    let archived = 0;
    const tx = this.db.transaction((targetIds: string[]) => {
      for (const id of targetIds) {
        archived += stmt.run(id).changes;
      }
    });
    tx(ids);
    return archived;
  }

  /**
   * 読み取り専用の判定関数（cap-sweep / forgetting-sweep の compute 系）へ渡す用の生コネクション。
   * これらの純関数は与えられた Database を SELECT するだけで書き込まない。書き込みは storage の
   * 名前付きメソッド（archiveMemories 等）に閉じる。
   */
  get connection(): Database.Database {
    return this.db;
  }

  /**
   * 忘却で archived にした記憶を active へ戻す（可逆退避の復元経路）。
   *
   * 忘却の実退避（forgetting-sweep.ts applyForgettingSweep）は物理削除ではなく
   * state='archived' への論理退避なので、この API で元に戻せる。archived 行のみを対象にし
   * （WHERE state='archived'）、他 state（active/deleted）や last_read_at 等には触れない。
   * memory_stash/memory_restore（stash テーブルの一時退避）とは別系統で、こちらは記憶本体の退避復元。
   *
   * @returns 実際に active へ戻した件数。
   */
  restoreArchived(ids: string[]): number {
    const stmt = this.db.prepare(
      "UPDATE memories SET state = 'active' WHERE id = ? AND state = 'archived'"
    );

    // archiveMemories と対称に db.transaction で包む。ループ途中で SQLITE_BUSY 等が起きても
    // 一部だけ active 化して restored カウントを失う（部分適用）ことを防ぐ。シグネチャ ((ids)=>number)
    // は不変なので既存呼び出し元（forgetting-sweep.test.ts:357）は無影響。
    let restored = 0;
    const tx = this.db.transaction((targetIds: string[]) => {
      for (const id of targetIds) {
        restored += stmt.run(id).changes;
      }
    });
    tx(ids);
    return restored;
  }

  /**
   * 忘却で archived にした記憶の一覧を返す（アンアーカイブ導線の発見経路・読み取り専用）。
   *
   * state='archived' の行のみを対象にし（他 state=active/deleted には触れない）、本文（content）は
   * 含めず索引情報だけを返す（全文を持ち回るコード経路を作らない設計＝getMinimalIndexEntries と同方針）。
   * 並び順は最終参照時刻の新しい順→timestamp降順（直近まで使っていた退避を上位に出す）。
   * 復元は restoreArchived(ids) が担い、こちらは選定のための読み取りだけを行う。
   */
  listArchived(limit: number = 100): Array<{
    id: string;
    title: string;
    category: MemoryCategory;
    project: string | null;
    timestamp: string;
    lastReadAt: string | null;
  }> {
    const rows = this.db
      .prepare(
        "SELECT id, title, category, project, timestamp, last_read_at FROM memories " +
          "WHERE state = 'archived' " +
          "ORDER BY last_read_at IS NULL, last_read_at DESC, timestamp DESC LIMIT ?"
      )
      .all(limit) as Array<{
      id: string;
      title: string;
      category: string;
      project: string | null;
      timestamp: string;
      last_read_at: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      category: r.category as MemoryCategory,
      project: r.project,
      timestamp: r.timestamp,
      lastReadAt: r.last_read_at,
    }));
  }

  /**
   * 追記型マージ（Phase 3 / R-A6・タスク3.7）。統合結果を「新レコード」として追記し、
   * 吸収された原本は本文を一切書き換えず deleted へ論理遷移させ、その索引行（vectors /
   * vector_metadata）を同一トランザクションで除去する。原本行の本文 UPDATE も物理 DELETE も
   * しない（append-only・非破壊。可逆情報は lineage の merged_from で保全）。
   *
   * severance 対策: 破壊 SQL はこの定義ファイル（sqlite.ts=STORAGE_PRIMITIVE_DEF_FILES）内に閉じ、
   * 呼び出し側は名前付き `.applyAppendOnlyMerge(` のみを使う（CLOSURE_WRITE_PATTERNS 非一致）。
   *
   * @returns 追記された新レコード id と、deleted へ遷移した原本 id の一覧。
   */
  applyAppendOnlyMerge(input: { merged: SaveParams; sourceIds: string[] }): {
    mergedId: string;
    absorbedIds: string[];
  } {
    const insertLineageStmt = this.db.prepare(
      "INSERT INTO lineage (id, child_id, parent_id, relation, created_at) VALUES (?, ?, ?, 'merged_from', datetime('now'))"
    );
    const softDeleteStmt = this.db.prepare(
      "UPDATE memories SET deleted_at = datetime('now'), state = 'deleted' WHERE id = ? AND state = 'active'"
    );
    const deleteVec = this.db.prepare("DELETE FROM vectors WHERE id = ?");
    const deleteMeta = this.db.prepare("DELETE FROM vector_metadata WHERE id = ?");

    const tx = this.db.transaction(() => {
      // 統合結果は saveInternal で新規 INSERT（原本は一切触らない＝append-only）。
      const saved = this.saveInternal(input.merged);
      const mergedId = saved.id;
      const absorbedIds: string[] = [];
      for (const sid of input.sourceIds) {
        // マージ結果の 100% に merged_from 系譜を付与（原本が既に非activeでも来歴は残す）。
        insertLineageStmt.run(this.generateId(), mergedId, sid);
        const changed = softDeleteStmt.run(sid).changes;
        if (changed > 0) {
          // deleted へ遷移した原本のみ索引行を同一トランザクションで除去（I2維持）。
          deleteVec.run(sid);
          deleteMeta.run(sid);
          absorbedIds.push(sid);
        }
      }
      return { mergedId, absorbedIds };
    });
    return tx();
  }

  /**
   * supersedes 系譜を1件記録する（Phase 3 / タスク3.8）。newId が oldId を上書き（優先）する関係。
   * 原本（oldId）の本文・state は変更しない（記録のみ）。表示側で旧版を下げるために使う。
   */
  insertSupersedes(newId: string, oldId: string): void {
    this.db.prepare(
      "INSERT INTO lineage (id, child_id, parent_id, relation, created_at) VALUES (?, ?, ?, 'supersedes', datetime('now'))"
    ).run(this.generateId(), newId, oldId);
  }

  /** child_id の merged_from 親（吸収した原本 id）を新しい順で返す（タスク3.7検証／表示用）。 */
  getMergeParents(childId: string): string[] {
    return (
      this.db.prepare(
        "SELECT parent_id FROM lineage WHERE child_id = ? AND relation = 'merged_from' ORDER BY created_at, id"
      ).all(childId) as { parent_id: string }[]
    ).map((r) => r.parent_id);
  }

  /**
   * oldId を supersede している新版 id を返す（無ければ null）。検索結果の旧版抑制に使う（タスク3.8）。
   * 複数あれば最新の1件（created_at 降順）。
   */
  getSupersededBy(oldId: string): string | null {
    const row = this.db.prepare(
      "SELECT child_id FROM lineage WHERE parent_id = ? AND relation = 'supersedes' ORDER BY created_at DESC, id DESC LIMIT 1"
    ).get(oldId) as { child_id: string } | undefined;
    return row?.child_id ?? null;
  }

  // ── 確定原則（principles）: 昇格の人間ゲート（Phase 3・タスク3.11／R-A7）──
  // 起草は state='proposed'（approved_at=NULL）で入り、CLI 承認でのみ 'approved' へ遷移する。
  // 自動昇格の経路は storage に存在しない（approve は明示的な人間操作のみが呼ぶ）。

  /** 起草済み原則を1件 INSERT する（state='proposed'・approved_at=NULL）。検証は promotion 層で先に行う。 */
  insertPrinciple(p: {
    id: string;
    text: string;
    originTier: "owner_confirmed" | "agent_observed";
    evidenceIds: string[];
    validUntil: string;
  }): void {
    this.db.prepare(
      `INSERT INTO principles (id, text, origin_tier, evidence_ids, valid_until, state, approved_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'proposed', NULL, datetime('now'))`
    ).run(p.id, p.text, p.originTier, JSON.stringify(p.evidenceIds), p.validUntil);
  }

  /** proposed の原則を承認する（approved_at を刻む）。proposed 以外は変更しない。@returns 承認件数(0/1)。 */
  approvePrinciple(id: string, now: Date = new Date()): number {
    return this.db.prepare(
      "UPDATE principles SET state = 'approved', approved_at = ? WHERE id = ? AND state = 'proposed'"
    ).run(now.toISOString(), id).changes;
  }

  /** proposed の原則を却下する。proposed 以外は変更しない。@returns 却下件数(0/1)。 */
  rejectPrinciple(id: string): number {
    return this.db.prepare(
      "UPDATE principles SET state = 'rejected' WHERE id = ? AND state = 'proposed'"
    ).run(id).changes;
  }

  /**
   * valid_until が到来した approved 原則を expired へ遷移させる（TTL失効）。
   * @returns 失効させた件数。
   */
  expirePrinciples(now: Date = new Date()): number {
    return this.db.prepare(
      "UPDATE principles SET state = 'expired' WHERE state = 'approved' AND valid_until <= ?"
    ).run(now.toISOString()).changes;
  }

  /**
   * 注入対象になれる原則（承認済み・approved_at 非NULL・TTL未到来）を返す。
   * approved_at が NULL の原則や、未承認/失効/却下は決して返さない（R-A7 の構造遮断）。
   */
  getInjectablePrinciples(now: Date = new Date()): {
    id: string;
    text: string;
    originTier: string;
    validUntil: string;
  }[] {
    const rows = this.db.prepare(
      `SELECT id, text, origin_tier AS originTier, valid_until AS validUntil
       FROM principles
       WHERE state = 'approved' AND approved_at IS NOT NULL AND valid_until > ?
       ORDER BY created_at`
    ).all(now.toISOString()) as { id: string; text: string; originTier: string; validUntil: string }[];
    return rows;
  }

  /** 指定 state（未指定なら全件）の原則を一覧する（CLI 表示用・本文含む）。 */
  listPrinciples(state?: "proposed" | "approved" | "expired" | "rejected"): {
    id: string;
    text: string;
    originTier: string;
    state: string;
    validUntil: string;
    approvedAt: string | null;
  }[] {
    const sql = state
      ? `SELECT id, text, origin_tier AS originTier, state, valid_until AS validUntil, approved_at AS approvedAt FROM principles WHERE state = ? ORDER BY created_at`
      : `SELECT id, text, origin_tier AS originTier, state, valid_until AS validUntil, approved_at AS approvedAt FROM principles ORDER BY created_at`;
    const stmt = this.db.prepare(sql);
    return (state ? stmt.all(state) : stmt.all()) as {
      id: string;
      text: string;
      originTier: string;
      state: string;
      validUntil: string;
      approvedAt: string | null;
    }[];
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
