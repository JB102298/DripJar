/**
 * POST /internal/process-reminders
 *
 * Idempotent reminder processing job — safe to call any number of times per day.
 *
 * ─── CANDIDATE SELECTION IS SET-BASED (Phase M3) ─────────────────────────────
 *
 * This processor is global by design: one call must consider every active
 * schedule and every Saving jar in the database. What it must NOT do is issue a
 * statement per row it considers.
 *
 * It used to. Each of the three reminder families walked its rows in JavaScript
 * and re-read the member, the jar, the user, the profile, the contribution
 * total, the current agreement, and each acceptance one row at a time. The cost
 * was linear in database residue rather than in eligible work:
 *
 *   queries ≈ 2
 *           + 5 × active schedules
 *           + Σ over Saving jars with a cutoff   (1 + 2 × active members)
 *           + Σ over Saving jars                 (1 + 1 + 1 per active member)
 *
 * Measured on 1 765 Saving jars with 165 due-today schedules, that was 6 782
 * statements for a first run and 6 452 for a steady-state re-run — 6 122 of
 * them selection work that produced no reminder at all.
 *
 * Selection is now three keyset-paged queries plus one enrichment query per
 * page, so the statement count scales with the number of PAGES and the number
 * of events actually emitted, never with the number of rows scanned:
 *
 *   queries = 1 (schedule count)
 *           + 1 per schedule page
 *           + 2 per cutoff-candidate page
 *           + 2 per agreement-candidate page
 *           + 1 per page (existing-event prefetch)
 *           + per emitted event: 1 claim, 0–1 notification, 0–2 email writes
 *
 * ─── WHAT SELECTION EXCLUDES, AND WHY IT IS EXACT ────────────────────────────
 *
 *   Schedules      inner-joined to an active member, a Saving jar, a user, and
 *                  a profile — the four `continue`s the old loop performed, now
 *                  expressed as joins. The jar is joined on `schedule.jar_id`
 *                  and the member on `schedule.member_id` independently, which
 *                  is what the old code did; a schedule whose member belongs to
 *                  a different jar is treated exactly as before.
 *
 *   Cutoff jars    pre-filtered to `cutoff_date <= today + 7`. The three
 *                  reminder windows are `daysAway === 7`, `daysAway === 1`, and
 *                  `daysAway <= 0`, so that bound is a strict superset of every
 *                  jar that can fire, and `daysUntil()` still decides which
 *                  window (if any) a jar actually falls in. The SQL narrows the
 *                  candidate set; it never decides eligibility.
 *
 *   Agreement jars paged over jars that HAVE an agreement, taking the current
 *                  one per jar with `DISTINCT ON`. Members who already accepted
 *                  are removed by an anti-join instead of one lookup each.
 *
 * Every page is ordered by a primary key and read with a keyset cursor
 * (`id > :last`), so a page boundary can neither skip nor repeat a candidate,
 * and two runs over unchanged data visit candidates in the same order.
 *
 * ─── NO CACHING ACROSS ANYTHING ──────────────────────────────────────────────
 *
 * Nothing is memoised beyond the lifetime of a single page of a single request.
 * There is no module-level map, no cross-invocation reuse, and no per-user
 * state that could outlive the response.
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
 *   No database transaction is open while an email is being sent. Each write is
 *   its own statement, so a slow provider cannot hold a connection's transaction
 *   open behind it.
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
  reminderSentEvents,
} from "@workspace/db";
import { eq, and, inArray, or, lte, sql, count } from "drizzle-orm";
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

// ─── Batching ────────────────────────────────────────────────────────────────

/**
 * Candidates read per page.
 *
 * The bound exists so a database with a million Saving jars cannot be pulled
 * into one array — memory is capped at a page, not at the table. It is a
 * plain constant rather than a tunable because the correctness of the keyset
 * cursor must not depend on it: any positive value visits exactly the same
 * candidates in exactly the same order.
 */
