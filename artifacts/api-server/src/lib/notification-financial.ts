/**
 * Canonical financial notifications.
 *
 * ─── The rule this module exists to enforce ─────────────────────────────────
 *
 * A customer-visible financial notification is derived from accounting records
 * and nothing else. Every entry point here takes IDENTIFIERS ONLY and re-reads
 * the canonical rows itself. No caller can hand it an amount, a percentage, a
 * name, or a jar total, so no request body, quote, client success screen, or
 * stale in-memory value can reach a notification message.
 *
 * ─── What was wrong ─────────────────────────────────────────────────────────
 *
 * Before this module the notification surface and the ledger were not merely
 * inconsistent, they were unconnected:
 *
 *   - The canonical money path — Stripe `payment_intent.succeeded` →
 *     `postContributionAccounting` → posted ledger transaction — emitted NO
 *     notification of any kind.
 *   - The only live financial producer was `POST /jars/:jarId/contributions`,
 *     which broadcast "{name} added ${req.body.amountCents}" to every member
 *     for a row written `status:'simulated'` — Test Mode principal that
 *     `getJarSavedPrincipalCents` deliberately excludes. Money that never
 *     moved, announced as if it had, at an amount the client chose.
 *   - `milestone_funded` and `jar_halfway_funded` were declared in the
 *     `NotificationType` union and produced by nothing. The only rows that
 *     ever bore them were literals in the demo seed
 *     (`scripts/src/seed.ts:407` and `:436` — "Hawaii 2027 is 71% funded!",
 *     "Flights are fully funded!"). That is the whole of the QA contradiction:
 *     not a miscalculation against canonical principal, but text with no
 *     calculation behind it sitting beside a ledger correctly reading $0.
 *
 * Progress and milestone notifications now have exactly one origin — a
 * settlement that posted to the ledger — and read their numbers from
 * `getJarProgressSummary` and `getMilestoneAllocations`, the same helpers the
 * money-bearing screens use. A jar cannot announce 71% while its canonical
 * principal is $0, because the percentage and the principal are now the same
 * number read from the same place.
 *
 * ─── Principal, never charge ────────────────────────────────────────────────
 *
 * Contribution notifications report `financial_transactions.requested_principal_cents`.
 * They never report `total_quoted_cents`, `dripjar_fee_cents`, or
 * `processing_fee_estimated_cents`. DripJar and processing fees are not jar
 * principal, they are not what the member saved, and one member's fees are
 * never another member's business.
 *
 * ─── Never changes financial state ──────────────────────────────────────────
 *
 * Every function reads. The only writes are notification rows and their event
 * claims, through `emitNotificationOnce`. All entry points are called AFTER
 * the money transaction commits, so a notification failure cannot roll back a
 * ledger posting, and none of them can commit, forfeit, or move principal.
 */

import { db } from "@workspace/db";
import {
  jars,
  jarMembers,
  profiles,
  milestones,
  financialTransactions,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { logger } from "./logger.js";
import { resolveDisplayName } from "./display-name.js";
import {
  getJarProgressSummary,
  getMilestoneAllocations,
  PRINCIPAL_ORIGIN_TRANSACTION_TYPES,
} from "./financial-balance.js";
import { emitNotificationOnce, notificationEventKey } from "./notification-events.js";

/** `$1,234.56` — the only money formatter customer-visible text may use. */
function formatUsd(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Funding thresholds that produce a notification, as a percentage of the goal.
 *
 * ─── The existing policy, documented rather than invented ───────────────────
 *
 * The codebase declares exactly two funding-progress notification types, and
 * both name their own threshold:
 *
 *   jar_halfway_funded   50%   lib/notifications.ts NotificationType union
 *   goal_fully_funded   100%   ditto; already emitted by routes/contributions.ts
 *
 * Both appear in the OpenAPI `Notification.type` enum, so both are contract.
 * No other threshold has ever existed in server code. The demo seed's 71% was
 * a hand-written string, not a policy — there is no 71% rule to preserve, and
 * inventing 25% or 75% here would be adding product behaviour this phase was
 * told not to add.
 *
 * Ordered high to low so the highest threshold crossed is reported first.
 */
const PROGRESS_THRESHOLDS: ReadonlyArray<{ percent: number; type: "goal_fully_funded" | "jar_halfway_funded" }> = [
  { percent: 100, type: "goal_fully_funded" },
  { percent: 50, type: "jar_halfway_funded" },
] as const;

/**
 * Active membership is the recipient rule for every shared jar notification.
 *
 * `status = 'active'` excludes members who left, members the organizer
 * removed, and invitees who declined or never accepted — none of whom may
 * receive new shared jar activity. Nothing here is a legal or financial
 * disclosure, so no exception applies. A former member's access to their own
 * refundable principal is unaffected: that lives on the refund surface, which
 * has no membership-status gate (routes/refunds.ts).
 */
async function activeMemberUserIds(jarId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: jarMembers.userId })
    .from(jarMembers)
    .where(and(eq(jarMembers.jarId, jarId), eq(jarMembers.status, "active")));
  return [...new Set(rows.map((r) => r.userId))];
}

