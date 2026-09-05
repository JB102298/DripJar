/**
 * Migration 0025 upgrade-path verification.
 *
 * `run-fresh-migration.mjs` proves an EMPTY database can be provisioned by the
 * whole chain. It cannot prove the thing that actually carries risk here:
 * migration 0025 adds a unique index to a table that already holds duplicate
 * rows, and it elects one of them per jar to carry the new key. That election
 * has to be deterministic, it has to leave every other row exactly as it found
 * it, and it has to happen on a database that looks like a real one.
 *
 * So this script builds that database: the chain up to and including 0024, then
 * a population of jars whose activity has already gone wrong in the specific
 * ways `dripjar_dev` did — many duplicates, timestamps tied to the microsecond,
 * unrelated activity types alongside them — and only then lets the real
 * migration runner apply 0025.
 *
 * ─── 0025 IS APPLIED BY `drizzle-kit migrate`, NOT BY HAND ───────────────────
 *
 * The baseline chain (0000→0024) is executed directly, because the point is to
 * stop at a specific version. Migration 0025 itself is not: it is applied by
 * the same `pnpm --filter @workspace/db run migrate` that provisions a real
 * database, with `drizzle.__drizzle_migrations` seeded to 0024 first so the
 * runner has exactly one entry left to apply. What is verified is therefore the
 * real upgrade, through the real runner, including the journal bookkeeping.
 *
 * ─── IDEMPOTENCY IS THE RUNNER'S, NOT THE SQL'S ──────────────────────────────
 *
 * 0025 carries no `IF NOT EXISTS`. Re-executing its raw SQL is expected to
 * fail, and this script does not do it. What must be idempotent is a second
 * ORDINARY migration invocation, and that is checked the way an operator would
 * experience it: run `migrate` again and prove the journal, the schema and
 * every row are unchanged.
 *
 * ─── AND IT MUST FAIL CLOSED ─────────────────────────────────────────────────
 *
 * Two drift scenarios are built deliberately — the column installed by hand,
 * and the column plus its index installed by hand — each without the journal
 * entry that would say 0025 had run. In both, `migrate` must fail rather than
 * silently accept a schema it did not produce.
 *
 * ─── WHAT THIS SCRIPT WILL NOT DO ────────────────────────────────────────────
 *
 * It operates only on throwaway databases whose names it generates itself, and
 * issues DDL against the `postgres` maintenance database only. It never opens a
 * connection to `dripjar_dev`, never names it as a target, and refuses to run at
 * all unless the inherited identity points at a loopback server. Nothing is
 * written to disk and no credential is read, derived, or printed.
 *
 * Requires: DATABASE_URL pointing at a local server where the role may
 *           CREATE DATABASE.
 * Usage:    node scripts/verify-0025-upgrade.mjs
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

// ─── Policy ──────────────────────────────────────────────────────────────────

/** The migration under test. Everything below it is the baseline. */
const TARGET_IDX = 25;
const TARGET_TAG = "0025_activity_idempotency_key";

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"];
const MAINTENANCE_DATABASE = "postgres";
const PROTECTED_DATABASES = ["dripjar_dev", "dripjar_test", "postgres", "template0", "template1"];

/** Every database this run creates, so cleanup can find them all. */
const RUN_ID = Date.now();
const createdDatabases = [];

// ─── Reporting ───────────────────────────────────────────────────────────────

const results = [];
const pass = (label, detail = "") => {
  results.push({ ok: true, label });
  console.log(`  ✓  ${label}${detail ? `  [${detail}]` : ""}`);
};
const fail = (label, detail = "") => {
  results.push({ ok: false, label, detail });
  console.error(`  ✗  ${label}${detail ? `  [${detail}]` : ""}`);
};

/** Exit with a redacted message. Never receives a URL or a credential. */
function abort(message) {
  console.error(`\n  UPGRADE-VERIFY REFUSED: ${message}\n`);
  process.exit(1);
}

// ─── Connection derivation ───────────────────────────────────────────────────

const raw = process.env.DATABASE_URL;
if (!raw) abort("DATABASE_URL is not set.");

let source;
try {
  source = new URL(raw);
} catch {
  // Never echo the input — it is the one string guaranteed to carry a password.
  abort("DATABASE_URL could not be parsed as a URL.");
}

