/**
 * Phase 4E — AutoDrip Authorization Tests
 *
 * Tests for:
 *   GET    /jars/:jarId/autodrip            → status/auth details
 *   POST   /jars/:jarId/autodrip/preview    → fee preview (dry-run)
 *   POST   /jars/:jarId/autodrip            → enable (requires schedule + consent)
 *   PATCH  /jars/:jarId/autodrip            → update amount/frequency/PM
 *   POST   /jars/:jarId/autodrip/pause      → pause
 *   POST   /jars/:jarId/autodrip/resume     → resume
 *   DELETE /jars/:jarId/autodrip            → cancel
 *
 * Auth: two users (organizer + contributor)
 * Stripe: mocked
 */

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  users, profiles, jars, jarMembers, contributionSchedules,
  savedPaymentMethods, autoDripAuthorizations, autoDripRuns,
  financialTransactions, contributions, ledgerTransactions,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import app from "../app.js";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("../lib/stripe.js", () => ({
  getStripeClient: vi.fn(() => ({
    paymentIntents: {
      create: vi.fn().mockResolvedValue({
        id: "pi_autodrip_test_001",
        amount: 10618,
        currency: "usd",
        status: "requires_action",
        metadata: { source: "autodrip" },
      }),
    },
    paymentMethods: {
      detach: vi.fn().mockResolvedValue({ id: "pm_test" }),
    },
    setupIntents: {
      create: vi.fn().mockResolvedValue({ id: "si_test", client_secret: "seti_secret", status: "requires_payment_method" }),
      retrieve: vi.fn().mockResolvedValue({ id: "si_test", customer: "cus_test", status: "succeeded", payment_method: "pm_test" }),
    },
  })),
}));

vi.mock("../lib/stripe-customer.js", () => ({
  getOrCreateStripeCustomer: vi.fn().mockResolvedValue("cus_test_4e_autodrip"),
}));

// ─── Test helpers ─────────────────────────────────────────────────────────────

async function getToken(email: string, password: string): Promise<string> {
  const res = await request(app).post("/api/auth/register").send({ email, password, displayName: "Test" });
  if (res.status === 201) return res.body.accessToken as string;
  const res2 = await request(app).post("/api/auth/login").send({ email, password });
  return res2.body.accessToken as string;
}

// ─── Test fixtures ────────────────────────────────────────────────────────────

let organizerToken: string;
let contributorToken: string;
let organizerId: string;
let contributorId: string;
let jarId: string;
let memberId: string;
let pmId: string;

const TS4E = Date.now();
const ORG_EMAIL = `ad-org-${TS4E}@dripjar.test`;
const CTR_EMAIL = `ad-ctr-${TS4E}@dripjar.test`;

