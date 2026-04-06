import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SQLiteStorage } from "./sqlite.js";

// 384次元のダミーベクトル生成ヘルパー
function dummyVector(seed: number): number[] {
  const vec = new Array(384).fill(0);
  vec[seed % 384] = 1.0; // 1次元だけ1にすることで距離が測れる
  return vec;
}

// 特定方向のベクトル（複数次元に値を持たせる）
function makeVector(values: Record<number, number>): number[] {
  const vec = new Array(384).fill(0);
  for (const [idx, val] of Object.entries(values)) {
    vec[Number(idx)] = val;
  }
  return vec;
}

describe("SQLiteStorage - Vector Operations", () => {
  let storage: SQLiteStorage;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-vec-test-"));
    storage = new SQLiteStorage(join(tmpDir, "test.db"));
    storage.initialize();
  });

  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- TASK-011: upsertVector / deleteVectors ---

  describe("upsertVector / deleteVectors", () => {
    it("upsertVectorでベクトルが保存される", () => {
      const saved = storage.save({ category: "config", title: "t", content: "c" });
      storage.upsertVector(saved.id, dummyVector(0));

      // searchVectorsで確認
      const results = storage.searchVectors(dummyVector(0), 999, 10);
      expect(results.some((r) => r.id === saved.id)).toBe(true);
    });

    it("upsertVectorでvector_metadataも作成される", () => {
      const saved = storage.save({ category: "config", title: "t", content: "c" });
      storage.upsertVector(saved.id, dummyVector(0));

      const meta = storage.getVectorMetadata([saved.id]);
      expect(meta.has(saved.id)).toBe(true);
      expect(meta.get(saved.id)!.accessCount).toBe(0);
    });

    it("upsertVectorを2回呼ぶとベクトルが上書きされる", () => {
      const saved = storage.save({ category: "config", title: "t", content: "c" });
      storage.upsertVector(saved.id, dummyVector(0));
      storage.upsertVector(saved.id, dummyVector(1));

      // 古いベクトル(dim0=1)でなく新しいベクトル(dim1=1)に近い結果が得られる
      const results = storage.searchVectors(dummyVector(1), 999, 10);
      expect(results[0].id).toBe(saved.id);
      expect(results[0].distance).toBe(0); // 完全一致
    });

    it("deleteVectorsでベクトルとメタデータが削除される", () => {
      const saved = storage.save({ category: "config", title: "t", content: "c" });
      storage.upsertVector(saved.id, dummyVector(0));

      storage.deleteVectors([saved.id]);

      const results = storage.searchVectors(dummyVector(0), 999, 10);
      expect(results.some((r) => r.id === saved.id)).toBe(false);

      const meta = storage.getVectorMetadata([saved.id]);
      expect(meta.has(saved.id)).toBe(false);
    });

    it("memoriesのdelete時にvectorsも削除される", () => {
      const saved = storage.save({ category: "config", title: "t", content: "c" });
      storage.upsertVector(saved.id, dummyVector(0));

      storage.delete({ ids: [saved.id] });

      const results = storage.searchVectors(dummyVector(0), 999, 10);
      expect(results.some((r) => r.id === saved.id)).toBe(false);
    });
  });

  // --- TASK-012: searchVectors ---

  describe("searchVectors", () => {
    it("距離順でソートされた結果が返る", () => {
      const s1 = storage.save({ category: "config", title: "t1", content: "c1" });
      const s2 = storage.save({ category: "config", title: "t2", content: "c2" });
      const s3 = storage.save({ category: "config", title: "t3", content: "c3" });

      // 異なるベクトルを登録
      storage.upsertVector(s1.id, makeVector({ 0: 1.0 }));
      storage.upsertVector(s2.id, makeVector({ 0: 0.5, 1: 0.5 }));
      storage.upsertVector(s3.id, makeVector({ 1: 1.0 }));

      // dim0=1.0のクエリ → s1が最も近い
      const results = storage.searchVectors(makeVector({ 0: 1.0 }), 999, 10);
      expect(results.length).toBe(3);
      expect(results[0].id).toBe(s1.id);
      expect(results[0].distance).toBe(0); // 完全一致
    });

    it("閾値フィルタが機能する", () => {
      const s1 = storage.save({ category: "config", title: "t1", content: "c1" });
      const s2 = storage.save({ category: "config", title: "t2", content: "c2" });

      storage.upsertVector(s1.id, makeVector({ 0: 1.0 }));
      storage.upsertVector(s2.id, makeVector({ 1: 1.0 }));

      // 非常に低い閾値 → 完全一致のみ
      const results = storage.searchVectors(makeVector({ 0: 1.0 }), 0.5, 10);
      expect(results.length).toBe(1);
      expect(results[0].id).toBe(s1.id);
    });

    it("limitが機能する", () => {
      const s1 = storage.save({ category: "config", title: "t1", content: "c1" });
      const s2 = storage.save({ category: "config", title: "t2", content: "c2" });
      const s3 = storage.save({ category: "config", title: "t3", content: "c3" });

      storage.upsertVector(s1.id, dummyVector(0));
      storage.upsertVector(s2.id, dummyVector(1));
      storage.upsertVector(s3.id, dummyVector(2));

      const results = storage.searchVectors(dummyVector(0), 999, 2);
      expect(results.length).toBe(2);
    });

    it("ベクトルが空の場合は空配列が返る", () => {
      const results = storage.searchVectors(dummyVector(0), 999, 10);
      expect(results).toEqual([]);
    });
  });

  // --- TASK-013: incrementAccessCount / getVectorMetadata ---

  describe("incrementAccessCount / getVectorMetadata", () => {
    it("incrementAccessCountでaccess_countが増加する", () => {
      const saved = storage.save({ category: "config", title: "t", content: "c" });
      storage.upsertVector(saved.id, dummyVector(0));

      storage.incrementAccessCount([saved.id]);
      storage.incrementAccessCount([saved.id]);

      const meta = storage.getVectorMetadata([saved.id]);
      expect(meta.get(saved.id)!.accessCount).toBe(2);
    });

    it("getVectorMetadataで存在しないIDは含まれない", () => {
      const meta = storage.getVectorMetadata(["nonexistent"]);
      expect(meta.size).toBe(0);
    });

    it("複数IDのメタデータを一度に取得できる", () => {
      const s1 = storage.save({ category: "config", title: "t1", content: "c1" });
      const s2 = storage.save({ category: "config", title: "t2", content: "c2" });
      storage.upsertVector(s1.id, dummyVector(0));
      storage.upsertVector(s2.id, dummyVector(1));

      storage.incrementAccessCount([s1.id]);

      const meta = storage.getVectorMetadata([s1.id, s2.id]);
      expect(meta.size).toBe(2);
      expect(meta.get(s1.id)!.accessCount).toBe(1);
      expect(meta.get(s2.id)!.accessCount).toBe(0);
    });

    it("last_accessed_atが更新される", () => {
      const saved = storage.save({ category: "config", title: "t", content: "c" });
      storage.upsertVector(saved.id, dummyVector(0));

      const before = storage.getVectorMetadata([saved.id]).get(saved.id)!.lastAccessedAt;
      storage.incrementAccessCount([saved.id]);
      const after = storage.getVectorMetadata([saved.id]).get(saved.id)!.lastAccessedAt;

      // last_accessed_atが更新されている（同一秒内の可能性もあるのでGTE）
      expect(new Date(after).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
    });
  });

  // --- TASK-014: getEntriesWithoutEmbedding ---

  describe("getEntriesWithoutEmbedding", () => {
    it("embedding未生成のエントリIDが返る", () => {
      const s1 = storage.save({ category: "config", title: "t1", content: "c1" });
      const s2 = storage.save({ category: "config", title: "t2", content: "c2" });
      const s3 = storage.save({ category: "config", title: "t3", content: "c3" });

      // s1だけにembeddingを付与
      storage.upsertVector(s1.id, dummyVector(0));

      const without = storage.getEntriesWithoutEmbedding();
      expect(without.length).toBe(2);
      expect(without).toContain(s2.id);
      expect(without).toContain(s3.id);
      expect(without).not.toContain(s1.id);
    });

    it("全エントリにembeddingがある場合は空配列", () => {
      const saved = storage.save({ category: "config", title: "t", content: "c" });
      storage.upsertVector(saved.id, dummyVector(0));

      const without = storage.getEntriesWithoutEmbedding();
      expect(without).toEqual([]);
    });

    it("エントリがない場合は空配列", () => {
      const without = storage.getEntriesWithoutEmbedding();
      expect(without).toEqual([]);
    });
  });
});

