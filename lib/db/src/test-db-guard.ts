/**
 * Test-mode database connection guard.
 *
 * ─── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * `index.ts` used to hand `process.env.DATABASE_URL` straight to `new Pool()`
 * with no checks. Whatever the shell exported is what the suite wrote to, and
 * on this machine that is `dripjar_dev` — the owner QA/demo database. A full
 * API run therefore registered thousands of synthetic users into the database a
 * human uses to walk through the product, and pointing the variable at a
 * production DSN would have written there just as happily.
 *
 * This module is the single place that makes that impossible. It runs BEFORE
 * the pool is constructed, so a misdirected test process fails closed without
 * ever opening a socket.
 *
 * ─── SCOPE: TEST MODE ONLY ───────────────────────────────────────────────────
 *
 * The guard is inert unless `NODE_ENV === "test"`. Development and production
 * connection behaviour is byte-for-byte unchanged — `assertTestDatabaseUrl`
 * returns immediately for every other value, including `undefined`.
 *
 * ─── WHY AN ALLOWLIST AND NOT A PATTERN ──────────────────────────────────────
 *
 * `*_test` would be a standing licence to write to any database somebody
 * happens to suffix that way, including a remote `customer_test`. The database
 * name must be exactly `dripjar_test`, the host must be loopback, and the query
 * string may only carry parameters that cannot redirect the connection.
 *
 * That last one is not paranoia. libpq honours `hostaddr`, `host`, `dbname` and
 * `service` from the query string, and every one of them silently overrides
 * what the rest of the URL appears to say:
 *
 *   postgresql://localhost/dripjar_test?hostaddr=10.0.0.5
 *
 * reads as local and connects to 10.0.0.5. Checking the URL's own host and path
 * is not sufficient on its own, so unknown parameters are refused outright
 * rather than ignored.
 *
 * ─── REDACTION ───────────────────────────────────────────────────────────────
 *
 * No failure message ever contains the connection string, the userinfo section,
 * a password, or any query-parameter VALUE. Offending parameters are named by
 * key only, because the value is exactly where a credential would sit
 * (`?password=…`). What a message may contain is the host, the port, and the
 * database name — the three facts an operator needs to understand the refusal,
 * and the same three `owner-reset.ts` already considers safe to print.
 *
 * This module performs no I/O and reads no environment of its own, so the whole
 * safety matrix is testable without a PostgreSQL server.
 */

// ─── Policy constants ────────────────────────────────────────────────────────

/** The one database automated tests may write to. */
export const TEST_DATABASE_NAME = "dripjar_test";

/**
 * Databases permitted under `NODE_ENV=test`, as an exact-match allowlist.
 *
 * Deliberately a list of literals rather than a suffix rule — see the header.
 */
export const TEST_APPROVED_DATABASES: readonly string[] = [TEST_DATABASE_NAME];

/**
 * Hosts considered loopback.
 *
 * Compared after normalisation: WHATWG `URL` lowercases the hostname and keeps
 * IPv6 literals bracketed (`[::1]`), so brackets are stripped before the check.
 */
export const TEST_LOOPBACK_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "::1"];

/** Connection schemes PostgreSQL DSNs may legitimately use. */
export const TEST_APPROVED_PROTOCOLS: readonly string[] = ["postgresql:", "postgres:"];

/**
 * Query parameters that cannot redirect a connection or weaken the
 * local-only guarantee.
 *
 * An allowlist, not a denylist: libpq accepts a long and growing set of
 * connection keywords, and a denylist silently fails open the moment a new
 * redirect-capable one appears. Anything not named here is refused.
 */
export const TEST_APPROVED_QUERY_PARAMS: readonly string[] = [
  "application_name",
  "connect_timeout",
  "sslmode",
];

/**
 * Substrings that mark a database name as production-like.
 *
 * These names are already refused by the allowlist above; this list exists only
 * so the operator gets "that looks like production" instead of the generic
 * "not on the allowlist". Over-matching here is harmless.
 */
