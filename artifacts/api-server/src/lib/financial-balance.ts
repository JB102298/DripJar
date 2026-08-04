/**
 * Financial Balance Service
 *
 * Derives all financial balances from immutable ledger entries.
 * NEVER trusts client-provided numbers or independently editable columns.
 *
 * Invariant verified by this service:
 *   refundable + committed + refunded = contributedPrincipal
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
} from "@workspace/db";
import { eq, and, sql, inArray } from "drizzle-orm";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MemberFinancialBalance {
  jarId: string;
  memberId: string;
  currency: string;

  /** Total principal ever dripped (sum of CTRB_REFUNDABLE credits). */
  contributedPrincipalCents: number;
  /** Current refundable = contributed − committed − refunded. */
  refundablePrincipalCents: number;
  /** Principal explicitly committed (locked for payout). */
  committedPrincipalCents: number;
  /** Principal returned to contributor via refund. */
  refundedPrincipalCents: number;

  /** DripJar 3% fees earned on this member's contributions. */
  dripJarFeesEarnedCents: number;
  /** Processing fee estimates recorded at contribution time. */
  processingFeesEstimatedCents: number;
  /** Actual provider fees (null until Phase 4B reconciliation). */
  processingFeesActualCents: number | null;

  /** Total amounts charged to the customer (EXT_PAY_CLR debits). */
  totalCustomerChargesCents: number;

  /** Invariant check: refundable + committed + refunded === contributedPrincipal. */
  invariantHolds: boolean;
}

export interface JarFinancialBalance {
  jarId: string;
  currency: string;

  totalContributedPrincipalCents: number;
  totalRefundablePrincipalCents: number;
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
  const ctrbRefCr = get(agg, "CTRB_REFUNDABLE", "credit"); // contributions
  const ctrbRefDr = get(agg, "CTRB_REFUNDABLE", "debit");  // refunds + commitments
  const ctrbCommCr = get(agg, "CTRB_COMMITTED", "credit");  // commitments
  const refundClrCr = get(agg, "REFUND_CLR", "credit");     // refund outflows
  const djFeeCr = get(agg, "DJ_FEE_REVENUE", "credit");
  const procFeeCr = get(agg, "PROC_FEE_CLR", "credit");
  const extPayDr = get(agg, "EXT_PAY_CLR", "debit");

  const contributedPrincipalCents = ctrbRefCr;
  const committedPrincipalCents = ctrbCommCr;
  const refundedPrincipalCents = refundClrCr;
  const refundablePrincipalCents = ctrbRefCr - ctrbRefDr;

  const invariantHolds =
    refundablePrincipalCents + committedPrincipalCents + refundedPrincipalCents ===
    contributedPrincipalCents;

  return {
    jarId,
    memberId,
    currency,
    contributedPrincipalCents,
    refundablePrincipalCents,
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
  const totalCommitted = sum((b) => b.committedPrincipalCents);
  const totalRefunded = sum((b) => b.refundedPrincipalCents);
  const totalContributed = sum((b) => b.contributedPrincipalCents);

  return {
    jarId,
    currency,
    totalContributedPrincipalCents: totalContributed,
    totalRefundablePrincipalCents: totalRefundable,
    totalCommittedPrincipalCents: totalCommitted,
    totalRefundedPrincipalCents: totalRefunded,
    totalDripJarRevenueAssociatedCents: sum((b) => b.dripJarFeesEarnedCents),
    totalProcessingFeesEstimatedCents: sum((b) => b.processingFeesEstimatedCents),
    totalCustomerChargesCents: sum((b) => b.totalCustomerChargesCents),
    memberBalances,
    invariantHolds:
      totalRefundable + totalCommitted + totalRefunded === totalContributed,
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
