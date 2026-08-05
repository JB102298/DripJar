/**
 * Phase 4D — Financial Transparency Tests
 *
 * Covers:
 *   PART A  — GET /jars/:jarId/financial-summary (zero state, structure)
 *   PART B  — Authorization (active member, organizer, outsider)
 *   PART C  — Privacy model (organizer exact / member redacted)
 *   PART D  — Goal waterfall integration in financial summary
 *   PART E  — Jar-level totals (fees excluded, remaining, over-target)
 *   PART F  — ledger-backed totalSavedCents in Jar response
 */

import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import app from "../app.js";
import { db } from "@workspace/db";
import { jars, jarMembers, profiles } from "@workspace/db";
import { eq, and } from "drizzle-orm";

const BASE = "/api";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function register(suffix: string) {
  const email = `transp-${suffix}-${Date.now()}@test.invalid`;
  const res = await request(app).post(`${BASE}/auth/register`).send({
    email,
    password: "P@ssword1!",
    firstName: "Transp",
    lastName: suffix,
  });
  expect(res.status, `register ${suffix}: ${JSON.stringify(res.body)}`).toBe(201);
  return { token: res.body.token as string, userId: res.body.user.id as string, email };
}

async function createJar(token: string, goalAmountCents = 100_000) {
  const res = await request(app)
    .post(`${BASE}/jars`)
    .set("Authorization", `Bearer ${token}`)
    .send({
      name: `Transparency Test Jar ${Date.now()}`,
      targetDate: "2027-12-31",
      goalAmountCents,
      currency: "USD",
    });
  expect(res.status, `createJar: ${JSON.stringify(res.body)}`).toBe(201);
  return res.body as { id: string; goalAmountCents: number };
}

async function inviteAndJoin(organizerToken: string, jarId: string, memberToken: string, memberEmail: string) {
  const invRes = await request(app)
    .post(`${BASE}/jars/${jarId}/invitations`)
    .set("Authorization", `Bearer ${organizerToken}`)
    .send({ email: memberEmail, role: "member" });
  if (!invRes.body?.id) return;
  await request(app)
    .post(`${BASE}/invitations/${invRes.body.id}/accept`)
    .set("Authorization", `Bearer ${memberToken}`);
}

async function createGoal(token: string, jarId: string, name: string, targetPrincipalCents: number) {
  const res = await request(app)
    .post(`${BASE}/jars/${jarId}/goals`)
    .set("Authorization", `Bearer ${token}`)
    .send({ name, targetPrincipalCents });
  expect(res.status, `createGoal "${name}": ${JSON.stringify(res.body)}`).toBe(201);
  return res.body as { id: string };
}

// ─── PART A — Zero state: structure validation ─────────────────────────────────

