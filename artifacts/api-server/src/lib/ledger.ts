/**
 * Double-Entry Ledger Posting Primitives
 *
 * Implements immutable ledger posting with:
 *   - Balance validation (debits = credits) before every post
 *   - Atomic DB transaction wrapping
 *   - Row-level locking for concurrent refund/commit operations
 *   - Account code cache (system accounts never change at runtime)
 *
 * Debit/credit semantics:
 *   ASSET / EXPENSE      → debit increases, credit decreases
 *   LIABILITY / REVENUE  → credit increases, debit decreases
 *
 * All money values are integer cents. No floating-point arithmetic.
 * Corrections use compensating (reversing) entries — never update posted rows.
 */

import { db } from "@workspace/db";
import {
  ledgerAccounts,
  ledgerTransactions,
  ledgerEntries,
  financialTransactions,
  jarMembers,
} from "@workspace/db";
import { eq, and, sql, inArray } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { generateQuote, DRIPJAR_FEE_RATE_BPS } from "./fee-engine.js";
import { randomUUID } from "node:crypto";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * The query executor shared by `db` itself and by the `tx` that a
 * `db.transaction` callback receives.
 *
 * Derived from the driver rather than written by hand. Drizzle declares
 * `PgTransaction<Q, F, S> extends PgDatabase<Q, F, S>`, and `db.transaction`
 * hands its callback exactly the instantiation `db`'s own base was built from —
 * so re-forming that base from the callback parameter's type yields the one type
 * both values genuinely satisfy. Nothing is asserted at either call site, and
 * every builder the accounting body uses (`select`, `insert`, `update`,
 * `execute`, `query`) lives on `PgDatabase`, at the same type arguments.
 *
 * The name predates this: these helpers always took "a db or a tx". Until M2.5
 * the alias said `typeof db`, which is why every caller had to launder its
 * transaction through `as unknown as`.
 */
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type DbOrTx =
  DbTransaction extends PgDatabase<infer TResult, infer TFullSchema, infer TSchema>
    ? PgDatabase<TResult, TFullSchema, TSchema>
    : never;

export interface LedgerEntryInput {
  accountCode: string;
  entryType: "debit" | "credit";
  /** Must be a positive integer. */
  amountCents: number;
  currency?: string;
  memo?: string;
}

export interface PostLedgerTransactionInput {
  description: string;
  currency?: string;
  /**
   * Every ledger_transaction must belong to a financial_transaction.
   * Required — the DB column is NOT NULL.
   */
  financialTransactionId: string;
  entries: LedgerEntryInput[];
}

export interface PostedLedger {
  ledgerTransactionId: string;
}

export interface ContributionPostResult {
  financialTransactionId: string;
  ledgerTransactionId: string;
}

// ─── Account cache ────────────────────────────────────────────────────────────

// System accounts are seeded at migration time and never change.
// Cache them after the first DB query to avoid repeated round-trips.
let _accountCache: Map<string, string> | null = null; // code → id

async function resolveAccountId(
  dbOrTx: DbOrTx,
  code: string,
): Promise<string> {
  if (!_accountCache) {
    const accounts = await dbOrTx
      .select({ id: ledgerAccounts.id, code: ledgerAccounts.code })
      .from(ledgerAccounts);
    _accountCache = new Map(accounts.map((a) => [a.code, a.id]));
  }
  const id = _accountCache.get(code);
  if (!id) throw new Error(`Ledger account not found: ${code}`);
  return id;
}

/** Clear the in-process account cache (use in tests when seeding a fresh DB). */
export function clearLedgerAccountCache(): void {
  _accountCache = null;
}

// ─── Core posting primitive ────────────────────────────────────────────────────

/**
 * Insert ledger_transaction + ledger_entries into an existing transaction
 * context. Does NOT open a new transaction — the caller is responsible.
 */
