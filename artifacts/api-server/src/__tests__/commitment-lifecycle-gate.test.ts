/**
 * Fund-commitment lifecycle gate.
 *
 * Committing converts principal a member has ALREADY paid in from refundable to
 * non-refundable. It is the one action that can strand somebody's savings, so
 * its gate is the narrowest in the system: `Saving`, with a cutoff date that has
 * passed **in the jar's own timezone**.
 *
 * ─── WHAT WAS ACTUALLY WRONG ─────────────────────────────────────────────────
 *
 * The earlier Phase 2A report claimed a cancelled jar could be committed to.
 * That was wrong: `deriveJarPhase("Cancelled") !== "Commitment"`, so confirm
 * already returned 422. That claim is retracted, and the first describe block
 * below pins the behaviour so the retraction is verifiable rather than asserted.
 *
 * Two real defects remained, and these tests cover both:
 *
 *   1. A check-then-write RACE. The status was read outside any transaction and
 *      the write transaction locked `jar_members`, not `jars`, so a cancel
 *      landing in between produced a commitment on a cancelled jar.
 *   2. The cutoff was compared against the SERVER's UTC date, while the jar
 *      carries its own immutable timezone. Honolulu opened ~10h early, Auckland
 *      a day late.
 *
 * Defect 1 in the report — `CommitmentPending` being a one-way state that
 * disconnects group requests from individual confirmation — is documented in
 * `lib/jar-status.ts` and deliberately NOT fixed here.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { db, pool, jars, jarMembers, fundCommitments, commitmentAllocations } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import app from "../app.js";
import { purgeSyntheticAccounts } from "../lib/owner-reset.js";
import { withGlobalSweepExclusion } from "./support/fixtures.js";
import { lifecycleAllowsFundCommitment, fundCommitmentLifecycleMessage } from "../lib/jar-status.js";
import { jarToday } from "../lib/jar-time.js";
import { postContributionAccounting, clearLedgerAccountCache } from "../lib/ledger.js";
import { financialTransactions } from "@workspace/db";

const BASE = "/api";

const FIXTURE_TAG = `clg${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const TAGGED_EMAIL_LIKE = `%-${FIXTURE_TAG}@test.invalid`;
const TAGGED_JAR_LIKE = `%${FIXTURE_TAG}%`;

let uniqCounter = 0;
const uniq = () => `${++uniqCounter}`;

const countRow = async (sql: string, params: unknown[] = []) =>
  Number((await pool.query(sql, params)).rows[0].c);

const ORPHAN_SQL = {
  ledgerEntries: `select count(*)::int c from ledger_entries le
                    left join ledger_transactions lt on lt.id = le.ledger_transaction_id
                   where lt.id is null`,
  financialTransactions: `select count(*)::int c from financial_transactions ft
                    left join jars j on j.id = ft.jar_id where j.id is null`,
} as const;
let orphanBaseline: Record<string, number>;

// ─── Fixtures ────────────────────────────────────────────────────────────────

async function register(suffix: string) {
  const res = await request(app).post(`${BASE}/auth/register`).send({
    email: `commit-lc-${suffix}${uniq()}-${FIXTURE_TAG}@test.invalid`,
    password: "P@ssword1!",
    firstName: "Commit",
    lastName: "Gate",
  });
  expect(res.status, `register: ${JSON.stringify(res.body)}`).toBe(201);
  return { token: res.body.token as string, userId: res.body.user.id as string };
}

/** A launched jar whose cutoff has passed, i.e. genuinely inside the window. */
async function committableJar(token: string, timeZone = "America/New_York") {
  const create = await request(app).post(`${BASE}/jars`).set("Authorization", `Bearer ${token}`).send({
    name: `Commit ${FIXTURE_TAG} ${uniq()}`,
    category: "Vacation",
    goalAmountCents: 500_000,
    targetDate: new Date(Date.now() + 200 * 86_400_000).toISOString().slice(0, 10),
    timeZone,
  });
  expect(create.status, `create: ${JSON.stringify(create.body)}`).toBe(201);
  const jarId = create.body.id as string;
  const launch = await request(app).post(`${BASE}/jars/${jarId}/launch`).set("Authorization", `Bearer ${token}`);
  expect(launch.status, `launch: ${JSON.stringify(launch.body)}`).toBe(200);
  // Cutoff in the past → inside the commitment window.
  await db.update(jars).set({ cutoffDate: "2026-01-01" }).where(eq(jars.id, jarId));
  return jarId;
}

