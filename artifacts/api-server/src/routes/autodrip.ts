/**
 * AutoDrip Routes — Phase 4E
 *
 * ── Contributor endpoints ──────────────────────────────────────────────────────
 * GET    /jars/:jarId/autodrip            Get current AutoDrip status
 * POST   /jars/:jarId/autodrip/preview    Compute fee breakdown (dry-run, no DB write)
 * POST   /jars/:jarId/autodrip            Enable AutoDrip (requires schedule + consent)
 * PATCH  /jars/:jarId/autodrip            Update amount, frequency, or payment method
 * POST   /jars/:jarId/autodrip/pause      Pause AutoDrip
 * POST   /jars/:jarId/autodrip/resume     Resume from paused or needs_attention
 * DELETE /jars/:jarId/autodrip            Cancel AutoDrip
 *
 * ── Internal ───────────────────────────────────────────────────────────────────
 * POST   /internal/process-autodrips      Processor (bearer INTERNAL_REMINDER_TOKEN)
 *
 * Security invariants:
 *   - principal_cents always derived server-side (never from client)
 *   - fee amounts always computed server-side (detectTamperedFeeFields guard)
 *   - payment method ownership verified before every use
 *   - organizer can see status pills but NOT payment details, last4, failure codes
 *   - jar must not be terminal before enabling/processing
 *   - AutoDrip blocked until Stripe verification confirmed (ACH pending_verification)
 */

import crypto from "node:crypto";
import { Router } from "express";
import { db } from "@workspace/db";
import {
  jars,
  jarMembers,
  contributionSchedules,
  financialTransactions,
  contributions,
  savedPaymentMethods,
  autoDripAuthorizations,
  autoDripRuns,
  profiles,
  users,
} from "@workspace/db";
import { eq, and, inArray, sql, lte, desc } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../lib/auth.js";
import {
  computeNextDueDate,
  toISODate,
  stripTime,
} from "../lib/schedule-utils.js";
import { computeJarTimeRunAt } from "../lib/jar-time.js";
import { computeDripJarFee, DRIPJAR_FEE_RATE_BPS, detectTamperedFeeFields } from "../lib/fee-engine.js";
import { computeGrossedUpProviderFee, type PaymentMethodType } from "../lib/provider-fees.js";
import { getStripeClient } from "../lib/stripe.js";
import { logActivity } from "../lib/activity.js";
import { createNotification } from "../lib/notifications.js";
import { sendAutoDripSucceededEmail, sendAutoDripNeedsAttentionEmail } from "../lib/autodrip-email.js";
import { logger } from "../lib/logger.js";
import { lifecycleAllowsNewContribution, contributionLifecycleMessage } from "../lib/jar-status.js";
import { randomUUID } from "node:crypto";

const router = Router();

// ─── Types ────────────────────────────────────────────────────────────────────

type DbOrTx = typeof db;

type AutoDripFrequency = "weekly" | "biweekly" | "monthly" | "twiceMonthly";
const VALID_FREQUENCIES: AutoDripFrequency[] = ["weekly", "biweekly", "monthly", "twiceMonthly"];

// Current terms version shown to the contributor at consent time
const CURRENT_TERMS_VERSION = "1";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Compute the UTC timestamp for 9:00 AM Jar Time on a given calendar date.
 *
 * Delegates to `lib/jar-time.ts`, which solves for the UTC instant whose
 * rendering in the jar's zone equals 09:00 local. The previous inline
 * implementation sampled the zone offset at 09:00 *UTC*, which produced
 * whole-day errors for zones at UTC−10 or further west (Pacific/Honolulu,
 * Pacific/Pago_Pago) and one-hour errors on DST transition dates.
 */
function computeNextRunAt(scheduledDateISO: string, jarTimeZone: string): Date {
  return computeJarTimeRunAt(scheduledDateISO, jarTimeZone);
}

/** Compute the ISO date of the most recent overdue scheduled occurrence for catch-up. */
function findMostRecentOverdueDate(
  schedule: { startDate: string; frequency: string; preferredDay?: number | null },
  lastRunAt: Date | null,
  now: Date,
): string | null {
  // Walk schedule forward from startDate; find the last occurrence strictly before now
  const nowDate = stripTime(now);
  const start = new Date(schedule.startDate + "T00:00:00Z");
  if (start >= nowDate) return null;

  let candidate: Date | null = null;
  let cur = start;
  for (let i = 0; i < 2_000; i++) {
    const next = computeNextDueDate(schedule, cur);
    if (!next) break;
    const nextStripped = stripTime(next);
    if (nextStripped >= nowDate) break; // future — stop
    // Only eligible if after last run
    if (!lastRunAt || nextStripped > stripTime(lastRunAt)) {
      candidate = nextStripped;
    }
    cur = new Date(next.getTime() + 86_400_000);
  }
  return candidate ? toISODate(candidate) : null;
}

/** Advance nextRunAt past all missed occurrences to find the next future one. */
function computeNextFutureRunDate(
  schedule: { startDate: string; frequency: string; preferredDay?: number | null },
  afterNow: Date,
): string | null {
  const next = computeNextDueDate(schedule, afterNow);
  return next ? toISODate(stripTime(next)) : null;
}

/** Verify that a saved_payment_methods row belongs to the given user and is eligible. */
async function verifyPaymentMethodOwnership(
  txDb: DbOrTx,
  spmId: string,
  userId: string,
): Promise<typeof savedPaymentMethods.$inferSelect | null> {
  const [pm] = await txDb
    .select()
    .from(savedPaymentMethods)
    .where(and(eq(savedPaymentMethods.id, spmId), eq(savedPaymentMethods.userId, userId)));
  return pm ?? null;
}