describe("PART A — GET /jars/:jarId/financial-summary (zero state)", () => {
  let token: string;
  let jarId: string;

  beforeAll(async () => {
    ({ token } = await register("zero-org"));
    const jar = await createJar(token, 80_000);
    jarId = jar.id;
  });

  it("returns 200 with correct top-level shape", async () => {
    const res = await request(app)
      .get(`${BASE}/jars/${jarId}/financial-summary`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("jar");
    expect(res.body).toHaveProperty("goals");
    expect(res.body).toHaveProperty("members");
    expect(res.body).toHaveProperty("viewerRole");
    expect(res.body).toHaveProperty("unallocatedCents");
    expect(res.body).toHaveProperty("surplusCents");
    expect(res.body).toHaveProperty("invariantHolds");
  });

  it("jar totals are zero when no contributions exist", async () => {
    const res = await request(app)
      .get(`${BASE}/jars/${jarId}/financial-summary`)
      .set("Authorization", `Bearer ${token}`);
    const { jar } = res.body;
    expect(jar.savedPrincipalCents).toBe(0);
    expect(jar.committedPrincipalCents).toBe(0);
    expect(jar.refundablePrincipalCents).toBe(0);
    expect(jar.refundPendingCents).toBe(0);
    expect(jar.refundedLifetimeCents).toBe(0);
    expect(jar.dripJarFeesTotalCents).toBe(0);
    expect(jar.processingFeesTotalCents).toBe(0);
    expect(jar.savedPercent).toBe(0);
    expect(jar.isOverTarget).toBe(false);
    expect(jar.overTargetByCents).toBe(0);
  });

  it("remainingToSaveCents equals goalAmountCents when nothing saved", async () => {
    const res = await request(app)
      .get(`${BASE}/jars/${jarId}/financial-summary`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.body.jar.remainingToSaveCents).toBe(80_000);
    expect(res.body.jar.goalAmountCents).toBe(80_000);
  });

  it("viewerRole is 'organizer' for the jar organizer", async () => {
    const res = await request(app)
      .get(`${BASE}/jars/${jarId}/financial-summary`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.body.viewerRole).toBe("organizer");
  });

  it("goals list is empty when no goals created", async () => {
    const res = await request(app)
      .get(`${BASE}/jars/${jarId}/financial-summary`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.body.goals).toEqual([]);
    expect(res.body.unallocatedCents).toBe(80_000);
  });

  it("invariantHolds is true", async () => {
    const res = await request(app)
      .get(`${BASE}/jars/${jarId}/financial-summary`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.body.invariantHolds).toBe(true);
  });
});

// ─── PART B — Authorization ────────────────────────────────────────────────────

describe("PART B — Authorization for /jars/:jarId/financial-summary", () => {
  let organizerToken: string;
  let memberToken: string;
  let memberEmail: string;
  let outsiderToken: string;
  let jarId: string;

  beforeAll(async () => {
    const org = await register("auth-org-t");
    organizerToken = org.token;
    const mem = await register("auth-mem-t");
    memberToken = mem.token;
    memberEmail = mem.email;
    const out = await register("auth-out-t");
    outsiderToken = out.token;

    const jar = await createJar(organizerToken, 50_000);
    jarId = jar.id;
    await inviteAndJoin(organizerToken, jarId, memberToken, memberEmail);
  });

  it("organizer can access (200)", async () => {
    const res = await request(app)
      .get(`${BASE}/jars/${jarId}/financial-summary`)
      .set("Authorization", `Bearer ${organizerToken}`);
    expect(res.status).toBe(200);
  });

  it("active member can access (200)", async () => {
    const res = await request(app)
      .get(`${BASE}/jars/${jarId}/financial-summary`)
      .set("Authorization", `Bearer ${memberToken}`);
    expect(res.status).toBe(200);
  });

  it("outsider is rejected (403)", async () => {
    const res = await request(app)
      .get(`${BASE}/jars/${jarId}/financial-summary`)
      .set("Authorization", `Bearer ${outsiderToken}`);
    expect(res.status).toBe(403);
  });

  it("unauthenticated is rejected (401)", async () => {
    const res = await request(app).get(`${BASE}/jars/${jarId}/financial-summary`);
    expect(res.status).toBe(401);
  });
});

// ─── PART C — Privacy model ────────────────────────────────────────────────────

describe("PART C — Privacy model (organizer exact / member redacted)", () => {
  let organizerToken: string;
  let memberToken: string;
  let memberEmail: string;
  let jarId: string;

  beforeAll(async () => {
    const org = await register("privacy-org");
    organizerToken = org.token;
    const mem = await register("privacy-mem");
    memberToken = mem.token;
    memberEmail = mem.email;

    const jar = await createJar(organizerToken, 60_000);
    jarId = jar.id;
    await inviteAndJoin(organizerToken, jarId, memberToken, memberEmail);
  });

  it("organizer sees own exact figures (isOwnData=false for self in organizer view)", async () => {
    const res = await request(app)
      .get(`${BASE}/jars/${jarId}/financial-summary`)
      .set("Authorization", `Bearer ${organizerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.viewerRole).toBe("organizer");
    // All members should have exact fields visible
    for (const m of res.body.members) {
      expect(m).toHaveProperty("contributedPrincipalCents");
      expect(m).toHaveProperty("refundablePrincipalCents");
      expect(m).toHaveProperty("committedPrincipalCents");
      expect(m).toHaveProperty("savedPrincipalCents");
    }
  });

  it("member sees own exact figures with isOwnData=true", async () => {
    const res = await request(app)
      .get(`${BASE}/jars/${jarId}/financial-summary`)
      .set("Authorization", `Bearer ${memberToken}`);
    expect(res.status).toBe(200);
    expect(res.body.viewerRole).toBe("member");

    const ownEntry = res.body.members.find((m: any) => m.isOwnData === true);
    expect(ownEntry).toBeDefined();
    expect(ownEntry).toHaveProperty("contributedPrincipalCents");
    expect(ownEntry).toHaveProperty("refundablePrincipalCents");
    expect(ownEntry).toHaveProperty("savedPrincipalCents");
  });

  it("member sees only statusLabel + savedPercent for other members", async () => {
    const res = await request(app)
      .get(`${BASE}/jars/${jarId}/financial-summary`)
      .set("Authorization", `Bearer ${memberToken}`);
    const otherEntries = res.body.members.filter((m: any) => m.isOwnData === false);

    for (const m of otherEntries) {
      expect(m).toHaveProperty("statusLabel");
      expect(m).toHaveProperty("savedPercent");
      expect(m).toHaveProperty("displayName");
      // Should NOT expose exact financial figures
      expect(m).not.toHaveProperty("contributedPrincipalCents");
      expect(m).not.toHaveProperty("refundablePrincipalCents");
      expect(m).not.toHaveProperty("committedPrincipalCents");
    }
  });

  it("statusLabel is 'Not Started' when no contributions", async () => {
    const res = await request(app)
      .get(`${BASE}/jars/${jarId}/financial-summary`)
      .set("Authorization", `Bearer ${memberToken}`);
    const ownEntry = res.body.members.find((m: any) => m.isOwnData === true);
    expect(ownEntry.statusLabel).toBe("Not Started");
  });

  it("members list includes both organizer and active members", async () => {
    const res = await request(app)
      .get(`${BASE}/jars/${jarId}/financial-summary`)
      .set("Authorization", `Bearer ${organizerToken}`);
    expect(res.body.members.length).toBeGreaterThanOrEqual(2);
    const roles = res.body.members.map((m: any) => m.role);
    expect(roles).toContain("organizer");
    expect(roles).toContain("member");
  });
});

// ─── PART D — Goal waterfall in financial summary ──────────────────────────────

describe("PART D — Goal waterfall integration in financial summary", () => {
  let token: string;
  let jarId: string;

  beforeAll(async () => {
    ({ token } = await register("summary-waterfall"));
    const jar = await createJar(token, 100_000);
    jarId = jar.id;
    await createGoal(token, jarId, "Flights", 40_000);
    await createGoal(token, jarId, "Hotel", 35_000);
    await createGoal(token, jarId, "Activities", 15_000);
  });

  it("includes goals list with correct structure", async () => {
    const res = await request(app)
      .get(`${BASE}/jars/${jarId}/financial-summary`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.goals).toHaveLength(3);
    for (const goal of res.body.goals) {
      expect(goal).toHaveProperty("id");
      expect(goal).toHaveProperty("name");
      expect(goal).toHaveProperty("targetPrincipalCents");
      expect(goal).toHaveProperty("savedAllocatedCents");
      expect(goal).toHaveProperty("committedAllocatedCents");
      expect(goal).toHaveProperty("savedPercent");
      expect(goal).toHaveProperty("fundingState");
    }
  });

  it("all goals unfunded when no principal saved", async () => {
    const res = await request(app)
      .get(`${BASE}/jars/${jarId}/financial-summary`)
      .set("Authorization", `Bearer ${token}`);
    for (const goal of res.body.goals) {
      expect(goal.fundingState).toBe("unfunded");
    }
  });

  it("unallocatedCents = jar target - sum of active goal targets", async () => {
    const res = await request(app)
      .get(`${BASE}/jars/${jarId}/financial-summary`)
      .set("Authorization", `Bearer ${token}`);
    // 100_000 - (40_000 + 35_000 + 15_000) = 10_000
    expect(res.body.unallocatedCents).toBe(10_000);
  });

  it("goals in financial summary match goals-only endpoint", async () => {
    const [summaryRes, goalsRes] = await Promise.all([
      request(app)
        .get(`${BASE}/jars/${jarId}/financial-summary`)
        .set("Authorization", `Bearer ${token}`),
      request(app)
        .get(`${BASE}/jars/${jarId}/goals`)
        .set("Authorization", `Bearer ${token}`),
    ]);
    expect(summaryRes.status).toBe(200);
    expect(goalsRes.status).toBe(200);
    // Both endpoints should return the same goals in the same order
    const summaryNames = summaryRes.body.goals.map((g: any) => g.name);
    const goalsNames = goalsRes.body.goals.map((g: any) => g.name);
    expect(summaryNames).toEqual(goalsNames);
  });
});

// ─── PART E — Jar-level totals: fees excluded, remainingToSave ────────────────

describe("PART E — Jar-level totals: remainingToSaveCents always non-negative", () => {
  let token: string;
  let jarId: string;

  beforeAll(async () => {
    ({ token } = await register("totals-test"));
    const jar = await createJar(token, 50_000);
    jarId = jar.id;
  });

  it("remainingToSaveCents is goalAmountCents when nothing saved", async () => {
    const res = await request(app)
      .get(`${BASE}/jars/${jarId}/financial-summary`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.body.jar.remainingToSaveCents).toBe(50_000);
  });

  it("isOverTarget is false and overTargetByCents is 0 with no contributions", async () => {
    const res = await request(app)
      .get(`${BASE}/jars/${jarId}/financial-summary`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.body.jar.isOverTarget).toBe(false);
    expect(res.body.jar.overTargetByCents).toBe(0);
  });

  it("currency is propagated from jar", async () => {
    const res = await request(app)
      .get(`${BASE}/jars/${jarId}/financial-summary`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.body.jar.currency).toBe("USD");
  });
});

// ─── PART F — Jar response uses ledger-backed totalSavedCents ─────────────────

describe("PART F — Jar response: totalSavedCents is ledger-backed (0 for no real payments)", () => {
  let token: string;
  let jarId: string;

  beforeAll(async () => {
    ({ token } = await register("ledger-total"));
    const jar = await createJar(token, 40_000);
    jarId = jar.id;
  });

  it("GET /jars/:jarId returns totalSavedCents=0 when no ledger entries", async () => {
    const res = await request(app)
      .get(`${BASE}/jars/${jarId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    // With ledger-backed totalSaved, no real payments → 0
    expect(res.body.totalSavedCents).toBe(0);
    expect(res.body.percentFunded).toBe(0);
  });

  it("GET /jars returns totalSavedCents=0 for all jars with no real payments", async () => {
    const res = await request(app)
      .get(`${BASE}/jars`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const testJar = (res.body as any[]).find((j: any) => j.id === jarId);
    expect(testJar).toBeDefined();
    expect(testJar.totalSavedCents).toBe(0);
  });

  it("GET /jars/:jarId/health works with ledger-backed totalSaved", async () => {
    // Launch the jar first (health only meaningful post-launch)
    await request(app)
      .post(`${BASE}/jars/${jarId}/launch`)
      .set("Authorization", `Bearer ${token}`);

    const res = await request(app)
      .get(`${BASE}/jars/${jarId}/health`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    // Health should compute correctly with 0 saved
    expect(res.body).toHaveProperty("status");
    expect(res.body).toHaveProperty("actualPercentage");
    expect(res.body.actualPercentage).toBe(0);
  });
});
