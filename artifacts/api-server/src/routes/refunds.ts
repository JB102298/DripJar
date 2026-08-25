/**
 * Refund Routes — Phase 4C
 *
 * Endpoints:
 *   GET  /jars/:jarId/refunds/preview        — FIFO lot preview (no state change)
 *   POST /jars/:jarId/refunds                — create refund request + reservation
 *   GET  /jars/:jarId/refunds/:refundId      — fetch one refund request
 *   POST /internal/dispatch-refunds          — internal: dispatch pending allocations to Stripe
 *
 * Refunds apply to REFUNDABLE principal only (not committed principal).
 * Fees (DripJar fee + processing fee) are NOT refunded — business rules F, G.
 * Only Stripe-backed contributions are eligible; simulated contributions are excluded.
 *
 * Security:
 *   - Client never supplies lot IDs, PI IDs, or ledger accounts.
 *   - amountCents is validated against the server-derived refundable balance.
 *   - Stripe refund calls use stable idempotency keys (dripjar-refund:<allocationId>).
 *   - dispatch-refunds is protected by INTERNAL_REMINDER_TOKEN (same mechanism as reminders).
 */

import { Router } from "express";
import { db } from "@workspace/db";
import {
  jars,
  jarMembers,
  financialTransactions,
  refundRequests,
  refundAllocations,
} from "@workspace/db";
import { eq, and, isNull } from "drizzle-orm";
import { timingSafeEqual } from "node:crypto";
import { requireAuth, type AuthenticatedRequest } from "../lib/auth.js";
import { computeRefundableBalanceInTx } from "../lib/ledger.js";
import { postRefundReservationInTx } from "../lib/ledger.js";
import { getRefundableLots, allocateFromLots } from "../lib/lot-allocation.js";
import { getStripeClient } from "../lib/stripe.js";
import { logActivity } from "../lib/activity.js";
import { logger } from "../lib/logger.js";
import { mapStripeRefundStatus, recomputeRefundRequestStatus } from "../lib/refund-helpers.js";

const router = Router();

/**
 * Resolve the caller's membership row for refund purposes.
 *
 * Deliberately does NOT require `status = "active"`.
 *
 * Both refund endpoints used to demand an active membership, which meant a
 * member who left the jar — or whose membership was marked inactive by an
 * organizer — lost access to principal they had already paid in and never
 * committed. Leaving a jar is not a forfeiture of your own money.
 *
 * This is authorization tied to *historical* membership: the caller must have a
 * `jar_members` row for this jar, in any state. That row is also what scopes
 * `getRefundableLots`, which only ever returns financial transactions carrying
 * this member id — so a former member can reach exactly their own lots and an
 * outsider, having no row at all, is refused before any balance is computed.
 *
 * The gate is membership history, never jar lifecycle.
 */
async function resolveRefundMember(
  jarId: string,
  userId: string,
): Promise<{ id: string } | null> {
  const [member] = await db
    .select({ id: jarMembers.id })
    .from(jarMembers)
    .where(and(eq(jarMembers.jarId, jarId), eq(jarMembers.userId, userId)))
    .limit(1);
  return member ?? null;
}

type DbOrTx = typeof db;

// ─── Internal token guard (same pattern as reminders) ─────────────────────────

function requireInternalToken(
  req: import("express").Request,
  res: import("express").Response,
  next: import("express").NextFunction,
) {
  const configuredToken = process.env["INTERNAL_REMINDER_TOKEN"];
  if (!configuredToken) {
    (res as any).status(503).json({
      error: "ServiceUnavailable",
      message: "INTERNAL_REMINDER_TOKEN is not configured",
    });
    return;
  }

  const provided = req.headers["x-internal-token"];
  if (typeof provided !== "string") {
    (res as any).status(403).json({ error: "Forbidden", message: "Invalid internal token" });
    return;
  }

  // Constant-time comparison to prevent timing attacks
  const configBuffer = Buffer.from(configuredToken, "utf8");
  const providedBuffer = Buffer.from(provided, "utf8");
  const valid =
    configBuffer.length === providedBuffer.length &&
    timingSafeEqual(configBuffer, providedBuffer);

  if (!valid) {
    (res as any).status(403).json({ error: "Forbidden", message: "Invalid internal token" });
    return;
  }

  next();
}

// ─── GET /jars/:jarId/refunds/preview ─────────────────────────────────────────

