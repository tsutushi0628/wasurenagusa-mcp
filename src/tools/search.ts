import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { SQLiteStorage } from "../storage/sqlite.js";
import { SearchParams, MemoryCategory, MemoryIndexEntry } from "../types.js";
import { LocalEmbedding } from "../vector/local-embedding.js";
import { TIER_THRESHOLDS, shouldPromoteToCritical } from "../vector/memory-tier.js";
import { SearchScorer } from "../vector/search-scorer.js";
import { parseWeightedTags } from "../vector/weighted-tag.js";
import { config, getMemoryPath } from "../config.js";
import { homedir } from "os";
import { join, basename } from "path";
import { logOperation, setLastSearch, generateSearchSessionId, generateJstTimestamp } from "../utils/operation-logger.js";

export const memorySearchTool: Tool = {
  name: "memory_search",
  description: `メモリを検索する。【重要】このツールは軽量インデックス（ID, タイトル, タグ）のみを返す。
フル内容が必要な場合は、返されたIDを memory_get_detail に渡すこと。
全件の詳細を取得せず、必要なものだけ取得してトークンを節約すること。`,
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "検索クエリ（キーワード）"
      },
      category: {
        type: "string",
        enum: ["config", "dont", "decision", "log", "snippet", "all"],
        description: "検索対象カテゴリ。デフォルトはall"
      },
      limit: {
        type: "number",
        description: "最大取得件数。デフォルトは5"
      },
      project: {
        type: "string",
        description: "プロジェクトフィルタ（オプション）。指定するとそのプロジェクト+プロジェクト未指定のエントリのみ返却。\"active\"を指定すると最近作業した上位5プロジェクト横断で検索"
      },
      scope: {
        type: "string",
        description: "スコープフィルタ（オプション）。指定するとそのscope+general+scope未指定のエントリのみ返却"
      }
    },
    required: ["query"]
  }
};

function computeDaysSinceAccess(lastAccessedAt: string): number {
  const lastAccess = new Date(lastAccessedAt).getTime();
  const now = Date.now();
  return Math.max(0, (now - lastAccess) / (1000 * 60 * 60 * 24));
}

function matchQueryToTags(query: string, tags: string[]): number[] {
  const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const weightedTags = parseWeightedTags(tags);
  const matchedWeights: number[] = [];

  for (const wt of weightedTags) {
    const tagLower = wt.tag.toLowerCase();
    for (const term of queryTerms) {
      if (tagLower.includes(term) || term.includes(tagLower)) {
        matchedWeights.push(wt.weight);
        break;
      }
    }
  }

  return matchedWeights;
}

