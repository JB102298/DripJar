/**
 * Caller-scoped history endpoints.
 *
 * Both routes are authenticated and read only the caller's own data — every
 * figure is derived from ledger entries belonging to the caller's own
 * membership rows, so there is no jar-membership check to get wrong and no way
 * to widen the scope with a query parameter.
 *
 * Both responses carry the same `summary` object. That is not redundancy: the
 * Profile stat, the jar list, and the contribution list must show the same
 * lifetime figure, and shipping the total next to the rows it was computed from
 * means a mismatch is visible on the screen rather than only in a report. See
 * lib/member-history.ts for why the identity holds exactly.
 */
import { Router } from "express";
import { requireAuth, type AuthenticatedRequest } from "../lib/auth.js";
import {
  CONTRIBUTION_PAGE_DEFAULT,
  CONTRIBUTION_PAGE_MAX,
  decodeCursor,
  getUserContributionPage,
  getUserHistorySummary,
  getUserJarHistory,
} from "../lib/member-history.js";

const router = Router();

// GET /me/jars — every jar the caller has joined, with their own money in each
router.get("/me/jars", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;

  const [summary, jarHistory] = await Promise.all([
    getUserHistorySummary(userId),
    getUserJarHistory(userId),
  ]);

  res.json({ summary, jars: jarHistory });
});

// GET /me/contributions — the caller's contributions, newest first, paginated
//
// `?limit=` sets the page size (clamped) and `?cursor=` continues from a
// previous page's `pageInfo.nextCursor`. See lib/member-history.ts for why the
// ordering carries a unique tie-breaker and why offset paging is not used.
router.get("/me/contributions", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;

  const rawLimit = Number((req.query.limit as string | undefined) ?? CONTRIBUTION_PAGE_DEFAULT);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.floor(rawLimit), CONTRIBUTION_PAGE_MAX)
    : CONTRIBUTION_PAGE_DEFAULT;

  // A malformed cursor is rejected rather than ignored. Silently restarting
  // from the top would send a reader who is fifteen pages in back to page one
  // and duplicate everything they had already loaded — a wrong answer dressed
  // as a successful one.
  const rawCursor = req.query.cursor as string | undefined;
  let cursor = null;
  if (rawCursor !== undefined) {
    cursor = decodeCursor(rawCursor);
    if (!cursor) {
      res.status(400).json({
        error: "BadRequest",
        message: "cursor is not a valid pagination cursor. Omit it to start from the most recent contribution.",
      });
      return;
    }
  }

  const [summary, page] = await Promise.all([
    // Deliberately computed over the caller's complete canonical ledger
    // history, never over the visible page: the lifetime figure must not shrink
    // because the reader has only loaded the first fifty rows. Reconciliation
    // is therefore between the summary and the FULL history, which the client
    // reaches by following the cursor — not between the summary and one page.
    getUserHistorySummary(userId),
    getUserContributionPage(userId, { limit, cursor }),
  ]);

  res.json({
    summary,
    contributions: page.entries,
    pageInfo: {
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
      limit,
      /** Total rows behind the cursor chain, so a client can show "N of M". */
      totalCount: summary.contributionCount,
    },
  });
});

export default router;