router.get("/jars/:jarId/refunds/preview", requireAuth, async (req, res) => {
  const userId = (req as unknown as AuthenticatedRequest).userId;
  const { jarId } = req.params as { jarId: string };
  const rawAmount = req.query["amountCents"];

  const [jar] = await db.select({ id: jars.id, status: jars.status, currency: jars.currency })
    .from(jars).where(eq(jars.id, jarId)).limit(1);
  if (!jar) {
    res.status(404).json({ error: "NotFound", message: "Jar not found" });
    return;
  }

  const member = await resolveRefundMember(jarId, userId);
  if (!member) {
    res.status(403).json({ error: "Forbidden", message: "Access denied" });
    return;
  }

  const lots = await getRefundableLots(jarId, member.id);
  const refundableCents = lots.reduce((s, l) => s + l.remainingCents, 0);

  let requestedCents: number;
  if (rawAmount === undefined || rawAmount === null) {
    requestedCents = refundableCents;
  } else {
    const parsed = Number(rawAmount);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      res.status(400).json({ error: "BadRequest", message: "amountCents must be a positive integer" });
      return;
    }
    requestedCents = parsed;
  }

  if (requestedCents <= 0) {
    res.json({
      refundableCents,
      requestedCents,
      allocations: [],
      note: "No refundable Stripe principal available.",
    });
    return;
  }

  if (requestedCents > refundableCents) {
    res.status(422).json({
      error: "InsufficientBalance",
      message: `Requested ${requestedCents}¢ exceeds refundable balance of ${refundableCents}¢`,
      refundableCents,
      requestedCents,
    });
    return;
  }

  let allocations: Array<{ ftId: string; providerTransactionId: string; allocatedCents: number; currency: string }>;
  try {
    allocations = allocateFromLots(lots, requestedCents);
  } catch (err) {
    res.status(422).json({ error: "InsufficientBalance", message: (err as Error).message });
    return;
  }

  res.json({
    refundableCents,
    requestedCents,
    currency: jar.currency,
    allocations: allocations.map((a) => ({
      sourceFtId: a.ftId,
      allocatedCents: a.allocatedCents,
    })),
    note: "Fees (DripJar 3% + processing) are non-refundable. Timing depends on your payment provider (typically 5–10 business days).",
  });
});

// ─── POST /jars/:jarId/refunds ─────────────────────────────────────────────────