/** Compute remaining expected principal = schedule total - cumulative contributed principal */
async function computeRemainingExpectedPrincipal(
  txDb: DbOrTx,
  jarId: string,
  memberId: string,
): Promise<{ scheduleTotalCents: number; contributedPrincipalCents: number; remainingCents: number }> {
  // Sum of all accepted schedule amounts for this member in this jar
  const schedules = await txDb
    .select({ amountCents: contributionSchedules.amountCents, isActive: contributionSchedules.isActive })
    .from(contributionSchedules)
    .where(and(eq(contributionSchedules.jarId, jarId), eq(contributionSchedules.memberId, memberId)));

  const scheduleTotalCents = schedules
    .filter((s) => s.isActive)
    .reduce((sum, s) => sum + s.amountCents, 0);

  // Sum of all posted contribution principal for this member in this jar
  const [ftRow] = await txDb
    .select({ total: sql<string>`coalesce(sum(${financialTransactions.requestedPrincipalCents}), 0)` })
    .from(financialTransactions)
    .where(
      and(
        eq(financialTransactions.jarId, jarId),
        eq(financialTransactions.memberId, memberId),
        eq(financialTransactions.ledgerPostingStatus, "posted"),
        inArray(financialTransactions.transactionType, ["contribution", "autodrip_contribution"]),
      ),
    );

  const contributedPrincipalCents = Number(ftRow?.total ?? 0);
  const remainingCents = Math.max(0, scheduleTotalCents - contributedPrincipalCents);

  return { scheduleTotalCents, contributedPrincipalCents, remainingCents };
}

function computeQuote(principalCents: number, pmType: PaymentMethodType) {
  const dripJarFeeCents = computeDripJarFee(principalCents);
  const processingFeeCents = computeGrossedUpProviderFee(principalCents + dripJarFeeCents, pmType);
  const totalChargeCents = principalCents + dripJarFeeCents + processingFeeCents;
  return { principalCents, dripJarFeeCents, processingFeeCents, totalChargeCents, feeRateBps: DRIPJAR_FEE_RATE_BPS };
}

// ─── GET /jars/:jarId/autodrip ────────────────────────────────────────────────

router.get("/jars/:jarId/autodrip", requireAuth, async (req, res) => {
  const userId = (req as unknown as AuthenticatedRequest).userId;
  const { jarId } = req.params as { jarId: string };

  const [jar] = await db.select({ id: jars.id, organizerId: jars.organizerId, status: jars.status, cutoffDate: jars.cutoffDate, timeZone: jars.timeZone }).from(jars).where(eq(jars.id, jarId));
  if (!jar) { res.status(404).json({ error: "NotFound", message: "Jar not found" }); return; }

  const [member] = await db
    .select({ id: jarMembers.id, userId: jarMembers.userId })
    .from(jarMembers)
    .where(and(eq(jarMembers.jarId, jarId), eq(jarMembers.userId, userId), eq(jarMembers.status, "active")));

  const isOrganizer = jar.organizerId === userId;
  if (!member && !isOrganizer) {
    res.status(403).json({ error: "Forbidden", message: "Access denied" });
    return;
  }

  if (member) {
    // Contributor view: full detail — only non-terminal authorizations
    const [auth] = await db
      .select()
      .from(autoDripAuthorizations)
      .where(and(
        eq(autoDripAuthorizations.jarId, jarId),
        eq(autoDripAuthorizations.memberId, member.id),
        inArray(autoDripAuthorizations.status, ["active", "paused", "needs_attention"]),
      ))
      .limit(1);

    if (!auth) {
      res.json({ enabled: false, jarTimeZone: jar.timeZone });
      return;
    }

    const [pm] = await db
      .select()
      .from(savedPaymentMethods)
      .where(eq(savedPaymentMethods.id, auth.savedPaymentMethodId));

    const recentRuns = await db
      .select({ id: autoDripRuns.id, status: autoDripRuns.status, scheduledFor: autoDripRuns.scheduledFor, principalCents: autoDripRuns.principalCents, completedAt: autoDripRuns.completedAt, failureCode: autoDripRuns.failureCode })
      .from(autoDripRuns)
      .where(eq(autoDripRuns.autoDripAuthorizationId, auth.id))
      .orderBy(desc(autoDripRuns.startedAt))
      .limit(10);

    res.json({
      enabled: true,
      authorization: {
        id: auth.id,
        status: auth.status,
        principalCents: auth.principalCents,
        frequency: auth.frequency,
        nextRunAt: auth.nextRunAt,
        lastRunAt: auth.lastRunAt,
        needsAttentionReason: auth.needsAttentionReason,
        authorizedAt: auth.authorizedAt,
      },
      paymentMethod: pm ? {
        id: pm.id,
        type: pm.type,
        displayBrand: pm.displayBrand,
        last4: pm.last4,
        bankName: pm.bankName,
        status: pm.status,
      } : null,
      jarTimeZone: jar.timeZone,
      recentRuns,
    });
    return;
  }

  // Organizer view: status pills per member (no payment details)
  const allMembers = await db
    .select({ id: jarMembers.id, userId: jarMembers.userId })
    .from(jarMembers)
    .where(and(eq(jarMembers.jarId, jarId), eq(jarMembers.status, "active")));

  const memberIds = allMembers.map((m) => m.id);

  const auths = memberIds.length > 0
    ? await db
        .select({ memberId: autoDripAuthorizations.memberId, status: autoDripAuthorizations.status })
        .from(autoDripAuthorizations)
        .where(and(eq(autoDripAuthorizations.jarId, jarId), inArray(autoDripAuthorizations.memberId, memberIds)))
    : [];

  const authMap = new Map(auths.map((a) => [a.memberId, a.status]));

  const pills = allMembers.map((m) => {
    const authStatus = authMap.get(m.id);
    let pill = "Off";
    if (authStatus === "active") pill = "Active";
    else if (authStatus === "paused") pill = "Paused";
    else if (authStatus === "needs_attention") pill = "Needs Attention";
    return { memberId: m.id, autoDripStatus: pill };
  });

  res.json({ organizerView: true, memberAutoDripStatuses: pills, jarTimeZone: jar.timeZone });
});