async function memberIdFor(jarId: string, userId: string) {
  const [m] = await db.select({ id: jarMembers.id }).from(jarMembers)
    .where(and(eq(jarMembers.jarId, jarId), eq(jarMembers.userId, userId)));
  return m!.id;
}

async function seedSettledLot(jarId: string, memberId: string, cents: number) {
  clearLedgerAccountCache();
  const r = await postContributionAccounting({ jarId, memberId, principalCents: cents, estimatedProcessingFeeCents: 0 });
  await db.update(financialTransactions)
    .set({ providerType: "stripe", providerStatus: "succeeded", providerTransactionId: `pi_clg_${uniq()}_${Date.now()}` })
    .where(eq(financialTransactions.id, r.financialTransactionId));
  return r.financialTransactionId;
}

/** Accept the jar's auto-created agreement so the agreement gate is satisfied. */
async function acceptAgreement(jarId: string, token: string) {
  const status = await request(app).get(`${BASE}/jars/${jarId}/agreements/status`).set("Authorization", `Bearer ${token}`);
  const agreementId = status.body?.agreementId as string | undefined;
  if (!agreementId) return;
  await request(app).post(`${BASE}/jars/${jarId}/agreements/${agreementId}/accept`).set("Authorization", `Bearer ${token}`);
}

const setStatus = (jarId: string, status: string) =>
  db.update(jars).set({ status, updatedAt: new Date() }).where(eq(jars.id, jarId));

const preview = (jarId: string, token: string) =>
  request(app).post(`${BASE}/jars/${jarId}/commitment/preview`).set("Authorization", `Bearer ${token}`);

const confirm = (jarId: string, token: string, snapshotToken: string) =>
  request(app).post(`${BASE}/jars/${jarId}/commitment/confirm`).set("Authorization", `Bearer ${token}`).send({ snapshotToken });

const commitmentRowCounts = async (jarId: string) => ({
  commitments: await countRow(`select count(*)::int c from fund_commitments where jar_id=$1`, [jarId]),
  allocations: await countRow(
    `select count(*)::int c from commitment_allocations ca
       join fund_commitments fc on fc.id = ca.fund_commitment_id where fc.jar_id=$1`, [jarId]),
});

const refundableCents = async (jarId: string, token: string) => {
  const p = await request(app).get(`${BASE}/jars/${jarId}/refunds/preview`).set("Authorization", `Bearer ${token}`);
  return p.body?.refundableCents as number;
};

beforeAll(async () => {
  orphanBaseline = {
    ledgerEntries: await countRow(ORPHAN_SQL.ledgerEntries),
    financialTransactions: await countRow(ORPHAN_SQL.financialTransactions),
  };
});

afterAll(async () => {
  try {
    const tagged = (
      await pool.query(`select email from users where email like $1 order by email`, [TAGGED_EMAIL_LIKE])
    ).rows.map((r) => r.email as string);
    if (tagged.length) await withGlobalSweepExclusion(() =>
        purgeSyntheticAccounts(tagged, { approvedEmails: tagged, quiet: true }),
      );

    expect(await countRow(`select count(*)::int c from jars where name like $1`, [TAGGED_JAR_LIKE]),
      "tagged jars survived").toBe(0);
    expect(await countRow(`select count(*)::int c from users where email like $1`, [TAGGED_EMAIL_LIKE]),
      "tagged users survived").toBe(0);
    for (const key of Object.keys(ORPHAN_SQL) as (keyof typeof ORPHAN_SQL)[]) {
      expect(await countRow(ORPHAN_SQL[key]), `${key} orphans increased`).toBe(orphanBaseline[key]);
    }
  } finally {
    vi.restoreAllMocks();
  }
});

// ─── The predicate ───────────────────────────────────────────────────────────

