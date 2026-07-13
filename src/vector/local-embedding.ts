import { pipeline, env, type FeatureExtractionPipeline } from "@huggingface/transformers";

export const EMBEDDING_DIMENSIONS = 384;
// 多言語モデル（日本語含む意味検索の自己検索実測: top5 72.0%→92.7%、圏外8.7%→2.0%）。
// 次元は384のまま変わらない（旧 Xenova/all-MiniLM-L6-v2 と同じベクトル表の器を使い続けられる）。
export const DEFAULT_MODEL = "Xenova/multilingual-e5-small";

// e5系モデルは非対称プレフィックスが前提（intfloat/multilingual-e5-smallモデルカード準拠）。
// 文書側（保存対象）は "passage: "、検索クエリ側は "query: " を付与しないと類似度分布が機能しない。
export type EmbedUsage = "passage" | "query";

export function buildPrefixedText(text: string, usage: EmbedUsage): string {
  const prefix = usage === "query" ? "query: " : "passage: ";
  return prefix + text;
}

export class LocalEmbedding {
  private extractor: FeatureExtractionPipeline | null = null;
  private readonly modelDir: string;
  private readonly modelName: string;

  constructor(modelDir: string, modelName: string = DEFAULT_MODEL) {
    this.modelDir = modelDir;
    this.modelName = modelName;
  }

  async initialize(): Promise<void> {
    // キャッシュディレクトリをmodelDirに設定
    env.cacheDir = this.modelDir;
    env.allowRemoteModels = true;

    this.extractor = await pipeline(
      "feature-extraction",
      this.modelName,
      { dtype: "fp32" },
    ) as FeatureExtractionPipeline;
  }

  isAvailable(): boolean {
    return this.extractor !== null;
  }

  async embed(text: string, usage: EmbedUsage): Promise<number[]> {
    if (!text) {
      throw new Error("embed: text must not be empty");
    }
    if (!this.extractor) {
      throw new Error("LocalEmbedding not initialized. Call initialize() first.");
    }

    const output = await this.extractor(buildPrefixedText(text, usage), {
      pooling: "mean",
      normalize: true,
    });

    return Array.from(output.data as Float32Array);
  }

  async embedBatch(texts: string[], usage: EmbedUsage): Promise<number[][]> {
    if (texts.length === 0) {
      throw new Error("embedBatch: texts must not be empty");
    }
    if (!this.extractor) {
      throw new Error("LocalEmbedding not initialized. Call initialize() first.");
    }

    const prefixedTexts = texts.map((t) => buildPrefixedText(t, usage));
    const output = await this.extractor(prefixedTexts, {
      pooling: "mean",
      normalize: true,
    });

    // バッチ出力: [batchSize, dimensions] の2Dテンソル
    const data = output.data as Float32Array;
    const dimensions = EMBEDDING_DIMENSIONS;
    const results: number[][] = [];

    for (let i = 0; i < texts.length; i++) {
      const start = i * dimensions;
      const end = start + dimensions;
      results.push(Array.from(data.slice(start, end)));
    }

    return results;
  }

  async dispose(): Promise<void> {
    // transformers.js の pipeline.dispose() は PreTrainedModel.dispose() → session.release()
    // まで到達し、ONNX ネイティブ(off-heap)セッションの重みを解放する。未初期化なら何もしない。
    if (this.extractor) {
      await this.extractor.dispose();
      this.extractor = null;
    }
  }
}

// --- 共有埋め込みプロバイダ（プロセス内シングルトン + アイドルTTL解放） ---------------
// 長寿命の stdio MCP サーバでは、save/search のたびに new LocalEmbedding()+initialize() すると
// ネイティブ(off-heap)の ONNX セッションが毎回生成されて解放されず RSS が増え続ける。
// modelDir と modelName の複合キーで1インスタンスへ集約して使い回し、アイドルが一定時間続いたら
// dispose でネイティブ解放する。次回利用時は同じキーで再ロード（ディスク読込のみ）される。
// 返すラッパは固定インスタンスを捕捉せず、呼び出しごとに現在の共有エントリを解決して
// 破棄済み/未初期化なら再初期化する（self-heal）。acquire→use 窓やアイドルTTL満了後の
// 呼び出しでも例外を投げずベクトルを欠落させない。

