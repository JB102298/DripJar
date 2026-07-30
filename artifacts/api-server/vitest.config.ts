import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Run files sequentially to avoid DB conflicts between integration tests
    pool: "forks",
    singleFork: true,
  },
});
