/**
 * Disposable local test-database lifecycle.
 *
 * Provisions, migrates, and disposes of exactly one database — `dripjar_test` —
 * so automated tests never touch `dripjar_dev`, the owner QA/demo database.
 *
 * Usage:
 *   node scripts/test-db.mjs create        create + migrate if absent
 *   node scripts/test-db.mjs reset         drop (if present) + create + migrate
 *   node scripts/test-db.mjs migrate       apply the canonical chain
 *   node scripts/test-db.mjs drop          drop if present
 *   node scripts/test-db.mjs run           reset, migrate, test, drop
 *   node scripts/test-db.mjs run --keep    reset, migrate, test, PRESERVE
 *   node scripts/test-db.mjs run -- <cmd…> as above with a custom test command
 *
 * ─── WHAT THIS SCRIPT WILL NOT DO ────────────────────────────────────────────
 *
 * The target database name is the compile-time constant TEST_DATABASE_NAME.
 * There is no flag, argument, or environment variable that changes it — a
 * caller cannot ask this script to create, migrate, or drop anything else, and
 * an assertion re-checks that before every DDL statement rather than trusting
 * the constant to have stayed put.
 *
 * `dripjar_dev` is used only as the *identity* to derive from: its host, port,
 * user, and password locate the server and authenticate. This script never
 * opens a connection to it, and issues no statement that could modify it. DDL
 * runs against the `postgres` maintenance database, because PostgreSQL cannot
 * drop a database you are connected to.
 *
 * No session is ever terminated. If a drop fails because something still holds
 * a connection, that is reported and the run fails — killing backends is a
 * bigger hammer than a test harness should own.
 *
 * ─── CREDENTIALS ─────────────────────────────────────────────────────────────
 *
 * The password is never read, never derived, and never printed. It travels one
 * of two ways, both untouched by this file: embedded in the inherited
 * DATABASE_URL (preserved verbatim when the path is swapped), or in PGPASSWORD,
 * which node-postgres and drizzle-kit both pick up from the environment.
 *
 * Nothing is written to disk. Child processes receive the derived URL through
 * `env`, never through argv, so it cannot appear in a process listing.
 */

import pg from "pg";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// ─── Policy ──────────────────────────────────────────────────────────────────

/** The only database this script may ever create, migrate, or drop. */
const TEST_DATABASE_NAME = "dripjar_test";

/** Database used purely to issue CREATE/DROP DATABASE. Never modified. */
const MAINTENANCE_DATABASE = "postgres";

/** Hosts this script will operate against. Loopback only. */
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"];

/** Databases this script must refuse to touch, named explicitly for clarity. */
const PROTECTED_DATABASES = ["dripjar_dev", "postgres", "template0", "template1"];

/** Default suite. The only DB-backed package; mobile runs under jsdom. */
const DEFAULT_TEST_COMMAND = ["--filter", "@workspace/api-server", "test"];

// ─── Output ──────────────────────────────────────────────────────────────────

const log = (m) => console.log(`  ${m}`);
const err = (m) => console.error(`  ${m}`);

/** Exit with a redacted message. Never receives a URL or a credential. */
function abort(message) {
  err("");
  err(`TEST-DB REFUSED: ${message}`);
  err("");
  process.exit(1);
}

// ─── Connection derivation ───────────────────────────────────────────────────