// ─── POST /jars/:jarId/autodrip/preview ───────────────────────────────────────

router.post("/jars/:jarId/autodrip/preview", requireAuth, async (req, res) => {
  const userId = (req as unknown as AuthenticatedRequest).userId;
  const { jarId } = req.params as { jarId: string };

  const tampered = detectTamperedFeeFields(req.body as Record<string, unknown>);
  if (tampered) { res.status(400).json({ error: "BadRequest", message: tampered }); return; }

  const { principalCents, frequency, paymentMethodId } = req.body as {
    principalCents?: unknown;
    frequency?: unknown;
    paymentMethodId?: unknown;
  };

  if (!Number.isInteger(principalCents) || (principalCents as number) < 1) {
    res.status(400).json({ error: "BadRequest", message: "principalCents must be a positive integer" });
    return;
  }
  if (!VALID_FREQUENCIES.includes(frequency as AutoDripFrequency)) {
    res.status(400).json({ error: "BadRequest", message: "frequency must be weekly|biweekly|monthly|twiceMonthly" });
    return;
  }
  if (typeof paymentMethodId !== "string") {
    res.status(400).json({ error: "BadRequest", message: "paymentMethodId is required" });
    return;
  }

  const [jar] = await db.select({ id: jars.id, organizerId: jars.organizerId, timeZone: jars.timeZone }).from(jars).where(eq(jars.id, jarId));
  if (!jar) { res.status(404).json({ error: "NotFound", message: "Jar not found" }); return; }

  const [member] = await db
    .select({ id: jarMembers.id })
    .from(jarMembers)
    .where(and(eq(jarMembers.jarId, jarId), eq(jarMembers.userId, userId), eq(jarMembers.status, "active")));
  if (!member) { res.status(403).json({ error: "Forbidden", message: "You are not an active member of this jar" }); return; }

  const pm = await verifyPaymentMethodOwnership(db, paymentMethodId, userId);
  if (!pm || pm.status !== "active") {
    res.status(400).json({ error: "BadRequest", message: "Payment method not found or not active" });
    return;
  }

  const { remainingCents, scheduleTotalCents, contributedPrincipalCents } = await computeRemainingExpectedPrincipal(db, jarId, member.id);
  const effectivePrincipal = Math.min(principalCents as number, remainingCents > 0 ? remainingCents : (principalCents as number));
  const quote = computeQuote(effectivePrincipal, pm.type as PaymentMethodType);

  // Estimate next run date
  const now = new Date();
  const nextDate = computeNextFutureRunDate({ startDate: now.toISOString().slice(0, 10), frequency: frequency as string }, now);
  const nextRunAt = nextDate ? computeNextRunAt(nextDate, jar.timeZone) : null;

  res.json({
    principalCents: effectivePrincipal,
    configuredPrincipalCents: principalCents,
    dripJarFeeCents: quote.dripJarFeeCents,
    processingFeeCents: quote.processingFeeCents,
    totalChargeCents: quote.totalChargeCents,
    feeRateBps: quote.feeRateBps,
    scheduleTotalCents,
    contributedPrincipalCents,
    remainingExpectedPrincipalCents: remainingCents,
    nextRunAt,
    jarTimeZone: jar.timeZone,
  });
});

// ─── POST /jars/:jarId/autodrip ───────────────────────────────────────────────

