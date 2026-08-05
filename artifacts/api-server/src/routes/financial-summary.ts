/**
 * Financial Summary Route — Phase 4D
 *
 * GET /jars/:jarId/financial-summary
 *
 * Returns jar-level financial totals, goal waterfall allocations, and
 * per-member financial breakdowns with privacy-aware redaction.
 *
 * Privacy model:
 *   - Organizer: exact financial figures for all members
 *   - Regular member: own exact figures + progress%/statusLabel for others
 *
 * All values are ledger-backed (immutable ledger_entries) — never from
 * mutable columns or the contributions table.
 * Fees are never counted toward jar progress or goal targets.
 */

import { Router } from "express";
import { db } from "@workspace/db";
import { jars, jarMembers, profiles, jarGoals } from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../lib/auth.js";
import { getJarFinancialBalance } from "../lib/financial-balance.js";
import { getJarPrincipalBreakdown } from "../lib/financial-balance.js";
import { computeGoalWaterfall, memberStatusLabel } from "../lib/goal-waterfall.js";

const router = Router();

// GET /jars/:jarId/financial-summary
router.get("/jars/:jarId/financial-summary", requireAuth, async (req, res) => {
  const userId = (req as unknown as AuthenticatedRequest).userId;
  const { jarId } = req.params as { jarId: string };

  // Load jar + check it exists
  const [jar] = await db.select().from(jars).where(eq(jars.id, jarId)).limit(1);
  if (!jar) { res.status(404).json({ error: "NotFound", message: "Jar not found" }); return; }

  // Check active membership
  const [viewerMember] = await db
    .select({ id: jarMembers.id, role: jarMembers.role })
    .from(jarMembers)
    .where(and(eq(jarMembers.jarId, jarId), eq(jarMembers.userId, userId), eq(jarMembers.status, "active")))
    .limit(1);

  const viewerIsOrganizer = jar.organizerId === userId;
  if (!viewerIsOrganizer && !viewerMember) {
    res.status(403).json({ error: "Forbidden", message: "You do not have access to this jar" });
    return;
  }

  // Parallel data fetch
  const [jarBalance, activeGoals, memberRows] = await Promise.all([
    getJarFinancialBalance(jarId, jar.currency),
    db
      .select()
      .from(jarGoals)
      .where(and(eq(jarGoals.jarId, jarId), eq(jarGoals.status, "active")))
      .orderBy(asc(jarGoals.sortOrder), asc(jarGoals.createdAt)),
    db
      .select({
        id: jarMembers.id,
        userId: jarMembers.userId,
        role: jarMembers.role,
        contributionTargetCents: jarMembers.contributionTargetCents,
        displayName: profiles.displayName,
        avatarUrl: profiles.avatarUrl,
      })
      .from(jarMembers)
      .innerJoin(profiles, eq(profiles.userId, jarMembers.userId))
      .where(and(eq(jarMembers.jarId, jarId), eq(jarMembers.status, "active"))),
  ]);

  // Jar-level principal breakdown (canonical saved = refundable + committed)
  const breakdown = await getJarPrincipalBreakdown(jarId);
  const { savedPrincipalCents, committedPrincipalCents } = breakdown;

  // Goal waterfall
  const waterfall = computeGoalWaterfall(activeGoals, savedPrincipalCents, committedPrincipalCents);
  const activeGoalTargetSum = activeGoals.reduce((s, g) => s + g.targetPrincipalCents, 0);
  const unallocatedCents = Math.max(0, jar.goalAmountCents - activeGoalTargetSum);

  // Jar summary
  const savedPercent =
    jar.goalAmountCents > 0
      ? Math.min(100, Math.round((savedPrincipalCents / jar.goalAmountCents) * 1000) / 10)
      : 0;
  const committedPercent =
    jar.goalAmountCents > 0
      ? Math.min(100, Math.round((committedPrincipalCents / jar.goalAmountCents) * 1000) / 10)
      : 0;
  const remainingToSaveCents = Math.max(0, jar.goalAmountCents - savedPrincipalCents);
  const isOverTarget = savedPrincipalCents > jar.goalAmountCents;
  const overTargetByCents = isOverTarget ? savedPrincipalCents - jar.goalAmountCents : 0;

  // Build member balance lookup map: memberId (jarMembers.id) → MemberFinancialBalance
  const balanceMap = new Map(jarBalance.memberBalances.map((b) => [b.memberId, b]));

  // Determine viewer's member id for privacy-aware response
  const viewerMemberId = viewerMember?.id ?? null;

  // Build member summaries
  const members = memberRows.map((m) => {
    const balance = balanceMap.get(m.id);
    const memberSavedPrincipal = (balance?.refundablePrincipalCents ?? 0) + (balance?.committedPrincipalCents ?? 0);
    const statusLabel = memberStatusLabel({
      committedPrincipalCents: balance?.committedPrincipalCents ?? 0,
      refundPendingCents: balance?.refundPendingCents ?? 0,
      savedPrincipalCents: memberSavedPrincipal,
    });

    const base = {
      memberId: m.id,
      userId: m.userId,
      displayName: m.displayName,
      avatarUrl: m.avatarUrl,
      role: m.role,
    };

    // Organizer sees exact figures for all members
    // Members see own exact figures + redacted (%) for others
    if (viewerIsOrganizer || m.id === viewerMemberId) {
      return {
        ...base,
        isOwnData: m.id === viewerMemberId,
        contributedPrincipalCents: balance?.contributedPrincipalCents ?? 0,
        refundablePrincipalCents: balance?.refundablePrincipalCents ?? 0,
        refundPendingCents: balance?.refundPendingCents ?? 0,
        committedPrincipalCents: balance?.committedPrincipalCents ?? 0,
        refundedPrincipalCents: balance?.refundedPrincipalCents ?? 0,
        savedPrincipalCents: memberSavedPrincipal,
        dripJarFeesEarnedCents: balance?.dripJarFeesEarnedCents ?? 0,
        processingFeesEstimatedCents: balance?.processingFeesEstimatedCents ?? 0,
        invariantHolds: balance?.invariantHolds ?? true,
        statusLabel,
        // Percentage of their individual contribution target
        savedPercent:
          m.contributionTargetCents > 0
            ? Math.min(100, Math.round((memberSavedPrincipal / m.contributionTargetCents) * 1000) / 10)
            : 0,
      };
    }

    // Redacted view: only progress% and status
    return {
      ...base,
      isOwnData: false,
      statusLabel,
      savedPercent:
        m.contributionTargetCents > 0
          ? Math.min(100, Math.round((memberSavedPrincipal / m.contributionTargetCents) * 1000) / 10)
          : 0,
    };
  });

  res.json({
    jar: {
      jarId: jar.id,
      goalAmountCents: jar.goalAmountCents,
      currency: jar.currency,
      savedPrincipalCents,
      committedPrincipalCents,
      refundablePrincipalCents: breakdown.refundablePrincipalCents,
      refundPendingCents: breakdown.refundPendingCents,
      refundedLifetimeCents: breakdown.refundedPrincipalCents,
      remainingToSaveCents,
      dripJarFeesTotalCents: jarBalance.totalDripJarRevenueAssociatedCents,
      processingFeesTotalCents: jarBalance.totalProcessingFeesEstimatedCents,
      savedPercent,
      committedPercent,
      isOverTarget,
      overTargetByCents,
    },
    goals: waterfall.goals,
    unallocatedCents,
    surplusCents: waterfall.surplusCents,
    members,
    viewerRole: viewerIsOrganizer ? "organizer" : "member",
    invariantHolds: jarBalance.invariantHolds,
  });
});

export default router;
