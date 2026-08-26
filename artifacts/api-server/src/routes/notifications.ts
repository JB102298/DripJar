/**
 * Notification read surface.
 *
 * ─── The rule this file enforces ────────────────────────────────────────────
 *
 * Every statement here is filtered by `notifications.user_id = req.userId`.
 * There is no route that can read, count, or mutate a notification the caller
 * does not own, and no route here writes anything except `is_read`.
 *
 * ─── Why the unread total is its own endpoint ───────────────────────────────
 *
 * The bottom-tab badge previously counted unread rows in the page the list
 * endpoint had already returned. That is not the unread total: the list is
 * capped (50 before this change, `MAX_LIMIT` now), so a caller with more unread
 * notifications than one page saw a badge pinned at the cap, and once the first
 * page was read the badge read 0 while unread rows remained behind it.
 *
 * The exact total already existed, but only inside `GET /dashboard`
 * (`unreadNotifications`) — a payload that runs a dozen queries and is scoped to
 * a featured jar. Making the badge depend on it would have coupled a tab-bar
 * count to the Home screen's whole data model. `GET /notifications/unread-count`
 * is the smallest caller-scoped addition that gives the badge a true number:
 * one indexed COUNT, no joins, no enrichment.
 *
 * `GET /dashboard.unreadNotifications` is left exactly as it was. Both read the
 * same predicate, so they cannot disagree.
 *
 * ─── Ordering is stable ─────────────────────────────────────────────────────
 *
 * `created_at DESC` alone is not a total order. `notifyAllMembers` inserts a
 * batch concurrently and jar lifecycle routes emit several rows inside one
 * request, so ties are reachable — and a tie makes the row that lands on a page
 * boundary undefined, which under pagination means a row can be shown twice or
 * skipped. `id DESC` breaks every tie deterministically.
 *
 * ─── Reading never creates ──────────────────────────────────────────────────
 *
 * No route in this file calls `createNotification`, `notifyAllMembers`, or
 * `emitNotificationOnce`, and none touches any financial table. Listing,
 * counting, and marking read are side-effect-free with respect to notification
 * generation.
 */

import { Router } from "express";
import { db } from "@workspace/db";
import { notifications, jars } from "@workspace/db";
import { eq, and, desc, inArray, sql } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../lib/auth.js";

const router = Router();

/**
 * Page size ceiling. Matches the previous hard-coded `limit(50)` as the
 * default, so an existing caller that sends no parameters gets byte-identical
 * behaviour, while a caller that asks for more is bounded rather than trusted.
 */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * `notifications.id` is a uuid column. A malformed path parameter reaches
 * Postgres as an invalid-text-representation error (22P02) and surfaces as a
 * 500, which both leaks an internal failure and is the wrong answer: a caller
 * asking for an id that cannot exist has not found a notification.
 */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Clamp a query-string integer, falling back when absent or unparseable. */
function boundedInt(raw: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

type NotificationRow = typeof notifications.$inferSelect;

/**
 * Attach `relatedJarName` to a page of rows with ONE query rather than one per
 * row. The previous implementation issued a SELECT per notification inside a
 * `Promise.all`, so a full page opened 50 round trips against `jars`.
 */
async function withJarNames(rows: readonly NotificationRow[]) {
  const jarIds = [...new Set(rows.map((r) => r.relatedJarId).filter((id): id is string => !!id))];

  const jarNameById = new Map<string, string>();
  if (jarIds.length > 0) {
    const named = await db
      .select({ id: jars.id, name: jars.name })
      .from(jars)
      .where(inArray(jars.id, jarIds));
    for (const j of named) jarNameById.set(j.id, j.name);
  }

  return rows.map((n) => ({
    id: n.id,
    userId: n.userId,
    type: n.type,
    title: n.title,
    message: n.message,
    isRead: n.isRead,
    relatedJarId: n.relatedJarId,
    relatedJarName: n.relatedJarId ? (jarNameById.get(n.relatedJarId) ?? null) : null,
    actionUrl: n.actionUrl,
    createdAt: n.createdAt,
  }));
}

// GET /notifications
router.get("/notifications", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const { unreadOnly } = req.query as { unreadOnly?: string };

  const limit = boundedInt(req.query["limit"], DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = boundedInt(req.query["offset"], 0, 0, Number.MAX_SAFE_INTEGER);

  const whereClause =
    unreadOnly === "true"
      ? and(eq(notifications.userId, userId), eq(notifications.isRead, false))
      : eq(notifications.userId, userId);

  const rows = await db
    .select()
    .from(notifications)
    .where(whereClause)
    // See the module header: the id tiebreaker is what makes paging safe.
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(limit)
    .offset(offset);

  res.json(await withJarNames(rows));
});

// GET /notifications/unread-count
//
// Declared before no path-parameter GET route, so there is nothing for
// `unread-count` to be captured by. Deliberately returns only a number: this is
// the badge's entire data dependency and it must not grow into a second list.
router.get("/notifications/unread-count", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;

  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.isRead, false)));

  res.json({ unreadCount: Number(row?.count ?? 0) });
});

// PATCH /notifications/:notificationId/read
//
// Idempotent by construction: the predicate matches on identity and ownership
// only, never on `is_read`, so the second call updates the same row to the same
// value and returns the same body. A notification belonging to another user
// matches nothing and is answered 404 — the same answer as an id that does not
// exist, so the response cannot be used to probe for other users' rows.
router.patch("/notifications/:notificationId/read", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const { notificationId } = req.params as { notificationId: string };

  if (!UUID_RE.test(notificationId)) {
    res.status(404).json({ error: "NotFound", message: "Notification not found" });
    return;
  }

  const [updated] = await db
    .update(notifications)
    .set({ isRead: true })
    .where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId)))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "NotFound", message: "Notification not found" });
    return;
  }

  // Resolved rather than hard-coded null. The list endpoint populates this
  // field, so a client that replaces a list row with this response previously
  // watched the jar name disappear on tap.
  const [enriched] = await withJarNames([updated]);
  res.json(enriched);
});

// POST /notifications/read-all
//
// Scoped to the caller and narrowed to rows that are actually unread, so a
// repeat call updates nothing and the operation is idempotent without relying
// on the write being harmless.
router.post("/notifications/read-all", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;

  await db
    .update(notifications)
    .set({ isRead: true })
    .where(and(eq(notifications.userId, userId), eq(notifications.isRead, false)));

  res.json({ message: "All notifications marked as read" });
});

export default router;
