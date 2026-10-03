import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts", "tests/**/*.test.ts"],
    maxWorkers: "50%",
    testTimeout: 10000,
    // 手元のパッケージ .env（中央ストアの絶対 MEMORY_DIR など）にテストが引きずられないよう、
    // 公開既定（プロジェクトごとの .wasurenagusa）に固定する。個別テストの上書きは従来どおり効く
    env: { MEMORY_DIR: ".wasurenagusa", WASURENAGUSA_CORRECTION_LOOP: "" },
  },
});