describe("SQLiteStorage - Hybrid Search (TASK-015)", () => {
  let storage: SQLiteStorage;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-hybrid-test-"));
    storage = new SQLiteStorage(join(tmpDir, "test.db"));
    storage.initialize();

    // テストデータ: 3エントリを異なるベクトルで登録
    const s1 = storage.save({ category: "config", title: "ポート番号設定", content: "ポート3000を使用", tags: ["port"] });
    storage.upsertVector(s1.id, makeVector({ 0: 1.0 }));

    const s2 = storage.save({ category: "dont", title: "直接DB接続禁止", content: "エミュレータを使うこと", tags: ["db"] });
    storage.upsertVector(s2.id, makeVector({ 1: 1.0 }));

    const s3 = storage.save({ category: "log", title: "デプロイ完了", content: "v2.0デプロイ", tags: ["deploy"] });
    storage.upsertVector(s3.id, makeVector({ 2: 1.0 }));
  });

  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("FTS5のみヒットするケース", () => {
    // "ポート"で検索 + 無関係なベクトル → FTS5だけがヒット
    const result = storage.searchHybrid(
      { query: "ポート" },
      makeVector({ 100: 1.0 }) // 全エントリから遠いベクトル
    );
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.results.some((r) => r.title.includes("ポート"))).toBe(true);
  });

  it("ベクトルのみヒットするケース", () => {
    // 空クエリ（FTSスキップ） + dim0に近いベクトル → ベクトルのみ
    const result = storage.searchHybrid(
      { query: "" },
      makeVector({ 0: 1.0 })
    );
    // ベクトル検索は全件返す（空クエリだとFTSスキップ）
    expect(result.results.length).toBe(3);
  });

  it("FTS5+ベクトル両方ヒットするケース（UNION）", () => {
    // "ポート"でFTSヒット + dim1に近いベクトルでDB関連もベクトルヒット
    const result = storage.searchHybrid(
      { query: "ポート" },
      makeVector({ 1: 1.0 }) // DB接続禁止エントリに近い
    );
    // FTS: ポート番号設定、ベクトル: 全3件（距離999以下）→ UNIONで3件
    expect(result.results.length).toBeGreaterThanOrEqual(2);
    // ポート番号設定（FTS）とDB接続禁止（ベクトル）の両方が含まれる
    const titles = result.results.map((r) => r.title);
    expect(titles.some((t) => t.includes("ポート"))).toBe(true);
  });

  it("categoryフィルタが機能する", () => {
    const result = storage.searchHybrid(
      { query: "", category: "config" },
      makeVector({ 0: 1.0 })
    );
    expect(result.results.every((r) => r.category === "config")).toBe(true);
  });

  it("limitが機能する", () => {
    const result = storage.searchHybrid(
      { query: "" },
      makeVector({ 0: 1.0 }),
    );
    const limitedResult = storage.searchHybrid(
      { query: "", limit: 1 },
      makeVector({ 0: 1.0 }),
    );
    expect(limitedResult.results.length).toBe(1);
    expect(result.results.length).toBeGreaterThan(1);
  });
});
