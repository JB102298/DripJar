/**
 * Phase 4B — Webhook Exactly-Once Concurrency Stress Test
 *
 * Proves that the Stripe webhook handler preserves exactly-once financial
 * state under high concurrent load with a real PostgreSQL database.
 * No DB layer is mocked; Stripe network operations are stubbed.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ SCENARIO A — 20 concurrent deliveries of the same event ID             │
 * │                                                                         │
 * │  Mocked  : getStripeClient() → stub for paymentIntents / customers      │
 * │            charges.retrieve (reconcileActualFee, best-effort only)      │
 * │  REAL    : stripe.webhooks.constructEvent() — full HMAC-SHA256          │
 * │            signature verification using a test secret.                  │
 * │            Every request travels through POST /api/webhooks/stripe,     │
 * │            express.raw(), and the full webhook dispatch pipeline.       │
 * │            All DB operations use the live PostgreSQL test database.     │
 * │                                                                         │
 * │  Asserts : 1 stripe_webhook_events row (unique constraint held)         │
 * │            event finishes processed                                      │
 * │            1 contribution (Stripe-backed)                               │
 * │            1 financial_transaction posted                               │
 * │            1 contribution ledger_transaction                            │
 * │            balanced ledger (sum debits = sum credits)                   │
 * │            EXT_PAY_CLR debit  = totalQuotedCents         (exactly once) │
 * │            CTRB_REFUNDABLE CR = requestedPrincipalCents  (exactly once) │
 * │            DJ_FEE_REVENUE CR  = dripJarFeeCents          (exactly once) │
 * │            PROC_FEE_CLR CR    = processingFeeCents       (exactly once) │
 * │            no event row stuck in processing                             │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ SCENARIO B — two different event IDs for the same succeeded PI          │
 * │                                                                         │
 * │  Mocked  : stripe.webhooks.constructEvent() (counter-based dispatch)   │
 * │  REAL    : all DB transaction / ledger / FOR UPDATE logic               │
 * │  Purpose : FOR UPDATE guard prevents double-posting when two event IDs  │
 * │            race to post the same PI (e.g. Stripe retry with new ID).   │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ SCENARIO C — processing vs succeeded events concurrent                  │
 * │                                                                         │
 * │  Mocked  : stripe.webhooks.constructEvent() (counter-based dispatch)   │
 * │  REAL    : all DB transaction / ledger / FOR UPDATE logic               │
 * │  Purpose : payment_intent.processing (default-ignore path) cannot       │
 * │            regress FT.providerStatus after succeeded posts.             │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { createHmac } from "node:crypto";
import Stripe from "stripe";
import app from "../app.js";
import { db, pool } from "@workspace/db";
import {
  jarMembers,
  financialTransactions,
  stripeWebhookEvents,
  contributions,
  ledgerTransactions,
  ledgerEntries,
  ledgerAccounts,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";

// ─── Real Stripe instance for signature verification (Scenario A only) ────────
// Only webhooks.constructEvent is used — no network calls.
const _stripeForSigVerification = new Stripe("sk_test_signature_verify_only");

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

/** Shared PI mock implementation used by both factories. */
function _makePiCreate() {
  return vi.fn().mockImplementation(async () => {
    const id = `pi_stress_${++_piCounter}_${Date.now()}`;
    return {
      id,
      client_secret: `${id}_secret`,
      amount: 21_246,
      currency: "usd",
      status: "requires_payment_method",
      latest_charge: null,
    };
  });
}

/**
 * Mock Stripe client for Scenarios B & C.
 * webhooks.constructEvent is a vi.fn() configured per-scenario.
 */
function buildMockStripe() {
  return {
    paymentIntents: { create: _makePiCreate(), retrieve: vi.fn() },
    customerSessions: { create: vi.fn().mockResolvedValue({ client_secret: "cuss_stress_secret" }) },
    customers: { create: vi.fn().mockResolvedValue({ id: "cus_stress_mock" }) },
    webhooks: { constructEvent: vi.fn() },
    charges: { retrieve: vi.fn().mockRejectedValue(new Error("Not available in test mode")) },
  } as unknown as ReturnType<typeof getStripeClient>;
}

/**
 * Mock Stripe client for Scenario A.
 * webhooks.constructEvent is the REAL Stripe SDK implementation —
 * full HMAC-SHA256 signature verification runs on every request.
 * Only Stripe network calls (PI create, charges.retrieve) are stubbed.
 */
