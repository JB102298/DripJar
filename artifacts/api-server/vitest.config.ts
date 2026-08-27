import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    // Fail-closed database check, once, before any worker is forked.
    // The environment itself is set by scripts/test-db.mjs before vitest
    // starts; this only asserts. See support/db-global-setup.ts.
    globalSetup: ["./src/__tests__/support/db-global-setup.ts"],
    // Raised from 30 000 to 60 000 so that tests which call process-reminders
    // without an explicit per-test override do not time-out under full-suite load
    // (~25–30 s per reminder flush when all prior test files have populated the DB).
    // This is a test-only change; production reminder logic is unaffected.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Run files sequentially to avoid DB conflicts between integration tests
    pool: "forks",
    singleFork: true,
    // The rate-limit suite runs under a separate config (vitest.rate-limits.config.ts)
    // with TEST_RATE_LIMITS=1.  Excluding it here keeps the normal suite fast and
    // prevents exhausted in-memory counters from leaking across test commands.
    exclude: ["**/node_modules/**", "**/dist/**", "src/__tests__/rate-limits.test.ts"],
  },
});