async function _postLedgerEntriesInTx(
  tx: DbOrTx,
  input: PostLedgerTransactionInput,
): Promise<PostedLedger> {
  const { description, currency = "USD", financialTransactionId, entries } = input;

  if (!financialTransactionId) {
    throw new Error("financialTransactionId is required for every ledger_transaction");
  }

  if (entries.length === 0) {
    throw new Error("Ledger transaction must have at least one entry");
  }

  // Validate amounts are positive integers
  for (const e of entries) {
    if (!Number.isInteger(e.amountCents) || e.amountCents <= 0) {
      throw new Error(
        `Ledger entry amount must be a positive integer; got ${e.amountCents}`,
      );
    }
  }

  // Validate balance: sum(debits) === sum(credits)
  let totalDebits = 0;
  let totalCredits = 0;
  for (const e of entries) {
    if (e.entryType === "debit") totalDebits += e.amountCents;
    else totalCredits += e.amountCents;
  }
  if (totalDebits !== totalCredits) {
    throw new Error(
      `Ledger transaction does not balance: debits=${totalDebits} credits=${totalCredits}`,
    );
  }

  // Resolve account IDs (uses cache; reads from the same tx on first call)
  const accountIds = new Map<string, string>();
  for (const e of entries) {
    if (!accountIds.has(e.accountCode)) {
      accountIds.set(e.accountCode, await resolveAccountId(tx, e.accountCode));
    }
  }

  // Insert ledger transaction header
  const [ledgerTx] = await tx
    .insert(ledgerTransactions)
    .values({
      financialTransactionId,
      description,
      currency,
    })
    .returning({ id: ledgerTransactions.id });

  if (!ledgerTx) throw new Error("Failed to insert ledger_transaction");

  // Insert all entries
  await tx.insert(ledgerEntries).values(
    entries.map((e) => ({
      ledgerTransactionId: ledgerTx.id,
      accountId: accountIds.get(e.accountCode)!,
      entryType: e.entryType,
      amountCents: e.amountCents,
      currency: e.currency ?? currency,
      memo: e.memo ?? null,
    })),
  );

  return { ledgerTransactionId: ledgerTx.id };
}

/**
 * Post an immutable double-entry ledger transaction.
 * Opens its own DB transaction to guarantee atomicity.
 */
export async function postLedgerTransaction(
  input: PostLedgerTransactionInput,
): Promise<PostedLedger> {
  return db.transaction((tx) =>
    _postLedgerEntriesInTx(tx, input),
  );
}

// ─── Contribution accounting ───────────────────────────────────────────────────

export interface ContributionAccountingParams {
  jarId: string;
  memberId: string;
  principalCents: number;
  estimatedProcessingFeeCents?: number;
  currency?: string;
  idempotencyKey?: string;
  /** Default: 'contribution'. Pass 'autodrip_contribution' for AutoDrip runs. */
  transactionType?: string;
  /** Provider info for AutoDrip runs (PI already created before webhook) */
  providerType?: string;
  providerTransactionId?: string;
  providerStatus?: string;
}

/**
 * Post the full financial record + ledger entries for a contribution INSIDE an
 * existing DB transaction supplied by the caller. Does NOT open one.
 *
 * Journal entry for $200 principal, $6 DripJar fee, $1.60 processing fee:
 *
 *   DR EXT_PAY_CLR       20760  (customer charged $207.60)
 *   CR CTRB_REFUNDABLE   20000  (contributor refundable principal)
 *   CR DJ_FEE_REVENUE      600  (DripJar service fee earned)
 *   CR PROC_FEE_CLR        160  (processing fee pass-through)
 *
 * Checks idempotency key uniqueness — duplicate keys return the existing
 * financial transaction ID without re-posting.
 *
 * ─── WHY THIS VARIANT EXISTS ─────────────────────────────────────────────────
 *
 * A caller already inside a transaction must use this, never the self-opening
 * wrapper below. Calling the wrapper from inside a transaction checks out a
 * SECOND pool connection and holds both at once, so ten concurrent postings
 * consume every connection in a pool of ten with none left for the inner
 * transactions they are all waiting on. `connectionTimeoutMillis` is 0, so that
 * state never errors — it waits forever.
 *
 * It also breaks atomicity: the inner transaction COMMITS the financial
 * transaction, the ledger transaction and its entries before the outer one
 * commits, so an outer rollback leaves posted ledger money behind with no
 * contribution row against it.
 *
 * Same shape as `postCommitPrincipalInTx` and the other Phase 4C primitives:
 * one implementation, two entry points, no logic that can drift apart.
 */
