import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { SQLiteStorage } from "../storage/sqlite.js";
import { SearchParams, MemoryCategory, MemoryIndexEntry } from "../types.js";
import { getSharedEmbedding, type SharedEmbedding } from "../vector/local-embedding.js";
import { config, getMemoryPath, getModelsDir } from "../config.js";
import { buildSearchHint } from "../storage/search-hint.js";
import { homedir } from "os";
import { join, basename } from "path";
import { logOperation, setLastSearch, generateSearchSessionId, generateJstTimestamp } from "../utils/operation-logger.js";
import { increment } from "../observability/counters.js";

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

export async function handleMemorySearch(
  args: Record<string, unknown>,
  projectRoot: string
): Promise<string> {
  const startTime = Date.now();
  const memoryPath = getMemoryPath(projectRoot);
  const dbPath = join(memoryPath, config.sqliteFile);
  const storage = new SQLiteStorage(dbPath);

  // 読み経路のDBハンドルは try/finally で必ず閉じ、例外時のリークを封じる（タスク2.7 ③・同一関数の根治範囲）。
  // initialize() 自体がthrowし得る（拡張ロード失敗等）ため、try の最初の文として実行し、
  // finally が確実に届く範囲に含める（コンストラクタで既に開いた接続をここで漏らさない）。
  try {
    storage.initialize(memoryPath);
    const params: SearchParams = {
      query: args.query as string,
      category: (args.category as MemoryCategory | "all") || "all",
      limit: (args.limit as number) || 5,
      project: args.project as string | undefined,
      scope: args.scope as string | undefined,
    };

    // 共有埋め込みを利用（プロセス内シングルトン + アイドルTTL解放。WASURENAGUSA_MODEL_CACHE_DIR
    // 設定時は共有キャッシュ先へ、タスク1.13）。呼び出し後に dispose しない（使い回すのが目的で、
    // 解放はアイドルTTLタイマーの役目）。
    const modelsDir = getModelsDir(memoryPath);
    let localEmbedding: SharedEmbedding | null = null;
    let embeddingAvailable = false;
    try {
      localEmbedding = await getSharedEmbedding(modelsDir);
      embeddingAvailable = localEmbedding.isAvailable();
    } catch (error) {
      console.error("[search] LocalEmbedding初期化失敗:", error);
    }

    let result;

    if (embeddingAvailable && localEmbedding) {
      try {
        const queryEmbedding = await localEmbedding.embed(params.query, "query");

        // ハイブリッド検索（FTS5 + ベクトル）。読み経路は副作用ゼロ（R-B2 AC3・タスク2.7）:
        // 旧実装にあったアクセス計数の書き込み（incrementAccessCount）と破壊的critical自動昇格
        // （intensity/timestampを書き換える storage.save）はこの経路から廃止した。読み取りで
        // 可変状態（intensity/timestamp/access_count）を書き換えると時間減衰順位を汚染するため。
        // 利用実績の反映は searchHybrid 内の既存スコア加点（accessCount加点）に一本化されている。
        result = storage.searchHybrid(params, queryEmbedding);
      } catch (error) {
        console.error("[search] ハイブリッド検索失敗、FTS5にフォールバック:", error);
        result = storage.search(params);
      }
    } else {
      // embedding不可 → FTS5のみ
      result = storage.search(params);
    }

    // アクティブプロジェクト横断検索
    if (params.project === "active") {
      const { ActiveProjectsTracker } = await import("../active-projects.js");
      const schedulerDir = join(homedir(), ".wasurenagusa", "scheduler");
      const activeTracker = new ActiveProjectsTracker(schedulerDir);
      const activeProjects = await activeTracker.getActiveProjects();

      for (const proj of activeProjects) {
        // DBハンドルは try 内で開き finally で必ず閉じる。SQLiteStorage コンストラクタは
        // eager に new Database() を開くため、消えた/移動した stale なアクティブプロジェクトの
        // パスでは SQLITE_CANTOPEN を投げる。コンストラクタも try 内に入れることで、その throw も
        // catch{continue} が受けて当該プロジェクトだけスキップする（外側 try は catch を持たないため、
        // try 外で投げると検索全体が中断してしまう。catch{continue} のループ継続挙動を厳密に維持）。
        const projMemoryPath = getMemoryPath(proj.path);
        const projDbPath = join(projMemoryPath, config.sqliteFile);
        let projStorage: SQLiteStorage | null = null;
        try {
          projStorage = new SQLiteStorage(projDbPath);
          projStorage.initialize(projMemoryPath);

          let projResults;
          if (embeddingAvailable && localEmbedding) {
            try {
              const projQueryEmbedding = await localEmbedding.embed(params.query, "query");
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
        } catch {
          continue;
        } finally {
          projStorage?.close();
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
          // DBハンドルは try 内で開き finally で必ず閉じる（同型2箇所目・タスク2.7 ④）。
          // コンストラクタも try 内: stale なプロジェクトパスでの new Database() throw を
          // catch{continue} が受け、angerHistory 合流の中断を防ぐ（catch{continue} 挙動を維持）。
          const projMemoryPath = getMemoryPath(proj.path);
          const projDbPath = join(projMemoryPath, config.sqliteFile);
          let projStorage: SQLiteStorage | null = null;
          try {
            projStorage = new SQLiteStorage(projDbPath);
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
          } catch {
            continue;
          } finally {
            projStorage?.close();
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
      // hintはマージ後の最終件数から再導出する（既存規約）。フォールバック段ラベルは起点プロジェクト
      // （projectRoot）検索で発火した段を用いる（タスク2.10: ヒットの経路可視化。アクティブプロジェクト
      // 横断マージは起点のfallbackStageを変更しない）。
      hint: buildSearchHint(result.results.length, result.fallbackStage),
    };
    if (result.angerHistory && result.angerHistory.length > 0) {
      slimResult.angerHistory = result.angerHistory.map(slimAngerEntry);
    }
    const resultJson = JSON.stringify(slimResult, null, 2);
    const sessionId = generateSearchSessionId();
    const resultIds = result.results.map((r: MemoryIndexEntry) => r.id);
    void logOperation({ ts: generateJstTimestamp(), operation_type: "search", session_id: sessionId, query: params.query, category: params.category ?? "all", hit_count: result.results.length, project: basename(projectRoot), duration_ms: Date.now() - startTime }, memoryPath).catch(() => {});
    setLastSearch(basename(projectRoot), sessionId, resultIds);

    // 可観測性カウンタ（タスク0.9、R-M1）: ゼロヒット率算出用の分母・分子を記録する
    void increment(memoryPath, "search_total", 1);
    if (result.results.length === 0) {
      void increment(memoryPath, "search_zero_hit", 1);
    }
    return resultJson;
  } finally {
    storage.close();
  }
}
