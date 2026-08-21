/**
 * Cross-jar history for one user.
 *
 * ─── THE BUG THIS EXISTS TO FIX ──────────────────────────────────────────────
 *
 * The Profile screen's "Contributed" stat rendered
 * `dashboard.personalProgress.contributedAmountCents`. That field is the
 * caller's saved principal **in the featured jar** — one jar, chosen as "most
 * recently updated jar I'm a member of". On a profile page, next to a "Jars"
 * count that spans every jar, it reads unambiguously as a lifetime total. A
 * member of six jars saw the number from whichever one they happened to touch
 * last, and the figure changed when an unrelated jar was updated.
 *
 * ─── WHAT "LIFETIME CONTRIBUTED" MEANS HERE ──────────────────────────────────
 *
 * Principal ever successfully contributed, across every jar, whether it is
 * still held, has since been committed, or has been refunded. It only ever goes
 * up. That is the honest reading of a profile stat labelled "Contributed", and
 * it is deliberately NOT the same as "currently saved" — which both `/me/jars`
 * and the jar screens also report, separately and labelled as such.
 *
 * ─── WHY IT IS DERIVED FROM LEDGER CREDITS, NOT FROM TRANSACTION AMOUNTS ─────
 *
 * The tempting implementation — sum `financial_transactions.
 * requested_principal_cents` over the caller's contributions — double-counts.
 * `financial_transactions` is not 1:1 with ledger postings: some rows share a
 * `ledger_id`, and some rows marked posted have no ledger entries at all. On
 * the development database that discrepancy affects 8 jars in 80.
 *
 * So every figure here comes from `ledger_entries`. Specifically:
 *
 *     lifetime contributed = Σ CTRB_REFUNDABLE credits
 *                            from principal-origin transactions
 *
 * That identity is exact, not approximate. Expanding the four-term invariant in
 * lib/financial-balance.ts:
 *
 *     refundable + refundPending + committed + refunded
 *   = (REF.cr − REF.dr) + (RP.cr − RP.dr) + CC.cr + RC.cr
 *
 * every term except contribution credits cancels — a commitment debits
 * refundable and credits committed, a reservation debits refundable and credits
 * pending, a finalization debits pending and credits refund-cleared, a reversal
 * debits pending and credits refundable back. What survives is exactly the
 * credits posted by `contribution` and `autodrip_contribution`.
 *
 * The consequence that matters for the UI: the drill-down list and the summary
 * total are the SAME ledger rows, summed at different granularity. They cannot
 * disagree. `reconciles` below independently cross-checks that against the
 * canonical per-member balance service, and the API reports it rather than
 * quietly papering over a mismatch.
 */

import { db } from "@workspace/db";
import {
  jars,
  jarMembers,
  ledgerEntries,
  ledgerTransactions,
  ledgerAccounts,
  financialTransactions,
} from "@workspace/db";
import { eq, and, inArray, desc, sql } from "drizzle-orm";
import {
  PRINCIPAL_ORIGIN_TRANSACTION_TYPES,
  getMemberFinancialBalance,
} from "./financial-balance.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * One contribution, as the contributor sees it.
 *
 * Deliberately carries NO internal identifier — not the ledger entry id, not
 * the financial transaction id, not the member id. `jarId` is the only id here,
 * because the client needs it to navigate to the jar. Everything else about a
 * posting is DripJar's internal accounting and has no business on a history
 * screen.
 */
export interface ContributionHistoryEntry {
  jarId: string;
  jarName: string;
  /** Principal this contribution added. Always positive. */
  principalCents: number;
  currency: string;
  /** 'contribution' (manual or Stripe) or 'autodrip_contribution'. */
  transactionType: string;
  /** When the contribution was recorded. */
  occurredAt: Date;
}

export interface MemberJarHistoryEntry {
  jarId: string;
  name: string;
  category: string | null;
  status: string;
  targetDate: string;
  /** 'exact' | 'monthYear' | 'year' — how the history screen must render it. */
  targetDatePrecision: string;
  goalAmountCents: number;
  currency: string;
  /** The caller's role in this jar. */
  role: string;
  /** 'active', 'removed', 'left' — so past jars can be labelled as past. */
  membershipStatus: string;
  joinedAt: Date | null;

  /** Principal the caller has ever contributed to this jar. Never decreases. */
  lifetimeContributedPrincipalCents: number;
  /** Principal the caller currently has in this jar (refundable + committed). */
  currentlySavedPrincipalCents: number;
  /** Principal the caller has had refunded out of this jar. */
  refundedPrincipalCents: number;
  /** How many contribution events make up the lifetime figure. */
  contributionCount: number;
  /**
   * False when the ledger-credit sum disagrees with the canonical member
   * balance service for this jar. Callers must suppress the per-jar breakdown
   * rather than render figures that do not add up. See the header comment.
   */
  reconciles: boolean;
}

