/**
 * Phase 4E — Saved Payment Methods Tests
 *
 * Tests for:
 *   POST /payment-methods/setup           → 201 with clientSecret
 *   POST /payment-methods/setup-confirm   → 201 saved PM row
 *   GET  /payment-methods                 → 200 list
 *   DELETE /payment-methods/:id           → 204 or 409 if AutoDrip refs
 *   POST /payment-methods/:id/default     → 200
 *
 * Auth: uses test user tokens created in beforeAll.
 * Stripe: all Stripe calls are mocked (unit-style integration tests).
 */

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  users, profiles, savedPaymentMethods, autoDripAuthorizations, jars, jarMembers, contributionSchedules,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import app from "../app.js";

// ─── Stripe mocks ─────────────────────────────────────────────────────────────

vi.mock("../lib/stripe.js", () => ({
  getStripeClient: vi.fn(() => ({
    setupIntents: {
      create: vi.fn().mockResolvedValue({
        id: "si_test_phase4e",
        client_secret: "seti_test_secret",
        customer: "cus_test_phase4e_a",
        status: "requires_payment_method",
      }),
      retrieve: vi.fn().mockResolvedValue({
        id: "si_test_phase4e",
        customer: "cus_test_phase4e_a",
        status: "succeeded",
        payment_method: "pm_test_card_4e",
      }),
    },
    paymentMethods: {
      retrieve: vi.fn().mockResolvedValue({
        id: "pm_test_card_4e",
        type: "card",
        customer: "cus_test_phase4e_a",
        card: { brand: "visa", last4: "4242" },
      }),
      detach: vi.fn().mockResolvedValue({ id: "pm_test_card_4e" }),
    },
  })),
}));

vi.mock("../lib/stripe-customer.js", () => ({
  getOrCreateStripeCustomer: vi.fn().mockResolvedValue("cus_test_phase4e_a"),
}));

// ─── Test data ────────────────────────────────────────────────────────────────

let userAToken: string;
let userAId: string;
let userBToken: string;
let userBId: string;
let savedPmId: string;
let jarId: string;
let memberId: string;

const TS = Date.now();
const EMAIL_A = `pm-a-${TS}@dripjar.test`;
const EMAIL_B = `pm-b-${TS}@dripjar.test`;
const PASSWORD = "Password123!";
// Shared mock customer IDs — must match what the Stripe mocks return
const STRIPE_CUSTOMER_A = "cus_test_phase4e_a";
const STRIPE_CUSTOMER_B = "cus_test_phase4e_b";

async function registerUser(email: string): Promise<{ token: string; userId: string }> {
  const res = await request(app).post("/api/auth/register").send({ email, password: PASSWORD, firstName: "PM", lastName: "Tester" });
  if (res.status !== 201) throw new Error(`Register failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  // register endpoint returns { token } (not accessToken)
  return { token: res.body.token as string, userId: res.body.user?.id as string };
}

beforeAll(async () => {
  const [a, b] = await Promise.all([registerUser(EMAIL_A), registerUser(EMAIL_B)]);
  userAToken = a.token;
  userAId = a.userId;
  userBToken = b.token;
  userBId = b.userId;

  // If userId not in token response body, fall back to DB lookup
  if (!userAId) {
    const [uA] = await db.select({ id: users.id }).from(users).where(eq(users.email, EMAIL_A));
    userAId = uA!.id;
  }
  if (!userBId) {
    const [uB] = await db.select({ id: users.id }).from(users).where(eq(users.email, EMAIL_B));
    userBId = uB!.id;
  }

  // Clear any existing profile rows that hold our shared mock customer IDs (from prior test runs)
  await db.update(profiles).set({ stripeCustomerId: null }).where(eq(profiles.stripeCustomerId, STRIPE_CUSTOMER_A));
  await db.update(profiles).set({ stripeCustomerId: null }).where(eq(profiles.stripeCustomerId, STRIPE_CUSTOMER_B));
  // Set the mock customer IDs on our new test users
  await db.update(profiles).set({ stripeCustomerId: STRIPE_CUSTOMER_A }).where(eq(profiles.userId, userAId));
  await db.update(profiles).set({ stripeCustomerId: STRIPE_CUSTOMER_B }).where(eq(profiles.userId, userBId));

  // Create a jar + member for delete-409 test
  const [jar] = await db.insert(jars).values({
    organizerId: userAId, name: `PM Test Jar ${TS}`, slug: `pm-jar-${TS}`,
    targetDate: "2027-12-31", goalAmountCents: 100000, timeZone: "America/New_York",
  }).returning();
  jarId = jar!.id;
  const [mem] = await db.insert(jarMembers).values({ jarId: jar!.id, userId: userAId, status: "active", role: "member" }).returning();
  memberId = mem!.id;

  // Create a schedule (contributionSchedules has no userId column)
  await db.insert(contributionSchedules).values({
    jarId, memberId, amountCents: 10000, frequency: "monthly",
    startDate: "2026-01-01", isActive: true,
  });
});

afterAll(async () => {
  await db.delete(autoDripAuthorizations).where(eq(autoDripAuthorizations.jarId, jarId));
  await db.delete(savedPaymentMethods).where(eq(savedPaymentMethods.userId, userAId));
  await db.delete(savedPaymentMethods).where(eq(savedPaymentMethods.userId, userBId));
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("POST /payment-methods/setup", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app).post("/api/payment-methods/setup").send({ type: "card" });
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid type", async () => {
    const res = await request(app)
      .post("/api/payment-methods/setup")
      .set("Authorization", `Bearer ${userAToken}`)
      .send({ type: "crypto" });
    expect(res.status).toBe(400);
  });

  it("returns 201 with clientSecret for card", async () => {
    const res = await request(app)
      .post("/api/payment-methods/setup")
      .set("Authorization", `Bearer ${userAToken}`)
      .send({ type: "card" });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("clientSecret");
    expect(res.body).toHaveProperty("setupIntentId");
  });

  it("returns 201 with clientSecret for us_bank_account", async () => {
    const res = await request(app)
      .post("/api/payment-methods/setup")
      .set("Authorization", `Bearer ${userAToken}`)
      .send({ type: "us_bank_account" });
    expect(res.status).toBe(201);
    expect(res.body.setupIntentId).toBeTruthy();
  });
});

describe("POST /payment-methods/setup-confirm", () => {
  it("returns 400 without setupIntentId", async () => {
    const res = await request(app)
      .post("/api/payment-methods/setup-confirm")
      .set("Authorization", `Bearer ${userAToken}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("saves a card payment method", async () => {
    const res = await request(app)
      .post("/api/payment-methods/setup-confirm")
      .set("Authorization", `Bearer ${userAToken}`)
      .send({ setupIntentId: "si_test_phase4e" });
    expect(res.status).toBe(201);
    expect(res.body.type).toBe("card");
    expect(res.body.last4).toBe("4242");
    expect(res.body.status).toBe("active");
    savedPmId = res.body.id as string;
  });

  it("is idempotent — second confirm returns 200 with same PM", async () => {
    const res = await request(app)
      .post("/api/payment-methods/setup-confirm")
      .set("Authorization", `Bearer ${userAToken}`)
      .send({ setupIntentId: "si_test_phase4e" });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(savedPmId);
  });
});

