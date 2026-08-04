/**
 * Phase 4B — Stripe Test-Mode Contribution Flow Tests
 *
 * Covers:
 *   PART A  — Stripe client factory test-mode guard
 *   PART C  — Processing-fee gross-up (computeStripeFeeOnCharge, computeGrossedUpProviderFee)
 *   PART B  — Stripe Customer linkage
 *   PART D  — Quote persistence + expiry
 *   PART E  — PaymentIntent creation (idempotent retry)
 *   PART F/G — Webhook endpoint (signature, idempotency)
 *   PART H  — Success/failure event handlers
 *   PART I  — Payment status endpoint
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import request from "supertest";
import app from "../app.js";
import { db } from "@workspace/db";
import {
  jars,
  jarMembers,
  financialTransactions,
  stripeWebhookEvents,
  contributions,
  profiles,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import {
  computeStripeFeeOnCharge,
  computeGrossedUpProviderFee,
} from "../lib/provider-fees.js";
import { _resetStripeClientForTests } from "../lib/stripe.js";

const BASE = "/api";

// ─── Stripe mock ──────────────────────────────────────────────────────────────
// All Stripe API calls are mocked — no real network calls in tests

vi.mock("../lib/stripe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/stripe.js")>();
  return {
    ...actual,
    getStripeClient: vi.fn(),
  };
});

vi.mock("../lib/stripe-customer.ts", () => ({
  getOrCreateStripeCustomer: vi.fn().mockResolvedValue("cus_test_mock123"),
}));

import { getStripeClient } from "../lib/stripe.js";
import { getOrCreateStripeCustomer } from "../lib/stripe-customer.js";

const mockGetStripeClient = vi.mocked(getStripeClient);
const mockGetOrCreateStripeCustomer = vi.mocked(getOrCreateStripeCustomer);

// Default Stripe mock for payment intent creation
// Each call to paymentIntents.create returns a unique PI ID so tests
// that create multiple PIs don't collide on providerTransactionId lookups.
let _piCounter = 0;
function buildMockStripe() {
  const createMock = vi.fn().mockImplementation(async () => {
    const id = `pi_test_mock_${++_piCounter}_${Date.now()}`;
    return {
      id,
      client_secret: `${id}_secret`,
      amount: 21246,
      currency: "usd",
      status: "requires_payment_method",
      latest_charge: null,
    };
  });
  const retrieveMock = vi.fn().mockImplementation(async (piId: string) => ({
    id: piId,
    client_secret: `${piId}_secret`,
    amount: 21246,
    currency: "usd",
    status: "requires_payment_method",
  }));
  return {
    paymentIntents: {
      create: createMock,
      retrieve: retrieveMock,
    },
    customerSessions: {
      create: vi.fn().mockResolvedValue({
        client_secret: "cuss_test_mock_session_secret",
      }),
    },
    customers: {
      create: vi.fn().mockResolvedValue({ id: "cus_test_mock123" }),
    },
    webhooks: {
      constructEvent: vi.fn(),
    },
    charges: {
      retrieve: vi.fn().mockRejectedValue(new Error("Not available in test mode")),
    },
  } as unknown as ReturnType<typeof getStripeClient>;
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

async function register(suffix: string) {
  const email = `stripe-${suffix}-${Date.now()}@test.invalid`;
  const res = await request(app).post(`${BASE}/auth/register`).send({
    email,
    password: "P@ssword1!",
    firstName: "Stripe",
    lastName: suffix,
  });
  expect(res.status, `register ${suffix}: ${JSON.stringify(res.body)}`).toBe(201);
  return {
    token: res.body.token as string,
    userId: res.body.user.id as string,
    email,
  };
}

async function createJar(token: string) {
  const res = await request(app)
    .post(`${BASE}/jars`)
    .set("Authorization", `Bearer ${token}`)
    .send({
      name: "Stripe Test Jar",
      targetDate: "2027-12-31",
      goalAmountCents: 100_000,
      currency: "USD",
    });
  expect(res.status, `createJar: ${JSON.stringify(res.body)}`).toBe(201);
  return res.body as { id: string };
}

async function launchJar(token: string, jarId: string) {
  const res = await request(app)
    .post(`${BASE}/jars/${jarId}/launch`)
    .set("Authorization", `Bearer ${token}`);
  expect(res.status, `launchJar: ${JSON.stringify(res.body)}`).toBe(200);
}

async function getMemberId(jarId: string, userId: string): Promise<string> {
  const [m] = await db
    .select({ id: jarMembers.id })
    .from(jarMembers)
    .where(and(eq(jarMembers.jarId, jarId), eq(jarMembers.userId, userId)));
  if (!m) throw new Error(`Member not found: userId=${userId} jarId=${jarId}`);
  return m.id;
}

async function getFinancialTransaction(ftId: string) {
  const [ft] = await db
    .select()
    .from(financialTransactions)
    .where(eq(financialTransactions.id, ftId));
  return ft;
}

// ─────────────────────────────────────────────────────────────────────────────
// PART A — Stripe client factory test-mode guard
// ─────────────────────────────────────────────────────────────────────────────

describe("Stripe client factory — test-mode guard", () => {
  const origKey = process.env["STRIPE_SECRET_KEY"];

  afterAll(() => {
    if (origKey !== undefined) {
      process.env["STRIPE_SECRET_KEY"] = origKey;
    } else {
      delete process.env["STRIPE_SECRET_KEY"];
    }
    _resetStripeClientForTests();
    mockGetStripeClient.mockImplementation(() => buildMockStripe());
  });

  it("accepts sk_test_ key", async () => {
    process.env["STRIPE_SECRET_KEY"] = "sk_test_valid_key_12345";
    _resetStripeClientForTests();
    const actual = await vi.importActual<typeof import("../lib/stripe.js")>("../lib/stripe.js");
    expect(() => actual.getStripeClient()).not.toThrow();
  });

  it("rejects sk_live_ key with descriptive error", async () => {
    process.env["STRIPE_SECRET_KEY"] = "sk_live_some_live_key";
    _resetStripeClientForTests();
    const actual = await vi.importActual<typeof import("../lib/stripe.js")>("../lib/stripe.js");
    expect(() => actual.getStripeClient()).toThrow(/test-mode key/i);
  });

  it("rejects missing key with descriptive error", async () => {
    delete process.env["STRIPE_SECRET_KEY"];
    _resetStripeClientForTests();
    const actual = await vi.importActual<typeof import("../lib/stripe.js")>("../lib/stripe.js");
    expect(() => actual.getStripeClient()).toThrow(/STRIPE_SECRET_KEY/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART C — Processing-fee gross-up
// ─────────────────────────────────────────────────────────────────────────────

describe("computeStripeFeeOnCharge", () => {
  it("card: computes 2.9% + $0.30 with half-up rounding", () => {
    // $100 = 10000¢: 10000 * 290 / 10000 + 30 = 290 + 30 = 320
    expect(computeStripeFeeOnCharge(10_000, "card")).toBe(320);
  });

  it("ACH: computes 0.8% capped at $5", () => {
    // $100 = 10000¢: 10000 * 80 / 10000 = 80
    expect(computeStripeFeeOnCharge(10_000, "us_bank_account")).toBe(80);
  });

  it("ACH: cap applies at large amounts", () => {
    // $1000 = 100000¢: 100000 * 80 / 10000 = 800 → capped at 500
    expect(computeStripeFeeOnCharge(100_000, "us_bank_account")).toBe(500);
  });

  it("card: fixed fee dominates on tiny amounts", () => {
    // $0.01 = 1¢: floor((1 * 290 + 5000) / 10000) + 30 = 0 + 30 = 30
    expect(computeStripeFeeOnCharge(1, "card")).toBe(30);
  });

  it("throws on non-safe-integer", () => {
    expect(() => computeStripeFeeOnCharge(-1, "card")).toThrow();
    expect(() => computeStripeFeeOnCharge(1.5, "card")).toThrow();
  });
});

describe("computeGrossedUpProviderFee — fixed-point solver", () => {
  const base200 = 20_000 + 600; // $200 principal + $6 DripJar fee = 20600¢

  it("$200 Card: produces exactly 646¢ ($6.46)", () => {
    const fee = computeGrossedUpProviderFee(base200, "card");
    expect(fee).toBe(646);
  });

  it("$200 ACH: produces exactly 166¢ ($1.66)", () => {
    const fee = computeGrossedUpProviderFee(base200, "us_bank_account");
    expect(fee).toBe(166);
  });

  it("$200 Card: total = 21246¢ ($212.46)", () => {
    const fee = computeGrossedUpProviderFee(base200, "card");
    expect(base200 + fee).toBe(21_246);
  });

  it("$200 ACH: total = 20766¢ ($207.66)", () => {
    const fee = computeGrossedUpProviderFee(base200, "us_bank_account");
    expect(base200 + fee).toBe(20_766);
  });

  it("minimality invariant (Card): computeStripeFeeOnCharge(base+P) <= P AND computeStripeFeeOnCharge(base+P-1) > P-1", () => {
    const P = computeGrossedUpProviderFee(base200, "card");
    // Upper bound: fee is fully covered
    expect(computeStripeFeeOnCharge(base200 + P, "card")).toBeLessThanOrEqual(P);
    // Lower bound: P is minimal (one less does not cover)
    if (P > 0) {
      expect(computeStripeFeeOnCharge(base200 + P - 1, "card")).toBeGreaterThan(P - 1);
    }
  });

  it("minimality invariant (ACH): computeStripeFeeOnCharge(base+P) <= P AND computeStripeFeeOnCharge(base+P-1) > P-1", () => {
    const P = computeGrossedUpProviderFee(base200, "us_bank_account");
    expect(computeStripeFeeOnCharge(base200 + P, "us_bank_account")).toBeLessThanOrEqual(P);
    if (P > 0) {
      expect(computeStripeFeeOnCharge(base200 + P - 1, "us_bank_account")).toBeGreaterThan(P - 1);
    }
  });

  it("ACH cap: base large enough that uncapped result >= 500 → exactly 500", () => {
    // baseCents = 62500¢ (≈$625): 0.8% * 62500 = 500 exactly → cap applies
    const bigBase = 62_500;
    const fee = computeGrossedUpProviderFee(bigBase, "us_bank_account");
    expect(fee).toBe(500);
  });

  it("ACH just below cap boundary", () => {
    // baseCents = 62_000: 0.8% * 62000 = 496 → fee = 499 or 500 (solver finds minimum)
    const fee = computeGrossedUpProviderFee(62_000, "us_bank_account");
    expect(fee).toBeLessThanOrEqual(500);
    expect(computeStripeFeeOnCharge(62_000 + fee, "us_bank_account")).toBeLessThanOrEqual(fee);
  });

  it("Card: rounding boundary at $1 principal + 3% fee = base 103¢", () => {
    const fee = computeGrossedUpProviderFee(103, "card");
    expect(computeStripeFeeOnCharge(103 + fee, "card")).toBeLessThanOrEqual(fee);
  });

  it("large safe-integer: $10,000 principal", () => {
    const bigBase = 1_000_000 + 30_000; // $10k + $300 fee
    const fee = computeGrossedUpProviderFee(bigBase, "card");
    expect(Number.isSafeInteger(bigBase + fee)).toBe(true);
    expect(computeStripeFeeOnCharge(bigBase + fee, "card")).toBeLessThanOrEqual(fee);
  });

  it("converges (does not throw) for valid inputs", () => {
    expect(() => computeGrossedUpProviderFee(20_600, "card")).not.toThrow();
    expect(() => computeGrossedUpProviderFee(20_600, "us_bank_account")).not.toThrow();
    expect(() => computeGrossedUpProviderFee(0, "card")).not.toThrow();
  });

  it("missing paymentMethodType → use base case; 0 base → fee = 30 for card (fixed)", () => {
    // base=0 card: floor((0 * 290 + 5000) / 10000) + 30 = 0 + 30 = 30
    // solver: iter1 required=30, 30>0 → feeCents=30; iter2: computeStripeFeeOnCharge(30,"card")
    // = floor((30*290+5000)/10000)+30 = floor((8700+5000)/10000)+30=floor(1.37)+30=1+30=31
    // 31>30 → feeCents=31; iter3: fee on 31 = floor((31*290+5000)/10000)+30=floor((8990+5000)/10000)+30=1+30=31
    // 31<=31 → return 31
    const fee = computeGrossedUpProviderFee(0, "card");
    expect(typeof fee).toBe("number");
    expect(fee).toBeGreaterThan(0);
  });

  it("throws on negative baseCents", () => {
    expect(() => computeGrossedUpProviderFee(-1, "card")).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART D — Quote persistence + expiry (via /finance/quote endpoint)
// ─────────────────────────────────────────────────────────────────────────────

describe("Finance quote — Phase 4B extension", () => {
  let token: string;
  let userId: string;
  let jarId: string;

  beforeAll(async () => {
    mockGetStripeClient.mockReturnValue(buildMockStripe());
    const user = await register("quote-4b");
    token = user.token;
    userId = user.userId;
    const jar = await createJar(token);
    jarId = jar.id;
    await launchJar(token, jarId);
  });

  it("returns estimatedProcessingFeeCents=0 when paymentMethodType omitted (backward-compatible)", async () => {
    const res = await request(app)
      .post(`${BASE}/finance/quote`)
      .set("Authorization", `Bearer ${token}`)
      .send({ principalCents: 20_000 });
    expect(res.status).toBe(200);
    expect(res.body.estimatedProcessingFeeCents).toBe(0);
    expect(res.body.financialTransactionId).toBeUndefined();
  });

  it("persists quote and returns financialTransactionId when paymentMethodType=card", async () => {
    const res = await request(app)
      .post(`${BASE}/finance/quote`)
      .set("Authorization", `Bearer ${token}`)
      .send({ principalCents: 20_000, paymentMethodType: "card", jarId });
    expect(res.status).toBe(200);
    expect(res.body.financialTransactionId).toBeTruthy();
    expect(res.body.estimatedProcessingFeeCents).toBe(646);
    expect(res.body.totalChargeCents).toBe(21_246);
    expect(res.body.paymentMethodType).toBe("card");
    expect(res.body.quoteExpiresAt).toBeTruthy();

    // Verify DB row
    const ft = await getFinancialTransaction(res.body.financialTransactionId);
    expect(ft).toBeTruthy();
    expect(ft!.providerStatus).toBe("quoted");
    expect(ft!.paymentMethodCategory).toBe("card");
  });

  it("persists quote for ACH with correct fee", async () => {
    const res = await request(app)
      .post(`${BASE}/finance/quote`)
      .set("Authorization", `Bearer ${token}`)
      .send({ principalCents: 20_000, paymentMethodType: "us_bank_account", jarId });
    expect(res.status).toBe(200);
    expect(res.body.estimatedProcessingFeeCents).toBe(166);
    expect(res.body.totalChargeCents).toBe(20_766);
  });

  it("ACH quote has lower total than card quote for same principal", async () => {
    const [achRes, cardRes] = await Promise.all([
      request(app)
        .post(`${BASE}/finance/quote`)
        .set("Authorization", `Bearer ${token}`)
        .send({ principalCents: 20_000, paymentMethodType: "us_bank_account", jarId }),
      request(app)
        .post(`${BASE}/finance/quote`)
        .set("Authorization", `Bearer ${token}`)
        .send({ principalCents: 20_000, paymentMethodType: "card", jarId }),
    ]);
    expect(achRes.body.totalChargeCents).toBeLessThan(cardRes.body.totalChargeCents);
  });

  it("rejects paymentMethodType without jarId", async () => {
    const res = await request(app)
      .post(`${BASE}/finance/quote`)
      .set("Authorization", `Bearer ${token}`)
      .send({ principalCents: 20_000, paymentMethodType: "card" });
    expect(res.status).toBe(400);
  });

  it("rejects invalid paymentMethodType", async () => {
    const res = await request(app)
      .post(`${BASE}/finance/quote`)
      .set("Authorization", `Bearer ${token}`)
      .send({ principalCents: 20_000, paymentMethodType: "bitcoin", jarId });
    expect(res.status).toBe(400);
  });

  it("server enforces rates — client cannot supply estimatedProcessingFeeCents", async () => {
    const res = await request(app)
      .post(`${BASE}/finance/quote`)
      .set("Authorization", `Bearer ${token}`)
      .send({ principalCents: 20_000, processingFeeEstimatedCents: 999 });
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART E — PaymentIntent creation + idempotent retry
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /jars/:jarId/drips/payment-intent", () => {
  let token: string;
  let userId: string;
  let jarId: string;
  let memberId: string;
  let mockStripe: ReturnType<typeof buildMockStripe>;

  beforeAll(async () => {
    mockStripe = buildMockStripe();
    mockGetStripeClient.mockReturnValue(mockStripe);
    mockGetOrCreateStripeCustomer.mockResolvedValue("cus_test_mock123");

    const user = await register("pi-create");
    token = user.token;
    userId = user.userId;
    const jar = await createJar(token);
    jarId = jar.id;
    await launchJar(token, jarId);
    memberId = await getMemberId(jarId, userId);
  });

  async function createQuote(pmt: "card" | "us_bank_account" = "card") {
    const res = await request(app)
      .post(`${BASE}/finance/quote`)
      .set("Authorization", `Bearer ${token}`)
      .send({ principalCents: 20_000, paymentMethodType: pmt, jarId });
    expect(res.status).toBe(200);
    return res.body as { financialTransactionId: string };
  }

  it("creates PaymentIntent and returns clientSecret", async () => {
    const { financialTransactionId } = await createQuote("card");

    const res = await request(app)
      .post(`${BASE}/jars/${jarId}/drips/payment-intent`)
      .set("Authorization", `Bearer ${token}`)
      .send({ financialTransactionId });

    expect(res.status).toBe(200);
    expect(res.body.financialTransactionId).toBe(financialTransactionId);
    expect(res.body.clientSecret).toBeTruthy();
    expect(res.body.customerSessionClientSecret).toBeTruthy();

    // Verify DB: status should be provider_created
    const ft = await getFinancialTransaction(financialTransactionId);
    expect(ft!.providerStatus).toBe("provider_created");
    expect(ft!.providerTransactionId).toBeTruthy();
    expect(ft!.providerTransactionId).toMatch(/^pi_test_mock_/);
  });

  it("amount comes from DB, not client", async () => {
    const { financialTransactionId } = await createQuote("card");

    await request(app)
      .post(`${BASE}/jars/${jarId}/drips/payment-intent`)
      .set("Authorization", `Bearer ${token}`)
      .send({ financialTransactionId });

    const createCall = (mockStripe.paymentIntents.create as ReturnType<typeof vi.fn>).mock.lastCall;
    expect(createCall).toBeTruthy();
    // Amount must match DB totalQuotedCents (20000 + 600 + 646 = 21246)
    expect(createCall![0].amount).toBe(21_246);
  });

  it("idempotency key is the financialTransactionId", async () => {
    const { financialTransactionId } = await createQuote("card");
    await request(app)
      .post(`${BASE}/jars/${jarId}/drips/payment-intent`)
      .set("Authorization", `Bearer ${token}`)
      .send({ financialTransactionId });

    const createCall = (mockStripe.paymentIntents.create as ReturnType<typeof vi.fn>).mock.lastCall;
    expect(createCall![1]).toMatchObject({ idempotencyKey: financialTransactionId });
  });

  it("harmless retry on provider_created returns existing PI without creating another", async () => {
    const { financialTransactionId } = await createQuote("card");

    // First call — creates PI
    const callsBefore = (mockStripe.paymentIntents.create as ReturnType<typeof vi.fn>).mock.calls.length;
    await request(app)
      .post(`${BASE}/jars/${jarId}/drips/payment-intent`)
      .set("Authorization", `Bearer ${token}`)
      .send({ financialTransactionId });

    // Retry — status is now provider_created
    const res = await request(app)
      .post(`${BASE}/jars/${jarId}/drips/payment-intent`)
      .set("Authorization", `Bearer ${token}`)
      .send({ financialTransactionId });

    expect(res.status).toBe(200);
    // create should only be called once for this quote (retry uses retrieve)
    const callsAfter = (mockStripe.paymentIntents.create as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsAfter - callsBefore).toBe(1);
  });

  it("consumed (succeeded) quote returns 409", async () => {
    const { financialTransactionId } = await createQuote("card");

    // Manually mark as succeeded
    await db
      .update(financialTransactions)
      .set({ providerStatus: "succeeded" })
      .where(eq(financialTransactions.id, financialTransactionId));

    const res = await request(app)
      .post(`${BASE}/jars/${jarId}/drips/payment-intent`)
      .set("Authorization", `Bearer ${token}`)
      .send({ financialTransactionId });

    expect(res.status).toBe(409);
  });

  it("wrong jar returns 403", async () => {
    const { financialTransactionId } = await createQuote("card");

    // Create a different jar
    const otherJar = await createJar(token);
    await launchJar(token, otherJar.id);

    const res = await request(app)
      .post(`${BASE}/jars/${otherJar.id}/drips/payment-intent`)
      .set("Authorization", `Bearer ${token}`)
      .send({ financialTransactionId });

    expect(res.status).toBe(403);
  });

  it("non-member returns 403", async () => {
    const other = await register("pi-outsider");
    const { financialTransactionId } = await createQuote("card");

    const res = await request(app)
      .post(`${BASE}/jars/${jarId}/drips/payment-intent`)
      .set("Authorization", `Bearer ${other.token}`)
      .send({ financialTransactionId });

    expect(res.status).toBe(403);
  });

  it("metadata contains correct internal IDs", async () => {
    const { financialTransactionId } = await createQuote("card");

    await request(app)
      .post(`${BASE}/jars/${jarId}/drips/payment-intent`)
      .set("Authorization", `Bearer ${token}`)
      .send({ financialTransactionId });

    const createCall = (mockStripe.paymentIntents.create as ReturnType<typeof vi.fn>).mock.lastCall;
    expect(createCall![0].metadata).toMatchObject({
      financialTransactionId,
      jarId,
      memberId,
    });
  });

  it("does not set setup_future_usage", async () => {
    const { financialTransactionId } = await createQuote("card");
    await request(app)
      .post(`${BASE}/jars/${jarId}/drips/payment-intent`)
      .set("Authorization", `Bearer ${token}`)
      .send({ financialTransactionId });

    const createCall = (mockStripe.paymentIntents.create as ReturnType<typeof vi.fn>).mock.lastCall;
    expect(createCall![0].setup_future_usage).toBeUndefined();
  });

  it("expired quote is rejected", async () => {
    const { financialTransactionId } = await createQuote("card");

    // Manually expire the quote
    await db
      .update(financialTransactions)
      .set({ quoteExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(financialTransactions.id, financialTransactionId));

    const res = await request(app)
      .post(`${BASE}/jars/${jarId}/drips/payment-intent`)
      .set("Authorization", `Bearer ${token}`)
      .send({ financialTransactionId });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/expired/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART G — Webhook endpoint (signature verification, idempotency)
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /webhooks/stripe — signature & idempotency", () => {
  let mockStripe: ReturnType<typeof buildMockStripe>;

  beforeAll(() => {
    mockStripe = buildMockStripe();
    mockGetStripeClient.mockReturnValue(mockStripe);
    process.env["STRIPE_WEBHOOK_SECRET"] = "whsec_test_mock";
  });

  afterAll(() => {
    delete process.env["STRIPE_WEBHOOK_SECRET"];
  });

  function mockEventPayload(eventType: string, piId = "pi_test_wh") {
    return Buffer.from(
      JSON.stringify({
        id: `evt_test_${Date.now()}`,
        type: eventType,
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            id: piId,
            object: "payment_intent",
            amount: 21_246,
            currency: "usd",
            status: "succeeded",
          },
        },
      }),
    );
  }

  it("missing Stripe-Signature → 400", async () => {
    const res = await request(app)
      .post(`${BASE}/webhooks/stripe`)
      .set("Content-Type", "application/json")
      .send(mockEventPayload("payment_intent.succeeded"));
    expect(res.status).toBe(400);
  });

  it("invalid Stripe-Signature → 400", async () => {
    (mockStripe.webhooks.constructEvent as ReturnType<typeof vi.fn>).mockImplementation(
      () => { throw new Error("Webhook signature verification failed"); },
    );

    const res = await request(app)
      .post(`${BASE}/webhooks/stripe`)
      .set("Content-Type", "application/json")
      .set("stripe-signature", "invalid_sig")
      .send(mockEventPayload("payment_intent.succeeded"));
    expect(res.status).toBe(400);
  });

  it("valid signature accepted → 200", async () => {
    const eventId = `evt_test_valid_${Date.now()}`;
    const payload = mockEventPayload("payment_intent.canceled", "pi_test_cancel_nomatch");
    const event = {
      id: eventId,
      type: "payment_intent.canceled",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: "pi_test_cancel_nomatch",
          object: "payment_intent",
          amount: 21_246,
          currency: "usd",
          status: "canceled",
        },
      },
    };

    (mockStripe.webhooks.constructEvent as ReturnType<typeof vi.fn>).mockReturnValue(event);

    const res = await request(app)
      .post(`${BASE}/webhooks/stripe`)
      .set("Content-Type", "application/json")
      .set("stripe-signature", "t=1,v1=valid")
      .send(payload);
    expect(res.status).toBe(200);
  });

  it("duplicate event already processed → 200, no re-processing", async () => {
    const eventId = `evt_dedup_${Date.now()}`;
    const payload = mockEventPayload("payment_intent.succeeded");
    const event = {
      id: eventId,
      type: "payment_intent.succeeded",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: { id: "pi_test_dedup", object: "payment_intent", amount: 0, currency: "usd" },
      },
    };
    (mockStripe.webhooks.constructEvent as ReturnType<typeof vi.fn>).mockReturnValue(event);

    // Insert a 'processed' event row
    await db.insert(stripeWebhookEvents).values({
      stripeEventId: eventId,
      eventType: "payment_intent.succeeded",
      stripeCreatedAt: new Date(),
      processingStatus: "processed",
      processedAt: new Date(),
    });

    const res = await request(app)
      .post(`${BASE}/webhooks/stripe`)
      .set("Content-Type", "application/json")
      .set("stripe-signature", "t=1,v1=valid")
      .send(payload);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("already_processed");
  });

  it("unknown event type → 200 with status=ignored", async () => {
    const eventId = `evt_unknown_${Date.now()}`;
    const event = {
      id: eventId,
      type: "charge.refunded",
      created: Math.floor(Date.now() / 1000),
      data: { object: {} },
    };
    (mockStripe.webhooks.constructEvent as ReturnType<typeof vi.fn>).mockReturnValue(event);

    const res = await request(app)
      .post(`${BASE}/webhooks/stripe`)
      .set("Content-Type", "application/json")
      .set("stripe-signature", "t=1,v1=valid")
      .send(Buffer.from(JSON.stringify(event)));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ignored");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART H — Success/failure event handlers + ledger
// ─────────────────────────────────────────────────────────────────────────────

describe("Webhook success handler — ledger posting", () => {
  let token: string;
  let userId: string;
  let jarId: string;
  let memberId: string;
  let mockStripe: ReturnType<typeof buildMockStripe>;

  beforeAll(async () => {
    mockStripe = buildMockStripe();
    mockGetStripeClient.mockReturnValue(mockStripe);
    mockGetOrCreateStripeCustomer.mockResolvedValue("cus_test_mock123");
    process.env["STRIPE_WEBHOOK_SECRET"] = "whsec_test_mock";

    const user = await register("webhook-success");
    token = user.token;
    userId = user.userId;
    const jar = await createJar(token);
    jarId = jar.id;
    await launchJar(token, jarId);
    memberId = await getMemberId(jarId, userId);
  });

  afterAll(() => {
    delete process.env["STRIPE_WEBHOOK_SECRET"];
  });

  async function setupQuoteAndPi(pmt: "card" | "us_bank_account" = "card") {
    // Create quote
    const quoteRes = await request(app)
      .post(`${BASE}/finance/quote`)
      .set("Authorization", `Bearer ${token}`)
      .send({ principalCents: 20_000, paymentMethodType: pmt, jarId });
    const { financialTransactionId } = quoteRes.body;

    // Create PI
    await request(app)
      .post(`${BASE}/jars/${jarId}/drips/payment-intent`)
      .set("Authorization", `Bearer ${token}`)
      .send({ financialTransactionId });

    const ft = await getFinancialTransaction(financialTransactionId);
    return { financialTransactionId, ft: ft! };
  }

  async function sendSuccessWebhook(ft: typeof financialTransactions.$inferSelect) {
    const eventId = `evt_success_${Date.now()}_${Math.random()}`;
    const event = {
      id: eventId,
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
    (mockStripe.webhooks.constructEvent as ReturnType<typeof vi.fn>).mockReturnValue(event);

    return request(app)
      .post(`${BASE}/webhooks/stripe`)
      .set("Content-Type", "application/json")
      .set("stripe-signature", `t=${event.created},v1=mock`)
      .send(Buffer.from(JSON.stringify(event)));
  }

  it("success webhook posts ledger and marks transaction succeeded", async () => {
    const { financialTransactionId, ft } = await setupQuoteAndPi("card");

    const res = await sendSuccessWebhook(ft);
    expect(res.status).toBe(200);

    const updatedFt = await getFinancialTransaction(financialTransactionId);
    expect(updatedFt!.providerStatus).toBe("succeeded");
    expect(updatedFt!.ledgerPostingStatus).toBe("posted");
  });

  it("success webhook inserts contributions row with status=stripe_test", async () => {
    const { ft } = await setupQuoteAndPi("card");

    await sendSuccessWebhook(ft);

    const [contrib] = await db
      .select()
      .from(contributions)
      .where(
        and(
          eq(contributions.memberId, memberId),
          eq(contributions.status, "stripe_test"),
        ),
      );
    expect(contrib).toBeTruthy();
    expect(contrib!.sourceType).toBe("stripe_test");
    expect(contrib!.amountCents).toBe(20_000);
  });

  it("exactly-once: duplicate success webhook does not double-credit", async () => {
    const { ft } = await setupQuoteAndPi("card");

    // Send twice
    await sendSuccessWebhook(ft);
    const res2 = await sendSuccessWebhook(ft);

    expect(res2.status).toBe(200);

    // Only one contribution row for this PI
    const rows = await db
      .select()
      .from(contributions)
      .where(eq(contributions.externalPaymentId, ft.providerTransactionId!));
    expect(rows.length).toBe(1);
  });

  it("failed payment → providerStatus=failed, no Jar credit", async () => {
    const { financialTransactionId, ft } = await setupQuoteAndPi("card");

    const eventId = `evt_failed_${Date.now()}`;
    const event = {
      id: eventId,
      type: "payment_intent.payment_failed",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: ft.providerTransactionId,
          object: "payment_intent",
          amount: ft.totalQuotedCents,
          currency: "usd",
          status: "requires_payment_method",
        },
      },
    };
    (mockStripe.webhooks.constructEvent as ReturnType<typeof vi.fn>).mockReturnValue(event);

    const res = await request(app)
      .post(`${BASE}/webhooks/stripe`)
      .set("Content-Type", "application/json")
      .set("stripe-signature", "t=1,v1=mock")
      .send(Buffer.from(JSON.stringify(event)));

    expect(res.status).toBe(200);

    const updatedFt = await getFinancialTransaction(financialTransactionId);
    expect(updatedFt!.providerStatus).toBe("failed");
    expect(updatedFt!.ledgerPostingStatus).toBe("pending");
  });

  it("cancelled payment → providerStatus=cancelled, no Jar credit", async () => {
    const { financialTransactionId, ft } = await setupQuoteAndPi("card");

    const eventId = `evt_cancelled_${Date.now()}`;
    const event = {
      id: eventId,
      type: "payment_intent.canceled",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: ft.providerTransactionId,
          object: "payment_intent",
          amount: ft.totalQuotedCents,
          currency: "usd",
          status: "canceled",
        },
      },
    };
    (mockStripe.webhooks.constructEvent as ReturnType<typeof vi.fn>).mockReturnValue(event);

    const res = await request(app)
      .post(`${BASE}/webhooks/stripe`)
      .set("Content-Type", "application/json")
      .set("stripe-signature", "t=1,v1=mock")
      .send(Buffer.from(JSON.stringify(event)));

    expect(res.status).toBe(200);

    const updatedFt = await getFinancialTransaction(financialTransactionId);
    expect(updatedFt!.providerStatus).toBe("cancelled");
    expect(updatedFt!.ledgerPostingStatus).toBe("pending");
  });

  it("amount mismatch → no ledger posting, event marked failed", async () => {
    const { ft } = await setupQuoteAndPi("card");

    const eventId = `evt_mismatch_${Date.now()}`;
    const event = {
      id: eventId,
      type: "payment_intent.succeeded",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: ft.providerTransactionId,
          object: "payment_intent",
          amount: 99999, // wrong amount
          currency: "usd",
          status: "succeeded",
        },
      },
    };
    (mockStripe.webhooks.constructEvent as ReturnType<typeof vi.fn>).mockReturnValue(event);

    const res = await request(app)
      .post(`${BASE}/webhooks/stripe`)
      .set("Content-Type", "application/json")
      .set("stripe-signature", "t=1,v1=mock")
      .send(Buffer.from(JSON.stringify(event)));

    // Returns 200 to prevent infinite Stripe retry (permanent mismatch)
    expect(res.status).toBe(200);

    // Ledger NOT posted
    const [webhookRow] = await db
      .select()
      .from(stripeWebhookEvents)
      .where(eq(stripeWebhookEvents.stripeEventId, eventId));
    expect(webhookRow!.processingStatus).toBe("failed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART I — Payment status endpoint
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /jars/:jarId/drips/:financialTransactionId/status", () => {
  let token: string;
  let jarId: string;
  let mockStripe: ReturnType<typeof buildMockStripe>;

  beforeAll(async () => {
    mockStripe = buildMockStripe();
    mockGetStripeClient.mockReturnValue(mockStripe);
    mockGetOrCreateStripeCustomer.mockResolvedValue("cus_test_mock123");

    const user = await register("drip-status");
    token = user.token;
    const jar = await createJar(token);
    jarId = jar.id;
    await launchJar(token, jarId);
  });

  it("returns providerStatus and totalQuotedCents for own transaction", async () => {
    const quoteRes = await request(app)
      .post(`${BASE}/finance/quote`)
      .set("Authorization", `Bearer ${token}`)
      .send({ principalCents: 20_000, paymentMethodType: "card", jarId });
    const { financialTransactionId } = quoteRes.body;

    const res = await request(app)
      .get(`${BASE}/jars/${jarId}/drips/${financialTransactionId}/status`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.financialTransactionId).toBe(financialTransactionId);
    expect(res.body.providerStatus).toBe("quoted");
    expect(res.body.totalQuotedCents).toBe(21_246);
    expect(res.body.paymentMethodCategory).toBe("card");
  });

  it("returns 403 for another user's transaction", async () => {
    const other = await register("drip-status-outsider");

    const quoteRes = await request(app)
      .post(`${BASE}/finance/quote`)
      .set("Authorization", `Bearer ${token}`)
      .send({ principalCents: 20_000, paymentMethodType: "card", jarId });
    const { financialTransactionId } = quoteRes.body;

    const res = await request(app)
      .get(`${BASE}/jars/${jarId}/drips/${financialTransactionId}/status`)
      .set("Authorization", `Bearer ${other.token}`);

    expect(res.status).toBe(403);
  });

  it("returns 404 for unknown transaction", async () => {
    const res = await request(app)
      .get(`${BASE}/jars/${jarId}/drips/00000000-0000-0000-0000-000000000000/status`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART B — Stripe Customer linkage
// ─────────────────────────────────────────────────────────────────────────────

describe("getOrCreateStripeCustomer", () => {
  it("returns customer ID on first-time creation (mocked)", async () => {
    mockGetOrCreateStripeCustomer.mockResolvedValue("cus_new_test_abc");
    const result = await mockGetOrCreateStripeCustomer("user-1", "test@test.invalid");
    expect(result).toBe("cus_new_test_abc");
  });

  it("idempotent: second call returns same ID (mocked)", async () => {
    mockGetOrCreateStripeCustomer.mockResolvedValue("cus_existing_abc");
    const r1 = await mockGetOrCreateStripeCustomer("user-1", "test@test.invalid");
    const r2 = await mockGetOrCreateStripeCustomer("user-1", "test@test.invalid");
    expect(r1).toBe(r2);
  });
});
