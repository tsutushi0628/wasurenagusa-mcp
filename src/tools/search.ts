import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { MarkdownStorage } from "../storage/index.js";
import { SearchParams, MemoryCategory, MemoryIndexEntry } from "../types.js";
import { EmbeddingService } from "../vector/embedding-service.js";
import { VectorStore } from "../vector/vector-store.js";
import { TIER_THRESHOLDS, shouldPromoteToCritical } from "../vector/memory-tier.js";
import { SearchScorer } from "../vector/search-scorer.js";
import { parseWeightedTags } from "../vector/weighted-tag.js";
import { config, getMemoryPath } from "../config.js";
import { homedir } from "os";
import { join } from "path";

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
        description: "最大取得件数。デフォルトは20"
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
  const storage = new MarkdownStorage(projectRoot);

  const params: SearchParams = {
    query: args.query as string,
    category: (args.category as MemoryCategory | "all") || "all",
    limit: (args.limit as number) || 20,
    project: args.project as string | undefined,
    scope: args.scope as string | undefined,
  };

  const result = await storage.search(params);
  const limit = params.limit || 20;

  // ベクトル検索結果のdistanceマップ
  const vectorDistanceMap = new Map<string, number>();

  // ベクトル検索（APIキーがある場合のみ）
  const embeddingService = new EmbeddingService(config.geminiApiKey);
  let vectorStore: VectorStore | null = null;
  if (embeddingService.isAvailable()) {
    try {
      const memoryPath = getMemoryPath(projectRoot);
      vectorStore = new VectorStore(memoryPath);
      const queryEmbedding = await embeddingService.embed(params.query);
      const vectorResults = await vectorStore.search(
        queryEmbedding,
        TIER_THRESHOLDS.medium,
        limit
      );

      // distanceマップ構築
      for (const vr of vectorResults) {
        vectorDistanceMap.set(vr.id, vr.distance);
      }

      // キーワード結果のIDセット
      const keywordIds = new Set(result.results.map(r => r.id));

      // ベクトルのみの結果ID
      const vectorOnlyIds: string[] = [];
      for (const vr of vectorResults) {
        if (!keywordIds.has(vr.id)) {
          vectorOnlyIds.push(vr.id);
        }
      }

      // アクセスカウント更新
      const allVectorIds = vectorResults.map(vr => vr.id);
      if (allVectorIds.length > 0) {
        await vectorStore.incrementAccessCount(allVectorIds);
      }

      // critical昇格チェック
      for (const vr of vectorResults) {
        if (shouldPromoteToCritical(vr.accessCount + 1)) {
          try {
            const detail = await storage.getDetail({ ids: [vr.id] });
            if (detail.entries.length > 0) {
              const entry = detail.entries[0];
              if (entry.intensity === undefined || entry.intensity < 5) {
                await storage.save({
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

      // ベクトルのみの結果をマージ（MarkdownStorageから詳細取得してインデックス化）
      if (vectorOnlyIds.length > 0) {
        const detail = await storage.getDetail({ ids: vectorOnlyIds });
        const vectorIndexEntries: MemoryIndexEntry[] = detail.entries.map(entry => ({
          id: entry.id,
          timestamp: entry.timestamp,
          category: entry.category,
          title: entry.title,
          tags: entry.tags,
          project: entry.project,
          scope: entry.scope,
          intensity: entry.intensity,
        }));
        result.results.push(...vectorIndexEntries);
        result.totalCount += vectorIndexEntries.length;
      }
    } catch (error) {
      console.error("[vector] ベクトル検索失敗:", error);
      // ベクトル検索失敗はキーワード結果に影響しない
    }
  }

  // SearchScorerによるランキング
  if (vectorStore && result.results.length > 0) {
    try {
      const allIds = result.results.map(r => r.id);
      const metadata = await vectorStore.getEntryMetadata(allIds);

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
        });

        return { entry, score };
      });

      scored.sort((a, b) => b.score - a.score);
      result.results = scored.map(s => s.entry);
    } catch (error) {
      console.error("[search] スコアリング失敗:", error);
      // スコアリング失敗時は既存順序を維持
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
        const projStorage = new MarkdownStorage(proj.path);
        const projResults = await projStorage.search({
          query: params.query,
          category: params.category,
          limit: params.limit,
        });

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

        // プロジェクト別ベクトル検索
        if (embeddingService.isAvailable()) {
          try {
            const projMemoryPath = getMemoryPath(proj.path);
            const projVectorStore = new VectorStore(projMemoryPath);
            const projQueryEmbedding = await embeddingService.embed(params.query);
            const projVectorResults = await projVectorStore.search(
              projQueryEmbedding,
              TIER_THRESHOLDS.medium,
              limit
            );

            const existingIds = new Set(result.results.map(r => r.id));
            const projVectorOnlyIds: string[] = [];
            for (const vr of projVectorResults) {
              if (!existingIds.has(vr.id)) {
                projVectorOnlyIds.push(vr.id);
              }
            }

            if (projVectorOnlyIds.length > 0) {
              const projDetail = await projStorage.getDetail({ ids: projVectorOnlyIds });
              const projVectorEntries: MemoryIndexEntry[] = projDetail.entries.map(entry => ({
                id: entry.id,
                timestamp: entry.timestamp,
                category: entry.category,
                title: `[${proj.name}] ${entry.title}`,
                tags: entry.tags,
                project: entry.project,
                scope: entry.scope,
                intensity: entry.intensity,
              }));
              result.results.push(...projVectorEntries);
              result.totalCount += projVectorEntries.length;
            }
          } catch {
            // プロジェクト別ベクトル検索失敗はスキップ
          }
        }
      } catch {
        // 個別プロジェクトの検索失敗はスキップ
        continue;
      }
    }
  }

  return JSON.stringify(result, null, 2);
}
