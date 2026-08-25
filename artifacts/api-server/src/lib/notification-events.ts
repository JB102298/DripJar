/**
 * Durable, exactly-once notification emission.
 *
 * ─── Why this exists ────────────────────────────────────────────────────────
 *
 * `createNotification` (lib/notifications.ts) is an unconditional INSERT. Every
 * caller that sits behind a retryable trigger — a Stripe webhook redelivery, a
 * worker retry, two concurrent deliveries of the same event — therefore writes
 * one row per attempt. `notifications` has no natural key and no unique index,
 * so the database cannot reject the duplicate either.
 *
 * The fix is an event identity that already exists in the schema.
 * `reminder_sent_events.event_key` carries `uniqueIndex("reminder_sent_events_key_idx")`
 * and the table is a general per-recipient event ledger (`event_key`, `user_id`,
 * `jar_id`, `event_type`) rather than anything reminder-specific. Phase 3 built
 * it as the dedup spine for scheduled reminders; the identity it provides is
 * exactly what financial notifications need, so this module reuses it rather
 * than adding a second table that would mean the same thing.
 *
 * NO MIGRATION IS REQUIRED. Every column used here already exists, the unique
 * index already exists, and `owner-reset.ts` already purges the table by user
 * and by owned jar, so the owner reset stays correct with no change.
 *
 * ─── Why the claim and the notification share one transaction ──────────────
 *
 * The alternatives both lose:
 *
 *   claim, then insert   → a crash between the two drops the notification for
 *                          ever; the claim blocks every retry.
 *   insert, then claim   → a crash between the two leaves the notification and
 *                          no claim, so the retry duplicates it.
 *
 * Wrapping both in one transaction makes the pair atomic: either the event is
 * claimed and the notification exists, or neither does and a retry re-runs
 * cleanly. `onConflictDoNothing` rather than a caught unique violation matters
 * here — a raised constraint error would abort the surrounding transaction and
 * take the caller's work down with it.
 *
 * This is deliberately NOT check-then-insert. The uniqueness decision is made
 * by the database inside the INSERT, so two concurrent callers with the same
 * key cannot both observe "absent" and both proceed.
 *
 * ─── Why `email_status` is 'skipped_preference' ─────────────────────────────
 *
 * Migration 0007 constrains the column:
 *
 *   CHECK (email_status IN ('pending','sending','sent','failed','skipped_preference'))
 *
 * so a semantically cleaner value like 'not_applicable' would need a migration
 * for no behavioural gain. Of the five permitted values only 'sent' and
 * 'skipped_preference' are terminal, and `atomicClaimEmailAttempt`
 * (routes/reminders.ts) claims exclusively 'pending', 'failed', and stale
 * 'sending'. Writing 'skipped_preference' therefore guarantees no email
 * processor can ever pick these rows up. Nothing scans the table for pending
 * work — every reader looks up a specific `event_key` — so the rows are inert
 * outside this module.
 *
 * These events are in-app only. No email, push, or SMS channel is attached to
 * any of them, and this module never sends one.
 *
 * ─── Never changes financial state ──────────────────────────────────────────
 *
 * This module reads nothing financial and writes only `reminder_sent_events`
 * and `notifications`. Callers invoke it AFTER their money transaction has
 * committed, never inside it, so a notification failure can never roll back a
 * ledger posting.
 */

import { db } from "@workspace/db";
import { notifications, reminderSentEvents } from "@workspace/db";
import { logger } from "./logger.js";
import type { NotificationType } from "./notifications.js";

/**
 * Terminal, non-claimable email state. See the module header for why this
 * specific value is used rather than a new one.
 */
const IN_APP_ONLY: string = "skipped_preference";

export interface NotificationEvent {
  /**
   * Deterministic identity for this notification. Two attempts that mean the
   * same thing must produce byte-identical keys; two that mean different
   * things must not collide.
   *
   * Built exclusively from immutable identifiers — see `notificationEventKey`.
   */
  eventKey: string;
  /** Coarse grouping stored on the event row. Not customer-visible. */
  eventType: string;
  /** Recipient. One event row per recipient, so keys are per-user. */
  userId: string;
  jarId: string | null;
  type: NotificationType;
  title: string;
  message: string;
  actionUrl?: string | null;
}

