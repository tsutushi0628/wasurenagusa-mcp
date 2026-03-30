#!/usr/bin/env node
/**
 * retag-worker
 * detachedプロセスとして起動され、新テーマに関連する過去エントリを
 * バックグラウンドで再タグ付けする。
 *
 * 使い方: node retag-worker.js <newThemesJson> <projectRoot>
 */

import { MarkdownStorage } from "../storage/index.js";
import { EmbeddingService } from "../vector/embedding-service.js";
import { VectorStore } from "../vector/vector-store.js";
import { TagEnricher } from "../vector/tag-enricher.js";
import { parseWeightedTags, formatWeightedTags } from "../vector/weighted-tag.js";
import { TIER_THRESHOLDS } from "../vector/memory-tier.js";
import { config, getMemoryPath } from "../config.js";
import { WeightedTag } from "../types.js";

const MAX_RETAG_ENTRIES = 20;

function mergeTags(existing: WeightedTag[], enriched: WeightedTag[]): WeightedTag[] {
  const tagMap = new Map<string, number>();

  for (const wt of existing) {
    tagMap.set(wt.tag, wt.weight);
  }
  for (const wt of enriched) {
    const current = tagMap.get(wt.tag);
    tagMap.set(wt.tag, current !== undefined ? Math.max(current, wt.weight) : wt.weight);
  }

  return [...tagMap.entries()].map(([tag, weight]) => ({ tag, weight }));
}

export async function retagEntries(
  newThemes: string[],
  projectRoot: string,
): Promise<void> {
  const memoryPath = getMemoryPath(projectRoot);
  const storage = new MarkdownStorage(projectRoot);
  const embeddingService = new EmbeddingService(config.geminiApiKey);
  const vectorStore = new VectorStore(memoryPath);
  const tagEnricher = new TagEnricher(config.geminiApiKey);

  // 新テーマでベクトル検索して関連エントリを見つける
  const relatedIds = new Set<string>();
  for (const theme of newThemes) {
    const queryEmbedding = await embeddingService.embed(theme);
    const results = await vectorStore.search(
      queryEmbedding,
      TIER_THRESHOLDS.medium,
      MAX_RETAG_ENTRIES,
    );
    for (const r of results) {
      relatedIds.add(r.id);
    }
  }

  const idsToProcess = [...relatedIds].slice(0, MAX_RETAG_ENTRIES);
  if (idsToProcess.length === 0) return;

  const detail = await storage.getDetail({ ids: idsToProcess });

  for (const entry of detail.entries) {
    try {
      const existingWeightedTags = parseWeightedTags(entry.tags);
      const enrichResult = await tagEnricher.enrich(
        entry.title,
        entry.content,
        entry.tags,
        [],
      );

      const merged = mergeTags(existingWeightedTags, enrichResult.tags);
      const mergedFormatted = formatWeightedTags(merged);

      await storage.save({
        category: entry.category,
        content: entry.content,
        title: entry.title,
        tags: mergedFormatted,
        project: entry.project,
        scope: entry.scope,
        intensity: entry.intensity,
        replaceId: entry.id,
      });
    } catch (error) {
      console.error(`[retag-worker] エントリ ${entry.id} の再タグ付け失敗:`, error);
      // 個別エントリの失敗は他に影響しない
    }
  }
}

// CLI直接実行
if (process.argv[1]?.endsWith("retag-worker.js")) {
  const [newThemesJson, projectRoot] = process.argv.slice(2);
  if (!newThemesJson || !projectRoot) {
    process.exit(1);
  }
  const newThemes = JSON.parse(newThemesJson) as string[];
  retagEntries(newThemes, projectRoot).catch(() => {
    process.exit(1);
  });
}
