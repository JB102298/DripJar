/**
 * Finance Routes — Phase 4A / 4B
 *
 * Public endpoints:
 *   POST /finance/quote            — server-authoritative contribution quote
 *                                    Phase 4B: accepts optional paymentMethodType
 *                                    to persist a quote with processing fee estimate
 *
 * Internal/dev-only endpoints (unavailable in production):
 *   GET  /finance/inspect/:txId    — full detail for a financial transaction
 *   GET  /finance/balances/jar/:jarId/member/:memberId — derived balances
 *   GET  /finance/balances/jar/:jarId                  — jar-level totals
 *
 * Authorization rules:
 *   - /finance/quote: any authenticated user
 *     Phase 4B: when paymentMethodType is provided, also requires jarId
 *   - /finance/inspect/:txId: auth + (own member transaction OR jar organizer)
 *   - /finance/balances/...: auth + (own memberId OR jar organizer)
 *   - Inspect/balance endpoints are dev-only (NODE_ENV !== 'production')
 *
 * Security boundaries enforced here:
 *   - Clients CANNOT supply fee components (dripJarFeeCents, totalChargeCents, etc.)
 *   - Clients CANNOT choose ledger accounts
 *   - Clients CANNOT post ledger entries directly
 *   - Clients CANNOT override the DripJar fee rate
 *   - Clients CANNOT supply estimatedProcessingFeeCents
 */

import { Router } from "express";
import { db } from "@workspace/db";
import { jars, jarMembers, financialTransactions } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../lib/auth.js";
import { generateQuote, detectTamperedFeeFields, DRIPJAR_FEE_RATE_BPS } from "../lib/fee-engine.js";
import {
  getMemberFinancialBalance,
  getJarFinancialBalance,
  getFinancialTransactionDetail,
} from "../lib/financial-balance.js";
import { computeGrossedUpProviderFee, type PaymentMethodType } from "../lib/provider-fees.js";

const router = Router();

// ─── Middleware: dev-only guard ────────────────────────────────────────────────

function devOnly(
  req: Parameters<Router>[0],
  res: Parameters<Router>[1],
  next: Parameters<Router>[2],
) {
  if (process.env["NODE_ENV"] === "production") {
    (res as any).status(404).json({ error: "NotFound", message: "Not found" });
    return;
  }
  next();
}

// ─── POST /finance/quote ───────────────────────────────────────────────────────
//
// Generate a server-authoritative financial quote for a drip.
// The client supplies ONLY principalCents (+ optional jarId + paymentMethodType).
// All fee components are computed server-side.
//
// Phase 4B extension:
//   - Optional `paymentMethodType: 'us_bank_account' | 'card'`
//   - When provided, REQUIRES `jarId` to look up the member record
//   - Computes estimatedProcessingFeeCents via gross-up algorithm
//   - Persists a financial_transaction row (providerStatus='quoted', TTL=30min)
//   - Returns full quote + financialTransactionId + paymentMethodType
//
// Backward-compatible: omitting paymentMethodType returns a Phase 4A quote
// with estimatedProcessingFeeCents=0 and no persisted transaction.

router.post("/finance/quote", requireAuth, async (req, res) => {
  // Detect tampered fee fields before reading principalCents
  const tamper = detectTamperedFeeFields(req.body as Record<string, unknown>);
  if (tamper) {
    res.status(400).json({ error: "BadRequest", message: tamper });
    return;
  }

  const {
    principalCents,
    currency,
    paymentMethodType,
    jarId,
  } = req.body as {
    principalCents?: unknown;
    currency?: unknown;
    paymentMethodType?: unknown;
    jarId?: unknown;
  };

  if (
    !Number.isInteger(principalCents) ||
    (principalCents as number) < 1
  ) {
    res.status(400).json({
      error: "BadRequest",
      message: "principalCents must be a positive integer (minimum 1 cent)",
    });
    return;
  }

  if (currency !== undefined && typeof currency !== "string") {
    res.status(400).json({ error: "BadRequest", message: "currency must be a string" });
    return;
  }

  // Phase 4B: optional paymentMethodType
  const resolvedCurrency = (typeof currency === "string" ? currency : undefined) ?? "USD";

  if (paymentMethodType !== undefined) {
    // Validate paymentMethodType
    if (
      paymentMethodType !== "us_bank_account" &&
      paymentMethodType !== "card"
    ) {
      res.status(400).json({
        error: "BadRequest",
        message: "paymentMethodType must be 'us_bank_account' or 'card'",
      });
      return;
    }

    // jarId is required when paymentMethodType is provided (to look up member)
    if (typeof jarId !== "string" || !jarId.trim()) {
      res.status(400).json({
        error: "BadRequest",
        message: "jarId is required when paymentMethodType is provided",
      });
      return;
    }

    const userId = (req as unknown as AuthenticatedRequest).userId;

    // Verify jar exists
    const [jar] = await db
      .select({ id: jars.id })
      .from(jars)
      .where(eq(jars.id, jarId));

    if (!jar) {
      res.status(404).json({ error: "NotFound", message: "Jar not found" });
      return;
    }

    // Verify caller is an active member of the jar
    const [member] = await db
      .select({ id: jarMembers.id, status: jarMembers.status })
      .from(jarMembers)
      .where(and(eq(jarMembers.userId, userId), eq(jarMembers.jarId, jarId)));

    if (!member || member.status !== "active") {
      res.status(403).json({
        error: "Forbidden",
        message: "You must be an active member of this jar",
      });
      return;
    }

    // Compute the processing fee gross-up
    const principal = principalCents as number;
    const dripJarFeeCents = generateQuote(principal, 0, resolvedCurrency).dripJarFeeCents;
    const baseCents = principal + dripJarFeeCents;
    const estimatedProcessingFeeCents = computeGrossedUpProviderFee(
      baseCents,
      paymentMethodType as PaymentMethodType,
    );

    const quote = generateQuote(principal, estimatedProcessingFeeCents, resolvedCurrency);

    // Persist the quote as a financial_transaction (providerStatus='quoted')
    const quoteExpiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes from now
    const idempotencyKey = `quote-${userId}-${jarId}-${principal}-${paymentMethodType}-${Date.now()}`;

    const [ft] = await db
      .insert(financialTransactions)
      .values({
        jarId,
        memberId: member.id,
        transactionType: "contribution",
        currency: resolvedCurrency,
        requestedPrincipalCents: principal,
        dripJarFeeCents: quote.dripJarFeeCents,
        dripJarFeeRateBps: DRIPJAR_FEE_RATE_BPS,
        processingFeeEstimatedCents: estimatedProcessingFeeCents,
        processingFeeActualCents: null,
        totalQuotedCents: quote.totalChargeCents,
        providerType: "stripe",
        providerTransactionId: null,
        providerStatus: "quoted",
        quoteExpiresAt,
        paymentMethodCategory: paymentMethodType,
        ledgerPostingStatus: "pending",
        ledgerId: null,
        idempotencyKey,
      })
      .returning({ id: financialTransactions.id });

    if (!ft) {
      res.status(500).json({ error: "InternalError", message: "Failed to persist quote" });
      return;
    }

    res.json({
      ...quote,
      financialTransactionId: ft.id,
      paymentMethodType,
      quoteExpiresAt: quoteExpiresAt.toISOString(),
    });
    return;
  }

  // Phase 4A path: no paymentMethodType — backward-compatible
  try {
    const quote = generateQuote(
      principalCents as number,
      0,
      resolvedCurrency,
    );
    res.json(quote);
  } catch (err) {
    res.status(400).json({ error: "BadRequest", message: (err as Error).message });
  }
});

