/**
 * Fresh-database migration verification — canonical Phase 4E provisioning check.
 *
 * Proves that a brand-new, empty PostgreSQL database can be provisioned end-to-end
 * by the canonical path (`drizzle-kit migrate`), and that the result is correct
 * and idempotent.
 *
 * Steps:
 *   1. Validate the local migration chain on disk (journal 0000→0023 + SQL files).
 *   2. Create a clean temporary database.
 *   3. Provision it with `pnpm --filter @workspace/db run migrate`.
 *   4. Verify 33 base tables, all 8 seeded ledger accounts, and no duplicates.
 *   5. Re-run migrate to prove the chain + seeds are idempotent.
 *   6. Drop the temporary database.
 *
 * `drizzle-kit push` is deliberately NOT used: push diffs schema *structure* only,
 * so it never executes the ledger-account seed INSERTs and leaves a fresh database
 * with an empty chart of accounts.
 *
 * Requires: DATABASE_URL pointing at a server where the role may CREATE DATABASE.
 * Usage: node scripts/run-fresh-migration.mjs
 */

import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const DRIZZLE_DIR = path.join(REPO_ROOT, "lib", "db", "drizzle");
const JOURNAL_PATH = path.join(DRIZZLE_DIR, "meta", "_journal.json");

// ─── Expectations ─────────────────────────────────────────────────────────────

/** Highest migration index in the current chain. */
const LAST_MIGRATION_IDX = 23;
/** 24 migrations: 0000 … 0023. */
const EXPECTED_MIGRATION_COUNT = LAST_MIGRATION_IDX + 1;
/** Base tables in `public` after the full chain (34 created, 1 dropped in 0015). */
const EXPECTED_TABLE_COUNT = 33;

/** The system chart of accounts: 7 seeded by 0008 + REFUND_PENDING by 0012. */
const EXPECTED_LEDGER_ACCOUNTS = [
  "CTRB_COMMITTED",
  "CTRB_REFUNDABLE",
  "DJ_FEE_REVENUE",
  "EXT_PAY_CLR",
  "PAYOUT_CLR",
  "PROC_FEE_CLR",
  "REFUND_CLR",
  "REFUND_PENDING",
];

// ─── Reporting ────────────────────────────────────────────────────────────────

const results = [];
function pass(label, detail = "") {
  results.push({ ok: true, label });
  console.log(`  ✓  ${label}${detail ? `  [${detail}]` : ""}`);
}
function fail(label, detail = "") {
  results.push({ ok: false, label, detail });
  console.error(`  ✗  ${label}${detail ? `  [${detail}]` : ""}`);
}

// ─── Connection strings ───────────────────────────────────────────────────────

const rawUrl = process.env.DATABASE_URL;
if (!rawUrl) {
  console.error("DATABASE_URL not set — cannot run fresh-migration verification.");
  process.exit(1);
}

const TEST_DB = `dripjar_migration_verify_${Date.now()}`;
const testUrl = new URL(rawUrl);
testUrl.pathname = `/${TEST_DB}`;
const testDsn = testUrl.toString();

/** Run the canonical provisioning command against the temp database. */
function runMigrate() {
  return spawnSync("pnpm", ["--filter", "@workspace/db", "run", "migrate"], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: testDsn },
    encoding: "utf8",
    shell: process.platform === "win32",
  });
}

let adminClient = null;
let testClient = null;