router.post("/jars/:jarId/autodrip", requireAuth, async (req, res) => {
  const userId = (req as unknown as AuthenticatedRequest).userId;
  const { jarId } = req.params as { jarId: string };

  const tampered = detectTamperedFeeFields(req.body as Record<string, unknown>);
  if (tampered) { res.status(400).json({ error: "BadRequest", message: tampered }); return; }

  const { principalCents, frequency, paymentMethodId, consentGiven, startDateISO } = req.body as {
    principalCents?: unknown;
    frequency?: unknown;
    paymentMethodId?: unknown;
    consentGiven?: unknown;
    startDateISO?: unknown;
  };

  if (!Number.isInteger(principalCents) || (principalCents as number) < 1) {
    res.status(400).json({ error: "BadRequest", message: "principalCents must be a positive integer" });
    return;
  }
  if (!VALID_FREQUENCIES.includes(frequency as AutoDripFrequency)) {
    res.status(400).json({ error: "BadRequest", message: "frequency must be weekly|biweekly|monthly|twiceMonthly" });
    return;
  }
  if (typeof paymentMethodId !== "string") {
    res.status(400).json({ error: "BadRequest", message: "paymentMethodId is required" });
    return;
  }
  if (consentGiven !== true) {
    res.status(400).json({ error: "BadRequest", message: "consentGiven must be true to enable AutoDrip" });
    return;
  }

  const [jar] = await db.select({ id: jars.id, status: jars.status, cutoffDate: jars.cutoffDate, timeZone: jars.timeZone }).from(jars).where(eq(jars.id, jarId));
  if (!jar) { res.status(404).json({ error: "NotFound", message: "Jar not found" }); return; }

  // Allowlist, not a denylist. The previous check named the two terminal
  // phases, so any status it did not recognise — a legacy value, or one the
  // server gains later — fell through and was allowed to schedule real money.
  if (!lifecycleAllowsNewContribution(jar.status)) {
    res.status(422).json({ error: "JarLifecycle", message: contributionLifecycleMessage(jar.status) });
    return;
  }

  const [member] = await db
    .select({ id: jarMembers.id })
    .from(jarMembers)
    .where(and(eq(jarMembers.jarId, jarId), eq(jarMembers.userId, userId), eq(jarMembers.status, "active")));
  if (!member) { res.status(403).json({ error: "Forbidden", message: "You are not an active member of this jar" }); return; }

  // Require an active contribution schedule
  const [schedule] = await db
    .select()
    .from(contributionSchedules)
    .where(
      and(
        eq(contributionSchedules.jarId, jarId),
        eq(contributionSchedules.memberId, member.id),
        eq(contributionSchedules.isActive, true),
      ),
    )
    .limit(1);

  if (!schedule) {
    res.status(409).json({
      error: "Conflict",
      message: "An active contribution schedule is required before enabling AutoDrip. Please set up your savings schedule first.",
    });
    return;
  }

  // Check existing active/paused authorization
  const [existingAuth] = await db
    .select({ id: autoDripAuthorizations.id, status: autoDripAuthorizations.status })
    .from(autoDripAuthorizations)
    .where(
      and(
        eq(autoDripAuthorizations.jarId, jarId),
        eq(autoDripAuthorizations.memberId, member.id),
        inArray(autoDripAuthorizations.status, ["active", "paused", "needs_attention"]),
      ),
    )
    .limit(1);

  if (existingAuth) {
    res.status(409).json({ error: "Conflict", message: "AutoDrip is already enabled. Use PATCH to modify or POST /pause to pause." });
    return;
  }

  const pm = await verifyPaymentMethodOwnership(db, paymentMethodId, userId);
  if (!pm || pm.status !== "active") {
    res.status(400).json({ error: "BadRequest", message: "Payment method not found or not active (must be verified)" });
    return;
  }

  // Compute remainingExpectedPrincipal to ensure there's something to drip
  const { remainingCents } = await computeRemainingExpectedPrincipal(db, jarId, member.id);
  if (remainingCents <= 0) {
    res.status(409).json({ error: "Conflict", message: "No remaining expected principal. Your schedule is already fulfilled." });
    return;
  }

  // Compute first nextRunAt from startDateISO or next schedule occurrence
  const startDate = typeof startDateISO === "string" && startDateISO.match(/^\d{4}-\d{2}-\d{2}$/)
    ? startDateISO
    : null;
  const now = new Date();
  const nextDateISO = startDate && startDate > now.toISOString().slice(0, 10)
    ? startDate
    : computeNextFutureRunDate(schedule, now);

  if (!nextDateISO) {
    res.status(409).json({ error: "Conflict", message: "Could not determine next AutoDrip date from schedule" });
    return;
  }

  const nextRunAt = computeNextRunAt(nextDateISO, jar.timeZone);

  const [auth] = await db
    .insert(autoDripAuthorizations)
    .values({
      jarId,
      memberId: member.id,
      userId,
      savedPaymentMethodId: paymentMethodId,
      principalCents: principalCents as number,
      frequency: frequency as AutoDripFrequency,
      status: "active",
      authorizedAt: new Date(),
      authorizationTermsVersion: CURRENT_TERMS_VERSION,
      nextRunAt,
    })
    .returning();

  if (!auth) { res.status(500).json({ error: "InternalError", message: "Failed to create AutoDrip authorization" }); return; }

  await logActivity({
    jarId,
    userId,
    eventType: "autodrip_enabled",
    description: `AutoDrip enabled`,
    metadata: { principalCents, frequency },
  });

  res.status(201).json({ authorization: serializeAuthForContributor(auth), nextRunAt });
});

// ─── PATCH /jars/:jarId/autodrip ──────────────────────────────────────────────