const PRODUCTION_LIKE_FRAGMENTS: readonly string[] = [
  "prod",
  "production",
  "live",
  "release",
  "staging",
];

// ─── Result types ────────────────────────────────────────────────────────────

export type TestDbGuardFailureCode =
  | "MISSING_DATABASE_URL"
  | "MALFORMED_URL"
  | "UNSUPPORTED_PROTOCOL"
  | "NON_LOOPBACK_HOST"
  | "MISSING_DATABASE_NAME"
  | "AMBIGUOUS_DATABASE_PATH"
  | "PRODUCTION_LIKE_NAME"
  | "DATABASE_NOT_ALLOWED"
  | "UNSAFE_CONNECTION_PARAMETER";

/** Non-secret description of a connection target. Safe to print. */
export interface TestDbTarget {
  host: string;
  port: string;
  database: string;
}

export interface TestDbGuardFailure {
  code: TestDbGuardFailureCode;
  /** Redacted, operator-facing explanation. Never contains a credential. */
  message: string;
}

export type TestDbGuardResult =
  | { ok: true; target: TestDbTarget }
  | { ok: false; failure: TestDbGuardFailure };

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Strip the brackets WHATWG `URL` puts around IPv6 literals, so `[::1]`
 * compares equal to the `::1` an operator would write in a config file.
 */
function normaliseHost(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

/**
 * True when a decoded database name contains anything that makes it ambiguous:
 * whitespace, an ASCII control character, or DEL.
 *
 * Written as a code-point scan rather than a regex literal so no control
 * character has to appear in this source file.
 */
function hasUnsafeNameChar(name: string): boolean {
  for (const ch of name) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) return true;
    if (/\s/.test(ch)) return true;
  }
  return false;
}

/**
 * Validate a connection string against the test-mode policy.
 *
 * Pure: no environment access, no I/O, no side effects. `assertTestDatabaseUrl`
 * decides *whether* to apply this; this function decides only *what passes*.
 */
