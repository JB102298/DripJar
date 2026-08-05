"use strict";
/**
 * Fresh migration verification script — CJS, uses pg from pnpm store.
 *
 * 1. Creates a clean temporary PostgreSQL database
 * 2. Applies migrations 0000–0017 in order
 * 3. Verifies Phase 4C schema requirements
 * 4. Drops the temporary database
 */

const path = require("path");
const fs   = require("fs");
const pg   = require(path.join(
  __dirname, "..", "node_modules", ".pnpm", "pg@8.22.0", "node_modules", "pg"
));

const DRIZZLE_DIR = path.join(__dirname, "..", "lib", "db", "drizzle");

// ── Build connection strings ──────────────────────────────────────────────────
const rawUrl = process.env.DATABASE_URL;
if (!rawUrl) throw new Error("DATABASE_URL not set");

// Parse: postgresql://user:pass@host/db?params
const m = rawUrl.match(/^(postgresql:\/\/[^/]+)\/([\w-]+)(.*)?$/);
const baseConn = m[1];          // postgresql://user:pass@host
const adminDb  = m[2];          // heliumdb
const params   = m[3] || "";    // ?sslmode=disable etc.

const TEST_DB  = `m3jar_migration_verify_${Date.now()}`;
const adminDsn = rawUrl;
const testDsn  = `${baseConn}/${TEST_DB}${params}`;

const results = [];
function pass(label, detail = "") {
  results.push({ ok: true, label });
  console.log(`  ✓  ${label}${detail ? "  [" + detail + "]" : ""}`);
}
function fail(label, detail = "") {
  results.push({ ok: false, label, detail });
  console.error(`  ✗  ${label}${detail ? "  [" + detail + "]" : ""}`);
}

// ── STEP 1: Create fresh database ─────────────────────────────────────────────
console.log(`\n=== STEP 1: Create fresh database ${TEST_DB} ===`);
const adminPool = new pg.Pool({ connectionString: adminDsn });
await adminPool.query(`CREATE DATABASE "${TEST_DB}"`);
await adminPool.end();
pass(`Created ${TEST_DB}`);

// ── STEP 2: Apply migrations ───────────────────────────────────────────────────
console.log("\n=== STEP 2: Apply migrations 0000 → 0017 ===");
const testPool = new pg.Pool({ connectionString: testDsn });

const migFiles = fs.readdirSync(DRIZZLE_DIR)
  .filter(f => /^\d{4}_.+\.sql$/.test(f))
  .sort();

if (migFiles.length !== 18) {
  fail(`Expected 18 migration files, found ${migFiles.length}`);
} else {
  pass(`Found ${migFiles.length} migration files`);
}

for (const file of migFiles) {
  const sql = fs.readFileSync(path.join(DRIZZLE_DIR, file), "utf8");
  try {
    await testPool.query(sql);
    pass(`Applied ${file}`);
  } catch (err) {
    fail(`Applied ${file}`, err.message.split("\n")[0].substring(0, 120));
  }
}

// ── STEP 3: Verify schema ─────────────────────────────────────────────────────
console.log("\n=== STEP 3: Verify schema ===");

async function q(sql, args = []) {
  return (await testPool.query(sql, args)).rows;
}
async function tableExists(name) {
  const r = await q(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`, [name]);
  return r.length > 0;
}
async function indexExists(name) {
  const r = await q(`SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname=$1`, [name]);
  return r.length > 0;
}
async function getConstraintDef(name) {
  const r = await q(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname=$1`, [name]);
  return r.length > 0 ? r[0].def : null;
}

// 3a. Phase 4C tables must exist
for (const t of [
  "commitment_snapshots", "commitment_snapshot_allocations",
  "fund_commitments", "commitment_allocations",
  "refund_requests", "refund_allocations",
]) {
  (await tableExists(t)) ? pass(`Table exists: ${t}`) : fail(`Table missing: ${t}`);
}

// 3b. REFUND_PENDING in ledger_accounts
{
  const r = await q(`SELECT 1 FROM ledger_accounts WHERE account_type='REFUND_PENDING' LIMIT 1`);
  r.length > 0 ? pass("ledger_accounts includes REFUND_PENDING")
               : fail("ledger_accounts missing REFUND_PENDING");
}

