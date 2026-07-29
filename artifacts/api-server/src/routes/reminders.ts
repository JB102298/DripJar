/**
 * POST /internal/process-reminders
 *
 * Scans all active contribution schedules and creates in-app notifications for:
 *  - Contributions due today
 *  - Contributions that were due yesterday (missed)
 *
 * This endpoint is meant to be called by a scheduled job (cron / Replit scheduled deployment).
 * It is protected by a shared secret via the X-Internal-Token header.
 */

import { Router } from "express";
import { db } from "@workspace/db";
import {
  contributionSchedules,
  jarMembers,
  jars,
  users,
  contributions,
  notifications,
} from "@workspace/db";
import { eq, and, gte, lte, inArray } from "drizzle-orm";
import { computeNextDueDate, computePreviousDueDate, toISODate } from "../lib/schedule-utils.js";

const router = Router();

function requireInternalToken(req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) {
  const configuredToken = process.env["INTERNAL_REMINDER_TOKEN"];
  if (!configuredToken) {
    // Fail closed: if the secret is not configured, refuse all requests
    res.status(503).json({ error: "ServiceUnavailable", message: "INTERNAL_REMINDER_TOKEN is not configured" });
    return;
  }
  const token = req.headers["x-internal-token"];
  if (token !== configuredToken) {
    res.status(403).json({ error: "Forbidden", message: "Invalid internal token" });
    return;
  }
  next();
}

// POST /internal/process-reminders
router.post("/internal/process-reminders", requireInternalToken, async (_req, res) => {
  const today = new Date();
  const todayStr = toISODate(today);

  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = toISODate(yesterday);

  // Load all active, non-paused schedules
  const activeSchedules = await db
    .select()
    .from(contributionSchedules)
    .where(and(eq(contributionSchedules.isActive, true), eq(contributionSchedules.isPaused, false)));

  let notificationsCreated = 0;
  let missedCount = 0;

  for (const schedule of activeSchedules) {
    const nextDue = computeNextDueDate(schedule, today);
    const prevDue = computePreviousDueDate(schedule, today);

    // Resolve jar member → user
    const [member] = await db
      .select()
      .from(jarMembers)
      .where(eq(jarMembers.id, schedule.memberId))
      .limit(1);

    if (!member) continue;

    const [jar] = await db
      .select({ id: jars.id, name: jars.name })
      .from(jars)
      .where(eq(jars.id, schedule.jarId))
      .limit(1);

    if (!jar) continue;

    const formattedAmount = `$${(schedule.amountCents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

    // ── Due today: send reminder ──────────────────────────────────────────────
    if (nextDue && toISODate(nextDue) === todayStr) {
      // Check if we already sent this notification today
      const existing = await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, member.userId),
            eq(notifications.type, "contribution_due"),
            eq(notifications.relatedJarId, jar.id),
          ),
        )
        .limit(1);

      // Deduplicate: only insert once per (user, jar, day). We check if any due notification exists
      // created today. Simple approach: skip if any notification with type contribution_due created
      // in last 20 hours exists.
      const cutoff = new Date(today);
      cutoff.setHours(cutoff.getHours() - 20);

      const recentDue = await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, member.userId),
            eq(notifications.type, "contribution_due"),
            eq(notifications.relatedJarId, jar.id),
            gte(notifications.createdAt, cutoff),
          ),
        )
        .limit(1);

      if (!recentDue[0]) {
        await db.insert(notifications).values({
          userId: member.userId,
          type: "contribution_due",
          title: "Contribution Due Today",
          message: `Your ${formattedAmount} contribution to ${jar.name} is due today. Keep your savings on track!`,
          isRead: false,
          relatedJarId: jar.id,
          actionUrl: `/jar/${jar.id}`,
        });
        notificationsCreated++;
      }
    }

    // ── Due yesterday (missed): send missed notification ──────────────────────
    if (prevDue && toISODate(prevDue) === yesterdayStr) {
      // Check if a contribution was made on or within 1 day of the due date
      const windowStart = new Date(prevDue);
      windowStart.setDate(windowStart.getDate() - 1);
      const windowEnd = new Date(prevDue);
      windowEnd.setDate(windowEnd.getDate() + 1);

      const windowStartStr = toISODate(windowStart);
      const windowEndStr = toISODate(windowEnd);

      // Count contributions in the window
      const contribsInWindow = await db
        .select({ id: contributions.id })
        .from(contributions)
        .where(
          and(
            eq(contributions.memberId, schedule.memberId),
            eq(contributions.jarId, schedule.jarId),
            gte(contributions.contributionDate, windowStartStr),
            lte(contributions.contributionDate, windowEndStr),
            inArray(contributions.status, ["completed", "simulated"]),
          ),
        )
        .limit(1);

      if (!contribsInWindow[0]) {
        // Missed! Create notification (deduplicate)
        const cutoff = new Date(today);
        cutoff.setHours(cutoff.getHours() - 20);

        const recentMissed = await db
          .select({ id: notifications.id })
          .from(notifications)
          .where(
            and(
              eq(notifications.userId, member.userId),
              eq(notifications.type, "contribution_missed"),
              eq(notifications.relatedJarId, jar.id),
              gte(notifications.createdAt, cutoff),
            ),
          )
          .limit(1);

        if (!recentMissed[0]) {
          await db.insert(notifications).values({
            userId: member.userId,
            type: "contribution_missed",
            title: "Missed Contribution",
            message: `You missed your ${formattedAmount} contribution to ${jar.name} yesterday. Add funds to stay on track.`,
            isRead: false,
            relatedJarId: jar.id,
            actionUrl: `/jar/${jar.id}`,
          });
          notificationsCreated++;
          missedCount++;
        }
      }
    }
  }

  res.json({
    processed: activeSchedules.length,
    notificationsCreated,
    missedCount,
    runAt: today.toISOString(),
  });
});

export default router;
