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
    // ─── Test files run in PARALLEL ──────────────────────────────────────────
    //
    // This block used to carry `singleFork: true` and a comment claiming files
    // ran sequentially. Neither was true. `singleFork` lived under
    // `poolOptions.forks` and was removed outright in Vitest 4, so as written it
    // was an unknown key that Vitest silently ignored — `fileParallelism`
    // defaults to true, and the suite has been running roughly seven files at a
    // time (a full run reports ~230s of test time inside ~33s of wall clock).
    //
    // The option is gone rather than relocated. Serialising the suite would hide
    // cross-file interference instead of fixing it, and would multiply the run
    // time by that same factor. Integration tests are expected to tolerate
    // concurrency: fixtures are uniquely tagged, assertions are scoped to rows
    // the file owns, and teardown removes exactly those rows.
    // See src/__tests__/support/fixtures.ts.
    pool: "forks",
    // The rate-limit suite runs under a separate config (vitest.rate-limits.config.ts)
    // with TEST_RATE_LIMITS=1.  Excluding it here keeps the normal suite fast and
    // prevents exhausted in-memory counters from leaking across test commands.
    exclude: ["**/node_modules/**", "**/dist/**", "src/__tests__/rate-limits.test.ts"],
  },
});