async function jarNameOf(jarId: string): Promise<{ name: string; goalAmountCents: number } | null> {
  const [row] = await db
    .select({ name: jars.name, goalAmountCents: jars.goalAmountCents })
    .from(jars)
    .where(eq(jars.id, jarId))
    .limit(1);
  return row ?? null;
}

async function displayNameOfMember(memberId: string): Promise<string> {
  const [member] = await db
    .select({ userId: jarMembers.userId })
    .from(jarMembers)
    .where(eq(jarMembers.id, memberId))
    .limit(1);
  if (!member) return resolveDisplayName(null);
  const [profile] = await db
    .select({ displayName: profiles.displayName, firstName: profiles.firstName, lastName: profiles.lastName })
    .from(profiles)
    .where(eq(profiles.userId, member.userId))
    .limit(1);
  return resolveDisplayName(profile);
}

// ─── Settled contribution ────────────────────────────────────────────────────

/**
 * Announce one settled contribution.
 *
 * PRECONDITION, re-verified here rather than trusted: the financial
 * transaction has provider success AND a posted ledger transaction. A quote, a
 * created payment intent, a pending charge, a failed charge, or a succeeded
 * charge whose ledger posting has not landed produces nothing. That check is
 * repeated inside this function because it is the whole point of it — a caller
 * that invoked it too early must not be able to announce unsettled money.
 *
 * Recipients and content:
 *   contributor    "Your $X drip to {jar} was received."
 *   other actives  "{Name} added $X to {jar}."
 *
 * $X is canonical principal in both. The contributor is told about their own
 * payment only; no member ever sees another member's fees or total charge.
 */
export async function notifySettledContribution(financialTransactionId: string): Promise<void> {
  const [ft] = await db
    .select({
      id: financialTransactions.id,
      jarId: financialTransactions.jarId,
      memberId: financialTransactions.memberId,
      requestedPrincipalCents: financialTransactions.requestedPrincipalCents,
      providerStatus: financialTransactions.providerStatus,
      ledgerPostingStatus: financialTransactions.ledgerPostingStatus,
      transactionType: financialTransactions.transactionType,
    })
    .from(financialTransactions)
    .where(eq(financialTransactions.id, financialTransactionId))
    .limit(1);

  if (!ft) return;

  // Settlement gate. `ledgerPostingStatus = 'posted'` is the canonical
  // definition of settled and mirrors aggregateLedger's filter.
  if (ft.ledgerPostingStatus !== "posted") return;

  // Only principal-originating types are contributions. A commitment transfer
  // or a refund movement is not new money into the jar.
  if (!(PRINCIPAL_ORIGIN_TRANSACTION_TYPES as readonly string[]).includes(ft.transactionType)) return;

  const principalCents = Number(ft.requestedPrincipalCents);
  if (principalCents <= 0) return;

  const jar = await jarNameOf(ft.jarId);
  if (!jar) return;

  const [contributor] = await db
    .select({ userId: jarMembers.userId })
    .from(jarMembers)
    .where(eq(jarMembers.id, ft.memberId))
    .limit(1);

  const contributorName = await displayNameOfMember(ft.memberId);
  const amount = formatUsd(principalCents);
  const recipients = await activeMemberUserIds(ft.jarId);

  // The contributor is notified whether or not they are still an active member
  // — it is their own payment, not shared jar activity.
  if (contributor && !recipients.includes(contributor.userId)) {
    recipients.push(contributor.userId);
  }

  await Promise.all(
    recipients.map((userId) =>
      emitNotificationOnce({
        eventKey: notificationEventKey.contributionSettled(ft.id, userId),
        eventType: "contribution_settled",
        userId,
        jarId: ft.jarId,
        type: "contribution_recorded",
        title: userId === contributor?.userId ? "Drip received" : "New contribution",
        message:
          userId === contributor?.userId
            ? `Your ${amount} drip to ${jar.name} was received.`
            : `${contributorName} added ${amount} to ${jar.name}.`,
      }),
    ),
  );
}

