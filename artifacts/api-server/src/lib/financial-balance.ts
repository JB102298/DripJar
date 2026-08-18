/**
 * Financial Balance Service
 *
 * Derives all financial balances from immutable ledger entries.
 * NEVER trusts client-provided numbers or independently editable columns.
 *
 * Balance invariant verified by this service (Phase 4C):
 *
 *   lifetimeContributedPrincipalCents =
 *     refundablePrincipalCents        (CTRB_REFUNDABLE net — currently free to refund or commit)
 *   + committedPrincipalCents         (CTRB_COMMITTED — locked for payout)
 *   + refundPendingCents              (REFUND_PENDING net — reserved for in-flight refunds)
 *   + refundedPrincipalCents          (REFUND_CLR — completed refund outflows)
 *
 * This is a LIFETIME total, not a "currently held" total. Once principal is
 * refunded it moves from REFUND_PENDING to REFUND_CLR and is no longer
 * retained by the system, but it still counts toward lifetimeContributed.
 *
 * currentlyRetainedPrincipalCents = refundable + committed + refundPending
 *   (i.e. excludes refundedPrincipalCents which has left the system)
 *
 * The four-term invariant always holds because all ledger postings are
 * balanced and principal only moves between accounts — never created or
 * destroyed.
 *
 * Simulated contributions (contributions.status = 'simulated') are completely
 * separate from ledger-backed balances. This service queries ledger_entries
 * only — simulated rows never appear here.
 */

import { db } from "@workspace/db";
import {
  ledgerEntries,
  ledgerTransactions,
  ledgerAccounts,
  financialTransactions,
  jarMembers,
  contributions,
  refundAllocations,
} from "@workspace/db";
import { eq, ne, and, sql, inArray, notInArray } from "drizzle-orm";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MemberFinancialBalance {
  jarId: string;
  memberId: string;
  currency: string;

  /**
   * Lifetime contributed principal: the total principal ever successfully
   * contributed by this member to this jar. Equals the sum of all four
   * principal-account buckets:
   *   refundable + committed + refundPending + refunded
   * This value does NOT decrease when refunds are completed — refunded
   * principal moves from refundPending to refunded but the sum is unchanged.
   */
  contributedPrincipalCents: number;
  /** Currently refundable principal — eligible for a new refund or commitment. */
  refundablePrincipalCents: number;
  /** Principal reserved for in-flight Stripe refunds (REFUND_PENDING net). */
  refundPendingCents: number;
  /** Principal explicitly committed (locked for payout). */
  committedPrincipalCents: number;
  /** Principal returned to contributor via completed refund. */
  refundedPrincipalCents: number;

  /** DripJar 3% fees earned on this member's contributions. */
  dripJarFeesEarnedCents: number;
  /** Processing fee estimates recorded at contribution time. */
  processingFeesEstimatedCents: number;
  /** Actual provider fees (null until Phase 4B reconciliation). */
  processingFeesActualCents: number | null;

  /** Total amounts charged to the customer (EXT_PAY_CLR debits). */
  totalCustomerChargesCents: number;

  /**
   * Invariant check:
   *   refundable + refundPending + committed + refunded === contributedPrincipal
   */
  invariantHolds: boolean;
}

export interface JarFinancialBalance {
  jarId: string;
  currency: string;

  totalContributedPrincipalCents: number;
  totalRefundablePrincipalCents: number;
  totalRefundPendingCents: number;
  totalCommittedPrincipalCents: number;
  totalRefundedPrincipalCents: number;

  totalDripJarRevenueAssociatedCents: number;
  totalProcessingFeesEstimatedCents: number;
  totalCustomerChargesCents: number;

  memberBalances: MemberFinancialBalance[];
  invariantHolds: boolean;
}

// ─── Raw ledger aggregation query ─────────────────────────────────────────────

/**
 * Aggregate ledger entries by (account code, entry type) for a set of
 * financial transactions filtered by jarId + optional memberId.
 *
 * Returns a map: `${accountCode}:${entryType}` → total cents
 */
