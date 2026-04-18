import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
    maxWorkers: "50%",
    testTimeout: 10000,
  },
});