export interface MemberHistorySummary {
  /** Σ lifetimeContributedPrincipalCents over every jar the caller has joined. */
  lifetimeContributedPrincipalCents: number;
  /** Σ currentlySavedPrincipalCents. */
  currentlySavedPrincipalCents: number;
  /** Σ refundedPrincipalCents. */
  refundedPrincipalCents: number;
  /** Number of jars the caller has ever been a member of. */
  jarCount: number;
  /** Number of contribution events behind the lifetime figure. */
  contributionCount: number;
  /** False when any jar failed its reconciliation check. */
  reconciles: boolean;
}

// ─── Membership lookup ────────────────────────────────────────────────────────

interface Membership {
  memberId: string;
  jarId: string;
  role: string;
  status: string;
  joinedAt: Date | null;
}

/**
 * Every membership row for a user, including inactive ones.
 *
 * Inactive memberships are deliberately included. A member who left a jar still
 * contributed to it, and a lifetime total that silently drops those jars is
 * wrong in exactly the way this module exists to fix. The membership status is
 * returned so the UI can label a past jar as past.
 */
export async function getUserMemberships(userId: string): Promise<Membership[]> {
  const rows = await db
    .select({
      memberId: jarMembers.id,
      jarId: jarMembers.jarId,
      role: jarMembers.role,
      status: jarMembers.status,
      joinedAt: jarMembers.joinedAt,
    })
    .from(jarMembers)
    .where(eq(jarMembers.userId, userId));

  return rows;
}

// ─── Ledger aggregation, caller-scoped ────────────────────────────────────────

/**
 * Per-jar contribution credits for a set of the caller's member rows.
 *
 * Returns totals and counts keyed by jarId. One query regardless of how many
 * jars the caller belongs to.
 */
