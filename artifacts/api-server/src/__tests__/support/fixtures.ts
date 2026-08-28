/**
 * Shared synthetic-fixture hygiene for the API integration suite.
 *
 * ─── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * Vitest runs test files in parallel (`fileParallelism` defaults to true), so
 * every file writes to the same `dripjar_test` database at the same time. A
 * file that asserts on whole-table state, or that leaves its rows behind, is
 * not testing its own behaviour — it is testing whatever else happened to be
 * running. The fix is per-file ownership: every fixture carries a tag unique to
 * the file and the run, assertions are scoped to tagged rows, and teardown
 * removes exactly the tagged rows and nothing else.
 *
 * ─── OWNERSHIP IS RESOLVED BY QUERY, NOT BY BOOKKEEPING ──────────────────────
 *
 * Teardown finds fixtures by querying for the tag, never from ids a setup
 * helper returned. A helper that throws half-way through has still created
 * rows, and that is precisely when cleanup matters most — so cleanup must not
 * depend on setup having succeeded. The tag is fixed at module scope, before
 * any fixture exists, which is what makes that possible.
 *
 * ─── THIS IS NOT A SECOND CLEANUP SYSTEM ─────────────────────────────────────
 *
 * The delete itself is delegated to `purgeSyntheticAccounts` in
 * `lib/owner-reset.ts` — the one hand-written, FK-graph-derived delete order in
 * the repository. This module adds tag discovery and the guards that decide
 * *which* accounts may be handed to it. It issues no DELETE of its own.
 *
 * ─── WHAT CLEANUP WILL NOT DO ────────────────────────────────────────────────
 *
 *   - No wildcard. A bare `%@test.invalid` is refused; the pattern must carry
 *     a tag long enough that it cannot collide by accident.
 *   - No untagged row. Every discovered address is re-checked against the tag
 *     suffix before it is passed on, so a LIKE pattern that somehow widened
 *     cannot take anything extra with it.
 *   - No owner QA account. The seeded `@dripjar.dev` addresses are refused by
 *     name even if a tag were contrived to match one.
 *   - No TRUNCATE, no schema reset, no session termination, no whole-table
 *     delete. Removal happens one account at a time through the guarded purge.
 */

import { expect } from "vitest";
import { pool } from "@workspace/db";
import { APPROVED_SYNTHETIC_EMAILS, purgeSyntheticAccounts } from "../../lib/owner-reset.js";

// ─── Tagging ─────────────────────────────────────────────────────────────────

/** Domain every synthetic fixture address uses. Never a deliverable domain. */
export const FIXTURE_EMAIL_DOMAIN = "test.invalid";

/**
 * A tag must be long enough that its LIKE pattern cannot collide with another
 * file's addresses, and lowercase alphanumeric so it needs no escaping inside a
 * LIKE pattern — no `%`, `_`, or backslash can appear in one.
 */
const TAG_RE = /^[a-z][a-z0-9]{11,39}$/;

export interface FixtureTag {
  /** The raw tag. Unique per file, per run. */
  readonly tag: string;
  /** LIKE pattern matching exactly this file's synthetic accounts. */
  readonly emailLike: string;
  /** LIKE pattern matching exactly this file's named rows (jars, goals, …). */
  readonly nameLike: string;
  /** A fresh tagged address, unique within the file. */
  email(suffix: string): string;
  /** A tagged display name, so jars and goals are attributable too. */
  name(base: string): string;
}

/**
 * Build the tag for one test file. Call once at module scope.
 *
 * `prefix` identifies the file in a `psql` session when a run is preserved with
 * `pnpm test:keep`; the entropy after it is what makes the tag unique per run,
 * so fixtures left by an earlier preserved run can never be mistaken for this
 * run's own.
 */
export function createFixtureTag(prefix: string): FixtureTag {
  if (!/^[a-z][a-z0-9]{1,9}$/.test(prefix)) {
    throw new Error(
      `[FIXTURE-TAG] prefix "${prefix}" must be 2-10 lowercase alphanumerics ` +
        `starting with a letter.`,
    );
  }

  const entropy = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    .replace(/[^a-z0-9]/g, "");
  const tag = `${prefix}${entropy}`;

  if (!TAG_RE.test(tag)) {
    throw new Error(`[FIXTURE-TAG] generated tag "${tag}" is not LIKE-safe.`);
  }

  let counter = 0;

  return {
    tag,
    emailLike: `%-${tag}@${FIXTURE_EMAIL_DOMAIN}`,
    nameLike: `%${tag}%`,
    email(suffix: string) {
      const clean = suffix.replace(/[^a-zA-Z0-9]/g, "") || "user";
      return `${clean}${++counter}-${tag}@${FIXTURE_EMAIL_DOMAIN}`;
    },
    name(base: string) {
      return `${base} ${tag} ${++counter}`;
    },
  };
}