async function aggregateLedger(
  jarId: string,
  memberId?: string,
): Promise<Map<string, number>> {
  const rows = await db
    .select({
      code: ledgerAccounts.code,
      entryType: ledgerEntries.entryType,
      total: sql<string>`coalesce(sum(${ledgerEntries.amountCents}), 0)`,
    })
    .from(ledgerEntries)
    .innerJoin(
      ledgerTransactions,
      eq(ledgerEntries.ledgerTransactionId, ledgerTransactions.id),
    )
    .innerJoin(
      financialTransactions,
      and(
        eq(ledgerTransactions.financialTransactionId, financialTransactions.id),
        eq(financialTransactions.ledgerPostingStatus, "posted"),
        eq(financialTransactions.jarId, jarId),
        ...(memberId ? [eq(financialTransactions.memberId, memberId)] : []),
      ),
    )
    .innerJoin(
      ledgerAccounts,
      eq(ledgerEntries.accountId, ledgerAccounts.id),
    )
    .groupBy(ledgerAccounts.code, ledgerEntries.entryType);

  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(`${row.code}:${row.entryType}`, Number(row.total));
  }
  return map;
}

function get(map: Map<string, number>, code: string, direction: "debit" | "credit"): number {
  return map.get(`${code}:${direction}`) ?? 0;
}

