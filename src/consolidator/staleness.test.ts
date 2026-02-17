import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { isConsolidationStale, readConsolidatedDont, writeConsolidatedDont } from "./staleness.js";
import { ConsolidatedDont } from "../types.js";

function createSampleConsolidated(overrides?: Partial<ConsolidatedDont>): ConsolidatedDont {
  return {
    principles: [
      {
        theme: "確認前行動の禁止",
        rule: "❌ 推測で行動 💡 信頼を失う ✅ ログとコードを確認",
        tags: ["ログ確認", "推測禁止"],
        sourceCount: 3,
        sourceIds: ["id-1", "id-2", "id-3"],
      },
    ],
    consolidatedAt: "2026-02-09T12:00:00.000+09:00",
    sourceEntryCount: 3,
    version: 1,
    ...overrides,
  };
}

function createDontMarkdown(count: number): string {
  const entries = Array.from({ length: count }, (_, i) => `## テスト${i + 1}

- **id**: test-${i + 1}
- **timestamp**: 2026-02-09T12:00:00.000+09:00
- **category**: dont
- **tags**: test
- **content**: テスト内容${i + 1}

---`);
  return entries.join("\n");
}

describe("staleness", () => {
  let tempDir: string;
  let memoryPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "wasurenagusa-staleness-"));
    memoryPath = join(tempDir, ".wasurenagusa");
    await mkdir(memoryPath, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("isConsolidationStale()", () => {
    it("統合ファイルが存在しない場合はstale", async () => {
      await writeFile(join(memoryPath, "dont.md"), createDontMarkdown(3));

      const result = await isConsolidationStale(memoryPath);
      expect(result).toBe(true);
    });

    it("dont.mdが存在しない場合はnot stale（統合不要）", async () => {
      const result = await isConsolidationStale(memoryPath);
      expect(result).toBe(false);
    });

    it("dont.mdが統合ファイルより新しい場合はstale", async () => {
      // 先に統合ファイルを書く
      const consolidated = createSampleConsolidated({ sourceEntryCount: 3 });
      await writeFile(
        join(memoryPath, "consolidated-dont.json"),
        JSON.stringify(consolidated)
      );

      // 少し待ってからdont.mdを書く（mtimeを確実に新しくする）
      await new Promise(resolve => setTimeout(resolve, 50));
      await writeFile(join(memoryPath, "dont.md"), createDontMarkdown(3));

      const result = await isConsolidationStale(memoryPath);
      expect(result).toBe(true);
    });

    it("統合ファイルがdont.mdより新しい＋エントリ数一致ならnot stale", async () => {
      // 先にdont.mdを書く
      await writeFile(join(memoryPath, "dont.md"), createDontMarkdown(3));

      // 少し待ってから統合ファイルを書く
      await new Promise(resolve => setTimeout(resolve, 50));
      const consolidated = createSampleConsolidated({ sourceEntryCount: 3 });
      await writeFile(
        join(memoryPath, "consolidated-dont.json"),
        JSON.stringify(consolidated)
      );

      const result = await isConsolidationStale(memoryPath);
      expect(result).toBe(false);
    });

    it("エントリ数が不一致の場合はstale（mtimeが新しくても）", async () => {
      // 先にdont.mdを書く（5件）
      await writeFile(join(memoryPath, "dont.md"), createDontMarkdown(5));

      // 統合ファイルはsourceEntryCount=3で書く（不一致）
      await new Promise(resolve => setTimeout(resolve, 50));
      const consolidated = createSampleConsolidated({ sourceEntryCount: 3 });
      await writeFile(
        join(memoryPath, "consolidated-dont.json"),
        JSON.stringify(consolidated)
      );

      const result = await isConsolidationStale(memoryPath);
      expect(result).toBe(true);
    });
  });

  describe("readConsolidatedDont()", () => {
    it("JSONファイルを読み込んでConsolidatedDontを返す", async () => {
      const expected = createSampleConsolidated();
      await writeFile(
        join(memoryPath, "consolidated-dont.json"),
        JSON.stringify(expected)
      );

      const result = await readConsolidatedDont(memoryPath);
      expect(result).toEqual(expected);
    });

    it("ファイルが存在しない場合はnullを返す", async () => {
      const result = await readConsolidatedDont(memoryPath);
      expect(result).toBeNull();
    });

    it("不正なJSONの場合はnullを返す", async () => {
      await writeFile(
        join(memoryPath, "consolidated-dont.json"),
        "not-json-content"
      );

      const result = await readConsolidatedDont(memoryPath);
      expect(result).toBeNull();
    });
  });

  describe("writeConsolidatedDont()", () => {
    it("ConsolidatedDontをJSONファイルに書き込む", async () => {
      const data = createSampleConsolidated();
      await writeConsolidatedDont(memoryPath, data);

      const readBack = await readConsolidatedDont(memoryPath);
      expect(readBack).toEqual(data);
    });
  });
});