export async function postContributionAccountingInTx(
  txDb: DbOrTx,
  params: ContributionAccountingParams,
): Promise<ContributionPostResult> {
  const {
    jarId,
    memberId,
    principalCents,
    estimatedProcessingFeeCents = 0,
    currency = "USD",
    idempotencyKey = randomUUID(),
    transactionType = "contribution",
    providerType = null,
    providerTransactionId = null,
    providerStatus = "not_applicable",
  } = params;

  const quote = generateQuote(principalCents, estimatedProcessingFeeCents, currency);

  // Check idempotency: if already posted, return existing IDs
  const [existing] = await txDb
    .select({
      id: financialTransactions.id,
      ledgerId: financialTransactions.ledgerId,
      status: financialTransactions.ledgerPostingStatus,
    })
    .from(financialTransactions)
    .where(eq(financialTransactions.idempotencyKey, idempotencyKey));

  if (existing) {
    if (!existing.ledgerId) {
      throw new Error("Duplicate idempotency key with unposted ledger");
    }
    return {
      financialTransactionId: existing.id,
      ledgerTransactionId: existing.ledgerId,
    };
  }

  // Insert financial_transaction (pending)
  const [finTx] = await txDb
    .insert(financialTransactions)
    .values({
      jarId,
      memberId,
      transactionType: transactionType as string,
      currency,
      requestedPrincipalCents: principalCents,
      dripJarFeeCents: quote.dripJarFeeCents,
      dripJarFeeRateBps: DRIPJAR_FEE_RATE_BPS,
      processingFeeEstimatedCents: estimatedProcessingFeeCents,
      processingFeeActualCents: null,
      totalQuotedCents: quote.totalChargeCents,
      providerType: providerType as string | null,
      providerTransactionId: providerTransactionId as string | null,
      providerStatus: providerStatus as string,
      ledgerPostingStatus: "pending",
      ledgerId: null,
      idempotencyKey,
    })
    .returning({ id: financialTransactions.id });

  if (!finTx) throw new Error("Failed to insert financial_transaction");

  // Post balanced ledger entries
  const posted = await _postLedgerEntriesInTx(txDb, {
    description: `Contribution: ${currency} ${(principalCents / 100).toFixed(2)} principal`,
    currency,
    financialTransactionId: finTx.id,
    entries: [
      {
        accountCode: "EXT_PAY_CLR",
        entryType: "debit",
        amountCents: quote.totalChargeCents,
        memo: `Total customer charge: ${quote.totalChargeCents}¢`,
      },
      {
        accountCode: "CTRB_REFUNDABLE",
        entryType: "credit",
        amountCents: principalCents,
        memo: `Refundable principal: ${principalCents}¢`,
      },
      {
        accountCode: "DJ_FEE_REVENUE",
        entryType: "credit",
        amountCents: quote.dripJarFeeCents,
        memo: `DripJar ${DRIPJAR_FEE_RATE_BPS / 100}% fee: ${quote.dripJarFeeCents}¢`,
      },
      // Only add processing-fee entry when non-zero
      ...(estimatedProcessingFeeCents > 0
        ? [
            {
              accountCode: "PROC_FEE_CLR",
              entryType: "credit" as const,
              amountCents: estimatedProcessingFeeCents,
              memo: `Processing fee pass-through (estimated): ${estimatedProcessingFeeCents}¢`,
            },
          ]
        : []),
    ],
  });

  // Mark financial_transaction as posted
  await txDb
    .update(financialTransactions)
    .set({
      ledgerPostingStatus: "posted",
      ledgerId: posted.ledgerTransactionId,
      updatedAt: new Date(),
    })
    .where(eq(financialTransactions.id, finTx.id));

  return {
    financialTransactionId: finTx.id,
    ledgerTransactionId: posted.ledgerTransactionId,
  };
}