// ─── Progress thresholds ─────────────────────────────────────────────────────

/**
 * Announce any funding threshold the jar has now crossed.
 *
 * Reads `getJarProgressSummary`, whose `percentFunded` is computed from
 * `savedPrincipalCents` = refundable + committed, straight from the ledger.
 * Test Mode principal is reported separately by that helper and is never part
 * of `savedPrincipalCents`, so a simulated contribution cannot move a
 * threshold. A failed or pending payment posts nothing, so it cannot either.
 *
 * FIRST CROSSING ONLY. The event key is `jar_progress:{jarId}:{percent}:{userId}`
 * and event rows are never deleted, so:
 *
 *   - recalculation, webhook redelivery, and worker retries are silent;
 *   - a refund that drops the jar back below a threshold, followed by new
 *     principal that re-crosses it, does NOT re-announce that threshold.
 *
 * That second behaviour is the deliberate default. No documented policy asks
 * for a threshold to be re-issued after a refund, and re-announcing "you're
 * halfway there!" to a group that was already told so reads as a bug. If a
 * future policy wants re-arming, it belongs in the key, not in a nullable
 * "last threshold" column that concurrent settlements would race on.
 */
export async function notifyJarProgressThresholds(jarId: string): Promise<void> {
  const jar = await jarNameOf(jarId);
  if (!jar || jar.goalAmountCents <= 0) return;

  const summary = await getJarProgressSummary(jarId, jar.goalAmountCents);

  // Zero canonical principal cannot cross any threshold. Explicit rather than
  // implied by the comparison, because this is the exact condition the QA
  // contradiction reported: progress announced against $0 saved.
  if (summary.savedPrincipalCents <= 0) return;

  const crossed = PROGRESS_THRESHOLDS.filter((t) => summary.percentFunded >= t.percent);
  if (crossed.length === 0) return;

  const recipients = await activeMemberUserIds(jarId);
  const saved = formatUsd(summary.savedPrincipalCents);
  const goal = formatUsd(jar.goalAmountCents);

  for (const threshold of crossed) {
    const isComplete = threshold.percent === 100;
    await Promise.all(
      recipients.map((userId) =>
        emitNotificationOnce({
          eventKey: notificationEventKey.jarProgressThreshold(jarId, threshold.percent, userId),
          eventType: "jar_progress_threshold",
          userId,
          jarId,
          type: threshold.type,
          title: isComplete ? `${jar.name} is fully funded!` : `${jar.name} is halfway there!`,
          message: isComplete
            ? `Your group has saved ${saved} toward the ${goal} goal.`
            : `Your group has saved ${saved} of the ${goal} goal. Keep going!`,
        }),
      ),
    );
  }
}

// ─── Milestone funded ────────────────────────────────────────────────────────