// ─── Guards ──────────────────────────────────────────────────────────────────

export type CleanupRefusal = "MALFORMED_TAG" | "UNTAGGED_EMAIL" | "OWNER_ACCOUNT";

export class FixtureCleanupRefused extends Error {
  constructor(readonly code: CleanupRefusal, message: string) {
    super(`[FIXTURE-CLEANUP:${code}] ${message}`);
    this.name = "FixtureCleanupRefused";
  }
}

/**
 * Every rule that decides whether a set of addresses may be deleted, as one
 * pure function so the guards can be exercised without a database.
 *
 * Note the shape: the caller supplies the addresses a LIKE query returned, and
 * this re-derives whether each one genuinely belongs to the tag. The pattern is
 * not trusted to have been correct — its results are checked.
 */
export function checkCleanupTargets(
  tag: string,
  emails: readonly string[],
): { ok: true } | { ok: false; refusal: FixtureCleanupRefused } {
  const refuse = (code: CleanupRefusal, message: string) =>
    ({ ok: false as const, refusal: new FixtureCleanupRefused(code, message) });

  if (!TAG_RE.test(tag)) {
    return refuse(
      "MALFORMED_TAG",
      `"${tag}" is not a valid fixture tag. A wildcard or short tag could match ` +
        `accounts this file does not own, so it is refused before any query runs.`,
    );
  }

  const suffix = `-${tag}@${FIXTURE_EMAIL_DOMAIN}`;
  const owners = new Set<string>(APPROVED_SYNTHETIC_EMAILS);

  for (const email of emails) {
    if (owners.has(email)) {
      return refuse(
        "OWNER_ACCOUNT",
        `"${email}" is a seeded owner QA account. Test cleanup never removes one.`,
      );
    }
    if (!email.endsWith(suffix)) {
      return refuse(
        "UNTAGGED_EMAIL",
        `"${email}" does not carry tag "${tag}". Cleanup removes only rows this ` +
          `file created.`,
      );
    }
  }

  return { ok: true };
}

// ─── Mutual exclusion between global sweeps and fixture deletion ─────────────

/**
 * Advisory-lock key shared by fixture teardown and any test that drives an
 * endpoint which scans the whole database.
 *
 * ─── THE RACE THIS CLOSES ────────────────────────────────────────────────────
 *
 * `POST /api/internal/process-reminders` is global by design: one call reads
 * every active schedule and every Saving jar, then inserts a
 * `reminder_sent_events` row per eligible reminder. Between the read and the
 * insert, another file's teardown can delete the user or jar the processor is
 * mid-way through handling, and the insert fails on
 * `reminder_sent_events_user_id_fkey` (SQLSTATE 23503) rather than on the
 * unique-key conflict the surrounding code is written to expect — surfacing as
 * a 500 and a failed run roughly two times in three. Verified by instrumenting
 * the failing insert during the Phase M2 audit.
 *
 * ─── WHY THE FIX IS HERE AND NOT IN THE PROCESSOR ────────────────────────────
 *
 * Nothing in production deletes a user or a jar. There is no account-deletion
 * endpoint and deliberately no jar-delete endpoint (see lib/owner-reset.ts), so
 * the only writer that can remove a row out from under the processor is test
 * teardown. The fragility is real but unreachable outside this suite, which
 * makes it the suite's problem to serialise — not a reason to change the
 * reminder processor, whose logic is out of scope for M2 and is the subject of
 * M3.
 *
 * ─── WHAT THIS IS NOT ────────────────────────────────────────────────────────
 *
 * This is not suite serialisation. It excludes exactly two operations from
 * overlapping — deleting fixtures, and running a whole-database sweep — and
 * only one file drives such a sweep. Every other file continues to run fully
 * parallel with every other file, including with both of these.
 */
const GLOBAL_SWEEP_LOCK_KEY = 906_112_001;

/**
 * Run `fn` while holding the exclusive sweep lock.
 *
 * The lock is session-scoped, and a pooled client *is* the session, so the
 * client is held for the whole call and released only after the unlock. It is
 * never nested: teardown takes it inside `purgeTaggedFixtures`, and a test
 * takes it around the sweep itself.
 */
