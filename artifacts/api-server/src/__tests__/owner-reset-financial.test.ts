/**
 * Owner-QA reset — the ledger-backed path.
 *
 * The live owner jars carried no financial records at all: no
 * `financial_transactions`, no `ledger_transactions`, no commitments, no
 * refunds. So the Phase 1 run proved the plan works on a jar with contributions
 * and nothing else, and the ordering assertions in `owner-reset.test.ts` are
 * statements about an array, not about Postgres.
 *
 * This file builds the graph that was missing and runs the real transaction
 * through it. Everything here is a throwaway fixture under a unique
 * `@dripjar.dev` address, passed through the `approvedEmails` seam — no seeded
 * or live account is reachable from these tests.
 *
 * The specific things that can only fail against real data:
 *
 *   - `financial_transactions` <-> `ledger_transactions` is a genuine FK cycle.
 *     Both directions are enforced, and only one side is nullable. Get it wrong
 *     and Postgres raises 23503 at the delete, not at review time.
 *   - Four RESTRICT children of `jars` and seven of `jar_members` abort the
 *     whole transaction if any is still present when the parent goes.
 *   - `ledger_accounts` are a canonical chart of accounts shared by every jar.
 *     They must survive; deleting them would corrupt unrelated jars.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { pool } from "@workspace/db";
import { runReset, buildManifest } from "../lib/owner-reset.js";
import { withGlobalSweepExclusion } from "./support/fixtures.js";

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;
const count = async (sql: string, params: unknown[] = []) =>
  Number((await q(sql, params))[0].c);

interface Graph {
  targetEmail: string;
  targetId: string;
  otherId: string;
  ownedJarId: string;
  otherJarId: string;
  ownedMemberId: string;
  otherMemberId: string;
  ftId: string;
  ledgerTxId: string;
  otherFtId: string;
  otherLedgerTxId: string;
  debitAccountId: string;
  creditAccountId: string;
  contributionId: string;
  milestoneId: string;
  agreementId: string;
  snapshotId: string;
  fundCommitmentId: string;
  refundRequestId: string;
  autodripAuthId: string;
  spmId: string;
}

/**
 * One owned jar carrying every dependant the schema supports, plus a second
 * user with their own jar and their own ledger-backed transaction that must
 * come through untouched.
 */
