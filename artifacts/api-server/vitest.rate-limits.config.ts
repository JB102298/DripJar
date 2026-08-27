import { defineConfig } from "vitest/config";

/**
 * Vitest config for the dedicated rate-limit verification suite.
 *
 * Used by:  pnpm run test:rate-limits
 *           which also sets TEST_RATE_LIMITS=1 so createLimiter() produces
 *           real express-rate-limit middleware instead of no-ops.
 *
 * Running this config without TEST_RATE_LIMITS=1 would cause every 429
 * assertion to fail because the limiters would be no-ops.
 */
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    // Same fail-closed database check as the main config — this suite is
    // equally DB-backed and must not reach dripjar_dev either.
    globalSetup: ["./src/__tests__/support/db-global-setup.ts"],
    // Rate-limit tests can issue many sequential requests against the DB;
    // allow slightly more time than the normal suite.
    testTimeout: 60_000,
    hookTimeout: 30_000,
    // Sequential execution — tests within each describe share an IP counter;
    // order must be stable for the "threshold + 1" pattern to work correctly.
    pool: "forks",
    singleFork: true,
    include: ["src/__tests__/rate-limits.test.ts"],
  },
});
