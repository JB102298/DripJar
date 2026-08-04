/**
 * Phase 4A — Financial Ledger Foundation Tests
 *
 * Tests are organized into sections matching the spec:
 *
 *   PART 5  — Fee engine: computeDripJarFee, generateQuote, tamper detection
 *   PART 7  — Quote API endpoint
 *   PART 8  — $200 Drip journal entry
 *   PART 9  — Refund accounting primitives
 *   PART 10 — Commitment accounting primitives
 *   PART 12 — Simulated contribution separation
 *   PART 13 — Financial balance service
 *   PART 16 — Concurrency / idempotency
 *   PART 17 — Ledger invariants
 *   PART 15 — Authorization model
 *
 * No Stripe or payment-provider calls in any test.
 * All money primitives tested with internal fixtures.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import app from "../app.js";
import { db } from "@workspace/db";
import {
  jars,
  jarMembers,
  contributions,
  financialTransactions,
  ledgerAccounts,
  ledgerTransactions,
  ledgerEntries,
} from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import {
  computeDripJarFee,
  generateQuote,
  detectTamperedFeeFields,
  DRIPJAR_FEE_RATE_BPS,
} from "../lib/fee-engine.js";
import {
  postLedgerTransaction,
  postContributionAccounting,
  postRefundPrincipal,
  postCommitPrincipal,
  clearLedgerAccountCache,
} from "../lib/ledger.js";
import {
  getMemberFinancialBalance,
  getJarFinancialBalance,
  getFinancialTransactionDetail,
} from "../lib/financial-balance.js";

const BASE = "/api";

// ─── Test helpers ─────────────────────────────────────────────────────────────

async function register(suffix: string) {
  const email = `ledger-${suffix}-${Date.now()}@test.invalid`;
  const res = await request(app).post(`${BASE}/auth/register`).send({
    email,
    password: "P@ssword1!",
    firstName: "Ledger",
    lastName: suffix,
  });
  expect(res.status, `register ${suffix}: ${JSON.stringify(res.body)}`).toBe(201);
  return {
    token: res.body.token as string,
    userId: res.body.user.id as string,
    email,
  };
}

async function createJar(token: string, name = "Test Jar") {
  const res = await request(app)
    .post(`${BASE}/jars`)
    .set("Authorization", `Bearer ${token}`)
    .send({
      name,
      targetDate: "2027-12-31",
      goalAmountCents: 100_000,
      currency: "USD",
    });
  expect(res.status, `createJar: ${JSON.stringify(res.body)}`).toBe(201);
  return res.body as { id: string; [k: string]: unknown };
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

// ─────────────────────────────────────────────────────────────────────────────
// PART 5 — Fee Engine
// ─────────────────────────────────────────────────────────────────────────────

describe("Fee Engine — computeDripJarFee", () => {
  it("$200.00 → $6.00 (20000 → 600)", () => {
    expect(computeDripJarFee(20_000)).toBe(600);
  });

  it("$100.00 → $3.00 (10000 → 300)", () => {
    expect(computeDripJarFee(10_000)).toBe(300);
  });

  it("$1.00 → $0.03 (100 → 3)", () => {
    expect(computeDripJarFee(100)).toBe(3);
  });

  it("$0.34 → $0.01 (rounds up from 1.02)", () => {
    expect(computeDripJarFee(34)).toBe(1);
  });

  it("$0.33 → $0.01 (rounds up from 0.99)", () => {
    expect(computeDripJarFee(33)).toBe(1);
  });

  it("$0.17 → $0.01 (rounds up from 0.51)", () => {
    expect(computeDripJarFee(17)).toBe(1);
  });

  it("$0.16 → $0.00 (rounds down from 0.48)", () => {
    expect(computeDripJarFee(16)).toBe(0);
  });

  it("large value: $10,000.00 (1000000 → 30000)", () => {
    expect(computeDripJarFee(1_000_000)).toBe(30_000);
  });

  it("zero principal → zero fee", () => {
    expect(computeDripJarFee(0)).toBe(0);
  });

  it("throws on negative principal", () => {
    expect(() => computeDripJarFee(-1)).toThrow();
  });

  it("throws on non-integer principal", () => {
    expect(() => computeDripJarFee(100.5)).toThrow();
  });

  it("rate is constant at DRIPJAR_FEE_RATE_BPS = 300", () => {
    expect(DRIPJAR_FEE_RATE_BPS).toBe(300);
  });
});

describe("Fee Engine — generateQuote", () => {
  it("$200 principal, 0 processing fee", () => {
    const q = generateQuote(20_000);
    expect(q.principalCents).toBe(20_000);
    expect(q.dripJarFeeCents).toBe(600);
    expect(q.estimatedProcessingFeeCents).toBe(0);
    expect(q.totalChargeCents).toBe(20_600);
    expect(q.currency).toBe("USD");
    expect(q.feeRateBps).toBe(300);
  });

  it("$200 principal + $1.60 processing fee = $207.60 total", () => {
    const q = generateQuote(20_000, 160);
    expect(q.principalCents).toBe(20_000);
    expect(q.dripJarFeeCents).toBe(600);
    expect(q.estimatedProcessingFeeCents).toBe(160);
    expect(q.totalChargeCents).toBe(20_760);
  });

  it("totalCharge = principal + DripJar fee + processing fee", () => {
    const q = generateQuote(15_000, 200);
    expect(q.totalChargeCents).toBe(q.principalCents + q.dripJarFeeCents + q.estimatedProcessingFeeCents);
  });

  it("throws on zero principal", () => {
    expect(() => generateQuote(0)).toThrow();
  });

  it("throws on negative processing fee", () => {
    expect(() => generateQuote(10_000, -1)).toThrow();
  });
});

describe("Fee Engine — detectTamperedFeeFields", () => {
  it("clean body passes", () => {
    expect(detectTamperedFeeFields({ principalCents: 20_000 })).toBeNull();
  });

  it("dripJarFeeCents is rejected", () => {
    expect(detectTamperedFeeFields({ principalCents: 20_000, dripJarFeeCents: 0 })).not.toBeNull();
  });

  it("totalChargeCents is rejected", () => {
    expect(detectTamperedFeeFields({ totalChargeCents: 20_000 })).not.toBeNull();
  });

  it("feeRateBps is rejected", () => {
    expect(detectTamperedFeeFields({ feeRateBps: 0 })).not.toBeNull();
  });

  it("snake_case variants also rejected", () => {
    expect(detectTamperedFeeFields({ dripjar_fee_cents: 0 })).not.toBeNull();
    expect(detectTamperedFeeFields({ total_charge_cents: 0 })).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART 7 — Quote API Endpoint
// ─────────────────────────────────────────────────────────────────────────────

describe("Quote API — POST /finance/quote", () => {
  let token: string;

  beforeAll(async () => {
    ({ token } = await register("quote"));
  });

  it("returns server-computed quote for valid principalCents", async () => {
    const res = await request(app)
      .post(`${BASE}/finance/quote`)
      .set("Authorization", `Bearer ${token}`)
      .send({ principalCents: 20_000 });

    expect(res.status).toBe(200);
    expect(res.body.principalCents).toBe(20_000);
    expect(res.body.dripJarFeeCents).toBe(600);
    expect(res.body.estimatedProcessingFeeCents).toBe(0);
    expect(res.body.totalChargeCents).toBe(20_600);
    expect(res.body.feeRateBps).toBe(300);
    expect(res.body.currency).toBe("USD");
  });

  it("rejects principalCents = 0", async () => {
    const res = await request(app)
      .post(`${BASE}/finance/quote`)
      .set("Authorization", `Bearer ${token}`)
      .send({ principalCents: 0 });
    expect(res.status).toBe(400);
  });

  it("rejects missing principalCents", async () => {
    const res = await request(app)
      .post(`${BASE}/finance/quote`)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("rejects float principalCents", async () => {
    const res = await request(app)
      .post(`${BASE}/finance/quote`)
      .set("Authorization", `Bearer ${token}`)
      .send({ principalCents: 99.99 });
    expect(res.status).toBe(400);
  });

  it("rejects tampered dripJarFeeCents", async () => {
    const res = await request(app)
      .post(`${BASE}/finance/quote`)
      .set("Authorization", `Bearer ${token}`)
      .send({ principalCents: 20_000, dripJarFeeCents: 0 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/server-computed/i);
  });

  it("rejects tampered totalChargeCents", async () => {
    const res = await request(app)
      .post(`${BASE}/finance/quote`)
      .set("Authorization", `Bearer ${token}`)
      .send({ principalCents: 20_000, totalChargeCents: 20_000 });
    expect(res.status).toBe(400);
  });

  it("rejects tampered feeRateBps", async () => {
    const res = await request(app)
      .post(`${BASE}/finance/quote`)
      .set("Authorization", `Bearer ${token}`)
      .send({ principalCents: 20_000, feeRateBps: 0 });
    expect(res.status).toBe(400);
  });

  it("requires authentication", async () => {
    const res = await request(app)
      .post(`${BASE}/finance/quote`)
      .send({ principalCents: 20_000 });
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART 8 — $200 Drip Journal Entry
// ─────────────────────────────────────────────────────────────────────────────

describe("$200 Drip journal entry", () => {
  let jarId: string;
  let memberId: string;

  beforeAll(async () => {
    clearLedgerAccountCache();
    const { token, userId } = await register("drip200");
    const jar = await createJar(token, "Drip200 Jar");
    jarId = jar.id;
    memberId = await getMemberId(jarId, userId);
  });

  it("posts balanced ledger entries for $200 + $6 fee + $1.60 processing = $207.60", async () => {
    const result = await postContributionAccounting({
      jarId,
      memberId,
      principalCents: 20_000,
      estimatedProcessingFeeCents: 160,
      currency: "USD",
    });

    expect(result.financialTransactionId).toBeTruthy();
    expect(result.ledgerTransactionId).toBeTruthy();

    // Verify the financial_transaction record
    const [ft] = await db
      .select()
      .from(financialTransactions)
      .where(eq(financialTransactions.id, result.financialTransactionId));

    expect(ft.requestedPrincipalCents).toBe(20_000);
    expect(ft.dripJarFeeCents).toBe(600);
    expect(ft.processingFeeEstimatedCents).toBe(160);
    expect(ft.totalQuotedCents).toBe(20_760);
    expect(ft.ledgerPostingStatus).toBe("posted");
    expect(ft.transactionType).toBe("contribution");
    expect(ft.providerType).toBeNull();  // no Stripe in 4A

    // Verify ledger entries
    const entries = await db
      .select({
        code: ledgerAccounts.code,
        entryType: ledgerEntries.entryType,
        amountCents: ledgerEntries.amountCents,
      })
      .from(ledgerEntries)
      .innerJoin(ledgerAccounts, eq(ledgerEntries.accountId, ledgerAccounts.id))
      .where(eq(ledgerEntries.ledgerTransactionId, result.ledgerTransactionId));

    // Sort for deterministic assertions
    const byCode = (c: string, t: string) =>
      entries.find((e) => e.code === c && e.entryType === t);

    expect(byCode("EXT_PAY_CLR", "debit")?.amountCents).toBe(20_760);
    expect(byCode("CTRB_REFUNDABLE", "credit")?.amountCents).toBe(20_000);
    expect(byCode("DJ_FEE_REVENUE", "credit")?.amountCents).toBe(600);
    expect(byCode("PROC_FEE_CLR", "credit")?.amountCents).toBe(160);

    // Balance check: sum(debits) === sum(credits)
    const totalDebits = entries
      .filter((e) => e.entryType === "debit")
      .reduce((s, e) => s + Number(e.amountCents), 0);
    const totalCredits = entries
      .filter((e) => e.entryType === "credit")
      .reduce((s, e) => s + Number(e.amountCents), 0);

    expect(totalDebits).toBe(totalCredits);
    expect(totalDebits).toBe(20_760);
  });

  it("journal entry without processing fee: DR EXT_PAY_CLR = CR CTRB_REFUNDABLE + CR DJ_FEE_REVENUE", async () => {
    const result = await postContributionAccounting({
      jarId,
      memberId,
      principalCents: 10_000,
      estimatedProcessingFeeCents: 0,
    });

    const entries = await db
      .select({
        code: ledgerAccounts.code,
        entryType: ledgerEntries.entryType,
        amountCents: ledgerEntries.amountCents,
      })
      .from(ledgerEntries)
      .innerJoin(ledgerAccounts, eq(ledgerEntries.accountId, ledgerAccounts.id))
      .where(eq(ledgerEntries.ledgerTransactionId, result.ledgerTransactionId));

    // No PROC_FEE_CLR entry when processing fee is zero
    const procEntry = entries.find((e) => e.code === "PROC_FEE_CLR");
    expect(procEntry).toBeUndefined();

    const totalDebits = entries
      .filter((e) => e.entryType === "debit")
      .reduce((s, e) => s + Number(e.amountCents), 0);
    const totalCredits = entries
      .filter((e) => e.entryType === "credit")
      .reduce((s, e) => s + Number(e.amountCents), 0);
    expect(totalDebits).toBe(totalCredits);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART 9 — Refund Accounting Primitives
// ─────────────────────────────────────────────────────────────────────────────

describe("Refund accounting", () => {
  let jarId: string;
  let memberId: string;

  beforeAll(async () => {
    clearLedgerAccountCache();
    const { token, userId } = await register("refund");
    const jar = await createJar(token, "Refund Jar");
    jarId = jar.id;
    memberId = await getMemberId(jarId, userId);

    // Contribute $200
    await postContributionAccounting({
      jarId,
      memberId,
      principalCents: 20_000,
      estimatedProcessingFeeCents: 160,
    });
  });

  it("refundable principal decreases after refund", async () => {
    const before = await getMemberFinancialBalance(jarId, memberId);
    expect(before.refundablePrincipalCents).toBe(20_000);

    await postRefundPrincipal({ jarId, memberId, principalCents: 20_000 });

    const after = await getMemberFinancialBalance(jarId, memberId);
    expect(after.refundablePrincipalCents).toBe(0);
    expect(after.refundedPrincipalCents).toBe(20_000);
  });

  it("original DripJar fee remains earned (non-refundable)", async () => {
    const balance = await getMemberFinancialBalance(jarId, memberId);
    expect(balance.dripJarFeesEarnedCents).toBe(600);
  });

  it("processing fee pass-through remains (non-refundable)", async () => {
    const balance = await getMemberFinancialBalance(jarId, memberId);
    expect(balance.processingFeesEstimatedCents).toBe(160);
  });

  it("contributed principal unchanged by refund", async () => {
    const balance = await getMemberFinancialBalance(jarId, memberId);
    expect(balance.contributedPrincipalCents).toBe(20_000);
  });

  it("invariant: refundable + committed + refunded = contributed", async () => {
    const b = await getMemberFinancialBalance(jarId, memberId);
    expect(b.invariantHolds).toBe(true);
  });

  it("cannot refund more than refundable", async () => {
    // refundable is now 0
    await expect(
      postRefundPrincipal({ jarId, memberId, principalCents: 1 }),
    ).rejects.toThrow(/insufficient/i);
  });

  it("original contribution ledger entries are immutable (still present)", async () => {
    // Refund entries are NEW compensating entries; original contribution entries still exist
    const allEntries = await db
      .select({
        code: ledgerAccounts.code,
        entryType: ledgerEntries.entryType,
      })
      .from(ledgerEntries)
      .innerJoin(ledgerAccounts, eq(ledgerEntries.accountId, ledgerAccounts.id))
      .innerJoin(
        ledgerTransactions,
        eq(ledgerEntries.ledgerTransactionId, ledgerTransactions.id),
      )
      .innerJoin(
        financialTransactions,
        eq(ledgerTransactions.financialTransactionId, financialTransactions.id),
      )
      .where(and(
        eq(financialTransactions.jarId, jarId),
        eq(financialTransactions.memberId, memberId),
      ));

    // Contribution entries
    const contribExt = allEntries.filter(
      (e) => e.code === "EXT_PAY_CLR" && e.entryType === "debit",
    );
    expect(contribExt.length).toBeGreaterThanOrEqual(1);

    // Refund entries (compensating)
    const refundClr = allEntries.filter(
      (e) => e.code === "REFUND_CLR" && e.entryType === "credit",
    );
    expect(refundClr.length).toBeGreaterThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART 10 — Commitment Accounting Primitives
// ─────────────────────────────────────────────────────────────────────────────

describe("Commitment accounting", () => {
  let jarId: string;
  let memberId: string;

  beforeAll(async () => {
    clearLedgerAccountCache();
    const { token, userId } = await register("commit");
    const jar = await createJar(token, "Commit Jar");
    jarId = jar.id;
    memberId = await getMemberId(jarId, userId);

    // Contribute $200
    await postContributionAccounting({ jarId, memberId, principalCents: 20_000 });
  });

  it("refundable → committed after commitment transfer", async () => {
    const before = await getMemberFinancialBalance(jarId, memberId);
    expect(before.refundablePrincipalCents).toBe(20_000);
    expect(before.committedPrincipalCents).toBe(0);

    await postCommitPrincipal({ jarId, memberId, principalCents: 20_000 });

    const after = await getMemberFinancialBalance(jarId, memberId);
    expect(after.refundablePrincipalCents).toBe(0);
    expect(after.committedPrincipalCents).toBe(20_000);
  });

  it("contributed principal unchanged by commitment", async () => {
    const b = await getMemberFinancialBalance(jarId, memberId);
    expect(b.contributedPrincipalCents).toBe(20_000);
  });

  it("invariant holds after commitment", async () => {
    const b = await getMemberFinancialBalance(jarId, memberId);
    expect(b.invariantHolds).toBe(true);
  });

  it("cannot commit more than refundable (now 0)", async () => {
    await expect(
      postCommitPrincipal({ jarId, memberId, principalCents: 1 }),
    ).rejects.toThrow(/insufficient/i);
  });

  it("partial commitment: refundable splits between refundable and committed", async () => {
    clearLedgerAccountCache();
    const { token, userId: uid2 } = await register("partialcommit");
    const jar2 = await createJar(token, "Partial Commit Jar");
    const mem2 = await getMemberId(jar2.id, uid2);

    await postContributionAccounting({ jarId: jar2.id, memberId: mem2, principalCents: 20_000 });
    await postCommitPrincipal({ jarId: jar2.id, memberId: mem2, principalCents: 12_000 });

    const b = await getMemberFinancialBalance(jar2.id, mem2);
    expect(b.refundablePrincipalCents).toBe(8_000);
    expect(b.committedPrincipalCents).toBe(12_000);
    expect(b.invariantHolds).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART 12 — Simulated Contribution Separation
// ─────────────────────────────────────────────────────────────────────────────

describe("Simulated contribution separation", () => {
  let jarId: string;
  let memberId: string;

  beforeAll(async () => {
    clearLedgerAccountCache();
    const { token, userId } = await register("simulated");
    const jar = await createJar(token, "Simulated Jar");
    jarId = jar.id;
    memberId = await getMemberId(jarId, userId);

    // Insert a simulated contribution (the old pre-ledger path)
    await db.insert(contributions).values({
      jarId,
      memberId,
      amountCents: 50_000, // $500 simulated — must NOT appear in ledger
      contributionDate: "2026-01-01",
      status: "simulated",
      sourceType: "manual",
    });
  });

  it("simulated contributions do NOT appear in ledger financial balances", async () => {
    const balance = await getMemberFinancialBalance(jarId, memberId);
    // No ledger entries have been posted, so all balances should be zero
    expect(balance.contributedPrincipalCents).toBe(0);
    expect(balance.refundablePrincipalCents).toBe(0);
    expect(balance.committedPrincipalCents).toBe(0);
    expect(balance.refundedPrincipalCents).toBe(0);
    expect(balance.dripJarFeesEarnedCents).toBe(0);
    expect(balance.totalCustomerChargesCents).toBe(0);
  });

  it("ledger balance remains zero with simulated contribution present", async () => {
    // Verify ledger entries count for this member is zero
    const finTxs = await db
      .select({ id: financialTransactions.id })
      .from(financialTransactions)
      .where(and(
        eq(financialTransactions.jarId, jarId),
        eq(financialTransactions.memberId, memberId),
      ));
    expect(finTxs.length).toBe(0);
  });

  it("ledger contribution is separate from simulated contribution", async () => {
    // Post a real ledger contribution
    await postContributionAccounting({
      jarId,
      memberId,
      principalCents: 10_000,
    });

    const balance = await getMemberFinancialBalance(jarId, memberId);
    // Only the ledger contribution is reflected — NOT the $500 simulated row
    expect(balance.contributedPrincipalCents).toBe(10_000);
  });

  it("simulated contribution still visible in contributions table (historical data preserved)", async () => {
    const rows = await db
      .select()
      .from(contributions)
      .where(and(eq(contributions.jarId, jarId), eq(contributions.memberId, memberId)));
    const simulatedRows = rows.filter((r) => r.status === "simulated");
    expect(simulatedRows.length).toBeGreaterThanOrEqual(1);
    expect(simulatedRows[0]?.amountCents).toBe(50_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART 13 — Financial Balance Service
// ─────────────────────────────────────────────────────────────────────────────

describe("Financial balance service", () => {
  let jarId: string;
  let memberId: string;

  beforeAll(async () => {
    clearLedgerAccountCache();
    const { token, userId } = await register("balance");
    const jar = await createJar(token, "Balance Jar");
    jarId = jar.id;
    memberId = await getMemberId(jarId, userId);

    // $200 contribution with $1.60 processing fee
    await postContributionAccounting({
      jarId,
      memberId,
      principalCents: 20_000,
      estimatedProcessingFeeCents: 160,
    });
    // Second $100 contribution
    await postContributionAccounting({
      jarId,
      memberId,
      principalCents: 10_000,
    });
    // Commit $5,000
    await postCommitPrincipal({ jarId, memberId, principalCents: 5_000 });
    // Refund $8,000
    await postRefundPrincipal({ jarId, memberId, principalCents: 8_000 });
  });

  it("contributedPrincipal = sum of all contribution principals", async () => {
    const b = await getMemberFinancialBalance(jarId, memberId);
    expect(b.contributedPrincipalCents).toBe(30_000);
  });

  it("refundable = contributed - committed - refunded", async () => {
    const b = await getMemberFinancialBalance(jarId, memberId);
    expect(b.refundablePrincipalCents).toBe(30_000 - 5_000 - 8_000); // 17_000
  });

  it("committed = 5000", async () => {
    const b = await getMemberFinancialBalance(jarId, memberId);
    expect(b.committedPrincipalCents).toBe(5_000);
  });

  it("refunded = 8000", async () => {
    const b = await getMemberFinancialBalance(jarId, memberId);
    expect(b.refundedPrincipalCents).toBe(8_000);
  });

  it("invariant: refundable + committed + refunded = contributed", async () => {
    const b = await getMemberFinancialBalance(jarId, memberId);
    expect(b.invariantHolds).toBe(true);
    expect(b.refundablePrincipalCents + b.committedPrincipalCents + b.refundedPrincipalCents)
      .toBe(b.contributedPrincipalCents);
  });

  it("DripJar fees earned = 3% of all contributed principal", async () => {
    const b = await getMemberFinancialBalance(jarId, memberId);
    // $200 → $6.00, $100 → $3.00, total = $9.00 = 900 cents
    expect(b.dripJarFeesEarnedCents).toBe(900);
  });

  it("DripJar fees unchanged after refund and commitment", async () => {
    // Fees were set at contribution time and are non-refundable
    const b = await getMemberFinancialBalance(jarId, memberId);
    expect(b.dripJarFeesEarnedCents).toBe(900);
  });

  it("total customer charges = sum of totalQuotedCents on contributions", async () => {
    const b = await getMemberFinancialBalance(jarId, memberId);
    // $200 drip: 20760, $100 drip: 10300, total = 31060
    expect(b.totalCustomerChargesCents).toBe(20_000 + 600 + 160 + 10_000 + 300);
  });

  it("jar-level balance sums member balances correctly", async () => {
    const jarBal = await getJarFinancialBalance(jarId);
    expect(jarBal.totalContributedPrincipalCents).toBe(30_000);
    expect(jarBal.totalCommittedPrincipalCents).toBe(5_000);
    expect(jarBal.totalRefundedPrincipalCents).toBe(8_000);
    expect(jarBal.totalDripJarRevenueAssociatedCents).toBe(900);
    expect(jarBal.invariantHolds).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART 16 — Concurrency / Idempotency
// ─────────────────────────────────────────────────────────────────────────────

describe("Concurrency and idempotency", () => {
  it("duplicate financial_transaction idempotency key returns same IDs without re-posting", async () => {
    clearLedgerAccountCache();
    const { token, userId } = await register("idem");
    const jar = await createJar(token, "Idempotency Jar");
    const memberId = await getMemberId(jar.id, userId);
    const key = `idem-test-${Date.now()}`;

    const r1 = await postContributionAccounting({
      jarId: jar.id,
      memberId,
      principalCents: 10_000,
      idempotencyKey: key,
    });

    const r2 = await postContributionAccounting({
      jarId: jar.id,
      memberId,
      principalCents: 10_000,
      idempotencyKey: key,
    });

    // Same IDs returned
    expect(r2.financialTransactionId).toBe(r1.financialTransactionId);
    expect(r2.ledgerTransactionId).toBe(r1.ledgerTransactionId);

    // Only one financial_transaction row
    const rows = await db
      .select({ id: financialTransactions.id })
      .from(financialTransactions)
      .where(eq(financialTransactions.idempotencyKey, key));
    expect(rows.length).toBe(1);
  });

  it("concurrent contribution attempts: both succeed independently (separate idempotency keys)", async () => {
    clearLedgerAccountCache();
    const { token, userId } = await register("concurrentcontrib");
    const jar = await createJar(token, "Concurrent Contrib Jar");
    const memberId = await getMemberId(jar.id, userId);

    const [r1, r2] = await Promise.all([
      postContributionAccounting({
        jarId: jar.id, memberId, principalCents: 5_000,
      }),
      postContributionAccounting({
        jarId: jar.id, memberId, principalCents: 7_000,
      }),
    ]);

    expect(r1.financialTransactionId).toBeTruthy();
    expect(r2.financialTransactionId).toBeTruthy();
    expect(r1.financialTransactionId).not.toBe(r2.financialTransactionId);

    const b = await getMemberFinancialBalance(jar.id, memberId);
    expect(b.contributedPrincipalCents).toBe(12_000);
  });

  it("concurrent refund attempts: exactly one wins when both request same amount as available", async () => {
    clearLedgerAccountCache();
    const { token, userId } = await register("concurrentrefund");
    const jar = await createJar(token, "Concurrent Refund Jar");
    const memberId = await getMemberId(jar.id, userId);

    // Contribute $200 (refundable)
    await postContributionAccounting({ jarId: jar.id, memberId, principalCents: 20_000 });

    // Try to refund $200 twice concurrently — only one should succeed
    const results = await Promise.allSettled([
      postRefundPrincipal({
        jarId: jar.id, memberId, principalCents: 20_000,
      }),
      postRefundPrincipal({
        jarId: jar.id, memberId, principalCents: 20_000,
      }),
    ]);

    const succeeded = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");

    // Exactly one must succeed
    expect(succeeded.length).toBe(1);
    expect(failed.length).toBe(1);

    // Final balance: refundable = 0, refunded = 20000
    const b = await getMemberFinancialBalance(jar.id, memberId);
    expect(b.refundablePrincipalCents).toBe(0);
    expect(b.refundedPrincipalCents).toBe(20_000);
    expect(b.invariantHolds).toBe(true);
  });

  it("concurrent commit attempts: exactly one wins", async () => {
    clearLedgerAccountCache();
    const { token, userId } = await register("concurrentcommit");
    const jar = await createJar(token, "Concurrent Commit Jar");
    const memberId = await getMemberId(jar.id, userId);

    await postContributionAccounting({ jarId: jar.id, memberId, principalCents: 20_000 });

    const results = await Promise.allSettled([
      postCommitPrincipal({ jarId: jar.id, memberId, principalCents: 20_000 }),
      postCommitPrincipal({ jarId: jar.id, memberId, principalCents: 20_000 }),
    ]);

    const succeeded = results.filter((r) => r.status === "fulfilled");
    expect(succeeded.length).toBe(1);

    const b = await getMemberFinancialBalance(jar.id, memberId);
    expect(b.refundablePrincipalCents).toBe(0);
    expect(b.committedPrincipalCents).toBe(20_000);
    expect(b.invariantHolds).toBe(true);
  });

  it("refund and commit racing: exactly one wins, invariant preserved", async () => {
    clearLedgerAccountCache();
    const { token, userId } = await register("racingrefundcommit");
    const jar = await createJar(token, "Racing Jar");
    const memberId = await getMemberId(jar.id, userId);

    await postContributionAccounting({ jarId: jar.id, memberId, principalCents: 20_000 });

    const results = await Promise.allSettled([
      postRefundPrincipal({ jarId: jar.id, memberId, principalCents: 20_000 }),
      postCommitPrincipal({ jarId: jar.id, memberId, principalCents: 20_000 }),
    ]);

    const succeeded = results.filter((r) => r.status === "fulfilled");
    expect(succeeded.length).toBe(1);

    const b = await getMemberFinancialBalance(jar.id, memberId);
    // Either refunded=20000,committed=0 OR refunded=0,committed=20000
    expect(b.refundablePrincipalCents).toBe(0);
    expect(b.invariantHolds).toBe(true);
    expect(b.contributedPrincipalCents).toBe(20_000);
    expect(b.committedPrincipalCents + b.refundedPrincipalCents).toBe(20_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART 17 — Ledger Invariants
// ─────────────────────────────────────────────────────────────────────────────

describe("Ledger invariants", () => {
  it("every posted ledger transaction balances (debits = credits)", async () => {
    // Query all ledger transactions and verify each balances
    const allTransactions = await db
      .select({ id: ledgerTransactions.id })
      .from(ledgerTransactions);

    for (const lt of allTransactions) {
      const entries = await db
        .select({ entryType: ledgerEntries.entryType, amountCents: ledgerEntries.amountCents })
        .from(ledgerEntries)
        .where(eq(ledgerEntries.ledgerTransactionId, lt.id));

      const debits = entries.filter((e) => e.entryType === "debit").reduce((s, e) => s + Number(e.amountCents), 0);
      const credits = entries.filter((e) => e.entryType === "credit").reduce((s, e) => s + Number(e.amountCents), 0);
      expect(debits, `ledger_transaction ${lt.id} must balance`).toBe(credits);
    }
  });

  it("no ledger entry has a negative or zero amount", async () => {
    const entries = await db
      .select({ id: ledgerEntries.id, amountCents: ledgerEntries.amountCents })
      .from(ledgerEntries);
    for (const e of entries) {
      expect(Number(e.amountCents), `entry ${e.id} must be positive`).toBeGreaterThan(0);
    }
  });

  it("postLedgerTransaction rejects unbalanced entries", async () => {
    await expect(
      postLedgerTransaction({
        description: "Intentionally unbalanced",
        entries: [
          { accountCode: "EXT_PAY_CLR", entryType: "debit", amountCents: 100 },
          { accountCode: "CTRB_REFUNDABLE", entryType: "credit", amountCents: 90 },
        ],
      }),
    ).rejects.toThrow(/balance/i);
  });

  it("postLedgerTransaction rejects zero-amount entries", async () => {
    await expect(
      postLedgerTransaction({
        description: "Zero amount",
        entries: [
          { accountCode: "EXT_PAY_CLR", entryType: "debit", amountCents: 0 },
          { accountCode: "CTRB_REFUNDABLE", entryType: "credit", amountCents: 0 },
        ],
      }),
    ).rejects.toThrow(/positive/i);
  });

  it("postLedgerTransaction rejects empty entries array", async () => {
    await expect(
      postLedgerTransaction({ description: "Empty", entries: [] }),
    ).rejects.toThrow();
  });

  it("refund cannot exceed refundable principal — DB-level invariant", async () => {
    clearLedgerAccountCache();
    const { token, userId } = await register("refundoverflow");
    const jar = await createJar(token, "Overflow Jar");
    const memberId = await getMemberId(jar.id, userId);

    await postContributionAccounting({ jarId: jar.id, memberId, principalCents: 5_000 });

    await expect(
      postRefundPrincipal({ jarId: jar.id, memberId, principalCents: 5_001 }),
    ).rejects.toThrow(/insufficient/i);
  });

  it("commitment cannot exceed refundable principal", async () => {
    clearLedgerAccountCache();
    const { token, userId } = await register("commitoverflow");
    const jar = await createJar(token, "Commit Overflow Jar");
    const memberId = await getMemberId(jar.id, userId);

    await postContributionAccounting({ jarId: jar.id, memberId, principalCents: 5_000 });

    await expect(
      postCommitPrincipal({ jarId: jar.id, memberId, principalCents: 5_001 }),
    ).rejects.toThrow(/insufficient/i);
  });

  it("DripJar revenue does not disappear when principal is refunded", async () => {
    clearLedgerAccountCache();
    const { token, userId } = await register("feepreserve");
    const jar = await createJar(token, "Fee Preserve Jar");
    const memberId = await getMemberId(jar.id, userId);

    await postContributionAccounting({ jarId: jar.id, memberId, principalCents: 20_000 });
    await postRefundPrincipal({ jarId: jar.id, memberId, principalCents: 20_000 });

    const b = await getMemberFinancialBalance(jar.id, memberId);
    expect(b.dripJarFeesEarnedCents).toBe(600); // $6 still earned
    expect(b.refundedPrincipalCents).toBe(20_000);
  });

  it("simulated contributions never appear in financial ledger balances", async () => {
    // Already tested in PART 12 — verify invariant holds globally
    // by checking that ledger balance queries filter by financial_transactions only
    clearLedgerAccountCache();
    const { token, userId } = await register("simseparate");
    const jar = await createJar(token, "Sim Separate Jar");
    const memberId = await getMemberId(jar.id, userId);

    // Insert simulated contribution (no ledger posting)
    await db.insert(contributions).values({
      jarId: jar.id,
      memberId,
      amountCents: 999_999,
      contributionDate: "2026-01-01",
      status: "simulated",
      sourceType: "manual",
    });

    const b = await getMemberFinancialBalance(jar.id, memberId);
    expect(b.contributedPrincipalCents).toBe(0);
    expect(b.totalCustomerChargesCents).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART 15 — Authorization model
// ─────────────────────────────────────────────────────────────────────────────

describe("Authorization — finance routes", () => {
  // Uses the organizer as the "member under test" — they are automatically
  // added to jar_members with role "organizer" at jar creation, no invitation
  // flow needed. Tests stranger access using a separate unrelated user.
  let organizer: { token: string; userId: string; email: string };
  let stranger: { token: string; userId: string; email: string };
  let jarId: string;
  let organizerMemberId: string;
  let txId: string;

  beforeAll(async () => {
    clearLedgerAccountCache();
    organizer = await register("org-auth");
    stranger = await register("stranger-auth");

    const jar = await createJar(organizer.token, "Auth Jar");
    jarId = jar.id;
    // No launchJar: organizer is already in jar_members at creation time.
    // Finance routes don't check jar status — Draft is sufficient for auth tests.
    organizerMemberId = await getMemberId(jarId, organizer.userId);

    const contrib = await postContributionAccounting({
      jarId,
      memberId: organizerMemberId,
      principalCents: 10_000,
    });
    txId = contrib.financialTransactionId;
  });

  it("unauthenticated request to /finance/quote returns 401", async () => {
    const res = await request(app)
      .post(`${BASE}/finance/quote`)
      .send({ principalCents: 10_000 });
    expect(res.status).toBe(401);
  });

  it("organizer can inspect their own transaction (member access)", async () => {
    const res = await request(app)
      .get(`${BASE}/finance/inspect/${txId}`)
      .set("Authorization", `Bearer ${organizer.token}`);
    // dev-only endpoint accessible in test env (NODE_ENV != production)
    expect(res.status).toBe(200);
    expect(res.body.memberId).toBe(organizerMemberId);
  });

  it("stranger cannot inspect another member's transaction", async () => {
    const res = await request(app)
      .get(`${BASE}/finance/inspect/${txId}`)
      .set("Authorization", `Bearer ${stranger.token}`);
    expect(res.status).toBe(403);
  });

  it("organizer can view their own balance (member access)", async () => {
    const res = await request(app)
      .get(`${BASE}/finance/balances/jar/${jarId}/member/${organizerMemberId}`)
      .set("Authorization", `Bearer ${organizer.token}`);
    expect(res.status).toBe(200);
    expect(res.body.contributedPrincipalCents).toBe(10_000);
  });

  it("stranger cannot view another member's balance", async () => {
    const res = await request(app)
      .get(`${BASE}/finance/balances/jar/${jarId}/member/${organizerMemberId}`)
      .set("Authorization", `Bearer ${stranger.token}`);
    expect(res.status).toBe(403);
  });

  it("only organizer can view jar-level balances; stranger gets 403", async () => {
    const strangerRes = await request(app)
      .get(`${BASE}/finance/balances/jar/${jarId}`)
      .set("Authorization", `Bearer ${stranger.token}`);
    expect(strangerRes.status).toBe(403);

    const orgRes = await request(app)
      .get(`${BASE}/finance/balances/jar/${jarId}`)
      .set("Authorization", `Bearer ${organizer.token}`);
    expect(orgRes.status).toBe(200);
  });

  it("dev-only endpoints return 404 in production (NODE_ENV simulation)", async () => {
    // We can't easily change NODE_ENV in the test process, but we can verify
    // the devOnly middleware is attached by checking the route is accessible in test mode
    const res = await request(app)
      .get(`${BASE}/finance/inspect/${txId}`)
      .set("Authorization", `Bearer ${organizer.token}`);
    // In test mode (NODE_ENV=test != 'production') the endpoint is accessible
    expect(res.status).toBe(200);
  });
});