export const CANDIDATE_BATCH_SIZE = 500;

/**
 * Reminder windows extend at most 7 days ahead of the run date, so no jar whose
 * cutoff is further out can produce an event. Kept next to the windows it
 * bounds — a new window further out must widen this too.
 */
const MAX_CUTOFF_LOOKAHEAD_DAYS = 7;

/**
 * Walk a keyset-paged candidate set.
 *
 * `fetchPage` receives the last key of the previous page (null for the first)
 * and must return rows ordered by that key, ascending, limited to
 * CANDIDATE_BATCH_SIZE. Because the cursor is a strict `>` on a unique,
 * immutable primary key, a row inserted or deleted mid-run can never cause a
 * candidate to be visited twice or skipped over: pages tile the key space.
 */
async function forEachPage<T>(
  keyOf: (row: T) => string,
  fetchPage: (afterKey: string | null) => Promise<T[]>,
  handlePage: (page: T[]) => Promise<void>,
): Promise<void> {
  let afterKey: string | null = null;
  for (;;) {
    const page = await fetchPage(afterKey);
    if (page.length === 0) return;
    await handlePage(page);
    if (page.length < CANDIDATE_BATCH_SIZE) return;
    afterKey = keyOf(page[page.length - 1]!);
  }
}

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
 * A conflict on `event_key` said the row exists, and the follow-up read could
 * not find it.
 *
 * In production this is unreachable: nothing deletes a reminder event. It is
 * reachable in the test suite, where fixture teardown removes accounts, and it
 * is raised rather than swallowed because the alternative — returning the
 * `undefined` that `[existing]` destructures to — would hand the caller a row
 * it is about to dereference.
 */
export class ReminderEventVanishedError extends Error {
  constructor(readonly eventKey: string) {
    super(
      `Reminder event "${eventKey}" conflicted on insert but could not be read ` +
        `back. The row was deleted between the two statements.`,
    );
    this.name = "ReminderEventVanishedError";
  }
}

/**
 * Try to INSERT a new reminder event row (status='pending').
 * Returns { isNew: true, row } on success.
 * Returns { isNew: false, row } when the event_key already exists.
 *
 * ─── ONLY THE EVENT-KEY CONFLICT COUNTS AS "ALREADY CLAIMED" ─────────────────
 *
 * This used to be a bare `try { insert } catch { select }`. Every database
 * failure took the catch: a foreign-key violation from a deleted user, a
 * dropped connection, a permission error, a serialisation failure, a malformed
 * statement. Each was silently reinterpreted as "someone else already claimed
 * this event", and the subsequent SELECT then returned nothing, so the function
 * handed back `row: undefined` typed as `ReminderRow` and the caller
 * dereferenced it.
 *
 * `ON CONFLICT (event_key) DO NOTHING ... RETURNING` moves the discrimination
 * into the database, where it is exact:
 *
 *   - the intended uniqueness conflict returns zero rows and throws nothing
 *   - every other error is still an error, and propagates unchanged
 *
 * There is no error-message matching anywhere in this path, so no error string
 * or SQLSTATE list has to stay in sync with the driver.
 *
 * @exported for deterministic testing of the conflict and error paths — do NOT
 *           call from application code outside this processor.
 */
export async function claimOrFetchEvent(opts: {
  eventKey: string;
  userId: string;
  jarId: string | null;
  eventType: string;
}): Promise<{ isNew: boolean; row: ReminderRow }> {
  const inserted = await db
    .insert(reminderSentEvents)
    .values({
      eventKey: opts.eventKey,
      userId: opts.userId,
      jarId: opts.jarId,
      eventType: opts.eventType,
      emailStatus: "pending",
    })
    // Targeted at the unique index on event_key alone. A conflict on any other
    // constraint is not swallowed here — it raises, as it should.
    .onConflictDoNothing({ target: reminderSentEvents.eventKey })
    .returning();

  const row = inserted[0];
  if (row) return { isNew: true, row };

  // Zero rows returned means exactly one thing: the event_key was already
  // taken. Read the existing claim back by that same key.
  const [existing] = await db
    .select()
    .from(reminderSentEvents)
    .where(eq(reminderSentEvents.eventKey, opts.eventKey))
    .limit(1);

  if (!existing) throw new ReminderEventVanishedError(opts.eventKey);
  return { isNew: false, row: existing };
}