/**
 * Post the full financial record + ledger entries for a contribution,
 * opening and owning the DB transaction.
 *
 * For standalone callers only. A caller that is already inside a transaction
 * must call `postContributionAccountingInTx` with its own executor instead —
 * see the note there.
 */
export async function postContributionAccounting(
  params: ContributionAccountingParams,
): Promise<ContributionPostResult> {
  return db.transaction((tx) => postContributionAccountingInTx(tx, params));
}

// ─── Refund accounting ────────────────────────────────────────────────────────

/**
 * Post accounting entries for a pre-commit principal refund.
 *
 * Journal entry (compensating — does not touch original contribution):
 *   DR CTRB_REFUNDABLE  principalCents  (reduce refundable liability)
 *   CR REFUND_CLR       principalCents  (record outflow)
 *
 * DripJar fee and processing fees are NOT refunded (business rule F, G).
 * The original contribution ledger entries are untouched (immutable).
 *
 * Locks the jar_members row FOR UPDATE to serialize concurrent operations
 * for the same member. Verifies sufficient refundable balance within the
 * same transaction so no overspend is possible under concurrency.
 *
 * @throws if refundable principal < principalCents
 * @throws if principalCents <= 0
 */
export async function postRefundPrincipal(params: {
  jarId: string;
  memberId: string;
  principalCents: number;
  currency?: string;
  idempotencyKey?: string;
}): Promise<ContributionPostResult> {
  const {
    jarId,
    memberId,
    principalCents,
    currency = "USD",
    idempotencyKey = randomUUID(),
  } = params;

  if (!Number.isInteger(principalCents) || principalCents <= 0) {
    throw new Error(`principalCents must be a positive integer; got ${principalCents}`);
  }

  return db.transaction(async (tx) => {
    const txDb = tx;

    // Check idempotency
    const [existing] = await txDb
      .select({ id: financialTransactions.id, ledgerId: financialTransactions.ledgerId })
      .from(financialTransactions)
      .where(eq(financialTransactions.idempotencyKey, idempotencyKey));

    if (existing) {
      if (!existing.ledgerId) throw new Error("Duplicate idempotency key with unposted ledger");
      return { financialTransactionId: existing.id, ledgerTransactionId: existing.ledgerId };
    }

    // Lock the jar_members row to serialize concurrent refund/commit for this member
    const locked = await txDb
      .select({ id: jarMembers.id })
      .from(jarMembers)
      .where(eq(jarMembers.id, memberId))
      .for("update");

    if (!locked[0]) throw new Error("Member not found");

    // Compute current refundable balance within the locked transaction
    const refundable = await _computeRefundableBalance(txDb, jarId, memberId);

    if (refundable < principalCents) {
      throw new Error(
        `Insufficient refundable principal: available=${refundable}¢ requested=${principalCents}¢`,
      );
    }

    // Create financial_transaction for the refund
    const [finTx] = await txDb
      .insert(financialTransactions)
      .values({
        jarId,
        memberId,
        transactionType: "refund",
        currency,
        requestedPrincipalCents: principalCents,
        dripJarFeeCents: 0,
        dripJarFeeRateBps: DRIPJAR_FEE_RATE_BPS,
        processingFeeEstimatedCents: 0,
        processingFeeActualCents: null,
        totalQuotedCents: principalCents,
        providerStatus: "not_applicable",
        ledgerPostingStatus: "pending",
        ledgerId: null,
        idempotencyKey,
      })
      .returning({ id: financialTransactions.id });

    if (!finTx) throw new Error("Failed to insert refund financial_transaction");

    // Post compensating ledger entries
    const posted = await _postLedgerEntriesInTx(txDb, {
      description: `Refund of ${principalCents}¢ principal`,
      currency,
      financialTransactionId: finTx.id,
      entries: [
        {
          accountCode: "CTRB_REFUNDABLE",
          entryType: "debit",
          amountCents: principalCents,
          memo: `Reduce refundable principal: ${principalCents}¢`,
        },
        {
          accountCode: "REFUND_CLR",
          entryType: "credit",
          amountCents: principalCents,
          memo: `Refund outflow: ${principalCents}¢`,
        },
      ],
    });

    await txDb
      .update(financialTransactions)
      .set({ ledgerPostingStatus: "posted", ledgerId: posted.ledgerTransactionId, updatedAt: new Date() })
      .where(eq(financialTransactions.id, finTx.id));

    return {
      financialTransactionId: finTx.id,
      ledgerTransactionId: posted.ledgerTransactionId,
    };
  });
}

