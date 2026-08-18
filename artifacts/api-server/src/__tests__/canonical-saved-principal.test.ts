/**
 * Canonical saved principal — Owner QA items 2 and 3
 *
 * Home showed $7,274 / 72.7% / "Ahead of Schedule" for Hawaii 2027 while Jar
 * Overview showed $0 / 0% / "At Risk" for the same jar, and milestone funding
 * summed to $5,778 against a $7,274 jar total.
 *
 * Root cause: two records of money. Jar Detail and Goals read the double-entry
 * ledger; Home, Members, Milestones, and the fully-funded check summed
 * `contributions.amount_cents` under `status IN ('completed','simulated')`.
 * That filter matched only `simulated` rows — `completed` is written by no code
 * path, and `stripe_test` (what the Stripe webhook actually writes for settled
 * money) was missing — so the legacy surfaces reported Test Mode money as real
 * and ignored real money entirely.
 *
 * These tests pin the properties that make the surfaces agree:
 *
 *   1. principal is derived from the ledger, never from contribution status
 *   2. Test Mode principal is reported separately and never counted as saved
 *   3. unsettled transactions contribute nothing
 *   4. refunds — partial, full, and in-flight — reduce saved principal
 *   5. committing principal does not reduce saved principal
 *   6. milestone allocated + unallocated === saved principal, always
 *
 * Property 6 is asserted, not assumed. Exact milestone attribution is not
 * derivable from this schema (the ledger has no milestone dimension, and
 * financial_transactions is not 1:1 with ledger postings), so `unallocatedCents`
 * is defined as the residual and these tests are what prove the identity holds.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@workspace/db";
import {
  jars,
  jarMembers,
  users,
  contributions,
  milestones,
  financialTransactions,
  refundAllocations,
  refundRequests,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  postContributionAccounting,
  postCommitPrincipal,
  postRefundReservationInTx,
  clearLedgerAccountCache,
} from "../lib/ledger.js";
import {
  getJarProgressSummary,
  getJarSavedPrincipalCents,
  getMemberSavedPrincipalCents,
  getMilestoneAllocations,
  computePercentFunded,
} from "../lib/financial-balance.js";

const GOAL_CENTS = 1_000_000;

let piCounter = 0;

async function createJarWithMember(): Promise<{ jarId: string; memberId: string }> {
  const [user] = await db
    .insert(users)
    .values({
      email: `canon-${randomUUID()}@test.invalid`,
      passwordHash: "x",
      emailVerified: true,
    })
    .returning();

  const [jar] = await db
    .insert(jars)
    .values({
      organizerId: user!.id,
      name: "Canonical Jar",
      slug: `canon-${randomUUID()}`,
      targetDate: "2030-12-31",
      goalAmountCents: GOAL_CENTS,
      currency: "USD",
      status: "Saving",
    })
    .returning();

  const [member] = await db
    .insert(jarMembers)
    .values({
      jarId: jar!.id,
      userId: user!.id,
      role: "organizer",
      status: "active",
      contributionTargetCents: GOAL_CENTS,
    })
    .returning();

  return { jarId: jar!.id, memberId: member!.id };
}

/**
 * A settled, ledger-backed Stripe contribution, plus the `contributions` row
 * the webhook writes. `milestoneId` mirrors the real tagging path.
 */
async function seedSettledContribution(
  jarId: string,
  memberId: string,
  principalCents: number,
  milestoneId: string | null = null,
): Promise<{ ftId: string; piId: string }> {
  clearLedgerAccountCache();
  const result = await postContributionAccounting({
    jarId,
    memberId,
    principalCents,
    estimatedProcessingFeeCents: 0,
  });

  const piId = `pi_canon_${++piCounter}_${Date.now()}`;
  await db
    .update(financialTransactions)
    .set({ providerType: "stripe", providerStatus: "succeeded", providerTransactionId: piId })
    .where(eq(financialTransactions.id, result.financialTransactionId));

  await db.insert(contributions).values({
    jarId,
    memberId,
    amountCents: principalCents,
    contributionDate: "2026-01-01",
    status: "stripe_test",
    sourceType: "stripe_test",
    externalPaymentId: piId,
    milestoneId,
  });

  return { ftId: result.financialTransactionId, piId };
}