router.patch("/jars/:jarId/autodrip", requireAuth, async (req, res) => {
  const userId = (req as unknown as AuthenticatedRequest).userId;
  const { jarId } = req.params as { jarId: string };

  const tampered = detectTamperedFeeFields(req.body as Record<string, unknown>);
  if (tampered) { res.status(400).json({ error: "BadRequest", message: tampered }); return; }

  const { principalCents, frequency, paymentMethodId } = req.body as {
    principalCents?: unknown;
    frequency?: unknown;
    paymentMethodId?: unknown;
  };

  const [jar] = await db.select({ id: jars.id, timeZone: jars.timeZone }).from(jars).where(eq(jars.id, jarId));
  if (!jar) { res.status(404).json({ error: "NotFound", message: "Jar not found" }); return; }

  const [member] = await db
    .select({ id: jarMembers.id })
    .from(jarMembers)
    .where(and(eq(jarMembers.jarId, jarId), eq(jarMembers.userId, userId), eq(jarMembers.status, "active")));
  if (!member) { res.status(403).json({ error: "Forbidden", message: "You are not an active member of this jar" }); return; }

  const [auth] = await db
    .select()
    .from(autoDripAuthorizations)
    .where(
      and(
        eq(autoDripAuthorizations.jarId, jarId),
        eq(autoDripAuthorizations.memberId, member.id),
        inArray(autoDripAuthorizations.status, ["active", "paused", "needs_attention"]),
      ),
    )
    .limit(1);

  if (!auth) { res.status(404).json({ error: "NotFound", message: "No active AutoDrip found" }); return; }

  const updates: Record<string, unknown> = { updatedAt: new Date() };

  if (principalCents !== undefined) {
    if (!Number.isInteger(principalCents) || (principalCents as number) < 1) {
      res.status(400).json({ error: "BadRequest", message: "principalCents must be a positive integer" });
      return;
    }
    updates.principalCents = principalCents;
  }

  if (frequency !== undefined) {
    if (!VALID_FREQUENCIES.includes(frequency as AutoDripFrequency)) {
      res.status(400).json({ error: "BadRequest", message: "Invalid frequency" });
      return;
    }
    updates.frequency = frequency;
  }

  if (paymentMethodId !== undefined) {
    if (typeof paymentMethodId !== "string") {
      res.status(400).json({ error: "BadRequest", message: "paymentMethodId must be a string" });
      return;
    }
    const pm = await verifyPaymentMethodOwnership(db, paymentMethodId, userId);
    if (!pm || pm.status !== "active") {
      res.status(400).json({ error: "BadRequest", message: "Payment method not found or not active" });
      return;
    }
    updates.savedPaymentMethodId = paymentMethodId;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [updated] = await db
    .update(autoDripAuthorizations)
    .set(updates as any)
    .where(eq(autoDripAuthorizations.id, auth.id))
    .returning();

  if (paymentMethodId) {
    await logActivity({ jarId, userId, eventType: "autodrip_payment_method_changed", description: "AutoDrip payment method updated" });
  }

  res.json({ authorization: serializeAuthForContributor(updated!) });
});

// ─── POST /jars/:jarId/autodrip/pause ─────────────────────────────────────────

router.post("/jars/:jarId/autodrip/pause", requireAuth, async (req, res) => {
  const userId = (req as unknown as AuthenticatedRequest).userId;
  const { jarId } = req.params as { jarId: string };

  const [member] = await db
    .select({ id: jarMembers.id })
    .from(jarMembers)
    .where(and(eq(jarMembers.jarId, jarId), eq(jarMembers.userId, userId), eq(jarMembers.status, "active")));
  if (!member) { res.status(403).json({ error: "Forbidden", message: "Access denied" }); return; }

  const [auth] = await db
    .select({ id: autoDripAuthorizations.id, status: autoDripAuthorizations.status })
    .from(autoDripAuthorizations)
    .where(
      and(
        eq(autoDripAuthorizations.jarId, jarId),
        eq(autoDripAuthorizations.memberId, member.id),
        eq(autoDripAuthorizations.status, "active"),
      ),
    )
    .limit(1);

  if (!auth) { res.status(404).json({ error: "NotFound", message: "No active AutoDrip to pause" }); return; }

  await db
    .update(autoDripAuthorizations)
    .set({ status: "paused", pausedAt: new Date(), updatedAt: new Date() })
    .where(eq(autoDripAuthorizations.id, auth.id));

  await logActivity({ jarId, userId, eventType: "autodrip_paused", description: "AutoDrip paused" });
  res.json({ success: true });
});

// ─── POST /jars/:jarId/autodrip/resume ────────────────────────────────────────

router.post("/jars/:jarId/autodrip/resume", requireAuth, async (req, res) => {
  const userId = (req as unknown as AuthenticatedRequest).userId;
  const { jarId } = req.params as { jarId: string };

  const [jar] = await db.select({ id: jars.id, status: jars.status, cutoffDate: jars.cutoffDate, timeZone: jars.timeZone }).from(jars).where(eq(jars.id, jarId));
  if (!jar) { res.status(404).json({ error: "NotFound", message: "Jar not found" }); return; }

  // Allowlist — see the note on the enable path above.
  if (!lifecycleAllowsNewContribution(jar.status)) {
    res.status(422).json({ error: "JarLifecycle", message: contributionLifecycleMessage(jar.status) });
    return;
  }

  const [member] = await db
    .select({ id: jarMembers.id })
    .from(jarMembers)
    .where(and(eq(jarMembers.jarId, jarId), eq(jarMembers.userId, userId), eq(jarMembers.status, "active")));
  if (!member) { res.status(403).json({ error: "Forbidden", message: "Access denied" }); return; }

  const [auth] = await db
    .select()
    .from(autoDripAuthorizations)
    .where(
      and(
        eq(autoDripAuthorizations.jarId, jarId),
        eq(autoDripAuthorizations.memberId, member.id),
        inArray(autoDripAuthorizations.status, ["paused", "needs_attention"]),
      ),
    )
    .limit(1);

  if (!auth) { res.status(404).json({ error: "NotFound", message: "No paused or needs_attention AutoDrip found" }); return; }

  // Verify payment method is still valid
  const pm = await verifyPaymentMethodOwnership(db, auth.savedPaymentMethodId, userId);
  if (!pm || pm.status !== "active") {
    res.status(409).json({ error: "Conflict", message: "Payment method is no longer active. Update your payment method before resuming." });
    return;
  }

  // Verify remaining principal > 0
  const { remainingCents } = await computeRemainingExpectedPrincipal(db, jarId, member.id);
  if (remainingCents <= 0) {
    res.status(409).json({ error: "Conflict", message: "No remaining expected principal. Your schedule is fulfilled." });
    return;
  }

  // Compute next future occurrence
  const schedule = await db
    .select()
    .from(contributionSchedules)
    .where(and(eq(contributionSchedules.jarId, jarId), eq(contributionSchedules.memberId, member.id), eq(contributionSchedules.isActive, true)))
    .limit(1)
    .then((rows) => rows[0]);

  const now = new Date();
  const nextDateISO = schedule
    ? computeNextFutureRunDate(schedule, now)
    : null;

  if (!nextDateISO) {
    res.status(409).json({ error: "Conflict", message: "Could not determine next AutoDrip date" });
    return;
  }

  const nextRunAt = computeNextRunAt(nextDateISO, jar.timeZone);

  await db
    .update(autoDripAuthorizations)
    .set({
      status: "active",
      pausedAt: null,
      needsAttentionAt: null,
      needsAttentionReason: null,
      nextRunAt,
      updatedAt: new Date(),
    })
    .where(eq(autoDripAuthorizations.id, auth.id));

  await logActivity({ jarId, userId, eventType: "autodrip_resumed", description: "AutoDrip resumed" });
  res.json({ success: true, nextRunAt });
});

// ─── DELETE /jars/:jarId/autodrip ─────────────────────────────────────────────

router.delete("/jars/:jarId/autodrip", requireAuth, async (req, res) => {
  const userId = (req as unknown as AuthenticatedRequest).userId;
  const { jarId } = req.params as { jarId: string };

  const [member] = await db
    .select({ id: jarMembers.id })
    .from(jarMembers)
    .where(and(eq(jarMembers.jarId, jarId), eq(jarMembers.userId, userId), eq(jarMembers.status, "active")));
  if (!member) { res.status(403).json({ error: "Forbidden", message: "Access denied" }); return; }

  const [auth] = await db
    .select({ id: autoDripAuthorizations.id })
    .from(autoDripAuthorizations)
    .where(
      and(
        eq(autoDripAuthorizations.jarId, jarId),
        eq(autoDripAuthorizations.memberId, member.id),
        inArray(autoDripAuthorizations.status, ["active", "paused", "needs_attention"]),
      ),
    )
    .limit(1);

  if (!auth) { res.status(404).json({ error: "NotFound", message: "No active AutoDrip found" }); return; }

  await db
    .update(autoDripAuthorizations)
    .set({ status: "cancelled", cancelledAt: new Date(), updatedAt: new Date() })
    .where(eq(autoDripAuthorizations.id, auth.id));

  await logActivity({ jarId, userId, eventType: "autodrip_cancelled", description: "AutoDrip cancelled" });
  res.status(204).send();
});

// ─── POST /internal/process-autodrips ─────────────────────────────────────────

function requireInternalToken(
  req: import("express").Request,
  res: import("express").Response,
  next: import("express").NextFunction,
) {
  const configuredToken = process.env["INTERNAL_REMINDER_TOKEN"];
  if (!configuredToken) {
    res.status(503).json({ error: "ServiceUnavailable", message: "INTERNAL_REMINDER_TOKEN is not configured" });
    return;
  }
  const provided = req.headers["x-internal-token"];
  if (typeof provided !== "string") {
    res.status(403).json({ error: "Forbidden", message: "Invalid internal token" });
    return;
  }
  const provBuf = Buffer.from(provided);
  const cfgBuf = Buffer.from(configuredToken);
  const lengthsMatch = provBuf.length === cfgBuf.length;
  const cmpBuf = lengthsMatch ? cfgBuf : Buffer.alloc(provBuf.length);
  if (!crypto.timingSafeEqual(provBuf, cmpBuf) || !lengthsMatch) {
    res.status(403).json({ error: "Forbidden", message: "Invalid internal token" });
    return;
  }
  next();
}

router.post("/internal/process-autodrips", requireInternalToken, async (req, res) => {
  const now = new Date();
  const results = { processed: 0, skipped: 0, errors: 0 };

  // Find all active authorizations with next_run_at <= now
  const dueCandidates = await db
    .select({ id: autoDripAuthorizations.id })
    .from(autoDripAuthorizations)
    .where(
      and(
        eq(autoDripAuthorizations.status, "active"),
        lte(autoDripAuthorizations.nextRunAt, now),
      ),
    );

  for (const candidate of dueCandidates) {
    try {
      await processOneAuthorization(candidate.id, now, results);
    } catch (err) {
      logger.error(
        { err: { message: (err as Error).message }, authorizationId: candidate.id },
        "AutoDrip processor: unhandled error for authorization",
      );
      results.errors++;
    }
  }

  logger.info({ ...results, dueCount: dueCandidates.length }, "AutoDrip processor completed");
  res.json({ success: true, ...results });
});

async function processOneAuthorization(
  authId: string,
  now: Date,
  results: { processed: number; skipped: number; errors: number },
) {
  await db.transaction(async (tx) => {
    const txDb = tx as unknown as DbOrTx;

    // Lock authorization row — SKIP LOCKED ensures exactly-once under concurrency
    const [auth] = await txDb
      .select()
      .from(autoDripAuthorizations)
      .where(and(eq(autoDripAuthorizations.id, authId), eq(autoDripAuthorizations.status, "active")))
      .for("update", { skipLocked: true });

    if (!auth) {
      // Either another worker claimed it or status changed — skip silently
      results.skipped++;
      return;
    }

    // Load jar for timezone + phase check
    const [jar] = await txDb
      .select({ id: jars.id, status: jars.status, cutoffDate: jars.cutoffDate, timeZone: jars.timeZone })
      .from(jars)
      .where(eq(jars.id, auth.jarId));

    if (!jar) { results.skipped++; return; }

    // Allowlist — automation must not create a charge against a jar whose
    // status it cannot classify, so an unrecognised value stops the run here
    // rather than falling through to the charge below.
    if (!lifecycleAllowsNewContribution(jar.status)) {
      // Jar no longer accepts contributions — cancel this authorization
      await txDb
        .update(autoDripAuthorizations)
        .set({ status: "cancelled", cancelledAt: now, updatedAt: now })
        .where(eq(autoDripAuthorizations.id, authId));
      results.skipped++;
      return;
    }

    // ── Catch-up logic ──────────────────────────────────────────────────────
    // If multiple occurrences are overdue, select the MOST RECENT one.
    // Permanently skip all older missed occurrences.
    // This is the catch-up occurrence to process.

    // Find the schedule for this member
    const [schedule] = await txDb
      .select()
      .from(contributionSchedules)
      .where(
        and(
          eq(contributionSchedules.jarId, auth.jarId),
          eq(contributionSchedules.memberId, auth.memberId),
          eq(contributionSchedules.isActive, true),
        ),
      )
      .limit(1);

    if (!schedule) { results.skipped++; return; }

    // Determine which scheduled occurrence date this run should cover.
    // The processor found this auth because nextRunAt <= now.
    // If multiple occurrences passed (catch-up scenario), select the most recent.
    const scheduleLike = {
      startDate: schedule.startDate,
      frequency: schedule.frequency,
      preferredDay: schedule.preferredDay,
    };

    const mostRecentOverdueISO = findMostRecentOverdueDate(
      scheduleLike,
      auth.lastRunAt,
      now,
    );

    if (!mostRecentOverdueISO) {
      // nextRunAt <= now but no overdue date found — clock skew or edge case; skip
      results.skipped++;
      return;
    }

    // Idempotency key: unique per (authorization, scheduledFor)
    const idempotencyKey = `autodrip:${authId}:${mostRecentOverdueISO}`;

    // Check if this occurrence already has a run row (exactly-once guard)
    const [existingRun] = await txDb
      .select({ id: autoDripRuns.id, status: autoDripRuns.status })
      .from(autoDripRuns)
      .where(eq(autoDripRuns.idempotencyKey, idempotencyKey));

    if (existingRun) {
      // Already processed by a concurrent worker — advance nextRunAt and exit
      const nextDate = computeNextFutureRunDate(scheduleLike, now);
      if (nextDate) {
        await txDb
          .update(autoDripAuthorizations)
          .set({ nextRunAt: computeNextRunAt(nextDate, jar.timeZone), updatedAt: now })
          .where(eq(autoDripAuthorizations.id, authId));
      }
      results.skipped++;
      return;
    }

    // ── Compute effectivePrincipal ──────────────────────────────────────────
    const { remainingCents } = await computeRemainingExpectedPrincipal(txDb, auth.jarId, auth.memberId);

    if (remainingCents <= 0) {
      // Schedule fulfilled — complete the authorization
      await txDb
        .update(autoDripAuthorizations)
        .set({ status: "completed", completedAt: now, updatedAt: now })
        .where(eq(autoDripAuthorizations.id, authId));
      results.skipped++;
      return;
    }

    const effectivePrincipal = Math.min(auth.principalCents, remainingCents);

    // ── Verify payment method is still active ───────────────────────────────
    const [pm] = await txDb
      .select()
      .from(savedPaymentMethods)
      .where(eq(savedPaymentMethods.id, auth.savedPaymentMethodId));

    if (!pm || pm.status !== "active") {
      // Payment method gone — set needs_attention
      await txDb
        .update(autoDripAuthorizations)
        .set({
          status: "needs_attention",
          needsAttentionAt: now,
          needsAttentionReason: "Payment method is no longer active",
          updatedAt: now,
        })
        .where(eq(autoDripAuthorizations.id, authId));
      results.skipped++;
      return;
    }

    // ── Pre-generate run UUID ───────────────────────────────────────────────
    const runId = randomUUID();

    // ── Insert run row (idempotency guard) ──────────────────────────────────
    await txDb.insert(autoDripRuns).values({
      id: runId,
      autoDripAuthorizationId: authId,
      scheduledFor: mostRecentOverdueISO,
      principalCents: effectivePrincipal,
      status: "processing",
      idempotencyKey,
      attemptCount: 1,
      startedAt: now,
    });

    // ── Create Stripe PaymentIntent (off-session) ───────────────────────────
    const pmType = pm.type as PaymentMethodType;
    const processingFeeCents = computeGrossedUpProviderFee(
      effectivePrincipal + computeDripJarFee(effectivePrincipal),
      pmType,
    );
    const totalChargeCents = effectivePrincipal + computeDripJarFee(effectivePrincipal) + processingFeeCents;

    let pi;
    try {
      const stripe = getStripeClient();
      pi = await stripe.paymentIntents.create(
        {
          amount: totalChargeCents,
          currency: "usd",
          customer: pm.stripeCustomerId,
          payment_method: pm.stripePaymentMethodId,
          confirm: true,
          off_session: true,
          metadata: {
            source: "autodrip",
            autoDripRunId: runId,
            autoDripAuthorizationId: authId,
            jarId: auth.jarId,
            memberId: auth.memberId,
            scheduledFor: mostRecentOverdueISO,
          },
        },
        { idempotencyKey: `autodrip-pi:${idempotencyKey}` },
      );
    } catch (stripeErr) {
      // Stripe rejected the charge — mark run failed, authorization needs_attention
      const failMsg = (stripeErr as Error).message ?? "Stripe payment failed";
      await txDb
        .update(autoDripRuns)
        .set({ status: "failed", failureMessage: failMsg, completedAt: now })
        .where(eq(autoDripRuns.id, runId));
      await txDb
        .update(autoDripAuthorizations)
        .set({
          status: "needs_attention",
          needsAttentionAt: now,
          needsAttentionReason: failMsg,
          updatedAt: now,
        })
        .where(eq(autoDripAuthorizations.id, authId));
      // Email notification (best-effort, outside tx commit)
      void notifyAutoDripNeedsAttention(auth, failMsg);
      results.errors++;
      return;
    }

    // ── Update run with PI ID ───────────────────────────────────────────────
    await txDb
      .update(autoDripRuns)
      .set({ stripePaymentIntentId: pi.id })
      .where(eq(autoDripRuns.id, runId));

    // ── Advance nextRunAt ───────────────────────────────────────────────────
    const nextDate = computeNextFutureRunDate(scheduleLike, now);
    await txDb
      .update(autoDripAuthorizations)
      .set({
        lastRunAt: now,
        nextRunAt: nextDate ? computeNextRunAt(nextDate, jar.timeZone) : auth.nextRunAt,
        updatedAt: now,
      })
      .where(eq(autoDripAuthorizations.id, authId));

    // Handle immediate PI result (card might succeed synchronously in test mode)
    if (pi.status === "succeeded") {
      // Will be handled by webhook; processor's job is done
    } else if (pi.status === "requires_action" || pi.status === "requires_payment_method") {
      // action_required → needs_attention
      await txDb
        .update(autoDripRuns)
        .set({ status: "action_required", failureMessage: `Stripe PI status: ${pi.status}`, completedAt: now })
        .where(eq(autoDripRuns.id, runId));
      await txDb
        .update(autoDripAuthorizations)
        .set({
          status: "needs_attention",
          needsAttentionAt: now,
          needsAttentionReason: "Payment requires additional authentication",
          updatedAt: now,
        })
        .where(eq(autoDripAuthorizations.id, authId));
      void notifyAutoDripNeedsAttention(auth, "Payment requires additional authentication");
    }

    results.processed++;
    logger.info({ authId, runId, effectivePrincipal, piId: pi.id, piStatus: pi.status }, "AutoDrip run initiated");
  });
}

// ─── Post-processor notification helpers ─────────────────────────────────────

export async function notifyAutoDripNeedsAttention(
  auth: typeof autoDripAuthorizations.$inferSelect,
  reason: string,
) {
  try {
    const [profile] = await db
      .select({ displayName: profiles.displayName })
      .from(profiles)
      .where(eq(profiles.userId, auth.userId));
    const [userRow] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, auth.userId));
    const [jarRow] = await db
      .select({ name: jars.name })
      .from(jars)
      .where(eq(jars.id, auth.jarId));

    if (!userRow || !jarRow) return;

    void sendAutoDripNeedsAttentionEmail({
      toEmail: userRow.email,
      displayName: profile?.displayName ?? userRow.email,
      jarName: jarRow.name,
      jarId: auth.jarId,
      reason,
    });

    void createNotification({
      userId: auth.userId,
      type: "autodrip_needs_attention",
      title: "AutoDrip Needs Attention",
      message: `Your AutoDrip to ${jarRow.name} encountered a problem and has been paused. Tap to fix.`,
      relatedJarId: auth.jarId,
    });
  } catch (err) {
    logger.warn({ err: { message: (err as Error).message } }, "Failed to send AutoDrip needs-attention notification");
  }
}