try {
  // ── STEP 1: Validate the migration chain on disk ───────────────────────────
  console.log("\n=== STEP 1: Validate migration chain on disk ===");

  const journal = JSON.parse(fs.readFileSync(JOURNAL_PATH, "utf8"));
  const entries = journal.entries ?? [];

  if (entries.length === EXPECTED_MIGRATION_COUNT) {
    pass(`Journal registers ${EXPECTED_MIGRATION_COUNT} migrations (0000→0023)`);
  } else {
    fail(
      `Journal migration count`,
      `expected ${EXPECTED_MIGRATION_COUNT}, found ${entries.length}`,
    );
  }

  for (let i = 0; i <= LAST_MIGRATION_IDX; i++) {
    const entry = entries.find((e) => e.idx === i);
    if (!entry) {
      fail(`Journal entry idx=${i} missing`);
      continue;
    }
    const sqlPath = path.join(DRIZZLE_DIR, `${entry.tag}.sql`);
    if (fs.existsSync(sqlPath)) {
      pass(`Chain step ${String(i).padStart(4, "0")} → ${entry.tag}.sql`);
    } else {
      fail(`Chain step ${String(i).padStart(4, "0")} SQL file missing`, `${entry.tag}.sql`);
    }
  }

  // Guard against orphaned SQL files that the journal does not register — these
  // would be silently skipped by `drizzle-kit migrate`.
  const sqlFiles = fs
    .readdirSync(DRIZZLE_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
  const registered = new Set(entries.map((e) => `${e.tag}.sql`));
  const orphans = sqlFiles.filter((f) => !registered.has(f));
  if (orphans.length === 0) {
    pass(`All ${sqlFiles.length} SQL files are registered in the journal`);
  } else {
    fail("Unregistered migration SQL files found", orphans.join(", "));
  }

  // ── STEP 2: Create a fresh, empty database ─────────────────────────────────
  console.log(`\n=== STEP 2: Create fresh database ${TEST_DB} ===`);
  adminClient = new pg.Client({ connectionString: rawUrl });
  await adminClient.connect();
  await adminClient.query(`CREATE DATABASE "${TEST_DB}"`);
  pass(`Created empty database ${TEST_DB}`);

  // ── STEP 3: Provision via the canonical path ───────────────────────────────
  console.log("\n=== STEP 3: Provision via `drizzle-kit migrate` ===");
  const migrateRun = runMigrate();
  if (migrateRun.status === 0) {
    pass("drizzle-kit migrate completed on empty database");
  } else {
    fail(
      "drizzle-kit migrate failed",
      (migrateRun.stderr || migrateRun.stdout || "").trim().split("\n").slice(-3).join(" | "),
    );
  }

  testClient = new pg.Client({ connectionString: testDsn });
  await testClient.connect();

  // Every migration in the chain must be recorded as applied.
  const applied = await testClient.query(
    "SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations",
  );
  if (applied.rows[0].n === EXPECTED_MIGRATION_COUNT) {
    pass(`drizzle recorded ${EXPECTED_MIGRATION_COUNT} applied migrations`);
  } else {
    fail(
      "Applied migration count",
      `expected ${EXPECTED_MIGRATION_COUNT}, found ${applied.rows[0].n}`,
    );
  }

  // ── STEP 4: Verify resulting schema ────────────────────────────────────────
  console.log("\n=== STEP 4: Verify schema ===");

  const tables = await testClient.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_type='BASE TABLE'
      ORDER BY table_name`,
  );
  const tableNames = tables.rows.map((r) => r.table_name);
  if (tableNames.length === EXPECTED_TABLE_COUNT) {
    pass(`Base table count is ${EXPECTED_TABLE_COUNT}`);
  } else {
    fail(
      "Base table count",
      `expected ${EXPECTED_TABLE_COUNT}, found ${tableNames.length}: ${tableNames.join(", ")}`,
    );
  }

  // Phase 4E tables must exist specifically.
  for (const t of ["autodrip_authorizations", "autodrip_runs", "saved_payment_methods"]) {
    if (tableNames.includes(t)) pass(`Phase 4E table exists: ${t}`);
    else fail(`Phase 4E table missing: ${t}`);
  }

  // The table dropped by 0015 must not survive a fresh chain run.
  if (!tableNames.includes("refund_request_placeholders")) {
    pass("refund_request_placeholders correctly dropped by migration 0015");
  } else {
    fail("refund_request_placeholders still present after full chain");
  }

  // ── Ledger accounts: all 8 present, exactly once each ──────────────────────
  const accounts = await testClient.query(
    "SELECT code, count(*)::int AS n FROM ledger_accounts GROUP BY code ORDER BY code",
  );
  const byCode = new Map(accounts.rows.map((r) => [r.code, r.n]));

  for (const code of EXPECTED_LEDGER_ACCOUNTS) {
    const n = byCode.get(code);
    if (n === undefined) fail(`Ledger account missing: ${code}`);
    else if (n !== 1) fail(`Ledger account duplicated: ${code}`, `count=${n}`);
    else pass(`Ledger account seeded exactly once: ${code}`);
  }

  const totalAccounts = accounts.rows.reduce((sum, r) => sum + r.n, 0);
  if (totalAccounts === EXPECTED_LEDGER_ACCOUNTS.length) {
    pass(`Ledger account total is ${EXPECTED_LEDGER_ACCOUNTS.length} with no duplicates`);
  } else {
    fail(
      "Ledger account total",
      `expected ${EXPECTED_LEDGER_ACCOUNTS.length}, found ${totalAccounts}`,
    );
  }

  const unexpected = accounts.rows
    .map((r) => r.code)
    .filter((c) => !EXPECTED_LEDGER_ACCOUNTS.includes(c));
  if (unexpected.length === 0) pass("No unexpected ledger accounts");
  else fail("Unexpected ledger accounts", unexpected.join(", "));

  // ── STEP 5: Idempotency — re-running migrate changes nothing ───────────────
  console.log("\n=== STEP 5: Verify idempotency (re-run migrate) ===");
  const rerun = runMigrate();
  if (rerun.status === 0) pass("Second `drizzle-kit migrate` run succeeded");
  else fail("Second migrate run failed", (rerun.stderr || "").trim().split("\n").slice(-3).join(" | "));

  const after = await testClient.query(
    `SELECT
       (SELECT count(*)::int FROM information_schema.tables
         WHERE table_schema='public' AND table_type='BASE TABLE') AS tables,
       (SELECT count(*)::int FROM ledger_accounts) AS accounts,
       (SELECT count(DISTINCT code)::int FROM ledger_accounts) AS distinct_accounts`,
  );
  const a = after.rows[0];
  if (a.tables === EXPECTED_TABLE_COUNT) pass(`Table count stable after re-run: ${a.tables}`);
  else fail("Table count changed after re-run", `${a.tables}`);

  if (a.accounts === EXPECTED_LEDGER_ACCOUNTS.length && a.accounts === a.distinct_accounts) {
    pass(`Ledger accounts stable and unique after re-run: ${a.accounts}`);
  } else {
    fail(
      "Ledger accounts changed after re-run",
      `total=${a.accounts} distinct=${a.distinct_accounts}`,
    );
  }
} catch (err) {
  fail("Unhandled error", err instanceof Error ? err.message : String(err));
} finally {
  // ── STEP 6: Drop the temporary database ──────────────────────────────────
  console.log("\n=== STEP 6: Drop temporary database ===");
  try {
    if (testClient) await testClient.end();
    if (adminClient) {
      await adminClient.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
        [TEST_DB],
      );
      await adminClient.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
      await adminClient.end();
      pass(`Dropped ${TEST_DB}`);
    }
  } catch (err) {
    fail("Cleanup failed", err instanceof Error ? err.message : String(err));
    console.error(`  Manual cleanup may be required: DROP DATABASE "${TEST_DB}";`);
  }
}

// ─── Summary ──────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;

console.log("\n=== SUMMARY ===");
console.log(`${passed} checks passed, ${failed} failed`);

if (failed > 0) {
  console.error("\nFRESH MIGRATION VERIFICATION FAILED");
  for (const r of results.filter((x) => !x.ok)) {
    console.error(`  - ${r.label}${r.detail ? `: ${r.detail}` : ""}`);
  }
  process.exit(1);
}

console.log("ALL FRESH MIGRATION CHECKS PASSED");
process.exit(0);