/** A Test Mode contribution: display row only, deliberately no ledger. */
async function seedSimulatedContribution(
  jarId: string,
  memberId: string,
  amountCents: number,
  milestoneId: string | null = null,
) {
  await db.insert(contributions).values({
    jarId,
    memberId,
    amountCents,
    contributionDate: "2026-01-01",
    status: "simulated",
    sourceType: "manual",
    milestoneId,
  });
}

async function seedMilestone(jarId: string, name: string, targetCents: number): Promise<string> {
  const [ms] = await db
    .insert(milestones)
    .values({ jarId, name, targetAmountCents: targetCents, priority: 1, status: "pending" })
    .returning();
  return ms!.id;
}

/** Reserve a refund against a lot: ledger movement plus the allocation row. */
async function seedRefund(
  jarId: string,
  memberId: string,
  sourceFtId: string,
  amountCents: number,
  providerStatus: string,
) {
  const [rr] = await db
    .insert(refundRequests)
    .values({ jarId, memberId, requestedCents: amountCents, status: "processing" })
    .returning();

  // Posted against `db` rather than inside a transaction: the helper's
  // parameter is typed `typeof db`, and the fixture needs no atomicity.
  await postRefundReservationInTx(db, { jarId, memberId, amountCents });

  await db.insert(refundAllocations).values({
    refundRequestId: rr!.id,
    sourceFtId,
    allocatedCents: amountCents,
    providerStatus,
  });
}

beforeAll(() => {
  clearLedgerAccountCache();
});

// ─── Property 1 & 2: ledger is the source; Test Mode is separate ─────────────

describe("principal derives from the ledger, not contribution status", () => {
  it("counts a settled ledger-backed contribution as saved", async () => {
    const { jarId, memberId } = await createJarWithMember();
    await seedSettledContribution(jarId, memberId, 20_000);

    const summary = await getJarProgressSummary(jarId, GOAL_CENTS);
    expect(summary.savedPrincipalCents).toBe(20_000);
    expect(summary.simulatedPrincipalCents).toBe(0);
  });

  it("never counts a simulated contribution as saved, and reports it separately", async () => {
    const { jarId, memberId } = await createJarWithMember();
    await seedSimulatedContribution(jarId, memberId, 50_000);

    const summary = await getJarProgressSummary(jarId, GOAL_CENTS);

    // This is exactly the Hawaii 2027 shape: Test Mode money present, none of
    // it real. Home used to render this as $500 saved.
    expect(summary.savedPrincipalCents).toBe(0);
    expect(summary.percentFunded).toBe(0);
    expect(summary.simulatedPrincipalCents).toBe(50_000);
  });

  it("keeps real and Test Mode principal separate when both exist", async () => {
    const { jarId, memberId } = await createJarWithMember();
    await seedSettledContribution(jarId, memberId, 20_000);
    await seedSimulatedContribution(jarId, memberId, 50_000);

    const summary = await getJarProgressSummary(jarId, GOAL_CENTS);
    expect(summary.savedPrincipalCents).toBe(20_000);
    expect(summary.simulatedPrincipalCents).toBe(50_000);
  });

  it("member saved principal reconciles with the jar total", async () => {
    const { jarId, memberId } = await createJarWithMember();
    await seedSettledContribution(jarId, memberId, 20_000);
    await seedSimulatedContribution(jarId, memberId, 9_999);

    const jarSaved = await getJarSavedPrincipalCents(jarId);
    const memberSaved = await getMemberSavedPrincipalCents(jarId, memberId);
    expect(memberSaved).toBe(jarSaved);
  });
});

// ─── Property 3: unsettled transactions contribute nothing ───────────────────

