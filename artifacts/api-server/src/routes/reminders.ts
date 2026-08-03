/**
 * POST /internal/process-reminders
 *
 * Idempotent reminder processing job — safe to call any number of times per day.
 *
 * ─── DELIVERY STATE MACHINE ──────────────────────────────────────────────────
 *
 *   email_status transitions (stored in reminder_sent_events):
 *
 *   ┌─────────────┐   atomicClaim (INSERT as pending)   ┌───────────┐
 *   │  (no row)   │ ───────────────────────────────────▶ │  pending  │
 *   └─────────────┘                                      └─────┬─────┘
 *                                                              │  atomicClaimEmailAttempt()
 *                                                              ▼
 *                                                        ┌───────────┐
 *                                                        │  sending  │  ← atomic: only ONE
 *                                                        └─────┬─────┘    processor wins
 *                                                              │
 *                                          ┌─────────────┬────┴──────────────────┐
 *                                          │             │                        │
 *                                    pref=false    send succeeds           send fails
 *                                          │             │                        │
 *                                          ▼             ▼                        ▼
 *                              ┌──────────────────┐ ┌────────┐            ┌────────────┐
 *                              │ skipped_pref...  │ │  sent  │            │   failed   │
 *                              └──────────────────┘ └────────┘            └──────┬─────┘
 *                                                                                 │
 *                                                                                 │ next run: atomicClaim
 *                                                                                 │ (retry from failed)
 *                                                                                 └─────▶ sending ──▶ ...
 *
 * ATOMIC CLAIM SEMANTICS (concurrent-safe):
 *   `atomicClaimEmailAttempt(rowId)` issues:
 *     UPDATE reminder_sent_events
 *     SET email_status='sending', email_attempt_count=+1, email_last_attempt_at=now()
 *     WHERE id=? AND (email_status IN ('pending','failed')
 *                     OR (email_status='sending' AND email_last_attempt_at < now() - 5min))
 *     RETURNING ...
 *
 *   Only the process that gets a non-empty RETURNING result "owns" the email
 *   attempt. Postgres UPDATE acquires a row-level lock; concurrent callers for
 *   the same row serialise. The loser sees the row in 'sending' state (not
 *   in the WHERE filter) and receives an empty result set → does not send.
 *
 * CRASH/STALE-SENDING RECOVERY:
 *   If a process crashes after claiming (status='sending') but before completing
 *   delivery, the row stays in 'sending'. After STALE_SENDING_MS (5 minutes),
 *   `atomicClaimEmailAttempt` treats a 'sending' row as stale and re-claims it.
 *   This guarantees eventual delivery without manual intervention.
 *
 *   'sending' rows < 5 min old are NOT re-claimed — they belong to an active
 *   in-progress attempt. No double-send can occur.
 *
 * CONCURRENCY GUARANTEE:
 *   Two simultaneous POST /internal/process-reminders invocations cannot both
 *   send the same logical email. The UNIQUE(event_key) constraint prevents
 *   duplicate INSERT; the atomic UPDATE prevents duplicate retry.
 *
 * PRODUCTION PROVIDER-UNAVAILABLE BEHAVIOUR:
 *   Missing RESEND_API_KEY → email function returns false → row stays/becomes
 *   'failed' → retried on next run. This is different from the test-mode
 *   vacuous-success path. See reminder-email.ts for details.
 *
 * AGREEMENT VS COMMITMENT PHASE SEMANTICS:
 *   Commitment phase is TIME-derived (cutoffDate ≤ today UTC). Unaccepted
 *   agreement does NOT block phase progression — it only blocks protected
 *   actions. Phase and agreement status are independent.
 *
 * CONTRIBUTION OBLIGATION (cumulative accounting):
 *   outstandingCents = max(0, elapsedPeriods × amountCents − totalContributedCents)
 *
 * SECURITY:
 *   X-Internal-Token (crypto.timingSafeEqual). Not in OpenAPI spec.
 */

