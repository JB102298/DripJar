/**
 * Refundability is independent of jar lifecycle.
 *
 * `POST /jars/:jarId/refunds` used to require `jar.status === "Saving"`.
 * `GET /jars/:jarId/refunds/preview` never had that gate. So a cancelled jar
 * showed every member the balance they had paid in and then refused to return
 * it — the two endpoints disagreed, and the disagreement stranded real money.
 *
 * The rule these tests pin: a member's uncommitted principal is theirs until
 * THEY commit it. No phase label — CommitmentPending, FullyFunded, Cancelled,
 * Completed — may convert uncommitted principal into committed principal.
 *
 * Both endpoints now share `getRefundableLots`, so they cannot disagree, and
 * both authorize on historical membership rather than active membership, so
 * leaving a jar does not forfeit your own money.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { db, pool, jars, jarMembers, financialTransactions } from "@workspace/db";
import { eq, and } from "drizzle-orm";

vi.mock("../lib/stripe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/stripe.js")>();
  return { ...actual, getStripeClient: vi.fn() };
});

import { getStripeClient } from "../lib/stripe.js";
import app from "../app.js";
import { postContributionAccounting, clearLedgerAccountCache } from "../lib/ledger.js";
// The dependency-aware cleanup primitive — the same ordered delete plan the
// owner reset uses. Never `DELETE FROM users`: four FKs into `users` are
// NO ACTION and would raise, leaving fixtures behind.
import { purgeSyntheticAccounts } from "../lib/owner-reset.js";
import { withGlobalSweepExclusion } from "./support/fixtures.js";

const BASE = "/api";
const mockGetStripeClient = vi.mocked(getStripeClient);

/**
 * One tag for the whole file, fixed before any fixture is built.
 *
 * Teardown resolves fixtures by querying for this tag, never from a value a
 * setup helper returned. A helper that throws half-way through still leaves
 * findable rows, which is exactly when cleanup matters most — the Phase 1
 * financial suite leaked fourteen accounts precisely because its teardown took
 * the object the builder was supposed to return.
 */
