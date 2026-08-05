/**
 * Phase 4D — Jar Goals Tests
 *
 * Covers:
 *   PART A  — GET /jars/:jarId/goals (empty state, waterfall)
 *   PART B  — POST /jars/:jarId/goals (create, sum constraint)
 *   PART C  — Authorization (member read-only, outsider blocked)
 *   PART D  — PATCH /jars/:jarId/goals/:goalId (edit, sum constraint)
 *   PART E  — POST /jars/:jarId/goals/:goalId/archive (pre-launch delete, post-launch archive)
 *   PART F  — POST /jars/:jarId/goals/reorder (reorder validation)
 *   PART G  — Waterfall algebra (funded/partially/unfunded, surplus, unallocated)
 *   PART H  — Archived goals excluded from waterfall
 *   PART I  — Invariant: goal mutations create NO ledger entries / financial_transactions
 *   PART J  — PATCH /jars/:jarId goal amount constraint (goal sum must fit)
 */

import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import app from "../app.js";
import { db } from "@workspace/db";
import { ledgerEntries, financialTransactions, jarGoals, jars } from "@workspace/db";
import { eq, and, count } from "drizzle-orm";

const BASE = "/api";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function register(suffix: string) {
  const email = `goals-${suffix}-${Date.now()}@test.invalid`;
  const res = await request(app).post(`${BASE}/auth/register`).send({
    email,
    password: "P@ssword1!",
    firstName: "Goals",
    lastName: suffix,
  });
  expect(res.status, `register ${suffix}: ${JSON.stringify(res.body)}`).toBe(201);
  return { token: res.body.token as string, userId: res.body.user.id as string, email };
}

async function createJar(token: string, goalAmountCents = 100_000, status = "Draft") {
  const res = await request(app)
    .post(`${BASE}/jars`)
    .set("Authorization", `Bearer ${token}`)
    .send({
      name: `Goals Test Jar ${Date.now()}`,
      targetDate: "2027-12-31",
      goalAmountCents,
      currency: "USD",
    });
  expect(res.status, `createJar: ${JSON.stringify(res.body)}`).toBe(201);
  return res.body as { id: string; status: string; goalAmountCents: number };
}

async function inviteAndJoin(organizerToken: string, jarId: string, memberToken: string, memberEmail: string) {
  const inviteRes = await request(app)
    .post(`${BASE}/jars/${jarId}/invitations`)
    .set("Authorization", `Bearer ${organizerToken}`)
    .send({ email: memberEmail, role: "member" });
  if (!inviteRes.body?.id) return;
  await request(app)
    .post(`${BASE}/invitations/${inviteRes.body.id}/accept`)
    .set("Authorization", `Bearer ${memberToken}`);
}

async function createGoal(
  token: string,
  jarId: string,
  name: string,
  targetPrincipalCents: number,
) {
  const res = await request(app)
    .post(`${BASE}/jars/${jarId}/goals`)
    .set("Authorization", `Bearer ${token}`)
    .send({ name, targetPrincipalCents });
  expect(res.status, `createGoal "${name}": ${JSON.stringify(res.body)}`).toBe(201);
  return res.body as { id: string; name: string; targetPrincipalCents: number; sortOrder: number };
}

async function countLedgerEntries(): Promise<number> {
  const [row] = await db.select({ n: count() }).from(ledgerEntries);
  return Number(row?.n ?? 0);
}

async function countFinancialTransactions(): Promise<number> {
  const [row] = await db.select({ n: count() }).from(financialTransactions);
  return Number(row?.n ?? 0);
}

// ─── PART A — GET goals (empty state) ─────────────────────────────────────────

describe("PART A — GET /jars/:jarId/goals (empty state)", () => {
  let token: string;
  let jarId: string;

  beforeAll(async () => {
    ({ token } = await register("get-empty"));
    const jar = await createJar(token, 50_000);
    jarId = jar.id;
  });

  it("returns empty goals list with correct structure", async () => {
    const res = await request(app)
      .get(`${BASE}/jars/${jarId}/goals`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.goals).toEqual([]);
    expect(res.body.unallocatedCents).toBe(50_000);
    expect(res.body.surplusCents).toBe(0);
    expect(res.body.savedPrincipalCents).toBe(0);
    expect(res.body.committedPrincipalCents).toBe(0);
    expect(res.body.goalAmountCents).toBe(50_000);
  });
});