export interface SharedEmbedding {
  isAvailable(): boolean;
  embed(text: string, usage: EmbedUsage): Promise<number[]>;
  embedBatch(texts: string[], usage: EmbedUsage): Promise<number[][]>;
}

interface SharedEmbeddingEntry {
  instance: LocalEmbedding;
  // 初期化 Promise を保持する（インスタンスだけでなく）。同時初回呼び出しがそれぞれ
  // initialize() を走らせるとモデルを二重ロードしてレースになるため、全員が同一の初期化
  // Promise を await して1回だけロードさせる。
  initPromise: Promise<void>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  // dispose 中に embed が走らないよう、進行中の embed 件数を数える。
  inflight: number;
}

const DEFAULT_IDLE_TTL_MS = 300_000; // 5分
const sharedEmbeddings = new Map<string, SharedEmbeddingEntry>();

// 共有インスタンスのキャッシュキー。modelDir だけをキーにすると、同じディレクトリを
// 別モデル名で使ったとき衝突して誤ったモデルを共有してしまう。modelDir と modelName の
// 両方を含めて衝突しないキーにし、生成・探索・破棄の全経路で本関数を通す。
// 区切りは改行（ファイルパス・モデル名のいずれにも現れない）。
function sharedKey(modelDir: string, modelName: string): string {
  return `${modelDir}\n${modelName}`;
}

function resolveIdleTtlMs(): number {
  const raw = process.env.WASURENAGUSA_EMBEDDING_IDLE_TTL_MS;
  if (raw === undefined) {
    return DEFAULT_IDLE_TTL_MS;
  }
  const parsed = Number(raw);
  if (isNaN(parsed) || parsed <= 0) {
    return DEFAULT_IDLE_TTL_MS;
  }
  return parsed;
}

function scheduleIdleDisposal(key: string): void {
  const entry = sharedEmbeddings.get(key);
  if (!entry) {
    return;
  }
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
  }
  const timer = setTimeout(() => {
    void disposeIfIdle(key);
  }, resolveIdleTtlMs());
  // unref: このTTLタイマーがイベントループを生かし続けると、親プロセス死亡時に MCP サーバが
  // 正常終了できなくなる（zombie-reaper.ts の生死判定を妨げる）。タイマーはプロセスの生存に
  // 関与させない。
  timer.unref();
  entry.idleTimer = timer;
}

async function disposeIfIdle(key: string): Promise<void> {
  const entry = sharedEmbeddings.get(key);
  if (!entry) {
    return;
  }
  // 進行中の embed があるならネイティブ解放しない（使用中の session を壊さない）。
  // 再スケジュールは各 embed 完了時の finally で行われるので取りこぼさない。
  if (entry.inflight > 0) {
    return;
  }
  entry.idleTimer = null;
  sharedEmbeddings.delete(key);
  // このパスはアイドルTTLタイマーから void で発火するため、dispose の reject を捕まえないと
  // unhandledRejection になり、Node の既定では長寿命 MCP サーバを落としかねない。エントリは
  // 既に Map から外して自己回復済みなので、解放失敗はログに残して握り潰す。
  try {
    await entry.instance.dispose();
  } catch (error) {
    console.error("[embedding] アイドル解放でのdispose失敗（エントリは除去済み、継続）:", error);
  }
}

async function runTracked<T>(
  key: string,
  entry: SharedEmbeddingEntry,
  fn: () => Promise<T>,
): Promise<T> {
  // 進行中フラグを立て、保留中の解放タイマーを止める（この呼び出し中に dispose させない）。
  entry.inflight += 1;
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
  try {
    return await fn();
  } finally {
    entry.inflight -= 1;
    // 呼び出し完了時点から改めてアイドル計時を開始する。
    if (entry.inflight === 0) {
      scheduleIdleDisposal(key);
    }
  }
}

/**
 * 指定キーの共有エントリを「初期化済みで available な状態」で解決して返す。
 *
 * - 未登録: 新規に生成して initialize() し、初期化 Promise を entry に保持する
 *   （同時初回呼び出しが二重ロードしないよう promise-cache する既存機構を維持）。
 * - 登録済み: 進行中/完了済みの初期化 Promise に相乗りする。相乗り待機中にアイドル解放で
 *   破棄されていたら（Map から消えている or 未 available）、再帰で作り直す（self-heal）。
 *
 * これにより acquire→use 窓やアイドルTTL満了後でも、常に生きたエントリを返せる。
 */