const FIXTURE_TAG = `rlc${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const TAGGED_EMAIL_LIKE = `%-${FIXTURE_TAG}@test.invalid`;
const TAGGED_JAR_LIKE = `%${FIXTURE_TAG}%`;

let uniqCounter = 0;
const uniq = () => `${++uniqCounter}`;
/** Every fixture email carries the tag as its final segment. */
const taggedEmail = (suffix: string) => `refund-lc-${suffix}${uniq()}-${FIXTURE_TAG}@test.invalid`;

let refundCounter = 0;
function mockStripe() {
  return {
    refunds: {
      create: vi.fn().mockImplementation(async () => ({
        id: `re_lc_${++refundCounter}_${Date.now()}`,
        status: "pending",
        amount: 10_000,
        currency: "usd",
      })),
    },
  } as unknown as ReturnType<typeof getStripeClient>;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

async function register(suffix: string) {
  const res = await request(app).post(`${BASE}/auth/register`).send({
    email: taggedEmail(suffix),
    password: "P@ssword1!",
    firstName: "Refund",
    lastName: "Lifecycle",
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { token: res.body.token as string, userId: res.body.user.id as string };
}

/** Jar names also carry the tag, so a jar whose organizer never got created is still findable. */
async function createLaunchedJar(token: string, name: string) {
  const create = await request(app).post(`${BASE}/jars`).set("Authorization", `Bearer ${token}`).send({
    name: `${name} ${FIXTURE_TAG} ${uniq()}`,
    category: "Vacation",
    goalAmountCents: 1_000_000,
    targetDate: new Date(Date.now() + 120 * 86_400_000).toISOString().slice(0, 10),
  });
  expect(create.status, JSON.stringify(create.body)).toBe(201);
  const jarId = create.body.id as string;
  const launch = await request(app).post(`${BASE}/jars/${jarId}/launch`).set("Authorization", `Bearer ${token}`);
  expect(launch.status, JSON.stringify(launch.body)).toBe(200);
  return jarId;
}

async function memberIdFor(jarId: string, userId: string) {
  const [m] = await db
    .select({ id: jarMembers.id })
    .from(jarMembers)
    .where(and(eq(jarMembers.jarId, jarId), eq(jarMembers.userId, userId)));
  return m!.id;
}

/** A settled, posted contribution lot — the shape refunds draw from. */
async function seedSettledLot(jarId: string, memberId: string, principalCents: number) {
  clearLedgerAccountCache();
  const r = await postContributionAccounting({
    jarId,
    memberId,
    principalCents,
    estimatedProcessingFeeCents: 0,
  });
  await db
    .update(financialTransactions)
    .set({ providerType: "stripe", providerStatus: "succeeded", providerTransactionId: `pi_lc_${uniq()}_${Date.now()}` })
    .where(eq(financialTransactions.id, r.financialTransactionId));
  return r.financialTransactionId;
}

/**
 * Explicitly commit `cents` of a specific lot.
 *
 * Raw SQL rather than drizzle inserts: several of these columns are `bigint`,
 * and the point of the fixture is the FK shape, not the ORM's numeric mapping.
 */
async function commitLot(jarId: string, memberId: string, ftId: string, cents: number) {
  const ag = (await pool.query(
    `insert into agreements (jar_id, version, content, effective_date)
     values ($1,'2.0','fixture agreement','2026-01-01') returning id`,
    [jarId],
  )).rows[0].id as string;

  const snap = (await pool.query(
    `insert into commitment_snapshots
       (jar_id, member_id, agreement_id, agreement_version, snapshot_token, total_principal_cents, expires_at)
     values ($1,$2,$3,'2.0',$4,$5, now() + interval '1 day') returning id`,
    [jarId, memberId, ag, `snap-${FIXTURE_TAG}-${uniq()}`, cents],
  )).rows[0].id as string;

  const fc = (await pool.query(
    `insert into fund_commitments
       (jar_id, member_id, snapshot_id, agreement_id, agreement_version, total_committed_cents)
     values ($1,$2,$3,$4,'2.0',$5) returning id`,
    [jarId, memberId, snap, ag, cents],
  )).rows[0].id as string;

  await pool.query(
    `insert into commitment_allocations (fund_commitment_id, source_ft_id, allocated_cents)
     values ($1,$2,$3)`,
    [fc, ftId, cents],
  );
}

const setStatus = (jarId: string, status: string) =>
  db.update(jars).set({ status, updatedAt: new Date() }).where(eq(jars.id, jarId));

const preview = (jarId: string, token: string) =>
  request(app).get(`${BASE}/jars/${jarId}/refunds/preview`).set("Authorization", `Bearer ${token}`);

const requestRefund = (jarId: string, token: string, amountCents: number) =>
  request(app).post(`${BASE}/jars/${jarId}/refunds`).set("Authorization", `Bearer ${token}`).send({ amountCents });

// ─── Orphan baseline ─────────────────────────────────────────────────────────

const countRow = async (sql: string, params: unknown[] = []) =>
  Number((await pool.query(sql, params)).rows[0].c);

const ORPHAN_SQL = {
  ledgerEntries: `select count(*)::int c from ledger_entries le
                    left join ledger_transactions lt on lt.id = le.ledger_transaction_id
                   where lt.id is null`,
  ledgerTransactions: `select count(*)::int c from ledger_transactions lt
                    left join financial_transactions ft on ft.id = lt.financial_transaction_id
                   where ft.id is null`,
  financialTransactions: `select count(*)::int c from financial_transactions ft
                    left join jars j on j.id = ft.jar_id where j.id is null`,
} as const;

let orphanBaseline: Record<string, number>;

beforeAll(async () => {
  mockGetStripeClient.mockReturnValue(mockStripe());
  // Recorded, not assumed to be zero — this database carries pre-existing rows
  // from other suites, and this file is only answerable for its own delta.
  orphanBaseline = {
    ledgerEntries: await countRow(ORPHAN_SQL.ledgerEntries),
    ledgerTransactions: await countRow(ORPHAN_SQL.ledgerTransactions),
    financialTransactions: await countRow(ORPHAN_SQL.financialTransactions),
  };
});

afterAll(async () => {
  // try/finally so the mocks are restored even if the purge throws or an
  // assertion below fails — a leaked Stripe stub would corrupt later suites in
  // the same worker. On the successful path the database work still happens
  // first, which is what the cleanup needs.
  try {
    // 1. Resolve fixtures by TAG, independent of whether any setup returned.
    const tagged = (
      await pool.query(`select email from users where email like $1 order by email`, [TAGGED_EMAIL_LIKE])
    ).rows.map((r) => r.email as string);

    // 2. Dependency-aware purge: walks the FK-derived delete plan (financial,
    //    ledger, agreement, commitment, refund, notification, activity,
    //    membership, jar) inside one transaction, then removes the user. The
    //    tagged list doubles as its own allowlist, so no seeded or live account
    //    is reachable from here.
    if (tagged.length) {
      await withGlobalSweepExclusion(() =>
        purgeSyntheticAccounts(tagged, { approvedEmails: tagged, quiet: true }),
      );
    }

    // 3. Nothing tagged may remain — jars first, since a failed setup can leave
    //    a jar whose organizer was never created.
    expect(
      await countRow(`select count(*)::int c from jars where name like $1`, [TAGGED_JAR_LIKE]),
      "tagged jars survived the purge",
    ).toBe(0);

    expect(
      await countRow(`select count(*)::int c from users where email like $1`, [TAGGED_EMAIL_LIKE]),
      "tagged users survived the purge",
    ).toBe(0);

    // 4. No NEW orphans. Pre-existing rows from other suites are preserved
    //    rather than "cleaned up" — this file answers only for its own delta.
    for (const key of Object.keys(ORPHAN_SQL) as (keyof typeof ORPHAN_SQL)[]) {
      expect(await countRow(ORPHAN_SQL[key]), `${key} orphans increased`).toBe(orphanBaseline[key]);
    }
  } finally {
    vi.restoreAllMocks();
  }
});

// ─────────────────────────────────────────────────────────────────────────────

describe("uncommitted principal is refundable in every jar status", () => {
  it.each(["Saving", "CommitmentPending", "FullyFunded", "Cancelled", "Completed"])(
    "%s: a member can recover their own uncommitted principal",
    async (status) => {
      const owner = await register(`st${status}`);
      const jarId = await createLaunchedJar(owner.token, `Status ${status}`);
      const memberId = await memberIdFor(jarId, owner.userId);
      await seedSettledLot(jarId, memberId, 25_000);
      await setStatus(jarId, status);

      const p = await preview(jarId, owner.token);
      expect(p.status, JSON.stringify(p.body)).toBe(200);
      expect(p.body.refundableCents).toBe(25_000);

      const r = await requestRefund(jarId, owner.token, 10_000);
      expect(r.status, `${status}: ${JSON.stringify(r.body)}`).toBe(201);
    },
  );
});

describe("committed principal is never refundable, in any status", () => {
  it.each(["Saving", "Cancelled", "Completed"])("%s: fully committed leaves nothing to refund", async (status) => {
    const owner = await register(`cm${status}`);
    const jarId = await createLaunchedJar(owner.token, `Committed ${status}`);
    const memberId = await memberIdFor(jarId, owner.userId);
    const ftId = await seedSettledLot(jarId, memberId, 30_000);
    await commitLot(jarId, memberId, ftId, 30_000);
    await setStatus(jarId, status);

    const p = await preview(jarId, owner.token);
    expect(p.body.refundableCents).toBe(0);

    const r = await requestRefund(jarId, owner.token, 1_000);
    expect(r.status).toBe(422);
    expect(r.body.error).toBe("NoRefundableBalance");
  });

  it("mixed lots refund only the uncommitted remainder", async () => {
    const owner = await register("mixed");
    const jarId = await createLaunchedJar(owner.token, "Mixed");
    const memberId = await memberIdFor(jarId, owner.userId);
    const committedFt = await seedSettledLot(jarId, memberId, 40_000);
    await seedSettledLot(jarId, memberId, 15_000);
    await commitLot(jarId, memberId, committedFt, 40_000);
    await setStatus(jarId, "Cancelled");

    const p = await preview(jarId, owner.token);
    expect(p.body.refundableCents).toBe(15_000);

    // The committed 40k must stay out of reach even when explicitly requested.
    const tooMuch = await requestRefund(jarId, owner.token, 55_000);
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.error).toBe("InsufficientBalance");

    const ok = await requestRefund(jarId, owner.token, 15_000);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });
});

describe("authorization is historical membership, not active membership", () => {
  it("a former member can still recover their own uncommitted principal", async () => {
    const owner = await register("fmowner");
    const jarId = await createLaunchedJar(owner.token, "Former");
    const memberId = await memberIdFor(jarId, owner.userId);
    await seedSettledLot(jarId, memberId, 20_000);

    // The member leaves / is deactivated. Their money does not leave with them.
    await db.update(jarMembers).set({ status: "left" }).where(eq(jarMembers.id, memberId));

    const p = await preview(jarId, owner.token);
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.refundableCents).toBe(20_000);

    const r = await requestRefund(jarId, owner.token, 20_000);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it("an unrelated user with no membership row is refused", async () => {
    const owner = await register("outowner");
    const outsider = await register("outstranger");
    const jarId = await createLaunchedJar(owner.token, "Outsider");
    const memberId = await memberIdFor(jarId, owner.userId);
    await seedSettledLot(jarId, memberId, 12_000);
    await setStatus(jarId, "Cancelled");

    expect((await preview(jarId, outsider.token)).status).toBe(403);
    const r = await requestRefund(jarId, outsider.token, 5_000);
    expect(r.status).toBe(403);

    // And the owner's balance is untouched by the attempt.
    expect((await preview(jarId, owner.token)).body.refundableCents).toBe(12_000);
  });
});

describe("preview and request cannot disagree", () => {
  it.each(["Saving", "CommitmentPending", "Cancelled", "Completed"])(
    "%s: whatever preview reports is what request honours",
    async (status) => {
      const owner = await register(`ag${status}`);
      const jarId = await createLaunchedJar(owner.token, `Agree ${status}`);
      const memberId = await memberIdFor(jarId, owner.userId);
      await seedSettledLot(jarId, memberId, 18_000);
      await setStatus(jarId, status);

      const p = await preview(jarId, owner.token);
      const refundable = p.body.refundableCents as number;
      expect(refundable).toBe(18_000);

      // Exactly the previewed amount succeeds …
      const exact = await requestRefund(jarId, owner.token, refundable);
      expect(exact.status, `${status}: ${JSON.stringify(exact.body)}`).toBe(201);

      // … and one cent beyond it does not.
      const over = await requestRefund(jarId, owner.token, 1);
      expect(over.status).toBe(422);
    },
  );

  it("neither endpoint reports a PhaseGate any more", async () => {
    const owner = await register("nogate");
    const jarId = await createLaunchedJar(owner.token, "No Gate");
    const memberId = await memberIdFor(jarId, owner.userId);
    await seedSettledLot(jarId, memberId, 9_000);
    await setStatus(jarId, "Cancelled");

    const r = await requestRefund(jarId, owner.token, 9_000);
    expect(r.body.error).not.toBe("PhaseGate");
    expect(JSON.stringify(r.body)).not.toMatch(/Saving or Commitment phase/);
  });
});

describe("lots cannot be double-refunded", () => {
  it("a second request cannot draw on principal the first already took", async () => {
    const owner = await register("double");
    const jarId = await createLaunchedJar(owner.token, "Double");
    const memberId = await memberIdFor(jarId, owner.userId);
    await seedSettledLot(jarId, memberId, 20_000);
    await setStatus(jarId, "Cancelled");

    const first = await requestRefund(jarId, owner.token, 20_000);
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    // The balance is consumed; a repeat must find nothing.
    const p = await preview(jarId, owner.token);
    expect(p.body.refundableCents).toBe(0);

    const second = await requestRefund(jarId, owner.token, 20_000);
    expect(second.status).toBe(422);
    expect(["NoRefundableBalance", "InsufficientBalance"]).toContain(second.body.error);
  });
});

describe("no refundable balance is reported clearly", () => {
  it("returns NoRefundableBalance rather than a phase complaint", async () => {
    const owner = await register("empty");
    const jarId = await createLaunchedJar(owner.token, "Empty");
    await setStatus(jarId, "Cancelled");

    const r = await requestRefund(jarId, owner.token, 5_000);
    expect(r.status).toBe(422);
    expect(r.body.error).toBe("NoRefundableBalance");
    expect(r.body.refundableCents).toBe(0);
    expect(r.body.message).toMatch(/no uncommitted principal/i);
  });
});