router.post("/jars/:jarId/refunds", requireAuth, async (req, res) => {
  const userId = (req as unknown as AuthenticatedRequest).userId;
  const { jarId } = req.params as { jarId: string };
  const { amountCents, reason } = req.body as { amountCents?: unknown; reason?: unknown };

  if (!Number.isInteger(amountCents) || (amountCents as number) <= 0) {
    res.status(400).json({ error: "BadRequest", message: "amountCents must be a positive integer" });
    return;
  }
  const requestedCents = amountCents as number;

  const [jar] = await db
    .select({ id: jars.id, status: jars.status, currency: jars.currency, cutoffDate: jars.cutoffDate })
    .from(jars).where(eq(jars.id, jarId)).limit(1);
  if (!jar) {
    res.status(404).json({ error: "NotFound", message: "Jar not found" });
    return;
  }

  // NO JAR-STATUS GATE. Refundability is not a function of the jar's lifecycle.
  //
  // This route used to require `jar.status === "Saving"`, which meant cancelling
  // a jar silently stranded every member's uncommitted principal — while
  // `GET /refunds/preview`, which has never had that gate, went on showing them
  // the balance they could no longer withdraw. Uncommitted principal belongs to
  // the member who paid it until that member explicitly commits it. A phase
  // label must never convert uncommitted principal into committed principal.
  //
  // The only authority on what may be released is `getRefundableLots`, shared
  // with the preview below, so the two cannot disagree.

  const member = await resolveRefundMember(jarId, userId);
  if (!member) {
    res.status(403).json({ error: "Forbidden", message: "Access denied" });
    return;
  }

  // FIFO lot query to find which lots to refund from — the same canonical
  // calculation the preview endpoint uses.
  const lots = await getRefundableLots(jarId, member.id);
  const refundableCents = lots.reduce((s, l) => s + l.remainingCents, 0);

  if (refundableCents <= 0) {
    res.status(422).json({
      error: "NoRefundableBalance",
      message: "You have no uncommitted principal available to refund in this jar.",
      refundableCents: 0,
    });
    return;
  }

  if (requestedCents > refundableCents) {
    res.status(422).json({
      error: "InsufficientBalance",
      message: `Requested ${requestedCents}¢ exceeds refundable balance of ${refundableCents}¢`,
      refundableCents,
    });
    return;
  }

  let allocationPlan: Array<{ ftId: string; providerTransactionId: string; allocatedCents: number; currency: string }>;
  try {
    allocationPlan = allocateFromLots(lots, requestedCents);
  } catch (err) {
    res.status(422).json({ error: "InsufficientBalance", message: (err as Error).message });
    return;
  }

  let refundRequestId: string;

  try {
    await db.transaction(async (tx) => {
      const txDb = tx as unknown as DbOrTx;

      // Lock member row to serialize concurrent refund/commit operations
      const [locked] = await txDb
        .select({ id: jarMembers.id })
        .from(jarMembers)
        .where(eq(jarMembers.id, member.id))
        .for("update");
      if (!locked) throw new Error("Member not found");

      // Re-verify refundable balance within the locked transaction
      const currentRefundable = await computeRefundableBalanceInTx(txDb, jarId, member.id);
      if (currentRefundable < requestedCents) {
        throw new Error(
          `Insufficient refundable balance: available=${currentRefundable}¢ requested=${requestedCents}¢`,
        );
      }

      // Post refund reservation (CTRB_REFUNDABLE DR / REFUND_PENDING CR)
      const { financialTransactionId: reservationFtId } = await postRefundReservationInTx(txDb, {
        jarId,
        memberId: member.id,
        amountCents: requestedCents,
        currency: jar.currency,
        idempotencyKey: `refund-reservation-${member.id}-${jarId}-${Date.now()}`,
      });

      // Insert refund_request
      const [rr] = await txDb
        .insert(refundRequests)
        .values({
          jarId,
          memberId: member.id,
          requestedCents,
          status: "pending_provider",
          reservationFtId,
          reason: typeof reason === "string" ? reason : null,
        })
        .returning({ id: refundRequests.id });

      if (!rr) throw new Error("Failed to insert refund_request");
      refundRequestId = rr.id;

      // Insert refund_allocations (one per FIFO lot)
      await txDb.insert(refundAllocations).values(
        allocationPlan.map((a) => ({
          refundRequestId: rr.id,
          sourceFtId: a.ftId,
          allocatedCents: a.allocatedCents,
          providerStatus: "pending",
          stripeRefundId: null,
          finalizationFtId: null,
        })),
      );
    });
  } catch (err) {
    const message = (err as Error).message;
    logger.error({ err: { message }, jarId, memberId: member.id }, "Refund request creation failed");
    if (message.startsWith("Insufficient")) {
      res.status(409).json({ error: "InsufficientBalance", message });
    } else {
      res.status(500).json({ error: "InternalError", message: "Failed to create refund request" });
    }
    return;
  }

  // Fire-and-forget activity log
  void logActivity({
    jarId,
    userId,
    eventType: "refund_requested",
    description: `Member requested refund of ${(requestedCents / 100).toFixed(2)} ${jar.currency}`,
    amountCents: requestedCents,
    metadata: { refundRequestId: refundRequestId! },
  });

  // Load the created refund request + allocations
  const allocs = await db
    .select({ id: refundAllocations.id, sourceFtId: refundAllocations.sourceFtId, allocatedCents: refundAllocations.allocatedCents, providerStatus: refundAllocations.providerStatus })
    .from(refundAllocations)
    .where(eq(refundAllocations.refundRequestId, refundRequestId!));

  res.status(201).json({
    refundRequestId: refundRequestId!,
    status: "pending_provider",
    requestedCents,
    currency: jar.currency,
    allocations: allocs.map((a) => ({
      id: a.id,
      sourceFtId: a.sourceFtId,
      allocatedCents: a.allocatedCents,
      providerStatus: a.providerStatus,
    })),
    note: "Your refund request has been received. Timing depends on your payment provider (typically 5–10 business days).",
  });
});

// ─── GET /jars/:jarId/refunds/:refundId ───────────────────────────────────────

router.get("/jars/:jarId/refunds/:refundId", requireAuth, async (req, res) => {
  const userId = (req as unknown as AuthenticatedRequest).userId;
  const { jarId, refundId } = req.params as { jarId: string; refundId: string };

  const [jar] = await db.select({ id: jars.id, organizerId: jars.organizerId })
    .from(jars).where(eq(jars.id, jarId)).limit(1);
  if (!jar) {
    res.status(404).json({ error: "NotFound", message: "Jar not found" });
    return;
  }

  const [member] = await db
    .select({ id: jarMembers.id })
    .from(jarMembers)
    .where(and(eq(jarMembers.jarId, jarId), eq(jarMembers.userId, userId)))
    .limit(1);

  const isOrganizer = jar.organizerId === userId;
  if (!member && !isOrganizer) {
    res.status(403).json({ error: "Forbidden", message: "Access denied" });
    return;
  }

  const [rr] = await db
    .select()
    .from(refundRequests)
    .where(and(eq(refundRequests.id, refundId), eq(refundRequests.jarId, jarId)))
    .limit(1);

  if (!rr) {
    res.status(404).json({ error: "NotFound", message: "Refund request not found" });
    return;
  }

  // Members can only view their own refund requests (organizers see all)
  if (!isOrganizer && member && rr.memberId !== member.id) {
    res.status(403).json({ error: "Forbidden", message: "Access denied" });
    return;
  }

  const allocs = await db
    .select()
    .from(refundAllocations)
    .where(eq(refundAllocations.refundRequestId, refundId));

  res.json({
    id: rr.id,
    jarId: rr.jarId,
    memberId: rr.memberId,
    requestedCents: rr.requestedCents,
    status: rr.status,
    reason: rr.reason,
    createdAt: rr.createdAt,
    updatedAt: rr.updatedAt,
    allocations: allocs.map((a) => ({
      id: a.id,
      sourceFtId: a.sourceFtId,
      allocatedCents: a.allocatedCents,
      providerStatus: a.providerStatus,
      stripeRefundId: a.stripeRefundId,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    })),
  });
});

