import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { consolidateModelCache, retireLegacyVectors, RETIRED_SUFFIX } from "./retire-legacy-vectors.js";
import { backupStore } from "./backup-store.js";

/**
 * タスク1.13の業務要件をテストで先に固定する（R-B8）。
 *
 * 業務要件:
 * ② 7ストアに重複する埋め込みモデルキャッシュ（models/）を1箇所の共有先へ集約できる
 *    （既存ファイルは上書きしない＝再実行しても壊れない）
 * ③ vectors.json は「バックアップとのチェックサム一致が確認できたときだけ」退避リネームされ、
 *    削除は一切行わない（バックアップ未確認・内容不一致時は中止する）
 */
describe("retire-legacy-vectors: モデルキャッシュ集約とvectors.json退避（タスク1.13、R-B8）", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wasurenagusa-retire-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("consolidateModelCache（②モデルキャッシュの共有先集約）", () => {
    it("ソースのモデルファイル（ネスト含む）を共有先へコピーする", () => {
      const source = join(tmpDir, "project-a", ".wasurenagusa", "models");
      const shared = join(tmpDir, "shared-model-cache");
      mkdirSync(join(source, "Xenova", "multilingual-e5-small"), { recursive: true });
      writeFileSync(join(source, "Xenova", "multilingual-e5-small", "weights.bin"), "dummy-weights-content");

      const result = consolidateModelCache(source, shared);

      expect(result.sourceMissing).toBe(false);
      expect(result.copiedFiles).toBe(1);
      expect(result.skippedExisting).toBe(0);
      expect(existsSync(join(shared, "Xenova", "multilingual-e5-small", "weights.bin"))).toBe(true);
      expect(readFileSync(join(shared, "Xenova", "multilingual-e5-small", "weights.bin"), "utf-8")).toBe(
        "dummy-weights-content",
      );
    });

    it("再実行しても既存ファイルを上書きせず、重複コピーもしない（冪等）", () => {
      const source = join(tmpDir, "project-b", ".wasurenagusa", "models");
      const shared = join(tmpDir, "shared-model-cache-2");
      mkdirSync(join(source, "Xenova", "model"), { recursive: true });
      writeFileSync(join(source, "Xenova", "model", "weights.bin"), "original-weights");

      consolidateModelCache(source, shared);
      // 共有先の実体が別プロセス等で更新された想定はせず、単純に二回目を実行する
      const second = consolidateModelCache(source, shared);

      expect(second.copiedFiles).toBe(0);
      expect(second.skippedExisting).toBe(1);
      // 内容も壊れていない
      expect(readFileSync(join(shared, "Xenova", "model", "weights.bin"), "utf-8")).toBe("original-weights");
    });

    it("ソースのmodels/ディレクトリが存在しない場合は何もせずスキップする（すでに共有先のみを使っている状態）", () => {
      const source = join(tmpDir, "project-c", ".wasurenagusa", "models");
      const shared = join(tmpDir, "shared-model-cache-3");

      const result = consolidateModelCache(source, shared);

      expect(result.sourceMissing).toBe(true);
      expect(result.copiedFiles).toBe(0);
    });
  });

  describe("retireLegacyVectors（③vectors.jsonの退避リネーム）", () => {
    function makeStoreWithVectors(vectorsContent: string): string {
      const storePath = join(tmpDir, "store", ".wasurenagusa");
      mkdirSync(storePath, { recursive: true });
      writeFileSync(join(storePath, "vectors.json"), vectorsContent);
      writeFileSync(join(storePath, "config.md"), "# config\n");
      return storePath;
    }

    it("バックアップとチェックサムが一致する場合のみ退避リネームし、削除はしない", async () => {
      const storePath = makeStoreWithVectors(JSON.stringify({ version: 1, entries: {} }));
      const backupDir = join(tmpDir, "backup");
      await backupStore(storePath, backupDir);

      const result = retireLegacyVectors(storePath, backupDir);

      expect(result.retired).toBe(true);
      expect(existsSync(join(storePath, "vectors.json"))).toBe(false);
      const retiredPath = join(storePath, `vectors.json${RETIRED_SUFFIX}`);
      expect(existsSync(retiredPath)).toBe(true);
      expect(readFileSync(retiredPath, "utf-8")).toBe(JSON.stringify({ version: 1, entries: {} }));
    });

    it("バックアップ（manifest.json）が存在しない場合は退避せずエラーで中止する", () => {
      const storePath = makeStoreWithVectors(JSON.stringify({ version: 1, entries: {} }));
      const backupDir = join(tmpDir, "no-backup-here");

      expect(() => retireLegacyVectors(storePath, backupDir)).toThrow();
      // 中止時は原本に一切手をつけない
      expect(existsSync(join(storePath, "vectors.json"))).toBe(true);
    });

    it("バックアップ取得後にvectors.jsonが変更されチェックサムが不一致の場合はエラーで中止する", async () => {
      const storePath = makeStoreWithVectors(JSON.stringify({ version: 1, entries: {} }));
      const backupDir = join(tmpDir, "backup-stale");
      await backupStore(storePath, backupDir);

      // バックアップ後にvectors.jsonの内容が変わった状況を再現
      writeFileSync(join(storePath, "vectors.json"), JSON.stringify({ version: 1, entries: { changed: true } }));

      expect(() => retireLegacyVectors(storePath, backupDir)).toThrow();
      expect(existsSync(join(storePath, "vectors.json"))).toBe(true);
    });

    it("vectors.jsonがすでに存在しない場合は冪等にスキップする（バックアップ確認なしでもエラーにしない）", () => {
      const storePath = join(tmpDir, "store-no-vectors", ".wasurenagusa");
      mkdirSync(storePath, { recursive: true });
      const backupDir = join(tmpDir, "irrelevant-backup-dir");

      const result = retireLegacyVectors(storePath, backupDir);

      expect(result.retired).toBe(false);
    });
  });
});
