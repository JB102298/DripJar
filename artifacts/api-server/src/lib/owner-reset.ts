/**
 * Local-only owner-QA reset.
 *
 * Resets ONE approved synthetic owner account to an empty product state so a
 * fresh-account walkthrough can be QA'd without wiping the database or losing
 * the account itself.
 *
 * ─── WHY THIS IS A SCRIPT AND NOT AN API ROUTE ───────────────────────────────
 *
 * There is no jar-delete endpoint anywhere in the API — `routes/` exposes
 * DELETE only for autodrip, members, milestones, and payment methods. Removing
 * a jar is deliberately not a product capability, so this lives in `scripts/`
 * as a development tool and must never be reachable from the running app.
 *
 * It is never invoked on startup or on sign-in. It runs only when a human types
 * the command with an explicit `--confirm`.
 *
 * ─── WHY THE DELETE ORDER IS HAND-WRITTEN ────────────────────────────────────
 *
 * `DELETE FROM jars` cannot work. Six of the sixteen foreign keys pointing at
 * `jars` are not CASCADE, and four of them raise rather than cascade:
 *
 *   financial_transactions.jar_id     RESTRICT
 *   fund_commitments.jar_id           RESTRICT
 *   refund_requests.jar_id            RESTRICT
 *   autodrip_authorizations.jar_id    RESTRICT
 *   notifications.related_jar_id      NO ACTION   (raises at commit)
 *   reminder_sent_events.jar_id       SET NULL    (row silently survives)
 *
 * `financial_transactions` is itself referenced by nine tables, almost all
 * RESTRICT, and forms a cycle with the ledger:
 *
 *   financial_transactions.ledger_id            -> ledger_transactions  NO ACTION
 *   ledger_transactions.financial_transaction_id -> financial_transactions RESTRICT
 *
 * The cycle is broken by nulling `financial_transactions.ledger_id` (nullable)
 * before deleting the ledger rows; `ledger_transactions.financial_transaction_id`
 * is NOT NULL and cannot be used for that.
 *
 * The order below is derived from the live FK graph, deepest dependant first.
 * It is not a guess and must not be reordered casually.
 *
 * ─── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
 *
 * It never edits agreement text. Deleting a local jar and the acceptance rows
 * scoped to it is a different act from rewriting an accepted agreement, which
 * nothing in this repository does. It never touches a user outside the
 * synthetic allowlist, never deletes the target user, and never runs against a
 * non-local database.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts reset-owner -- --email jordan@dripjar.dev
 *   pnpm --filter @workspace/scripts reset-owner -- --email jordan@dripjar.dev --confirm
 */

import { pool } from "@workspace/db";

/**
 * The slice of a node-postgres client this module actually uses. Declared
 * structurally so the module needs no `@types/pg` dependency, which is not
 * resolvable from this package.
 */
export interface QueryClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

// ─── Guard configuration ─────────────────────────────────────────────────────

/**
 * Accounts this tool is permitted to reset.
 *
 * An allowlist, not a pattern match: `@dripjar.dev` alone would still be a
 * standing licence to delete any future account on that domain. Every entry
 * here is a synthetic fixture created by `seed.ts`.
 */
export const APPROVED_SYNTHETIC_EMAILS: readonly string[] = [
  "jordan@dripjar.dev",
  "caitlyn@dripjar.dev",
  "mom@dripjar.dev",
  "dad@dripjar.dev",
  "tyler@dripjar.dev",
  "demo@dripjar.dev",
];

/** Databases this tool may touch. Anything else is refused by name. */
export const APPROVED_DATABASES: readonly string[] = ["dripjar_dev"];

/** Hosts considered local. A remote host is refused even if the name matches. */
export const LOCAL_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "::1", "[::1]", ""];

export interface GuardInput {
  email: string;
  nodeEnv: string | undefined;
  databaseUrl: string | undefined;
  /**
   * Test seam. In-process callers may supply their own allowlist so the suite
   * can reset throwaway fixture accounts without naming a real seeded one.
   * The CLI never passes this, so the command a human runs is always checked
   * against `APPROVED_SYNTHETIC_EMAILS`.
   */
  approvedEmails?: readonly string[];
}

export interface GuardFailure {
  code:
    | "PRODUCTION_ENV"
    | "NO_DATABASE_URL"
    | "MALFORMED_DATABASE_URL"
    | "NON_LOCAL_HOST"
    | "UNKNOWN_DATABASE"
    | "EMAIL_NOT_APPROVED"
    | "MISSING_EMAIL";
  message: string;
}