async function buildFinancialGraph(tag: string): Promise<Graph> {
  const u = tag;
  const targetEmail = `fin-target-${u}@dripjar.dev`;

  const [target] = await q(`insert into users (email, email_verified, password_hash) values ($1,true,'hash-fin-target') returning id`, [targetEmail]);
  const [other] = await q(`insert into users (email, email_verified, password_hash) values ($1,true,'hash-fin-other') returning id`, [`fin-other-${u}@dripjar.dev`]);
  await q(`insert into profiles (user_id, first_name, last_name, display_name) values ($1,'Fin','Target','Fin Target')`, [target.id]);
  await q(`insert into profiles (user_id, first_name, last_name, display_name) values ($1,'Fin','Other','Fin Other')`, [other.id]);

  const mkJar = async (owner: string, name: string) =>
    (await q(
      `insert into jars (organizer_id, name, slug, target_date, goal_amount_cents, status)
       values ($1,$2,$3,'2027-06-01',500000,'Saving') returning id`,
      [owner, name, `${name}-${u}`],
    ))[0].id as string;

  const ownedJarId = await mkJar(target.id, "fin-owned");
  const otherJarId = await mkJar(other.id, "fin-other-jar");

  const mkMember = async (jarId: string, userId: string, role: string) =>
    (await q(`insert into jar_members (jar_id, user_id, role) values ($1,$2,$3) returning id`, [jarId, userId, role]))[0].id as string;

  const ownedMemberId = await mkMember(ownedJarId, target.id, "organizer");
  const coMemberId = await mkMember(ownedJarId, other.id, "member");
  const otherMemberId = await mkMember(otherJarId, other.id, "organizer");

  // ── Canonical chart of accounts (shared, must survive) ────────────────────
  const mkAccount = async (code: string, type: string, normal: string) =>
    (await q(
      `insert into ledger_accounts (code, name, account_type, normal_balance) values ($1,$2,$3,$4) returning id`,
      [`${code}-${u}`, `${code} account`, type, normal],
    ))[0].id as string;

  const debitAccountId = await mkAccount("CASH", "asset", "debit");
  const creditAccountId = await mkAccount("MEMBER_PRINCIPAL", "liability", "credit");

  // ── financial_transactions + ledger, for both users ───────────────────────
  const mkFt = async (jarId: string, memberId: string, key: string) =>
    (await q(
      `insert into financial_transactions
         (jar_id, member_id, transaction_type, requested_principal_cents, dripjar_fee_cents,
          dripjar_fee_rate_bps, total_quoted_cents, idempotency_key, provider_status, ledger_posting_status)
       values ($1,$2,'contribution',50000,1500,300,51500,$3,'succeeded','posted') returning id`,
      [jarId, memberId, key],
    ))[0].id as string;

  const ftId = await mkFt(ownedJarId, ownedMemberId, `idem-owned-${u}`);
  const otherFtId = await mkFt(otherJarId, otherMemberId, `idem-other-${u}`);

  const mkLedger = async (ftId: string) => {
    const ltId = (await q(
      `insert into ledger_transactions (financial_transaction_id, description) values ($1,'fixture posting') returning id`,
      [ftId],
    ))[0].id as string;
    // A balanced pair — the shape the canonical ledger actually writes.
    await q(`insert into ledger_entries (ledger_transaction_id, account_id, entry_type, amount_cents) values ($1,$2,'debit',50000)`, [ltId, debitAccountId]);
    await q(`insert into ledger_entries (ledger_transaction_id, account_id, entry_type, amount_cents) values ($1,$2,'credit',50000)`, [ltId, creditAccountId]);
    // Close the cycle: the FT points back at its ledger transaction.
    await q(`update financial_transactions set ledger_id = $1 where id = $2`, [ltId, ftId]);
    return ltId;
  };

  const ledgerTxId = await mkLedger(ftId);
  const otherLedgerTxId = await mkLedger(otherFtId);

  // ── Contributions, milestones, allocations ────────────────────────────────
  const contributionId = (await q(
    `insert into contributions (jar_id, member_id, amount_cents, contribution_date) values ($1,$2,50000,'2026-07-01') returning id`,
    [ownedJarId, ownedMemberId],
  ))[0].id as string;
  const milestoneId = (await q(
    `insert into milestones (jar_id, name, target_amount_cents) values ($1,'Flights',250000) returning id`,
    [ownedJarId],
  ))[0].id as string;
  await q(`insert into milestone_allocations (milestone_id, contribution_id, amount_cents) values ($1,$2,50000)`, [milestoneId, contributionId]);

  await q(`insert into contribution_schedules (jar_id, member_id, amount_cents, start_date) values ($1,$2,10000,'2026-07-01')`, [ownedJarId, ownedMemberId]);

  // ── Agreement + acceptance ────────────────────────────────────────────────
  const agreementId = (await q(
    `insert into agreements (jar_id, version, content, effective_date) values ($1,'2.0','fixture agreement','2026-01-01') returning id`,
    [ownedJarId],
  ))[0].id as string;
  await q(`insert into agreement_acceptances (agreement_id, user_id) values ($1,$2)`, [agreementId, target.id]);
  await q(`insert into agreement_acceptances (agreement_id, user_id) values ($1,$2)`, [agreementId, other.id]);

  // ── Commitment chain: request -> vote -> snapshot -> fund commitment ──────
  const commitmentRequestId = (await q(
    `insert into commitment_requests (jar_id, amount_cents, purpose, milestone_id, created_by_user_id)
     values ($1,200000,'Book flights',$2,$3) returning id`,
    [ownedJarId, milestoneId, target.id],
  ))[0].id as string;
  await q(`insert into commitment_votes (commitment_request_id, member_id, vote) values ($1,$2,'approve')`, [commitmentRequestId, ownedMemberId]);

  const snapshotId = (await q(
    `insert into commitment_snapshots (jar_id, member_id, agreement_id, agreement_version, snapshot_token, total_principal_cents, expires_at)
     values ($1,$2,$3,'2.0',$4,50000, now() + interval '1 day') returning id`,
    [ownedJarId, ownedMemberId, agreementId, `snap-${u}`],
  ))[0].id as string;
  await q(`insert into commitment_snapshot_allocations (snapshot_id, source_ft_id, allocated_cents) values ($1,$2,50000)`, [snapshotId, ftId]);

  const fundCommitmentId = (await q(
    `insert into fund_commitments (jar_id, member_id, snapshot_id, agreement_id, agreement_version, total_committed_cents)
     values ($1,$2,$3,$4,'2.0',50000) returning id`,
    [ownedJarId, ownedMemberId, snapshotId, agreementId],
  ))[0].id as string;
  await q(`insert into commitment_allocations (fund_commitment_id, source_ft_id, allocated_cents) values ($1,$2,50000)`, [fundCommitmentId, ftId]);

  // ── Refund chain ──────────────────────────────────────────────────────────
  const refundRequestId = (await q(
    `insert into refund_requests (jar_id, member_id, requested_cents) values ($1,$2,25000) returning id`,
    [ownedJarId, ownedMemberId],
  ))[0].id as string;
  await q(`insert into refund_allocations (refund_request_id, source_ft_id, allocated_cents) values ($1,$2,25000)`, [refundRequestId, ftId]);

  // ── Payment method + autodrip ─────────────────────────────────────────────
  const spmId = (await q(
    `insert into saved_payment_methods (user_id, stripe_customer_id, stripe_payment_method_id, type)
     values ($1,$2,$3,'card') returning id`,
    [target.id, `cus_${u}`, `pm_${u}`],
  ))[0].id as string;
  const autodripAuthId = (await q(
    `insert into autodrip_authorizations (jar_id, member_id, user_id, saved_payment_method_id, principal_cents, frequency, next_run_at)
     values ($1,$2,$3,$4,10000,'monthly', now() + interval '7 days') returning id`,
    [ownedJarId, ownedMemberId, target.id, spmId],
  ))[0].id as string;
  // `autodrip_runs.id` carries no default — the application supplies it.
  await q(
    `insert into autodrip_runs (id, autodrip_authorization_id, scheduled_for, principal_cents, idempotency_key, financial_transaction_id)
     values (gen_random_uuid(),$1,'2026-08-01',10000,$2,$3)`,
    [autodripAuthId, `run-${u}`, ftId],
  );

  // ── Notices: target's own, the co-member's about this jar, and the
  //    co-member's about something else entirely. ────────────────────────────
  await q(`insert into notifications (user_id, title, message, related_jar_id) values ($1,'own','about my jar',$2)`, [target.id, ownedJarId]);
  await q(`insert into notifications (user_id, title, message, related_jar_id) values ($1,'co-member','about the deleted jar',$2)`, [other.id, ownedJarId]);
  await q(`insert into notifications (user_id, title, message, related_jar_id) values ($1,'co-member','about their own jar',$2)`, [other.id, otherJarId]);
  await q(`insert into notifications (user_id, title, message, related_jar_id) values ($1,'co-member','not about any jar',null)`, [other.id]);

  await q(`insert into reminder_sent_events (event_key, user_id, event_type, jar_id) values ($1,$2,'contribution_due',$3)`, [`rk-own-${u}`, target.id, ownedJarId]);
  await q(`insert into reminder_sent_events (event_key, user_id, event_type, jar_id) values ($1,$2,'contribution_due',$3)`, [`rk-co-${u}`, other.id, ownedJarId]);
  await q(`insert into reminder_sent_events (event_key, user_id, event_type, jar_id) values ($1,$2,'contribution_due',$3)`, [`rk-other-${u}`, other.id, otherJarId]);

  await q(`insert into activity_events (jar_id, user_id, event_type, description) values ($1,$2,'jar_created','fixture')`, [ownedJarId, target.id]);
  await q(`insert into activity_events (jar_id, user_id, event_type, description) values ($1,$2,'jar_created','other fixture')`, [otherJarId, other.id]);

  void coMemberId;

  return {
    targetEmail, targetId: target.id, otherId: other.id,
    ownedJarId, otherJarId, ownedMemberId, otherMemberId,
    ftId, ledgerTxId, otherFtId, otherLedgerTxId,
    debitAccountId, creditAccountId,
    contributionId, milestoneId, agreementId, snapshotId,
    fundCommitmentId, refundRequestId, autodripAuthId, spmId,
  };
}