describe("unsettled transactions are not principal", () => {
  it("ignores a quoted contribution that never posted to the ledger", async () => {
    const { jarId, memberId } = await createJarWithMember();

    // A quote: financial transaction exists, nothing posted. This is what
    // `POST /drips/payment-intent` leaves behind if the payment never happens.
    await db.insert(financialTransactions).values({
      jarId,
      memberId,
      transactionType: "contribution",
      requestedPrincipalCents: 75_000,
      dripJarFeeCents: 2_250,
      dripJarFeeRateBps: 300,
      totalQuotedCents: 77_250,
      providerType: "stripe",
      providerStatus: "quoted",
      ledgerPostingStatus: "pending",
      idempotencyKey: `quote-${randomUUID()}`,
    });

    expect(await getJarSavedPrincipalCents(jarId)).toBe(0);

    const allocations = await getMilestoneAllocations(jarId);
    expect(allocations.savedPrincipalCents).toBe(0);
    expect(allocations.reconciles).toBe(true);
  });

  it("ignores a failed contribution", async () => {
    const { jarId, memberId } = await createJarWithMember();
    await db.insert(financialTransactions).values({
      jarId,
      memberId,
      transactionType: "contribution",
      requestedPrincipalCents: 30_000,
      dripJarFeeCents: 900,
      dripJarFeeRateBps: 300,
      totalQuotedCents: 30_900,
      providerType: "stripe",
      providerStatus: "failed",
      ledgerPostingStatus: "pending",
      idempotencyKey: `failed-${randomUUID()}`,
    });

    expect(await getJarSavedPrincipalCents(jarId)).toBe(0);
  });
});

// ─── Properties 4 & 5: refunds reduce saved, commitments do not ──────────────

describe("refunds and commitments", () => {
  it("a partial refund reduces saved principal by the refunded portion only", async () => {
    const { jarId, memberId } = await createJarWithMember();
    const { ftId } = await seedSettledContribution(jarId, memberId, 20_000);

    await seedRefund(jarId, memberId, ftId, 5_000, "succeeded");

    expect(await getJarSavedPrincipalCents(jarId)).toBe(15_000);
  });

  it("a refund still in flight is already excluded from saved principal", async () => {
    const { jarId, memberId } = await createJarWithMember();
    const { ftId } = await seedSettledContribution(jarId, memberId, 20_000);

    // refundPending is not part of savedPrincipal = refundable + committed.
    await seedRefund(jarId, memberId, ftId, 8_000, "pending");

    expect(await getJarSavedPrincipalCents(jarId)).toBe(12_000);
  });

  it("a full refund leaves nothing saved", async () => {
    const { jarId, memberId } = await createJarWithMember();
    const { ftId } = await seedSettledContribution(jarId, memberId, 20_000);

    await seedRefund(jarId, memberId, ftId, 20_000, "succeeded");

    expect(await getJarSavedPrincipalCents(jarId)).toBe(0);
  });

  it("committing principal does not reduce saved principal", async () => {
    const { jarId, memberId } = await createJarWithMember();
    await seedSettledContribution(jarId, memberId, 20_000);

    await postCommitPrincipal({ jarId, memberId, principalCents: 12_000 });

    // Committed money is still saved — it moved refundable → committed.
    const summary = await getJarProgressSummary(jarId, GOAL_CENTS);
    expect(summary.savedPrincipalCents).toBe(20_000);
    expect(summary.committedPrincipalCents).toBe(12_000);
    expect(summary.refundablePrincipalCents).toBe(8_000);
  });
});

// ─── Property 6: the milestone identity ──────────────────────────────────────

