import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { VectorStore } from "./vector-store.js";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

describe("VectorStore.getEntryMetadata", () => {
  let tempDir: string;
  let store: VectorStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vector-metadata-test-"));
    store = new VectorStore(tempDir);
    // Set up test data
    await store.upsert("entry-1", [0.1, 0.2, 0.3]);
    await store.upsert("entry-2", [0.4, 0.5, 0.6]);
    await store.incrementAccessCount(["entry-1", "entry-1", "entry-1"]); // 3 accesses
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("returns metadata for existing entries", async () => {
    const metadata = await store.getEntryMetadata(["entry-1", "entry-2"]);
    expect(metadata.size).toBe(2);
    expect(metadata.get("entry-1")!.accessCount).toBe(3);
    expect(metadata.get("entry-2")!.accessCount).toBe(0);
    expect(metadata.get("entry-1")!.lastAccessedAt).toBeTruthy();
    expect(metadata.get("entry-2")!.lastAccessedAt).toBeTruthy();
  });

  it("skips missing entries", async () => {
    const metadata = await store.getEntryMetadata(["entry-1", "nonexistent"]);
    expect(metadata.size).toBe(1);
    expect(metadata.has("nonexistent")).toBe(false);
  });

  it("returns empty map for empty input", async () => {
    const metadata = await store.getEntryMetadata([]);
    expect(metadata.size).toBe(0);
  });

  it("returns empty map when no entries exist", async () => {
    const emptyStore = new VectorStore(await mkdtemp(join(tmpdir(), "empty-")));
    const metadata = await emptyStore.getEntryMetadata(["any-id"]);
    expect(metadata.size).toBe(0);
  });
});