/**
 * Read the reminder rows that already exist for a page of candidate event keys.
 *
 * ─── WHY A STALE READ IS SAFE HERE ───────────────────────────────────────────
 *
 * The only decision taken from this result is "is this event already terminal",
 * and the two terminal states — 'sent' and 'skipped_preference' — are absorbing:
 * nothing transitions out of them. A row read as terminal is therefore still
 * terminal when it is skipped, however much time has passed.
 *
 * Everything else falls through to `claimOrFetchEvent`, which re-reads
 * authoritatively. A row that was absent, pending, failed, or sending at this
 * read is handled by exactly the same code path as before this prefetch
 * existed, so the prefetch can only remove work, never change an outcome.
 */
async function fetchExistingEvents(eventKeys: string[]): Promise<Map<string, ReminderRow>> {
  const byKey = new Map<string, ReminderRow>();
  if (eventKeys.length === 0) return byKey;
  const rows = await db
    .select()
    .from(reminderSentEvents)
    .where(inArray(reminderSentEvents.eventKey, eventKeys));
  for (const row of rows) byKey.set(row.eventKey, row);
  return byKey;
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
 * One reminder that selection decided is eligible, with everything needed to
 * emit it. Built per page and discarded with the page — never cached.
 *
 * `alsoAfter` runs once per invocation for this candidate whether the event was
 * emitted, retried, or skipped as a duplicate. Exactly one reminder uses it
 * (the organizer-side commitment-phase activity entry), and it runs in the same
 * position relative to the event as it did before batching.
 */
interface ReminderIntent {
  eventKey: string;
  userId: string;
  jarId: string | null;
  eventType: string;
  prefEnabled: boolean;
  createNotificationFn: () => Promise<void>;
  sendEmailFn: () => Promise<boolean>;
  newStatKey: keyof ReminderStats;
  alsoAfter?: () => Promise<void>;
}

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

/**
 * Emit one page's worth of intents, in order, after one batched read of the
 * events that already exist.
 *
 * Events already in a terminal state are counted and skipped without issuing a
 * single statement of their own — the case that dominates a mature database,
 * where almost every candidate has already been delivered. Everything else goes
 * through the unchanged per-event path.
 */
async function emitIntents(intents: ReminderIntent[], stats: ReminderStats): Promise<void> {
  const existing = await fetchExistingEvents(intents.map((i) => i.eventKey));

  for (const intent of intents) {
    const known = existing.get(intent.eventKey);
    if (known && (known.emailStatus === "sent" || known.emailStatus === "skipped_preference")) {
      stats.skippedDuplicate++;
    } else {
      await processReminderEvent({
        eventKey: intent.eventKey,
        userId: intent.userId,
        jarId: intent.jarId,
        eventType: intent.eventType,
        prefEnabled: intent.prefEnabled,
        createNotificationFn: intent.createNotificationFn,
        sendEmailFn: intent.sendEmailFn,
        stats,
        newStatKey: intent.newStatKey,
      });
    }
    if (intent.alsoAfter) await intent.alsoAfter();
  }
}

// ─── Candidate row shapes ────────────────────────────────────────────────────

type ScheduleCandidate = {
  scheduleId: string;
  startDate: string;
  frequency: string;
  preferredDay: number | null;
  amountCents: number;
  userId: string;
  jarId: string;
  jarName: string;
  email: string;
  displayName: string;
  prefEnabled: boolean;
  totalContributedCents: number;
};

type CutoffJarCandidate = {
  jarId: string;
  jarName: string;
  cutoffDate: string;
  organizerId: string;
};

type AgreementJarCandidate = {
  jarId: string;
  jarName: string;
  agreementId: string;
  version: string;
};

type MemberRecipient = {
  jarId: string;
  userId: string;
  email: string;
  displayName: string;
  prefEnabled: boolean;
};

/** Group recipient rows by jar, preserving the SQL ordering within each jar. */
function groupByJar(rows: MemberRecipient[]): Map<string, MemberRecipient[]> {
  const byJar = new Map<string, MemberRecipient[]>();
  for (const row of rows) {
    const list = byJar.get(row.jarId);
    if (list) list.push(row);
    else byJar.set(row.jarId, [row]);
  }
  return byJar;
}

/**
 * The inclusive upper bound of the cutoff candidate pre-filter, as yyyy-MM-dd.
 *
 * The three cutoff windows are `daysAway === 7`, `daysAway === 1` and
 * `daysAway <= 0`, so no jar whose cutoff is later than this can fire. The
 * arithmetic is done on the UTC calendar day of `now` in whole 86 400 000 ms
 * steps, which is why it is immune to daylight saving: it never touches a local
 * wall clock, and month, year and leap-day rollovers are handled by the epoch
 * arithmetic rather than by field manipulation.
 *
 * @exported so the boundary tests can exercise the real pre-filter bound rather
 *           than a second copy of the same arithmetic.
 */
export function cutoffPrefilterEnd(now: Date): string {
  const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(base + MAX_CUTOFF_LOOKAHEAD_DAYS * 86_400_000).toISOString().slice(0, 10);
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
  //
  // `schedulesProcessed` counts every active, unpaused schedule — including
  // those discarded below for having no active member, no Saving jar, no user,
  // or no profile. That is what the pre-M3 processor reported (it counted the
  // rows it fetched, before filtering), so it is counted separately from the
  // candidate join rather than derived from it.

  const [scheduleCount] = await db
    .select({ n: count() })
    .from(contributionSchedules)
    .where(and(eq(contributionSchedules.isActive, true), eq(contributionSchedules.isPaused, false)));
  stats.schedulesProcessed = Number(scheduleCount?.n ?? 0);

  await forEachPage<ScheduleCandidate>(
    (row) => row.scheduleId,
    async (afterKey) => {
      const result = await db.execute<ScheduleCandidate>(sql`
        select
          s.id                                     as "scheduleId",
          to_char(s.start_date, 'YYYY-MM-DD')       as "startDate",
          s.frequency                              as "frequency",
          s.preferred_day                          as "preferredDay",
          s.amount_cents                           as "amountCents",
          m.user_id                                as "userId",
          j.id                                     as "jarId",
          j.name                                   as "jarName",
          u.email                                  as "email",
          p.display_name                           as "displayName",
          p.email_pref_contribution_reminders      as "prefEnabled",
          (
            select coalesce(sum(c.amount_cents), 0)
              from contributions c
             where c.member_id = s.member_id
               and c.jar_id = s.jar_id
               and c.contribution_date >= s.start_date
               and c.status in ('completed', 'simulated')
          )::int                                   as "totalContributedCents"
        from contribution_schedules s
        join jar_members m on m.id = s.member_id and m.status = 'active'
        join jars j        on j.id = s.jar_id     and j.status = 'Saving'
        join users u       on u.id = m.user_id
        join profiles p    on p.user_id = m.user_id
       where s.is_active = true
         and s.is_paused = false
         ${afterKey === null ? sql.empty() : sql`and s.id > ${afterKey}::uuid`}
       order by s.id
       limit ${CANDIDATE_BATCH_SIZE}
      `);
      return result.rows;
    },
    async (page) => {
      const intents: ReminderIntent[] = [];

      for (const row of page) {
        const status = computeScheduleStatus(
          {
            startDate: row.startDate,
            frequency: row.frequency,
            preferredDay: row.preferredDay,
            isActive: true,
            isPaused: false,
            amountCents: row.amountCents,
          },
          now,
          row.totalContributedCents,
        );
        const fmt = `$${(row.amountCents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

        if (status.state === "due_today") {
          intents.push({
            eventKey: `contribution_due:${row.scheduleId}:${todayUTC}`,
            userId: row.userId, jarId: row.jarId, eventType: "contribution_due",
            prefEnabled: row.prefEnabled,
            createNotificationFn: () => createNotification({
              userId: row.userId, type: "contribution_due",
              title: "Contribution Due Today",
              message: `Your ${fmt} contribution to ${row.jarName} is due today.`,
              relatedJarId: row.jarId, actionUrl: `/jar/${row.jarId}`,
            }),
            sendEmailFn: () => sendContributionDueEmail({
              toEmail: row.email, displayName: row.displayName, jarName: row.jarName,
              jarId: row.jarId, amountCents: row.amountCents, dueDateISO: todayUTC,
            }),
            newStatKey: "contributionDueSent",
          });
        }

        if (status.state === "missed" && status.outstandingCents > 0) {
          intents.push({
            eventKey: `contribution_missed:${row.scheduleId}:${todayUTC}`,
            userId: row.userId, jarId: row.jarId, eventType: "contribution_missed",
            prefEnabled: row.prefEnabled,
            createNotificationFn: () => createNotification({
              userId: row.userId, type: "contribution_missed",
              title: "Contribution Outstanding",
              message: `You have $${(status.outstandingCents / 100).toFixed(0)} outstanding in ${row.jarName}. Add a contribution to catch up.`,
              relatedJarId: row.jarId, actionUrl: `/jar/${row.jarId}`,
            }),
            sendEmailFn: () => sendContributionMissedEmail({
              toEmail: row.email, displayName: row.displayName, jarName: row.jarName,
              jarId: row.jarId, amountCents: row.amountCents, outstandingCents: status.outstandingCents,
            }),
            newStatKey: "contributionMissedSent",
          });
        }
      }

      await emitIntents(intents, stats);
    },
  );

  // ── 2. Cutoff reminders ───────────────────────────────────────────────────
  //
  // Only jars whose cutoff is at most MAX_CUTOFF_LOOKAHEAD_DAYS away can fire.
  // The bound is applied in SQL as a superset filter; `daysUntil()` below still
  // decides which of the three windows — 7 days, 1 day, reached — a jar is in,
  // so the windows themselves are computed exactly as before.

  const cutoffWindowEnd = cutoffPrefilterEnd(now);

  await forEachPage<CutoffJarCandidate>(
    (row) => row.jarId,
    async (afterKey) => {
      const result = await db.execute<CutoffJarCandidate>(sql`
        select
          j.id           as "jarId",
          j.name         as "jarName",
          to_char(j.cutoff_date, 'YYYY-MM-DD') as "cutoffDate",
          j.organizer_id as "organizerId"
        from jars j
       where j.status = 'Saving'
         and j.cutoff_date is not null
         and j.cutoff_date <= ${cutoffWindowEnd}::date
         ${afterKey === null ? sql.empty() : sql`and j.id > ${afterKey}::uuid`}
       order by j.id
       limit ${CANDIDATE_BATCH_SIZE}
      `);
      return result.rows;
    },
    async (page) => {
      const jarIds = page.map((j) => j.jarId);
      const recipients = await db.execute<MemberRecipient>(sql`
        select
          m.jar_id                    as "jarId",
          m.user_id                   as "userId",
          u.email                     as "email",
          p.display_name              as "displayName",
          p.email_pref_cutoff_reminders as "prefEnabled"
        from jar_members m
        join users u    on u.id = m.user_id
        join profiles p on p.user_id = m.user_id
       where m.jar_id = any(${sql.param(jarIds)}::uuid[])
         and m.status = 'active'
       order by m.jar_id, m.id
      `);
      const byJar = groupByJar(recipients.rows);
      const intents: ReminderIntent[] = [];

      for (const jar of page) {
        const daysAway = daysUntil(jar.cutoffDate, now);
        for (const member of byJar.get(jar.jarId) ?? []) {
          if (daysAway === 7) {
            intents.push({
              eventKey: `cutoff_upcoming_7d:${jar.jarId}:${jar.cutoffDate}:${member.userId}`,
              userId: member.userId, jarId: jar.jarId, eventType: "cutoff_upcoming",
              prefEnabled: member.prefEnabled,
              createNotificationFn: () => createNotification({
                userId: member.userId, type: "cutoff_upcoming",
                title: `${jar.jarName} commitment date in 7 days`,
                message: `The commitment date for ${jar.jarName} is ${jar.cutoffDate}. Ensure your agreement is accepted and contributions are current.`,
                relatedJarId: jar.jarId, actionUrl: `/jar/${jar.jarId}`,
              }),
              sendEmailFn: () => sendCutoffUpcomingEmail({ toEmail: member.email, displayName: member.displayName, jarName: jar.jarName, jarId: jar.jarId, cutoffDateISO: jar.cutoffDate, daysAway: 7 }),
              newStatKey: "cutoffUpcoming7dSent",
            });
          }

          if (daysAway === 1) {
            intents.push({
              eventKey: `cutoff_upcoming_1d:${jar.jarId}:${jar.cutoffDate}:${member.userId}`,
              userId: member.userId, jarId: jar.jarId, eventType: "cutoff_upcoming",
              prefEnabled: member.prefEnabled,
              createNotificationFn: () => createNotification({
                userId: member.userId, type: "cutoff_upcoming",
                title: `${jar.jarName} commitment date tomorrow`,
                message: `The commitment date for ${jar.jarName} is tomorrow (${jar.cutoffDate}). Last chance to ensure your contributions and agreement are in order.`,
                relatedJarId: jar.jarId, actionUrl: `/jar/${jar.jarId}`,
              }),
              sendEmailFn: () => sendCutoffUpcomingEmail({ toEmail: member.email, displayName: member.displayName, jarName: jar.jarName, jarId: jar.jarId, cutoffDateISO: jar.cutoffDate, daysAway: 1 }),
              newStatKey: "cutoffUpcoming1dSent",
            });
          }

          if (daysAway <= 0) {
            intents.push({
              eventKey: `cutoff_reached:${jar.jarId}:${jar.cutoffDate}:${member.userId}`,
              userId: member.userId, jarId: jar.jarId, eventType: "cutoff_reached",
              prefEnabled: member.prefEnabled,
              createNotificationFn: () => createNotification({
                userId: member.userId, type: "cutoff_reached",
                title: `${jar.jarName} has entered the Commitment phase`,
                message: `${jar.jarName} reached its commitment date on ${jar.cutoffDate} and is now in the Commitment phase. Schedules are locked; contributions remain open.`,
                relatedJarId: jar.jarId, actionUrl: `/jar/${jar.jarId}`,
              }),
              sendEmailFn: () => sendCutoffReachedEmail({ toEmail: member.email, displayName: member.displayName, jarName: jar.jarName, jarId: jar.jarId, cutoffDateISO: jar.cutoffDate }),
              newStatKey: "cutoffReachedSent",
              // Jar-level activity, logged by the organizer's pass and only by
              // it. Unconditional per invocation, exactly as before — it does
              // not depend on whether the reminder itself was a duplicate.
              ...(member.userId === jar.organizerId
                ? {
                    alsoAfter: async () => {
                      try {
                        await logActivity({
                          jarId: jar.jarId,
                          eventType: "jar_commitment_phase",
                          description: `${jar.jarName} has entered the Commitment phase (cutoff: ${jar.cutoffDate})`,
                        });
                      } catch { /* activity log failure is non-critical */ }
                    },
                  }
                : {}),
            });
          }
        }
      }

      await emitIntents(intents, stats);
    },
  );

  // ── 3. Agreement acceptance reminders ─────────────────────────────────────
  // Phase is TIME-derived (cutoffDate ≤ today). Unaccepted agreement does NOT
  // change the phase — it only blocks protected actions.
  //
  // Paged over jars that HAVE an agreement rather than over every Saving jar:
  // a jar with none produced nothing before and is not a candidate now.
  // `DISTINCT ON (jar_id) … ORDER BY created_at DESC` picks the same current
  // agreement the per-jar `ORDER BY created_at DESC LIMIT 1` picked, with
  // `id DESC` added so two agreements sharing a timestamp resolve the same way
  // on every run instead of arbitrarily.

  await forEachPage<AgreementJarCandidate>(
    (row) => row.jarId,
    async (afterKey) => {
      const result = await db.execute<AgreementJarCandidate>(sql`
        select distinct on (a.jar_id)
          a.jar_id  as "jarId",
          j.name    as "jarName",
          a.id      as "agreementId",
          a.version as "version"
        from agreements a
        join jars j on j.id = a.jar_id and j.status = 'Saving'
       ${afterKey === null ? sql.empty() : sql`where a.jar_id > ${afterKey}::uuid`}
       order by a.jar_id, a.created_at desc, a.id desc
       limit ${CANDIDATE_BATCH_SIZE}
      `);
      return result.rows;
    },
    async (page) => {
      const jarIds = page.map((j) => j.jarId);
      const agreementIds = page.map((j) => j.agreementId);

      // Anti-join: active members of these jars who have NOT accepted that
      // jar's current agreement. Replaces one acceptance lookup per member.
      const recipients = await db.execute<MemberRecipient>(sql`
        select
          t.jar_id               as "jarId",
          m.user_id              as "userId",
          u.email                as "email",
          p.display_name         as "displayName",
          p.email_pref_lifecycle as "prefEnabled"
        from unnest(${sql.param(jarIds)}::uuid[], ${sql.param(agreementIds)}::uuid[]) as t(jar_id, agreement_id)
        join jar_members m on m.jar_id = t.jar_id and m.status = 'active'
        join users u       on u.id = m.user_id
        join profiles p    on p.user_id = m.user_id
        left join agreement_acceptances aa
               on aa.agreement_id = t.agreement_id
              and aa.user_id = m.user_id
       where aa.id is null
       order by t.jar_id, m.id
      `);
      const byJar = groupByJar(recipients.rows);
      const intents: ReminderIntent[] = [];

      for (const jar of page) {
        for (const member of byJar.get(jar.jarId) ?? []) {
          intents.push({
            eventKey: `agreement_required:${jar.agreementId}:${member.userId}`,
            userId: member.userId, jarId: jar.jarId, eventType: "agreement_required",
            prefEnabled: member.prefEnabled,
            createNotificationFn: () => createNotification({
              userId: member.userId, type: "agreement_required",
              title: `Action needed: ${jar.jarName} savings agreement`,
              message: `Please accept the savings agreement for ${jar.jarName} (v${jar.version}) to continue making contributions and managing your schedule. The jar's phase is determined by the commitment date — accepting the agreement does not change the phase, but is required for protected actions.`,
              relatedJarId: jar.jarId, actionUrl: `/jar/${jar.jarId}`,
            }),
            sendEmailFn: () => sendAgreementRequiredEmail({
              toEmail: member.email, displayName: member.displayName, jarName: jar.jarName,
              jarId: jar.jarId, version: jar.version,
            }),
            newStatKey: "agreementRequiredSent",
          });
        }
      }

      await emitIntents(intents, stats);
    },
  );

  res.json(stats);
});

export default router;