// 3c. Placeholder table dropped by 0015
!(await tableExists("refund_request_placeholders"))
  ? pass("refund_request_placeholders correctly dropped by migration 0015")
  : fail("refund_request_placeholders still exists — migration 0015 failed to drop it");

// 3d. ft_transaction_type_check includes all Phase 4C types
{
  const def = await getConstraintDef("ft_transaction_type_check");
  if (def) {
    for (const type of ["refund_reservation", "refund_finalization", "refund_reversal", "commitment_transfer"]) {
      def.includes(type)
        ? pass(`ft_transaction_type_check includes '${type}'`)
        : fail(`ft_transaction_type_check missing '${type}'`, def.substring(0, 100));
    }
  } else {
    fail("ft_transaction_type_check constraint not found");
  }
}

// 3e. Phase 4C indexes
for (const idx of [
  "commitment_snapshots_status_expires_idx",
  "fund_commitments_snapshot_idx",
  "refund_allocations_dispatch_idx",
  "refund_allocations_stripe_refund_unique_idx",
  "refund_requests_member_jar_idx",
]) {
  (await indexExists(idx)) ? pass(`Index exists: ${idx}`) : fail(`Index missing: ${idx}`);
}

// 3f. fund_commitments NOT NULL constraints
{
  const cols = await q(
    `SELECT column_name, is_nullable FROM information_schema.columns
     WHERE table_schema='public' AND table_name='fund_commitments'
     AND column_name IN ('agreement_id','agreement_version','snapshot_id','jar_id','member_id')`
  );
  for (const col of cols) {
    col.is_nullable === "NO"
      ? pass(`fund_commitments.${col.column_name} is NOT NULL`)
      : fail(`fund_commitments.${col.column_name} is nullable (expected NOT NULL)`);
  }
}

// 3g. Overall table count sanity check
{
  const r = await q(
    `SELECT count(*)::int AS cnt FROM information_schema.tables
     WHERE table_schema='public' AND table_type='BASE TABLE'`
  );
  const cnt = r[0].cnt;
  cnt >= 16 ? pass(`Table count: ${cnt} (≥ 16)`)
            : fail(`Table count: ${cnt} (expected ≥ 16)`);
}

// 3h. commitment_snapshots has expected columns
{
  const r = await q(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='commitment_snapshots'
     AND column_name IN ('id','jar_id','member_id','snapshot_token','status','expires_at','confirmed_at')`
  );
  const found = r.map(row => row.column_name).sort().join(",");
  const needed = "confirmed_at,expires_at,id,jar_id,member_id,snapshot_token,status";
  found === needed
    ? pass(`commitment_snapshots columns: ${found}`)
    : fail(`commitment_snapshots columns mismatch`, `found: ${found}`);
}

// ── STEP 4: Drop test database ────────────────────────────────────────────────
console.log("\n=== STEP 4: Drop test database ===");
await testPool.end();
const adminPool2 = new pg.Pool({ connectionString: adminDsn });
await adminPool2.query(`DROP DATABASE "${TEST_DB}"`);
await adminPool2.end();
pass(`Dropped ${TEST_DB}`);

// Also drop the earlier unused test DB if it exists
try {
  const adminPool3 = new pg.Pool({ connectionString: adminDsn });
  const r = await adminPool3.query(`SELECT 1 FROM pg_database WHERE datname LIKE 'm3jar_migration_test_%' LIMIT 5`);
  for (const row of r.rows) {
    // Already dropped in main flow; this is just cleanup
  }
  await adminPool3.end();
} catch (_) {}

// ── SUMMARY ───────────────────────────────────────────────────────────────────
console.log("\n=== SUMMARY ===");
const passed = results.filter(r => r.ok).length;
const failed = results.filter(r => !r.ok).length;
console.log(`${passed} checks passed, ${failed} failed`);
if (failed > 0) {
  results.filter(r => !r.ok).forEach(r => console.error(`  FAIL: ${r.label}${r.detail ? " — " + r.detail : ""}`));
  process.exit(1);
} else {
  console.log("ALL FRESH MIGRATION CHECKS PASSED");
  process.exit(0);
}