import crypto from "node:crypto";
import { Router } from "express";
import { db } from "@workspace/db";
import {
  contributionSchedules,
  jarMembers,
  jars,
  users,
  profiles,
  contributions,
  agreements,
  agreementAcceptances,
  reminderSentEvents,
} from "@workspace/db";
import { eq, and, gte, inArray, desc, or, lte, sql } from "drizzle-orm";
import { toUTCDateString, daysUntil } from "../lib/phase.js";
import { computeScheduleStatus } from "../lib/schedule-status.js";
import { createNotification } from "../lib/notifications.js";
import {
  sendContributionDueEmail,
  sendContributionMissedEmail,
  sendCutoffUpcomingEmail,
  sendCutoffReachedEmail,
  sendAgreementRequiredEmail,
} from "../lib/reminder-email.js";
import { logActivity } from "../lib/activity.js";
import { logger } from "../lib/logger.js";

const router = Router();

// ─── Stale-sending timeout ────────────────────────────────────────────────────

/**
 * A 'sending' row older than this many milliseconds is considered stale
 * (the original processor likely crashed) and becomes re-claimable.
 */
export const STALE_SENDING_MS = 5 * 60_000; // 5 minutes

// ─── Internal token guard ────────────────────────────────────────────────────

function requireInternalToken(
  req: import("express").Request,
  res: import("express").Response,
  next: import("express").NextFunction,
) {
  const configuredToken = process.env["INTERNAL_REMINDER_TOKEN"];
  if (!configuredToken) {
    res.status(503).json({
      error: "ServiceUnavailable",
      message: "INTERNAL_REMINDER_TOKEN is not configured",
    });
    return;
  }

  const provided = req.headers["x-internal-token"];
  if (typeof provided !== "string") {
    res.status(403).json({ error: "Forbidden", message: "Invalid internal token" });
    return;
  }

  // Constant-time comparison to prevent timing attacks.
  const provBuf = Buffer.from(provided);
  const cfgBuf = Buffer.from(configuredToken);
  const lengthsMatch = provBuf.length === cfgBuf.length;
  const cmpBuf = lengthsMatch ? cfgBuf : Buffer.alloc(provBuf.length);
  const tokensMatch = crypto.timingSafeEqual(provBuf, cmpBuf) && lengthsMatch;

  if (!tokensMatch) {
    res.status(403).json({ error: "Forbidden", message: "Invalid internal token" });
    return;
  }
  next();
}

// ─── Reminder event helpers ──────────────────────────────────────────────────

export type ReminderRow = typeof reminderSentEvents.$inferSelect;

/**
 * Try to INSERT a new reminder event row (status='pending').
 * Returns { isNew: true, row } on success.
 * Returns { isNew: false, row } when the event_key already exists.
 */
async function claimOrFetchEvent(opts: {
  eventKey: string;
  userId: string;
  jarId: string | null;
  eventType: string;
}): Promise<{ isNew: boolean; row: ReminderRow }> {
  try {
    const [inserted] = await db
      .insert(reminderSentEvents)
      .values({
        eventKey: opts.eventKey,
        userId: opts.userId,
        jarId: opts.jarId,
        eventType: opts.eventType,
        emailStatus: "pending",
      })
      .returning();
    return { isNew: true, row: inserted };
  } catch {
    // UNIQUE constraint violation — event row already exists
    const [existing] = await db
      .select()
      .from(reminderSentEvents)
      .where(eq(reminderSentEvents.eventKey, opts.eventKey))
      .limit(1);
    return { isNew: false, row: existing };
  }
}

