/**
 * M1 — safety matrix for the test-mode database guard.
 *
 * The guard's whole job is to make it impossible for a test process to reach
 * `dripjar_dev`, a production database, or a remote host. That property is only
 * worth as much as its proof, so every rejection path is exercised here.
 *
 * `validateTestDatabaseUrl` performs no I/O and reads no environment, so all of
 * PART A runs without a PostgreSQL server. PART D spawns the lifecycle script,
 * which refuses before it opens a connection — nothing here ever connects to
 * anything, and in particular nothing here touches `dripjar_dev`.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateTestDatabaseUrl,
  assertTestDatabaseUrl,
  describeTestDbTarget,
  TEST_DATABASE_NAME,
  TEST_APPROVED_DATABASES,
  TEST_LOOPBACK_HOSTS,
  TEST_DB_GUARD_ERROR_PREFIX,
} from "@workspace/db/test-db-guard";
import { APPROVED_DATABASES, LOCAL_HOSTS } from "../lib/owner-reset.js";
import globalSetup from "./support/db-global-setup.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/** A password that must never appear in any message the guard produces. */
const SECRET = "sup3rs3cr3t-pgpassword";

// ─── PART A — validation matrix (no database, no environment) ────────────────

describe("PART A — validateTestDatabaseUrl accepts only the local test database", () => {
  it("accepts the exact loopback dripjar_test target", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      const r = validateTestDatabaseUrl(
        `postgresql://dripjar_dev@${host}:5432/${TEST_DATABASE_NAME}`,
      );
      expect(r.ok, `host ${host} should be accepted`).toBe(true);
      if (r.ok) {
        expect(TEST_LOOPBACK_HOSTS).toContain(r.target.host);
        expect(r.target.database).toBe(TEST_DATABASE_NAME);
      }
    }
  });

  it("accepts postgres: as well as postgresql:, and defaults the port", () => {
    const r = validateTestDatabaseUrl(`postgres://u@localhost/${TEST_DATABASE_NAME}`);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.target.port).toBe("5432");
  });

  it("REFUSES dripjar_dev — the owner QA database", () => {
    const r = validateTestDatabaseUrl("postgresql://dripjar_dev@localhost:5432/dripjar_dev");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.code).toBe("DATABASE_NOT_ALLOWED");
      expect(r.failure.message).toContain("dripjar_dev");
      expect(r.failure.message).toContain("test:clean");
    }
  });

  it("REFUSES production-like database names with a distinct code", () => {
    for (const name of ["dripjar_prod", "dripjar_production", "dripjar_live", "dripjar_staging"]) {
      const r = validateTestDatabaseUrl(`postgresql://u@localhost/${name}`);
      expect(r.ok, `${name} must be refused`).toBe(false);
      if (!r.ok) expect(r.failure.code, name).toBe("PRODUCTION_LIKE_NAME");
    }
  });

  it("REFUSES remote hosts, including ones whose name merely looks local", () => {
    for (const host of ["db.example.com", "10.0.0.5", "127.0.0.2", "localhost.evil.com"]) {
      const r = validateTestDatabaseUrl(`postgresql://u@${host}/${TEST_DATABASE_NAME}`);
      expect(r.ok, `${host} must be refused`).toBe(false);
      if (!r.ok) expect(r.failure.code, host).toBe("NON_LOOPBACK_HOST");
    }
  });

  it("REFUSES query parameters that could redirect the connection", () => {
    // hostaddr is the sharp one: the URL reads as local and connects elsewhere.
    for (const q of [
      "hostaddr=10.0.0.5",
      "host=/var/run/postgresql",
      "dbname=dripjar_dev",
      "service=production",
      "options=-c%20search_path%3Devil",
    ]) {
      const r = validateTestDatabaseUrl(
        `postgresql://u@localhost/${TEST_DATABASE_NAME}?${q}`,
      );
      expect(r.ok, `?${q} must be refused`).toBe(false);
      if (!r.ok) expect(r.failure.code, q).toBe("UNSAFE_CONNECTION_PARAMETER");
    }
  });

  it("allows the small set of parameters that cannot redirect a connection", () => {
    const r = validateTestDatabaseUrl(
      `postgresql://u@localhost/${TEST_DATABASE_NAME}?application_name=vitest&connect_timeout=5&sslmode=disable`,
    );
    expect(r.ok).toBe(true);
  });

  it("REFUSES malformed, ambiguous, and non-PostgreSQL URLs", () => {
    const cases: [string | undefined, string][] = [
      [undefined, "MISSING_DATABASE_URL"],
      ["", "MISSING_DATABASE_URL"],
      ["not-a-url", "MALFORMED_URL"],
      // libpq multi-host DSN — Node's URL parser rejects the authority outright.
      ["postgresql://u@h1:5432,h2:5432/dripjar_test", "MALFORMED_URL"],
      ["mysql://u@localhost/dripjar_test", "UNSUPPORTED_PROTOCOL"],
      ["http://localhost/dripjar_test", "UNSUPPORTED_PROTOCOL"],
      ["postgresql://u@localhost/", "MISSING_DATABASE_NAME"],
      ["postgresql://u@localhost/a/b", "AMBIGUOUS_DATABASE_PATH"],
      // A NUL smuggled in as %00 must not slip past an exact-match comparison.
      ["postgresql://u@localhost/dripjar_test%00x", "AMBIGUOUS_DATABASE_PATH"],
    ];
    for (const [url, code] of cases) {
      const r = validateTestDatabaseUrl(url);
      expect(r.ok, `${String(url)} must be refused`).toBe(false);
      if (!r.ok) expect(r.failure.code, String(url)).toBe(code);
    }
  });

  it("REFUSES a case-variant of the allowed name (exact match, not fuzzy)", () => {
    const r = validateTestDatabaseUrl("postgresql://u@localhost/DRIPJAR_TEST");
    expect(r.ok).toBe(false);
  });

  it("uses an exact allowlist, not a _test suffix rule", () => {
    expect(TEST_APPROVED_DATABASES).toEqual([TEST_DATABASE_NAME]);
    for (const name of ["customer_test", "dripjar_test_2", "acme_test"]) {
      expect(validateTestDatabaseUrl(`postgresql://u@localhost/${name}`).ok).toBe(false);
    }
  });
});