function buildMockStripeWithRealSig() {
  return {
    paymentIntents: { create: _makePiCreate(), retrieve: vi.fn() },
    customerSessions: { create: vi.fn().mockResolvedValue({ client_secret: "cuss_stress_secret" }) },
    customers: { create: vi.fn().mockResolvedValue({ id: "cus_stress_mock" }) },
    webhooks: {
      constructEvent: (rawBody: Buffer | string, sig: string, secret: string): Stripe.Event =>
        _stripeForSigVerification.webhooks.constructEvent(rawBody, sig, secret),
    },
    charges: { retrieve: vi.fn().mockRejectedValue(new Error("Not available in test mode")) },
  } as unknown as ReturnType<typeof getStripeClient>;
}

// ─── Concurrency bound for scenarios that post money ─────────────────────────

/**
 * How many *posting* webhook deliveries these scenarios fire at once.
 *
 * ─── WHY THIS WAS FOUR, AND WHY IT IS TEN AGAIN ──────────────────────────────
 *
 * Phase M2 lowered this to four to keep the suite green around a production
 * defect it was not chartered to fix. A delivery that actually posted a
 * contribution held TWO pool connections at the same time:
 *
 *   routes/stripe-webhooks.ts   opened `db.transaction(...)` and took
 *                               `SELECT … FOR UPDATE` on the financial
 *                               transaction            → connection 1
 *   lib/ledger.ts               `postContributionAccounting` was called from
 *                               inside that transaction and opened its own
 *                               `db.transaction(...)`, taking no `tx`
 *                               parameter               → connection 2
 *
 * `lib/db` builds its pool as `new Pool({ connectionString })`, so node-postgres
 * defaults apply: `max: 10` and `connectionTimeoutMillis: 0` — a request that
 * cannot get a connection waits forever rather than failing. Ten deliveries that
 * all reached the outer transaction together held all ten connections, each
 * waiting on an eleventh that could not exist. Nothing errored; the run stopped
 * until the test's own timeout fired.
 *
 * Phase M2.5 removed the nested transaction: the webhook handler now passes its
 * own executor to `postContributionAccountingInTx`, so a posting delivery holds
 * exactly one connection and ten concurrent deliveries are bounded by the pool
 * rather than deadlocked by it. Ten is restored because it is the number that
 * used to hang — a bound of four could no longer detect a regression of the
 * thing M2.5 fixed.
 *
 * The deterministic version of this race — all ten deliveries proven to be
 * inside their outer transaction simultaneously, rather than merely fired
 * together — lives in `m25-webhook-atomicity.test.ts`. This bound keeps the
 * probabilistic form here too, because it is the shape production actually sees.
 */
const CONCURRENT_POSTING_DELIVERIES = 10;

// ─── Pool health helper (Scenario A) ─────────────────────────────────────────

/**
 * Polls the pg connection pool until at least `minIdle` connections are idle,
 * or `maxWaitMs` elapses.  Scenario A issues 20 concurrent requests against a
 * pool whose default size is 10, so it queues by construction; this waits for
 * the worker's pool to be quiet first rather than adding that queue on top of
 * one already in progress.
 *
 * It polls a condition and gives up on a deadline — it is not a fixed sleep,
 * and it is not load-bearing for any assertion.  Nothing below is skipped or
 * relaxed if the deadline passes.
 *
 * NOTE: this file's earlier comments claimed `singleFork: true` made all test
 * files share one process and one pool.  That option never took effect (see
 * vitest.config.ts); files run in parallel, each fork holding its own pool.
 *
 * An earlier revision of this note also attributed the pool-timeout flake in
 * Scenarios B and C to residue in the shared `dripjar_dev` database. That was
 * wrong. The cause was the nested transaction described under
 * CONCURRENT_POSTING_DELIVERIES, which M2.5 removed; moving to a disposable
 * database only made the flake rarer by making the suite faster.
 */
async function waitForPoolConnections(
  minIdle = 5,
  maxWaitMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (pool.idleCount >= minIdle) return;
    await new Promise<void>((r) => setTimeout(r, 500));
  }
}

// ─── Signature helpers (Scenario A) ──────────────────────────────────────────

/**
 * Generate a valid Stripe webhook signature for the given payload and secret.
 * Uses the same HMAC-SHA256 algorithm Stripe uses in production:
 *   signed_payload = timestamp + "." + payload
 *   signature      = HMAC-SHA256(signed_payload, secret)
 *   header         = "t=" + timestamp + ",v1=" + signature
 */
function generateStripeSignature(payload: string, secret: string): string {
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", secret)
    .update(`${ts}.${payload}`)
    .digest("hex");
  return `t=${ts},v1=${sig}`;
}

