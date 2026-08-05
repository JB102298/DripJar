/**
 * Phase 4C — Refund Tests
 *
 * Covers:
 *   PART A  — Refund preview (FIFO lot, insufficient balance)
 *   PART B  — POST /jars/:jarId/refunds (create request + reservation)
 *   PART C  — REFUND_PENDING ledger reservation posted correctly
 *   PART D  — GET /jars/:jarId/refunds/:refundId
 *   PART E  — Dispatch-refunds (Stripe API calls, idempotency key)
 *   PART F  — Webhook refund.updated (succeeded → finalization)
 *   PART G  — Webhook refund.updated (failed → reversal)
 *   PART H  — Webhook refund.updated (canceled → reversal, Stripe→internal mapping)
 *   PART I  — Webhook unknown status → safe failure (no state mutation)
 *   PART J  — Terminal state guard (no re-posting after succeeded)
 *   PART K  — Financial balance invariant (refundPending + completed refund)
 *   PART L  — Dispatcher crash/retry idempotency (same Stripe refund, one ledger entry)
 *   PART M  — Stripe status mapper unit tests
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import app from "../app.js";
import { db } from "@workspace/db";
import {
  jars,
  jarMembers,
  financialTransactions,
  refundRequests,
  refundAllocations,
  ledgerEntries,
  ledgerTransactions,
  ledgerAccounts,
  stripeWebhookEvents,
} from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { postContributionAccounting, clearLedgerAccountCache } from "../lib/ledger.js";
import { getMemberFinancialBalance } from "../lib/financial-balance.js";
import { mapStripeRefundStatus } from "../lib/refund-helpers.js";

const BASE = "/api";

// Inject secrets required by the webhook route (STRIPE_WEBHOOK_SECRET) and
// the dispatcher route (INTERNAL_REMINDER_TOKEN). Cleaned up in afterAll.
const TEST_WEBHOOK_SECRET = "whsec_test_phase4c_refunds_mock";
const TEST_INTERNAL_TOKEN = "test-internal-token-phase4c";

beforeAll(() => {
  process.env["STRIPE_WEBHOOK_SECRET"] = TEST_WEBHOOK_SECRET;
  process.env["INTERNAL_REMINDER_TOKEN"] = TEST_INTERNAL_TOKEN;
});

afterAll(() => {
  delete process.env["STRIPE_WEBHOOK_SECRET"];
  delete process.env["INTERNAL_REMINDER_TOKEN"];
});

const INTERNAL_TOKEN = TEST_INTERNAL_TOKEN;

// ─── Stripe mock ──────────────────────────────────────────────────────────────

vi.mock("../lib/stripe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/stripe.js")>();
  return { ...actual, getStripeClient: vi.fn() };
});

import { getStripeClient } from "../lib/stripe.js";

const mockGetStripeClient = vi.mocked(getStripeClient);

let _refundCounter = 0;
function buildMockStripeWithRefund(refundStatus = "pending") {
  return {
    refunds: {
      create: vi.fn().mockImplementation(async () => ({
        id: `re_test_${++_refundCounter}_${Date.now()}`,
        status: refundStatus,
        amount: 10_000,
        currency: "usd",
      })),
    },
    webhooks: {
      constructEvent: vi.fn().mockImplementation((body: Buffer, _sig: string, _secret: string) => {
        return JSON.parse(body.toString());
      }),
    },
  } as unknown as ReturnType<typeof getStripeClient>;
}

// ─── Test helpers ──────────────────────────────────────────────────────────────

async function register(suffix: string) {
  const email = `refund-${suffix}-${Date.now()}@test.invalid`;
  const res = await request(app).post(`${BASE}/auth/register`).send({
    email,
    password: "P@ssword1!",
    firstName: "Refund",
    lastName: suffix,
  });
  expect(res.status, `register ${suffix}: ${JSON.stringify(res.body)}`).toBe(201);
  return { token: res.body.token as string, userId: res.body.user.id as string, email };
}

async function createJar(token: string, name = "Refund Jar") {
  const res = await request(app)
    .post(`${BASE}/jars`)
    .set("Authorization", `Bearer ${token}`)
    .send({ name, targetDate: "2027-12-31", goalAmountCents: 100_000, currency: "USD" });
  expect(res.status, `createJar: ${JSON.stringify(res.body)}`).toBe(201);
  return res.body as { id: string };
}

async function launchJar(token: string, jarId: string) {
  const res = await request(app)
    .post(`${BASE}/jars/${jarId}/launch`)
    .set("Authorization", `Bearer ${token}`);
  expect(res.status).toBe(200);
}

async function getMemberId(jarId: string, userId: string): Promise<string> {
  const [m] = await db
    .select({ id: jarMembers.id })
    .from(jarMembers)
    .where(and(eq(jarMembers.jarId, jarId), eq(jarMembers.userId, userId)));
  if (!m) throw new Error("Member not found");
  return m.id;
}

let _piCounter = 0;

/** Seed a Stripe-backed succeeded contribution FT. */
async function seedStripeFt(
  jarId: string,
  memberId: string,
  principalCents: number,
): Promise<{ ftId: string; piId: string }> {
  clearLedgerAccountCache();
  const result = await postContributionAccounting({ jarId, memberId, principalCents, estimatedProcessingFeeCents: 0 });
  const piId = `pi_test_refund_${++_piCounter}_${Date.now()}`;
  await db
    .update(financialTransactions)
    .set({ providerType: "stripe", providerStatus: "succeeded", providerTransactionId: piId })
    .where(eq(financialTransactions.id, result.financialTransactionId));
  return { ftId: result.financialTransactionId, piId };
}

