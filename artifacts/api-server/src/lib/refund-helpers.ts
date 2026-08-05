/**
 * Shared Refund Helpers — Phase 4C
 *
 * Used by both the refunds route and the stripe-webhooks route.
 * Kept in a lib file to avoid cross-route imports.
 */

import { db } from "@workspace/db";
import { refundAllocations } from "@workspace/db";
import { eq } from "drizzle-orm";

type DbOrTx = typeof db;

// ─── Stripe status mapper ─────────────────────────────────────────────────────
//
// Maps raw Stripe refund status strings to internal domain values.
// Stripe uses "canceled" (one l); we use "cancelled" (two l's).
// Unknown statuses return null — caller must handle safely without state mutation.

export function mapStripeRefundStatus(stripeStatus: string): string | null {
  const map: Record<string, string> = {
    pending: "pending",
    requires_action: "requires_action",
    succeeded: "succeeded",
    failed: "failed",
    canceled: "cancelled", // Stripe one-l → internal two-l
  };
  return map[stripeStatus] ?? null;
}

// ─── Aggregate status recomputation ──────────────────────────────────────────

/**
 * Recompute the aggregate status of a refund_request from its allocations.
 * Called after any allocation status change.
 *
 * Status rules:
 *   - All succeeded                           → 'completed'
 *   - All terminal; some succeeded            → 'partially_failed'
 *   - All terminal; all cancelled             → 'cancelled'
 *   - All terminal; all failed/cancelled      → 'failed'
 *   - Any still in-flight                     → 'processing'
 */
export async function recomputeRefundRequestStatus(
  refundRequestId: string,
  txDb: DbOrTx = db,
): Promise<string> {
  const allocs = await txDb
    .select({ providerStatus: refundAllocations.providerStatus })
    .from(refundAllocations)
    .where(eq(refundAllocations.refundRequestId, refundRequestId));

  if (allocs.length === 0) return "pending_provider";

  const statuses = allocs.map((a) => a.providerStatus);
  const allSucceeded = statuses.every((s) => s === "succeeded");
  const allTerminal = statuses.every((s) => ["succeeded", "failed", "cancelled"].includes(s));
  const anySucceeded = statuses.some((s) => s === "succeeded");
  const allCancelled = statuses.every((s) => s === "cancelled");

  if (allSucceeded) return "completed";
  if (allTerminal && anySucceeded) return "partially_failed";
  if (allTerminal && allCancelled) return "cancelled";
  if (allTerminal) return "failed";
  return "processing";
}

/** Terminal allocation states — no regression allowed once reached. */
export const TERMINAL_ALLOCATION_STATES = new Set(["succeeded", "failed", "cancelled"]);