if (source.protocol !== "postgresql:" && source.protocol !== "postgres:") {
  abort(`DATABASE_URL uses unsupported scheme "${source.protocol}".`);
}

const host = source.hostname.replace(/^\[|\]$/g, "");
if (!LOOPBACK_HOSTS.includes(host)) {
  abort(`DATABASE_URL points at non-loopback host "${host}".`);
}

/** Swap only the path; userinfo travels across untouched, query params dropped. */
function urlFor(database) {
  const u = new URL(source.toString());
  u.pathname = `/${database}`;
  u.search = "";
  u.hash = "";
  return u.toString();
}

const maintenanceUrl = urlFor(MAINTENANCE_DATABASE);

// ─── Migration chain ─────────────────────────────────────────────────────────

const journal = JSON.parse(fs.readFileSync(JOURNAL_PATH, "utf8"));
const entries = [...(journal.entries ?? [])].sort((a, b) => a.idx - b.idx);
const baseline = entries.filter((e) => e.idx < TARGET_IDX);
const target = entries.find((e) => e.idx === TARGET_IDX);

const sqlPathFor = (entry) => path.join(DRIZZLE_DIR, `${entry.tag}.sql`);

/**
 * Apply one journal entry's SQL directly.
 *
 * Used ONLY for the 0000→0024 baseline, where the point is to stop at a chosen
 * version. 0025 is never applied this way — see the header.
 */
async function applyEntry(client, entry) {
  const p = sqlPathFor(entry);
  if (!fs.existsSync(p)) throw new Error(`missing migration file ${entry.tag}.sql`);
  await client.query(fs.readFileSync(p, "utf8"));
}

/**
 * Tell drizzle the baseline is already applied.
 *
 * `drizzle-kit migrate` reads the highest `created_at` recorded in
 * `drizzle.__drizzle_migrations` and applies every journal entry whose `when`
 * exceeds it. Seeding the baseline entries with their own `when` values leaves
 * exactly one entry — 0025 — for the runner to apply.
 */
