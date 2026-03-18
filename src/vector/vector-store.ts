import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { cosineDistance } from "./cosine-distance.js";

export interface VectorEntry {
  id: string;
  embedding: number[];
  accessCount: number;
  createdAt: string;
  lastAccessedAt: string;
}

export interface VectorStoreData {
  version: 1;
  entries: Record<string, VectorEntry>;
}

export interface VectorSearchResult {
  id: string;
  distance: number;
  accessCount: number;
}

function nowJST(): string {
  return new Date()
    .toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" })
    .replace(" ", "T") + "+09:00";
}

export class VectorStore {
  private filePath: string;

  constructor(memoryPath: string) {
    this.filePath = join(memoryPath, "vectors.json");
  }

  async upsert(id: string, embedding: number[]): Promise<void> {
    const data = await this.load();
    const now = nowJST();
    const existing = data.entries[id];

    if (existing) {
      existing.embedding = embedding;
      existing.lastAccessedAt = now;
    } else {
      data.entries[id] = {
        id,
        embedding,
        accessCount: 0,
        createdAt: now,
        lastAccessedAt: now,
      };
    }

    await this.save(data);
  }

  async delete(ids: string[]): Promise<void> {
    const data = await this.load();

    for (const id of ids) {
      delete data.entries[id];
    }

    await this.save(data);
  }

  async search(
    queryEmbedding: number[],
    threshold: number,
    limit: number,
  ): Promise<VectorSearchResult[]> {
    const data = await this.load();
    const results: VectorSearchResult[] = [];

    for (const entry of Object.values(data.entries)) {
      const distance = cosineDistance(queryEmbedding, entry.embedding);
      if (distance <= threshold) {
        results.push({
          id: entry.id,
          distance,
          accessCount: entry.accessCount,
        });
      }
    }

    results.sort((a, b) => a.distance - b.distance);

    return results.slice(0, limit);
  }

  async incrementAccessCount(ids: string[]): Promise<void> {
    const data = await this.load();
    const now = nowJST();

    for (const id of ids) {
      const entry = data.entries[id];
      if (entry) {
        entry.accessCount += 1;
        entry.lastAccessedAt = now;
      }
    }

    await this.save(data);
  }

  async getEntriesWithoutEmbedding(allIds: string[]): Promise<string[]> {
    const data = await this.load();
    const missing: string[] = [];

    for (const id of allIds) {
      if (!data.entries[id]) {
        missing.push(id);
      }
    }

    return missing;
  }

  async getEntryCount(): Promise<number> {
    const data = await this.load();
    return Object.keys(data.entries).length;
  }

  private async load(): Promise<VectorStoreData> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf-8");
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, entries: {} };
      }
      throw err;
    }

    try {
      return JSON.parse(raw) as VectorStoreData;
    } catch {
      console.error(`[VectorStore] Corrupted vectors.json at ${this.filePath}, re-initializing.`);
      return { version: 1, entries: {} };
    }
  }

  private async save(data: VectorStoreData): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(data, null, 2), "utf-8");
  }
}
