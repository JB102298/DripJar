/**
 * Per-invocation database query accounting for the reminder processor.
 *
 * ─── WHY COUNT QUERIES RATHER THAN TIME ──────────────────────────────────────
 *
 * Wall clock measures the machine; query count measures the algorithm. An N+1
 * loop that issues one statement per Saving jar is slow because it issues one
 * statement per Saving jar, and that is the property a regression test should
 * assert. Timing is kept only as a ceiling, because a run that stays under a
 * fixed statement budget cannot silently reacquire the N+1 shape.
 *
 * ─── HOW IT ATTACHES ─────────────────────────────────────────────────────────
 *
 * `@workspace/db` builds one `pg.Pool` at module scope and drizzle issues every
 * statement through `pool.query`. Wrapping that single method therefore sees
 * every statement the request path runs, in order, without touching the pool's
 * configuration, its size, or the connection each statement lands on.
 *
 * Statements issued on a client checked out with `pool.connect()` do NOT pass
 * through here — that is deliberate. The advisory sweep lock and the fixture
 * purge both use a checked-out client, so neither pollutes a processor budget.
 *
 * ─── CATEGORIES ──────────────────────────────────────────────────────────────
 *
 * The four categories are the ones the M3 budget is stated in:
 *
 *   selection   candidate discovery and enrichment — everything that decides
 *               WHICH reminders are eligible. This is the number that must not
 *               grow with the size of the database.
 *   claim       reminder_sent_events reads, inserts, and the atomic
 *               `email_status := 'sending'` claim. Scales with candidates.
 *   notification in-app notification inserts. One per canonical new event.
 *   emailState  the terminal `email_status` write after a delivery attempt.
 *   activity    activity_events inserts (jar_commitment_phase).
 *
 * Anything unrecognised counts as `selection`, so a new statement can never
 * hide from the budget by being unclassifiable.
 */

import { pool } from "@workspace/db";

export type QueryCategory =
  | "selection"
  | "claim"
  | "notification"
  | "emailState"
  | "activity";

export interface QueryTally {
  total: number;
  selection: number;
  claim: number;
  notification: number;
  emailState: number;
  activity: number;
  /** Every statement seen, in issue order. Kept for diagnosis, not assertions. */
  statements: string[];
}

function emptyTally(): QueryTally {
  return {
    total: 0,
    selection: 0,
    claim: 0,
    notification: 0,
    emailState: 0,
    activity: 0,
    statements: [],
  };
}

/** Extract the SQL text from either `query(text, values)` or `query(config)`. */
function sqlTextOf(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg && typeof arg === "object" && "text" in arg) {
    const t = (arg as { text?: unknown }).text;
    if (typeof t === "string") return t;
  }
  return "";
}

export function classify(sql: string): QueryCategory {
  const s = sql.toLowerCase();

  if (s.includes("reminder_sent_events")) {
    if (s.startsWith("update")) {
      // The atomic email claim is the only reminder update that touches the
      // attempt counter; the finalising write sets the terminal status alone.
      return s.includes("email_attempt_count") ? "claim" : "emailState";
    }
    return "claim";
  }
  if (s.includes("notifications")) return "notification";
  if (s.includes("activity_events")) return "activity";
  return "selection";
}

/**
 * Count every statement `fn` issues through the shared pool.
 *
 * The original `query` is restored in a `finally`, so a throwing body cannot
 * leave the pool wrapped for the rest of the file.
 */
export async function countQueries<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; tally: QueryTally }> {
  const tally = emptyTally();
  const original = pool.query.bind(pool) as (...args: unknown[]) => unknown;

  (pool as unknown as { query: unknown }).query = function patched(...args: unknown[]) {
    const sql = sqlTextOf(args[0]);
    tally.total++;
    tally[classify(sql)]++;
    tally.statements.push(sql);
    return original(...args);
  };

  try {
    const result = await fn();
    return { result, tally };
  } finally {
    (pool as unknown as { query: unknown }).query = original;
  }
}

/** Compact one-line summary for test output. */
export function describeTally(t: QueryTally): string {
  return (
    `total=${t.total} selection=${t.selection} claim=${t.claim} ` +
    `notification=${t.notification} emailState=${t.emailState} activity=${t.activity}`
  );
}