/**
 * Tear-down keyed on the fixture TAG, not on the object `buildFinancialGraph`
 * returns.
 *
 * The first version took the returned `Graph`, which meant a fixture that threw
 * part-way through construction left `g` undefined and cleaned up nothing —
 * fourteen half-built accounts survived the first run of this file. Resolving
 * the users by tag makes tear-down independent of how far the build got.
 */
async function destroyByTag(tag: string) {
  const users = (await q(`select id from users where email like $1`, [`%-${tag}@dripjar.dev`])).map((r) => r.id as string);
  if (!users.length) return;
  const jars = (await q(`select id from jars where organizer_id = any($1)`, [users])).map((r) => r.id as string);
  if (!jars.length) {
    // Users exist but no jars were reached before the build failed.
    await q(`delete from saved_payment_methods where user_id = any($1)`, [users]);
    await q(`delete from notifications where user_id = any($1)`, [users]);
    await q(`delete from reminder_sent_events where user_id = any($1)`, [users]);
    await q(`delete from profiles where user_id = any($1)`, [users]);
    await q(`delete from users where id = any($1)`, [users]);
    return;
  }
  const stmts = [
    [`delete from milestone_allocations where milestone_id in (select id from milestones where jar_id = any($1))`, [jars]],
    [`delete from commitment_allocations where fund_commitment_id in (select id from fund_commitments where jar_id = any($1))`, [jars]],
    [`delete from commitment_snapshot_allocations where snapshot_id in (select id from commitment_snapshots where jar_id = any($1))`, [jars]],
    [`delete from refund_allocations where refund_request_id in (select id from refund_requests where jar_id = any($1))`, [jars]],
    [`delete from refund_requests where jar_id = any($1)`, [jars]],
    [`delete from fund_commitments where jar_id = any($1)`, [jars]],
    [`delete from autodrip_runs where autodrip_authorization_id in (select id from autodrip_authorizations where jar_id = any($1))`, [jars]],
    [`delete from autodrip_authorizations where jar_id = any($1) or user_id = any($2)`, [jars, users]],
    [`delete from saved_payment_methods where user_id = any($1)`, [users]],
    [`delete from commitment_votes where commitment_request_id in (select id from commitment_requests where jar_id = any($1))`, [jars]],
    [`delete from commitment_requests where jar_id = any($1) or created_by_user_id = any($2)`, [jars, users]],
    [`delete from commitment_snapshots where jar_id = any($1)`, [jars]],
    [`update financial_transactions set ledger_id = null where jar_id = any($1)`, [jars]],
    [`delete from ledger_entries where ledger_transaction_id in (select id from ledger_transactions where financial_transaction_id in (select id from financial_transactions where jar_id = any($1)))`, [jars]],
    [`delete from ledger_transactions where financial_transaction_id in (select id from financial_transactions where jar_id = any($1))`, [jars]],
    [`delete from financial_transactions where jar_id = any($1)`, [jars]],
    [`delete from contributions where jar_id = any($1)`, [jars]],
    [`delete from contribution_schedules where jar_id = any($1)`, [jars]],
    [`delete from milestones where jar_id = any($1)`, [jars]],
    [`delete from agreement_acceptances where agreement_id in (select id from agreements where jar_id = any($1)) or user_id = any($2)`, [jars, users]],
    [`delete from agreements where jar_id = any($1)`, [jars]],
    [`delete from activity_events where jar_id = any($1) or user_id = any($2)`, [jars, users]],
    [`delete from notifications where user_id = any($1) or related_jar_id = any($2)`, [users, jars]],
    [`delete from reminder_sent_events where user_id = any($1) or jar_id = any($2)`, [users, jars]],
    [`delete from jar_members where jar_id = any($1) or user_id = any($2)`, [jars, users]],
    [`delete from jars where id = any($1)`, [jars]],
    // Fixture chart-of-accounts rows are suffixed with the tag, so they can be
    // resolved without the (possibly unbuilt) Graph object.
    [`delete from ledger_accounts where code like $1`, [`%-${tag}`]],
    [`delete from profiles where user_id = any($1)`, [users]],
    [`delete from users where id = any($1)`, [users]],
  ] as [string, unknown[]][];
  for (const [sql, params] of stmts) await q(sql, params);
}