beforeAll(async () => {
  const [orgReg, ctrReg] = await Promise.all([
    request(app).post("/api/auth/register").send({ email: ORG_EMAIL, password: "Pass1234!", firstName: "Org", lastName: "User" }),
    request(app).post("/api/auth/register").send({ email: CTR_EMAIL, password: "Pass1234!", firstName: "Contributor", lastName: "User" }),
  ]);
  if (orgReg.status !== 201) throw new Error(`Org register failed: ${orgReg.status} ${JSON.stringify(orgReg.body)}`);
  if (ctrReg.status !== 201) throw new Error(`Ctr register failed: ${ctrReg.status} ${JSON.stringify(ctrReg.body)}`);

  // register endpoint returns { token } (not accessToken)
  organizerToken = orgReg.body.token as string;
  contributorToken = ctrReg.body.token as string;

  const [org] = await db.select({ id: users.id }).from(users).where(eq(users.email, ORG_EMAIL));
  const [ctr] = await db.select({ id: users.id }).from(users).where(eq(users.email, CTR_EMAIL));
  organizerId = org!.id;
  contributorId = ctr!.id;

  // Jar
  const [jar] = await db.insert(jars).values({
    organizerId, name: "AutoDrip Test Jar", slug: `ad-jar-${Date.now()}`,
    targetDate: "2027-12-31", goalAmountCents: 100000, timeZone: "America/New_York",
    // `jars.status` defaults to "Draft". AutoDrip is a recurring PAYMENT
    // authorization — saved payment method plus recorded consent — so it is
    // only permitted on a jar that can actually take money. This fixture
    // relied on the default and passed only because the old guard was a
    // denylist naming the two terminal phases; an unlaunched jar was never an
    // intended AutoDrip target.
    status: "Saving",
  }).returning();
  jarId = jar!.id;

  // Contributor member
  const [mem] = await db.insert(jarMembers).values({
    jarId, userId: contributorId, status: "active", role: "member",
  }).returning();
  memberId = mem!.id;

  // Schedule for contributor (no userId column on contributionSchedules)
  await db.insert(contributionSchedules).values({
    jarId, memberId,
    amountCents: 50000, frequency: "monthly",
    startDate: "2026-01-01", isActive: true,
  });

  // Saved payment method for contributor — clear stale customer ID first (unique constraint)
  await db.update(profiles).set({ stripeCustomerId: null }).where(eq(profiles.stripeCustomerId, "cus_test_4e_autodrip"));
  await db.update(profiles).set({ stripeCustomerId: "cus_test_4e_autodrip" }).where(eq(profiles.userId, contributorId));
  const [pm] = await db.insert(savedPaymentMethods).values({
    userId: contributorId,
    stripeCustomerId: "cus_test_4e_autodrip",
    stripePaymentMethodId: "pm_ad_test_4e",
    type: "card", last4: "4242", isDefault: true, status: "active",
  }).returning();
  pmId = pm!.id;
});

afterAll(async () => {
  const auths = await db.select({ id: autoDripAuthorizations.id }).from(autoDripAuthorizations).where(eq(autoDripAuthorizations.jarId, jarId));
  for (const auth of auths) {
    await db.delete(autoDripRuns).where(eq(autoDripRuns.autoDripAuthorizationId, auth.id));
  }
  await db.delete(autoDripAuthorizations).where(eq(autoDripAuthorizations.jarId, jarId));
  await db.delete(savedPaymentMethods).where(eq(savedPaymentMethods.userId, contributorId));
});

// ─── GET /jars/:jarId/autodrip ────────────────────────────────────────────────

describe("GET /jars/:jarId/autodrip", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app).get(`/api/jars/${jarId}/autodrip`);
    expect(res.status).toBe(401);
  });

  it("returns enabled=false when no AutoDrip set up", async () => {
    const res = await request(app)
      .get(`/api/jars/${jarId}/autodrip`)
      .set("Authorization", `Bearer ${contributorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
  });

  it("organizer sees member AutoDrip status pills", async () => {
    const res = await request(app)
      .get(`/api/jars/${jarId}/autodrip`)
      .set("Authorization", `Bearer ${organizerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.organizerView).toBe(true);
    expect(Array.isArray(res.body.memberAutoDripStatuses)).toBe(true);
  });
});

// ─── POST /jars/:jarId/autodrip/preview ──────────────────────────────────────

describe("POST /jars/:jarId/autodrip/preview", () => {
  it("returns fee preview without DB changes", async () => {
    const res = await request(app)
      .post(`/api/jars/${jarId}/autodrip/preview`)
      .set("Authorization", `Bearer ${contributorToken}`)
      .send({ principalCents: 5000, frequency: "monthly", paymentMethodId: pmId });
    expect(res.status).toBe(200);
    expect(res.body.principalCents).toBe(5000);
    expect(res.body.dripJarFeeCents).toBeGreaterThan(0);
    expect(res.body.totalChargeCents).toBeGreaterThan(5000);
    expect(res.body.nextRunAt).toBeTruthy();
  });

  it("rejects tampered fee fields", async () => {
    const res = await request(app)
      .post(`/api/jars/${jarId}/autodrip/preview`)
      .set("Authorization", `Bearer ${contributorToken}`)
      .send({ principalCents: 5000, frequency: "monthly", paymentMethodId: pmId, dripJarFeeCents: 0 });
    expect(res.status).toBe(400);
  });

  it("rejects invalid frequency", async () => {
    const res = await request(app)
      .post(`/api/jars/${jarId}/autodrip/preview`)
      .set("Authorization", `Bearer ${contributorToken}`)
      .send({ principalCents: 5000, frequency: "annually", paymentMethodId: pmId });
    expect(res.status).toBe(400);
  });
});