// ─── GET /finance/inspect/:txId ────────────────────────────────────────────────
//
// Internal dev-only: full detail view of a financial transaction.
// Requires auth + (own member OR jar organizer).

router.get("/finance/inspect/:txId", requireAuth, devOnly, async (req, res) => {
  const userId = (req as unknown as AuthenticatedRequest).userId;
  const { txId } = req.params as { txId: string };

  // Load the transaction to check authorization
  const [ft] = await db
    .select({
      id: financialTransactions.id,
      jarId: financialTransactions.jarId,
      memberId: financialTransactions.memberId,
    })
    .from(financialTransactions)
    .where(eq(financialTransactions.id, txId));

  if (!ft) {
    res.status(404).json({ error: "NotFound", message: "Financial transaction not found" });
    return;
  }

  // Check authorization: requester must be the contributing member OR jar organizer
  const [jar] = await db
    .select({ organizerId: jars.organizerId })
    .from(jars)
    .where(eq(jars.id, ft.jarId));

  const [member] = await db
    .select({ id: jarMembers.id })
    .from(jarMembers)
    .where(and(eq(jarMembers.id, ft.memberId), eq(jarMembers.userId, userId)));

  const isOrganizer = jar?.organizerId === userId;
  const isOwnMember = !!member;

  if (!isOrganizer && !isOwnMember) {
    res.status(403).json({ error: "Forbidden", message: "Access denied" });
    return;
  }

  const detail = await getFinancialTransactionDetail(txId);
  if (!detail) {
    res.status(404).json({ error: "NotFound", message: "Financial transaction not found" });
    return;
  }

  res.json(detail);
});

// ─── GET /finance/balances/jar/:jarId/member/:memberId ────────────────────────
//
// Internal dev-only: derived balance for one member in a jar.

router.get(
  "/finance/balances/jar/:jarId/member/:memberId",
  requireAuth,
  devOnly,
  async (req, res) => {
    const userId = (req as unknown as AuthenticatedRequest).userId;
    const { jarId, memberId } = req.params as { jarId: string; memberId: string };

    const [jar] = await db
      .select({ organizerId: jars.organizerId })
      .from(jars)
      .where(eq(jars.id, jarId));

    if (!jar) {
      res.status(404).json({ error: "NotFound", message: "Jar not found" });
      return;
    }

    // Auth: own member or organizer
    const [member] = await db
      .select({ id: jarMembers.id, userId: jarMembers.userId })
      .from(jarMembers)
      .where(and(eq(jarMembers.id, memberId), eq(jarMembers.jarId, jarId)));

    const isOrganizer = jar.organizerId === userId;
    const isOwnMember = member?.userId === userId;

    if (!isOrganizer && !isOwnMember) {
      res.status(403).json({ error: "Forbidden", message: "Access denied" });
      return;
    }

    const balance = await getMemberFinancialBalance(jarId, memberId);
    res.json(balance);
  },
);

// ─── GET /finance/balances/jar/:jarId ────────────────────────────────────────
//
// Internal dev-only: jar-level totals (organizer only).

router.get("/finance/balances/jar/:jarId", requireAuth, devOnly, async (req, res) => {
  const userId = (req as unknown as AuthenticatedRequest).userId;
  const { jarId } = req.params as { jarId: string };

  const [jar] = await db
    .select({ organizerId: jars.organizerId })
    .from(jars)
    .where(eq(jars.id, jarId));

  if (!jar) {
    res.status(404).json({ error: "NotFound", message: "Jar not found" });
    return;
  }

  if (jar.organizerId !== userId) {
    res.status(403).json({ error: "Forbidden", message: "Only the jar organizer can view jar-level balances" });
    return;
  }

  const balance = await getJarFinancialBalance(jarId);
  res.json(balance);
});

export default router;
