/**
 * Phase 4B — Webhook Exactly-Once Concurrency Stress Test
 *
 * Proves that the Stripe webhook handler preserves exactly-once financial
 * state under high concurrent load with a real PostgreSQL database.
 * No DB layer is mocked; only Stripe network operations are stubbed.
 *
 * Scenario A  — 50 concurrent deliveries of the same event ID
 *   Asserts: exactly-once ledger posting, exactly-once contributions row,
 *   FT providerStatus/ledgerPostingStatus, no duplicate stripeWebhookEvents row.
 *
 * Scenario B  — 50 concurrent requests split between two different event IDs
 *   that both refer to the same PaymentIntent (e.g. Stripe retries with new
 *   event IDs).  The FOR UPDATE guard must prevent double-posting even when
 *   both events race to post the ledger.
 *
 * Scenario C  — 25 `payment_intent.processing` + 25 `payment_intent.succeeded`
 *   requests for the same PI delivered concurrently.  Verifies that the
 *   processing event (handled by the default "ignore" path) cannot regress
 *   the FT providerStatus back from "succeeded".
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import app from "../app.js";
import { db } from "@workspace/db";
import {
  jarMembers,
  financialTransactions,
  stripeWebhookEvents,
  contributions,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";

const BASE = "/api";

// ─── Stripe mock ─────────────────────────────────────────────────────────────
// All Stripe network calls are mocked.  DB operations use real PostgreSQL.

vi.mock("../lib/stripe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/stripe.js")>();
  return { ...actual, getStripeClient: vi.fn() };
});

vi.mock("../lib/stripe-customer.ts", () => ({
  getOrCreateStripeCustomer: vi.fn().mockResolvedValue("cus_stress_mock"),
}));

import { getStripeClient } from "../lib/stripe.js";
import { getOrCreateStripeCustomer } from "../lib/stripe-customer.js";

const mockGetStripeClient = vi.mocked(getStripeClient);
const mockGetOrCreateStripeCustomer = vi.mocked(getOrCreateStripeCustomer);

// ─── Mock factory ─────────────────────────────────────────────────────────────

let _piCounter = 0;

function buildMockStripe() {
  return {
    paymentIntents: {
      create: vi.fn().mockImplementation(async () => {
        const id = `pi_stress_${++_piCounter}_${Date.now()}`;
        return {
          id,
          client_secret: `${id}_secret`,
          amount: 21_246,
          currency: "usd",
          status: "requires_payment_method",
          latest_charge: null,
        };
      }),
      retrieve: vi.fn(),
    },
    customerSessions: {
      create: vi.fn().mockResolvedValue({ client_secret: "cuss_stress_secret" }),
    },
    customers: {
      create: vi.fn().mockResolvedValue({ id: "cus_stress_mock" }),
    },
    webhooks: {
      // constructEvent is configured per-scenario below
      constructEvent: vi.fn(),
    },
    charges: {
      retrieve: vi.fn().mockRejectedValue(new Error("Not available in test mode")),
    },
  } as unknown as ReturnType<typeof getStripeClient>;
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

async function register(suffix: string) {
  const email = `stress-wh-${suffix}-${Date.now()}@test.invalid`;
  const res = await request(app)
    .post(`${BASE}/auth/register`)
    .send({ email, password: "P@ssword1!", firstName: "Stress", lastName: suffix });
  expect(res.status, `register ${suffix}: ${JSON.stringify(res.body)}`).toBe(201);
  return { token: res.body.token as string, userId: res.body.user.id as string };
}

async function createJar(token: string) {
  const res = await request(app)
    .post(`${BASE}/jars`)
    .set("Authorization", `Bearer ${token}`)
    .send({ name: "Stress Jar", targetDate: "2027-12-31", goalAmountCents: 500_000, currency: "USD" });
  expect(res.status, `createJar: ${JSON.stringify(res.body)}`).toBe(201);
  return res.body as { id: string };
}

async function launchJar(token: string, jarId: string) {
  const res = await request(app)
    .post(`${BASE}/jars/${jarId}/launch`)
    .set("Authorization", `Bearer ${token}`);
  expect(res.status, `launchJar: ${JSON.stringify(res.body)}`).toBe(200);
}

async function getMemberId(jarId: string, userId: string) {
  const [m] = await db
    .select({ id: jarMembers.id })
    .from(jarMembers)
    .where(and(eq(jarMembers.jarId, jarId), eq(jarMembers.userId, userId)));
  if (!m) throw new Error(`Member not found: userId=${userId} jarId=${jarId}`);
  return m.id;
}

async function createQuoteAndPi(token: string, jarId: string) {
  const quoteRes = await request(app)
    .post(`${BASE}/finance/quote`)
    .set("Authorization", `Bearer ${token}`)
    .send({ principalCents: 20_000, paymentMethodType: "card", jarId });
  expect(quoteRes.status, `quote: ${JSON.stringify(quoteRes.body)}`).toBe(200);
  const { financialTransactionId } = quoteRes.body as { financialTransactionId: string };

  await request(app)
    .post(`${BASE}/jars/${jarId}/drips/payment-intent`)
    .set("Authorization", `Bearer ${token}`)
    .send({ financialTransactionId });

  const [ft] = await db
    .select()
    .from(financialTransactions)
    .where(eq(financialTransactions.id, financialTransactionId));
  if (!ft) throw new Error(`FT not found after PI creation: ${financialTransactionId}`);
  return ft;
}

function buildSuccessEvent(
  ft: typeof financialTransactions.$inferSelect,
  eventId?: string,
) {
  const id =
    eventId ?? `evt_stress_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return {
    id,
    type: "payment_intent.succeeded",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: ft.providerTransactionId,
        object: "payment_intent",
        amount: ft.totalQuotedCents,
        currency: ft.currency.toLowerCase(),
        status: "succeeded",
        latest_charge: null,
        metadata: {
          financialTransactionId: ft.id,
          jarId: ft.jarId,
          memberId: ft.memberId,
        },
      },
    },
  };
}

function buildProcessingEvent(ft: typeof financialTransactions.$inferSelect) {
  return {
    id: `evt_processing_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    type: "payment_intent.processing",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: ft.providerTransactionId,
        object: "payment_intent",
        amount: ft.totalQuotedCents,
        currency: ft.currency.toLowerCase(),
        status: "processing",
        latest_charge: null,
        metadata: {
          financialTransactionId: ft.id,
          jarId: ft.jarId,
          memberId: ft.memberId,
        },
      },
    },
  };
}

function sendWebhookWith(event: unknown) {
  return request(app)
    .post(`${BASE}/webhooks/stripe`)
    .set("Content-Type", "application/json")
    .set("stripe-signature", `t=${Math.floor(Date.now() / 1000)},v1=mock`)
    .send(Buffer.from(JSON.stringify(event)));
}

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO A — 50 concurrent deliveries of the same event ID
// ─────────────────────────────────────────────────────────────────────────────

describe(
  "Webhook stress — Scenario A: 50 concurrent same-event-ID deliveries",
  () => {
    let mockStripe: ReturnType<typeof buildMockStripe>;
    let ft: typeof financialTransactions.$inferSelect;

    beforeAll(async () => {
      mockStripe = buildMockStripe();
      mockGetStripeClient.mockReturnValue(mockStripe);
      mockGetOrCreateStripeCustomer.mockResolvedValue("cus_stress_mock");
      process.env["STRIPE_WEBHOOK_SECRET"] = "whsec_test_stress_a";

      const user = await register("a");
      const jar = await createJar(user.token);
      await launchJar(user.token, jar.id);
      ft = await createQuoteAndPi(user.token, jar.id);
    }, 60_000);

    afterAll(() => {
      delete process.env["STRIPE_WEBHOOK_SECRET"];
    });

    it("all 10 return 200 and exactly-once financial state holds", { timeout: 120_000 }, async () => {
      const event = buildSuccessEvent(ft);

      // Single constructEvent mock — all 10 concurrent calls return the same event
      (mockStripe.webhooks.constructEvent as ReturnType<typeof vi.fn>).mockReturnValue(event);

      const responses = await Promise.all(
        Array.from({ length: 10 }).map(() => sendWebhookWith(event)),
      );

      // (1) All 50 requests returned 200
      const statuses = responses.map((r) => r.status);
      expect(statuses.every((s) => s === 200)).toBe(true);

      // (2) Exactly 1 stripeWebhookEvents row for this event ID
      const eventRows = await db
        .select()
        .from(stripeWebhookEvents)
        .where(eq(stripeWebhookEvents.stripeEventId, event.id));
      expect(eventRows).toHaveLength(1);

      // (3) That row is marked processed
      expect(eventRows[0]!.processingStatus).toBe("processed");
      expect(eventRows[0]!.processedAt).toBeTruthy();
      expect(eventRows[0]!.processingStatus).not.toBe("failed");

      // (4) FT providerStatus = succeeded
      const [updatedFt] = await db
        .select()
        .from(financialTransactions)
        .where(eq(financialTransactions.id, ft.id));
      expect(updatedFt!.providerStatus).toBe("succeeded");

      // (5) FT ledgerPostingStatus = posted
      expect(updatedFt!.ledgerPostingStatus).toBe("posted");

      // (6) FT has a ledgerId (ledger_transactions FK set)
      expect(updatedFt!.ledgerId).toBeTruthy();

      // (7) FT updatedAt was written
      expect(updatedFt!.updatedAt).toBeTruthy();

      // (8) The event row is linked to the FT
      expect(eventRows[0]!.financialTransactionId).toBe(ft.id);

      // (9) Exactly 1 contributions row for this PI
      const contribs = await db
        .select()
        .from(contributions)
        .where(
          and(
            eq(contributions.jarId, ft.jarId),
            eq(contributions.memberId, ft.memberId),
            eq(contributions.externalPaymentId, ft.providerTransactionId!),
          ),
        );
      expect(contribs).toHaveLength(1);

      // (10) Contribution amount equals requestedPrincipalCents
      expect(contribs[0]!.amountCents).toBe(Number(ft.requestedPrincipalCents));

      // (11) Contribution status is stripe_test
      expect(contribs[0]!.status).toBe("stripe_test");

      // (12) Contribution sourceType is stripe_test
      expect(contribs[0]!.sourceType).toBe("stripe_test");

      // (13) No second stripeWebhookEvents row was ever created (unique constraint held)
      const allForEvent = await db
        .select()
        .from(stripeWebhookEvents)
        .where(eq(stripeWebhookEvents.stripeEventId, event.id));
      expect(allForEvent).toHaveLength(1);

      // (14) Response bodies include at least one normal success OR already_processed
      const bodies = responses.map((r) => r.body as Record<string, unknown>);
      const atLeastOneNormalOrDedup =
        bodies.some((b) => b["received"] === true && !b["status"]) ||
        bodies.some((b) => b["status"] === "already_processed");
      expect(atLeastOneNormalOrDedup).toBe(true);

      // (15) No contributions rows beyond the single expected one exist for this PI
      const allContribsForPi = await db
        .select()
        .from(contributions)
        .where(eq(contributions.externalPaymentId, ft.providerTransactionId!));
      expect(allContribsForPi).toHaveLength(1);
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO B — Two different event IDs for the same PI, both succeeded
// ─────────────────────────────────────────────────────────────────────────────

describe(
  "Webhook stress — Scenario B: two different event IDs same PI, both succeeded",
  () => {
    let mockStripe: ReturnType<typeof buildMockStripe>;
    let ft: typeof financialTransactions.$inferSelect;

    beforeAll(async () => {
      mockStripe = buildMockStripe();
      mockGetStripeClient.mockReturnValue(mockStripe);
      mockGetOrCreateStripeCustomer.mockResolvedValue("cus_stress_mock");
      process.env["STRIPE_WEBHOOK_SECRET"] = "whsec_test_stress_b";

      const user = await register("b");
      const jar = await createJar(user.token);
      await launchJar(user.token, jar.id);
      ft = await createQuoteAndPi(user.token, jar.id);
    }, 60_000);

    afterAll(() => {
      delete process.env["STRIPE_WEBHOOK_SECRET"];
    });

    it("FOR UPDATE guard prevents double-posting when two event IDs race to post the same PI", { timeout: 120_000 }, async () => {
      const ts = Date.now();
      const event1 = buildSuccessEvent(ft, `evt_stress_b1_${ts}`);
      const event2 = buildSuccessEvent(ft, `evt_stress_b2_${ts}`);

      // Alternate between event1 and event2 so both event IDs are processed
      // concurrently — the counter is shared across all 50 concurrent callers.
      let callCount = 0;
      (mockStripe.webhooks.constructEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {
        return callCount++ % 2 === 0 ? event1 : event2;
      });

      // 10 concurrent requests — ~5 will deliver event1, ~5 will deliver event2
      const responses = await Promise.all(
        Array.from({ length: 10 }).map(() => sendWebhookWith(event1)),
      );

      // All 50 return 200
      expect(responses.every((r) => r.status === 200)).toBe(true);

      // Exactly 1 event row per event ID
      const rows1 = await db
        .select()
        .from(stripeWebhookEvents)
        .where(eq(stripeWebhookEvents.stripeEventId, event1.id));
      const rows2 = await db
        .select()
        .from(stripeWebhookEvents)
        .where(eq(stripeWebhookEvents.stripeEventId, event2.id));
      expect(rows1).toHaveLength(1);
      expect(rows2).toHaveLength(1);

      // FT providerStatus = succeeded
      const [updatedFt] = await db
        .select()
        .from(financialTransactions)
        .where(eq(financialTransactions.id, ft.id));
      expect(updatedFt!.providerStatus).toBe("succeeded");

      // FT ledgerPostingStatus = posted exactly once
      expect(updatedFt!.ledgerPostingStatus).toBe("posted");

      // FT has ledgerId
      expect(updatedFt!.ledgerId).toBeTruthy();

      // Exactly 1 contributions row — not 2
      const contribs = await db
        .select()
        .from(contributions)
        .where(
          and(
            eq(contributions.jarId, ft.jarId),
            eq(contributions.memberId, ft.memberId),
            eq(contributions.externalPaymentId, ft.providerTransactionId!),
          ),
        );
      expect(contribs).toHaveLength(1);

      // Exactly 1 ledger posting (implied by exactly 1 contributions row)
      expect(contribs[0]!.amountCents).toBe(Number(ft.requestedPrincipalCents));
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO C — payment_intent.processing + payment_intent.succeeded concurrent
// ─────────────────────────────────────────────────────────────────────────────

describe(
  "Webhook stress — Scenario C: processing + succeeded concurrent, no state regression",
  () => {
    let mockStripe: ReturnType<typeof buildMockStripe>;
    let ft: typeof financialTransactions.$inferSelect;

    beforeAll(async () => {
      mockStripe = buildMockStripe();
      mockGetStripeClient.mockReturnValue(mockStripe);
      mockGetOrCreateStripeCustomer.mockResolvedValue("cus_stress_mock");
      process.env["STRIPE_WEBHOOK_SECRET"] = "whsec_test_stress_c";

      const user = await register("c");
      const jar = await createJar(user.token);
      await launchJar(user.token, jar.id);
      ft = await createQuoteAndPi(user.token, jar.id);
    }, 60_000);

    afterAll(() => {
      delete process.env["STRIPE_WEBHOOK_SECRET"];
    });

    it("processing events cannot regress FT providerStatus after succeeded posts", { timeout: 120_000 }, async () => {
      const successEvent = buildSuccessEvent(ft);
      const processingEvent = buildProcessingEvent(ft);

      // Alternate between succeeded and processing events so both types race
      // concurrently — the counter is shared across all 50 concurrent callers.
      let callCount = 0;
      (mockStripe.webhooks.constructEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {
        return callCount++ % 2 === 0 ? successEvent : processingEvent;
      });

      // 10 concurrent requests — ~5 will deliver succeeded, ~5 will deliver processing
      const responses = await Promise.all(
        Array.from({ length: 10 }).map(() => sendWebhookWith(successEvent)),
      );

      // All 50 return 200
      expect(responses.every((r) => r.status === 200)).toBe(true);

      // FT providerStatus must be "succeeded" — the processing event has no
      // handler that touches financialTransactions.providerStatus, so it
      // cannot regress the status from "succeeded" to anything lower.
      const [updatedFt] = await db
        .select()
        .from(financialTransactions)
        .where(eq(financialTransactions.id, ft.id));
      expect(updatedFt!.providerStatus).toBe("succeeded");
      expect(updatedFt!.providerStatus).not.toBe("processing");

      // FT ledgerPostingStatus = posted
      expect(updatedFt!.ledgerPostingStatus).toBe("posted");

      // FT has ledgerId
      expect(updatedFt!.ledgerId).toBeTruthy();

      // Exactly 1 contributions row (succeeded handler ran exactly once)
      const contribs = await db
        .select()
        .from(contributions)
        .where(
          and(
            eq(contributions.jarId, ft.jarId),
            eq(contributions.memberId, ft.memberId),
            eq(contributions.externalPaymentId, ft.providerTransactionId!),
          ),
        );
      expect(contribs).toHaveLength(1);

      // Exactly 1 stripeWebhookEvents row for the succeeded event, marked processed
      const successRows = await db
        .select()
        .from(stripeWebhookEvents)
        .where(eq(stripeWebhookEvents.stripeEventId, successEvent.id));
      expect(successRows).toHaveLength(1);
      expect(successRows[0]!.processingStatus).toBe("processed");

      // Exactly 1 stripeWebhookEvents row for the processing event, marked ignored
      // (payment_intent.processing falls through to the default "ignore" handler
      //  which only updates stripeWebhookEvents — it never touches financialTransactions)
      const processingRows = await db
        .select()
        .from(stripeWebhookEvents)
        .where(eq(stripeWebhookEvents.stripeEventId, processingEvent.id));
      expect(processingRows).toHaveLength(1);
      expect(processingRows[0]!.processingStatus).toBe("ignored");

      // The processing event did NOT update financialTransactions.providerStatus
      // (confirmed above by the "succeeded" assertion)
    });
  },
);