async function ensureInitialized(
  key: string,
  modelDir: string,
  modelName: string,
): Promise<SharedEmbeddingEntry> {
  const existing = sharedEmbeddings.get(key);
  if (!existing) {
    const instance = new LocalEmbedding(modelDir, modelName);
    const initPromise = instance.initialize();
    const entry: SharedEmbeddingEntry = { instance, initPromise, idleTimer: null, inflight: 0 };
    sharedEmbeddings.set(key, entry);
    try {
      await initPromise;
    } catch (error) {
      // 初期化に失敗したら壊れたエントリを残さない（次回呼び出しで再挑戦させる）。
      // self-heal で並行に作り直された別エントリは消さないよう、自分が入れた entry のみ削除する。
      if (sharedEmbeddings.get(key) === entry) {
        sharedEmbeddings.delete(key);
      }
      throw error;
    }
    // 初期化成功直後は available、かつ fresh entry にアイドルタイマーは未スケジュール
    // （runTracked の finally で初めて計時開始）。ここで破棄される隙間は無い。
    return entry;
  }
  // 既存エントリ: 進行中/完了済みの初期化 Promise に相乗りする。
  await existing.initPromise;
  const current = sharedEmbeddings.get(key);
  if (current && current.instance.isAvailable()) {
    return current;
  }
  // 相乗り待機中にアイドル解放で破棄された（Map から消えた or 未 available）→ 作り直す。
  // promise-cache により、この再帰は二重ロードにならない。
  return ensureInitialized(key, modelDir, modelName);
}

/**
 * modelDir と modelName の複合キーで共有 LocalEmbedding を返す。初回はロードして初期化し、
 * 以後は同一インスタンスを使い回す。アイドルが WASURENAGUSA_EMBEDDING_IDLE_TTL_MS（既定5分）
 * 続いたら dispose でネイティブ解放し、次回呼び出しで再初期化される。
 *
 * 返すラッパの isAvailable/embed/embedBatch は固定インスタンスを捕捉せず、呼び出しのたびに
 * 現在の共有エントリを解決する（self-heal）。破棄済み/未初期化なら ensureInitialized 経由で
 * 再初期化してから委譲するため、acquire→use 窓やアイドルTTL満了後でも例外を投げず
 * ベクトルを欠落させない。
 */
export async function getSharedEmbedding(
  modelDir: string,
  modelName: string = DEFAULT_MODEL,
): Promise<SharedEmbedding> {
  const key = sharedKey(modelDir, modelName);
  // acquire 時点で1回初期化を確定させる（isAvailable が直後に true を返せるように）。
  await ensureInitialized(key, modelDir, modelName);

  return {
    isAvailable: () => {
      // 現在の共有エントリを解決して委譲する（破棄済みの固定インスタンスを見ない）。
      // 同期メソッドのため再初期化は行わないが、embed/embedBatch 側が self-heal する。
      const entry = sharedEmbeddings.get(key);
      return entry ? entry.instance.isAvailable() : false;
    },
    embed: async (text, usage) => {
      const entry = await ensureInitialized(key, modelDir, modelName);
      return runTracked(key, entry, () => entry.instance.embed(text, usage));
    },
    embedBatch: async (texts, usage) => {
      const entry = await ensureInitialized(key, modelDir, modelName);
      return runTracked(key, entry, () => entry.instance.embedBatch(texts, usage));
    },
  };
}

/**
 * 共有埋め込みを即時破棄する（テスト・明示的なリソース解放用）。TTLタイマーを止めて
 * ネイティブセッションを解放する。
 *
 * modelDir を渡すと、その modelDir 配下の全モデル名バリアント（複合キー）を破棄する。
 * 省略時は全エントリを破棄する。
 */
export async function disposeSharedEmbedding(modelDir?: string): Promise<void> {
  const allKeys = Array.from(sharedEmbeddings.keys());
  const targets =
    modelDir !== undefined
      ? allKeys.filter((k) => k === modelDir || k.startsWith(`${modelDir}\n`))
      : allKeys;
  for (const key of targets) {
    const entry = sharedEmbeddings.get(key);
    if (!entry) {
      continue;
    }
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    sharedEmbeddings.delete(key);
    await entry.instance.dispose();
  }
}