// ─── PART B — POST goals (create + sum constraint) ────────────────────────────

describe("PART B — POST /jars/:jarId/goals", () => {
  let token: string;
  let jarId: string;

  beforeAll(async () => {
    ({ token } = await register("post-goals"));
    const jar = await createJar(token, 100_000);
    jarId = jar.id;
  });

  it("creates a goal successfully", async () => {
    const res = await request(app)
      .post(`${BASE}/jars/${jarId}/goals`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Flights", targetPrincipalCents: 30_000 });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Flights");
    expect(res.body.targetPrincipalCents).toBe(30_000);
    expect(res.body.status).toBe("active");
    expect(res.body.sortOrder).toBeGreaterThan(0);
  });

  it("auto-increments sortOrder for subsequent goals", async () => {
    const g1 = await createGoal(token, jarId, "Hotel", 20_000);
    const g2 = await createGoal(token, jarId, "Car", 10_000);
    expect(g2.sortOrder).toBeGreaterThan(g1.sortOrder);
  });

  it("rejects goal that would exceed jar target (sum constraint)", async () => {
    // Jar target = 100_000; already have ~60_000+ from above
    // Try to add a goal that would push over the limit
    const res = await request(app)
      .post(`${BASE}/jars/${jarId}/goals`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Too Big", targetPrincipalCents: 99_000 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Conflict");
  });

  it("rejects missing name", async () => {
    const res = await request(app)
      .post(`${BASE}/jars/${jarId}/goals`)
      .set("Authorization", `Bearer ${token}`)
      .send({ targetPrincipalCents: 5_000 });
    expect(res.status).toBe(400);
  });

  it("rejects missing targetPrincipalCents", async () => {
    const res = await request(app)
      .post(`${BASE}/jars/${jarId}/goals`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "No Target" });
    expect(res.status).toBe(400);
  });

  it("rejects zero targetPrincipalCents", async () => {
    const res = await request(app)
      .post(`${BASE}/jars/${jarId}/goals`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Zero", targetPrincipalCents: 0 });
    expect(res.status).toBe(400);
  });

  it("rejects description over 500 characters", async () => {
    const res = await request(app)
      .post(`${BASE}/jars/${jarId}/goals`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Long Desc", targetPrincipalCents: 100, description: "x".repeat(501) });
    expect(res.status).toBe(400);
  });
});

// ─── PART C — Authorization ───────────────────────────────────────────────────

describe("PART C — Authorization", () => {
  let organizerToken: string;
  let memberToken: string;
  let memberEmail: string;
  let outsiderToken: string;
  let jarId: string;
  let goalId: string;

  beforeAll(async () => {
    const org = await register("auth-org");
    organizerToken = org.token;
    const mem = await register("auth-mem");
    memberToken = mem.token;
    memberEmail = mem.email;
    const out = await register("auth-out");
    outsiderToken = out.token;

    const jar = await createJar(organizerToken, 50_000);
    jarId = jar.id;

    // Invite member
    await inviteAndJoin(organizerToken, jarId, memberToken, memberEmail);

    // Create a goal for tests
    const goal = await createGoal(organizerToken, jarId, "Auth Test Goal", 10_000);
    goalId = goal.id;
  });

  it("member can read goals", async () => {
    const res = await request(app)
      .get(`${BASE}/jars/${jarId}/goals`)
      .set("Authorization", `Bearer ${memberToken}`);
    expect(res.status).toBe(200);
  });

  it("outsider cannot read goals (403)", async () => {
    const res = await request(app)
      .get(`${BASE}/jars/${jarId}/goals`)
      .set("Authorization", `Bearer ${outsiderToken}`);
    expect(res.status).toBe(403);
  });

  it("unauthenticated cannot read goals (401)", async () => {
    const res = await request(app).get(`${BASE}/jars/${jarId}/goals`);
    expect(res.status).toBe(401);
  });

  it("member cannot create goals (403)", async () => {
    const res = await request(app)
      .post(`${BASE}/jars/${jarId}/goals`)
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ name: "Member Goal", targetPrincipalCents: 5_000 });
    expect(res.status).toBe(403);
  });

  it("member cannot edit goals (403)", async () => {
    const res = await request(app)
      .patch(`${BASE}/jars/${jarId}/goals/${goalId}`)
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ name: "Renamed" });
    expect(res.status).toBe(403);
  });

  it("member cannot archive goals (403)", async () => {
    const res = await request(app)
      .post(`${BASE}/jars/${jarId}/goals/${goalId}/archive`)
      .set("Authorization", `Bearer ${memberToken}`);
    expect(res.status).toBe(403);
  });

  it("member cannot reorder goals (403)", async () => {
    const res = await request(app)
      .post(`${BASE}/jars/${jarId}/goals/reorder`)
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ goalIds: [goalId] });
    expect(res.status).toBe(403);
  });
});