export async function handleMemorySearch(
  args: Record<string, unknown>,
  projectRoot: string
): Promise<string> {
  const startTime = Date.now();
  const memoryPath = getMemoryPath(projectRoot);
  const dbPath = join(memoryPath, config.sqliteFile);
  const storage = new SQLiteStorage(dbPath);
  storage.initialize(memoryPath);

  const params: SearchParams = {
    query: args.query as string,
    category: (args.category as MemoryCategory | "all") || "all",
    limit: (args.limit as number) || 5,
    project: args.project as string | undefined,
    scope: args.scope as string | undefined,
  };

  const limit = params.limit || 5;

  // LocalEmbedding初期化
  const modelsDir = join(memoryPath, config.modelsDir);
  const localEmbedding = new LocalEmbedding(modelsDir);
  let embeddingAvailable = false;
  try {
    await localEmbedding.initialize();
    embeddingAvailable = localEmbedding.isAvailable();
  } catch (error) {
    console.error("[search] LocalEmbedding初期化失敗:", error);
  }

  // ベクトル検索のdistanceマップ
  const vectorDistanceMap = new Map<string, number>();
  let result;

  if (embeddingAvailable) {
    try {
      const queryEmbedding = await localEmbedding.embed(params.query);

      // ハイブリッド検索（FTS5 + ベクトル）
      result = storage.searchHybrid(params, queryEmbedding);

      // ベクトル検索結果のdistanceマップ構築
      const vectorResults = storage.searchVectors(queryEmbedding, TIER_THRESHOLDS.medium, limit);
      for (const vr of vectorResults) {
        vectorDistanceMap.set(vr.id, vr.distance);
      }

      // アクセスカウント更新
      const allVectorIds = vectorResults.map(vr => vr.id);
      if (allVectorIds.length > 0) {
        storage.incrementAccessCount(allVectorIds);
      }

      // critical昇格チェック
      for (const vr of vectorResults) {
        const meta = storage.getVectorMetadata([vr.id]);
        const entryMeta = meta.get(vr.id);
        const accessCount = entryMeta ? entryMeta.accessCount : 0;
        if (shouldPromoteToCritical(accessCount)) {
          try {
            const detail = storage.getDetail({ ids: [vr.id] });
            if (detail.entries.length > 0) {
              const entry = detail.entries[0];
              if (entry.intensity === undefined || entry.intensity < 5) {
                storage.save({
                  category: entry.category,
                  content: entry.content,
                  title: entry.title,
                  tags: entry.tags,
                  project: entry.project,
                  scope: entry.scope,
                  intensity: 5,
                  replaceId: entry.id,
                });
              }
            }
          } catch {
            // 昇格失敗は無視
          }
        }
      }
    } catch (error) {
      console.error("[search] ハイブリッド検索失敗、FTS5にフォールバック:", error);
      result = storage.search(params);
    }
  } else {
    // embedding不可 → FTS5のみ
    result = storage.search(params);
  }

  // SearchScorerによるランキング
  if (result.results.length > 0) {
    try {
      const allIds = result.results.map(r => r.id);
      const metadata = storage.getVectorMetadata(allIds);
      // 予測誤差: 差分が大きいエントリほど surface 加点する（無いエントリは恒等で素通り）
      const predictionErrors = storage.getPredictionErrors(allIds);

      const scored = result.results.map(entry => {
        const meta = metadata.get(entry.id);
        const distance = vectorDistanceMap.get(entry.id);
        const vectorSimilarity = distance !== undefined ? 1 - distance : 1.0;
        const daysSinceLastAccess = meta
          ? computeDaysSinceAccess(meta.lastAccessedAt)
          : 0;
        const accessCount = meta ? meta.accessCount : 0;
        const matchedTagWeights = matchQueryToTags(params.query, entry.tags);

        const score = SearchScorer.score({
          vectorSimilarity,
          matchedTagWeights,
          daysSinceLastAccess,
          accessCount,
          predictionError: predictionErrors.get(entry.id),
        });

        return { entry, score };
      });

      scored.sort((a, b) => b.score - a.score);
      result.results = scored.map(s => s.entry);
    } catch (error) {
      console.error("[search] スコアリング失敗:", error);
    }
  }

  // アクティブプロジェクト横断検索
  if (params.project === "active") {
    const { ActiveProjectsTracker } = await import("../active-projects.js");
    const schedulerDir = join(homedir(), ".wasurenagusa", "scheduler");
    const activeTracker = new ActiveProjectsTracker(schedulerDir);
    const activeProjects = await activeTracker.getActiveProjects();

    for (const proj of activeProjects) {
      try {
        const projMemoryPath = getMemoryPath(proj.path);
        const projDbPath = join(projMemoryPath, config.sqliteFile);
        const projStorage = new SQLiteStorage(projDbPath);
        projStorage.initialize(projMemoryPath);

        let projResults;
        if (embeddingAvailable) {
          try {
            const projQueryEmbedding = await localEmbedding.embed(params.query);
            projResults = projStorage.searchHybrid(
              { query: params.query, category: params.category, limit: params.limit },
              projQueryEmbedding
            );
          } catch {
            projResults = projStorage.search({
              query: params.query,
              category: params.category,
              limit: params.limit,
            });
          }
        } else {
          projResults = projStorage.search({
            query: params.query,
            category: params.category,
            limit: params.limit,
          });
        }

        // プロジェクト名プレフィックスを付与してマージ
        const prefixedResults = projResults.results.map(r => ({
          ...r,
          title: `[${proj.name}] ${r.title}`,
        }));

        // ID重複排除
        for (const entry of prefixedResults) {
          const exists = result.results.some(existing => existing.id === entry.id);
          if (!exists) {
            result.results.push(entry);
            result.totalCount += 1;
          }
        }

        projStorage.close();
      } catch {
        continue;
      }
    }
  }

  // 再発防止リスト（高強度dont）を毎回付与
  // クエリ無関係に直近で怒られた事項を surface する
  try {
    const angerEntries = storage.listHighIntensityDonts(4, 5);

    // active プロジェクト指定時は他プロジェクトの高強度dontも合流
    if (params.project === "active") {
      const { ActiveProjectsTracker } = await import("../active-projects.js");
      const schedulerDir = join(homedir(), ".wasurenagusa", "scheduler");
      const activeTracker = new ActiveProjectsTracker(schedulerDir);
      const activeProjects = await activeTracker.getActiveProjects();

      for (const proj of activeProjects) {
        try {
          const projMemoryPath = getMemoryPath(proj.path);
          const projDbPath = join(projMemoryPath, config.sqliteFile);
          const projStorage = new SQLiteStorage(projDbPath);
          projStorage.initialize(projMemoryPath);
          const projAnger = projStorage.listHighIntensityDonts(4, 5).map(e => ({
            ...e,
            title: `[${proj.name}] ${e.title}`,
          }));
          for (const entry of projAnger) {
            const exists = angerEntries.some(existing => existing.id === entry.id);
            if (!exists) {
              angerEntries.push(entry);
            }
          }
          projStorage.close();
        } catch {
          continue;
        }
      }
    }

    // intensity降順でソート、上位5件のみ
    angerEntries.sort((a, b) => (b.intensity ?? 0) - (a.intensity ?? 0));
    if (angerEntries.length > 0) {
      result.angerHistory = angerEntries.slice(0, 5);
    }
  } catch (error) {
    console.error("[search] angerHistory取得失敗:", error);
  }

  storage.close();

  // 軽量化: AI向けに id, title, positiveAction（angerHistory用）のみに絞る
  // 詳細（category/intensity/tags/project等）は memory_get_detail で取得
  const slimEntry = (e: { id: string; title: string }) => ({ id: e.id, title: e.title });
  const slimAngerEntry = (e: { id: string; title: string; positiveAction?: string; scenario?: string; whyCore?: string }) => {
    const result: { id: string; title: string; positiveAction: string; scenario?: string; whyCore?: string } = {
      id: e.id,
      title: e.title,
      positiveAction: e.positiveAction ?? e.title,
    };
    if (e.scenario) { result.scenario = e.scenario; }
    if (e.whyCore) { result.whyCore = e.whyCore; }
    return result;
  };
  const slimResult: {
    results: ReturnType<typeof slimEntry>[];
    totalCount: number;
    hint: string;
    angerHistory?: ReturnType<typeof slimAngerEntry>[];
  } = {
    results: result.results.map(slimEntry),
    totalCount: result.totalCount,
    hint: result.hint,
  };
  if (result.angerHistory && result.angerHistory.length > 0) {
    slimResult.angerHistory = result.angerHistory.map(slimAngerEntry);
  }
  const resultJson = JSON.stringify(slimResult, null, 2);
  const sessionId = generateSearchSessionId();
  const resultIds = result.results.map((r: MemoryIndexEntry) => r.id);
  void logOperation({ ts: generateJstTimestamp(), operation_type: "search", session_id: sessionId, query: params.query, category: params.category ?? "all", hit_count: result.results.length, project: basename(projectRoot), duration_ms: Date.now() - startTime }, memoryPath).catch(() => {});
  setLastSearch(basename(projectRoot), sessionId, resultIds);
  return resultJson;
}