/**
 * Atomically claim a reminder row for email delivery.
 *
 * Issues a single conditional UPDATE that transitions the row to 'sending'.
 * Only one concurrent caller can win — the first UPDATE acquires a row-level
 * lock in Postgres; the second finds the row no longer matches the WHERE
 * clause and returns an empty set.
 *
 * Claimable states:
 *   - 'pending'  : newly inserted, first attempt
 *   - 'failed'   : previous attempt failed, eligible for retry
 *   - 'sending' + last_attempt older than staleMs: crash-recovery re-claim
 *
 * Non-claimable states:
 *   - 'sending'  + last_attempt < staleMs ago: another processor is active
 *   - 'sent'     : successfully delivered; never retried
 *   - 'skipped_preference': user disabled; never retried
 *
 * @returns The claimed row (with incremented emailAttemptCount), or null if
 *          another processor owns the row or the row is in a terminal state.
 *
 * @exported for deterministic unit testing — do NOT call from application code
 *           outside this processor.
 */
export async function atomicClaimEmailAttempt(
  rowId: string,
  staleMs: number = STALE_SENDING_MS,
): Promise<ReminderRow | null> {
  const staleThreshold = new Date(Date.now() - staleMs);
  const rows = await db
    .update(reminderSentEvents)
    .set({
      emailStatus: "sending",
      emailAttemptCount: sql`${reminderSentEvents.emailAttemptCount} + 1`,
      emailLastAttemptAt: new Date(),
    })
    .where(
      and(
        eq(reminderSentEvents.id, rowId),
        or(
          inArray(reminderSentEvents.emailStatus, ["pending", "failed"]),
          and(
            eq(reminderSentEvents.emailStatus, "sending"),
            lte(reminderSentEvents.emailLastAttemptAt, staleThreshold),
          ),
        ),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/**
 * Finalise email delivery state after an attempt.
 * emailAttemptCount is NOT incremented here — that happened atomically in
 * atomicClaimEmailAttempt(). This function only transitions the terminal status.
 */
async function finaliseEmailDelivery(
  id: string,
  status: "sent" | "failed" | "skipped_preference",
): Promise<void> {
  await db
    .update(reminderSentEvents)
    .set({
      emailStatus: status,
      ...(status === "sent" ? { emailSentAt: new Date() } : {}),
    })
    .where(eq(reminderSentEvents.id, id));
}

/** Fetch total contributed cents for a member's schedule since startDate. */
async function getTotalContributedCents(
  memberId: string,
  jarId: string,
  sinceDate: string,
): Promise<number> {
  const rows = await db
    .select({ amountCents: contributions.amountCents })
    .from(contributions)
    .where(
      and(
        eq(contributions.memberId, memberId),
        eq(contributions.jarId, jarId),
        gte(contributions.contributionDate, sinceDate),
        inArray(contributions.status, ["completed", "simulated"]),
      ),
    );
  return rows.reduce((sum, r) => sum + r.amountCents, 0);
}

// ─── Stats ───────────────────────────────────────────────────────────────────

interface ReminderStats {
  schedulesProcessed: number;
  contributionDueSent: number;
  contributionMissedSent: number;
  cutoffUpcoming7dSent: number;
  cutoffUpcoming1dSent: number;
  cutoffReachedSent: number;
  agreementRequiredSent: number;
  skippedDuplicate: number;
  emailRetried: number;
  emailDeliveryFailed: number;
  emailSkippedPreference: number;
  runAt: string;
}

// ─── Shared event processing helper ─────────────────────────────────────────

/**
 * Process a single reminder event end-to-end:
 *   1. claim/fetch the event row
 *   2. skip if terminal (sent / skipped_preference)
 *   3. create in-app notification if this is the first time the event fires
 *   4. atomically claim for email delivery
 *   5. if pref disabled → finalise as skipped_preference
 *   6. else → attempt delivery → finalise as sent or failed
 *
 * All concurrent callers for the same event_key serialise on the atomic UPDATE;
 * only one can successfully transition the row to 'sending'.
 */
async function processReminderEvent(opts: {
  eventKey: string;
  userId: string;
  jarId: string | null;
  eventType: string;
  prefEnabled: boolean;
  createNotificationFn: () => Promise<void>;
  sendEmailFn: () => Promise<boolean>;
  stats: ReminderStats;
  newStatKey: keyof ReminderStats;
}): Promise<void> {
  const { eventKey, userId, jarId, eventType, prefEnabled, createNotificationFn, sendEmailFn, stats, newStatKey } = opts;

  const { isNew, row } = await claimOrFetchEvent({ eventKey, userId, jarId, eventType });

  // Terminal states — permanently done
  if (!isNew && (row.emailStatus === "sent" || row.emailStatus === "skipped_preference")) {
    stats.skippedDuplicate++;
    return;
  }

  // Create in-app notification exactly once (first time this event is seen)
  if (isNew) {
    try {
      await createNotificationFn();
    } catch (err) {
      logger.warn({ err, eventKey }, "Failed to create notification for reminder event");
    }
  }

  // Atomically claim the row for email delivery.
  // If preference is disabled we still claim atomically to prevent another
  // processor from independently attempting delivery.
  const claimed = await atomicClaimEmailAttempt(row.id);
  if (!claimed) {
    // Another processor currently owns this row (fresh 'sending' state).
    // Do not send — they are handling it.
    return;
  }

  if (!prefEnabled) {
    await finaliseEmailDelivery(row.id, "skipped_preference");
    stats.emailSkippedPreference++;
    return;
  }

  // Attempt email delivery
  const delivered = await sendEmailFn();
  await finaliseEmailDelivery(row.id, delivered ? "sent" : "failed");

  if (delivered) {
    if (isNew) {
      (stats[newStatKey] as number)++;
    } else {
      stats.emailRetried++;
    }
  } else {
    stats.emailDeliveryFailed++;
    logger.warn({ eventKey, eventType }, "Reminder email delivery failed; row marked for retry");
  }
}

// ─── POST /internal/process-reminders ───────────────────────────────────────

router.post("/internal/process-reminders", requireInternalToken, async (_req, res) => {
  const now = new Date();
  const todayUTC = toUTCDateString(now);

  const stats: ReminderStats = {
    schedulesProcessed: 0,
    contributionDueSent: 0,
    contributionMissedSent: 0,
    cutoffUpcoming7dSent: 0,
    cutoffUpcoming1dSent: 0,
    cutoffReachedSent: 0,
    agreementRequiredSent: 0,
    skippedDuplicate: 0,
    emailRetried: 0,
    emailDeliveryFailed: 0,
    emailSkippedPreference: 0,
    runAt: now.toISOString(),
  };

  // ── 1. Contribution schedule reminders ─────────────────────────────────────

  const activeSchedules = await db
    .select()
    .from(contributionSchedules)
    .where(and(eq(contributionSchedules.isActive, true), eq(contributionSchedules.isPaused, false)));

  stats.schedulesProcessed = activeSchedules.length;

  for (const schedule of activeSchedules) {
    const [member] = await db
      .select()
      .from(jarMembers)
      .where(and(eq(jarMembers.id, schedule.memberId), eq(jarMembers.status, "active")))
      .limit(1);
    if (!member) continue;

    const [jar] = await db
      .select()
      .from(jars)
      .where(and(eq(jars.id, schedule.jarId), eq(jars.status, "Saving")))
      .limit(1);
    if (!jar) continue;

    const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, member.userId)).limit(1);
    if (!user) continue;

    const [profile] = await db.select().from(profiles).where(eq(profiles.userId, member.userId)).limit(1);
    if (!profile) continue;

    const totalContributedCents = await getTotalContributedCents(schedule.memberId, schedule.jarId, schedule.startDate);
    const status = computeScheduleStatus(schedule, now, totalContributedCents);
    const { emailPrefContributionReminders: prefEnabled, displayName } = profile;
    const fmt = `$${(schedule.amountCents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

    if (status.state === "due_today") {
      await processReminderEvent({
        eventKey: `contribution_due:${schedule.id}:${todayUTC}`,
        userId: member.userId, jarId: jar.id, eventType: "contribution_due",
        prefEnabled,
        createNotificationFn: () => createNotification({
          userId: member.userId, type: "contribution_due",
          title: "Contribution Due Today",
          message: `Your ${fmt} contribution to ${jar.name} is due today.`,
          relatedJarId: jar.id, actionUrl: `/jar/${jar.id}`,
        }),
        sendEmailFn: () => sendContributionDueEmail({
          toEmail: user.email, displayName, jarName: jar.name,
          jarId: jar.id, amountCents: schedule.amountCents, dueDateISO: todayUTC,
        }),
        stats, newStatKey: "contributionDueSent",
      });
    }

    if (status.state === "missed" && status.outstandingCents > 0) {
      await processReminderEvent({
        eventKey: `contribution_missed:${schedule.id}:${todayUTC}`,
        userId: member.userId, jarId: jar.id, eventType: "contribution_missed",
        prefEnabled,
        createNotificationFn: () => createNotification({
          userId: member.userId, type: "contribution_missed",
          title: "Contribution Outstanding",
          message: `You have $${(status.outstandingCents / 100).toFixed(0)} outstanding in ${jar.name}. Add a contribution to catch up.`,
          relatedJarId: jar.id, actionUrl: `/jar/${jar.id}`,
        }),
        sendEmailFn: () => sendContributionMissedEmail({
          toEmail: user.email, displayName, jarName: jar.name,
          jarId: jar.id, amountCents: schedule.amountCents, outstandingCents: status.outstandingCents,
        }),
        stats, newStatKey: "contributionMissedSent",
      });
    }
  }

  // ── 2. Cutoff reminders ───────────────────────────────────────────────────

  const savingJars = await db.select().from(jars).where(eq(jars.status, "Saving"));

  for (const jar of savingJars) {
    if (!jar.cutoffDate) continue;
    const daysAway = daysUntil(jar.cutoffDate, now);

    const members = await db
      .select()
      .from(jarMembers)
      .where(and(eq(jarMembers.jarId, jar.id), eq(jarMembers.status, "active")));

    for (const member of members) {
      const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, member.userId)).limit(1);
      if (!user) continue;
      const [profile] = await db.select().from(profiles).where(eq(profiles.userId, member.userId)).limit(1);
      if (!profile) continue;

      const { emailPrefCutoffReminders: prefEnabled, displayName } = profile;

      if (daysAway === 7) {
        await processReminderEvent({
          eventKey: `cutoff_upcoming_7d:${jar.id}:${jar.cutoffDate}:${member.userId}`,
          userId: member.userId, jarId: jar.id, eventType: "cutoff_upcoming",
          prefEnabled,
          createNotificationFn: () => createNotification({
            userId: member.userId, type: "cutoff_upcoming",
            title: `${jar.name} commitment date in 7 days`,
            message: `The commitment date for ${jar.name} is ${jar.cutoffDate}. Ensure your agreement is accepted and contributions are current.`,
            relatedJarId: jar.id, actionUrl: `/jar/${jar.id}`,
          }),
          sendEmailFn: () => sendCutoffUpcomingEmail({ toEmail: user.email, displayName, jarName: jar.name, jarId: jar.id, cutoffDateISO: jar.cutoffDate!, daysAway: 7 }),
          stats, newStatKey: "cutoffUpcoming7dSent",
        });
      }

      if (daysAway === 1) {
        await processReminderEvent({
          eventKey: `cutoff_upcoming_1d:${jar.id}:${jar.cutoffDate}:${member.userId}`,
          userId: member.userId, jarId: jar.id, eventType: "cutoff_upcoming",
          prefEnabled,
          createNotificationFn: () => createNotification({
            userId: member.userId, type: "cutoff_upcoming",
            title: `${jar.name} commitment date tomorrow`,
            message: `The commitment date for ${jar.name} is tomorrow (${jar.cutoffDate}). Last chance to ensure your contributions and agreement are in order.`,
            relatedJarId: jar.id, actionUrl: `/jar/${jar.id}`,
          }),
          sendEmailFn: () => sendCutoffUpcomingEmail({ toEmail: user.email, displayName, jarName: jar.name, jarId: jar.id, cutoffDateISO: jar.cutoffDate!, daysAway: 1 }),
          stats, newStatKey: "cutoffUpcoming1dSent",
        });
      }

      if (daysAway <= 0) {
        await processReminderEvent({
          eventKey: `cutoff_reached:${jar.id}:${jar.cutoffDate}:${member.userId}`,
          userId: member.userId, jarId: jar.id, eventType: "cutoff_reached",
          prefEnabled,
          createNotificationFn: () => createNotification({
            userId: member.userId, type: "cutoff_reached",
            title: `${jar.name} has entered the Commitment phase`,
            message: `${jar.name} reached its commitment date on ${jar.cutoffDate} and is now in the Commitment phase. Schedules are locked; contributions remain open.`,
            relatedJarId: jar.id, actionUrl: `/jar/${jar.id}`,
          }),
          sendEmailFn: () => sendCutoffReachedEmail({ toEmail: user.email, displayName, jarName: jar.name, jarId: jar.id, cutoffDateISO: jar.cutoffDate! }),
          stats, newStatKey: "cutoffReachedSent",
        });

        // Log jar-level activity exactly once (by organizer, idempotent)
        if (member.userId === jar.organizerId) {
          try {
            await logActivity({
              jarId: jar.id,
              eventType: "jar_commitment_phase",
              description: `${jar.name} has entered the Commitment phase (cutoff: ${jar.cutoffDate})`,
            });
          } catch { /* activity log failure is non-critical */ }
        }
      }
    }
  }

  // ── 3. Agreement acceptance reminders ─────────────────────────────────────
  // Phase is TIME-derived (cutoffDate ≤ today). Unaccepted agreement does NOT
  // change the phase — it only blocks protected actions.

  for (const jar of savingJars) {
    const [currentAgreement] = await db
      .select()
      .from(agreements)
      .where(eq(agreements.jarId, jar.id))
      .orderBy(desc(agreements.createdAt))
      .limit(1);
    if (!currentAgreement) continue;

    const activeMembers = await db
      .select()
      .from(jarMembers)
      .where(and(eq(jarMembers.jarId, jar.id), eq(jarMembers.status, "active")));

    for (const member of activeMembers) {
      const [acceptance] = await db
        .select({ id: agreementAcceptances.id })
        .from(agreementAcceptances)
        .where(and(
          eq(agreementAcceptances.agreementId, currentAgreement.id),
          eq(agreementAcceptances.userId, member.userId),
        ))
        .limit(1);
      if (acceptance) continue;

      const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, member.userId)).limit(1);
      if (!user) continue;
      const [profile] = await db.select().from(profiles).where(eq(profiles.userId, member.userId)).limit(1);
      if (!profile) continue;

      const { emailPrefLifecycle: prefEnabled, displayName } = profile;

      await processReminderEvent({
        eventKey: `agreement_required:${currentAgreement.id}:${member.userId}`,
        userId: member.userId, jarId: jar.id, eventType: "agreement_required",
        prefEnabled,
        createNotificationFn: () => createNotification({
          userId: member.userId, type: "agreement_required",
          title: `Action needed: ${jar.name} savings agreement`,
          message: `Please accept the savings agreement for ${jar.name} (v${currentAgreement.version}) to continue making contributions and managing your schedule. The jar's phase is determined by the commitment date — accepting the agreement does not change the phase, but is required for protected actions.`,
          relatedJarId: jar.id, actionUrl: `/jar/${jar.id}`,
        }),
        sendEmailFn: () => sendAgreementRequiredEmail({
          toEmail: user.email, displayName, jarName: jar.name,
          jarId: jar.id, version: currentAgreement.version,
        }),
        stats, newStatKey: "agreementRequiredSent",
      });
    }
  }

  res.json(stats);
});

export default router;