// ─── POST /jars/:jarId/autodrip ───────────────────────────────────────────────

describe("POST /jars/:jarId/autodrip (enable)", () => {
  afterAll(async () => {
    // Clean up any autorizations created
    await db.delete(autoDripAuthorizations).where(eq(autoDripAuthorizations.jarId, jarId));
  });

  it("returns 400 if consentGiven is not true", async () => {
    const res = await request(app)
      .post(`/api/jars/${jarId}/autodrip`)
      .set("Authorization", `Bearer ${contributorToken}`)
      .send({ principalCents: 5000, frequency: "monthly", paymentMethodId: pmId, consentGiven: false });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/consent/i);
  });

  it("returns 400 if principalCents is not a positive integer", async () => {
    const res = await request(app)
      .post(`/api/jars/${jarId}/autodrip`)
      .set("Authorization", `Bearer ${contributorToken}`)
      .send({ principalCents: -100, frequency: "monthly", paymentMethodId: pmId, consentGiven: true });
    expect(res.status).toBe(400);
  });

  it("successfully enables AutoDrip", async () => {
    const res = await request(app)
      .post(`/api/jars/${jarId}/autodrip`)
      .set("Authorization", `Bearer ${contributorToken}`)
      .send({ principalCents: 5000, frequency: "monthly", paymentMethodId: pmId, consentGiven: true });
    expect(res.status).toBe(201);
    expect(res.body.authorization).toMatchObject({ status: "active", principalCents: 5000, frequency: "monthly" });
  });

  it("returns 409 if AutoDrip already active", async () => {
    const res = await request(app)
      .post(`/api/jars/${jarId}/autodrip`)
      .set("Authorization", `Bearer ${contributorToken}`)
      .send({ principalCents: 5000, frequency: "monthly", paymentMethodId: pmId, consentGiven: true });
    expect(res.status).toBe(409);
  });
});

// ─── Pause + Resume + Cancel ──────────────────────────────────────────────────

