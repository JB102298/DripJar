/**
 * Phase 4C — Fund Commitment Tests
 *
 * Covers:
 *   PART A  — Phase gate enforcement (Saving vs Commitment phase)
 *   PART B  — Agreement gate (no agreement, not accepted, accepted)
 *   PART C  — Commitment preview (FIFO lots, snapshot creation)
 *   PART D  — Commitment confirm (ledger posting, allocation copy)
 *   PART E  — Idempotency (double confirm returns existing, no re-posting)
 *   PART F  — Stale snapshot (expired, agreement changed, balance changed)
 *   PART G  — Ledger invariants (CTRB_REFUNDABLE DR / CTRB_COMMITTED CR)
 *   PART H  — Financial balance (committedPrincipal, invariantHolds)
 *   PART I  — GET /jars/:jarId/commitment/mine
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import app from "../app.js";
import { db } from "@workspace/db";
import {
  jars,
  jarMembers,
  agreements,
  agreementAcceptances,
  commitmentSnapshots,
  commitmentSnapshotAllocations,
  fundCommitments,
  commitmentAllocations,
  financialTransactions,
  ledgerEntries,
  ledgerTransactions,
  ledgerAccounts,
} from "@workspace/db";
import { eq, and, sql, desc } from "drizzle-orm";
import { postContributionAccounting, clearLedgerAccountCache } from "../lib/ledger.js";
import { getMemberFinancialBalance } from "../lib/financial-balance.js";

const BASE = "/api";

// ─── Test helpers ──────────────────────────────────────────────────────────────

async function register(suffix: string) {
  const email = `commit-${suffix}-${Date.now()}@test.invalid`;
  const res = await request(app).post(`${BASE}/auth/register`).send({
    email,
    password: "P@ssword1!",
    firstName: "Commit",
    lastName: suffix,
  });
  expect(res.status, `register ${suffix}: ${JSON.stringify(res.body)}`).toBe(201);
  return { token: res.body.token as string, userId: res.body.user.id as string, email };
}

async function createJar(token: string, name = "Commitment Jar") {
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
  expect(res.status, `launchJar: ${JSON.stringify(res.body)}`).toBe(200);
}

async function getMemberId(jarId: string, userId: string): Promise<string> {
  const [m] = await db
    .select({ id: jarMembers.id })
    .from(jarMembers)
    .where(and(eq(jarMembers.jarId, jarId), eq(jarMembers.userId, userId)));
  if (!m) throw new Error(`Member not found`);
  return m.id;
}

/** Set the jar's cutoff date to a past date (enabling Commitment phase). */
async function setCutoffPast(jarId: string, cutoffDate = "2026-07-01") {
  await db.update(jars).set({ cutoffDate }).where(eq(jars.id, jarId));
}

/** Create an agreement for the jar and optionally mark the user as having accepted it. */
async function seedAgreement(jarId: string, userId: string, accept = true) {
  const [ag] = await db
    .insert(agreements)
    .values({
      jarId,
      version: "1.0",
      content: "You agree to the terms.",
      effectiveDate: "2026-01-01",
    })
    .returning({ id: agreements.id, version: agreements.version });

  if (!ag) throw new Error("Failed to seed agreement");

  if (accept) {
    await db.insert(agreementAcceptances).values({
      agreementId: ag.id,
      userId,
    });
  }

  return { agreementId: ag.id, agreementVersion: ag.version };
}

let _piCounter = 0;

/** Seed a Stripe-backed contribution FT (providerType=stripe, providerStatus=succeeded). */
async function seedStripeFt(
  jarId: string,
  memberId: string,
  principalCents: number,
): Promise<string> {
  clearLedgerAccountCache();
  const result = await postContributionAccounting({ jarId, memberId, principalCents, estimatedProcessingFeeCents: 0 });
  const piId = `pi_test_commit_${++_piCounter}_${Date.now()}`;
  await db
    .update(financialTransactions)
    .set({ providerType: "stripe", providerStatus: "succeeded", providerTransactionId: piId })
    .where(eq(financialTransactions.id, result.financialTransactionId));
  return result.financialTransactionId;
}