// ─── POST /internal/dispatch-refunds ─────────────────────────────────────────
//
// Internal dispatcher: finds refund_allocations with providerStatus='pending'
// and stripeRefundId IS NULL, then calls Stripe to initiate each refund.
//
// Idempotency: stable idempotency key `dripjar-refund:<allocationId>` ensures
// that re-running the dispatcher on a crash never creates a second provider
// refund for the same allocation.
//
// No scheduler is wired in Phase 4C; tests call this endpoint directly.
// IMPORTANT: A production cron job calling this endpoint (authenticated with
// INTERNAL_REMINDER_TOKEN) is a pre-go-live prerequisite before enabling live
// Stripe refunds. Phase 4C remains in TEST MODE until that scheduler is in place.

router.post("/internal/dispatch-refunds", requireInternalToken, async (_req, res) => {
  const stats = {
    dispatched: 0,
    alreadyDispatched: 0,
    failed: 0,
    errors: [] as string[],
    runAt: new Date().toISOString(),
  };

  // Find all pending allocations (stripeRefundId IS NULL, status='pending')
  const pendingAllocs = await db
    .select({
      id: refundAllocations.id,
      refundRequestId: refundAllocations.refundRequestId,
      sourceFtId: refundAllocations.sourceFtId,
      allocatedCents: refundAllocations.allocatedCents,
      providerStatus: refundAllocations.providerStatus,
      stripeRefundId: refundAllocations.stripeRefundId,
    })
    .from(refundAllocations)
    .where(
      and(
        eq(refundAllocations.providerStatus, "pending"),
        isNull(refundAllocations.stripeRefundId),
      ),
    );

  if (pendingAllocs.length === 0) {
    res.json({ ...stats, message: "No pending allocations to dispatch" });
    return;
  }

  const stripe = getStripeClient();

  for (const alloc of pendingAllocs) {
    try {
      // Load source FT to get the providerTransactionId (Stripe PI ID)
      const [sourceFt] = await db
        .select({
          providerTransactionId: financialTransactions.providerTransactionId,
          currency: financialTransactions.currency,
        })
        .from(financialTransactions)
        .where(eq(financialTransactions.id, alloc.sourceFtId))
        .limit(1);

      if (!sourceFt?.providerTransactionId) {
        logger.warn({ allocationId: alloc.id }, "Dispatch: source FT has no providerTransactionId — skipping");
        stats.failed += 1;
        stats.errors.push(`alloc:${alloc.id} — source FT has no providerTransactionId`);
        continue;
      }

      // Call Stripe refunds API with stable idempotency key
      // Same key on retry → same Refund object → no second provider charge
      const refund = await stripe.refunds.create(
        {
          payment_intent: sourceFt.providerTransactionId,
          amount: Number(alloc.allocatedCents),
          reason: "requested_by_customer",
        },
        { idempotencyKey: `dripjar-refund:${alloc.id}` },
      );

      // Update allocation with Stripe refund ID
      const internalStatus = mapStripeRefundStatus(refund.status ?? "pending") ?? "pending";

      await db.transaction(async (tx) => {
        const txDb = tx as unknown as DbOrTx;

        await txDb
          .update(refundAllocations)
          .set({
            stripeRefundId: refund.id,
            providerStatus: internalStatus,
            updatedAt: new Date(),
          })
          .where(eq(refundAllocations.id, alloc.id));

        // Mark parent request as 'processing'
        await txDb
          .update(refundRequests)
          .set({ status: "processing", updatedAt: new Date() })
          .where(eq(refundRequests.id, alloc.refundRequestId));
      });

      stats.dispatched += 1;
      logger.info(
        { allocationId: alloc.id, stripeRefundId: refund.id, status: internalStatus },
        "Refund dispatched",
      );
    } catch (err) {
      const message = (err as Error).message;
      stats.failed += 1;
      stats.errors.push(`alloc:${alloc.id} — ${message}`);
      logger.error({ err: { message }, allocationId: alloc.id }, "Dispatch: Stripe refund creation failed");
    }
  }

  res.json(stats);
});

export default router;