describe("AutoDrip lifecycle — pause / resume / cancel", () => {
  beforeEach(async () => {
    // Ensure a fresh active authorization exists
    await db.delete(autoDripAuthorizations).where(eq(autoDripAuthorizations.jarId, jarId));
    await db.insert(autoDripAuthorizations).values({
      jarId, memberId, userId: contributorId,
      savedPaymentMethodId: pmId,
      principalCents: 5000, frequency: "monthly",
      status: "active", nextRunAt: new Date("2027-01-01"),
    });
  });

  afterAll(async () => {
    await db.delete(autoDripAuthorizations).where(eq(autoDripAuthorizations.jarId, jarId));
  });

  it("pauses an active AutoDrip", async () => {
    const res = await request(app)
      .post(`/api/jars/${jarId}/autodrip/pause`)
      .set("Authorization", `Bearer ${contributorToken}`);
    expect(res.status).toBe(200);

    const getRes = await request(app)
      .get(`/api/jars/${jarId}/autodrip`)
      .set("Authorization", `Bearer ${contributorToken}`);
    expect(getRes.body.authorization?.status).toBe("paused");
  });

  it("returns 404 when pausing non-existent AutoDrip", async () => {
    // Cancel the authorization first
    await db.delete(autoDripAuthorizations).where(eq(autoDripAuthorizations.jarId, jarId));
    const res = await request(app)
      .post(`/api/jars/${jarId}/autodrip/pause`)
      .set("Authorization", `Bearer ${contributorToken}`);
    expect(res.status).toBe(404);
  });

  it("resumes a paused AutoDrip", async () => {
    // Pause first
    await request(app)
      .post(`/api/jars/${jarId}/autodrip/pause`)
      .set("Authorization", `Bearer ${contributorToken}`);

    // Resume
    const res = await request(app)
      .post(`/api/jars/${jarId}/autodrip/resume`)
      .set("Authorization", `Bearer ${contributorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.nextRunAt).toBeTruthy();

    const getRes = await request(app)
      .get(`/api/jars/${jarId}/autodrip`)
      .set("Authorization", `Bearer ${contributorToken}`);
    expect(getRes.body.authorization?.status).toBe("active");
  });

  it("resumes from needs_attention and clears the flag", async () => {
    // Set to needs_attention
    await db.update(autoDripAuthorizations)
      .set({ status: "needs_attention", needsAttentionAt: new Date(), needsAttentionReason: "Card declined" })
      .where(eq(autoDripAuthorizations.jarId, jarId));

    const res = await request(app)
      .post(`/api/jars/${jarId}/autodrip/resume`)
      .set("Authorization", `Bearer ${contributorToken}`);
    expect(res.status).toBe(200);

    const getRes = await request(app)
      .get(`/api/jars/${jarId}/autodrip`)
      .set("Authorization", `Bearer ${contributorToken}`);
    expect(getRes.body.authorization?.status).toBe("active");
    expect(getRes.body.authorization?.needsAttentionReason).toBeNull();
  });

  it("cancels an active AutoDrip (terminal)", async () => {
    const res = await request(app)
      .delete(`/api/jars/${jarId}/autodrip`)
      .set("Authorization", `Bearer ${contributorToken}`);
    expect(res.status).toBe(204);

    // After cancel, GET shows enabled=false (no active auth)
    const getRes = await request(app)
      .get(`/api/jars/${jarId}/autodrip`)
      .set("Authorization", `Bearer ${contributorToken}`);
    // No active auth exists now
    expect(getRes.body.enabled).toBe(false);
  });
});

// ─── PATCH (update) ───────────────────────────────────────────────────────────

describe("PATCH /jars/:jarId/autodrip (update)", () => {
  beforeEach(async () => {
    await db.delete(autoDripAuthorizations).where(eq(autoDripAuthorizations.jarId, jarId));
    await db.insert(autoDripAuthorizations).values({
      jarId, memberId, userId: contributorId,
      savedPaymentMethodId: pmId,
      principalCents: 5000, frequency: "monthly",
      status: "active", nextRunAt: new Date("2027-01-01"),
    });
  });

  afterAll(async () => {
    await db.delete(autoDripAuthorizations).where(eq(autoDripAuthorizations.jarId, jarId));
  });

  it("updates principalCents", async () => {
    const res = await request(app)
      .patch(`/api/jars/${jarId}/autodrip`)
      .set("Authorization", `Bearer ${contributorToken}`)
      .send({ principalCents: 7500 });
    expect(res.status).toBe(200);
    expect(res.body.authorization.principalCents).toBe(7500);
  });

  it("updates frequency", async () => {
    const res = await request(app)
      .patch(`/api/jars/${jarId}/autodrip`)
      .set("Authorization", `Bearer ${contributorToken}`)
      .send({ frequency: "weekly" });
    expect(res.status).toBe(200);
    expect(res.body.authorization.frequency).toBe("weekly");
  });

  it("rejects tampered fee fields in PATCH body", async () => {
    const res = await request(app)
      .patch(`/api/jars/${jarId}/autodrip`)
      .set("Authorization", `Bearer ${contributorToken}`)
      .send({ principalCents: 5000, dripJarFeeCents: 0 });
    expect(res.status).toBe(400);
  });
});