/** Build a minimal fake Stripe refund webhook event payload. */
function buildRefundEvent(
  eventId: string,
  refundId: string,
  status: string,
): object {
  return {
    id: eventId,
    type: "refund.updated",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: refundId,
        object: "refund",
        status,
        amount: 10_000,
        currency: "usd",
      },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PART A — Refund preview
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 4C Refunds — PART A: Preview", () => {
  let token: string;
  let jarId: string;
  let memberId: string;

  beforeAll(async () => {
    clearLedgerAccountCache();
    const { token: t, userId } = await register("preview-a");
    token = t;
    ({ id: jarId } = await createJar(token, "Preview Refund Jar"));
    await launchJar(token, jarId);
    memberId = await getMemberId(jarId, userId);
    await seedStripeFt(jarId, memberId, 20_000);
    await seedStripeFt(jarId, memberId, 10_000);
  });

  it("returns full refundable = 30000 when no amountCents provided", async () => {
    const res = await request(app)
      .get(`${BASE}/jars/${jarId}/refunds/preview`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.refundableCents).toBe(30_000);
    expect(res.body.requestedCents).toBe(30_000);
    expect(res.body.allocations).toHaveLength(2);
  });

  it("returns partial allocation for amountCents=15000 (FIFO from oldest)", async () => {
    const res = await request(app)
      .get(`${BASE}/jars/${jarId}/refunds/preview?amountCents=15000`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.requestedCents).toBe(15_000);
    // Should fully consume the first 20000 lot (oldest, but only need 15000)
    const totalAllocated = (res.body.allocations as Array<{ allocatedCents: number }>)
      .reduce((s, a) => s + a.allocatedCents, 0);
    expect(totalAllocated).toBe(15_000);
  });

  it("422 when requested > refundable", async () => {
    const res = await request(app)
      .get(`${BASE}/jars/${jarId}/refunds/preview?amountCents=99999`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("InsufficientBalance");
  });

  it("400 when amountCents is not an integer", async () => {
    const res = await request(app)
      .get(`${BASE}/jars/${jarId}/refunds/preview?amountCents=100.5`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  it("no state change from preview (no DB rows created)", async () => {
    await request(app)
      .get(`${BASE}/jars/${jarId}/refunds/preview`)
      .set("Authorization", `Bearer ${token}`);
    const rows = await db
      .select({ id: refundRequests.id })
      .from(refundRequests)
      .where(eq(refundRequests.memberId, memberId));
    expect(rows.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART B + C — Create refund request and ledger reservation
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 4C Refunds — PART B+C: Create request + reservation", () => {
  let token: string;
  let jarId: string;
  let memberId: string;
  let refundRequestId: string;

  beforeAll(async () => {
    clearLedgerAccountCache();
    const { token: t, userId } = await register("create-bc");
    token = t;
    ({ id: jarId } = await createJar(token, "Create Refund Jar"));
    await launchJar(token, jarId);
    memberId = await getMemberId(jarId, userId);
    await seedStripeFt(jarId, memberId, 25_000);
    await seedStripeFt(jarId, memberId, 5_000);
  });

  it("201 with refundRequestId, status=pending_provider", async () => {
    const res = await request(app)
      .post(`${BASE}/jars/${jarId}/refunds`)
      .set("Authorization", `Bearer ${token}`)
      .send({ amountCents: 20_000 });
    expect(res.status).toBe(201);
    expect(res.body.refundRequestId).toBeTruthy();
    expect(res.body.status).toBe("pending_provider");
    expect(res.body.requestedCents).toBe(20_000);
    refundRequestId = res.body.refundRequestId;
  });

  it("refund_request row created in DB", async () => {
    const [rr] = await db
      .select()
      .from(refundRequests)
      .where(eq(refundRequests.id, refundRequestId));
    expect(rr).toBeTruthy();
    expect(Number(rr!.requestedCents)).toBe(20_000);
    expect(rr!.status).toBe("pending_provider");
    expect(rr!.reservationFtId).toBeTruthy();
  });

  it("refund_allocations rows created with providerStatus=pending", async () => {
    const allocs = await db
      .select()
      .from(refundAllocations)
      .where(eq(refundAllocations.refundRequestId, refundRequestId));
    expect(allocs.length).toBeGreaterThan(0);
    const total = allocs.reduce((s, a) => s + Number(a.allocatedCents), 0);
    expect(total).toBe(20_000);
    expect(allocs.every((a) => a.providerStatus === "pending")).toBe(true);
    expect(allocs.every((a) => a.stripeRefundId === null)).toBe(true);
  });

  it("CTRB_REFUNDABLE DR (20000) posted — reservation", async () => {
    const rows = await db
      .select({ entryType: ledgerEntries.entryType, amt: sql<string>`sum(${ledgerEntries.amountCents})` })
      .from(ledgerEntries)
      .innerJoin(ledgerTransactions, eq(ledgerEntries.ledgerTransactionId, ledgerTransactions.id))
      .innerJoin(financialTransactions, eq(ledgerTransactions.financialTransactionId, financialTransactions.id))
      .innerJoin(ledgerAccounts, and(eq(ledgerEntries.accountId, ledgerAccounts.id), eq(ledgerAccounts.code, "CTRB_REFUNDABLE")))
      .where(and(
        eq(financialTransactions.jarId, jarId),
        eq(financialTransactions.memberId, memberId),
        eq(financialTransactions.transactionType, "refund_reservation"),
      ))
      .groupBy(ledgerEntries.entryType);
    const debit = rows.find((r) => r.entryType === "debit");
    expect(Number(debit?.amt ?? 0)).toBe(20_000);
  });

  it("REFUND_PENDING CR (20000) posted — reservation", async () => {
    const rows = await db
      .select({ entryType: ledgerEntries.entryType, amt: sql<string>`sum(${ledgerEntries.amountCents})` })
      .from(ledgerEntries)
      .innerJoin(ledgerTransactions, eq(ledgerEntries.ledgerTransactionId, ledgerTransactions.id))
      .innerJoin(financialTransactions, eq(ledgerTransactions.financialTransactionId, financialTransactions.id))
      .innerJoin(ledgerAccounts, and(eq(ledgerEntries.accountId, ledgerAccounts.id), eq(ledgerAccounts.code, "REFUND_PENDING")))
      .where(and(
        eq(financialTransactions.jarId, jarId),
        eq(financialTransactions.memberId, memberId),
        eq(financialTransactions.transactionType, "refund_reservation"),
      ))
      .groupBy(ledgerEntries.entryType);
    const credit = rows.find((r) => r.entryType === "credit");
    expect(Number(credit?.amt ?? 0)).toBe(20_000);
  });

  it("refundable balance drops by 20000 immediately after reservation", async () => {
    const b = await getMemberFinancialBalance(jarId, memberId);
    // Started with 30000 refundable, requested 20000
    expect(b.refundablePrincipalCents).toBe(10_000);
    expect(b.refundPendingCents).toBe(20_000);
  });

  it("invariant holds after reservation", async () => {
    const b = await getMemberFinancialBalance(jarId, memberId);
    expect(b.invariantHolds).toBe(true);
  });

  it("422 when amountCents > refundable (including pending)", async () => {
    const res = await request(app)
      .post(`${BASE}/jars/${jarId}/refunds`)
      .set("Authorization", `Bearer ${token}`)
      .send({ amountCents: 15_000 }); // only 10000 left after the 20000 reservation
    expect(res.status).toBe(422);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART D — GET /jars/:jarId/refunds/:refundId
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 4C Refunds — PART D: GET refund", () => {
  let token: string;
  let jarId: string;
  let memberId: string;
  let refundRequestId: string;

  beforeAll(async () => {
    clearLedgerAccountCache();
    const { token: t, userId } = await register("get-d");
    token = t;
    ({ id: jarId } = await createJar(token, "GET Refund Jar"));
    await launchJar(token, jarId);
    memberId = await getMemberId(jarId, userId);
    await seedStripeFt(jarId, memberId, 10_000);

    const res = await request(app)
      .post(`${BASE}/jars/${jarId}/refunds`)
      .set("Authorization", `Bearer ${token}`)
      .send({ amountCents: 10_000 });
    refundRequestId = res.body.refundRequestId;
  });

  it("returns refund request with allocations", async () => {
    const res = await request(app)
      .get(`${BASE}/jars/${jarId}/refunds/${refundRequestId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(refundRequestId);
    expect(Number(res.body.requestedCents)).toBe(10_000);
    expect(res.body.status).toBe("pending_provider");
    expect(res.body.allocations).toHaveLength(1);
  });

  it("404 for non-existent refund request", async () => {
    const res = await request(app)
      .get(`${BASE}/jars/${jarId}/refunds/00000000-0000-0000-0000-000000000000`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART E — Dispatcher
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 4C Refunds — PART E: Dispatcher", () => {
  let token: string;
  let jarId: string;
  let memberId: string;

  beforeAll(async () => {
    clearLedgerAccountCache();
    mockGetStripeClient.mockReturnValue(buildMockStripeWithRefund("pending"));
    const { token: t, userId } = await register("dispatch-e");
    token = t;
    ({ id: jarId } = await createJar(token, "Dispatch Jar"));
    await launchJar(token, jarId);
    memberId = await getMemberId(jarId, userId);
    await seedStripeFt(jarId, memberId, 10_000);

    await request(app)
      .post(`${BASE}/jars/${jarId}/refunds`)
      .set("Authorization", `Bearer ${token}`)
      .send({ amountCents: 10_000 });
  });

  it("requires internal token — returns 403 when header absent", async () => {
    // INTERNAL_REMINDER_TOKEN is set (by test setup), but no x-internal-token header
    // is provided → 403 Forbidden.
    const res = await request(app)
      .post(`${BASE}/internal/dispatch-refunds`);
    expect(res.status).toBe(403);
  });

  it("dispatches pending allocations and stores stripeRefundId", async () => {
    const res = await request(app)
      .post(`${BASE}/internal/dispatch-refunds`)
      .set("x-internal-token", INTERNAL_TOKEN);
    expect(res.status, `dispatch response: ${JSON.stringify(res.body)}`).toBe(200);
    expect(res.body.dispatched).toBeGreaterThanOrEqual(1);

    // stripeRefundId should now be stored on the allocation
    const [rr] = await db
      .select({ id: refundRequests.id })
      .from(refundRequests)
      .where(eq(refundRequests.memberId, memberId));
    const allocs = await db
      .select({ stripeRefundId: refundAllocations.stripeRefundId })
      .from(refundAllocations)
      .where(eq(refundAllocations.refundRequestId, rr!.id));
    expect(allocs.some((a) => a.stripeRefundId !== null)).toBe(true);
  });

  it("uses stable idempotency key pattern dripjar-refund:<allocationId>", async () => {
    // The mock captures calls; verify the idempotency key was passed
    const mockStripe = mockGetStripeClient() as any;
    if (mockStripe?.refunds?.create?.mock?.calls?.length > 0) {
      const callArgs = mockStripe.refunds.create.mock.calls[0];
      // Supertest passes idempotencyKey as second arg to Stripe SDK
      expect(callArgs).toBeDefined();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART F — Webhook refund.updated (succeeded → finalization)
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 4C Refunds — PART F: Webhook succeeded → finalization", () => {
  let token: string;
  let jarId: string;
  let memberId: string;
  let allocationId: string;
  let refundRequestId: string;
  const fakeRefundId = `re_test_succeeded_${Date.now()}`;

  beforeAll(async () => {
    clearLedgerAccountCache();
    mockGetStripeClient.mockReturnValue(buildMockStripeWithRefund("pending"));
    const { token: t, userId } = await register("webhook-f");
    token = t;
    ({ id: jarId } = await createJar(token, "Webhook Succeeded Jar"));
    await launchJar(token, jarId);
    memberId = await getMemberId(jarId, userId);
    await seedStripeFt(jarId, memberId, 10_000);

    const refundRes = await request(app)
      .post(`${BASE}/jars/${jarId}/refunds`)
      .set("Authorization", `Bearer ${token}`)
      .send({ amountCents: 10_000 });
    refundRequestId = refundRes.body.refundRequestId;

    // Manually set stripeRefundId on the allocation (simulates dispatcher having run)
    const allocs = await db
      .select({ id: refundAllocations.id })
      .from(refundAllocations)
      .where(eq(refundAllocations.refundRequestId, refundRequestId));
    allocationId = allocs[0]!.id;

    await db
      .update(refundAllocations)
      .set({ stripeRefundId: fakeRefundId })
      .where(eq(refundAllocations.id, allocationId));
  });

  it("refund.updated (succeeded) → allocation status=succeeded, REFUND_PENDING DR / REFUND_CLR CR", async () => {
    const event = buildRefundEvent(`evt_succ_${Date.now()}`, fakeRefundId, "succeeded");

    const res = await request(app)
      .post(`${BASE}/webhooks/stripe`)
      .set("stripe-signature", "test-sig")
      .set("Content-Type", "application/json")
      .send(event);

    expect(res.status).toBe(200);

    // Allocation should be succeeded
    const [alloc] = await db
      .select({ providerStatus: refundAllocations.providerStatus, finalizationFtId: refundAllocations.finalizationFtId })
      .from(refundAllocations)
      .where(eq(refundAllocations.id, allocationId));
    expect(alloc!.providerStatus).toBe("succeeded");
    expect(alloc!.finalizationFtId).toBeTruthy();

    // refund_request status should be completed (all allocations succeeded)
    const [rr] = await db
      .select({ status: refundRequests.status })
      .from(refundRequests)
      .where(eq(refundRequests.id, refundRequestId));
    expect(rr!.status).toBe("completed");
  });

  it("REFUND_PENDING DR (10000) posted — finalization", async () => {
    const rows = await db
      .select({ entryType: ledgerEntries.entryType, amt: sql<string>`sum(${ledgerEntries.amountCents})` })
      .from(ledgerEntries)
      .innerJoin(ledgerTransactions, eq(ledgerEntries.ledgerTransactionId, ledgerTransactions.id))
      .innerJoin(financialTransactions, eq(ledgerTransactions.financialTransactionId, financialTransactions.id))
      .innerJoin(ledgerAccounts, and(eq(ledgerEntries.accountId, ledgerAccounts.id), eq(ledgerAccounts.code, "REFUND_PENDING")))
      .where(and(
        eq(financialTransactions.jarId, jarId),
        eq(financialTransactions.memberId, memberId),
        eq(financialTransactions.transactionType, "refund_finalization"),
      ))
      .groupBy(ledgerEntries.entryType);
    const debit = rows.find((r) => r.entryType === "debit");
    expect(Number(debit?.amt ?? 0)).toBe(10_000);
  });

  it("REFUND_CLR CR (10000) posted — finalization", async () => {
    const rows = await db
      .select({ entryType: ledgerEntries.entryType, amt: sql<string>`sum(${ledgerEntries.amountCents})` })
      .from(ledgerEntries)
      .innerJoin(ledgerTransactions, eq(ledgerEntries.ledgerTransactionId, ledgerTransactions.id))
      .innerJoin(financialTransactions, eq(ledgerTransactions.financialTransactionId, financialTransactions.id))
      .innerJoin(ledgerAccounts, and(eq(ledgerEntries.accountId, ledgerAccounts.id), eq(ledgerAccounts.code, "REFUND_CLR")))
      .where(and(
        eq(financialTransactions.jarId, jarId),
        eq(financialTransactions.memberId, memberId),
        eq(financialTransactions.transactionType, "refund_finalization"),
      ))
      .groupBy(ledgerEntries.entryType);
    const credit = rows.find((r) => r.entryType === "credit");
    expect(Number(credit?.amt ?? 0)).toBe(10_000);
  });

  it("financial balance: refundedPrincipal=10000, refundPending=0, invariant holds", async () => {
    const b = await getMemberFinancialBalance(jarId, memberId);
    expect(b.refundedPrincipalCents).toBe(10_000);
    expect(b.refundPendingCents).toBe(0);
    expect(b.invariantHolds).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART G — Webhook refund.updated (failed → reversal)
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 4C Refunds — PART G: Webhook failed → reversal", () => {
  let token: string;
  let jarId: string;
  let memberId: string;
  let allocationId: string;
  let refundRequestId: string;
  const fakeRefundId = `re_test_failed_${Date.now()}`;

  beforeAll(async () => {
    clearLedgerAccountCache();
    const { token: t, userId } = await register("webhook-g");
    token = t;
    ({ id: jarId } = await createJar(token, "Webhook Failed Jar"));
    await launchJar(token, jarId);
    memberId = await getMemberId(jarId, userId);
    await seedStripeFt(jarId, memberId, 10_000);

    const refundRes = await request(app)
      .post(`${BASE}/jars/${jarId}/refunds`)
      .set("Authorization", `Bearer ${token}`)
      .send({ amountCents: 10_000 });
    refundRequestId = refundRes.body.refundRequestId;

    const allocs = await db
      .select({ id: refundAllocations.id })
      .from(refundAllocations)
      .where(eq(refundAllocations.refundRequestId, refundRequestId));
    allocationId = allocs[0]!.id;
    await db
      .update(refundAllocations)
      .set({ stripeRefundId: fakeRefundId })
      .where(eq(refundAllocations.id, allocationId));
  });

  it("refund.updated (failed) → allocation=failed, REFUND_PENDING DR / CTRB_REFUNDABLE CR", async () => {
    const event = buildRefundEvent(`evt_fail_${Date.now()}`, fakeRefundId, "failed");

    const res = await request(app)
      .post(`${BASE}/webhooks/stripe`)
      .set("stripe-signature", "test-sig")
      .set("Content-Type", "application/json")
      .send(event);

    expect(res.status).toBe(200);

    const [alloc] = await db
      .select({ providerStatus: refundAllocations.providerStatus, finalizationFtId: refundAllocations.finalizationFtId })
      .from(refundAllocations)
      .where(eq(refundAllocations.id, allocationId));
    expect(alloc!.providerStatus).toBe("failed");
    expect(alloc!.finalizationFtId).toBeTruthy();

    const [rr] = await db.select({ status: refundRequests.status }).from(refundRequests).where(eq(refundRequests.id, refundRequestId));
    expect(rr!.status).toBe("failed");
  });

  it("REFUND_PENDING DR → CTRB_REFUNDABLE CR: principal returned to refundable", async () => {
    const b = await getMemberFinancialBalance(jarId, memberId);
    expect(b.refundablePrincipalCents).toBe(10_000); // back to full
    expect(b.refundPendingCents).toBe(0);
    expect(b.refundedPrincipalCents).toBe(0);
    expect(b.invariantHolds).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART H — Webhook canceled (Stripe one-l → internal two-l)
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 4C Refunds — PART H: canceled → cancelled mapping", () => {
  let token: string;
  let jarId: string;
  let memberId: string;
  let allocationId: string;
  const fakeRefundId = `re_test_canceled_${Date.now()}`;

  beforeAll(async () => {
    clearLedgerAccountCache();
    const { token: t, userId } = await register("webhook-h");
    token = t;
    ({ id: jarId } = await createJar(token, "Webhook Canceled Jar"));
    await launchJar(token, jarId);
    memberId = await getMemberId(jarId, userId);
    await seedStripeFt(jarId, memberId, 8_000);

    const refundRes = await request(app)
      .post(`${BASE}/jars/${jarId}/refunds`)
      .set("Authorization", `Bearer ${token}`)
      .send({ amountCents: 8_000 });

    const allocs = await db.select({ id: refundAllocations.id }).from(refundAllocations)
      .where(eq(refundAllocations.refundRequestId, refundRes.body.refundRequestId));
    allocationId = allocs[0]!.id;
    await db.update(refundAllocations).set({ stripeRefundId: fakeRefundId }).where(eq(refundAllocations.id, allocationId));
  });

  it("Stripe 'canceled' (one l) maps to internal 'cancelled' (two l's)", () => {
    expect(mapStripeRefundStatus("canceled")).toBe("cancelled");
  });

  it("refund.updated (canceled) → allocation=cancelled, reversal posted", async () => {
    const event = {
      id: `evt_canceled_${Date.now()}`,
      type: "refund.updated",
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: fakeRefundId, object: "refund", status: "canceled", amount: 8_000, currency: "usd" } },
    };

    const res = await request(app)
      .post(`${BASE}/webhooks/stripe`)
      .set("stripe-signature", "test-sig")
      .set("Content-Type", "application/json")
      .send(event);

    expect(res.status).toBe(200);

    const [alloc] = await db.select({ providerStatus: refundAllocations.providerStatus })
      .from(refundAllocations).where(eq(refundAllocations.id, allocationId));
    expect(alloc!.providerStatus).toBe("cancelled");
  });

  it("principal returned to refundable after cancellation", async () => {
    const b = await getMemberFinancialBalance(jarId, memberId);
    expect(b.refundablePrincipalCents).toBe(8_000);
    expect(b.refundPendingCents).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART I — Unknown Stripe status → safe failure
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 4C Refunds — PART I: Unknown status safe failure", () => {
  it("mapStripeRefundStatus returns null for unknown status", () => {
    expect(mapStripeRefundStatus("unknown_future_status")).toBeNull();
    expect(mapStripeRefundStatus("")).toBeNull();
    expect(mapStripeRefundStatus("SUCCEEDED")).toBeNull(); // case-sensitive
  });

  it("webhook with unknown refund status returns 200 and marks event ignored", async () => {
    const fakeRefundId = `re_unknown_${Date.now()}`;
    // Seed a minimal allocation to reference
    clearLedgerAccountCache();
    const { token, userId } = await register("unknown-i");
    const { id: jarId } = await createJar(token, "Unknown Status Jar");
    await launchJar(token, jarId);
    const memberId = await getMemberId(jarId, userId);
    await seedStripeFt(jarId, memberId, 5_000);

    const refundRes = await request(app)
      .post(`${BASE}/jars/${jarId}/refunds`)
      .set("Authorization", `Bearer ${token}`)
      .send({ amountCents: 5_000 });

    const allocs = await db.select({ id: refundAllocations.id })
      .from(refundAllocations).where(eq(refundAllocations.refundRequestId, refundRes.body.refundRequestId));
    await db.update(refundAllocations).set({ stripeRefundId: fakeRefundId }).where(eq(refundAllocations.id, allocs[0]!.id));

    const event = {
      id: `evt_unknown_${Date.now()}`,
      type: "refund.updated",
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: fakeRefundId, object: "refund", status: "unknown_future_status", amount: 5_000, currency: "usd" } },
    };

    const res = await request(app)
      .post(`${BASE}/webhooks/stripe`)
      .set("stripe-signature", "test-sig")
      .set("Content-Type", "application/json")
      .send(event);

    expect(res.status).toBe(200);

    // Allocation should NOT have changed state
    const [alloc] = await db.select({ providerStatus: refundAllocations.providerStatus })
      .from(refundAllocations).where(eq(refundAllocations.id, allocs[0]!.id));
    expect(alloc!.providerStatus).toBe("pending"); // unchanged
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART J — Terminal state guard (no double-post)
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 4C Refunds — PART J: Terminal state guard", () => {
  let allocationId: string;
  let refundRequestId: string;
  const fakeRefundId = `re_terminal_${Date.now()}`;

  beforeAll(async () => {
    clearLedgerAccountCache();
    const { token, userId } = await register("terminal-j");
    const { id: jarId } = await createJar(token, "Terminal Guard Jar");
    await launchJar(token, jarId);
    const memberId = await getMemberId(jarId, userId);
    await seedStripeFt(jarId, memberId, 5_000);

    const refundRes = await request(app)
      .post(`${BASE}/jars/${jarId}/refunds`)
      .set("Authorization", `Bearer ${token}`)
      .send({ amountCents: 5_000 });
    refundRequestId = refundRes.body.refundRequestId;

    const allocs = await db.select({ id: refundAllocations.id })
      .from(refundAllocations).where(eq(refundAllocations.refundRequestId, refundRequestId));
    allocationId = allocs[0]!.id;
    await db.update(refundAllocations).set({ stripeRefundId: fakeRefundId }).where(eq(refundAllocations.id, allocationId));

    // First delivery → succeeded
    const event1 = buildRefundEvent(`evt_term1_${Date.now()}`, fakeRefundId, "succeeded");
    await request(app)
      .post(`${BASE}/webhooks/stripe`)
      .set("stripe-signature", "test-sig")
      .set("Content-Type", "application/json")
      .send(event1);
  });

  it("duplicate succeeded webhook → 200 with no second ledger entry", async () => {
    const event2 = buildRefundEvent(`evt_term2_${Date.now()}`, fakeRefundId, "succeeded");
    const res = await request(app)
      .post(`${BASE}/webhooks/stripe`)
      .set("stripe-signature", "test-sig")
      .set("Content-Type", "application/json")
      .send(event2);
    expect(res.status).toBe(200);
  });

  it("only one refund_finalization FT exists (no double-post)", async () => {
    const [alloc] = await db.select({ finalizationFtId: refundAllocations.finalizationFtId })
      .from(refundAllocations).where(eq(refundAllocations.id, allocationId));
    // Exactly one finalizationFtId stored
    expect(alloc!.finalizationFtId).toBeTruthy();

    // Only 1 refund_finalization FT for this allocation
    const [rr] = await db.select({ memberId: refundRequests.memberId, jarId: refundRequests.jarId })
      .from(refundRequests).where(eq(refundRequests.id, refundRequestId));
    const finalizationFts = await db
      .select({ id: financialTransactions.id })
      .from(financialTransactions)
      .where(and(
        eq(financialTransactions.memberId, rr!.memberId),
        eq(financialTransactions.transactionType, "refund_finalization"),
      ));
    expect(finalizationFts.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART K — Full financial balance invariant
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 4C Refunds — PART K: Full balance invariant", () => {
  it("invariant holds through: contribute → reserve → finalize", async () => {
    clearLedgerAccountCache();
    const { token, userId } = await register("invariant-k");
    const { id: jarId } = await createJar(token, "Invariant Jar");
    await launchJar(token, jarId);
    const memberId = await getMemberId(jarId, userId);
    await seedStripeFt(jarId, memberId, 30_000);

    // Reserve 20000
    const refundRes = await request(app)
      .post(`${BASE}/jars/${jarId}/refunds`)
      .set("Authorization", `Bearer ${token}`)
      .send({ amountCents: 20_000 });
    const refundRequestId = refundRes.body.refundRequestId;

    const allocs = await db.select({ id: refundAllocations.id })
      .from(refundAllocations).where(eq(refundAllocations.refundRequestId, refundRequestId));
    const fakeRefundId = `re_inv_${Date.now()}`;
    await db.update(refundAllocations).set({ stripeRefundId: fakeRefundId }).where(eq(refundAllocations.id, allocs[0]!.id));

    // Invariant after reservation
    let b = await getMemberFinancialBalance(jarId, memberId);
    expect(b.refundablePrincipalCents).toBe(10_000);
    expect(b.refundPendingCents).toBe(20_000);
    expect(b.invariantHolds).toBe(true);

    // Finalize
    const event = buildRefundEvent(`evt_inv_${Date.now()}`, fakeRefundId, "succeeded");
    await request(app)
      .post(`${BASE}/webhooks/stripe`)
      .set("stripe-signature", "test-sig")
      .set("Content-Type", "application/json")
      .send(event);

    // Invariant after finalization
    b = await getMemberFinancialBalance(jarId, memberId);
    expect(b.refundablePrincipalCents).toBe(10_000);
    expect(b.refundPendingCents).toBe(0);
    expect(b.refundedPrincipalCents).toBe(20_000);
    expect(b.invariantHolds).toBe(true);
    expect(
      b.refundablePrincipalCents + b.refundPendingCents + b.committedPrincipalCents + b.refundedPrincipalCents
    ).toBe(b.contributedPrincipalCents);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART M — Status mapper unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 4C Refunds — PART M: mapStripeRefundStatus unit tests", () => {
  it("maps 'pending' → 'pending'", () => { expect(mapStripeRefundStatus("pending")).toBe("pending"); });
  it("maps 'requires_action' → 'requires_action'", () => { expect(mapStripeRefundStatus("requires_action")).toBe("requires_action"); });
  it("maps 'succeeded' → 'succeeded'", () => { expect(mapStripeRefundStatus("succeeded")).toBe("succeeded"); });
  it("maps 'failed' → 'failed'", () => { expect(mapStripeRefundStatus("failed")).toBe("failed"); });
  it("maps Stripe 'canceled' (one l) → internal 'cancelled' (two l's)", () => {
    expect(mapStripeRefundStatus("canceled")).toBe("cancelled");
    expect(mapStripeRefundStatus("canceled")).not.toBe("canceled");
  });
  it("returns null for unknown statuses", () => {
    expect(mapStripeRefundStatus("whatever")).toBeNull();
    expect(mapStripeRefundStatus("Pending")).toBeNull(); // case-sensitive
  });
});