// ─── PART B — redaction ──────────────────────────────────────────────────────

describe("PART B — refusals never leak a credential", () => {
  const hostile = [
    `postgresql://admin:${SECRET}@db.prod.example.com:5432/dripjar_production`,
    `postgresql://admin:${SECRET}@localhost/dripjar_dev`,
    `postgresql://admin:${SECRET}@localhost/dripjar_test?password=${SECRET}`,
    `postgres://admin:${SECRET}@localhost/dripjar_test?hostaddr=10.0.0.5`,
    `://admin:${SECRET}@broken`,
  ];

  it("no failure message contains the password, userinfo, or the full URL", () => {
    for (const url of hostile) {
      const r = validateTestDatabaseUrl(url);
      expect(r.ok, `${url.replace(SECRET, "***")} must be refused`).toBe(false);
      if (!r.ok) {
        expect(r.failure.message).not.toContain(SECRET);
        expect(r.failure.message).not.toContain("admin:");
        expect(r.failure.message).not.toContain(url);
        expect(r.failure.message).not.toContain("://");
      }
    }
  });

  it("thrown errors are redacted too, and name the failure code", () => {
    for (const url of hostile) {
      let caught: Error | undefined;
      try {
        assertTestDatabaseUrl(url, "test");
      } catch (e) {
        caught = e as Error;
      }
      expect(caught, "guard must throw under NODE_ENV=test").toBeDefined();
      expect(caught!.message).toContain(TEST_DB_GUARD_ERROR_PREFIX);
      expect(caught!.message).not.toContain(SECRET);
      expect(caught!.message).not.toContain("://");
    }
  });

  it("the safe target descriptor carries no credential", () => {
    const r = validateTestDatabaseUrl(
      `postgresql://admin:${SECRET}@localhost:5432/${TEST_DATABASE_NAME}`,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const d = describeTestDbTarget(r.target);
      expect(d).toBe(`${TEST_DATABASE_NAME} @ localhost:5432`);
      expect(d).not.toContain(SECRET);
      expect(d).not.toContain("admin");
    }
  });
});

// ─── PART C — the guard is inert outside test mode ───────────────────────────