/**
 * Announce milestones that have reached canonical funded.
 *
 * `getMilestoneAllocations` attributes ledger-backed principal to milestones
 * from posted, principal-origin financial transactions only, net of refund
 * allocations. Pending, failed, cancelled, and succeeded-but-unposted
 * transactions contribute nothing, so none of them can fund a milestone.
 *
 * Guards, each covering a distinct way "funded" could be claimed falsely:
 *
 *   reconciles === false     attribution exceeded canonical saved principal,
 *                            so the split is wrong, not merely coarse. The
 *                            helper's own contract says callers must suppress
 *                            the breakdown; announcing from it would be
 *                            announcing numbers that do not add up.
 *   targetAmountCents <= 0   a zero-target milestone would satisfy
 *                            `allocated >= target` at zero allocation and
 *                            announce itself the moment any jar settled.
 *   allocated <= 0           zero allocation is never funded, stated
 *                            explicitly and independently of the target.
 *
 * REFUND AND REALLOCATION BEHAVIOUR, stated rather than guessed: the event key
 * is the milestone id, so the notification is issued once, on the first
 * observation of canonical funded. A later refund that drops the milestone
 * back below its target does not retract it — there is no un-notify concept in
 * this system — and does not re-arm it either. Retraction and re-arming are
 * both product decisions with no existing policy behind them; this phase
 * implements the transition it was asked for and leaves those to a future one.
 */
export async function notifyMilestonesFunded(jarId: string): Promise<void> {
  const breakdown = await getMilestoneAllocations(jarId);
  if (!breakdown.reconciles) return;
  if (breakdown.byMilestoneId.size === 0) return;

  const ids = [...breakdown.byMilestoneId.keys()];
  const rows = await db
    .select({ id: milestones.id, name: milestones.name, targetAmountCents: milestones.targetAmountCents })
    .from(milestones)
    .where(and(eq(milestones.jarId, jarId), inArray(milestones.id, ids)));

  const funded = rows.filter((m) => {
    if (m.targetAmountCents <= 0) return false;
    const allocated = breakdown.byMilestoneId.get(m.id) ?? 0;
    if (allocated <= 0) return false;
    return allocated >= m.targetAmountCents;
  });

  if (funded.length === 0) return;

  const jar = await jarNameOf(jarId);
  if (!jar) return;
  const recipients = await activeMemberUserIds(jarId);

  for (const milestone of funded) {
    await Promise.all(
      recipients.map((userId) =>
        emitNotificationOnce({
          eventKey: notificationEventKey.milestoneFunded(milestone.id, userId),
          eventType: "milestone_funded",
          userId,
          jarId,
          type: "milestone_funded",
          title: `${milestone.name} is fully funded!`,
          message: `Your group has fully funded ${milestone.name} in ${jar.name}.`,
        }),
      ),
    );
  }
}

// ─── Post-settlement orchestration ───────────────────────────────────────────

/**
 * Everything that becomes true when principal settles, in one call.
 *
 * Ordered contribution → progress → milestone so a member reads the cause
 * before its consequences. Each step is independently idempotent, so a partial
 * failure is recovered by the next delivery without duplicating whatever
 * already succeeded.
 *
 * Call AFTER the money transaction commits. Never inside it.
 */
export async function notifyContributionSettled(financialTransactionId: string): Promise<void> {
  try {
    await notifySettledContribution(financialTransactionId);

    const [ft] = await db
      .select({ jarId: financialTransactions.jarId, ledgerPostingStatus: financialTransactions.ledgerPostingStatus })
      .from(financialTransactions)
      .where(eq(financialTransactions.id, financialTransactionId))
      .limit(1);

    if (!ft || ft.ledgerPostingStatus !== "posted") return;

    await notifyJarProgressThresholds(ft.jarId);
    await notifyMilestonesFunded(ft.jarId);
  } catch (err) {
    // Money has already committed. A notification problem is logged, never
    // propagated back into the financial path.
    logger.warn(
      { err: { message: (err as Error).message }, financialTransactionId },
      "Post-settlement notifications failed",
    );
  }
}
