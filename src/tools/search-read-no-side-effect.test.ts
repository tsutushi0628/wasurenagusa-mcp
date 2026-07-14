import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// LocalEmbedding のみモックし、実モデル非依存で「埋め込み利用可能」の read 経路を通す。
// SQLiteStorage・config・memory-tier は実物のまま使い、実DBの可変状態が読み取りで不変かを検証する。
// （既存の search-*.test.ts は SQLiteStorage を丸ごとモックするため実DBの書き換えを観測できない。
//  副作用は searchHybrid ではなく handleMemorySearch 本体にあったので、実DB＋実 read 経路で検査する。）
const mockEmbed = vi.fn();
vi.mock("../vector/local-embedding.js", async (importOriginal) => {
  // schema.ts が同モジュールの DEFAULT_MODEL 等を参照するため、実exportは温存して
  // LocalEmbedding クラスだけ差し替える（部分モック）。
  const actual = await importOriginal<typeof import("../vector/local-embedding.js")>();
  class MockLocalEmbedding {
    constructor(_modelDir: string) {}
    initialize = vi.fn().mockResolvedValue(undefined);
    isAvailable = vi.fn().mockReturnValue(true);
    embed = mockEmbed;
  }
  return { ...actual, LocalEmbedding: MockLocalEmbedding };
});

import { SQLiteStorage } from "../storage/sqlite.js";
import { getMemoryPath, config } from "../config.js";
import { handleMemorySearch } from "./search.js";
import { mutableStateHash } from "../storage/mutable-state-hash.js";

function makeVector(values: Record<number, number>): number[] {
  const vec = new Array(384).fill(0);
  for (const [idx, val] of Object.entries(values)) {
    vec[Number(idx)] = val;
  }
  return vec;
}

describe("handleMemorySearch - 読み経路の副作用ゼロ（R-B2 AC3・タスク2.7）", () => {
  let tmpDir: string;
  let projectRoot: string;
  let dbPath: string;
  const selfContent = "読み取りで記録が書き換わらないことを検証する本文";

  beforeEach(() => {
    vi.clearAllMocks();
    // クエリ埋め込みは常にシード済みベクトルと完全一致（距離0）を返す。
    mockEmbed.mockResolvedValue(makeVector({ 0: 1.0 }));

    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-readonly-test-"));
    projectRoot = tmpDir;
    const memoryPath = getMemoryPath(projectRoot);
    mkdirSync(memoryPath, { recursive: true });
    dbPath = join(memoryPath, config.sqliteFile);

    // 旧実装の2つの読み経路書き込み（アクセス計数の加算・破壊的critical自動昇格）が「必ず発火する」
    // 条件を1件で満たす: ベクトルはクエリと距離0で必ず候補入り、access_count は昇格閾値(5)超の6、
    // intensity は昇格対象となる5未満。撤去が戻ればこの1件で確実に可変状態が書き換わり検知できる。
    const storage = new SQLiteStorage(dbPath);
    storage.initialize(memoryPath);
    const entry = storage.save({
      category: "config",
      title: "読み取り不変検証用エントリ",
      content: selfContent,
      intensity: 3,
    });
    storage.upsertVector(entry.id, makeVector({ 0: 1.0 }));
    const db = (storage as unknown as { db: { prepare: (sql: string) => { run: (...a: unknown[]) => unknown } } }).db;
    db.prepare("UPDATE vector_metadata SET access_count = 6 WHERE id = ?").run(entry.id);
    storage.close();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("検索を実行しても memories.intensity/timestamp と vector_metadata.access_count が一切変わらない", async () => {
    const before = mutableStateHash(dbPath);

    // 実 read 経路を起動。旧実装ならこの1回で access_count が加算され、閾値超により intensity=5 へ
    // 破壊的昇格され、after が before と乖離する。副作用ゼロなら両テーブルとも不変。
    await handleMemorySearch({ query: selfContent, limit: 10 }, projectRoot);

    const after = mutableStateHash(dbPath);

    // 読みは順位付け状態（intensity/timestamp/access_count）を変えない（R-B2 AC3）。副作用撤去を
    // 戻すと、access_count 加算か破壊的昇格のいずれかで after が before と食い違い落ちる（真の回帰検知器）。
    // last_read_at は mutableStateHash の対象外（順位付けに使わない専用列）なので、下の検索による
    // 最終読取時刻の更新はこの不変条件に抵触しない。
    expect(after.vectorMeta).toEqual(before.vectorMeta);
    expect(after.memories).toEqual(before.memories);

    // 一方で last_read_at は検索ヒットで更新される（検索でのみ参照される記憶を忘却から守る・rank1）。
    const lraDb = new Database(dbPath, { readonly: true });
    try {
      const lra = (
        lraDb.prepare("SELECT last_read_at FROM memories LIMIT 1").get() as { last_read_at: string | null }
      ).last_read_at;
      expect(lra).not.toBeNull();
    } finally {
      lraDb.close();
    }

    // read 経路の best-effort 操作ログ（fire-and-forget）が afterEach の一時ディレクトリ削除と
    // 競合しないよう短く待つ（g2-search.ts の後測待機と同趣旨。ログはDB可変状態には無関係）。
    await new Promise((r) => setTimeout(r, 100));
  });
});