export async function notifyAutoDripSucceeded(
  auth: { userId: string; jarId: string; principalCents: number; frequency: string },
) {
  try {
    const [userRow] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, auth.userId));
    const [profileRow] = await db
      .select({ displayName: profiles.displayName })
      .from(profiles)
      .where(eq(profiles.userId, auth.userId));
    const [jarRow] = await db
      .select({ name: jars.name })
      .from(jars)
      .where(eq(jars.id, auth.jarId));

    if (!userRow || !jarRow) return;

    void sendAutoDripSucceededEmail({
      toEmail: userRow.email,
      displayName: profileRow?.displayName ?? userRow.email,
      jarName: jarRow.name,
      jarId: auth.jarId,
      principalCents: auth.principalCents,
      frequency: auth.frequency,
    });

    void createNotification({
      userId: auth.userId,
      type: "autodrip_succeeded",
      title: "AutoDrip Processed",
      message: `Your automatic Drip to ${jarRow.name} was processed successfully.`,
      relatedJarId: auth.jarId,
    });
  } catch (err) {
    logger.warn({ err: { message: (err as Error).message } }, "Failed to send AutoDrip succeeded notification");
  }
}

// ─── Serializers ──────────────────────────────────────────────────────────────

function serializeAuthForContributor(auth: typeof autoDripAuthorizations.$inferSelect) {
  return {
    id: auth.id,
    status: auth.status,
    principalCents: auth.principalCents,
    frequency: auth.frequency,
    nextRunAt: auth.nextRunAt,
    lastRunAt: auth.lastRunAt,
    authorizedAt: auth.authorizedAt,
    needsAttentionReason: auth.needsAttentionReason,
  };
}

// ─── Exports for webhook handler ──────────────────────────────────────────────

export { computeNextRunAt };

export default router;