// ─── Commitment accounting ────────────────────────────────────────────────────

/**
 * Post accounting entries for an explicit contributor commitment.
 *
 * Moves refundable principal to committed — no money leaves the platform:
 *   DR CTRB_REFUNDABLE  principalCents  (reduce refundable liability)
 *   CR CTRB_COMMITTED   principalCents  (increase committed liability)
 *
 * Idempotent, locking, and balance-checking — same invariants as refund.
 * Each contributor commits their OWN principal only (enforced by memberId).
 *
 * @throws if refundable principal < principalCents
 */
export async function postCommitPrincipal(params: {
  jarId: string;
  memberId: string;
  principalCents: number;
  currency?: string;
  idempotencyKey?: string;
}): Promise<ContributionPostResult> {
  const {
    jarId,
    memberId,
    principalCents,
    currency = "USD",
    idempotencyKey = randomUUID(),
  } = params;

  if (!Number.isInteger(principalCents) || principalCents <= 0) {
    throw new Error(`principalCents must be a positive integer; got ${principalCents}`);
  }

  return db.transaction(async (tx) => {
    const txDb = tx;

    // Check idempotency
    const [existing] = await txDb
      .select({ id: financialTransactions.id, ledgerId: financialTransactions.ledgerId })
      .from(financialTransactions)
      .where(eq(financialTransactions.idempotencyKey, idempotencyKey));

    if (existing) {
      if (!existing.ledgerId) throw new Error("Duplicate idempotency key with unposted ledger");
      return { financialTransactionId: existing.id, ledgerTransactionId: existing.ledgerId };
    }

    // Lock member row to serialize concurrent commit/refund for this member
    const locked = await txDb
      .select({ id: jarMembers.id })
      .from(jarMembers)
      .where(eq(jarMembers.id, memberId))
      .for("update");

    if (!locked[0]) throw new Error("Member not found");

    const refundable = await _computeRefundableBalance(txDb, jarId, memberId);

    if (refundable < principalCents) {
      throw new Error(
        `Insufficient refundable principal: available=${refundable}¢ requested=${principalCents}¢`,
      );
    }

    const [finTx] = await txDb
      .insert(financialTransactions)
      .values({
        jarId,
        memberId,
        transactionType: "commitment_transfer",
        currency,
        requestedPrincipalCents: principalCents,
        dripJarFeeCents: 0,
        dripJarFeeRateBps: DRIPJAR_FEE_RATE_BPS,
        processingFeeEstimatedCents: 0,
        processingFeeActualCents: null,
        totalQuotedCents: principalCents,
        providerStatus: "not_applicable",
        ledgerPostingStatus: "pending",
        ledgerId: null,
        idempotencyKey,
      })
      .returning({ id: financialTransactions.id });

    if (!finTx) throw new Error("Failed to insert commitment financial_transaction");

    const posted = await _postLedgerEntriesInTx(txDb, {
      description: `Commitment of ${principalCents}¢ principal`,
      currency,
      financialTransactionId: finTx.id,
      entries: [
        {
          accountCode: "CTRB_REFUNDABLE",
          entryType: "debit",
          amountCents: principalCents,
          memo: `Reduce refundable: ${principalCents}¢`,
        },
        {
          accountCode: "CTRB_COMMITTED",
          entryType: "credit",
          amountCents: principalCents,
          memo: `Committed to jar: ${principalCents}¢`,
        },
      ],
    });

    await txDb
      .update(financialTransactions)
      .set({ ledgerPostingStatus: "posted", ledgerId: posted.ledgerTransactionId, updatedAt: new Date() })
      .where(eq(financialTransactions.id, finTx.id));

    return {
      financialTransactionId: finTx.id,
      ledgerTransactionId: posted.ledgerTransactionId,
    };
  });
}