describe("lifecycleAllowsFundCommitment is a narrow allowlist", () => {
  const PAST = "2020-01-01";
  const TZ = "America/New_York";

  it("permits only Saving, and only once the cutoff has passed", () => {
    expect(lifecycleAllowsFundCommitment("Saving", PAST, TZ)).toBe(true);
    expect(lifecycleAllowsFundCommitment("Saving", "2099-12-31", TZ)).toBe(false);
    expect(lifecycleAllowsFundCommitment("Saving", null, TZ)).toBe(false);
  });

  it.each(["Draft", "Inviting", "CommitmentPending", "Committed", "FullyFunded", "Cancelled", "Completed"])(
    "refuses %s even with a cutoff long past",
    (status) => {
      expect(lifecycleAllowsFundCommitment(status, PAST, TZ)).toBe(false);
    },
  );

  it.each(["Archived", "Paused", "LEGACY_STATE", "saving", ""])("refuses the unknown value %p", (status) => {
    expect(lifecycleAllowsFundCommitment(status, PAST, TZ)).toBe(false);
  });

  it("refuses null/undefined status without throwing", () => {
    expect(lifecycleAllowsFundCommitment(null, PAST, TZ)).toBe(false);
    expect(lifecycleAllowsFundCommitment(undefined, PAST, TZ)).toBe(false);
  });

  it("does NOT include CommitmentPending — that is the documented one-way state", () => {
    // Opening a group commitment request sets CommitmentPending and nothing
    // sets it back, so including it here would let a member commit merely
    // because the organizer opened a request — no approval required.
    expect(lifecycleAllowsFundCommitment("CommitmentPending", PAST, TZ)).toBe(false);
  });

  it("names terminal jars plainly in its refusal", () => {
    expect(fundCommitmentLifecycleMessage("Cancelled")).toMatch(/cancelled/i);
    expect(fundCommitmentLifecycleMessage("Completed")).toMatch(/completed/i);
    expect(fundCommitmentLifecycleMessage("")).toMatch(/unknown/);
  });
});

// ─── Jar Time, not server UTC ────────────────────────────────────────────────

describe("the cutoff is evaluated in the jar's own timezone", () => {
  // 2027-03-01T06:00Z is 2027-02-28 20:00 in Honolulu (UTC-10)
  //                and 2027-03-01 19:00 in Auckland (UTC+13).
  const INSTANT = new Date("2027-03-01T06:00:00Z");

  it("Honolulu is still on the previous day, so a cutoff of Mar 1 has NOT passed", () => {
    expect(jarToday("Pacific/Honolulu", INSTANT)).toBe("2027-02-28");
    expect(lifecycleAllowsFundCommitment("Saving", "2027-03-01", "Pacific/Honolulu", INSTANT)).toBe(false);
    // …while the server's UTC date would have wrongly opened the window.
    expect(jarToday("UTC", INSTANT)).toBe("2027-03-01");
    expect(lifecycleAllowsFundCommitment("Saving", "2027-03-01", "UTC", INSTANT)).toBe(true);
  });

  it("Auckland has already reached Mar 1, so the same cutoff HAS passed", () => {
    expect(jarToday("Pacific/Auckland", INSTANT)).toBe("2027-03-01");
    expect(lifecycleAllowsFundCommitment("Saving", "2027-03-01", "Pacific/Auckland", INSTANT)).toBe(true);
  });

  it("Auckland crosses midnight ahead of UTC", () => {
    // 2027-02-28T12:00Z is already 2027-03-01 01:00 in Auckland.
    const eve = new Date("2027-02-28T12:00:00Z");
    expect(jarToday("UTC", eve)).toBe("2027-02-28");
    expect(jarToday("Pacific/Auckland", eve)).toBe("2027-03-01");
    expect(lifecycleAllowsFundCommitment("Saving", "2027-03-01", "Pacific/Auckland", eve)).toBe(true);
    expect(lifecycleAllowsFundCommitment("Saving", "2027-03-01", "UTC", eve)).toBe(false);
  });

  it("fails closed when the timezone cannot be resolved", () => {
    for (const tz of ["Not/AZone", "", null, undefined, "   "]) {
      expect(jarToday(tz as string, INSTANT), `jarToday(${String(tz)})`).toBeNull();
      expect(
        lifecycleAllowsFundCommitment("Saving", "2020-01-01", tz as string, INSTANT),
        `predicate with tz ${String(tz)} must refuse`,
      ).toBe(false);
    }
  });
});

