/**
 * Fail-closed assertion that runs once, in the Vitest main process, before any
 * test worker is forked.
 *
 * ─── THIS IS THE SECOND LAYER, NOT THE SWITCH ────────────────────────────────
 *
 * `scripts/test-db.mjs` sets DATABASE_URL and NODE_ENV in the child environment
 * *before* Vitest starts. That is the primary mechanism, and it has to be:
 * changing DATABASE_URL from here would be too late, because configs and
 * modules may already have been evaluated and `@workspace/db` builds its pool
 * at module scope.
 *
 * So this file switches nothing. It asserts — and it asserts twice over:
 *
 *   1. NODE_ENV must be "test". Without it the connection guard inside
 *      `@workspace/db` is inert by design, and the suite would happily open
 *      `dripjar_dev`. A wrong NODE_ENV is the one way the real guard silently
 *      stops guarding, so it is checked explicitly rather than assumed.
 *
 *   2. DATABASE_URL must satisfy the same policy the pool guard applies, using
 *      the same pure function — no second copy of the rules to drift.
 *
 * Failing here aborts the run before a single worker starts, which makes the
 * refusal legible instead of arriving as 39 identical connection errors.
 */

import {
  validateTestDatabaseUrl,
  describeTestDbTarget,
  TEST_DATABASE_NAME,
} from "@workspace/db/test-db-guard";

export default function setup(): void {
  if (process.env["NODE_ENV"] !== "test") {
    throw new Error(
      `[VITEST-DB-GUARD] NODE_ENV is "${process.env["NODE_ENV"] ?? "(unset)"}", not "test". ` +
        `The database connection guard only engages under NODE_ENV=test, so refusing ` +
        `to start rather than running against an unguarded connection. ` +
        `Run the suite through "pnpm test:clean" or "pnpm test:keep".`,
    );
  }

  const result = validateTestDatabaseUrl(process.env["DATABASE_URL"]);

  if (!result.ok) {
    throw new Error(
      `[VITEST-DB-GUARD] ${result.failure.code}: ${result.failure.message}\n` +
        `Refusing to start the API suite. Use "pnpm test:clean" (drops the test ` +
        `database afterwards) or "pnpm test:keep" (preserves it for diagnosis).`,
    );
  }

  // Safe descriptor only: host, port, database name. Never the URL.
  console.log(`\n  [vitest] database: ${describeTestDbTarget(result.target)}\n`);

  if (result.target.database !== TEST_DATABASE_NAME) {
    // Unreachable while the allowlist holds; asserted so it stays that way.
    throw new Error(
      `[VITEST-DB-GUARD] Validated database "${result.target.database}" is not ` +
        `"${TEST_DATABASE_NAME}".`,
    );
  }
}