describe("GET /payment-methods", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app).get("/api/payment-methods");
    expect(res.status).toBe(401);
  });

  it("returns saved methods for user", async () => {
    const res = await request(app)
      .get("/api/payment-methods")
      .set("Authorization", `Bearer ${userAToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const pm = (res.body as Array<{ id: string }>).find(m => m.id === savedPmId);
    expect(pm).toBeTruthy();
  });

  it("does NOT return another user's methods", async () => {
    const res = await request(app)
      .get("/api/payment-methods")
      .set("Authorization", `Bearer ${userBToken}`);
    expect(res.status).toBe(200);
    const hasA = (res.body as Array<{ id: string }>).some(m => m.id === savedPmId);
    expect(hasA).toBe(false);
  });
});

describe("POST /payment-methods/:id/default", () => {
  it("returns 404 for non-existent PM", async () => {
    const res = await request(app)
      .post("/api/payment-methods/00000000-0000-0000-0000-000000000000/default")
      .set("Authorization", `Bearer ${userAToken}`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for another user's PM", async () => {
    const res = await request(app)
      .post(`/api/payment-methods/${savedPmId}/default`)
      .set("Authorization", `Bearer ${userBToken}`);
    expect(res.status).toBe(404);
  });

  it("sets PM as default", async () => {
    const res = await request(app)
      .post(`/api/payment-methods/${savedPmId}/default`)
      .set("Authorization", `Bearer ${userAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe("DELETE /payment-methods/:id", () => {
  it("returns 404 for non-existent PM", async () => {
    const res = await request(app)
      .delete("/api/payment-methods/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${userAToken}`);
    expect(res.status).toBe(404);
  });

  it("returns 409 if PM referenced by active AutoDrip", async () => {
    // Create AutoDrip authorization referencing savedPmId
    const [auth] = await db.insert(autoDripAuthorizations).values({
      jarId, memberId, userId: userAId,
      savedPaymentMethodId: savedPmId,
      principalCents: 5000, frequency: "monthly",
      status: "active", nextRunAt: new Date("2027-01-01"),
    }).returning();

    const res = await request(app)
      .delete(`/api/payment-methods/${savedPmId}`)
      .set("Authorization", `Bearer ${userAToken}`);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/AutoDrip/i);

    // Cleanup
    await db.delete(autoDripAuthorizations).where(eq(autoDripAuthorizations.id, auth!.id));
  });

  it("returns 409 even if AutoDrip is paused (pausing alone is NOT sufficient)", async () => {
    const [auth] = await db.insert(autoDripAuthorizations).values({
      jarId, memberId, userId: userAId,
      savedPaymentMethodId: savedPmId,
      principalCents: 5000, frequency: "monthly",
      status: "paused", nextRunAt: new Date("2027-01-01"),
    }).returning();

    const res = await request(app)
      .delete(`/api/payment-methods/${savedPmId}`)
      .set("Authorization", `Bearer ${userAToken}`);
    expect(res.status).toBe(409);

    await db.delete(autoDripAuthorizations).where(eq(autoDripAuthorizations.id, auth!.id));
  });

  it("deletes PM when no active AutoDrip references it", async () => {
    // Create a fresh PM for deletion
    const [pm2] = await db.insert(savedPaymentMethods).values({
      userId: userAId,
      stripeCustomerId: "cus_test_phase4e",
      stripePaymentMethodId: "pm_to_delete_4e",
      type: "card",
      last4: "9999",
      isDefault: false,
      status: "active",
    }).returning();

    const res = await request(app)
      .delete(`/api/payment-methods/${pm2!.id}`)
      .set("Authorization", `Bearer ${userAToken}`);
    expect(res.status).toBe(204);

    const [gone] = await db
      .select({ status: savedPaymentMethods.status })
      .from(savedPaymentMethods)
      .where(eq(savedPaymentMethods.id, pm2!.id));
    expect(gone?.status).toBe("detached");
  });
});
