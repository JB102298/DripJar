/**
 * FIFO Lot Allocation Helper — Phase 4C
 *
 * Computes the remaining refundable/committable amount for each Stripe
 * contribution PaymentIntent (a "lot") for a specific member in a jar.
 *
 * FIFO ordering: lots are returned oldest-first (by financialTransaction.createdAt).
 * The caller greedily fills from the oldest lot first, moving to newer lots when
 * a lot is exhausted.
 *
 * A lot's remaining amount = requestedPrincipalCents
 *   − sum(commitment_allocations.allocatedCents WHERE sourceFtId = lot.id)
 *   − sum(refund_allocations.allocatedCents WHERE sourceFtId = lot.id
 *         AND providerStatus NOT IN ('failed', 'cancelled'))
 *
 * Simulated contributions (providerType IS NULL or providerStatus ≠ 'succeeded')
 * are excluded — only real Stripe contributions are refundable/committable.
 */

import { db } from "@workspace/db";
import {
  financialTransactions,
  commitmentAllocations,
  refundAllocations,
} from "@workspace/db";
import { eq, and, inArray, sql, asc, notInArray } from "drizzle-orm";

export interface RefundableLot {
  /** The source financial_transaction ID (used in allocation rows). */
  ftId: string;
  /** The Stripe PaymentIntent ID — used to call stripe.refunds.create. */
  providerTransactionId: string;
  /** Full principal of this contribution lot. */
  principalCents: number;
  /** Amount not yet committed or reserved (= committable and refundable). */
  remainingCents: number;
  currency: string;
}

/**
 * Return all Stripe contribution lots for the member with remaining > 0,
 * ordered FIFO (oldest first).
 */
export async function getRefundableLots(
  jarId: string,
  memberId: string,
): Promise<RefundableLot[]> {
  // 1. Load all succeeded Stripe contribution FTs for this member
  const lots = await db
    .select({
      id: financialTransactions.id,
      providerTransactionId: financialTransactions.providerTransactionId,
      principalCents: financialTransactions.requestedPrincipalCents,
      currency: financialTransactions.currency,
      createdAt: financialTransactions.createdAt,
    })
    .from(financialTransactions)
    .where(
      and(
        eq(financialTransactions.jarId, jarId),
        eq(financialTransactions.memberId, memberId),
        eq(financialTransactions.transactionType, "contribution"),
        eq(financialTransactions.providerType, "stripe"),
        eq(financialTransactions.providerStatus, "succeeded"),
        eq(financialTransactions.ledgerPostingStatus, "posted"),
      ),
    )
    .orderBy(asc(financialTransactions.createdAt));

  if (lots.length === 0) return [];

  const lotIds = lots.map((l) => l.id);

  // 2. Sum committed amounts per source FT
  const committedRows = await db
    .select({
      sourceFtId: commitmentAllocations.sourceFtId,
      total: sql<string>`coalesce(sum(${commitmentAllocations.allocatedCents}), 0)`,
    })
    .from(commitmentAllocations)
    .where(inArray(commitmentAllocations.sourceFtId, lotIds))
    .groupBy(commitmentAllocations.sourceFtId);

  const committedMap = new Map(committedRows.map((r) => [r.sourceFtId, Number(r.total)]));

  // 3. Sum reserved/pending refund amounts per source FT
  //    Exclude failed/cancelled allocations (their reservation was reversed).
  const reservedRows = await db
    .select({
      sourceFtId: refundAllocations.sourceFtId,
      total: sql<string>`coalesce(sum(${refundAllocations.allocatedCents}), 0)`,
    })
    .from(refundAllocations)
    .where(
      and(
        inArray(refundAllocations.sourceFtId, lotIds),
        notInArray(refundAllocations.providerStatus, ["failed", "cancelled"]),
      ),
    )
    .groupBy(refundAllocations.sourceFtId);

  const reservedMap = new Map(reservedRows.map((r) => [r.sourceFtId, Number(r.total)]));

  // 4. Compute remaining per lot and filter to lots with remaining > 0
  const result: RefundableLot[] = [];
  for (const lot of lots) {
    const committed = committedMap.get(lot.id) ?? 0;
    const reserved = reservedMap.get(lot.id) ?? 0;
    const remaining = Number(lot.principalCents) - committed - reserved;
    if (remaining > 0 && lot.providerTransactionId) {
      result.push({
        ftId: lot.id,
        providerTransactionId: lot.providerTransactionId,
        principalCents: Number(lot.principalCents),
        remainingCents: remaining,
        currency: lot.currency,
      });
    }
  }

  return result;
}

/**
 * Greedily allocate `amountCents` from the provided FIFO lots.
 * Returns one allocation per lot used (in FIFO order).
 * Throws if the lots cannot cover the requested amount.
 */
export function allocateFromLots(
  lots: RefundableLot[],
  amountCents: number,
): Array<{ ftId: string; providerTransactionId: string; allocatedCents: number; currency: string }> {
  if (amountCents <= 0) throw new Error("amountCents must be positive");

  const allocations: Array<{ ftId: string; providerTransactionId: string; allocatedCents: number; currency: string }> = [];
  let remaining = amountCents;

  for (const lot of lots) {
    if (remaining <= 0) break;
    const take = Math.min(lot.remainingCents, remaining);
    allocations.push({
      ftId: lot.ftId,
      providerTransactionId: lot.providerTransactionId,
      allocatedCents: take,
      currency: lot.currency,
    });
    remaining -= take;
  }

  if (remaining > 0) {
    throw new Error(
      `Insufficient refundable principal: requested=${amountCents}¢ shortfall=${remaining}¢`,
    );
  }

  return allocations;
}