export async function withGlobalSweepExclusion<T>(fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [GLOBAL_SWEEP_LOCK_KEY]);
    try {
      return await fn();
    } finally {
      await client.query("select pg_advisory_unlock($1)", [GLOBAL_SWEEP_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

const countOf = async (sql: string, params: unknown[] = []) =>
  Number((await pool.query(sql, params)).rows[0].c);

/**
 * Remove every account carrying `tag`, and everything those accounts own.
 *
 * Idempotent: a second call finds nothing and returns 0 without writing.
 * Safe after a partial setup: accounts are discovered by query, so a fixture
 * abandoned half-built is still found and removed.
 *
 * Returns the number of accounts removed.
 */
export async function purgeTaggedFixtures(fixtures: FixtureTag): Promise<number> {
  const { tag, emailLike } = fixtures;

  // Refuse a malformed tag before the query, not after — a bad pattern must
  // never reach the database at all.
  const preflight = checkCleanupTargets(tag, []);
  if (!preflight.ok) throw preflight.refusal;

  const emails = (
    await pool.query(`select email from users where email like $1 order by email`, [emailLike])
  ).rows.map((r) => r.email as string);

  if (emails.length === 0) return 0;

  const verdict = checkCleanupTargets(tag, emails);
  if (!verdict.ok) throw verdict.refusal;

  // `approvedEmails` is the discovered set itself: the purge is authorised for
  // exactly these addresses and nothing wider, and it re-runs the owner-reset
  // guards (non-production, loopback host, approved database) on every one.
  //
  // Held under the sweep lock so the deletes cannot land inside a global scan
  // that is already holding ids for these rows. See GLOBAL_SWEEP_LOCK_KEY.
  await withGlobalSweepExclusion(() =>
    purgeSyntheticAccounts(emails, { approvedEmails: emails, quiet: true }),
  );
  return emails.length;
}

/** Assert this file left nothing tagged behind. Call after `purgeTaggedFixtures`. */
export async function expectTaggedFixturesRemoved(fixtures: FixtureTag): Promise<void> {
  expect(
    await countOf(`select count(*)::int c from users where email like $1`, [fixtures.emailLike]),
    `tagged users survived cleanup (tag ${fixtures.tag})`,
  ).toBe(0);
  expect(
    await countOf(`select count(*)::int c from jars where name like $1`, [fixtures.nameLike]),
    `tagged jars survived cleanup (tag ${fixtures.tag})`,
  ).toBe(0);
}

// ─── Orphan accounting ───────────────────────────────────────────────────────

/**
 * Rows whose parent is gone. A correct teardown adds none, and this is the one
 * whole-table measurement that stays valid under concurrency: the baseline is
 * captured before the file runs and only the *delta* is asserted. Rows other
 * files leave behind are preserved rather than "cleaned up" — this file answers
 * for its own delta and nothing else.
 */
const ORPHAN_SQL = {
  ledgerEntries: `select count(*)::int c from ledger_entries le
                    left join ledger_transactions lt on lt.id = le.ledger_transaction_id
                   where lt.id is null`,
  ledgerTransactions: `select count(*)::int c from ledger_transactions lt
                    left join financial_transactions ft on ft.id = lt.financial_transaction_id
                   where ft.id is null`,
  financialTransactions: `select count(*)::int c from financial_transactions ft
                    left join jars j on j.id = ft.jar_id where j.id is null`,
  notifications: `select count(*)::int c from notifications n
                    left join users u on u.id = n.user_id where u.id is null`,
  reminderEvents: `select count(*)::int c from reminder_sent_events r
                    left join users u on u.id = r.user_id where u.id is null`,
} as const;

export type OrphanBaseline = Record<keyof typeof ORPHAN_SQL, number>;

export async function captureOrphanBaseline(): Promise<OrphanBaseline> {
  const out = {} as OrphanBaseline;
  for (const key of Object.keys(ORPHAN_SQL) as (keyof typeof ORPHAN_SQL)[]) {
    out[key] = await countOf(ORPHAN_SQL[key]);
  }
  return out;
}

export async function expectNoNewOrphans(baseline: OrphanBaseline): Promise<void> {
  for (const key of Object.keys(ORPHAN_SQL) as (keyof typeof ORPHAN_SQL)[]) {
    expect(await countOf(ORPHAN_SQL[key]), `${key} orphans increased`).toBe(baseline[key]);
  }
}

// ─── Teardown wrapper ────────────────────────────────────────────────────────

/**
 * Run teardown so a cleanup failure is reported clearly and never masks the
 * test failure that preceded it.
 *
 * Vitest records a failing `afterAll` separately from failing tests, so an
 * earlier failure survives on its own. What this adds is legibility: a throw
 * from here is unambiguously a cleanup problem, and `restore` still runs even
 * when the purge throws, so leaked mocks and environment variables cannot
 * follow this file into the next one sharing the worker.
 */
export async function teardownFixtures(
  fixtures: FixtureTag,
  opts: { baseline?: OrphanBaseline; restore?: () => void } = {},
): Promise<void> {
  try {
    await purgeTaggedFixtures(fixtures);
    await expectTaggedFixturesRemoved(fixtures);
    if (opts.baseline) await expectNoNewOrphans(opts.baseline);
  } catch (err) {
    throw new Error(
      `[FIXTURE-CLEANUP] teardown failed for tag "${fixtures.tag}". Any test ` +
        `failure reported above this one is the original failure and is ` +
        `unrelated to cleanup.\n  cause: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  } finally {
    opts.restore?.();
  }
}