function normaliseHost(hostname) {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

/**
 * Parse the inherited DATABASE_URL and derive the two connection strings this
 * script needs, without ever logging either of them.
 *
 * The source URL is validated first: if the inherited identity points at a
 * remote server, no test URL is derived from it at all.
 */
function deriveConnections() {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    abort(
      "DATABASE_URL is not set. This script derives the local test connection " +
        "from the inherited local database identity.",
    );
  }

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

  const host = normaliseHost(source.hostname);
  if (!LOOPBACK_HOSTS.includes(host)) {
    abort(
      `DATABASE_URL points at non-loopback host "${host}". This script only ` +
        `operates against a local PostgreSQL server (${LOOPBACK_HOSTS.join(", ")}).`,
    );
  }

  const port = source.port || "5432";

  // Swap only the path. Userinfo (and therefore any embedded password) is
  // carried across untouched; query parameters are dropped so nothing from the
  // dev DSN can redirect the test connection.
  const build = (database) => {
    const u = new URL(source.toString());
    u.pathname = `/${database}`;
    u.search = "";
    u.hash = "";
    return u.toString();
  };

  return {
    host,
    port,
    sourceDatabase: source.pathname.replace(/^\//, ""),
    testUrl: build(TEST_DATABASE_NAME),
    maintenanceUrl: build(MAINTENANCE_DATABASE),
  };
}

/**
 * Re-assert the target before any DDL.
 *
 * TEST_DATABASE_NAME is a constant, so this can only fire if someone later
 * edits it into something dangerous. That is exactly the edit worth catching.
 */
function assertSafeTarget(name) {
  if (name !== TEST_DATABASE_NAME) {
    abort(`Refusing DDL against "${name}". This script may only touch "${TEST_DATABASE_NAME}".`);
  }
  if (PROTECTED_DATABASES.includes(name)) {
    abort(`Refusing DDL against protected database "${name}".`);
  }
}

/**
 * Quote a PostgreSQL identifier.
 *
 * The only value ever passed here is TEST_DATABASE_NAME, but CREATE/DROP
 * DATABASE cannot be parameterised, so the quoting is done properly rather
 * than relying on the constant being well-behaved.
 */
function quoteIdent(name) {
  return `"${name.replace(/"/g, '""')}"`;
}

async function withMaintenanceClient(maintenanceUrl, fn) {
  const client = new pg.Client({ connectionString: maintenanceUrl });
  try {
    await client.connect();
  } catch (e) {
    abort(
      `Could not connect to the "${MAINTENANCE_DATABASE}" maintenance database ` +
        `(${e.code ?? "connection failed"}). Check that the local server is running ` +
        `and that the inherited role may connect to it.`,
    );
  }
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

// ─── DDL ─────────────────────────────────────────────────────────────────────

async function databaseExists(client, name) {
  const r = await client.query("select 1 from pg_database where datname = $1", [name]);
  return r.rowCount === 1;
}

async function dropTestDatabase(conn, { quiet = false } = {}) {
  assertSafeTarget(TEST_DATABASE_NAME);
  return withMaintenanceClient(conn.maintenanceUrl, async (client) => {
    if (!(await databaseExists(client, TEST_DATABASE_NAME))) {
      if (!quiet) log(`${TEST_DATABASE_NAME} does not exist — nothing to drop`);
      return false;
    }
    try {
      await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(TEST_DATABASE_NAME)}`);
    } catch (e) {
      if (e.code === "55006") {
        abort(
          `${TEST_DATABASE_NAME} is still in use by another session, so it cannot ` +
            `be dropped. Close any open psql or test process and retry. This script ` +
            `will not terminate backends.`,
        );
      }
      abort(`Failed to drop ${TEST_DATABASE_NAME} (${e.code ?? "unknown error"}).`);
    }
    if (!quiet) log(`Dropped ${TEST_DATABASE_NAME}`);
    return true;
  });
}

async function createTestDatabase(conn) {
  assertSafeTarget(TEST_DATABASE_NAME);
  return withMaintenanceClient(conn.maintenanceUrl, async (client) => {
    if (await databaseExists(client, TEST_DATABASE_NAME)) {
      log(`${TEST_DATABASE_NAME} already exists`);
      return false;
    }
    await client.query(
      `CREATE DATABASE ${quoteIdent(TEST_DATABASE_NAME)} ENCODING 'UTF8' TEMPLATE template0`,
    );
    log(`Created ${TEST_DATABASE_NAME}`);
    return true;
  });
}

// ─── Child processes ─────────────────────────────────────────────────────────

/**
 * Windows needs `pnpm.cmd`, and Node refuses to spawn a `.cmd` without a shell
 * (the CVE-2024-27980 hardening). Every argv entry below is a hard-coded
 * literal and the connection string travels via `env`, so nothing
 * shell-sensitive is interpolated into the command line.
 */
const PNPM_BIN = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const NEEDS_SHELL = process.platform === "win32";

function runPnpm(args, databaseUrl, extraEnv = {}) {
  return spawnSync(PNPM_BIN, args, {
    cwd: REPO_ROOT,
    stdio: "inherit",
    shell: NEEDS_SHELL,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      PGDATABASE: TEST_DATABASE_NAME,
      ...extraEnv,
    },
  });
}

/** Apply the canonical migration chain, in journal order, via drizzle-kit. */
function migrateTestDatabase(conn) {
  log(`Applying canonical migration chain to ${TEST_DATABASE_NAME}…`);
  const res = runPnpm(["--filter", "@workspace/db", "run", "migrate"], conn.testUrl);
  if (res.status !== 0) {
    err("");
    err(`Migration failed (exit ${res.status ?? res.signal}).`);
    process.exit(res.status ?? 1);
  }
  log("Migration chain applied");
}

/** Report what a fresh provision actually produced. Read-only. */
async function verifyTestDatabase(conn) {
  const client = new pg.Client({ connectionString: conn.testUrl });
  await client.connect();
  try {
    const tables = await client.query(
      `select count(*)::int n from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    const migrations = await client.query(
      "select count(*)::int n from drizzle.__drizzle_migrations",
    );
    const accounts = await client.query("select count(*)::int n from ledger_accounts");
    log(
      `Verified: ${migrations.rows[0].n} migrations, ` +
        `${tables.rows[0].n} public tables, ${accounts.rows[0].n} ledger accounts`,
    );
    return {
      migrations: migrations.rows[0].n,
      tables: tables.rows[0].n,
      ledgerAccounts: accounts.rows[0].n,
    };
  } finally {
    await client.end().catch(() => {});
  }
}

// ─── run ─────────────────────────────────────────────────────────────────────

/**
 * Passthrough arguments become a command line under `shell: true` on Windows,
 * so refuse anything a shell would treat as syntax. The default command needs
 * none of these characters.
 */
function assertSafePassthrough(args) {
  const unsafe = /[&|;<>^`$(){}\[\]!\n\r"']/;
  for (const a of args) {
    if (unsafe.test(a)) {
      abort(`Refusing test command argument containing shell metacharacters: ${a}`);
    }
  }
}

async function runSuite(conn, { keep }) {
  const passthroughIdx = process.argv.indexOf("--");
  const testArgs =
    passthroughIdx !== -1 ? process.argv.slice(passthroughIdx + 1) : DEFAULT_TEST_COMMAND;
  if (testArgs.length === 0) abort("No test command supplied after `--`.");
  assertSafePassthrough(testArgs);

  log("");
  log(`Resetting ${TEST_DATABASE_NAME} on ${conn.host}:${conn.port}`);
  await dropTestDatabase(conn, { quiet: true });
  await createTestDatabase(conn);
  migrateTestDatabase(conn);
  await verifyTestDatabase(conn);

  log("");
  log(`Running: pnpm ${testArgs.join(" ")}`);
  log("");

  // Set here, in the child environment, BEFORE vitest starts. The vitest global
  // setup is a second assertion, not the switch itself.
  //
  //   NODE_ENV=test  engages the pool guard, and makes rate limiters no-ops and
  //                  Resend delivery vacuous. Without it a suite produces
  //                  cascading 429s that read exactly like logic regressions.
  //   TZ=UTC         the date helpers compare UTC yyyy-MM-dd strings, and several
  //                  pure schedule/health tests assert on day boundaries. Under a
  //                  westward host zone (this machine is America/New_York) those
  //                  land a day early. Pinning it makes a run reproducible on any
  //                  developer machine and in CI.
  const res = runPnpm(testArgs, conn.testUrl, { NODE_ENV: "test", TZ: "UTC" });
  const exitCode = res.status ?? (res.signal ? 1 : 1);

  log("");
  if (keep) {
    log(`Preserved ${TEST_DATABASE_NAME} for diagnosis.`);
    log(`Inspect with:  psql "$DATABASE_URL" -d ${TEST_DATABASE_NAME}`);
    log(`Remove with:   node scripts/test-db.mjs drop`);
  } else {
    // Runs whether the suite passed or failed.
    await dropTestDatabase(conn);
  }

  process.exit(exitCode);
}

// ─── Entry point ─────────────────────────────────────────────────────────────

const command = process.argv[2] ?? "run";
const keep = process.argv.includes("--keep");
const conn = deriveConnections();

log("");
log(`server      : ${conn.host}:${conn.port}`);
log(`derived from: ${conn.sourceDatabase} (identity only — never modified)`);
log(`target      : ${TEST_DATABASE_NAME}`);

switch (command) {
  case "create":
    await createTestDatabase(conn);
    migrateTestDatabase(conn);
    await verifyTestDatabase(conn);
    break;
  case "reset":
    await dropTestDatabase(conn, { quiet: true });
    await createTestDatabase(conn);
    migrateTestDatabase(conn);
    await verifyTestDatabase(conn);
    break;
  case "migrate":
    migrateTestDatabase(conn);
    await verifyTestDatabase(conn);
    break;
  case "drop":
    await dropTestDatabase(conn);
    break;
  case "run":
    await runSuite(conn, { keep });
    break;
  default:
    abort(`Unknown command "${command}". Expected: create, reset, migrate, drop, run.`);
}