async function aggregateContributionCredits(
  memberIds: string[],
): Promise<Map<string, { totalCents: number; count: number }>> {
  const result = new Map<string, { totalCents: number; count: number }>();
  if (memberIds.length === 0) return result;

  const rows = await db
    .select({
      jarId: financialTransactions.jarId,
      total: sql<string>`coalesce(sum(${ledgerEntries.amountCents}), 0)`,
      count: sql<string>`count(*)`,
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
        inArray(financialTransactions.memberId, memberIds),
        inArray(financialTransactions.transactionType, [...PRINCIPAL_ORIGIN_TRANSACTION_TYPES]),
      ),
    )
    .innerJoin(
      ledgerAccounts,
      and(
        eq(ledgerEntries.accountId, ledgerAccounts.id),
        eq(ledgerAccounts.code, "CTRB_REFUNDABLE"),
      ),
    )
    .where(eq(ledgerEntries.entryType, "credit"))
    .groupBy(financialTransactions.jarId);

  for (const row of rows) {
    result.set(row.jarId, { totalCents: Number(row.total), count: Number(row.count) });
  }
  return result;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Every jar the caller has joined, with their own money in each.
 *
 * Sorted most-recent-target-date first so upcoming goals lead and finished ones
 * fall to the bottom.
 *
 * ─── WHY THIS IS NOT PAGINATED, AND CONTRIBUTIONS ARE ────────────────────────
 *
 * The two lists grow for different reasons. Contribution rows accumulate on
 * their own: one weekly AutoDrip adds ~52 rows a year to a single jar, forever,
 * with no action from anyone. Membership rows require a human to be invited to
 * a jar and accept, once per jar. That is a hard practical ceiling in the tens,
 * and it does not grow with time — a jar the caller joined in 2027 contributes
 * exactly one row in 2045, while its contributions contribute nine hundred.
 *
 * The cost per row differs too: one row here is one `getMemberFinancialBalance`
 * call. That is an N+1, and it is a deliberate trade. The alternative — one
 * grouped query over all the caller's memberships — would make `reconciles`
 * self-referential: it exists precisely to cross-check the credit sum against
 * the canonical balance service, and cross-checking a number against itself
 * proves nothing. A bounded N+1 that preserves a real invariant check is worth
 * more than an unbounded-looking optimisation that quietly removes one.
 *
 * If membership counts ever become large enough to matter, this takes the same
 * keyset model as `getUserContributionPage` — the ordering key would be
 * (targetDate DESC, jarId DESC).
 */
export async function getUserJarHistory(userId: string): Promise<MemberJarHistoryEntry[]> {
  const memberships = await getUserMemberships(userId);
  if (memberships.length === 0) return [];

  const jarIds = [...new Set(memberships.map((m) => m.jarId))];
  const jarRows = await db.select().from(jars).where(inArray(jars.id, jarIds));
  const jarById = new Map(jarRows.map((j) => [j.id, j]));

  const credits = await aggregateContributionCredits(memberships.map((m) => m.memberId));

  const entries = await Promise.all(
    memberships.map(async (m): Promise<MemberJarHistoryEntry | null> => {
      const jar = jarById.get(m.jarId);
      if (!jar) return null; // jar deleted out from under the membership

      const credit = credits.get(m.jarId) ?? { totalCents: 0, count: 0 };

      // Cross-check against the canonical per-member balance service. Both read
      // the ledger, so they agree except in the known financial_transactions ↔
      // ledger_transactions non-1:1 cases — which is precisely what `reconciles`
      // is here to surface.
      const balance = await getMemberFinancialBalance(m.jarId, m.memberId, jar.currency);

      return {
        jarId: jar.id,
        name: jar.name,
        category: jar.category ?? null,
        status: jar.status,
        targetDate: jar.targetDate,
        targetDatePrecision: jar.targetDatePrecision,
        goalAmountCents: jar.goalAmountCents,
        currency: jar.currency,
        role: m.role,
        membershipStatus: m.status,
        joinedAt: m.joinedAt,
        lifetimeContributedPrincipalCents: credit.totalCents,
        currentlySavedPrincipalCents:
          balance.refundablePrincipalCents + balance.committedPrincipalCents,
        refundedPrincipalCents: balance.refundedPrincipalCents,
        contributionCount: credit.count,
        reconciles: credit.totalCents === balance.contributedPrincipalCents,
      };
    }),
  );

  const present = entries.filter((e): e is MemberJarHistoryEntry => e !== null);
  present.sort((a, b) => (a.targetDate < b.targetDate ? 1 : a.targetDate > b.targetDate ? -1 : 0));
  return present;
}

// ─── Contribution history pagination ─────────────────────────────────────────
//
// A jar with a weekly AutoDrip produces ~52 rows a year per member. Over the
// life of a long-horizon jar — an eighteen-year college fund is the case this
// product explicitly supports — one member can accumulate several hundred rows
// in a single jar, and the total across jars has no ceiling at all. A fixed cap
// is therefore not a safe simplification: it is a promise the product cannot
// keep, and the version of this endpoint that shipped with a 500-row cap would
// silently stop showing a member their own money.
//
// OFFSET pagination is not used. Rows are ordered newest-first, and new
// contributions arrive at the front, so any page fetched after a new row lands
// would repeat a row the reader has already seen — the classic offset drift.
// Keyset (cursor) pagination anchors on a position in the ordering instead, so
// inserts at the front cannot shift a page already in flight.
//
// The sort key is (createdAt DESC, ledgerEntryId DESC). `createdAt` alone is
// NOT unique: a single AutoDrip batch, or two contributions posted in the same
// transaction, can share a timestamp to the microsecond, and without a unique
// tie-breaker the boundary between two pages is undefined — the same row can be
// returned twice or skipped entirely depending on how the planner happens to
// order the tie. The ledger entry id is unique and immutable, which makes the
// total ordering deterministic.

/** Default rows per page. */
export const CONTRIBUTION_PAGE_DEFAULT = 50;
/** Ceiling on rows per page, regardless of what the caller asks for. */
export const CONTRIBUTION_PAGE_MAX = 200;

export interface ContributionPage {
  entries: ContributionHistoryEntry[];
  /** Opaque cursor for the next page, or null when this is the last page. */
  nextCursor: string | null;
  hasMore: boolean;
}

interface DecodedCursor {
  occurredAt: Date;
  entryId: string;
}

/**
 * Encode a position in the ordering.
 *
 * Opaque by contract: callers must round-trip it verbatim and must not parse
 * it. It encodes a timestamp and one of the caller's OWN ledger entry ids —
 * which identifies nothing the caller cannot already see, and which no endpoint
 * accepts as input — so a decoded cursor grants no access. Treating it as
 * opaque is about keeping the pagination key free to change, not secrecy.
 */
function encodeCursor(occurredAt: Date, entryId: string): string {
  return Buffer.from(`${occurredAt.toISOString()}|${entryId}`, "utf8").toString("base64url");
}

/**
 * Decode a cursor, or return null if it is malformed.
 *
 * A bad cursor is rejected by the route rather than silently treated as "start
 * from the beginning", which would send a reader back to page one mid-scroll
 * and duplicate everything they had already loaded.
 */
export function decodeCursor(cursor: string): DecodedCursor | null {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const separator = decoded.lastIndexOf("|");
  if (separator <= 0) return null;

  const occurredAt = new Date(decoded.slice(0, separator));
  const entryId = decoded.slice(separator + 1);
  if (Number.isNaN(occurredAt.getTime()) || entryId.length === 0) return null;
  // The id half is compared against a uuid column; a non-uuid would be a
  // database-level type error rather than an empty page.
  if (!/^[0-9a-fA-F-]{36}$/.test(entryId)) return null;

  return { occurredAt, entryId };
}

/**
 * One page of the caller's contributions, newest first.
 *
 * Every row is a `CTRB_REFUNDABLE` credit from a principal-origin transaction —
 * the same postings the lifetime summary is computed from, just ungrouped and
 * windowed. The summary is deliberately NOT derived from the page: it spans the
 * caller's complete ledger history regardless of how few rows are being
 * displayed, so paginating cannot make the headline figure shrink.
 */
export async function getUserContributionPage(
  userId: string,
  options: { limit?: number; cursor?: DecodedCursor | null } = {},
): Promise<ContributionPage> {
  const limit = Math.min(
    Math.max(1, Math.floor(options.limit ?? CONTRIBUTION_PAGE_DEFAULT)),
    CONTRIBUTION_PAGE_MAX,
  );

  const memberships = await getUserMemberships(userId);
  if (memberships.length === 0) return { entries: [], nextCursor: null, hasMore: false };

  const memberIds = memberships.map((m) => m.memberId);
  const cursor = options.cursor ?? null;

  // Fetch one more row than requested. Its existence is what proves there is a
  // next page; counting the whole history to answer "hasMore" would defeat the
  // point of paginating.
  const rows = await db
    .select({
      entryId: ledgerEntries.id,
      amountCents: ledgerEntries.amountCents,
      currency: ledgerEntries.currency,
      jarId: financialTransactions.jarId,
      jarName: jars.name,
      transactionType: financialTransactions.transactionType,
      occurredAt: financialTransactions.createdAt,
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
        inArray(financialTransactions.memberId, memberIds),
        inArray(financialTransactions.transactionType, [...PRINCIPAL_ORIGIN_TRANSACTION_TYPES]),
      ),
    )
    .innerJoin(
      ledgerAccounts,
      and(
        eq(ledgerEntries.accountId, ledgerAccounts.id),
        eq(ledgerAccounts.code, "CTRB_REFUNDABLE"),
      ),
    )
    .innerJoin(jars, eq(financialTransactions.jarId, jars.id))
    .where(
      and(
        eq(ledgerEntries.entryType, "credit"),
        // Row-value comparison, which is exactly the keyset predicate: strictly
        // "after" the cursor in (createdAt DESC, id DESC) order. Writing it as
        // `createdAt <= c1 AND (createdAt < c1 OR id < c2)` would be equivalent
        // but far easier to get subtly wrong.
        ...(cursor
          ? [
              sql`(${financialTransactions.createdAt}, ${ledgerEntries.id}) < (${cursor.occurredAt}, ${cursor.entryId}::uuid)`,
            ]
          : []),
      ),
    )
    .orderBy(desc(financialTransactions.createdAt), desc(ledgerEntries.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  return {
    entries: page.map((r) => ({
      jarId: r.jarId,
      jarName: r.jarName,
      principalCents: Number(r.amountCents),
      currency: r.currency,
      transactionType: r.transactionType,
      occurredAt: r.occurredAt,
    })),
    nextCursor: hasMore && last ? encodeCursor(last.occurredAt, last.entryId) : null,
    hasMore,
  };
}

/**
 * The cross-jar totals the Profile screen shows.
 *
 * Derived by summing `getUserJarHistory`, not by a separate query, so the
 * headline number is arithmetically the same object as the drill-down. A
 * separate query would be faster and would eventually disagree.
 */
export async function getUserHistorySummary(userId: string): Promise<MemberHistorySummary> {
  const jarHistory = await getUserJarHistory(userId);

  return {
    lifetimeContributedPrincipalCents: jarHistory.reduce(
      (sum, j) => sum + j.lifetimeContributedPrincipalCents,
      0,
    ),
    currentlySavedPrincipalCents: jarHistory.reduce(
      (sum, j) => sum + j.currentlySavedPrincipalCents,
      0,
    ),
    refundedPrincipalCents: jarHistory.reduce((sum, j) => sum + j.refundedPrincipalCents, 0),
    jarCount: jarHistory.length,
    contributionCount: jarHistory.reduce((sum, j) => sum + j.contributionCount, 0),
    reconciles: jarHistory.every((j) => j.reconciles),
  };
}