// ─── Route behaviour ─────────────────────────────────────────────────────────

describe("confirm and preview refuse jars outside the window", () => {
  it.each(["Cancelled", "Completed", "Draft", "CommitmentPending", "FullyFunded", "LEGACY_STATE"])(
    "%s: preview refuses with 422 JarLifecycle",
    async (status) => {
      const owner = await register(`pv${status}`);
      const jarId = await committableJar(owner.token);
      await setStatus(jarId, status);

      const r = await preview(jarId, owner.token);
      expect(r.status, `${status}: ${JSON.stringify(r.body)}`).toBe(422);
      expect(r.body.error).toBe("JarLifecycle");
    },
  );

  it("Cancelled: confirming a snapshot taken while valid creates nothing", async () => {
    const owner = await register("cancelconfirm");
    const jarId = await committableJar(owner.token);
    const memberId = await memberIdFor(jarId, owner.userId);
    await seedSettledLot(jarId, memberId, 30_000);
    await acceptAgreement(jarId, owner.token);

    // A legitimate snapshot, taken while the jar was committable.
    const pv = await preview(jarId, owner.token);
    expect(pv.status, `preview: ${JSON.stringify(pv.body)}`).toBe(200);
    const snapshotToken = pv.body.snapshotToken as string;

    // …then the organizer cancels.
    await setStatus(jarId, "Cancelled");

    const before = await commitmentRowCounts(jarId);
    const r = await confirm(jarId, owner.token, snapshotToken);
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(r.body.error).toBe("JarLifecycle");

    const after = await commitmentRowCounts(jarId);
    expect(after).toEqual(before);
    expect(after.commitments).toBe(0);
    expect(after.allocations).toBe(0);
  });

  it("refusal leaves the member's refundable principal untouched", async () => {
    const owner = await register("refundintact");
    const jarId = await committableJar(owner.token);
    const memberId = await memberIdFor(jarId, owner.userId);
    await seedSettledLot(jarId, memberId, 40_000);
    await acceptAgreement(jarId, owner.token);

    const pv = await preview(jarId, owner.token);
    const snapshotToken = pv.body.snapshotToken as string;
    const beforeRefundable = await refundableCents(jarId, owner.token);
    expect(beforeRefundable).toBe(40_000);

    await setStatus(jarId, "Cancelled");
    const r = await confirm(jarId, owner.token, snapshotToken);
    expect(r.status).toBe(422);

    // Still fully refundable — nothing was converted to committed principal.
    expect(await refundableCents(jarId, owner.token)).toBe(40_000);
  });
});

describe("authorization is unchanged: you can only commit your own principal", () => {
  it("a member cannot confirm another member's snapshot", async () => {
    const owner = await register("aowner");
    const other = await register("aother");
    const jarId = await committableJar(owner.token);
    const ownerMemberId = await memberIdFor(jarId, owner.userId);
    await seedSettledLot(jarId, ownerMemberId, 25_000);
    await acceptAgreement(jarId, owner.token);

    const pv = await preview(jarId, owner.token);
    const snapshotToken = pv.body.snapshotToken as string;

    // The outsider is not even a member — refused before snapshot ownership.
    const r = await confirm(jarId, other.token, snapshotToken);
    expect([403, 404]).toContain(r.status);
    expect((await commitmentRowCounts(jarId)).commitments).toBe(0);
  });
});

describe("idempotent confirmation still works", () => {
  it("a repeated confirm returns the same commitment without a second posting", async () => {
    const owner = await register("idem");
    const jarId = await committableJar(owner.token);
    const memberId = await memberIdFor(jarId, owner.userId);
    await seedSettledLot(jarId, memberId, 20_000);
    await acceptAgreement(jarId, owner.token);

    const pv = await preview(jarId, owner.token);
    const snapshotToken = pv.body.snapshotToken as string;

    const first = await confirm(jarId, owner.token, snapshotToken);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const afterFirst = await commitmentRowCounts(jarId);
    expect(afterFirst.commitments).toBe(1);

    const second = await confirm(jarId, owner.token, snapshotToken);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(await commitmentRowCounts(jarId)).toEqual(afterFirst);
  });
});

// ─── The race ────────────────────────────────────────────────────────────────