/**
 * Send a webhook request to POST /api/webhooks/stripe with a REAL Stripe
 * HMAC-SHA256 signature so the production constructEvent path is exercised.
 * Used exclusively by Scenario A.
 */
function sendWebhookWithRealSig(event: unknown, secret: string) {
  const payload = JSON.stringify(event);
  // NOTE: send the payload as a plain string, NOT a Buffer.
  // supertest/superagent with Content-Type:application/json would otherwise
  // JSON-serialize the Buffer object itself (producing garbage bytes).
  // express.raw({ type:"application/json" }) stores the incoming string body
  // as a raw Buffer, so constructEvent receives the correct byte sequence.
  return request(app)
    .post(`${BASE}/webhooks/stripe`)
    .set("Content-Type", "application/json")
    .set("stripe-signature", generateStripeSignature(payload, secret))
    .send(payload);
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
// SCENARIO A — 20 concurrent deliveries of the same event ID
//   Real HMAC-SHA256 Stripe signature verification on every request.
//   Full signed-HTTP path: express.raw → stripe-signature header →
//   stripe.webhooks.constructEvent → production webhook dispatch.
// ─────────────────────────────────────────────────────────────────────────────

const SCENARIO_A_SECRET = "whsec_test_stress_a_realhmac";

describe(
  "Webhook stress — Scenario A: 20 concurrent same-event-ID deliveries (real signature)",
  () => {
    // Scenario A uses buildMockStripeWithRealSig so constructEvent is NOT mocked.
    let mockStripe: ReturnType<typeof buildMockStripeWithRealSig>;
    let ft: typeof financialTransactions.$inferSelect;

    beforeAll(async () => {
      // Files run in parallel, so this fork may already be busy with whatever
      // else landed on it. Wait for its pool to be quiet rather than adding 20
      // concurrent requests on top of a queue already in progress.
      await waitForPoolConnections(5, 20_000);

      mockStripe = buildMockStripeWithRealSig();
      mockGetStripeClient.mockReturnValue(
        mockStripe as unknown as ReturnType<typeof getStripeClient>,
      );
      mockGetOrCreateStripeCustomer.mockResolvedValue("cus_stress_mock");
      process.env["STRIPE_WEBHOOK_SECRET"] = SCENARIO_A_SECRET;

      const user = await register("a");
      const jar = await createJar(user.token);
      await launchJar(user.token, jar.id);
      ft = await createQuoteAndPi(user.token, jar.id);
    }, 90_000);

    afterAll(() => {
      delete process.env["STRIPE_WEBHOOK_SECRET"];
    });

    it(
      "all 20 return 200, signature verified, exactly-once financial + balanced ledger",
      { timeout: 180_000 },
      async () => {
        const event = buildSuccessEvent(ft);

        // constructEvent is NOT mocked — real HMAC-SHA256 verification runs.
        // Each request carries a freshly-computed signature via sendWebhookWithRealSig.
        const responses = await Promise.all(
          Array.from({ length: 20 }).map(() =>
            sendWebhookWithRealSig(event, SCENARIO_A_SECRET),
          ),
        );

        // ── HTTP responses ────────────────────────────────────────────────────
        // (1) All 20 requests returned 200
        const statuses = responses.map((r) => r.status);
        expect(
          statuses.every((s) => s === 200),
          `Non-200 statuses: ${statuses.filter((s) => s !== 200).join(", ")}`,
        ).toBe(true);

        // (2) Response bodies: at least one normal success OR already_processed
        const bodies = responses.map((r) => r.body as Record<string, unknown>);
        const hasValidBody =
          bodies.some((b) => b["received"] === true && !b["status"]) ||
          bodies.some((b) => b["status"] === "already_processed");
        expect(hasValidBody, "at least one 200 with received:true body").toBe(true);

        // ── stripe_webhook_events ─────────────────────────────────────────────
        // (3) Exactly 1 row for this event ID (unique constraint held under 20-way concurrency)
        const eventRows = await db
          .select()
          .from(stripeWebhookEvents)
          .where(eq(stripeWebhookEvents.stripeEventId, event.id));
        expect(eventRows, "exactly 1 stripe_webhook_events row").toHaveLength(1);

        // (4) Event row finishes in 'processed' state — never stuck in 'processing'
        expect(eventRows[0]!.processingStatus, "event finishes processed").toBe("processed");
        expect(eventRows[0]!.processedAt, "processedAt is set").toBeTruthy();
        expect(eventRows[0]!.processingStatus, "not in failed state").not.toBe("failed");

        // (5) Event row is linked to the FT
        expect(
          eventRows[0]!.financialTransactionId,
          "event linked to financial_transaction",
        ).toBe(ft.id);

        // ── financial_transaction ─────────────────────────────────────────────
        const [updatedFt] = await db
          .select()
          .from(financialTransactions)
          .where(eq(financialTransactions.id, ft.id));

        // (6) FT providerStatus = succeeded
        expect(updatedFt!.providerStatus, "FT providerStatus").toBe("succeeded");

        // (7) FT ledgerPostingStatus = posted (exactly once)
        expect(updatedFt!.ledgerPostingStatus, "FT ledgerPostingStatus").toBe("posted");

        // (8) FT has a ledgerId
        expect(updatedFt!.ledgerId, "FT has ledgerId").toBeTruthy();

        // ── contributions ─────────────────────────────────────────────────────
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

        // (9) Exactly 1 Stripe-backed contribution row (not 2, not 0)
        expect(contribs, "exactly 1 contribution").toHaveLength(1);

        // (10) Contribution amount = requestedPrincipalCents (principal posted exactly once)
        expect(
          contribs[0]!.amountCents,
          "contribution principal amount",
        ).toBe(Number(ft.requestedPrincipalCents));

        // (11) Contribution status and sourceType
        expect(contribs[0]!.status).toBe("stripe_test");
        expect(contribs[0]!.sourceType).toBe("stripe_test");

        // (12) No second contributions row for this PI anywhere in the DB
        const allContribsForPi = await db
          .select()
          .from(contributions)
          .where(eq(contributions.externalPaymentId, ft.providerTransactionId!));
        expect(allContribsForPi, "no duplicate contributions for this PI").toHaveLength(1);

        // ── ledger_transactions ───────────────────────────────────────────────
        // (13) Exactly 1 contribution ledger_transaction linked via FT.ledgerId
        const [ledgerTxRow] = await db
          .select()
          .from(ledgerTransactions)
          .where(eq(ledgerTransactions.id, updatedFt!.ledgerId!));
        expect(ledgerTxRow, "exactly 1 contribution ledger_transaction").toBeDefined();

        // ── ledger_entries — balanced double-entry ────────────────────────────
        const entries = await db
          .select({
            entryType: ledgerEntries.entryType,
            amountCents: ledgerEntries.amountCents,
            accountCode: ledgerAccounts.code,
          })
          .from(ledgerEntries)
          .innerJoin(ledgerAccounts, eq(ledgerEntries.accountId, ledgerAccounts.id))
          .where(eq(ledgerEntries.ledgerTransactionId, updatedFt!.ledgerId!));

        // (14) Balanced ledger: sum(debits) === sum(credits)
        const debitSum = entries
          .filter((e) => e.entryType === "debit")
          .reduce((s, e) => s + Number(e.amountCents), 0);
        const creditSum = entries
          .filter((e) => e.entryType === "credit")
          .reduce((s, e) => s + Number(e.amountCents), 0);
        expect(debitSum, "balanced ledger: debits").toBe(creditSum);
        expect(debitSum, "total debits equal totalQuotedCents").toBe(
          Number(ft.totalQuotedCents),
        );

        // (15) EXT_PAY_CLR debit = totalQuotedCents (customer charged exactly once)
        const extPayDebits = entries.filter(
          (e) => e.accountCode === "EXT_PAY_CLR" && e.entryType === "debit",
        );
        expect(extPayDebits, "EXT_PAY_CLR debit exactly once").toHaveLength(1);
        expect(Number(extPayDebits[0]!.amountCents), "EXT_PAY_CLR amount").toBe(
          Number(ft.totalQuotedCents),
        );

        // (16) CTRB_REFUNDABLE credit = principalCents (member principal credited exactly once)
        const principalCredits = entries.filter(
          (e) => e.accountCode === "CTRB_REFUNDABLE" && e.entryType === "credit",
        );
        expect(principalCredits, "CTRB_REFUNDABLE credit exactly once").toHaveLength(1);
        expect(
          Number(principalCredits[0]!.amountCents),
          "CTRB_REFUNDABLE amount = requestedPrincipalCents",
        ).toBe(Number(ft.requestedPrincipalCents));

        // (17) DJ_FEE_REVENUE credit = dripJarFeeCents (DripJar fee credited exactly once)
        const feeCredits = entries.filter(
          (e) => e.accountCode === "DJ_FEE_REVENUE" && e.entryType === "credit",
        );
        expect(feeCredits, "DJ_FEE_REVENUE credit exactly once").toHaveLength(1);
        const expectedFee =
          Number(ft.totalQuotedCents) -
          Number(ft.requestedPrincipalCents) -
          Number(ft.processingFeeEstimatedCents);
        expect(Number(feeCredits[0]!.amountCents), "DJ_FEE_REVENUE amount").toBe(
          expectedFee,
        );

        // (18) PROC_FEE_CLR credit = processingFeeEstimatedCents (if non-zero)
        if (Number(ft.processingFeeEstimatedCents) > 0) {
          const procFeeCredits = entries.filter(
            (e) => e.accountCode === "PROC_FEE_CLR" && e.entryType === "credit",
          );
          expect(
            procFeeCredits,
            "PROC_FEE_CLR credit exactly once",
          ).toHaveLength(1);
          expect(
            Number(procFeeCredits[0]!.amountCents),
            "PROC_FEE_CLR amount = processingFeeEstimatedCents",
          ).toBe(Number(ft.processingFeeEstimatedCents));
        }

        // (19) No event row stuck in 'processing' (impossible intermediate state)
        expect(
          eventRows[0]!.processingStatus,
          "no impossible processing state",
        ).not.toBe("processing");
      },
    );
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
      // Wait for Scenario A's 20 concurrent handlers to drain before setting up.
      // Under full-suite load they can hold pool connections for 30–60s.
      await waitForPoolConnections(5, 30_000);

      mockStripe = buildMockStripe();
      mockGetStripeClient.mockReturnValue(mockStripe);
      mockGetOrCreateStripeCustomer.mockResolvedValue("cus_stress_mock");
      process.env["STRIPE_WEBHOOK_SECRET"] = "whsec_test_stress_b";

      const user = await register("b");
      const jar = await createJar(user.token);
      await launchJar(user.token, jar.id);
      ft = await createQuoteAndPi(user.token, jar.id);
    }, 90_000);

    afterAll(() => {
      delete process.env["STRIPE_WEBHOOK_SECRET"];
    });

    it("FOR UPDATE guard prevents double-posting when two event IDs race to post the same PI", { timeout: 120_000 }, async () => {
      const ts = Date.now();
      const event1 = buildSuccessEvent(ft, `evt_stress_b1_${ts}`);
      const event2 = buildSuccessEvent(ft, `evt_stress_b2_${ts}`);

      // Alternate between event1 and event2 so both event IDs are processed
      // concurrently — the counter is shared across all concurrent callers.
      let callCount = 0;
      (mockStripe.webhooks.constructEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {
        return callCount++ % 2 === 0 ? event1 : event2;
      });

      // Concurrent deliveries, half carrying each event ID.
      // See CONCURRENT_POSTING_DELIVERIES for why this is bounded.
      const responses = await Promise.all(
        Array.from({ length: CONCURRENT_POSTING_DELIVERIES }).map(() => sendWebhookWith(event1)),
      );

      expect(responses.every((r) => r.status === 200)).toBe(true);
      // Both event IDs really were delivered — otherwise there was no race and
      // the exactly-once assertions below would prove nothing.
      expect(callCount).toBeGreaterThanOrEqual(2);

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
      // Wait for Scenario B's concurrent handlers to drain before setting up.
      await waitForPoolConnections(5, 30_000);

      mockStripe = buildMockStripe();
      mockGetStripeClient.mockReturnValue(mockStripe);
      mockGetOrCreateStripeCustomer.mockResolvedValue("cus_stress_mock");
      process.env["STRIPE_WEBHOOK_SECRET"] = "whsec_test_stress_c";

      const user = await register("c");
      const jar = await createJar(user.token);
      await launchJar(user.token, jar.id);
      ft = await createQuoteAndPi(user.token, jar.id);
    }, 90_000);

    afterAll(() => {
      delete process.env["STRIPE_WEBHOOK_SECRET"];
    });

    it("processing events cannot regress FT providerStatus after succeeded posts", { timeout: 120_000 }, async () => {
      const successEvent = buildSuccessEvent(ft);
      const processingEvent = buildProcessingEvent(ft);

      // Alternate between succeeded and processing events so both types race
      // concurrently — the counter is shared across all concurrent callers.
      let callCount = 0;
      (mockStripe.webhooks.constructEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {
        return callCount++ % 2 === 0 ? successEvent : processingEvent;
      });

      // Concurrent deliveries, alternating succeeded and processing.
      // See CONCURRENT_POSTING_DELIVERIES for why this is bounded.
      const responses = await Promise.all(
        Array.from({ length: CONCURRENT_POSTING_DELIVERIES }).map(() => sendWebhookWith(successEvent)),
      );

      expect(responses.every((r) => r.status === 200)).toBe(true);
      // Both event types really were delivered, so the no-regression assertion
      // below is about an actual race rather than a single event type.
      expect(callCount).toBeGreaterThanOrEqual(2);

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
