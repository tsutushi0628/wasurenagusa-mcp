import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { VectorStore } from "./vector-store.js";

function makeEmbedding(seed: number, dim = 768): number[] {
  return Array.from({ length: dim }, (_, i) => Math.sin(seed * 100 + i));
}

describe("VectorStore", () => {
  let tmpDir: string;
  let store: VectorStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "vector-store-test-"));
    store = new VectorStore(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ============================
  // Task 3: CRUD
  // ============================
  describe("CRUD (Task 3)", () => {
    it("upsert creates a new entry", async () => {
      const emb = makeEmbedding(1);
      await store.upsert("entry-1", emb);

      const count = await store.getEntryCount();
      expect(count).toBe(1);

      // Verify persisted to file
      const raw = await readFile(join(tmpDir, "vectors.json"), "utf-8");
      const data = JSON.parse(raw);
      expect(data.entries["entry-1"]).toBeDefined();
      expect(data.entries["entry-1"].id).toBe("entry-1");
      expect(data.entries["entry-1"].accessCount).toBe(0);
      expect(data.entries["entry-1"].embedding).toEqual(emb);
    });

    it("upsert updates existing entry, preserving createdAt", async () => {
      const emb1 = makeEmbedding(1);
      await store.upsert("entry-1", emb1);

      const raw1 = await readFile(join(tmpDir, "vectors.json"), "utf-8");
      const data1 = JSON.parse(raw1);
      const createdAt = data1.entries["entry-1"].createdAt;
      const lastAccessed1 = data1.entries["entry-1"].lastAccessedAt;

      // Small delay to ensure timestamps differ
      await new Promise((r) => setTimeout(r, 10));

      const emb2 = makeEmbedding(2);
      await store.upsert("entry-1", emb2);

      const raw2 = await readFile(join(tmpDir, "vectors.json"), "utf-8");
      const data2 = JSON.parse(raw2);
      const entry = data2.entries["entry-1"];

      // createdAt must be preserved
      expect(entry.createdAt).toBe(createdAt);
      // embedding must be updated
      expect(entry.embedding).toEqual(emb2);
      // lastAccessedAt must be updated (or at least same second)
      expect(entry.lastAccessedAt).toBeDefined();
    });

    it("delete removes entries", async () => {
      await store.upsert("a", makeEmbedding(1));
      await store.upsert("b", makeEmbedding(2));
      await store.upsert("c", makeEmbedding(3));

      await store.delete(["a", "c"]);

      const count = await store.getEntryCount();
      expect(count).toBe(1);

      const raw = await readFile(join(tmpDir, "vectors.json"), "utf-8");
      const data = JSON.parse(raw);
      expect(data.entries["a"]).toBeUndefined();
      expect(data.entries["b"]).toBeDefined();
      expect(data.entries["c"]).toBeUndefined();
    });

    it("delete ignores missing IDs without error", async () => {
      await store.upsert("a", makeEmbedding(1));

      // Should not throw
      await store.delete(["nonexistent-1", "nonexistent-2"]);

      const count = await store.getEntryCount();
      expect(count).toBe(1);
    });

    it("getEntryCount returns correct count", async () => {
      expect(await store.getEntryCount()).toBe(0);

      await store.upsert("a", makeEmbedding(1));
      expect(await store.getEntryCount()).toBe(1);

      await store.upsert("b", makeEmbedding(2));
      expect(await store.getEntryCount()).toBe(2);

      await store.delete(["a"]);
      expect(await store.getEntryCount()).toBe(1);
    });

    it("loads empty data when file does not exist", async () => {
      // Fresh store, no file created yet
      const count = await store.getEntryCount();
      expect(count).toBe(0);
    });

    it("re-initializes on corrupted file", async () => {
      // Write garbage to vectors.json
      await writeFile(join(tmpDir, "vectors.json"), "{{not valid json!!", "utf-8");

      // Should not throw; should re-init silently
      const count = await store.getEntryCount();
      expect(count).toBe(0);

      // Should be able to upsert after recovery
      await store.upsert("recovered", makeEmbedding(1));
      expect(await store.getEntryCount()).toBe(1);
    });
  });

  // ============================
  // Task 4: Search
  // ============================
  describe("Search (Task 4)", () => {
    it("returns correct results sorted by distance", async () => {
      // Seed vectors: identical to query (distance ~0), slightly different, very different
      const query = makeEmbedding(1);
      const close = makeEmbedding(1.001);  // very similar
      const far = makeEmbedding(50);       // quite different

      await store.upsert("exact", query);
      await store.upsert("close", close);
      await store.upsert("far", far);

      const results = await store.search(query, 2.0, 10);

      expect(results.length).toBe(3);
      // Results must be sorted ascending by distance
      expect(results[0].id).toBe("exact");
      expect(results[0].distance).toBeCloseTo(0, 5);
      // Each subsequent distance should be >= previous
      for (let i = 1; i < results.length; i++) {
        expect(results[i].distance).toBeGreaterThanOrEqual(results[i - 1].distance);
      }
    });

    it("filters by threshold", async () => {
      const query = makeEmbedding(1);
      const close = makeEmbedding(1.001);
      const far = makeEmbedding(50);

      await store.upsert("exact", query);
      await store.upsert("close", close);
      await store.upsert("far", far);

      // Use a tight threshold that only matches exact/close
      const resultsAll = await store.search(query, 2.0, 10);
      const farDist = resultsAll.find((r) => r.id === "far");

      // Set threshold just below the far entry's distance
      if (farDist) {
        const tightThreshold = farDist.distance - 0.001;
        const filtered = await store.search(query, tightThreshold, 10);
        const farInFiltered = filtered.find((r) => r.id === "far");
        expect(farInFiltered).toBeUndefined();
      }
    });

    it("respects limit", async () => {
      const query = makeEmbedding(1);

      await store.upsert("a", makeEmbedding(1));
      await store.upsert("b", makeEmbedding(2));
      await store.upsert("c", makeEmbedding(3));
      await store.upsert("d", makeEmbedding(4));
      await store.upsert("e", makeEmbedding(5));

      const results = await store.search(query, 2.0, 3);
      expect(results.length).toBe(3);
    });

    it("returns empty results on empty store", async () => {
      const query = makeEmbedding(1);
      const results = await store.search(query, 2.0, 10);
      expect(results).toEqual([]);
    });

    it("incrementAccessCount increases counts", async () => {
      await store.upsert("a", makeEmbedding(1));
      await store.upsert("b", makeEmbedding(2));

      await store.incrementAccessCount(["a"]);
      await store.incrementAccessCount(["a", "b"]);

      const query = makeEmbedding(1);
      const results = await store.search(query, 2.0, 10);

      const entryA = results.find((r) => r.id === "a");
      const entryB = results.find((r) => r.id === "b");

      expect(entryA).toBeDefined();
      expect(entryA!.accessCount).toBe(2);
      expect(entryB).toBeDefined();
      expect(entryB!.accessCount).toBe(1);
    });

    it("incrementAccessCount persists across load/save", async () => {
      await store.upsert("x", makeEmbedding(1));
      await store.incrementAccessCount(["x"]);
      await store.incrementAccessCount(["x"]);

      // Create a new store instance pointing to same file
      const store2 = new VectorStore(tmpDir);
      const query = makeEmbedding(1);
      const results = await store2.search(query, 2.0, 10);

      const entry = results.find((r) => r.id === "x");
      expect(entry).toBeDefined();
      expect(entry!.accessCount).toBe(2);
    });

    it("getEntriesWithoutEmbedding returns missing IDs", async () => {
      await store.upsert("exists-1", makeEmbedding(1));
      await store.upsert("exists-2", makeEmbedding(2));

      const missing = await store.getEntriesWithoutEmbedding([
        "exists-1",
        "exists-2",
        "missing-1",
        "missing-2",
      ]);

      expect(missing).toEqual(["missing-1", "missing-2"]);
    });

    it("getEntriesWithoutEmbedding returns all IDs when store is empty", async () => {
      const missing = await store.getEntriesWithoutEmbedding(["a", "b", "c"]);
      expect(missing).toEqual(["a", "b", "c"]);
    });
  });
});