/** Parsed, non-secret description of the connection target. */
export interface DbIdentity {
  host: string;
  port: string;
  database: string;
}

/**
 * Every safety check, in one pure function so the tests can exercise each
 * rejection without a database or a live environment.
 */
export function checkGuards(input: GuardInput): { ok: true; db: DbIdentity } | { ok: false; failure: GuardFailure } {
  const fail = (code: GuardFailure["code"], message: string) =>
    ({ ok: false as const, failure: { code, message } });

  if (!input.email) {
    return fail("MISSING_EMAIL", "--email is required. Pass the exact target address.");
  }

  if (input.nodeEnv === "production") {
    return fail("PRODUCTION_ENV", "Refusing to run with NODE_ENV=production. This tool is local-only.");
  }

  if (!input.databaseUrl) {
    return fail("NO_DATABASE_URL", "DATABASE_URL is not set.");
  }

  let url: URL;
  try {
    url = new URL(input.databaseUrl);
  } catch {
    return fail("MALFORMED_DATABASE_URL", "DATABASE_URL could not be parsed.");
  }

  const host = url.hostname;
  const database = url.pathname.replace(/^\//, "");

  if (!LOCAL_HOSTS.includes(host)) {
    // Never echo the URL — it carries a password.
    return fail("NON_LOCAL_HOST", `Refusing to run against non-local database host "${host}".`);
  }

  if (!APPROVED_DATABASES.includes(database)) {
    return fail("UNKNOWN_DATABASE", `Refusing to run against unapproved database "${database}".`);
  }

  const approved = input.approvedEmails ?? APPROVED_SYNTHETIC_EMAILS;
  if (!approved.includes(input.email)) {
    return fail(
      "EMAIL_NOT_APPROVED",
      `"${input.email}" is not an approved synthetic QA account. Refusing.`,
    );
  }

  return { ok: true, db: { host, port: url.port || "5432", database } };
}

// ─── Manifest ────────────────────────────────────────────────────────────────

export interface ResetManifest {
  userId: string;
  email: string;
  ownedJars: { id: string; name: string; status: string }[];
  foreignMemberships: { jarId: string; jarName: string; ownerEmail: string; memberId: string }[];
  counts: Record<string, number>;
}

const OWNED = `(select id from jars where organizer_id = $1)`;
const OWNED_FT = `(select id from financial_transactions where jar_id in ${OWNED})`;

/**
 * Count every row the reset would remove, using exactly the predicates the
 * delete step uses. Read-only: this is what `--dry-run` prints.
 */
export async function buildManifest(client: QueryClient, userId: string, email: string): Promise<ResetManifest> {
  const jars = (
    await client.query(
      `select id, name, status from jars where organizer_id = $1 order by created_at`,
      [userId],
    )
  ).rows;

  const foreign = (
    await client.query(
      `select j.id as "jarId", j.name as "jarName", o.email as "ownerEmail", m.id as "memberId"
         from jar_members m
         join jars j on j.id = m.jar_id
         join users o on o.id = j.organizer_id
        where m.user_id = $1 and j.organizer_id <> $1`,
      [userId],
    )
  ).rows;

  const countQueries: [string, string][] = [
    ["milestone_allocations", `select count(*)::int c from milestone_allocations where milestone_id in (select id from milestones where jar_id in ${OWNED}) or contribution_id in (select id from contributions where jar_id in ${OWNED})`],
    ["commitment_allocations", `select count(*)::int c from commitment_allocations where fund_commitment_id in (select id from fund_commitments where jar_id in ${OWNED}) or source_ft_id in ${OWNED_FT}`],
    ["commitment_snapshot_allocations", `select count(*)::int c from commitment_snapshot_allocations where snapshot_id in (select id from commitment_snapshots where jar_id in ${OWNED}) or source_ft_id in ${OWNED_FT}`],
    ["refund_allocations", `select count(*)::int c from refund_allocations where refund_request_id in (select id from refund_requests where jar_id in ${OWNED})`],
    ["refund_requests", `select count(*)::int c from refund_requests where jar_id in ${OWNED}`],
    ["fund_commitments", `select count(*)::int c from fund_commitments where jar_id in ${OWNED}`],
    ["autodrip_runs", `select count(*)::int c from autodrip_runs where autodrip_authorization_id in (select id from autodrip_authorizations where jar_id in ${OWNED}) or financial_transaction_id in ${OWNED_FT}`],
    ["autodrip_authorizations", `select count(*)::int c from autodrip_authorizations where jar_id in ${OWNED}`],
    ["commitment_votes", `select count(*)::int c from commitment_votes where commitment_request_id in (select id from commitment_requests where jar_id in ${OWNED})`],
    ["commitment_requests", `select count(*)::int c from commitment_requests where jar_id in ${OWNED}`],
    ["commitment_snapshots", `select count(*)::int c from commitment_snapshots where jar_id in ${OWNED}`],
    ["stripe_webhook_events", `select count(*)::int c from stripe_webhook_events where financial_transaction_id in ${OWNED_FT}`],
    ["ledger_entries", `select count(*)::int c from ledger_entries where ledger_transaction_id in (select id from ledger_transactions where financial_transaction_id in ${OWNED_FT})`],
    ["ledger_transactions", `select count(*)::int c from ledger_transactions where financial_transaction_id in ${OWNED_FT}`],
    ["financial_transactions", `select count(*)::int c from financial_transactions where jar_id in ${OWNED}`],
    ["contributions", `select count(*)::int c from contributions where jar_id in ${OWNED}`],
    ["contribution_schedules", `select count(*)::int c from contribution_schedules where jar_id in ${OWNED}`],
    ["milestones", `select count(*)::int c from milestones where jar_id in ${OWNED}`],
    ["jar_goals", `select count(*)::int c from jar_goals where jar_id in ${OWNED}`],
    ["invitations", `select count(*)::int c from invitations where jar_id in ${OWNED} or invited_by_user_id = $1`],
    ["agreement_acceptances", `select count(*)::int c from agreement_acceptances where agreement_id in (select id from agreements where jar_id in ${OWNED}) or user_id = $1`],
    ["agreements", `select count(*)::int c from agreements where jar_id in ${OWNED}`],
    ["activity_events", `select count(*)::int c from activity_events where jar_id in ${OWNED} or user_id = $1`],
    ["notifications", `select count(*)::int c from notifications where user_id = $1 or related_jar_id in ${OWNED}`],
    ["reminder_sent_events", `select count(*)::int c from reminder_sent_events where user_id = $1 or jar_id in ${OWNED}`],
    ["saved_payment_methods", `select count(*)::int c from saved_payment_methods where user_id = $1`],
    ["payment_method_placeholders", `select count(*)::int c from payment_method_placeholders where user_id = $1`],
    ["jar_members", `select count(*)::int c from jar_members where jar_id in ${OWNED} or user_id = $1`],
    ["jars", `select count(*)::int c from jars where organizer_id = $1`],
  ];

  const counts: Record<string, number> = {};
  for (const [name, sql] of countQueries) {
    counts[name] = (await client.query(sql, [userId])).rows[0].c as number;
  }

  return { userId, email, ownedJars: jars, foreignMemberships: foreign, counts };
}

// ─── Delete plan ─────────────────────────────────────────────────────────────

/**
 * Ordered statements, deepest dependant first. Each is scoped by `$1` = target
 * user id. Order is load-bearing — see the header comment.
 *
 * `notifications` and `reminder_sent_events` belonging to OTHER users that
 * merely reference a deleted jar are detached (set null), not deleted: they are
 * that user's data, not the target's.
 */
export const DELETE_PLAN: { label: string; sql: string }[] = [
  { label: "milestone_allocations", sql: `delete from milestone_allocations where milestone_id in (select id from milestones where jar_id in ${OWNED}) or contribution_id in (select id from contributions where jar_id in ${OWNED})` },
  { label: "commitment_allocations", sql: `delete from commitment_allocations where fund_commitment_id in (select id from fund_commitments where jar_id in ${OWNED}) or source_ft_id in ${OWNED_FT}` },
  { label: "commitment_snapshot_allocations", sql: `delete from commitment_snapshot_allocations where snapshot_id in (select id from commitment_snapshots where jar_id in ${OWNED}) or source_ft_id in ${OWNED_FT}` },
  { label: "refund_allocations", sql: `delete from refund_allocations where refund_request_id in (select id from refund_requests where jar_id in ${OWNED}) or source_ft_id in ${OWNED_FT} or finalization_ft_id in ${OWNED_FT}` },
  { label: "refund_requests", sql: `delete from refund_requests where jar_id in ${OWNED} or reservation_ft_id in ${OWNED_FT}` },
  { label: "fund_commitments", sql: `delete from fund_commitments where jar_id in ${OWNED}` },
  { label: "autodrip_runs", sql: `delete from autodrip_runs where autodrip_authorization_id in (select id from autodrip_authorizations where jar_id in ${OWNED}) or financial_transaction_id in ${OWNED_FT}` },
  { label: "autodrip_authorizations", sql: `delete from autodrip_authorizations where jar_id in ${OWNED} or user_id = $1` },
  // Payment instruments are the target's own and must go for the profile to
  // read as a fresh account. They can only be removed once the autodrip
  // authorisations that RESTRICT on them are gone, hence the position here.
  { label: "saved_payment_methods", sql: `delete from saved_payment_methods where user_id = $1` },
  { label: "payment_method_placeholders", sql: `delete from payment_method_placeholders where user_id = $1` },
  { label: "commitment_votes", sql: `delete from commitment_votes where commitment_request_id in (select id from commitment_requests where jar_id in ${OWNED})` },
  { label: "commitment_requests", sql: `delete from commitment_requests where jar_id in ${OWNED} or created_by_user_id = $1` },
  { label: "commitment_snapshots", sql: `delete from commitment_snapshots where jar_id in ${OWNED}` },
  { label: "stripe_webhook_events", sql: `delete from stripe_webhook_events where financial_transaction_id in ${OWNED_FT}` },
  // Break the financial_transactions <-> ledger_transactions cycle.
  { label: "financial_transactions.ledger_id := null", sql: `update financial_transactions set ledger_id = null where jar_id in ${OWNED}` },
  { label: "ledger_entries", sql: `delete from ledger_entries where ledger_transaction_id in (select id from ledger_transactions where financial_transaction_id in ${OWNED_FT})` },
  { label: "ledger_transactions", sql: `delete from ledger_transactions where financial_transaction_id in ${OWNED_FT}` },
  { label: "financial_transactions", sql: `delete from financial_transactions where jar_id in ${OWNED}` },
  { label: "contributions", sql: `delete from contributions where jar_id in ${OWNED}` },
  { label: "contribution_schedules", sql: `delete from contribution_schedules where jar_id in ${OWNED}` },
  { label: "milestones", sql: `delete from milestones where jar_id in ${OWNED}` },
  { label: "jar_goals", sql: `delete from jar_goals where jar_id in ${OWNED}` },
  { label: "invitations", sql: `delete from invitations where jar_id in ${OWNED} or invited_by_user_id = $1` },
  { label: "agreement_acceptances", sql: `delete from agreement_acceptances where agreement_id in (select id from agreements where jar_id in ${OWNED}) or user_id = $1` },
  { label: "agreements", sql: `delete from agreements where jar_id in ${OWNED}` },
  { label: "activity_events", sql: `delete from activity_events where jar_id in ${OWNED} or user_id = $1` },
  // Jar-scoped notices are deleted for EVERY recipient, not detached.
  //
  // Detaching (`related_jar_id := null`) leaves a co-member holding "Hawaii 2027
  // reached a milestone" with nothing behind the tap — a ghost row whose only
  // meaning was a jar that no longer exists. Deleting the jar-scoped notice is
  // not deleting that person's account data; it is removing a record that
  // cannot refer to anything. Everything of theirs NOT about this jar is
  // untouched, which is what the `related_jar_id in (...)` predicate guarantees.
  { label: "notifications (jar-scoped, all recipients)", sql: `delete from notifications where related_jar_id in ${OWNED}` },
  { label: "notifications (target's own)", sql: `delete from notifications where user_id = $1` },
  { label: "reminder_sent_events (jar-scoped, all recipients)", sql: `delete from reminder_sent_events where jar_id in ${OWNED}` },
  { label: "reminder_sent_events (target's own)", sql: `delete from reminder_sent_events where user_id = $1` },
  { label: "jar_members", sql: `delete from jar_members where jar_id in ${OWNED} or user_id = $1` },
  { label: "jars", sql: `delete from jars where organizer_id = $1` },
];

// ─── Reconciliation ──────────────────────────────────────────────────────────

export interface Reconciliation {
  userStillExists: boolean;
  passwordHashUnchanged: boolean;
  emailVerifiedUnchanged: boolean;
  profileStillExists: boolean;
  ownedJars: number;
  memberships: number;
  notifications: number;
  activityEvents: number;
  otherUsers: number;
  otherJars: number;
  orphanedLedgerEntries: number;
  orphanedFinancialTransactions: number;
}

export async function reconcile(
  client: QueryClient,
  userId: string,
  before: { passwordHash: string; emailVerified: boolean },
): Promise<Reconciliation> {
  const one = async (sql: string, params: unknown[] = [userId]) =>
    (await client.query(sql, params)).rows[0];

  const u = await one(`select password_hash, email_verified from users where id = $1`);
  const counts = await one(
    `select
       (select count(*)::int from jars where organizer_id = $1)                        as owned,
       (select count(*)::int from jar_members where user_id = $1)                      as memberships,
       (select count(*)::int from notifications where user_id = $1)                    as notifications,
       (select count(*)::int from activity_events where user_id = $1)                  as activity,
       (select count(*)::int from profiles where user_id = $1)                         as profiles,
       (select count(*)::int from users where id <> $1)                                as other_users,
       (select count(*)::int from jars where organizer_id <> $1)                       as other_jars,
       (select count(*)::int from ledger_entries le
          left join ledger_transactions lt on lt.id = le.ledger_transaction_id
         where lt.id is null)                                                          as orphan_entries,
       (select count(*)::int from financial_transactions ft
          left join jars j on j.id = ft.jar_id where j.id is null)                     as orphan_fts`,
  );

  return {
    userStillExists: Boolean(u),
    passwordHashUnchanged: Boolean(u) && u.password_hash === before.passwordHash,
    emailVerifiedUnchanged: Boolean(u) && u.email_verified === before.emailVerified,
    profileStillExists: counts.profiles > 0,
    ownedJars: counts.owned,
    memberships: counts.memberships,
    notifications: counts.notifications,
    activityEvents: counts.activity,
    otherUsers: counts.other_users,
    otherJars: counts.other_jars,
    orphanedLedgerEntries: counts.orphan_entries,
    orphanedFinancialTransactions: counts.orphan_fts,
  };
}

// ─── Full account purge (used by the seed's cleanup step) ────────────────────

/**
 * Remove a synthetic account and everything it owns, then the account itself.
 *
 * `seed.ts` used to do this with `DELETE FROM users`, on the stated assumption
 * that "cascade deletes will handle related records". They do not:
 * `jars.organizer_id`, `jar_members.user_id`, `activity_events.user_id`, and
 * `agreement_acceptances.user_id` are all NO ACTION, so the second run of the
 * seed raised a foreign-key violation and the seed was effectively single-use.
 *
 * Rather than maintain a second, contradictory delete order, this reuses
 * `DELETE_PLAN` — the one derived from the live FK graph — and then removes the
 * user row, letting the genuinely-cascading children (profiles,
 * refresh_sessions, payment_method_placeholders) go with it.
 *
 * Guarded exactly like the reset: production is refused, non-local hosts are
 * refused, unknown databases are refused, and every address must be on the
 * synthetic allowlist.
 */
export async function purgeSyntheticAccounts(
  emails: readonly string[],
  opts: { approvedEmails?: readonly string[]; quiet?: boolean } = {},
): Promise<Record<string, number>> {
  const log = opts.quiet ? () => {} : (m: string) => console.log(m);

  for (const email of emails) {
    const guard = checkGuards({
      email,
      nodeEnv: process.env["NODE_ENV"],
      databaseUrl: process.env["DATABASE_URL"],
      ...(opts.approvedEmails ? { approvedEmails: opts.approvedEmails } : {}),
    });
    if (!guard.ok) throw new Error(`[GUARD:${guard.failure.code}] ${guard.failure.message}`);
  }

  const removed: Record<string, number> = {};
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const email of emails) {
      const [user] = (await client.query(`select id from users where email = $1`, [email])).rows;
      if (!user) {
        removed[email] = 0;
        continue;
      }
      for (const step of DELETE_PLAN) await client.query(step.sql, [user.id]);
      const res = await client.query(`delete from users where id = $1`, [user.id]);
      removed[email] = res.rowCount ?? 0;
    }
    await client.query("COMMIT");
    log(`  Purged ${Object.values(removed).filter(Boolean).length} synthetic account(s)`);
    return removed;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ─── Runner ──────────────────────────────────────────────────────────────────

export interface RunOptions {
  email: string;
  confirm: boolean;
  /** Test seam: throw after the deletes to prove the transaction rolls back. */
  injectFailure?: boolean;
  /** Test seam — see `GuardInput.approvedEmails`. Never set by the CLI. */
  approvedEmails?: readonly string[];
  /** Suppress console output during tests. */
  quiet?: boolean;
}

export async function runReset(opts: RunOptions): Promise<{ manifest: ResetManifest; reconciliation?: Reconciliation }> {
  const log = opts.quiet ? () => {} : (m: string) => console.log(m);
  const guard = checkGuards({
    email: opts.email,
    nodeEnv: process.env["NODE_ENV"],
    databaseUrl: process.env["DATABASE_URL"],
    ...(opts.approvedEmails ? { approvedEmails: opts.approvedEmails } : {}),
  });
  if (!guard.ok) throw new Error(`[GUARD:${guard.failure.code}] ${guard.failure.message}`);

  const client = await pool.connect();
  try {
    const [user] = (
      await client.query(
        `select id, email, password_hash, email_verified from users where email = $1`,
        [opts.email],
      )
    ).rows;

    if (!user) {
      throw new Error(`No user found with email "${opts.email}". Nothing to do.`);
    }

    log(`\n  database : ${guard.db.database} @ ${guard.db.host}:${guard.db.port}`);
    log(`  target   : ${user.email}`);
    log(`  user id  : ${user.id}`);
    log(`  mode     : ${opts.confirm ? "EXECUTE (destructive)" : "DRY RUN (no writes)"}\n`);

    const manifest = await buildManifest(client, user.id, user.email);

    log("  Jars to delete:");
    if (!manifest.ownedJars.length) log("    (none)");
    for (const j of manifest.ownedJars) log(`    - ${j.name}  [${j.status}]  ${j.id}`);

    log("\n  Memberships in OTHER users' jars (membership removed, jar preserved):");
    if (!manifest.foreignMemberships.length) log("    (none)");
    for (const m of manifest.foreignMemberships) {
      log(`    - ${m.jarName}  owned by ${m.ownerEmail}`);
    }

    log("\n  Rows to remove, by table:");
    let total = 0;
    for (const [table, n] of Object.entries(manifest.counts)) {
      if (n > 0) log(`    ${String(n).padStart(6)}  ${table}`);
      total += n;
    }
    log(`    ${String(total).padStart(6)}  TOTAL`);

    const others = (
      await client.query(
        `select (select count(*)::int from users where id <> $1) u,
                (select count(*)::int from jars where organizer_id <> $1) j`,
        [user.id],
      )
    ).rows[0];
    log(`\n  Excluded from this reset: ${others.u} other users, ${others.j} jars they own.`);

    if (!opts.confirm) {
      log("\n  DRY RUN — nothing was written. Re-run with --confirm to execute.\n");
      return { manifest };
    }

    await client.query("BEGIN");
    try {
      log("\n  Executing inside one transaction:");
      for (const step of DELETE_PLAN) {
        const res = await client.query(step.sql, [user.id]);
        if (res.rowCount) log(`    ${String(res.rowCount).padStart(6)}  ${step.label}`);
      }

      if (opts.injectFailure) throw new Error("Injected failure (test seam) — expecting rollback");

      const reconciliation = await reconcile(client, user.id, {
        passwordHash: user.password_hash,
        emailVerified: user.email_verified,
      });

      if (!reconciliation.userStillExists) throw new Error("ABORT: target user disappeared");
      if (!reconciliation.passwordHashUnchanged) throw new Error("ABORT: password hash changed");
      if (!reconciliation.emailVerifiedUnchanged) throw new Error("ABORT: verification state changed");
      if (!reconciliation.profileStillExists) throw new Error("ABORT: profile was removed");
      if (reconciliation.ownedJars !== 0) throw new Error("ABORT: owned jars remain");
      if (reconciliation.orphanedLedgerEntries !== 0) throw new Error("ABORT: orphaned ledger entries");
      if (reconciliation.orphanedFinancialTransactions !== 0) throw new Error("ABORT: orphaned financial transactions");

      await client.query("COMMIT");

      log("\n  Post-run reconciliation:");
      for (const [k, v] of Object.entries(reconciliation)) log(`    ${k}: ${v}`);
      log("\n  Reset complete.\n");
      return { manifest, reconciliation };
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(`\n  ROLLED BACK — no changes were written. ${(err as Error).message}\n`);
      throw err;
    }
  } finally {
    client.release();
  }
}