function deriveFromLedger(
  jarId: string,
  memberId: string,
  currency: string,
  agg: Map<string, number>,
): MemberFinancialBalance {
  // Raw account movements
  const ctrbRefCr = get(agg, "CTRB_REFUNDABLE", "credit");  // contributions + reversals
  const ctrbRefDr = get(agg, "CTRB_REFUNDABLE", "debit");   // commitments + reservations + direct refunds
  const ctrbCommCr = get(agg, "CTRB_COMMITTED", "credit");   // commitments
  const refundPendCr = get(agg, "REFUND_PENDING", "credit"); // reservations created
  const refundPendDr = get(agg, "REFUND_PENDING", "debit");  // finalizations + reversals
  const refundClrCr = get(agg, "REFUND_CLR", "credit");      // completed refund outflows
  const djFeeCr = get(agg, "DJ_FEE_REVENUE", "credit");
  const procFeeCr = get(agg, "PROC_FEE_CLR", "credit");
  const extPayDr = get(agg, "EXT_PAY_CLR", "debit");

  // Net balances per account
  const refundablePrincipalCents = ctrbRefCr - ctrbRefDr;
  const refundPendingCents = refundPendCr - refundPendDr;
  const committedPrincipalCents = ctrbCommCr;
  const refundedPrincipalCents = refundClrCr;

  // lifetimeContributedPrincipalCents = refundable + committed + refundPending + refunded
  // This is a LIFETIME total. Refunded principal moves CTRB_REFUNDABLE→REFUND_PENDING→REFUND_CLR
  // but remains in the sum — it never leaves the four-term equation.
  // The formula holds across all Phase 4A/4B/4C posting patterns because all
  // ledger transactions are balanced and principal only moves between accounts.
  const contributedPrincipalCents =
    refundablePrincipalCents + refundPendingCents + committedPrincipalCents + refundedPrincipalCents;

  const invariantHolds =
    refundablePrincipalCents + refundPendingCents + committedPrincipalCents + refundedPrincipalCents ===
    contributedPrincipalCents;

  return {
    jarId,
    memberId,
    currency,
    contributedPrincipalCents,
    refundablePrincipalCents,
    refundPendingCents,
    committedPrincipalCents,
    refundedPrincipalCents,
    dripJarFeesEarnedCents: djFeeCr,
    processingFeesEstimatedCents: procFeeCr,
    processingFeesActualCents: null, // Phase 4B: populated from provider reconciliation
    totalCustomerChargesCents: extPayDr,
    invariantHolds,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Derive the financial balance for one member in one jar.
 * All values come from immutable ledger entries — never from mutable columns.
 */
export async function getMemberFinancialBalance(
  jarId: string,
  memberId: string,
  currency = "USD",
): Promise<MemberFinancialBalance> {
  const agg = await aggregateLedger(jarId, memberId);
  return deriveFromLedger(jarId, memberId, currency, agg);
}

/**
 * Derive financial balances for all members of a jar, plus jar-level totals.
 */
export async function getJarFinancialBalance(
  jarId: string,
  currency = "USD",
): Promise<JarFinancialBalance> {
  // Get all members of this jar
  const members = await db
    .select({ id: jarMembers.id })
    .from(jarMembers)
    .where(eq(jarMembers.jarId, jarId));

  const memberBalances = await Promise.all(
    members.map((m) => getMemberFinancialBalance(jarId, m.id, currency)),
  );

  const sum = (fn: (b: MemberFinancialBalance) => number): number =>
    memberBalances.reduce((acc, b) => acc + fn(b), 0);

  const totalRefundable = sum((b) => b.refundablePrincipalCents);
  const totalRefundPending = sum((b) => b.refundPendingCents);
  const totalCommitted = sum((b) => b.committedPrincipalCents);
  const totalRefunded = sum((b) => b.refundedPrincipalCents);
  const totalContributed = totalRefundable + totalRefundPending + totalCommitted + totalRefunded;

  return {
    jarId,
    currency,
    totalContributedPrincipalCents: totalContributed,
    totalRefundablePrincipalCents: totalRefundable,
    totalRefundPendingCents: totalRefundPending,
    totalCommittedPrincipalCents: totalCommitted,
    totalRefundedPrincipalCents: totalRefunded,
    totalDripJarRevenueAssociatedCents: sum((b) => b.dripJarFeesEarnedCents),
    totalProcessingFeesEstimatedCents: sum((b) => b.processingFeesEstimatedCents),
    totalCustomerChargesCents: sum((b) => b.totalCustomerChargesCents),
    memberBalances,
    invariantHolds:
      totalRefundable + totalRefundPending + totalCommitted + totalRefunded === totalContributed,
  };
}

// ─── Phase 4D: Jar-level principal breakdown ──────────────────────────────────

/**
 * Derive the jar-level principal breakdown for goal waterfall and progress display.
 *
 * savedPrincipalCents = refundable + committed
 *   — the canonical "currently saved" figure used for the Jar progress bar,
 *     goal waterfall allocation, and financial summary.
 *   — excludes refundPending, refunded, and all fee accounts.
 *
 * Uses a single ledger aggregation query.
 */
export async function getJarPrincipalBreakdown(jarId: string): Promise<{
  savedPrincipalCents: number;
  committedPrincipalCents: number;
  refundablePrincipalCents: number;
  refundPendingCents: number;
  refundedPrincipalCents: number;
}> {
  const agg = await aggregateLedger(jarId);
  const refundable = Math.max(0, get(agg, "CTRB_REFUNDABLE", "credit") - get(agg, "CTRB_REFUNDABLE", "debit"));
  const committed = get(agg, "CTRB_COMMITTED", "credit");
  const refundPending = Math.max(0, get(agg, "REFUND_PENDING", "credit") - get(agg, "REFUND_PENDING", "debit"));
  const refunded = get(agg, "REFUND_CLR", "credit");
  return {
    savedPrincipalCents: refundable + committed,
    committedPrincipalCents: committed,
    refundablePrincipalCents: refundable,
    refundPendingCents: refundPending,
    refundedPrincipalCents: refunded,
  };
}

/**
 * Get just the saved principal for a jar (refundable + committed).
 * Ledger-backed replacement for the contributions-table getTotalSaved function.
 * Used by Jar summary, health, and progress endpoints.
 */
export async function getJarSavedPrincipalCents(jarId: string): Promise<number> {
  const { savedPrincipalCents } = await getJarPrincipalBreakdown(jarId);
  return savedPrincipalCents;
}

// ─── Canonical progress surface ───────────────────────────────────────────────
//
// Home, Jar Detail, Members, Milestones, Goals, and schedule health must all
// show the same money. Before this section they did not: Jar Detail and Goals
// read the ledger through the helpers above, while Home, Members, Milestones,
// and the fully-funded check summed `contributions.amount_cents` under the
// filter `status IN ('completed','simulated')`.
//
// That filter is wrong in both directions. `completed` is never written to
// `contributions` by any code path — it is a dead value. `stripe_test`, which
// the Stripe webhook actually writes for settled money, is absent. So the
// legacy surfaces matched exactly one status, `simulated`, which by design has
// no ledger backing. Hawaii 2027 showed $7,274 on Home (entirely Test Mode)
// and $0 on Jar Overview (the ledger, correctly seeing no real money).
//
// PRINCIPAL IS NEVER INFERRED FROM `contributions.status`.
//
// A contribution row is a display record. The authority on money is the
// double-entry ledger. Everything below derives principal from the ledger, so
// an unanticipated status value cannot silently add or remove money.
// `contributions` is consulted for exactly two things it alone knows: the Test
// Mode figure, and the milestone tag on a payment.

/**
 * Transaction types that ORIGINATE principal.
 *
 * Every other type — commitment_transfer, refund, refund_reservation,
 * refund_finalization, refund_reversal — moves principal that already exists.
 * Mirrors the allowlist in routes/autodrip.ts; exported so there is one
 * definition rather than two that can drift.
 */
export const PRINCIPAL_ORIGIN_TRANSACTION_TYPES = [
  "contribution",
  "autodrip_contribution",
] as const;

/**
 * Refund allocation states that still hold principal away from the jar.
 *
 * 'failed' and 'cancelled' allocations had their reservation reversed, so that
 * principal returned to refundable and must NOT be subtracted. Pending,
 * requires_action, and succeeded are either in flight or gone; both are
 * excluded from saved principal, matching savedPrincipal = refundable +
 * committed.
 */
const REVERSED_REFUND_ALLOCATION_STATES = ["failed", "cancelled"] as const;

export interface JarProgressSummary {
  jarId: string;
  goalAmountCents: number;

  /** Canonical "currently saved" principal: refundable + committed. */
  savedPrincipalCents: number;
  committedPrincipalCents: number;
  refundablePrincipalCents: number;
  refundPendingCents: number;
  refundedPrincipalCents: number;

  /** savedPrincipalCents / goalAmountCents, capped at 100, one decimal place. */
  percentFunded: number;

  /**
   * Test Mode principal recorded outside the ledger. Reported separately so a
   * surface can disclose it; never part of savedPrincipalCents.
   */
  simulatedPrincipalCents: number;
}

/**
 * Percent funded from canonical saved principal.
 *
 * Single implementation so Home, Jar Detail, and the jar list cannot round
 * differently — they each inlined this expression previously.
 */
export function computePercentFunded(savedPrincipalCents: number, goalAmountCents: number): number {
  if (goalAmountCents <= 0) return 0;
  return Math.min(100, Math.round((savedPrincipalCents / goalAmountCents) * 1000) / 10);
}

/** Test Mode principal for a jar. Never counted as saved. */
export async function getJarSimulatedPrincipalCents(jarId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${contributions.amountCents}), 0)` })
    .from(contributions)
    .where(and(eq(contributions.jarId, jarId), eq(contributions.status, "simulated")));
  return Number(row?.total ?? 0);
}

/**
 * The canonical progress figures for one jar.
 *
 * Every money-bearing jar surface should call this rather than aggregating
 * contributions itself.
 */
export async function getJarProgressSummary(
  jarId: string,
  goalAmountCents: number,
): Promise<JarProgressSummary> {
  const [breakdown, simulatedPrincipalCents] = await Promise.all([
    getJarPrincipalBreakdown(jarId),
    getJarSimulatedPrincipalCents(jarId),
  ]);

  return {
    jarId,
    goalAmountCents,
    savedPrincipalCents: breakdown.savedPrincipalCents,
    committedPrincipalCents: breakdown.committedPrincipalCents,
    refundablePrincipalCents: breakdown.refundablePrincipalCents,
    refundPendingCents: breakdown.refundPendingCents,
    refundedPrincipalCents: breakdown.refundedPrincipalCents,
    percentFunded: computePercentFunded(breakdown.savedPrincipalCents, goalAmountCents),
    simulatedPrincipalCents,
  };
}

/**
 * Canonical saved principal for one member in one jar (refundable + committed).
 *
 * Member-level counterpart of getJarSavedPrincipalCents. Member balances summed
 * across a jar reconcile with the jar total because both derive from the same
 * ledger entries.
 */
export async function getMemberSavedPrincipalCents(
  jarId: string,
  memberId: string,
): Promise<number> {
  const balance = await getMemberFinancialBalance(jarId, memberId);
  return balance.refundablePrincipalCents + balance.committedPrincipalCents;
}

export interface MilestoneAllocationBreakdown {
  /** Milestone id → saved principal attributed to it. */
  byMilestoneId: Map<string, number>;
  /** Sum of byMilestoneId values. */
  totalAllocatedCents: number;
  /**
   * Saved principal not attributed to any milestone, derived as the residual
   * `savedPrincipalCents − totalAllocatedCents`. Never negative.
   */
  unallocatedCents: number;
  /** Canonical saved principal for the jar, from the ledger. */
  savedPrincipalCents: number;
  /**
   * False when attribution exceeded canonical saved principal, meaning the
   * split cannot be trusted. Callers must render only savedPrincipalCents and
   * suppress the breakdown — never show numbers that do not add up.
   */
  reconciles: boolean;
}

/**
 * Split the jar's saved principal across milestones.
 *
 * `unallocatedCents` is a RESIDUAL, not an independent sum. That is deliberate,
 * and the reason is worth stating precisely, because the obvious
 * implementation — sum contributions per milestone, sum untagged separately —
 * silently reports money that no longer exists.
 *
 * The ledger is authoritative for how much is saved, but has no milestone
 * dimension. The milestone tag lives on the contribution row, reachable only
 * via the Stripe PaymentIntent id shared by `provider_transaction_id` and
 * `external_payment_id`. So attribution must come from financial transactions
 * while the total must come from the ledger, and those two do not agree in
 * general. Measured against the 80 jars in the development database:
 *
 *   - Attribution alone reconciled for 62 jars.
 *   - `postRefundPrincipal` (lib/ledger.ts) debits CTRB_REFUNDABLE with no
 *     `refund_allocations` row, so a direct refund reduces saved principal
 *     while leaving every lot untouched. Accounting for it: 72 jars.
 *   - The remaining 8 fail because financial_transactions ↔ ledger is not 1:1:
 *     some transactions share a `ledger_id` and some posted rows have no ledger
 *     entries at all, so any sum over transaction principal double-counts.
 *
 * Deriving `unallocated` as the residual makes
 * `totalAllocated + unallocated === savedPrincipalCents` true by construction
 * rather than by coincidence, and pushes every discrepancy into the untagged
 * bucket where it is disclosed rather than hidden. When attribution exceeds
 * canonical saved principal the split is not merely imprecise but wrong, so
 * `reconciles` goes false and callers suppress the breakdown.
 *
 * Committed principal stays attributed: committing money does not un-save it,
 * it moves refundable → committed and both count as saved. A partial refund
 * subtracts only its allocated portion, leaving the remainder attributed.
 *
 * Exact attribution would need the milestone recorded against the financial
 * transaction, the way `commitment_allocations` and `refund_allocations` are.
 * The `milestone_allocations` table exists for this but is dead — never read
 * or written by any code path.
 *
 * Hawaii 2027 displayed $5,778 across five milestones against $7,274 saved.
 * The missing $1,496 was five untagged contributions: legitimately unallocated
 * money that no surface named. `unallocatedCents` names it.
 */
export async function getMilestoneAllocations(
  jarId: string,
): Promise<MilestoneAllocationBreakdown> {
  const savedPrincipalCents = await getJarSavedPrincipalCents(jarId);

  // Principal-origin lots. `ledgerPostingStatus = 'posted'` is the settlement
  // gate and mirrors aggregateLedger's filter, so quoted, provider_created,
  // failed, cancelled, and succeeded-but-unposted transactions are all excluded.
  //
  // Deliberately does NOT filter on providerStatus: manual and Phase 4A lots
  // post with 'not_applicable', and excluding them would drop real
  // ledger-backed principal.
  const lots = await db
    .select({
      id: financialTransactions.id,
      providerTransactionId: financialTransactions.providerTransactionId,
      principalCents: financialTransactions.requestedPrincipalCents,
    })
    .from(financialTransactions)
    .where(
      and(
        eq(financialTransactions.jarId, jarId),
        eq(financialTransactions.ledgerPostingStatus, "posted"),
        inArray(financialTransactions.transactionType, [...PRINCIPAL_ORIGIN_TRANSACTION_TYPES]),
      ),
    );

  const emptyResult: MilestoneAllocationBreakdown = {
    byMilestoneId: new Map(),
    totalAllocatedCents: 0,
    unallocatedCents: Math.max(0, savedPrincipalCents),
    savedPrincipalCents,
    reconciles: true,
  };

  if (lots.length === 0) return emptyResult;

  const lotIds = lots.map((l) => l.id);

  // Principal withdrawn from each lot by refunds, in flight or completed.
  const refundRows = await db
    .select({
      sourceFtId: refundAllocations.sourceFtId,
      total: sql<string>`coalesce(sum(${refundAllocations.allocatedCents}), 0)`,
    })
    .from(refundAllocations)
    .where(
      and(
        inArray(refundAllocations.sourceFtId, lotIds),
        notInArray(refundAllocations.providerStatus, [...REVERSED_REFUND_ALLOCATION_STATES]),
      ),
    )
    .groupBy(refundAllocations.sourceFtId);

  const refundedByLot = new Map(refundRows.map((r) => [r.sourceFtId, Number(r.total)]));

  // Milestone tag per lot. Reversed contributions are skipped — a reversal
  // voids the display record.
  const paymentIds = lots
    .map((l) => l.providerTransactionId)
    .filter((id): id is string => id !== null);

  const milestoneByPaymentId = new Map<string, string>();
  if (paymentIds.length > 0) {
    const tagRows = await db
      .select({
        externalPaymentId: contributions.externalPaymentId,
        milestoneId: contributions.milestoneId,
      })
      .from(contributions)
      .where(
        and(
          eq(contributions.jarId, jarId),
          inArray(contributions.externalPaymentId, paymentIds),
          ne(contributions.status, "reversed"),
        ),
      );

    for (const row of tagRows) {
      if (row.externalPaymentId && row.milestoneId) {
        milestoneByPaymentId.set(row.externalPaymentId, row.milestoneId);
      }
    }
  }

  const byMilestoneId = new Map<string, number>();
  let totalAllocatedCents = 0;

  for (const lot of lots) {
    const milestoneId = lot.providerTransactionId
      ? milestoneByPaymentId.get(lot.providerTransactionId)
      : undefined;
    if (!milestoneId) continue; // untagged principal falls into the residual

    const saved = Number(lot.principalCents) - (refundedByLot.get(lot.id) ?? 0);
    if (saved <= 0) continue;

    byMilestoneId.set(milestoneId, (byMilestoneId.get(milestoneId) ?? 0) + saved);
    totalAllocatedCents += saved;
  }

  // Attribution claiming more than the ledger holds means the split is wrong,
  // not merely coarse. Report nothing rather than something incorrect.
  if (totalAllocatedCents > savedPrincipalCents) {
    return {
      byMilestoneId: new Map(),
      totalAllocatedCents: 0,
      unallocatedCents: Math.max(0, savedPrincipalCents),
      savedPrincipalCents,
      reconciles: false,
    };
  }

  return {
    byMilestoneId,
    totalAllocatedCents,
    unallocatedCents: savedPrincipalCents - totalAllocatedCents,
    savedPrincipalCents,
    reconciles: true,
  };
}

/**
 * Derive the full detail view for a single financial transaction.
 * Used by the internal dev transparency endpoint.
 */
export async function getFinancialTransactionDetail(transactionId: string) {
  const [ft] = await db
    .select()
    .from(financialTransactions)
    .where(eq(financialTransactions.id, transactionId));

  if (!ft) return null;

  // Load ledger entries if posted
  let ledgerDetail: {
    ledgerTransactionId: string;
    entries: Array<{
      id: string;
      accountCode: string;
      accountName: string;
      entryType: string;
      amountCents: number;
      currency: string;
      memo: string | null;
    }>;
  } | null = null;

  if (ft.ledgerId) {
    const entries = await db
      .select({
        id: ledgerEntries.id,
        code: ledgerAccounts.code,
        name: ledgerAccounts.name,
        entryType: ledgerEntries.entryType,
        amountCents: ledgerEntries.amountCents,
        currency: ledgerEntries.currency,
        memo: ledgerEntries.memo,
      })
      .from(ledgerEntries)
      .innerJoin(ledgerAccounts, eq(ledgerEntries.accountId, ledgerAccounts.id))
      .where(eq(ledgerEntries.ledgerTransactionId, ft.ledgerId));

    ledgerDetail = {
      ledgerTransactionId: ft.ledgerId,
      entries: entries.map((e) => ({
        id: e.id,
        accountCode: e.code,
        accountName: e.name,
        entryType: e.entryType,
        amountCents: Number(e.amountCents),
        currency: e.currency,
        memo: e.memo,
      })),
    };
  }

  // Derive principal state from ledger
  const memberBalance = await getMemberFinancialBalance(ft.jarId, ft.memberId, ft.currency);

  return {
    transactionId: ft.id,
    jarId: ft.jarId,
    memberId: ft.memberId,
    transactionType: ft.transactionType,
    currency: ft.currency,
    requestedPrincipalCents: ft.requestedPrincipalCents,
    dripJarFeeCents: ft.dripJarFeeCents,
    dripJarFeeRateBps: ft.dripJarFeeRateBps,
    processingFeeEstimatedCents: ft.processingFeeEstimatedCents,
    processingFeeActualCents: ft.processingFeeActualCents,
    totalQuotedCents: ft.totalQuotedCents,
    providerType: ft.providerType,
    providerTransactionId: ft.providerTransactionId,
    providerStatus: ft.providerStatus,
    ledgerPostingStatus: ft.ledgerPostingStatus,
    ledgerTransactionId: ft.ledgerId,
    fundDestinationType: ft.fundDestinationType,
    createdAt: ft.createdAt,
    updatedAt: ft.updatedAt,
    ledger: ledgerDetail,
    derivedMemberBalance: memberBalance,
  };
}