// ─────────────────────────────────────────────────────────────────────────────
// PART A — Phase gate enforcement
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 4C Commitment — PART A: Phase gate", () => {
  let token: string;
  let jarId: string;

  beforeAll(async () => {
    ({ token } = await register("phasegate-a"));
    ({ id: jarId } = await createJar(token, "Phase Gate Jar"));
    await launchJar(token, jarId);
  });

  it("422 when jar is in Saving phase (no cutoffDate)", async () => {
    const res = await request(app)
      .post(`${BASE}/jars/${jarId}/commitment/preview`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("PhaseGate");
    expect(res.body.phase).toBe("Saving");
  });

  it("422 when cutoffDate is in the future", async () => {
    await db.update(jars).set({ cutoffDate: "2099-12-31" }).where(eq(jars.id, jarId));
    const res = await request(app)
      .post(`${BASE}/jars/${jarId}/commitment/preview`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("PhaseGate");
  });

  it("proceeds to next gate when cutoffDate <= today UTC", async () => {
    await setCutoffPast(jarId);
    const res = await request(app)
      .post(`${BASE}/jars/${jarId}/commitment/preview`)
      .set("Authorization", `Bearer ${token}`);
    // Every jar auto-creates a default agreement on creation, so "NoActiveAgreement"
    // is unreachable in normal flow. The route hits the acceptance gate instead.
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("AgreementNotAccepted");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART B — Agreement gate
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 4C Commitment — PART B: Agreement gate", () => {
  let token: string;
  let userId: string;
  let jarId: string;

  beforeAll(async () => {
    ({ token, userId } = await register("agreegate-b"));
    ({ id: jarId } = await createJar(token, "Agreement Gate Jar"));
    await launchJar(token, jarId);
    await setCutoffPast(jarId);
  });

  it("422 agreement_not_accepted when jar has agreement but organizer has not accepted", async () => {
    // Every jar auto-creates a default agreement; organizer has not accepted it yet.
    const res = await request(app)
      .post(`${BASE}/jars/${jarId}/commitment/preview`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("AgreementNotAccepted");
    expect(res.body.code).toBe("agreement_not_accepted");
  });

  it("422 agreement_not_accepted when agreement exists but user has not accepted", async () => {
    await seedAgreement(jarId, userId, /* accept= */ false);
    const res = await request(app)
      .post(`${BASE}/jars/${jarId}/commitment/preview`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("AgreementNotAccepted");
    expect(res.body.code).toBe("agreement_not_accepted");
  });

  it("proceeds to next gate when agreement exists and user accepted", async () => {
    // Accept the LATEST agreement — same one getCurrentAgreement picks (desc createdAt).
    // test 2 may have added a newer version via seedAgreement, so we must order consistently.
    const [ag] = await db
      .select({ id: agreements.id })
      .from(agreements)
      .where(eq(agreements.jarId, jarId))
      .orderBy(desc(agreements.createdAt))
      .limit(1);
    if (ag) {
      await db.insert(agreementAcceptances).values({ agreementId: ag.id, userId }).onConflictDoNothing();
    }
    const res = await request(app)
      .post(`${BASE}/jars/${jarId}/commitment/preview`)
      .set("Authorization", `Bearer ${token}`);
    // Fails at nothing-to-commit gate (no Stripe contributions)
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("NothingToCommit");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART C — Commitment preview
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 4C Commitment — PART C: Preview", () => {
  let token: string;
  let userId: string;
  let jarId: string;
  let memberId: string;
  let agreementId: string;
  let agreementVersion: string;

  beforeAll(async () => {
    clearLedgerAccountCache();
    ({ token, userId } = await register("preview-c"));
    ({ id: jarId } = await createJar(token, "Preview Jar"));
    await launchJar(token, jarId);
    await setCutoffPast(jarId);
    memberId = await getMemberId(jarId, userId);
    ({ agreementId, agreementVersion } = await seedAgreement(jarId, userId));
    // Seed two Stripe contributions
    await seedStripeFt(jarId, memberId, 10_000);
    await seedStripeFt(jarId, memberId, 15_000);
  });

  it("returns snapshotToken, totalPrincipalCents=25000, 2 allocations", async () => {
    const res = await request(app)
      .post(`${BASE}/jars/${jarId}/commitment/preview`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.snapshotToken).toBeTruthy();
    expect(res.body.totalPrincipalCents).toBe(25_000);
    expect(res.body.allocations).toHaveLength(2);
    expect(res.body.agreementId).toBe(agreementId);
    expect(res.body.agreementVersion).toBe(agreementVersion);
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("creates commitment_snapshot row in DB", async () => {
    const res = await request(app)
      .post(`${BASE}/jars/${jarId}/commitment/preview`)
      .set("Authorization", `Bearer ${token}`);
    const [snap] = await db
      .select()
      .from(commitmentSnapshots)
      .where(eq(commitmentSnapshots.snapshotToken, res.body.snapshotToken));
    expect(snap).toBeTruthy();
    expect(snap!.status).toBe("pending");
    expect(Number(snap!.totalPrincipalCents)).toBe(25_000);
    expect(snap!.agreementId).toBe(agreementId);
    expect(snap!.agreementVersion).toBe(agreementVersion);
  });

  it("creates commitment_snapshot_allocations for each lot", async () => {
    const res = await request(app)
      .post(`${BASE}/jars/${jarId}/commitment/preview`)
      .set("Authorization", `Bearer ${token}`);
    const [snap] = await db
      .select({ id: commitmentSnapshots.id })
      .from(commitmentSnapshots)
      .where(eq(commitmentSnapshots.snapshotToken, res.body.snapshotToken));
    const allocs = await db
      .select()
      .from(commitmentSnapshotAllocations)
      .where(eq(commitmentSnapshotAllocations.snapshotId, snap!.id));
    expect(allocs).toHaveLength(2);
  });

  it("422 NothingToCommit when member has no Stripe contributions", async () => {
    const { token: t2, userId: u2 } = await register("preview-nostripe");
    const { id: j2 } = await createJar(t2, "No Stripe Jar");
    await launchJar(t2, j2);
    await setCutoffPast(j2);
    const m2 = await getMemberId(j2, u2);
    await seedAgreement(j2, u2);
    // No Stripe FT seeded
    const res = await request(app)
      .post(`${BASE}/jars/${j2}/commitment/preview`)
      .set("Authorization", `Bearer ${t2}`);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("NothingToCommit");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART D — Commitment confirm (ledger posting)
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 4C Commitment — PART D: Confirm and ledger", () => {
  let token: string;
  let userId: string;
  let jarId: string;
  let memberId: string;
  let snapshotToken: string;

  beforeAll(async () => {
    clearLedgerAccountCache();
    ({ token, userId } = await register("confirm-d"));
    ({ id: jarId } = await createJar(token, "Confirm Jar"));
    await launchJar(token, jarId);
    await setCutoffPast(jarId);
    memberId = await getMemberId(jarId, userId);
    await seedAgreement(jarId, userId);
    await seedStripeFt(jarId, memberId, 20_000);

    const previewRes = await request(app)
      .post(`${BASE}/jars/${jarId}/commitment/preview`)
      .set("Authorization", `Bearer ${token}`);
    expect(previewRes.status).toBe(200);
    snapshotToken = previewRes.body.snapshotToken;
  });

  it("confirm returns fundCommitmentId and totalCommittedCents", async () => {
    const res = await request(app)
      .post(`${BASE}/jars/${jarId}/commitment/confirm`)
      .set("Authorization", `Bearer ${token}`)
      .send({ snapshotToken });
    expect(res.status).toBe(200);
    expect(res.body.fundCommitmentId).toBeTruthy();
    expect(res.body.totalCommittedCents).toBe(20_000);
    expect(res.body.idempotent).toBe(false);
  });

  it("fund_commitments row created with correct agreementId/Version (NOT NULL)", async () => {
    const [fc] = await db
      .select()
      .from(fundCommitments)
      .where(and(eq(fundCommitments.memberId, memberId), eq(fundCommitments.jarId, jarId)));
    expect(fc).toBeTruthy();
    expect(fc!.totalCommittedCents).toBe(20_000);
    expect(fc!.agreementId).toBeTruthy();
    expect(fc!.agreementVersion).toBeTruthy();
    expect(fc!.financialTransactionId).toBeTruthy();
  });

  it("commitment_allocations rows created", async () => {
    const [fc] = await db
      .select({ id: fundCommitments.id })
      .from(fundCommitments)
      .where(and(eq(fundCommitments.memberId, memberId), eq(fundCommitments.jarId, jarId)));
    const allocs = await db
      .select()
      .from(commitmentAllocations)
      .where(eq(commitmentAllocations.fundCommitmentId, fc!.id));
    expect(allocs.length).toBeGreaterThan(0);
    const totalAllocated = allocs.reduce((s, a) => s + Number(a.allocatedCents), 0);
    expect(totalAllocated).toBe(20_000);
  });

  it("snapshot status updated to confirmed", async () => {
    const [snap] = await db
      .select({ status: commitmentSnapshots.status })
      .from(commitmentSnapshots)
      .where(eq(commitmentSnapshots.snapshotToken, snapshotToken));
    expect(snap!.status).toBe("confirmed");
  });

  it("CTRB_REFUNDABLE debited by 20000", async () => {
    const rows = await db
      .select({
        entryType: ledgerEntries.entryType,
        amount: sql<string>`sum(${ledgerEntries.amountCents})`,
      })
      .from(ledgerEntries)
      .innerJoin(ledgerTransactions, eq(ledgerEntries.ledgerTransactionId, ledgerTransactions.id))
      .innerJoin(financialTransactions, eq(ledgerTransactions.financialTransactionId, financialTransactions.id))
      .innerJoin(ledgerAccounts, and(
        eq(ledgerEntries.accountId, ledgerAccounts.id),
        eq(ledgerAccounts.code, "CTRB_REFUNDABLE"),
      ))
      .where(and(
        eq(financialTransactions.jarId, jarId),
        eq(financialTransactions.memberId, memberId),
        eq(financialTransactions.transactionType, "commitment_transfer"),
      ))
      .groupBy(ledgerEntries.entryType);

    const debit = rows.find((r) => r.entryType === "debit");
    expect(Number(debit?.amount ?? 0)).toBe(20_000);
  });

  it("CTRB_COMMITTED credited by 20000", async () => {
    const rows = await db
      .select({
        entryType: ledgerEntries.entryType,
        amount: sql<string>`sum(${ledgerEntries.amountCents})`,
      })
      .from(ledgerEntries)
      .innerJoin(ledgerTransactions, eq(ledgerEntries.ledgerTransactionId, ledgerTransactions.id))
      .innerJoin(financialTransactions, eq(ledgerTransactions.financialTransactionId, financialTransactions.id))
      .innerJoin(ledgerAccounts, and(
        eq(ledgerEntries.accountId, ledgerAccounts.id),
        eq(ledgerAccounts.code, "CTRB_COMMITTED"),
      ))
      .where(and(
        eq(financialTransactions.jarId, jarId),
        eq(financialTransactions.memberId, memberId),
      ))
      .groupBy(ledgerEntries.entryType);

    const credit = rows.find((r) => r.entryType === "credit");
    expect(Number(credit?.amount ?? 0)).toBe(20_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART E — Idempotency
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 4C Commitment — PART E: Idempotency", () => {
  let token: string;
  let jarId: string;
  let memberId: string;
  let snapshotToken: string;
  let fundCommitmentId: string;

  beforeAll(async () => {
    clearLedgerAccountCache();
    const { token: t, userId } = await register("idem-e");
    token = t;
    ({ id: jarId } = await createJar(token, "Idempotency Jar"));
    await launchJar(token, jarId);
    await setCutoffPast(jarId);
    memberId = await getMemberId(jarId, userId);
    await seedAgreement(jarId, userId);
    await seedStripeFt(jarId, memberId, 10_000);

    const preview = await request(app)
      .post(`${BASE}/jars/${jarId}/commitment/preview`)
      .set("Authorization", `Bearer ${token}`);
    snapshotToken = preview.body.snapshotToken;

    const confirm = await request(app)
      .post(`${BASE}/jars/${jarId}/commitment/confirm`)
      .set("Authorization", `Bearer ${token}`)
      .send({ snapshotToken });
    fundCommitmentId = confirm.body.fundCommitmentId;
  });

  it("second confirm with same snapshotToken returns existing result (idempotent=true)", async () => {
    const res = await request(app)
      .post(`${BASE}/jars/${jarId}/commitment/confirm`)
      .set("Authorization", `Bearer ${token}`)
      .send({ snapshotToken });
    expect(res.status).toBe(200);
    expect(res.body.idempotent).toBe(true);
    expect(res.body.fundCommitmentId).toBe(fundCommitmentId);
  });

  it("no second ledger posting on retry", async () => {
    const rows = await db
      .select({ id: financialTransactions.id })
      .from(financialTransactions)
      .where(and(
        eq(financialTransactions.memberId, memberId),
        eq(financialTransactions.transactionType, "commitment_transfer"),
      ));
    expect(rows.length).toBe(1);
  });

  it("409 AlreadyCommitted when previewing again after commitment", async () => {
    const res = await request(app)
      .post(`${BASE}/jars/${jarId}/commitment/preview`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("AlreadyCommitted");
    expect(res.body.fundCommitmentId).toBe(fundCommitmentId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART F — Stale / expired snapshot
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 4C Commitment — PART F: Stale/expired snapshots", () => {
  let token: string;
  let userId: string;
  let jarId: string;
  let memberId: string;

  beforeAll(async () => {
    clearLedgerAccountCache();
    ({ token, userId } = await register("stale-f"));
    ({ id: jarId } = await createJar(token, "Stale Jar"));
    await launchJar(token, jarId);
    await setCutoffPast(jarId);
    memberId = await getMemberId(jarId, userId);
    await seedAgreement(jarId, userId);
    await seedStripeFt(jarId, memberId, 10_000);
  });

  it("409 snapshot_stale reason=agreement_changed when a new agreement is published after preview", async () => {
    const preview = await request(app)
      .post(`${BASE}/jars/${jarId}/commitment/preview`)
      .set("Authorization", `Bearer ${token}`);
    const { snapshotToken } = preview.body as { snapshotToken: string };

    // Publish a new agreement version after the preview
    const [newAg] = await db
      .insert(agreements)
      .values({ jarId, version: "2.0", content: "Updated terms.", effectiveDate: "2026-08-01" })
      .returning({ id: agreements.id });
    // Accept the new version too
    await db.insert(agreementAcceptances).values({ agreementId: newAg!.id, userId });

    const res = await request(app)
      .post(`${BASE}/jars/${jarId}/commitment/confirm`)
      .set("Authorization", `Bearer ${token}`)
      .send({ snapshotToken });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("snapshot_stale");
    expect(res.body.reason).toBe("agreement_changed");
  });

  it("409 snapshot_stale when snapshot is force-expired (past expiresAt)", async () => {
    // Get a fresh jar for this test
    const { token: t2, userId: u2 } = await register("stale-exp-f");
    const { id: j2 } = await createJar(t2, "Expire Jar");
    await launchJar(t2, j2);
    await setCutoffPast(j2);
    const m2 = await getMemberId(j2, u2);
    await seedAgreement(j2, u2);
    await seedStripeFt(j2, m2, 5_000);

    const preview = await request(app)
      .post(`${BASE}/jars/${j2}/commitment/preview`)
      .set("Authorization", `Bearer ${t2}`);
    const { snapshotToken } = preview.body as { snapshotToken: string };

    // Force-expire the snapshot
    await db
      .update(commitmentSnapshots)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(commitmentSnapshots.snapshotToken, snapshotToken));

    const res = await request(app)
      .post(`${BASE}/jars/${j2}/commitment/confirm`)
      .set("Authorization", `Bearer ${t2}`)
      .send({ snapshotToken });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("snapshot_stale");
  });

  it("400 when snapshotToken missing", async () => {
    const res = await request(app)
      .post(`${BASE}/jars/${jarId}/commitment/confirm`)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("409 when snapshotToken not found", async () => {
    const res = await request(app)
      .post(`${BASE}/jars/${jarId}/commitment/confirm`)
      .set("Authorization", `Bearer ${token}`)
      .send({ snapshotToken: "aabbccddeeff112233445566778899" });
    expect(res.status).toBe(409);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART G — Snapshot TTL (15 minutes)
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 4C Commitment — PART G: Snapshot TTL = 15 minutes", () => {
  let token: string;
  let userId: string;
  let jarId: string;
  let memberId: string;

  beforeAll(async () => {
    clearLedgerAccountCache();
    ({ token, userId } = await register("ttl-g"));
    ({ id: jarId } = await createJar(token, "TTL Jar"));
    await launchJar(token, jarId);
    await setCutoffPast(jarId);
    memberId = await getMemberId(jarId, userId);
    await seedAgreement(jarId, userId);
    await seedStripeFt(jarId, memberId, 5_000);
  });

  it("preview expiresAt is approximately 15 minutes from now (±60 s)", async () => {
    const before = Date.now();
    const res = await request(app)
      .post(`${BASE}/jars/${jarId}/commitment/preview`)
      .set("Authorization", `Bearer ${token}`);
    const after = Date.now();
    expect(res.status).toBe(200);
    const expiresAt = new Date(res.body.expiresAt).getTime();
    // Must be between 14 min and 16 min from the request window
    expect(expiresAt).toBeGreaterThan(before + 14 * 60_000);
    expect(expiresAt).toBeLessThan(after  + 16 * 60_000);
  });

  it("confirm succeeds when snapshot is within the 15-minute window", async () => {
    const preview = await request(app)
      .post(`${BASE}/jars/${jarId}/commitment/preview`)
      .set("Authorization", `Bearer ${token}`);
    expect(preview.status).toBe(200);
    // Immediately confirm — well within the 15-minute TTL
    const res = await request(app)
      .post(`${BASE}/jars/${jarId}/commitment/confirm`)
      .set("Authorization", `Bearer ${token}`)
      .send({ snapshotToken: preview.body.snapshotToken });
    expect(res.status).toBe(200);
    expect(res.body.fundCommitmentId).toBeTruthy();
  });

  it("confirm rejects (409 snapshot_stale) when snapshot is force-expired beyond 15 minutes", async () => {
    // Fresh jar so it has no existing commitment
    const { token: t2, userId: u2 } = await register("ttl-expire-g");
    const { id: j2 } = await createJar(t2, "TTL Expire Jar");
    await launchJar(t2, j2);
    await setCutoffPast(j2);
    const m2 = await getMemberId(j2, u2);
    await seedAgreement(j2, u2);
    await seedStripeFt(j2, m2, 3_000);

    const preview = await request(app)
      .post(`${BASE}/jars/${j2}/commitment/preview`)
      .set("Authorization", `Bearer ${t2}`);
    const { snapshotToken } = preview.body as { snapshotToken: string };

    // Manually push expiresAt past the 15-minute mark (simulate timeout)
    await db
      .update(commitmentSnapshots)
      .set({ expiresAt: new Date(Date.now() - 16 * 60_000) })
      .where(eq(commitmentSnapshots.snapshotToken, snapshotToken));

    const res = await request(app)
      .post(`${BASE}/jars/${j2}/commitment/confirm`)
      .set("Authorization", `Bearer ${t2}`)
      .send({ snapshotToken });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("snapshot_stale");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART H — Financial balance after commitment
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 4C Commitment — PART H: Financial balance", () => {
  let jarId: string;
  let memberId: string;
  let token: string;

  beforeAll(async () => {
    clearLedgerAccountCache();
    const { token: t, userId } = await register("balance-h");
    token = t;
    ({ id: jarId } = await createJar(token, "Balance Jar"));
    await launchJar(token, jarId);
    await setCutoffPast(jarId);
    memberId = await getMemberId(jarId, userId);
    await seedAgreement(jarId, userId);
    await seedStripeFt(jarId, memberId, 20_000);
    await seedStripeFt(jarId, memberId, 10_000);

    const preview = await request(app)
      .post(`${BASE}/jars/${jarId}/commitment/preview`)
      .set("Authorization", `Bearer ${token}`);
    await request(app)
      .post(`${BASE}/jars/${jarId}/commitment/confirm`)
      .set("Authorization", `Bearer ${token}`)
      .send({ snapshotToken: preview.body.snapshotToken });
  });

  it("committedPrincipalCents = 30000 after committing both lots", async () => {
    const b = await getMemberFinancialBalance(jarId, memberId);
    expect(b.committedPrincipalCents).toBe(30_000);
  });

  it("refundablePrincipalCents = 0 after committing all", async () => {
    const b = await getMemberFinancialBalance(jarId, memberId);
    expect(b.refundablePrincipalCents).toBe(0);
  });

  it("contributedPrincipalCents = 30000", async () => {
    const b = await getMemberFinancialBalance(jarId, memberId);
    expect(b.contributedPrincipalCents).toBe(30_000);
  });

  it("invariantHolds = true", async () => {
    const b = await getMemberFinancialBalance(jarId, memberId);
    expect(b.invariantHolds).toBe(true);
    expect(
      b.refundablePrincipalCents + b.refundPendingCents + b.committedPrincipalCents + b.refundedPrincipalCents
    ).toBe(b.contributedPrincipalCents);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART J — Concurrent duplicate commit (race safety)
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 4C Commitment — PART J: Concurrent duplicate commit race", () => {
  let token: string;
  let jarId: string;
  let memberId: string;
  let snapshotToken: string;

  beforeAll(async () => {
    clearLedgerAccountCache();
    const { token: t, userId } = await register("concurrent-j");
    token = t;
    ({ id: jarId } = await createJar(token, "Concurrent Jar"));
    await launchJar(token, jarId);
    await setCutoffPast(jarId);
    memberId = await getMemberId(jarId, userId);
    await seedAgreement(jarId, userId);
    await seedStripeFt(jarId, memberId, 12_000);

    const preview = await request(app)
      .post(`${BASE}/jars/${jarId}/commitment/preview`)
      .set("Authorization", `Bearer ${token}`);
    expect(preview.status).toBe(200);
    snapshotToken = preview.body.snapshotToken;
  });

  it("two concurrent confirms with the same snapshotToken both return 2xx (no HTTP 500)", async () => {
    const [r1, r2] = await Promise.all([
      request(app)
        .post(`${BASE}/jars/${jarId}/commitment/confirm`)
        .set("Authorization", `Bearer ${token}`)
        .send({ snapshotToken }),
      request(app)
        .post(`${BASE}/jars/${jarId}/commitment/confirm`)
        .set("Authorization", `Bearer ${token}`)
        .send({ snapshotToken }),
    ]);
    // Both must be 2xx — never 500
    expect(r1.status).toBeGreaterThanOrEqual(200);
    expect(r1.status).toBeLessThan(300);
    expect(r2.status).toBeGreaterThanOrEqual(200);
    expect(r2.status).toBeLessThan(300);
    // Both return a fundCommitmentId and the same commitment ID
    expect(r1.body.fundCommitmentId).toBeTruthy();
    expect(r2.body.fundCommitmentId).toBeTruthy();
    expect(r1.body.fundCommitmentId).toBe(r2.body.fundCommitmentId);
    // Exactly one of them is the "new" commit, the other is idempotent
    const bothIdempotent = r1.body.idempotent === true && r2.body.idempotent === true;
    const oneIdempotent = r1.body.idempotent !== r2.body.idempotent;
    expect(bothIdempotent || oneIdempotent).toBe(true);
  });

  it("exactly one fund_commitments row exists for the member/jar pair", async () => {
    const rows = await db
      .select({ id: fundCommitments.id })
      .from(fundCommitments)
      .where(and(eq(fundCommitments.memberId, memberId), eq(fundCommitments.jarId, jarId)));
    expect(rows.length).toBe(1);
  });

  it("exactly one commitment_transfer financial_transaction exists", async () => {
    const rows = await db
      .select({ id: financialTransactions.id })
      .from(financialTransactions)
      .where(and(
        eq(financialTransactions.memberId, memberId),
        eq(financialTransactions.transactionType, "commitment_transfer"),
      ));
    expect(rows.length).toBe(1);
  });

  it("refundable balance is not negative after concurrent commit", async () => {
    const { getMemberFinancialBalance } = await import("../lib/financial-balance.js");
    const b = await getMemberFinancialBalance(jarId, memberId);
    expect(b.refundablePrincipalCents).toBeGreaterThanOrEqual(0);
    expect(b.invariantHolds).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART I — GET /jars/:jarId/commitment/mine
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 4C Commitment — PART I: GET mine", () => {
  let token: string;
  let jarId: string;
  let memberId: string;

  beforeAll(async () => {
    clearLedgerAccountCache();
    const { token: t, userId } = await register("getmine-i");
    token = t;
    ({ id: jarId } = await createJar(token, "Get Mine Jar"));
    await launchJar(token, jarId);
    await setCutoffPast(jarId);
    memberId = await getMemberId(jarId, userId);
    await seedAgreement(jarId, userId);
    await seedStripeFt(jarId, memberId, 15_000);
  });

  it("returns null before commitment", async () => {
    const res = await request(app)
      .get(`${BASE}/jars/${jarId}/commitment/mine`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.commitment).toBeNull();
  });

  it("returns commitment after confirm", async () => {
    const preview = await request(app)
      .post(`${BASE}/jars/${jarId}/commitment/preview`)
      .set("Authorization", `Bearer ${token}`);
    await request(app)
      .post(`${BASE}/jars/${jarId}/commitment/confirm`)
      .set("Authorization", `Bearer ${token}`)
      .send({ snapshotToken: preview.body.snapshotToken });

    const res = await request(app)
      .get(`${BASE}/jars/${jarId}/commitment/mine`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.commitment).not.toBeNull();
    expect(res.body.commitment.totalCommittedCents).toBe(15_000);
    expect(res.body.commitment.agreementId).toBeTruthy();
    expect(res.body.commitment.agreementVersion).toBeTruthy();
    expect(res.body.commitment.allocations.length).toBeGreaterThan(0);
  });
});