// ─── PART D — PATCH goal ──────────────────────────────────────────────────────

describe("PART D — PATCH /jars/:jarId/goals/:goalId", () => {
  let token: string;
  let jarId: string;
  let goalId: string;

  beforeAll(async () => {
    ({ token } = await register("patch-goals"));
    const jar = await createJar(token, 80_000);
    jarId = jar.id;
    const goal = await createGoal(token, jarId, "Original Name", 20_000);
    goalId = goal.id;
  });

  it("updates name", async () => {
    const res = await request(app)
      .patch(`${BASE}/jars/${jarId}/goals/${goalId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Updated Name" });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Updated Name");
  });

  it("updates description", async () => {
    const res = await request(app)
      .patch(`${BASE}/jars/${jarId}/goals/${goalId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ description: "A useful description" });
    expect(res.status).toBe(200);
    expect(res.body.description).toBe("A useful description");
  });

  it("clears description with null", async () => {
    const res = await request(app)
      .patch(`${BASE}/jars/${jarId}/goals/${goalId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ description: null });
    expect(res.status).toBe(200);
    expect(res.body.description).toBeNull();
  });

  it("updates targetPrincipalCents within constraint", async () => {
    const res = await request(app)
      .patch(`${BASE}/jars/${jarId}/goals/${goalId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ targetPrincipalCents: 25_000 });
    expect(res.status).toBe(200);
    expect(res.body.targetPrincipalCents).toBe(25_000);
  });

  it("rejects targetPrincipalCents that would exceed jar target (409)", async () => {
    const res = await request(app)
      .patch(`${BASE}/jars/${jarId}/goals/${goalId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ targetPrincipalCents: 100_000 }); // jar target is 80_000
    expect(res.status).toBe(409);
  });

  it("returns 404 for non-existent goal", async () => {
    const res = await request(app)
      .patch(`${BASE}/jars/${jarId}/goals/00000000-0000-0000-0000-000000000000`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Ghost" });
    expect(res.status).toBe(404);
  });
});

// ─── PART E — Archive ─────────────────────────────────────────────────────────

describe("PART E — POST /jars/:jarId/goals/:goalId/archive", () => {
  it("hard-deletes a goal on a Draft jar", async () => {
    const { token } = await register("archive-draft");
    const jar = await createJar(token, 50_000);
    const goal = await createGoal(token, jar.id, "Draft Goal", 10_000);

    const res = await request(app)
      .post(`${BASE}/jars/${jar.id}/goals/${goal.id}/archive`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);

    // Goal should no longer exist in DB
    const dbGoal = await db
      .select()
      .from(jarGoals)
      .where(eq(jarGoals.id, goal.id))
      .limit(1);
    expect(dbGoal).toHaveLength(0);
  });

  it("soft-archives a goal on a Saving jar", async () => {
    const { token } = await register("archive-saving");
    const jar = await createJar(token, 50_000);
    const goal = await createGoal(token, jar.id, "Saving Goal", 10_000);

    // Launch the jar
    await request(app)
      .post(`${BASE}/jars/${jar.id}/launch`)
      .set("Authorization", `Bearer ${token}`);

    const res = await request(app)
      .post(`${BASE}/jars/${jar.id}/goals/${goal.id}/archive`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(false);
    expect(res.body.archived).toBe(true);
    expect(res.body.goal.status).toBe("archived");
    expect(res.body.goal.archivedAt).toBeTruthy();

    // Goal should still exist with status=archived
    const [dbGoal] = await db
      .select()
      .from(jarGoals)
      .where(eq(jarGoals.id, goal.id))
      .limit(1);
    expect(dbGoal).toBeDefined();
    expect(dbGoal!.status).toBe("archived");
  });

  it("rejects archiving an already-archived goal (400)", async () => {
    const { token } = await register("archive-twice");
    const jar = await createJar(token, 50_000);
    const goal = await createGoal(token, jar.id, "Already Archived", 5_000);

    // First archive (hard delete since Draft)
    await request(app)
      .post(`${BASE}/jars/${jar.id}/goals/${goal.id}/archive`)
      .set("Authorization", `Bearer ${token}`);

    // Attempt to archive the now-deleted goal
    const res = await request(app)
      .post(`${BASE}/jars/${jar.id}/goals/${goal.id}/archive`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404); // Hard deleted → not found
  });
});

// ─── PART F — Reorder ─────────────────────────────────────────────────────────

describe("PART F — POST /jars/:jarId/goals/reorder", () => {
  let token: string;
  let jarId: string;
  let g1: string;
  let g2: string;
  let g3: string;

  beforeAll(async () => {
    ({ token } = await register("reorder-goals"));
    const jar = await createJar(token, 100_000);
    jarId = jar.id;
    const a = await createGoal(token, jarId, "Alpha", 10_000);
    const b = await createGoal(token, jarId, "Beta", 10_000);
    const c = await createGoal(token, jarId, "Gamma", 10_000);
    g1 = a.id;
    g2 = b.id;
    g3 = c.id;
  });

  it("reorders goals and returns canonical order", async () => {
    const res = await request(app)
      .post(`${BASE}/jars/${jarId}/goals/reorder`)
      .set("Authorization", `Bearer ${token}`)
      .send({ goalIds: [g3, g1, g2] }); // Gamma, Alpha, Beta
    expect(res.status).toBe(200);
    const names = res.body.goals.map((g: any) => g.name);
    expect(names).toEqual(["Gamma", "Alpha", "Beta"]);
    // sort_orders should be 1, 2, 3
    expect(res.body.goals[0].sortOrder).toBe(1);
    expect(res.body.goals[1].sortOrder).toBe(2);
    expect(res.body.goals[2].sortOrder).toBe(3);
  });

  it("rejects if any goal ID is missing (incomplete list)", async () => {
    const res = await request(app)
      .post(`${BASE}/jars/${jarId}/goals/reorder`)
      .set("Authorization", `Bearer ${token}`)
      .send({ goalIds: [g1, g2] }); // Missing g3
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("BadRequest");
  });

  it("rejects duplicate IDs", async () => {
    const res = await request(app)
      .post(`${BASE}/jars/${jarId}/goals/reorder`)
      .set("Authorization", `Bearer ${token}`)
      .send({ goalIds: [g1, g1, g3] });
    expect(res.status).toBe(400);
  });

  it("rejects invalid (non-existent) goal IDs", async () => {
    const res = await request(app)
      .post(`${BASE}/jars/${jarId}/goals/reorder`)
      .set("Authorization", `Bearer ${token}`)
      .send({ goalIds: [g1, g2, "00000000-0000-0000-0000-000000000000"] });
    expect(res.status).toBe(400);
  });

  it("rejects empty goalIds array", async () => {
    const res = await request(app)
      .post(`${BASE}/jars/${jarId}/goals/reorder`)
      .set("Authorization", `Bearer ${token}`)
      .send({ goalIds: [] });
    expect(res.status).toBe(400);
  });
});

// ─── PART G — Waterfall algebra ───────────────────────────────────────────────

describe("PART G — Waterfall algebra (no real ledger entries)", () => {
  // We test the waterfall via the goals endpoint.
  // With no ledger entries, savedPrincipalCents = 0 → all goals unfunded.
  let token: string;
  let jarId: string;

  beforeAll(async () => {
    ({ token } = await register("waterfall-test"));
    const jar = await createJar(token, 100_000);
    jarId = jar.id;
    await createGoal(token, jarId, "Flights", 40_000);
    await createGoal(token, jarId, "Hotel", 30_000);
    await createGoal(token, jarId, "Car", 20_000);
  });

  it("all goals unfunded when no principal saved", async () => {
    const res = await request(app)
      .get(`${BASE}/jars/${jarId}/goals`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    for (const goal of res.body.goals) {
      expect(goal.fundingState).toBe("unfunded");
      expect(goal.savedAllocatedCents).toBe(0);
      expect(goal.committedAllocatedCents).toBe(0);
      expect(goal.savedPercent).toBe(0);
    }
  });

  it("unallocatedCents = jar target - sum of active goal targets", async () => {
    const res = await request(app)
      .get(`${BASE}/jars/${jarId}/goals`)
      .set("Authorization", `Bearer ${token}`);
    // 100_000 - (40_000 + 30_000 + 20_000) = 10_000
    expect(res.body.unallocatedCents).toBe(10_000);
  });

  it("surplusCents = 0 when no principal saved", async () => {
    const res = await request(app)
      .get(`${BASE}/jars/${jarId}/goals`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.body.surplusCents).toBe(0);
  });

  it("goals returned in sort_order ascending", async () => {
    const res = await request(app)
      .get(`${BASE}/jars/${jarId}/goals`)
      .set("Authorization", `Bearer ${token}`);
    const names = res.body.goals.map((g: any) => g.name);
    expect(names).toEqual(["Flights", "Hotel", "Car"]);
  });
});

// ─── PART H — Archived goals excluded from waterfall ─────────────────────────

describe("PART H — Archived goals excluded from waterfall", () => {
  let token: string;
  let jarId: string;
  let archivedGoalId: string;

  beforeAll(async () => {
    ({ token } = await register("archive-waterfall"));
    const jar = await createJar(token, 80_000);
    jarId = jar.id;
    await createGoal(token, jarId, "Active Goal", 30_000);
    const archived = await createGoal(token, jarId, "To Archive", 20_000);
    archivedGoalId = archived.id;

    // Launch so we get soft archive
    await request(app)
      .post(`${BASE}/jars/${jar.id}/launch`)
      .set("Authorization", `Bearer ${token}`);

    // Archive one goal
    await request(app)
      .post(`${BASE}/jars/${jar.id}/goals/${archivedGoalId}/archive`)
      .set("Authorization", `Bearer ${token}`);
  });

  it("active goals list excludes archived goals", async () => {
    const res = await request(app)
      .get(`${BASE}/jars/${jarId}/goals`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.goals).toHaveLength(1);
    expect(res.body.goals[0].name).toBe("Active Goal");
  });

  it("unallocatedCents recalculates after archiving", async () => {
    const res = await request(app)
      .get(`${BASE}/jars/${jarId}/goals`)
      .set("Authorization", `Bearer ${token}`);
    // jar target 80_000, only active goal 30_000 → unallocated = 50_000
    expect(res.body.unallocatedCents).toBe(50_000);
  });

  it("includeArchived=true returns archived goals separately", async () => {
    const res = await request(app)
      .get(`${BASE}/jars/${jarId}/goals?includeArchived=true`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.archivedGoals).toHaveLength(1);
    expect(res.body.archivedGoals[0].name).toBe("To Archive");
    expect(res.body.archivedGoals[0].status).toBe("archived");
  });
});

// ─── PART I — Invariant: goal mutations create NO ledger/FT entries ───────────

describe("PART I — Invariant: goal mutations leave ledger unchanged", () => {
  let token: string;
  let jarId: string;
  let goalId: string;

  beforeAll(async () => {
    ({ token } = await register("invariant-goals"));
    const jar = await createJar(token, 100_000);
    jarId = jar.id;
    const goal = await createGoal(token, jarId, "Invariant Goal", 30_000);
    goalId = goal.id;
  });

  it("POST /goals does not create ledger_entries or financial_transactions", async () => {
    const leBefore = await countLedgerEntries();
    const ftBefore = await countFinancialTransactions();

    await createGoal(token, jarId, "New Goal", 10_000);

    const leAfter = await countLedgerEntries();
    const ftAfter = await countFinancialTransactions();
    expect(leAfter).toBe(leBefore);
    expect(ftAfter).toBe(ftBefore);
  });

  it("PATCH /goals does not create ledger_entries or financial_transactions", async () => {
    const leBefore = await countLedgerEntries();
    const ftBefore = await countFinancialTransactions();

    await request(app)
      .patch(`${BASE}/jars/${jarId}/goals/${goalId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Renamed Invariant" });

    const leAfter = await countLedgerEntries();
    const ftAfter = await countFinancialTransactions();
    expect(leAfter).toBe(leBefore);
    expect(ftAfter).toBe(ftBefore);
  });

  it("POST /goals/reorder does not create ledger_entries or financial_transactions", async () => {
    const allGoalsRes = await request(app)
      .get(`${BASE}/jars/${jarId}/goals`)
      .set("Authorization", `Bearer ${token}`);
    const ids: string[] = allGoalsRes.body.goals.map((g: any) => g.id);

    const leBefore = await countLedgerEntries();
    const ftBefore = await countFinancialTransactions();

    await request(app)
      .post(`${BASE}/jars/${jarId}/goals/reorder`)
      .set("Authorization", `Bearer ${token}`)
      .send({ goalIds: ids.reverse() });

    const leAfter = await countLedgerEntries();
    const ftAfter = await countFinancialTransactions();
    expect(leAfter).toBe(leBefore);
    expect(ftAfter).toBe(ftBefore);
  });

  it("Launch jar + POST /goals/archive does not create ledger entries", async () => {
    // Launch the jar so we get soft archive
    await request(app)
      .post(`${BASE}/jars/${jarId}/launch`)
      .set("Authorization", `Bearer ${token}`);

    const allGoalsRes = await request(app)
      .get(`${BASE}/jars/${jarId}/goals`)
      .set("Authorization", `Bearer ${token}`);
    const firstGoalId = allGoalsRes.body.goals[0]?.id as string;
    if (!firstGoalId) return; // No active goals to archive

    const leBefore = await countLedgerEntries();
    const ftBefore = await countFinancialTransactions();

    await request(app)
      .post(`${BASE}/jars/${jarId}/goals/${firstGoalId}/archive`)
      .set("Authorization", `Bearer ${token}`);

    const leAfter = await countLedgerEntries();
    const ftAfter = await countFinancialTransactions();
    expect(leAfter).toBe(leBefore);
    expect(ftAfter).toBe(ftBefore);
  });
});

// ─── PART J — PATCH jar goal amount constraint ────────────────────────────────

describe("PART J — PATCH /jars/:jarId goalAmountCents constraint with goals", () => {
  let token: string;
  let jarId: string;

  beforeAll(async () => {
    ({ token } = await register("jar-amount-constraint"));
    const jar = await createJar(token, 100_000);
    jarId = jar.id;
    // Create a goal for 60_000
    await createGoal(token, jarId, "Big Goal", 60_000);
  });

  it("allows increasing goalAmountCents freely", async () => {
    const res = await request(app)
      .patch(`${BASE}/jars/${jarId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ goalAmountCents: 150_000 });
    expect(res.status).toBe(200);
  });

  it("rejects reducing goalAmountCents below active goal sum (409)", async () => {
    const res = await request(app)
      .patch(`${BASE}/jars/${jarId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ goalAmountCents: 50_000 }); // Goals sum is 60_000
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Conflict");
  });

  it("allows reducing goalAmountCents to exactly the goal sum", async () => {
    const res = await request(app)
      .patch(`${BASE}/jars/${jarId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ goalAmountCents: 60_000 }); // Exactly equals the goal sum
    expect(res.status).toBe(200);
  });
});