export function validateTestDatabaseUrl(
  databaseUrl: string | undefined | null,
): TestDbGuardResult {
  const fail = (code: TestDbGuardFailureCode, message: string): TestDbGuardResult => ({
    ok: false,
    failure: { code, message },
  });

  if (!databaseUrl) {
    return fail(
      "MISSING_DATABASE_URL",
      `DATABASE_URL is not set. Tests must point at the local "${TEST_DATABASE_NAME}" database.`,
    );
  }

  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    // Never echo the input — it is the one string guaranteed to carry a password.
    return fail(
      "MALFORMED_URL",
      "DATABASE_URL could not be parsed as a URL. Multi-host DSNs and libpq " +
        "key/value strings are not supported in test mode.",
    );
  }

  if (!TEST_APPROVED_PROTOCOLS.includes(url.protocol)) {
    return fail(
      "UNSUPPORTED_PROTOCOL",
      `Refusing to connect with scheme "${url.protocol}". ` +
        `Expected one of: ${TEST_APPROVED_PROTOCOLS.join(", ")}.`,
    );
  }

  // ── Redirect-capable parameters ───────────────────────────────────────────
  //
  // Checked before host and database, because a parameter like `hostaddr` makes
  // those two fields meaningless. Keys are named; values never are.
  const offendingParams: string[] = [];
  for (const key of url.searchParams.keys()) {
    if (!TEST_APPROVED_QUERY_PARAMS.includes(key.toLowerCase())) {
      if (!offendingParams.includes(key)) offendingParams.push(key);
    }
  }
  if (offendingParams.length > 0) {
    return fail(
      "UNSAFE_CONNECTION_PARAMETER",
      `Refusing DATABASE_URL carrying unsupported connection parameter(s): ` +
        `${offendingParams.join(", ")}. Parameters such as host, hostaddr, dbname ` +
        `and service override the rest of the URL and would defeat the ` +
        `local-only guarantee. Allowed: ${TEST_APPROVED_QUERY_PARAMS.join(", ")}.`,
    );
  }

  const host = normaliseHost(url.hostname);
  if (!TEST_LOOPBACK_HOSTS.includes(host)) {
    return fail(
      "NON_LOOPBACK_HOST",
      `Refusing to connect to non-loopback host "${host}" in test mode. ` +
        `Allowed: ${TEST_LOOPBACK_HOSTS.join(", ")}.`,
    );
  }

  // ── Database name ─────────────────────────────────────────────────────────
  const rawPath = url.pathname.replace(/^\//, "");
  if (rawPath === "") {
    return fail(
      "MISSING_DATABASE_NAME",
      `DATABASE_URL names no database. Expected "${TEST_DATABASE_NAME}".`,
    );
  }

  let database: string;
  try {
    database = decodeURIComponent(rawPath);
  } catch {
    return fail(
      "AMBIGUOUS_DATABASE_PATH",
      "The database name in DATABASE_URL is not valid percent-encoding.",
    );
  }

  // A well-formed PostgreSQL DSN has exactly one path segment naming one
  // database. Extra segments, whitespace, or control characters (a NUL smuggled
  // in as %00, say) make it ambiguous which database is actually addressed.
  if (database.includes("/") || hasUnsafeNameChar(database)) {
    return fail(
      "AMBIGUOUS_DATABASE_PATH",
      "DATABASE_URL does not name exactly one database. " +
        `Expected a single path segment: "/${TEST_DATABASE_NAME}".`,
    );
  }

  const lowered = database.toLowerCase();
  if (
    !TEST_APPROVED_DATABASES.includes(database) &&
    PRODUCTION_LIKE_FRAGMENTS.some((fragment) => lowered.includes(fragment))
  ) {
    return fail(
      "PRODUCTION_LIKE_NAME",
      `Refusing to run tests against "${database}" — the name looks like a ` +
        `production or shared environment. Tests may only use "${TEST_DATABASE_NAME}".`,
    );
  }

  if (!TEST_APPROVED_DATABASES.includes(database)) {
    return fail(
      "DATABASE_NOT_ALLOWED",
      `Refusing to run tests against database "${database}". ` +
        `Tests may only use "${TEST_DATABASE_NAME}". ` +
        `Run the suite through "pnpm test:clean" (or "pnpm test:keep"), which ` +
        `provisions and points at a disposable local test database.`,
    );
  }

  return {
    ok: true,
    target: { host, port: url.port || "5432", database },
  };
}

// ─── Enforcement ─────────────────────────────────────────────────────────────

/** Prefix every refusal carries, so the cause is unmistakable in a stack trace. */
export const TEST_DB_GUARD_ERROR_PREFIX = "[TEST-DB-GUARD]";

/**
 * Apply the test-mode policy, throwing on refusal.
 *
 * Inert unless `nodeEnv === "test"`: development and production callers return
 * immediately, so no existing connection behaviour changes.
 *
 * @throws Error with a redacted message when the URL is not an approved local
 *         test target.
 */
export function assertTestDatabaseUrl(
  databaseUrl: string | undefined | null,
  nodeEnv: string | undefined,
): void {
  if (nodeEnv !== "test") return;

  const result = validateTestDatabaseUrl(databaseUrl);
  if (result.ok) return;

  throw new Error(
    `${TEST_DB_GUARD_ERROR_PREFIX} ${result.failure.code}: ${result.failure.message}`,
  );
}

/**
 * Format a validated target for logging.
 *
 * Exists so callers have an obvious safe alternative to interpolating the
 * connection string when they want to say where they connected.
 */
export function describeTestDbTarget(target: TestDbTarget): string {
  return `${target.database} @ ${target.host}:${target.port}`;
}
