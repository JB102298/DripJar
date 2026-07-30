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
    // The rate-limit suite runs under a separate config (vitest.rate-limits.config.ts)
    // with TEST_RATE_LIMITS=1.  Excluding it here keeps the normal suite fast and
    // prevents exhausted in-memory counters from leaking across test commands.
    exclude: ["**/node_modules/**", "**/dist/**", "src/__tests__/rate-limits.test.ts"],
  },
});