// ─── Internal balance computation ─────────────────────────────────────────────

/**
 * Compute the current refundable balance for a member in a jar.
 * Must be called within an existing DB transaction that has already locked
 * the jar_members row (SELECT FOR UPDATE) to prevent races.
 *
 * refundable = CTRB_REFUNDABLE credits − CTRB_REFUNDABLE debits
 * (debits arise from refunds and commitment_transfers)
 */
async function _computeRefundableBalance(
  txDb: DbOrTx,
  jarId: string,
  memberId: string,
): Promise<number> {
  const rows = await txDb
    .select({
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
      eq(ledgerTransactions.financialTransactionId, financialTransactions.id),
    )
    .innerJoin(
      ledgerAccounts,
      and(
        eq(ledgerEntries.accountId, ledgerAccounts.id),
        eq(ledgerAccounts.code, "CTRB_REFUNDABLE"),
      ),
    )
    .where(
      and(
        eq(financialTransactions.jarId, jarId),
        eq(financialTransactions.memberId, memberId),
        eq(financialTransactions.ledgerPostingStatus, "posted"),
      ),
    )
    .groupBy(ledgerEntries.entryType);

  let credits = 0;
  let debits = 0;
  for (const row of rows) {
    const amount = Number(row.total);
    if (row.entryType === "credit") credits = amount;
    else if (row.entryType === "debit") debits = amount;
  }
  return credits - debits;
}

// Re-export for use in balance service
export { _computeRefundableBalance as computeRefundableBalanceInTx };

// ─── Phase 4C: In-Transaction Ledger Primitives ───────────────────────────────
//
// These functions post a balanced ledger transaction + create the associated
// financial_transaction row INSIDE an existing DB transaction provided by the
// caller. They do NOT open a new transaction. The caller is responsible for:
//   - Starting the enclosing transaction
//   - Locking the jar_members row (SELECT FOR UPDATE) before calling
//   - Verifying sufficient balance before calling
//   - Rolling back on any error
//
// Each primitive creates exactly one financial_transaction + one
// ledger_transaction + two ledger_entries, all within the provided txDb.

export interface InTxPostResult {
  financialTransactionId: string;
  ledgerTransactionId: string;
}

async function _createFinancialTransactionInTx(
  txDb: DbOrTx,
  params: {
    jarId: string;
    memberId: string;
    transactionType: string;
    amountCents: number;
    currency: string;
    idempotencyKey: string;
  },
): Promise<string> {
  // Check idempotency
  const [existing] = await txDb
    .select({ id: financialTransactions.id })
    .from(financialTransactions)
    .where(eq(financialTransactions.idempotencyKey, params.idempotencyKey));

  if (existing) return existing.id;

  const [finTx] = await txDb
    .insert(financialTransactions)
    .values({
      jarId: params.jarId,
      memberId: params.memberId,
      transactionType: params.transactionType,
      currency: params.currency,
      requestedPrincipalCents: params.amountCents,
      dripJarFeeCents: 0,
      dripJarFeeRateBps: DRIPJAR_FEE_RATE_BPS,
      processingFeeEstimatedCents: 0,
      processingFeeActualCents: null,
      totalQuotedCents: params.amountCents,
      providerStatus: "not_applicable",
      ledgerPostingStatus: "pending",
      ledgerId: null,
      idempotencyKey: params.idempotencyKey,
    })
    .returning({ id: financialTransactions.id });

  if (!finTx) throw new Error(`Failed to insert ${params.transactionType} financial_transaction`);
  return finTx.id;
}

async function _postTwoEntryInTx(
  txDb: DbOrTx,
  params: {
    jarId: string;
    memberId: string;
    transactionType: string;
    description: string;
    amountCents: number;
    currency: string;
    idempotencyKey: string;
    debitAccount: string;
    creditAccount: string;
  },
): Promise<InTxPostResult> {
  if (!Number.isInteger(params.amountCents) || params.amountCents <= 0) {
    throw new Error(`amountCents must be a positive integer; got ${params.amountCents}`);
  }

  const financialTransactionId = await _createFinancialTransactionInTx(txDb, {
    jarId: params.jarId,
    memberId: params.memberId,
    transactionType: params.transactionType,
    amountCents: params.amountCents,
    currency: params.currency,
    idempotencyKey: params.idempotencyKey,
  });

  // If FT already existed (idempotent hit), check if it already has a ledger entry
  const [existingFt] = await txDb
    .select({ ledgerId: financialTransactions.ledgerId, ledgerPostingStatus: financialTransactions.ledgerPostingStatus })
    .from(financialTransactions)
    .where(eq(financialTransactions.id, financialTransactionId));

  if (existingFt?.ledgerPostingStatus === "posted" && existingFt.ledgerId) {
    return { financialTransactionId, ledgerTransactionId: existingFt.ledgerId };
  }

  const posted = await _postLedgerEntriesInTx(txDb, {
    description: params.description,
    currency: params.currency,
    financialTransactionId,
    entries: [
      {
        accountCode: params.debitAccount,
        entryType: "debit",
        amountCents: params.amountCents,
        memo: `${params.description}: ${params.amountCents}¢`,
      },
      {
        accountCode: params.creditAccount,
        entryType: "credit",
        amountCents: params.amountCents,
        memo: `${params.description}: ${params.amountCents}¢`,
      },
    ],
  });

  await txDb
    .update(financialTransactions)
    .set({
      ledgerPostingStatus: "posted",
      ledgerId: posted.ledgerTransactionId,
      updatedAt: new Date(),
    })
    .where(eq(financialTransactions.id, financialTransactionId));

  return { financialTransactionId, ledgerTransactionId: posted.ledgerTransactionId };
}

/**
 * Refund Reservation — Phase 4C
 *
 * Posts the reservation entry when a refund_request is created.
 * Moves principal from refundable to in-flight reservation:
 *   DR CTRB_REFUNDABLE   amountCents  (reduce refundable)
 *   CR REFUND_PENDING    amountCents  (reserve for in-flight refund)
 *
 * Called INSIDE an existing transaction. Caller must lock jar_members row
 * and verify sufficient refundable balance before calling.
 *
 * Idempotent via idempotencyKey.
 */
export async function postRefundReservationInTx(
  txDb: DbOrTx,
  params: {
    jarId: string;
    memberId: string;
    amountCents: number;
    currency?: string;
    idempotencyKey?: string;
  },
): Promise<InTxPostResult> {
  const { jarId, memberId, amountCents, currency = "USD", idempotencyKey = randomUUID() } = params;
  return _postTwoEntryInTx(txDb, {
    jarId,
    memberId,
    transactionType: "refund_reservation",
    description: `Refund reservation: ${amountCents}¢`,
    amountCents,
    currency,
    idempotencyKey,
    debitAccount: "CTRB_REFUNDABLE",
    creditAccount: "REFUND_PENDING",
  });
}

/**
 * Refund Finalization — Phase 4C
 *
 * Posts the finalization entry when Stripe confirms a refund.
 * Clears the in-flight reservation and records the outflow:
 *   DR REFUND_PENDING  amountCents  (clear reservation)
 *   CR REFUND_CLR      amountCents  (refund outflow — money leaves platform)
 *
 * Called INSIDE an existing transaction. Must be idempotent — check
 * allocation.finalizationFtId before calling.
 */
export async function postRefundFinalizationInTx(
  txDb: DbOrTx,
  params: {
    jarId: string;
    memberId: string;
    amountCents: number;
    currency?: string;
    idempotencyKey?: string;
  },
): Promise<InTxPostResult> {
  const { jarId, memberId, amountCents, currency = "USD", idempotencyKey = randomUUID() } = params;
  return _postTwoEntryInTx(txDb, {
    jarId,
    memberId,
    transactionType: "refund_finalization",
    description: `Refund finalization: ${amountCents}¢`,
    amountCents,
    currency,
    idempotencyKey,
    debitAccount: "REFUND_PENDING",
    creditAccount: "REFUND_CLR",
  });
}

/**
 * Refund Reversal — Phase 4C
 *
 * Posts the reversal entry when a Stripe refund fails or is cancelled.
 * Returns the reserved principal back to refundable:
 *   DR REFUND_PENDING    amountCents  (clear reservation)
 *   CR CTRB_REFUNDABLE   amountCents  (restore refundable balance)
 *
 * Called INSIDE an existing transaction. Per-allocation terminal states
 * cannot regress — caller must verify before calling.
 */
export async function postRefundReversalInTx(
  txDb: DbOrTx,
  params: {
    jarId: string;
    memberId: string;
    amountCents: number;
    currency?: string;
    idempotencyKey?: string;
  },
): Promise<InTxPostResult> {
  const { jarId, memberId, amountCents, currency = "USD", idempotencyKey = randomUUID() } = params;
  return _postTwoEntryInTx(txDb, {
    jarId,
    memberId,
    transactionType: "refund_reversal",
    description: `Refund reversal: ${amountCents}¢`,
    amountCents,
    currency,
    idempotencyKey,
    debitAccount: "REFUND_PENDING",
    creditAccount: "CTRB_REFUNDABLE",
  });
}

/**
 * Commit Principal (in-transaction) — Phase 4C
 *
 * In-transaction variant of postCommitPrincipal. Moves refundable principal
 * to committed without opening its own transaction:
 *   DR CTRB_REFUNDABLE  amountCents  (reduce refundable)
 *   CR CTRB_COMMITTED   amountCents  (lock for payout)
 *
 * Called INSIDE an existing transaction. Caller must:
 *   - Lock the jar_members row (FOR UPDATE)
 *   - Verify sufficient refundable balance
 *
 * Idempotent via idempotencyKey.
 */
export async function postCommitPrincipalInTx(
  txDb: DbOrTx,
  params: {
    jarId: string;
    memberId: string;
    amountCents: number;
    currency?: string;
    idempotencyKey?: string;
  },
): Promise<InTxPostResult> {
  const { jarId, memberId, amountCents, currency = "USD", idempotencyKey = randomUUID() } = params;
  return _postTwoEntryInTx(txDb, {
    jarId,
    memberId,
    transactionType: "commitment_transfer",
    description: `Fund commitment: ${amountCents}¢`,
    amountCents,
    currency,
    idempotencyKey,
    debitAccount: "CTRB_REFUNDABLE",
    creditAccount: "CTRB_COMMITTED",
  });
}