describe("PART C — non-test environments keep their existing behaviour", () => {
  it("does not throw for any NODE_ENV other than 'test', whatever the URL", () => {
    const urls = [
      "postgresql://u@db.prod.example.com/dripjar_production",
      "postgresql://u@localhost/dripjar_dev",
      "not-a-url",
      undefined,
    ];
    for (const env of ["production", "development", "staging", undefined]) {
      for (const url of urls) {
        expect(
          () => assertTestDatabaseUrl(url, env),
          `NODE_ENV=${String(env)} url=${String(url)} must be inert`,
        ).not.toThrow();
      }
    }
  });

  it("throws under NODE_ENV=test for the same URLs it ignores elsewhere", () => {
    expect(() =>
      assertTestDatabaseUrl("postgresql://u@localhost/dripjar_dev", "test"),
    ).toThrow(/DATABASE_NOT_ALLOWED/);
  });

  it("accepts the approved target under NODE_ENV=test", () => {
    expect(() =>
      assertTestDatabaseUrl(`postgresql://u@localhost/${TEST_DATABASE_NAME}`, "test"),
    ).not.toThrow();
  });
});

// ─── PART D — vitest refuses to start against the wrong database ─────────────

describe("PART D — vitest global setup is wired and fails closed", () => {
  /** Run globalSetup against a synthetic environment, restoring afterwards. */
  function withEnv(env: Record<string, string | undefined>, fn: () => void) {
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(env)) {
      saved[k] = process.env[k];
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
    try {
      fn();
    } finally {
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  }

  it("REFUSES to start when pointed at dripjar_dev", () => {
    withEnv(
      { NODE_ENV: "test", DATABASE_URL: `postgresql://u:${SECRET}@localhost/dripjar_dev` },
      () => {
        let caught: Error | undefined;
        try {
          globalSetup();
        } catch (e) {
          caught = e as Error;
        }
        expect(caught, "globalSetup must refuse dripjar_dev").toBeDefined();
        expect(caught!.message).toContain("DATABASE_NOT_ALLOWED");
        expect(caught!.message).not.toContain(SECRET);
      },
    );
  });

  it("REFUSES to start when NODE_ENV is not 'test' (guard would be inert)", () => {
    withEnv(
      {
        NODE_ENV: "development",
        DATABASE_URL: `postgresql://u@localhost/${TEST_DATABASE_NAME}`,
      },
      () => {
        expect(() => globalSetup()).toThrow(/NODE_ENV/);
      },
    );
  });

  it("REFUSES a remote host", () => {
    withEnv(
      {
        NODE_ENV: "test",
        DATABASE_URL: `postgresql://u@db.example.com/${TEST_DATABASE_NAME}`,
      },
      () => {
        expect(() => globalSetup()).toThrow(/NON_LOOPBACK_HOST/);
      },
    );
  });

  it("accepts the provisioned local test database", () => {
    withEnv(
      {
        NODE_ENV: "test",
        DATABASE_URL: `postgresql://u@localhost:5432/${TEST_DATABASE_NAME}`,
      },
      () => {
        expect(() => globalSetup()).not.toThrow();
      },
    );
  });

  it("both vitest configs actually wire the global setup", () => {
    for (const config of ["vitest.config.ts", "vitest.rate-limits.config.ts"]) {
      const src = readFileSync(join(REPO_ROOT, "artifacts/api-server", config), "utf8");
      expect(src, config).toContain("globalSetup");
      expect(src, config).toContain("support/db-global-setup.ts");
    }
  });
});

// ─── PART E — the lifecycle script cannot target anything else ───────────────

describe("PART E — scripts/test-db.mjs is pinned to dripjar_test", () => {
  /**
   * Spawn the lifecycle script with a hostile identity. Every case below is
   * refused during argument/URL validation, before any connection is opened,
   * so no database is contacted by these tests.
   */
  function runScript(databaseUrl: string | undefined, args: string[] = ["drop"]) {
    const env = { ...process.env, NODE_ENV: "development" } as Record<string, string>;
    if (databaseUrl === undefined) delete env["DATABASE_URL"];
    else env["DATABASE_URL"] = databaseUrl;
    return spawnSync(process.execPath, [join(REPO_ROOT, "scripts/test-db.mjs"), ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 30_000,
      env,
    });
  }

  it("refuses a remote source identity without connecting", () => {
    const r = runScript(`postgresql://u:${SECRET}@db.prod.example.com/dripjar_dev`);
    expect(r.status).not.toBe(0);
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    expect(out).toContain("TEST-DB REFUSED");
    expect(out).toContain("non-loopback");
    expect(out).not.toContain(SECRET);
  });

  it("refuses an unparseable identity without echoing it", () => {
    const r = runScript("this-is-not-a-url");
    expect(r.status).not.toBe(0);
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    expect(out).toContain("TEST-DB REFUSED");
    expect(out).not.toContain("this-is-not-a-url");
  });

  it("refuses when no identity is available", () => {
    const r = runScript(undefined);
    expect(r.status).not.toBe(0);
    expect(`${r.stdout ?? ""}${r.stderr ?? ""}`).toContain("TEST-DB REFUSED");
  });

  it("refuses an unknown subcommand rather than guessing", () => {
    const r = runScript(process.env["DATABASE_URL"], ["obliterate"]);
    expect(r.status).not.toBe(0);
    expect(`${r.stdout ?? ""}${r.stderr ?? ""}`).toContain("Unknown command");
  });

  it("exposes no way to name a different database", () => {
    const src = readFileSync(join(REPO_ROOT, "scripts/test-db.mjs"), "utf8");

    // The target is a constant, and it is the only thing interpolated into DDL.
    expect(src).toContain('const TEST_DATABASE_NAME = "dripjar_test"');
    // Prose about DDL is not DDL — only real statements are asserted on.
    const isComment = (l: string) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*");
    };
    for (const ddl of ["CREATE DATABASE", "DROP DATABASE"]) {
      const stmts = src.split("\n").filter((l) => l.includes(ddl) && !isComment(l));
      expect(stmts.length, `${ddl} statements`).toBeGreaterThan(0);
      for (const line of stmts) {
        expect(line, line).toContain("quoteIdent(TEST_DATABASE_NAME)");
      }
    }

    // No argv or env path can redirect the target.
    expect(src).not.toMatch(/TEST_DATABASE_NAME\s*=\s*process\./);
    expect(src).not.toContain("pg_terminate_backend");
    expect(src).toContain("assertSafeTarget");
  });

  it("names dripjar_dev only as a protected, never-modified identity source", () => {
    const src = readFileSync(join(REPO_ROOT, "scripts/test-db.mjs"), "utf8");
    expect(src).toContain("PROTECTED_DATABASES");
    expect(src).toContain('"dripjar_dev"');
    // dripjar_dev must never be the argument to a DDL statement.
    for (const line of src.split("\n")) {
      const t = line.trim();
      if (t.startsWith("*") || t.startsWith("//")) continue;
      if (line.includes("CREATE DATABASE") || line.includes("DROP DATABASE")) {
        expect(line).not.toContain("dripjar_dev");
      }
    }
  });
});