/**
 * Create a notification at most once for the given event identity.
 *
 * @returns `true` when this call created the notification, `false` when the
 *          event had already been emitted. Callers may ignore the result; it
 *          exists for tests and for logging, never for control flow that
 *          affects money.
 */
export async function emitNotificationOnce(event: NotificationEvent): Promise<boolean> {
  try {
    return await db.transaction(async (tx) => {
      const claimed = await tx
        .insert(reminderSentEvents)
        .values({
          eventKey: event.eventKey,
          userId: event.userId,
          jarId: event.jarId,
          eventType: event.eventType,
          emailStatus: IN_APP_ONLY,
        })
        .onConflictDoNothing({ target: reminderSentEvents.eventKey })
        .returning({ id: reminderSentEvents.id });

      // Already emitted — by a previous delivery, a retry, or the concurrent
      // caller that won the unique index a moment ago.
      if (claimed.length === 0) return false;

      await tx.insert(notifications).values({
        userId: event.userId,
        type: event.type,
        title: event.title,
        message: event.message,
        relatedJarId: event.jarId,
        actionUrl: event.actionUrl ?? null,
        isRead: false,
      });

      return true;
    });
  } catch (err) {
    // Notification delivery is not allowed to fail a caller that has already
    // committed money. Log and swallow, exactly as createNotification does.
    logger.warn(
      { err: { message: (err as Error).message }, eventKey: event.eventKey },
      "Failed to emit notification event",
    );
    return false;
  }
}

/** Emit the same event to several recipients. Failures are per-recipient. */
export async function emitNotificationOnceToMany(
  userIds: readonly string[],
  build: (userId: string) => NotificationEvent,
): Promise<number> {
  const results = await Promise.all(userIds.map((userId) => emitNotificationOnce(build(userId))));
  return results.filter(Boolean).length;
}

// ─── Event key builders ──────────────────────────────────────────────────────
//
// Every key is derived from identifiers that are immutable once written, so a
// key cannot change under a retry:
//
//   financial_transactions.id   settled / failed contribution
//   autodrip_runs.id            AutoDrip run outcome
//   jars.id + threshold         progress threshold crossing
//   milestones.id               milestone funded transition
//   invitations.id              invitation delivered
//
// Amounts, names, percentages, and timestamps are deliberately absent. A key
// containing a mutable value would let a display change re-issue a
// notification the recipient has already seen.

export const notificationEventKey = {
  /** One settled contribution, one recipient. */
  contributionSettled: (financialTransactionId: string, recipientUserId: string) =>
    `contribution_settled:${financialTransactionId}:${recipientUserId}`,

  /**
   * A jar crossing a funding threshold, per recipient.
   *
   * The threshold is part of the identity, so 50% and 100% are distinct events
   * while a recalculation at the same threshold is not.
   */
  jarProgressThreshold: (jarId: string, thresholdPercent: number, recipientUserId: string) =>
    `jar_progress:${jarId}:${thresholdPercent}:${recipientUserId}`,

  /** A milestone reaching canonical funded, per recipient. */
  milestoneFunded: (milestoneId: string, recipientUserId: string) =>
    `milestone_funded:${milestoneId}:${recipientUserId}`,

  /** One AutoDrip run succeeding. Recipient is always the authorizing user. */
  autoDripSucceeded: (autoDripRunId: string) => `autodrip_succeeded:${autoDripRunId}`,

  /**
   * An AutoDrip authorization entering needs_attention.
   *
   * Keyed on the run, not the authorization: a later run failing is a new
   * event the member must see, while two deliveries of the same run's failure
   * are one event.
   */
  autoDripNeedsAttention: (autoDripRunId: string) => `autodrip_needs_attention:${autoDripRunId}`,

  /** An invitation delivered to an existing account. */
  invitationReceived: (invitationId: string, recipientUserId: string) =>
    `invitation_received:${invitationId}:${recipientUserId}`,
} as const;