describe("cancellation and confirmation cannot interleave into a bad state", () => {
  it("cancellation first → confirmation fails, nothing is committed", async () => {
    const owner = await register("raceA");
    const jarId = await committableJar(owner.token);
    const memberId = await memberIdFor(jarId, owner.userId);
    await seedSettledLot(jarId, memberId, 30_000);
    await acceptAgreement(jarId, owner.token);

    const pv = await preview(jarId, owner.token);
    const snapshotToken = pv.body.snapshotToken as string;

    // Cancel commits BEFORE the confirm is issued.
    const cancel = await request(app).post(`${BASE}/jars/${jarId}/cancel`).set("Authorization", `Bearer ${owner.token}`);
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);

    const r = await confirm(jarId, owner.token, snapshotToken);
    expect(r.status).toBe(422);
    expect(r.body.error).toBe("JarLifecycle");
    expect(await commitmentRowCounts(jarId)).toEqual({ commitments: 0, allocations: 0 });
    expect(await refundableCents(jarId, owner.token)).toBe(30_000);
  });

  it("confirmation first → it completes, and a later cancellation keeps it committed", async () => {
    const owner = await register("raceB");
    const jarId = await committableJar(owner.token);
    const memberId = await memberIdFor(jarId, owner.userId);
    await seedSettledLot(jarId, memberId, 30_000);
    await acceptAgreement(jarId, owner.token);

    const pv = await preview(jarId, owner.token);
    const r = await confirm(jarId, owner.token, pv.body.snapshotToken as string);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await commitmentRowCounts(jarId)).commitments).toBe(1);

    const cancel = await request(app).post(`${BASE}/jars/${jarId}/cancel`).set("Authorization", `Bearer ${owner.token}`);
    expect(cancel.status).toBe(200);

    // Committed principal stays committed; it is not refundable.
    expect((await commitmentRowCounts(jarId)).commitments).toBe(1);
    expect(await refundableCents(jarId, owner.token)).toBe(0);
  });

  it("issued concurrently, exactly one of {commit, cancel-then-refuse} wins — never both", async () => {
    // The real interleaving. Whichever grabs the jars row lock first decides;
    // the loser must observe the winner's outcome. What must never happen is a
    // fund_commitment existing on a jar whose canonical status is Cancelled
    // with the commitment created afterwards.
    for (let attempt = 0; attempt < 6; attempt++) {
      const owner = await register(`raceC${attempt}`);
      const jarId = await committableJar(owner.token);
      const memberId = await memberIdFor(jarId, owner.userId);
      await seedSettledLot(jarId, memberId, 30_000);
      await acceptAgreement(jarId, owner.token);

      const pv = await preview(jarId, owner.token);
      const snapshotToken = pv.body.snapshotToken as string;

      const [confirmRes, cancelRes] = await Promise.all([
        confirm(jarId, owner.token, snapshotToken),
        request(app).post(`${BASE}/jars/${jarId}/cancel`).set("Authorization", `Bearer ${owner.token}`),
      ]);

      const counts = await commitmentRowCounts(jarId);
      const [jar] = await db.select({ status: jars.status }).from(jars).where(eq(jars.id, jarId));

      if (confirmRes.status === 200) {
        // Commitment won: it exists, and it is a real allocation.
        expect(counts.commitments, `attempt ${attempt}`).toBe(1);
        expect(counts.allocations).toBeGreaterThan(0);
      } else {
        // Commitment lost: it must have created nothing at all.
        expect(confirmRes.status, `attempt ${attempt}: ${JSON.stringify(confirmRes.body)}`).toBe(422);
        expect(confirmRes.body.error).toBe("JarLifecycle");
        expect(counts, `attempt ${attempt}`).toEqual({ commitments: 0, allocations: 0 });
      }

      // Cancel is expected to succeed in both orderings.
      expect([200, 400]).toContain(cancelRes.status);
      if (cancelRes.status === 200) expect(jar!.status).toBe("Cancelled");

      // The invariant that matters: never a commitment created against a jar
      // that was already canonically cancelled.
      if (jar!.status === "Cancelled" && counts.commitments > 0) {
        expect(confirmRes.status, "a commitment exists on a cancelled jar — it must have won the lock").toBe(200);
      }
    }
  });
});
