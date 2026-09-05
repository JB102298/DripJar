import { db } from "@workspace/db";
import { activityEvents } from "@workspace/db";
import { inArray } from "drizzle-orm";

export type ActivityEventType =
  | "jar_created"
  | "invitation_sent"
  | "member_joined"
  | "contribution_added"
  | "contribution_reversed"
  | "target_changed"
  | "milestone_created"
  | "milestone_funded"
  | "commitment_requested"
  | "approval_submitted"
  | "jar_locked"
  | "jar_completed"
  | "jar_cancelled"
  | "member_left"
  | "member_removed"
  | "invitation_revoked"
  | "jar_updated"
  | "agreement_accepted"
  | "cutoff_changed"
  | "jar_commitment_phase"
  | "agreement_version_changed"
  // Phase 4C
  | "fund_committed"
  | "refund_requested"
  | "refund_completed"
  | "refund_partially_failed"
  | "refund_failed"
  // Phase 4D — Jar Goals (metadata only; no financial events for waterfall shifts)
  | "goal_created"
  | "goal_updated"
  | "goal_archived"
  | "goal_reordered"
  // Phase 4E — AutoDrip
  | "autodrip_enabled"
  | "autodrip_paused"
  | "autodrip_resumed"
  | "autodrip_cancelled"
  | "autodrip_succeeded"
  | "autodrip_failed"
  | "autodrip_payment_method_changed";

export async function logActivity(params: {
  jarId: string;
  userId?: string;
  eventType: ActivityEventType;
  description: string;
  amountCents?: number;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.insert(activityEvents).values({
      jarId: params.jarId,
      userId: params.userId ?? null,
      eventType: params.eventType,
      description: params.description,
      amountCents: params.amountCents ?? null,
      metadata: params.metadata ?? null,
    });
  } catch (err) {
    // Activity logging is fire-and-forget; never block main request
    console.error("Failed to log activity:", err);
  }
}

// ─── Exactly-once activity ───────────────────────────────────────────────────
//
// `logActivity` above is unconditional and swallowing, which is right for the
// twenty-nine call sites behind a user action: the user pressed the button
// once, so the row is written once, and a logging failure must not fail their
// request. It is wrong for a caller behind a scheduler, which re-observes the
// same fact on every invocation and has no button press to count.
//
// `logActivityOnce` is that second writer. Nothing about `logActivity` changes.

/**
 * Deterministic identity for an activity that may be written at most once.
 *
 * Built exclusively from immutable identifiers, in the same spirit as
 * `notificationEventKey` (lib/notification-events.ts): a key that embedded a
 * mutable value would let a later change re-issue an entry the jar has already
 * shown. `jars.id` never changes, and there is no organizer transfer, so this
 * key is stable for the whole life of the jar.
 *
 * Deliberately NOT included: the cutoff date (a jar can enter the commitment
 * phase only once — `PATCH /jars/:id` refuses to move `cutoff_date` once it has
 * been reached), the run date (that would mint a new activity every day), and
 * any member identifier (the activity is jar-level).
 */
export const activityDedupeKey = {
  /** The one commitment-phase entry in a jar's lifecycle. */
  jarCommitmentPhase: (jarId: string) => `jar_commitment_phase:${jarId}`,
} as const;

/** What `logActivityOnce` did. Never inferred from an error. */
export type ActivityOnceOutcome = "created" | "already-logged";

/**
 * Write an activity at most once for the given deterministic key.
 *
 * ─── THE DATABASE DECIDES, NOT A PRIOR READ ──────────────────────────────────
 *
 * The single `INSERT … ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`
 * resolves the uniqueness question inside the statement, where it is exact.
 * Two concurrent callers with the same key cannot both observe "absent" and
 * both proceed; one wins the unique index and the other gets zero rows back.
 * There is deliberately no `SELECT` first — a check-then-insert would be a race
 * with the check's own result.
 *
 * The conflict target is the bare column. `activity_events_dedupe_key_idx`
 * (migration 0025) is a plain unique index rather than a partial one, so no
 * predicate has to be repeated here and kept in step with the migration.
 *
 * ─── AN ERROR IS NEVER "ALREADY LOGGED" ──────────────────────────────────────
 *
 * Only the empty RETURNING set means the key was taken. Every other failure —
 * a foreign-key violation, a dropped connection, a serialisation failure —
 * propagates to the caller unchanged. Nothing here catches, so nothing here can
 * misreport a failure as a completed write.
 *
 * ─── A FAILED WRITE LEAVES NO CLAIM ──────────────────────────────────────────
 *
 * The key lives on the activity row itself, not on a separate marker written
 * before or after it. There is no window in which the claim exists and the
 * activity does not: if the INSERT does not commit, no key exists and the next
 * invocation retries from scratch. That is the property a two-table claim
 * (claim first, write second) cannot offer without a transaction around both.
 *
 * @throws whatever the database raised. Callers behind a scheduler are expected
 *         to log and continue, per their own error contract.
 */
export async function logActivityOnce(params: {
  dedupeKey: string;
  jarId: string;
  userId?: string;
  eventType: ActivityEventType;
  description: string;
  amountCents?: number;
  metadata?: Record<string, unknown>;
}): Promise<ActivityOnceOutcome> {
  const inserted = await db
    .insert(activityEvents)
    .values({
      jarId: params.jarId,
      userId: params.userId ?? null,
      eventType: params.eventType,
      description: params.description,
      amountCents: params.amountCents ?? null,
      metadata: params.metadata ?? null,
      dedupeKey: params.dedupeKey,
    })
    .onConflictDoNothing({ target: activityEvents.dedupeKey })
    .returning({ id: activityEvents.id });

  return inserted.length > 0 ? "created" : "already-logged";
}

/**
 * Of the given deterministic keys, which have NOT been claimed yet.
 *
 * A page-level prefetch, so a processor that re-observes hundreds of settled
 * jars issues one statement for the page instead of one insert attempt per jar.
 *
 * ─── WHY A STALE READ IS SAFE ────────────────────────────────────────────────
 *
 * The key is a column on the activity row, so "claimed" and "the canonical
 * activity exists" are the same fact, and it is absorbing: a claimed key is
 * never released, and the only thing that removes it removes the activity row
 * with it (both are jar-scoped, and `activity_events.jar_id` cascades). A key
 * read as claimed is therefore still claimed when it is skipped.
 *
 * A key read as unclaimed falls through to `logActivityOnce`, which re-decides
 * authoritatively. So this prefetch can only remove work; it can never change
 * an outcome, and a concurrent claimer between the read and the insert is
 * resolved by the unique index exactly as if this function did not exist.
 */
export async function unclaimedActivityKeys(dedupeKeys: string[]): Promise<Set<string>> {
  const unclaimed = new Set(dedupeKeys);
  if (unclaimed.size === 0) return unclaimed;

  const rows = await db
    .select({ dedupeKey: activityEvents.dedupeKey })
    .from(activityEvents)
    .where(inArray(activityEvents.dedupeKey, [...unclaimed]));

  for (const row of rows) if (row.dedupeKey !== null) unclaimed.delete(row.dedupeKey);
  return unclaimed;
}