async function seedMigrationLedger(client) {
  await client.query(`CREATE SCHEMA IF NOT EXISTS drizzle`);
  await client.query(
    `CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
       id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
  );
  for (const entry of baseline) {
    await client.query(
      `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)`,
      [`baseline-${entry.tag}`, String(entry.when)],
    );
  }
}

/** Run the canonical provisioning command against a database. */
function runMigrate(databaseUrl) {
  return spawnSync("pnpm", ["--filter", "@workspace/db", "run", "migrate"], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: "utf8",
    shell: process.platform === "win32",
  });
}

const appliedCount = async (client) =>
  Number((await client.query(`SELECT count(*)::int n FROM drizzle.__drizzle_migrations`)).rows[0].n);

// ─── Database lifecycle ──────────────────────────────────────────────────────

let adminClient = null;

async function createDatabase(name) {
  if (PROTECTED_DATABASES.includes(name)) abort(`Refusing to create protected database "${name}".`);
  await adminClient.query(`CREATE DATABASE "${name}" ENCODING 'UTF8' TEMPLATE template0`);
  createdDatabases.push(name);
  return urlFor(name);
}

/** A database provisioned through 0024 with the ledger seeded to match. */
async function makeBaselineDatabase(name) {
  const url = await createDatabase(name);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  for (const entry of baseline) await applyEntry(client, entry);
  await seedMigrationLedger(client);
  return { url, client };
}

// ─── The population ──────────────────────────────────────────────────────────

const HASH = "$2b$10$upgradeverifynotarealhashxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

/**
 * Build the shapes that matter, each isolated in its own jar:
 *
 *   heavy   many duplicates at distinct times — the ordinary dripjar_dev case
 *   tied    three duplicates sharing one timestamp — only `id` can decide
 *   single  one row and no duplicate — must still be claimed
 *   mixed   duplicates interleaved with other event types on the same jar
 *   none    no commitment-phase row at all — must be left entirely alone
 */
async function seed(client) {
  const jars = {};
  const user = await client.query(
    `insert into users (email, password_hash, email_verified)
     values ('upgrade-verify@test.invalid', $1, true) returning id`,
    [HASH],
  );
  const organizerId = user.rows[0].id;

  const makeJar = async (label) => {
    const res = await client.query(
      `insert into jars (organizer_id, name, slug, category, target_date,
                         cutoff_date, goal_amount_cents, status, currency)
       values ($1, $2, $3, 'Vacation', current_date + 400, current_date - 5,
               100000, 'Saving', 'USD') returning id`,
      [organizerId, `upgrade ${label}`, `upgrade-${label}`],
    );
    return res.rows[0].id;
  };

  const addPhase = (jarId, offsetSeconds, description) =>
    client.query(
      `insert into activity_events (jar_id, event_type, description, created_at)
       values ($1, 'jar_commitment_phase', $2,
               timestamp '2026-08-08 00:00:00' + ($3 || ' seconds')::interval)`,
      [jarId, description, String(offsetSeconds)],
    );

  // heavy: 40 duplicates, each a second apart. The first is the canonical one.
  jars.heavy = await makeJar("heavy");
  for (let i = 0; i < 40; i++) await addPhase(jars.heavy, i, "heavy entered the Commitment phase");

  // tied: three rows sharing one timestamp exactly, plus one strictly later.
  // Only the `id` tie-breaker can pick a winner among the first three, and it
  // must pick the same one on every database.
  jars.tied = await makeJar("tied");
  for (let i = 0; i < 3; i++) await addPhase(jars.tied, 100, "tied entered the Commitment phase");
  await addPhase(jars.tied, 200, "tied entered the Commitment phase");

  // single: exactly one row. Nothing to elect between, but it must be claimed.
  jars.single = await makeJar("single");
  await addPhase(jars.single, 0, "single entered the Commitment phase");

  // mixed: duplicates alongside other event types that must stay unclaimed.
  jars.mixed = await makeJar("mixed");
  await addPhase(jars.mixed, 10, "mixed entered the Commitment phase");
  await addPhase(jars.mixed, 20, "mixed entered the Commitment phase");
  for (const other of ["jar_created", "member_joined", "contribution_added", "cutoff_changed"]) {
    await client.query(
      `insert into activity_events (jar_id, user_id, event_type, description, amount_cents, metadata)
       values ($1, $2, $3, $4, 1234, '{"seeded":true}'::jsonb)`,
      [jars.mixed, organizerId, other, `mixed ${other}`],
    );
  }

  // none: a jar with activity but no commitment-phase row at all.
  jars.none = await makeJar("none");
  await client.query(
    `insert into activity_events (jar_id, event_type, description)
     values ($1, 'jar_created', 'none was created')`,
    [jars.none],
  );

  return { jars, organizerId };
}

/**
 * Every visible column of every activity row, ordered stably.
 *
 * `withKey` is off for the baseline snapshot because the column does not exist
 * yet — that is the whole point of the migration. It must be ON for every read
 * taken afterwards: a snapshot that silently omits `dedupe_key` returns
 * `undefined` for it, and `undefined !== null` would report every row as
 * claimed.
 */
async function snapshot(client, { withKey = false } = {}) {
  const res = await client.query(
    `select id, jar_id, user_id, event_type, description, amount_cents,
            metadata, created_at${withKey ? ", dedupe_key" : ""}
       from activity_events
      order by id`,
  );
  return res.rows;
}

/** The activity table's shape, for proving a re-run changed nothing. */
async function schemaShape(client) {
  const cols = await client.query(
    `select column_name, data_type, is_nullable, column_default
       from information_schema.columns
      where table_schema='public' and table_name='activity_events'
      order by ordinal_position`,
  );
  const idx = await client.query(
    `select indexname, indexdef from pg_indexes
      where schemaname='public' and tablename='activity_events' order by indexname`,
  );
  return JSON.stringify({ columns: cols.rows, indexes: idx.rows });
}

// ─── Run ─────────────────────────────────────────────────────────────────────

let client = null;

try {
  console.log(`\n  server : ${host}:${source.port || "5432"}`);
  console.log(`  targets: throwaway databases created and dropped by this script`);

  // ── STEP 1: Chain sanity, and the fail-closed property of the SQL ──────────
  console.log("\n=== STEP 1: Locate the baseline and the migration under test ===");

  if (baseline.length === TARGET_IDX) {
    pass(`Baseline chain is 0000→0024 (${baseline.length} migrations)`);
  } else {
    fail("Baseline chain length", `expected ${TARGET_IDX}, found ${baseline.length}`);
  }

  if (target && target.tag === TARGET_TAG) pass(`Migration under test is ${TARGET_TAG}`);
  else fail("Migration under test missing from journal", `idx ${TARGET_IDX}`);

  // A versioned migration must not smuggle in reconciliation semantics.
  const targetSql = fs.readFileSync(sqlPathFor(target), "utf8");
  const executable = targetSql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  if (!/IF\s+NOT\s+EXISTS/i.test(executable)) {
    pass("0025 contains no IF NOT EXISTS — it fails closed on drift");
  } else {
    fail("0025 carries IF NOT EXISTS", "drift would be silently accepted");
  }

  adminClient = new pg.Client({ connectionString: maintenanceUrl });
  await adminClient.connect();

  // ── STEP 2: Provision through 0024 ─────────────────────────────────────────
  const mainDb = `dripjar_0025_upgrade_${RUN_ID}`;
  console.log(`\n=== STEP 2: Provision ${mainDb} through migration 0024 ===`);
  const main = await makeBaselineDatabase(mainDb);
  client = main.client;
  pass(`Applied ${baseline.length} migrations (0000→0024)`);

  const ledgerBefore = await appliedCount(client);
  if (ledgerBefore === baseline.length) {
    pass(`Migration ledger records ${ledgerBefore} applied migrations, 0025 not among them`);
  } else {
    fail("Migration ledger seed", `expected ${baseline.length}, found ${ledgerBefore}`);
  }

  const preColumn = await client.query(
    `select 1 from information_schema.columns
      where table_name='activity_events' and column_name='dedupe_key'`,
  );
  if (preColumn.rowCount === 0) pass("dedupe_key does not exist before 0025");
  else fail("dedupe_key already present before 0025 — the baseline is not 0024");

  // ── STEP 3: Seed a database that already went wrong ────────────────────────
  console.log("\n=== STEP 3: Seed duplicated historical activity ===");
  const { jars } = await seed(client);
  const before = await snapshot(client);
  const beforeById = new Map(before.map((r) => [r.id, r]));
  pass(`Seeded ${before.length} activity rows across ${Object.keys(jars).length} jars`);

  // Work out, independently of the migration, which row it OUGHT to elect.
  const expectedWinner = new Map();
  for (const [label, jarId] of Object.entries(jars)) {
    const candidates = before
      .filter((r) => r.jar_id === jarId && r.event_type === "jar_commitment_phase")
      .sort(
        (a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
    if (candidates.length > 0) expectedWinner.set(label, candidates[0].id);
  }
  const earliestTied = before
    .filter((x) => x.jar_id === jars.tied)
    .reduce((min, x) => Math.min(min, x.created_at.getTime()), Infinity);
  const tiedGroup = before.filter(
    (r) => r.jar_id === jars.tied && r.created_at.getTime() === earliestTied,
  );
  if (tiedGroup.length === 3) pass("Three seeded rows share one timestamp exactly");
  else fail("Timestamp tie was not created", `found ${tiedGroup.length} at the earliest instant`);

  // ── STEP 4: Apply 0025 through the real migration runner ───────────────────
  console.log("\n=== STEP 4: Apply 0025 via `drizzle-kit migrate` ===");
  const firstRun = runMigrate(main.url);
  if (firstRun.status === 0) {
    pass("drizzle-kit migrate applied the outstanding migration");
  } else {
    fail(
      "drizzle-kit migrate failed",
      (firstRun.stderr || firstRun.stdout || "").trim().split("\n").slice(-3).join(" | "),
    );
  }

  const ledgerAfter = await appliedCount(client);
  if (ledgerAfter === baseline.length + 1) {
    pass(`Migration ledger now records ${ledgerAfter} migrations — 0025 applied exactly once`);
  } else {
    fail("Migration ledger after 0025", `expected ${baseline.length + 1}, found ${ledgerAfter}`);
  }

  const after = await snapshot(client, { withKey: true });
  const shapeAfter = await schemaShape(client);

  // ── STEP 5: Nothing was inserted, deleted, or altered ──────────────────────
  console.log("\n=== STEP 5: Verify historical rows survived untouched ===");

  if (after.length === before.length) pass(`Activity row count unchanged (${after.length})`);
  else fail("Activity row count changed", `${before.length} → ${after.length}`);

  const VISIBLE = [
    "id",
    "jar_id",
    "user_id",
    "event_type",
    "description",
    "amount_cents",
    "metadata",
    "created_at",
  ];
  let drifted = 0;
  let missing = 0;
  for (const row of after) {
    const original = beforeById.get(row.id);
    if (!original) {
      missing++;
      continue;
    }
    for (const col of VISIBLE) {
      const a = original[col];
      const b = row[col];
      const same =
        a instanceof Date && b instanceof Date
          ? a.getTime() === b.getTime()
          : JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
      if (!same) {
        drifted++;
        fail(`Visible field changed: ${col}`, `row ${row.id}`);
        break;
      }
    }
  }
  if (missing === 0) pass("Every row present before the migration is still present");
  else fail("Rows appeared that did not exist before", `${missing} unknown ids`);
  if (drifted === 0) {
    pass(`All ${VISIBLE.length} pre-existing user-visible columns identical on all ${after.length} rows`);
  }

  // ── STEP 6: The election ───────────────────────────────────────────────────
  console.log("\n=== STEP 6: Verify the key election ===");

  for (const [label, jarId] of Object.entries(jars)) {
    const rows = after.filter((r) => r.jar_id === jarId);
    const phase = rows.filter((r) => r.event_type === "jar_commitment_phase");
    const claimed = rows.filter((r) => r.dedupe_key !== null);

    if (phase.length === 0) {
      if (claimed.length === 0) pass(`${label}: no commitment-phase row, nothing claimed`);
      else fail(`${label}: claimed a key with no commitment-phase row`);
      continue;
    }

    if (claimed.length === 1) pass(`${label}: exactly one of ${phase.length} rows claimed the key`);
    else fail(`${label}: expected exactly one claimed row`, `found ${claimed.length}`);

    const winner = claimed[0];
    if (winner) {
      if (winner.id === expectedWinner.get(label)) {
        pass(`${label}: the earliest row won (id tie-break applied)`);
      } else {
        fail(
          `${label}: the wrong row was elected`,
          `expected ${expectedWinner.get(label)}, got ${winner.id}`,
        );
      }
      if (winner.dedupe_key === `jar_commitment_phase:${jarId}`) {
        pass(`${label}: key format is jar_commitment_phase:<jarId>`);
      } else {
        fail(`${label}: unexpected key value`, String(winner.dedupe_key));
      }
      if (winner.event_type === "jar_commitment_phase") {
        pass(`${label}: the claimed row is a commitment-phase row`);
      } else {
        fail(`${label}: claimed the wrong event type`, winner.event_type);
      }
    }

    const surplus = phase.filter((r) => r.dedupe_key === null);
    if (surplus.length === phase.length - 1) {
      pass(`${label}: all ${surplus.length} surplus duplicates remain present with NULL keys`);
    } else {
      fail(
        `${label}: surplus duplicates`,
        `expected ${phase.length - 1} NULL, found ${surplus.length}`,
      );
    }
  }

  const otherTypesClaimed = after.filter(
    (r) => r.event_type !== "jar_commitment_phase" && r.dedupe_key !== null,
  );
  if (otherTypesClaimed.length === 0) pass("No unrelated activity type received a key");
  else fail("Unrelated activity types were claimed", `${otherTypesClaimed.length} rows`);

  // ── STEP 7: The index actually enforces what the writer depends on ─────────
  console.log("\n=== STEP 7: Verify the unique index ===");

  const idx = await client.query(
    `select indexdef from pg_indexes
      where schemaname='public' and indexname='activity_events_dedupe_key_idx'`,
  );
  if (idx.rowCount === 1) {
    pass("activity_events_dedupe_key_idx exists");
    const def = idx.rows[0].indexdef;
    if (/CREATE UNIQUE INDEX/i.test(def)) pass("Index is UNIQUE");
    else fail("Index is not unique", def);
    if (!/\bWHERE\b/i.test(def)) pass("Index is not partial — ON CONFLICT (dedupe_key) can infer it");
    else fail("Index unexpectedly carries a predicate", def);
  } else {
    fail("activity_events_dedupe_key_idx missing after 0025");
  }

  // Duplicate non-NULL keys must be rejected...
  try {
    await client.query("BEGIN");
    await client.query(
      `insert into activity_events (jar_id, event_type, description, dedupe_key)
       values ($1, 'jar_commitment_phase', 'dupe attempt', $2)`,
      [jars.heavy, `jar_commitment_phase:${jars.heavy}`],
    );
    await client.query("ROLLBACK");
    fail("A duplicate dedupe_key was accepted");
  } catch (err) {
    await client.query("ROLLBACK");
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("activity_events_dedupe_key_idx")) {
      pass("A duplicate non-NULL dedupe_key is rejected by the index");
    } else {
      fail("Duplicate rejection came from somewhere unexpected", message.split("\n")[0]);
    }
  }

  // ...and repeated NULLs must still be allowed, or every other writer breaks.
  try {
    await client.query("BEGIN");
    for (let i = 0; i < 5; i++) {
      await client.query(
        `insert into activity_events (jar_id, event_type, description)
         values ($1, 'contribution_added', 'null key row')`,
        [jars.heavy],
      );
    }
    await client.query("ROLLBACK");
    pass("Repeated NULL dedupe_key values remain allowed");
  } catch (err) {
    await client.query("ROLLBACK");
    fail("NULL dedupe_key rows were rejected", err instanceof Error ? err.message : String(err));
  }

  // ── STEP 8: A second ordinary migration invocation is a no-op ──────────────
  //
  // Not a re-execution of 0025's SQL — that is expected to fail and is not
  // attempted. This is what an operator actually does: run `migrate` again.
  console.log("\n=== STEP 8: Verify a second `drizzle-kit migrate` is a no-op ===");

  const secondRun = runMigrate(main.url);
  if (secondRun.status === 0) pass("Second `drizzle-kit migrate` run succeeded");
  else {
    fail(
      "Second migrate run failed",
      (secondRun.stderr || secondRun.stdout || "").trim().split("\n").slice(-3).join(" | "),
    );
  }

  const ledgerRerun = await appliedCount(client);
  if (ledgerRerun === ledgerAfter) {
    pass(`Journal unchanged by the re-run — still ${ledgerRerun} migrations, 0025 not reapplied`);
  } else {
    fail("The re-run recorded another migration", `${ledgerAfter} → ${ledgerRerun}`);
  }

  if ((await schemaShape(client)) === shapeAfter) pass("Schema identical after the re-run");
  else fail("The re-run changed the activity_events schema");

  const afterRerun = await snapshot(client, { withKey: true });
  const dataStable =
    afterRerun.length === after.length &&
    afterRerun.every((row, i) => {
      const prev = after[i];
      return (
        prev &&
        row.id === prev.id &&
        (row.dedupe_key ?? null) === (prev.dedupe_key ?? null) &&
        row.created_at.getTime() === prev.created_at.getTime()
      );
    });
  if (dataStable) pass("Every row identical after the re-run");
  else fail("The re-run altered activity rows");

  // ── STEP 9: Drift must fail closed ─────────────────────────────────────────
  //
  // In both scenarios the schema carries part or all of 0025 while the journal
  // says it never ran. That is a database nobody verified, and the migration
  // must refuse it rather than mark itself done.
  console.log("\n=== STEP 9: Verify 0025 fails closed on schema drift ===");

  // `drizzle-kit migrate` prints only a spinner and exits 1 — it surfaces no
  // trace of the underlying database error — so the runner proves the outcome
  // (it fails, and the journal stays unmarked) while the statements are
  // executed directly through the driver to prove the CAUSE by SQLSTATE. That
  // is what stops this test passing for some unrelated reason.
  const DUPLICATE_COLUMN = "42701";
  const DUPLICATE_RELATION = "42P07";

  /** The bare `CREATE UNIQUE INDEX …` statement, read from the migration itself. */
  const indexStatement = executable
    .split(";")
    .map((s) => s.trim())
    .find((s) => /create\s+unique\s+index/i.test(s));
  if (indexStatement) pass("Located the CREATE UNIQUE INDEX statement inside 0025");
  else fail("Could not find a CREATE UNIQUE INDEX statement in 0025");

  /** Run SQL and report the SQLSTATE it raised, or null if it succeeded. */
  async function sqlStateOf(c, sql) {
    try {
      await c.query(sql);
      return null;
    } catch (err) {
      return err?.code ?? "unknown";
    }
  }

  const driftScenarios = [
    {
      name: "column installed by hand",
      db: `dripjar_0025_drift_col_${RUN_ID}`,
      prepare: (c) => c.query(`ALTER TABLE activity_events ADD COLUMN dedupe_key TEXT`),
      // The whole migration is attempted; ADD COLUMN is the first statement.
      statement: () => executable,
      expectState: DUPLICATE_COLUMN,
      because: "ALTER TABLE … ADD COLUMN rejects an existing column",
    },
    {
      name: "column and index installed by hand",
      db: `dripjar_0025_drift_idx_${RUN_ID}`,
      prepare: async (c) => {
        await c.query(`ALTER TABLE activity_events ADD COLUMN dedupe_key TEXT`);
        await c.query(
          `CREATE UNIQUE INDEX activity_events_dedupe_key_idx ON activity_events(dedupe_key)`,
        );
      },
      // The index cannot exist without the column, so a whole-file attempt
      // still stops at ADD COLUMN. Run the index statement on its own to prove
      // it is strict too, rather than inferring it.
      statement: () => indexStatement,
      expectState: DUPLICATE_RELATION,
      because: "CREATE UNIQUE INDEX rejects an existing index",
    },
  ];

  for (const scenario of driftScenarios) {
    const drift = await makeBaselineDatabase(scenario.db);
    try {
      await scenario.prepare(drift.client);

      // ── The runner refuses, and records nothing ──────────────────────────
      const run = runMigrate(drift.url);
      if (run.status !== 0) {
        pass(`migrate refuses to run — ${scenario.name}`, `exit ${run.status}`);
      } else {
        fail(`Drift silently accepted — ${scenario.name}`, "migrate reported success");
      }

      // The journal must NOT have recorded 0025, so the discrepancy is still
      // visible to whoever looks next rather than inherited as "done".
      const n = await appliedCount(drift.client);
      if (n === baseline.length) {
        pass(`Journal left unmarked after the failure — ${scenario.name}`, `${n} migrations`);
      } else {
        fail(
          `Journal advanced despite the failure — ${scenario.name}`,
          `expected ${baseline.length}, found ${n}`,
        );
      }

      // ── And the cause is the drifted object, named by SQLSTATE ───────────
      const state = await sqlStateOf(drift.client, scenario.statement());
      if (state === scenario.expectState) {
        pass(`Rejected with SQLSTATE ${state} — ${scenario.because}`);
      } else {
        fail(
          `Wrong failure for ${scenario.name}`,
          `expected SQLSTATE ${scenario.expectState}, got ${state ?? "success"}`,
        );
      }
    } finally {
      await drift.client.end().catch(() => {});
    }
  }

  // The control for both scenarios: the SAME baseline database, built by the
  // same helper, migrates cleanly when nothing has drifted. Without this the
  // failures above could be caused by anything.
  if (ledgerAfter === baseline.length + 1) {
    pass("Control: an undrifted baseline database migrated cleanly (STEP 4)");
  }
} catch (err) {
  fail("Unhandled error", err instanceof Error ? err.message : String(err));
} finally {
  // ── STEP 10: Drop every temporary database ─────────────────────────────────
  console.log("\n=== STEP 10: Drop the temporary databases ===");
  try {
    if (client) await client.end();
    if (adminClient) {
      for (const name of createdDatabases) {
        await adminClient.query(`DROP DATABASE IF EXISTS "${name}"`);
        pass(`Dropped ${name}`);
      }
      await adminClient.end();
    }
  } catch (err) {
    fail("Cleanup failed", err instanceof Error ? err.message : String(err));
    console.error(`  Manual cleanup may be required for: ${createdDatabases.join(", ")}`);
  }
}

// ─── Summary ─────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;

console.log("\n=== SUMMARY ===");
console.log(`${passed} checks passed, ${failed} failed`);

if (failed > 0) {
  console.error("\n0025 UPGRADE VERIFICATION FAILED");
  for (const r of results.filter((x) => !x.ok)) {
    console.error(`  - ${r.label}${r.detail ? `: ${r.detail}` : ""}`);
  }
  process.exit(1);
}

console.log("ALL 0025 UPGRADE CHECKS PASSED");
process.exit(0);