describe("milestone allocated + unallocated === saved principal", () => {
  async function expectReconciles(jarId: string) {
    const a = await getMilestoneAllocations(jarId);
    expect(a.reconciles).toBe(true);
    expect(a.totalAllocatedCents + a.unallocatedCents).toBe(a.savedPrincipalCents);
    expect(a.unallocatedCents).toBeGreaterThanOrEqual(0);
    return a;
  }

  it("holds with everything tagged", async () => {
    const { jarId, memberId } = await createJarWithMember();
    const ms = await seedMilestone(jarId, "Flights", 100_000);
    await seedSettledContribution(jarId, memberId, 20_000, ms);

    const a = await expectReconciles(jarId);
    expect(a.byMilestoneId.get(ms)).toBe(20_000);
    expect(a.unallocatedCents).toBe(0);
  });

  it("holds with a mix of tagged and untagged principal", async () => {
    const { jarId, memberId } = await createJarWithMember();
    const ms = await seedMilestone(jarId, "Lodging", 100_000);
    await seedSettledContribution(jarId, memberId, 20_000, ms);
    await seedSettledContribution(jarId, memberId, 7_000, null);

    // The Hawaii 2027 shape: some money tagged, some not, none missing.
    const a = await expectReconciles(jarId);
    expect(a.byMilestoneId.get(ms)).toBe(20_000);
    expect(a.unallocatedCents).toBe(7_000);
    expect(a.savedPrincipalCents).toBe(27_000);
  });

  it("holds after a partial refund of tagged principal", async () => {
    const { jarId, memberId } = await createJarWithMember();
    const ms = await seedMilestone(jarId, "Activities", 100_000);
    const { ftId } = await seedSettledContribution(jarId, memberId, 20_000, ms);

    await seedRefund(jarId, memberId, ftId, 5_000, "succeeded");

    // The old implementation summed contributions.amount_cents and would still
    // report the original 20,000 here.
    const a = await expectReconciles(jarId);
    expect(a.byMilestoneId.get(ms)).toBe(15_000);
    expect(a.savedPrincipalCents).toBe(15_000);
  });

  it("holds after a full refund of tagged principal", async () => {
    const { jarId, memberId } = await createJarWithMember();
    const ms = await seedMilestone(jarId, "Food", 100_000);
    const { ftId } = await seedSettledContribution(jarId, memberId, 20_000, ms);

    await seedRefund(jarId, memberId, ftId, 20_000, "succeeded");

    const a = await expectReconciles(jarId);
    expect(a.totalAllocatedCents).toBe(0);
    expect(a.savedPrincipalCents).toBe(0);
  });

  it("holds while a refund is pending", async () => {
    const { jarId, memberId } = await createJarWithMember();
    const ms = await seedMilestone(jarId, "Buffer", 100_000);
    const { ftId } = await seedSettledContribution(jarId, memberId, 20_000, ms);

    await seedRefund(jarId, memberId, ftId, 6_000, "pending");

    const a = await expectReconciles(jarId);
    expect(a.byMilestoneId.get(ms)).toBe(14_000);
  });

  it("holds after committing tagged principal", async () => {
    const { jarId, memberId } = await createJarWithMember();
    const ms = await seedMilestone(jarId, "Excursion", 100_000);
    await seedSettledContribution(jarId, memberId, 20_000, ms);

    await postCommitPrincipal({ jarId, memberId, principalCents: 12_000 });

    const a = await expectReconciles(jarId);
    expect(a.byMilestoneId.get(ms)).toBe(20_000);
  });

  it("does not let Test Mode money inflate a milestone", async () => {
    const { jarId, memberId } = await createJarWithMember();
    const ms = await seedMilestone(jarId, "Simulated", 100_000);
    await seedSimulatedContribution(jarId, memberId, 44_000, ms);

    const a = await expectReconciles(jarId);
    expect(a.byMilestoneId.get(ms) ?? 0).toBe(0);
    expect(a.savedPrincipalCents).toBe(0);
  });

  it("a reversed refund allocation returns its principal to saved", async () => {
    const { jarId, memberId } = await createJarWithMember();
    const ms = await seedMilestone(jarId, "Reversed", 100_000);
    const { ftId } = await seedSettledContribution(jarId, memberId, 20_000, ms);

    // 'cancelled' allocations had their reservation reversed, so the principal
    // is refundable again and must not be subtracted twice.
    await db.insert(refundAllocations).values({
      refundRequestId: (
        await db
          .insert(refundRequests)
          .values({ jarId, memberId, requestedCents: 9_000, status: "cancelled" })
          .returning()
      )[0]!.id,
      sourceFtId: ftId,
      allocatedCents: 9_000,
      providerStatus: "cancelled",
    });

    const a = await expectReconciles(jarId);
    expect(a.byMilestoneId.get(ms)).toBe(20_000);
  });
});

// ─── percentFunded ───────────────────────────────────────────────────────────

describe("computePercentFunded", () => {
  it("is one shared implementation with one rounding rule", () => {
    expect(computePercentFunded(727_400, 1_000_000)).toBe(72.7);
    expect(computePercentFunded(0, 1_000_000)).toBe(0);
  });

  it("caps at 100 and never divides by zero", () => {
    expect(computePercentFunded(2_000_000, 1_000_000)).toBe(100);
    expect(computePercentFunded(500, 0)).toBe(0);
  });
});
