import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";
import { assertTestDatabaseUrl } from "./test-db-guard";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

/**
 * Fail closed before the pool exists.
 *
 * Under `NODE_ENV=test` this refuses anything that is not the local disposable
 * `dripjar_test` database — `dripjar_dev`, a remote host, or a URL carrying a
 * redirect-capable connection parameter. It throws here, at module evaluation,
 * so a misdirected test process dies before a socket is opened rather than
 * after it has written its first row.
 *
 * Inert for every other NODE_ENV, so development and production connection
 * behaviour is unchanged. See `test-db-guard.ts`.
 */
assertTestDatabaseUrl(process.env.DATABASE_URL, process.env.NODE_ENV);

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });

export * from "./schema";
export * from "./test-db-guard";