// ─── PART G — the pool guard is wired ahead of pool construction ─────────────

describe("PART G — @workspace/db applies the guard before opening a pool", () => {
  const dbIndex = readFileSync(join(REPO_ROOT, "lib/db/src/index.ts"), "utf8");

  it("calls assertTestDatabaseUrl before constructing the Pool", () => {
    const guardAt = dbIndex.indexOf("assertTestDatabaseUrl(");
    const poolAt = dbIndex.indexOf("new Pool(");
    expect(guardAt, "guard call missing from lib/db/src/index.ts").toBeGreaterThan(-1);
    expect(poolAt, "pool construction missing").toBeGreaterThan(-1);
    // Module scope runs top to bottom: the guard must come first, or a
    // misdirected process opens a socket before it is told not to.
    expect(guardAt).toBeLessThan(poolAt);
  });

  it("passes the live process env, so the guard cannot be told the wrong mode", () => {
    expect(dbIndex).toContain("assertTestDatabaseUrl(process.env.DATABASE_URL, process.env.NODE_ENV)");
  });
});

// ─── PART F — cleanup allowlist compatibility ────────────────────────────────

describe("PART F — synthetic-account cleanup accepts dripjar_test, nothing more", () => {
  it("lists both databases as exact literals", () => {
    expect(APPROVED_DATABASES).toEqual(["dripjar_dev", "dripjar_test"]);
  });

  it("still refuses every other database name", () => {
    for (const name of ["dripjar_prod", "postgres", "customer_test", "dripjar_test_2", ""]) {
      expect(APPROVED_DATABASES.includes(name), name).toBe(false);
    }
  });

  it("did not broaden the host rule", () => {
    expect(LOCAL_HOSTS).toEqual(["localhost", "127.0.0.1", "::1", "[::1]", ""]);
  });
});
