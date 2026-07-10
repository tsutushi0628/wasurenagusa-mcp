/**
 * src/config-models-dir.test.ts
 *
 * タスク1.13①: モデルキャッシュ先の解決（getModelsDir）が環境変数
 * WASURENAGUSA_MODEL_CACHE_DIR で共有先へ向くこと、未設定時（および空文字時）は
 * 従来どおり memoryPath 配下の config.modelsDir へフォールバックすることを検証する。
 *
 * 7ストア（プロジェクトごとの .wasurenagusa/models/）に87MBずつ重複している埋め込み
 * モデル実体（522MB相当）を1箇所の共有キャッシュへ向けるための解決ロジック（R-B8）。
 */
import { describe, it, expect, afterEach } from "vitest";
import { join } from "path";
import { config, getModelsDir } from "./config.js";

const ENV_KEY = "WASURENAGUSA_MODEL_CACHE_DIR";
const originalValue = process.env[ENV_KEY];

afterEach(() => {
  if (originalValue === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = originalValue;
  }
});

describe("getModelsDir（タスク1.13: モデルキャッシュ共有先の解決）", () => {
  it("環境変数が未設定のとき、従来どおりmemoryPath配下のmodelsDirを返す", () => {
    delete process.env[ENV_KEY];
    const memoryPath = "/tmp/wasurenagusa-test-project/.wasurenagusa";
    expect(getModelsDir(memoryPath)).toBe(join(memoryPath, config.modelsDir));
  });

  it("環境変数が設定されているとき、memoryPathを無視して共有先ディレクトリを返す", () => {
    process.env[ENV_KEY] = "/tmp/wasurenagusa-shared-model-cache";
    const memoryPath = "/tmp/wasurenagusa-test-project-b/.wasurenagusa";
    expect(getModelsDir(memoryPath)).toBe("/tmp/wasurenagusa-shared-model-cache");
  });

  it("環境変数が空文字のときは未設定と同様に従来動作へフォールバックする", () => {
    process.env[ENV_KEY] = "";
    const memoryPath = "/tmp/wasurenagusa-test-project-c/.wasurenagusa";
    expect(getModelsDir(memoryPath)).toBe(join(memoryPath, config.modelsDir));
  });
});
