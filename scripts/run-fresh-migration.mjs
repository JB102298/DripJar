/**
 * Fresh-database migration verification — canonical Phase 4E provisioning check.
 *
 * Proves that a brand-new, empty PostgreSQL database can be provisioned end-to-end
 * by the canonical path (`drizzle-kit migrate`), and that the result is correct
 * and idempotent.
 *
 * Steps:
 *   1. Validate the local migration chain on disk (journal 0000→0025 + SQL files).
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
const LAST_MIGRATION_IDX = 25;
/** 26 migrations: 0000 … 0025. */
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
    pass(`Journal registers ${EXPECTED_MIGRATION_COUNT} migrations (0000→0025)`);
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

  // ── The newest migration must be able to reach an existing database ────────
  //
  // `drizzle-kit migrate` reads the highest `created_at` already recorded in a
  // target database and applies only journal entries whose `when` exceeds it.
  // A new migration timestamped below the journal's running maximum therefore
  // applies cleanly to a fresh database and is SILENTLY SKIPPED on every
  // existing one — the worst possible failure mode, because provisioning
  // verification passes while production never gets the change.
  //
  // This chain already contains such a regression: entries 0010–0023 were
  // timestamped about a year BELOW 0009, so `migrate` cannot apply them to a
  // database that recorded 0009. Those tables reached existing databases by
  // `drizzle-kit push` instead. The historical entries are deliberately not
  // rewritten — databases that did apply them hold those `created_at` values,
  // and raising them would re-run migrations that are not idempotent.
  //
  // What is enforced is the property that matters going forward: the NEWEST
  // entry must sit above every earlier one.
  const newest = entries.find((e) => e.idx === LAST_MIGRATION_IDX);
  const priorMax = Math.max(...entries.filter((e) => e.idx !== LAST_MIGRATION_IDX).map((e) => e.when));
  if (newest && newest.when > priorMax) {
    pass(
      `Newest migration timestamp is above every earlier entry`,
      `${newest.when} > ${priorMax}`,
    );
  } else {
    fail(
      "Newest migration would be skipped on an existing database",
      `when=${newest?.when} is not above the journal maximum ${priorMax}`,
    );
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

  // ── Migration 0024: jars.target_date_precision ─────────────────────────────
  //
  // Checked explicitly rather than by table count, because this migration adds
  // a column rather than a table — the table count alone would not notice if it
  // silently failed to apply.
  const precisionCol = await testClient.query(
    `SELECT data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name='jars'
        AND column_name='target_date_precision'`,
  );
  if (precisionCol.rows.length === 1) {
    const col = precisionCol.rows[0];
    pass("jars.target_date_precision exists (migration 0024)");
    if (col.is_nullable === "NO") pass("jars.target_date_precision is NOT NULL");
    else fail("jars.target_date_precision is nullable");
    if ((col.column_default ?? "").includes("exact")) {
      pass("jars.target_date_precision defaults to 'exact'");
    } else {
      fail("jars.target_date_precision default", `found ${col.column_default}`);
    }
  } else {
    fail("jars.target_date_precision missing after full chain");
  }

  const precisionConstraint = await testClient.query(
    `SELECT conname FROM pg_constraint WHERE conname = 'jars_target_date_precision_check'`,
  );
  if (precisionConstraint.rows.length === 1) {
    pass("jars_target_date_precision_check constraint present");
  } else {
    fail("jars_target_date_precision_check constraint missing");
  }

  // The constraint must actually reject an out-of-model value, not merely exist.
  try {
    await testClient.query("BEGIN");
    await testClient.query(
      `INSERT INTO jars (organizer_id, name, slug, target_date, goal_amount_cents, target_date_precision)
       VALUES ('00000000-0000-0000-0000-000000000000', 'x', 'x', '2030-01-01', 100, 'decade')`,
    );
    await testClient.query("ROLLBACK");
    fail("target_date_precision CHECK did not reject an invalid value");
  } catch (err) {
    await testClient.query("ROLLBACK");
    const message = err instanceof Error ? err.message : String(err);
    // A foreign-key failure would also throw, so require the CHECK by name.
    if (message.includes("jars_target_date_precision_check")) {
      pass("target_date_precision CHECK rejects values outside the model");
    } else {
      fail("target_date_precision CHECK rejection", message.split("\n")[0]);
    }
  }

  // ── Migration 0025: activity_events.dedupe_key ─────────────────────────────
  //
  // Another column-only migration, so the table count cannot notice it either.
  // What matters is not just that the column exists but that the unique index
  // behaves the way the writer depends on: it must reject a duplicate non-NULL
  // key and must still accept any number of NULLs.
  const dedupeCol = await testClient.query(
    `SELECT data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name='activity_events'
        AND column_name='dedupe_key'`,
  );
  if (dedupeCol.rows.length === 1) {
    pass("activity_events.dedupe_key exists (migration 0025)");
    if (dedupeCol.rows[0].is_nullable === "YES") pass("activity_events.dedupe_key is nullable");
    else fail("activity_events.dedupe_key is NOT NULL — unclaimed rows could not exist");
  } else {
    fail("activity_events.dedupe_key missing after full chain");
  }

  const dedupeIdx = await testClient.query(
    `SELECT indexdef FROM pg_indexes
      WHERE schemaname='public' AND indexname='activity_events_dedupe_key_idx'`,
  );
  if (dedupeIdx.rows.length === 1) {
    pass("activity_events_dedupe_key_idx present");
    const def = dedupeIdx.rows[0].indexdef;
    if (/CREATE UNIQUE INDEX/i.test(def)) pass("activity_events_dedupe_key_idx is UNIQUE");
    else fail("activity_events_dedupe_key_idx is not unique", def);
    // A predicate would force every INSERT to repeat it to infer the target.
    if (!/\bWHERE\b/i.test(def)) pass("activity_events_dedupe_key_idx is not partial");
    else fail("activity_events_dedupe_key_idx unexpectedly carries a predicate", def);
  } else {
    fail("activity_events_dedupe_key_idx missing after full chain");
  }

  // The index must actually enforce uniqueness, and must actually tolerate
  // repeated NULLs. Both are exercised against real rows and rolled back.
  try {
    await testClient.query("BEGIN");
    await testClient.query(
      `INSERT INTO users (id, email, password_hash)
       VALUES ('00000000-0000-0000-0000-0000000000aa', 'chain-check@example.invalid', 'x')`,
    );
    await testClient.query(
      `INSERT INTO jars (id, organizer_id, name, slug, target_date, goal_amount_cents)
       VALUES ('00000000-0000-0000-0000-0000000000bb',
               '00000000-0000-0000-0000-0000000000aa', 'chain', 'chain', '2030-01-01', 100)`,
    );
    const insertActivity = (dedupe) =>
      testClient.query(
        `INSERT INTO activity_events (jar_id, event_type, description, dedupe_key)
         VALUES ('00000000-0000-0000-0000-0000000000bb', 'jar_commitment_phase', 'x', $1)`,
        [dedupe],
      );

    await insertActivity(null);
    await insertActivity(null);
    await insertActivity(null);
    pass("activity_events accepts repeated NULL dedupe_key values");

    await insertActivity("chain-check-key");
    try {
      await insertActivity("chain-check-key");
      fail("activity_events_dedupe_key_idx did not reject a duplicate key");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("activity_events_dedupe_key_idx")) {
        pass("activity_events_dedupe_key_idx rejects a duplicate non-NULL key");
      } else {
        fail("Duplicate dedupe_key rejection", message.split("\n")[0]);
      }
    }
    await testClient.query("ROLLBACK");
  } catch (err) {
    await testClient.query("ROLLBACK");
    fail("dedupe_key uniqueness check", err instanceof Error ? err.message : String(err));
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
