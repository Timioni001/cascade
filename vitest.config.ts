import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/test/**/*.test.ts", "services/*/test/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "sandbox",
          include: ["contracts/tests/**/*.test.ts"],
          testTimeout: 240_000,
          hookTimeout: 300_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