describe("owner reset against a ledger-backed jar", () => {
  let g: Graph;
  let tag: string;
  const approvedFor = (email: string) => [email];

  beforeEach(async () => {
    tag = unique();
    g = await buildFinancialGraph(tag);
  });
  // Keyed on , so a fixture that fails mid-build still gets cleaned up.
  afterEach(async () => { await destroyByTag(tag); });

  it("the fixture really does contain the graph under test", async () => {
    expect(await count(`select count(*)::int c from financial_transactions where jar_id=$1`, [g.ownedJarId])).toBe(1);
    expect(await count(`select count(*)::int c from ledger_transactions where id=$1`, [g.ledgerTxId])).toBe(1);
    expect(await count(`select count(*)::int c from ledger_entries where ledger_transaction_id=$1`, [g.ledgerTxId])).toBe(2);
    // The cycle is genuinely closed in both directions.
    const ft = await q(`select ledger_id from financial_transactions where id=$1`, [g.ftId]);
    expect(ft[0].ledger_id).toBe(g.ledgerTxId);
    const lt = await q(`select financial_transaction_id from ledger_transactions where id=$1`, [g.ledgerTxId]);
    expect(lt[0].financial_transaction_id).toBe(g.ftId);
    // Every restrictive child is present.
    expect(await count(`select count(*)::int c from fund_commitments where jar_id=$1`, [g.ownedJarId])).toBe(1);
    expect(await count(`select count(*)::int c from refund_requests where jar_id=$1`, [g.ownedJarId])).toBe(1);
    expect(await count(`select count(*)::int c from autodrip_authorizations where jar_id=$1`, [g.ownedJarId])).toBe(1);
    expect(await count(`select count(*)::int c from autodrip_runs where autodrip_authorization_id=$1`, [g.autodripAuthId])).toBe(1);
    expect(await count(`select count(*)::int c from commitment_snapshots where jar_id=$1`, [g.ownedJarId])).toBe(1);
    expect(await count(`select count(*)::int c from milestone_allocations where milestone_id=$1`, [g.milestoneId])).toBe(1);
  });

  it("a plain DELETE FROM jars still fails — the ordering is load-bearing, not decorative", async () => {
    await expect(pool.query(`delete from jars where id = $1`, [g.ownedJarId])).rejects.toMatchObject({
      code: "23503", // foreign_key_violation
    });
    // And the jar is of course still there.
    expect(await count(`select count(*)::int c from jars where id=$1`, [g.ownedJarId])).toBe(1);
  });

  it("counts the whole graph in the dry-run manifest and writes nothing", async () => {
    const client = await pool.connect();
    try {
      const m = await buildManifest(client, g.targetId, g.targetEmail);
      expect(m.counts.financial_transactions).toBe(1);
      expect(m.counts.ledger_transactions).toBe(1);
      expect(m.counts.ledger_entries).toBe(2);
      expect(m.counts.fund_commitments).toBe(1);
      expect(m.counts.refund_requests).toBe(1);
      expect(m.counts.autodrip_authorizations).toBe(1);
      expect(m.counts.autodrip_runs).toBe(1);
      expect(m.counts.commitment_snapshots).toBe(1);
      expect(m.counts.commitment_requests).toBe(1);
      expect(m.counts.commitment_votes).toBe(1);
      expect(m.counts.milestone_allocations).toBe(1);
      expect(m.counts.saved_payment_methods).toBe(1);
    } finally {
      client.release();
    }

    await runReset({ email: g.targetEmail, confirm: false, quiet: true, approvedEmails: approvedFor(g.targetEmail) });
    expect(await count(`select count(*)::int c from financial_transactions where jar_id=$1`, [g.ownedJarId])).toBe(1);
    expect(await count(`select count(*)::int c from ledger_entries where ledger_transaction_id=$1`, [g.ledgerTxId])).toBe(2);
  });

  it("deletes the entire ledger-backed graph and leaves nothing orphaned", async () => {
    const res = await withGlobalSweepExclusion(() =>
      runReset({ email: g.targetEmail, confirm: true, quiet: true, approvedEmails: approvedFor(g.targetEmail) }),
    );
    const r = res.reconciliation!;

    // The cycle resolved.
    expect(await count(`select count(*)::int c from financial_transactions where id=$1`, [g.ftId])).toBe(0);
    expect(await count(`select count(*)::int c from ledger_transactions where id=$1`, [g.ledgerTxId])).toBe(0);
    expect(await count(`select count(*)::int c from ledger_entries where ledger_transaction_id=$1`, [g.ledgerTxId])).toBe(0);

    // Every restrictive child gone.
    for (const [table, col, val] of [
      ["fund_commitments", "id", g.fundCommitmentId],
      ["refund_requests", "id", g.refundRequestId],
      ["autodrip_authorizations", "id", g.autodripAuthId],
      ["commitment_snapshots", "id", g.snapshotId],
      ["saved_payment_methods", "id", g.spmId],
      ["contributions", "id", g.contributionId],
      ["milestones", "id", g.milestoneId],
      ["agreements", "id", g.agreementId],
      ["jars", "id", g.ownedJarId],
    ] as [string, string, string][]) {
      expect(await count(`select count(*)::int c from ${table} where ${col}=$1`, [val]), `${table} should be gone`).toBe(0);
    }

    // Global orphan checks, from the reset's own reconciliation.
    expect(r.orphanedLedgerEntries).toBe(0);
    expect(r.orphanedFinancialTransactions).toBe(0);
    // And directly: no ledger entry may point at a vanished transaction.
    expect(await count(
      `select count(*)::int c from ledger_entries le left join ledger_transactions lt on lt.id=le.ledger_transaction_id where lt.id is null`,
    )).toBe(0);
    expect(await count(
      `select count(*)::int c from ledger_transactions lt left join financial_transactions ft on ft.id=lt.financial_transaction_id where ft.id is null`,
    )).toBe(0);

    // Target survives, untouched.
    expect(r.userStillExists).toBe(true);
    expect(r.passwordHashUnchanged).toBe(true);
    expect(r.emailVerifiedUnchanged).toBe(true);
    expect(r.profileStillExists).toBe(true);
    expect(r.ownedJars).toBe(0);
  });

  it("leaves the other user's jar, money, and ledger completely intact", async () => {
    const beforeFt = await q(`select * from financial_transactions where id=$1`, [g.otherFtId]);
    const beforeEntries = await q(`select id, account_id, entry_type, amount_cents from ledger_entries where ledger_transaction_id=$1 order by entry_type`, [g.otherLedgerTxId]);
    const beforeUser = await q(`select id,email,password_hash,email_verified from users where id=$1`, [g.otherId]);

    await withGlobalSweepExclusion(() =>
      runReset({ email: g.targetEmail, confirm: true, quiet: true, approvedEmails: approvedFor(g.targetEmail) }),
    );

    expect(await q(`select * from financial_transactions where id=$1`, [g.otherFtId])).toEqual(beforeFt);
    expect(await q(`select id, account_id, entry_type, amount_cents from ledger_entries where ledger_transaction_id=$1 order by entry_type`, [g.otherLedgerTxId])).toEqual(beforeEntries);
    expect(await q(`select id,email,password_hash,email_verified from users where id=$1`, [g.otherId])).toEqual(beforeUser);
    expect(await count(`select count(*)::int c from jars where id=$1`, [g.otherJarId])).toBe(1);
    expect(await count(`select count(*)::int c from jar_members where id=$1`, [g.otherMemberId])).toBe(1);

    // The shared chart of accounts is canonical and must never be touched.
    expect(await count(`select count(*)::int c from ledger_accounts where id = any($1)`, [[g.debitAccountId, g.creditAccountId]])).toBe(2);
  });

  it("removes ghost notices for every recipient without touching unrelated ones", async () => {
    await withGlobalSweepExclusion(() =>
      runReset({ email: g.targetEmail, confirm: true, quiet: true, approvedEmails: approvedFor(g.targetEmail) }),
    );

    // The co-member's notice ABOUT the deleted jar is gone.
    expect(await count(`select count(*)::int c from notifications where user_id=$1 and message='about the deleted jar'`, [g.otherId])).toBe(0);
    // Their other two are untouched.
    expect(await count(`select count(*)::int c from notifications where user_id=$1 and message='about their own jar'`, [g.otherId])).toBe(1);
    expect(await count(`select count(*)::int c from notifications where user_id=$1 and message='not about any jar'`, [g.otherId])).toBe(1);
    // Nothing was merely detached: no surviving notice points at a dead jar,
    // and none of this fixture's notices were left with a nulled target.
    expect(await count(
      `select count(*)::int c from notifications n where n.related_jar_id is not null
         and not exists (select 1 from jars j where j.id = n.related_jar_id)`,
    )).toBe(0);
    expect(await count(`select count(*)::int c from notifications where user_id=$1 and related_jar_id is null and message='about the deleted jar'`, [g.otherId])).toBe(0);

    // Reminder events: jar-scoped ones gone for both recipients, other jar kept.
    expect(await count(`select count(*)::int c from reminder_sent_events where jar_id=$1`, [g.ownedJarId])).toBe(0);
    expect(await count(`select count(*)::int c from reminder_sent_events where user_id=$1 and jar_id=$2`, [g.otherId, g.otherJarId])).toBe(1);
    expect(await count(
      `select count(*)::int c from reminder_sent_events r where r.jar_id is null and r.user_id=$1`, [g.otherId],
    )).toBe(0);

    // The co-member keeps their account, jar, and membership.
    expect(await count(`select count(*)::int c from users where id=$1`, [g.otherId])).toBe(1);
    expect(await count(`select count(*)::int c from jars where organizer_id=$1`, [g.otherId])).toBe(1);
  });

  it("rolls the whole realistic graph back when the transaction fails midway", async () => {
    const before = {
      ft: await count(`select count(*)::int c from financial_transactions where jar_id=$1`, [g.ownedJarId]),
      entries: await count(`select count(*)::int c from ledger_entries where ledger_transaction_id=$1`, [g.ledgerTxId]),
      fund: await count(`select count(*)::int c from fund_commitments where jar_id=$1`, [g.ownedJarId]),
      refunds: await count(`select count(*)::int c from refund_requests where jar_id=$1`, [g.ownedJarId]),
      autodrip: await count(`select count(*)::int c from autodrip_authorizations where jar_id=$1`, [g.ownedJarId]),
      runs: await count(`select count(*)::int c from autodrip_runs where autodrip_authorization_id=$1`, [g.autodripAuthId]),
      allocs: await count(`select count(*)::int c from milestone_allocations where milestone_id=$1`, [g.milestoneId]),
      notes: await count(`select count(*)::int c from notifications where related_jar_id=$1`, [g.ownedJarId]),
      jars: await count(`select count(*)::int c from jars where id=$1`, [g.ownedJarId]),
    };

    await expect(
      runReset({ email: g.targetEmail, confirm: true, quiet: true, injectFailure: true, approvedEmails: approvedFor(g.targetEmail) }),
    ).rejects.toThrow(/Injected failure/);

    expect({
      ft: await count(`select count(*)::int c from financial_transactions where jar_id=$1`, [g.ownedJarId]),
      entries: await count(`select count(*)::int c from ledger_entries where ledger_transaction_id=$1`, [g.ledgerTxId]),
      fund: await count(`select count(*)::int c from fund_commitments where jar_id=$1`, [g.ownedJarId]),
      refunds: await count(`select count(*)::int c from refund_requests where jar_id=$1`, [g.ownedJarId]),
      autodrip: await count(`select count(*)::int c from autodrip_authorizations where jar_id=$1`, [g.ownedJarId]),
      runs: await count(`select count(*)::int c from autodrip_runs where autodrip_authorization_id=$1`, [g.autodripAuthId]),
      allocs: await count(`select count(*)::int c from milestone_allocations where milestone_id=$1`, [g.milestoneId]),
      notes: await count(`select count(*)::int c from notifications where related_jar_id=$1`, [g.ownedJarId]),
      jars: await count(`select count(*)::int c from jars where id=$1`, [g.ownedJarId]),
    }).toEqual(before);

    // The cycle must be restored too — ledger_id was nulled inside the aborted tx.
    const ft = await q(`select ledger_id from financial_transactions where id=$1`, [g.ftId]);
    expect(ft[0].ledger_id).toBe(g.ledgerTxId);
  });
});
