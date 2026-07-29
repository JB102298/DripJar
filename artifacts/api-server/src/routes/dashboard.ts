import { Router } from "express";
import { db } from "@workspace/db";
import {
  jars,
  jarMembers,
  contributions,
  profiles,
  notifications,
  activityEvents,
} from "@workspace/db";
import { eq, and, desc, sql, inArray, count } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../lib/auth.js";
import { calculateJarHealth, calculateMemberHealth } from "../lib/jar-health.js";

const router = Router();

// GET /dashboard
router.get("/dashboard", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;

  // Get all jars for this user
  const userMemberships = await db
    .select()
    .from(jarMembers)
    .where(and(eq(jarMembers.userId, userId), eq(jarMembers.status, "active")));

  const memberJarIds = userMemberships.map((m) => m.jarId);

  const userJars = memberJarIds.length > 0
    ? await db
        .select()
        .from(jars)
        .where(inArray(jars.id, memberJarIds))
        .orderBy(desc(jars.updatedAt))
    : [];

  // Active jars in saving phase
  const activeJars = userJars.filter((j) => ["Saving", "CommitmentPending", "Committed"].includes(j.status));
  const totalJars = userJars.length;
  const activeJarsCount = activeJars.length;

  // Unread notifications
  const unreadResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.isRead, false)));
  const unreadNotifications = Number(unreadResult[0]?.count ?? 0);

  // Featured jar: most recently active saving jar
  const featuredJar = activeJars[0] ?? userJars[0] ?? null;

  let featuredJarData = null;
  let personalProgress = null;
  let memberProgress: unknown[] = [];
  let upcomingActivity: unknown[] = [];

  if (featuredJar) {
    // Total saved for featured jar
    const savedResult = await db
      .select({ total: sql<number>`coalesce(sum(${contributions.amountCents}), 0)` })
      .from(contributions)
      .where(
        and(
          eq(contributions.jarId, featuredJar.id),
          inArray(contributions.status, ["completed", "simulated"]),
        ),
      );
    const totalSavedCents = Number(savedResult[0]?.total ?? 0);
    const percentFunded = featuredJar.goalAmountCents > 0
      ? Math.min(100, (totalSavedCents / featuredJar.goalAmountCents) * 100)
      : 0;

    const memberCount = await db
      .select({ count: sql<number>`count(*)` })
      .from(jarMembers)
      .where(and(eq(jarMembers.jarId, featuredJar.id), eq(jarMembers.status, "active")));

    let health = null;
    if (featuredJar.launchedAt) {
      health = calculateJarHealth(
        featuredJar.goalAmountCents,
        totalSavedCents,
        featuredJar.launchedAt,
        new Date(featuredJar.targetDate),
      );
    }

    const daysRem = Math.max(0, Math.ceil((new Date(featuredJar.targetDate).getTime() - Date.now()) / 86_400_000));

    featuredJarData = {
      id: featuredJar.id,
      organizerId: featuredJar.organizerId,
      name: featuredJar.name,
      category: featuredJar.category,
      destination: featuredJar.destination,
      coverImageUrl: featuredJar.coverImageUrl,
      targetDate: featuredJar.targetDate,
      goalAmountCents: featuredJar.goalAmountCents,
      currency: featuredJar.currency,
      status: featuredJar.status,
      memberCount: Number(memberCount[0]?.count ?? 0),
      totalSavedCents,
      percentFunded,
      daysRemaining: daysRem,
      userRole: userMemberships.find((m) => m.jarId === featuredJar.id)?.role ?? null,
      health,
    };

    // Personal progress for featured jar
    const myMembership = userMemberships.find((m) => m.jarId === featuredJar.id);
    if (myMembership) {
      const myContribs = await db
        .select({ total: sql<number>`coalesce(sum(${contributions.amountCents}), 0)` })
        .from(contributions)
        .where(
          and(
            eq(contributions.jarId, featuredJar.id),
            eq(contributions.memberId, myMembership.id),
            inArray(contributions.status, ["completed", "simulated"]),
          ),
        );
      const contributedAmountCents = Number(myContribs[0]?.total ?? 0);
      const remainingAmountCents = Math.max(0, myMembership.contributionTargetCents - contributedAmountCents);
      const percentComplete = myMembership.contributionTargetCents > 0
        ? Math.min(100, (contributedAmountCents / myMembership.contributionTargetCents) * 100)
        : 0;

      personalProgress = {
        targetAmountCents: myMembership.contributionTargetCents,
        contributedAmountCents,
        remainingAmountCents,
        percentComplete,
        nextScheduledDate: null,
        nextScheduledAmountCents: null,
        estimatedCompletionDate: null,
        isOnTrack: percentComplete >= (featuredJarData.health?.expectedPercentage ?? 0) - 10,
      };
    }

    // Member progress for featured jar
    const allMembers = await db
      .select()
      .from(jarMembers)
      .where(and(eq(jarMembers.jarId, featuredJar.id), eq(jarMembers.status, "active")));

    const memberProfiles = await db
      .select()
      .from(profiles)
      .where(inArray(profiles.userId, allMembers.map((m) => m.userId)));

    const profileMap = new Map(memberProfiles.map((p) => [p.userId, p]));

    const daysElapsed = featuredJar.launchedAt
      ? Math.ceil((Date.now() - featuredJar.launchedAt.getTime()) / 86_400_000)
      : 0;
    const totalDays = Math.ceil((new Date(featuredJar.targetDate).getTime() - (featuredJar.launchedAt?.getTime() ?? Date.now())) / 86_400_000);

    memberProgress = await Promise.all(
      allMembers.map(async (m) => {
        const memberContribs = await db
          .select({ total: sql<number>`coalesce(sum(${contributions.amountCents}), 0)` })
          .from(contributions)
          .where(
            and(
              eq(contributions.jarId, featuredJar.id),
              eq(contributions.memberId, m.id),
              inArray(contributions.status, ["completed", "simulated"]),
            ),
          );
        const contributedAmountCents = Number(memberContribs[0]?.total ?? 0);
        const percentComplete = m.contributionTargetCents > 0
          ? Math.min(100, (contributedAmountCents / m.contributionTargetCents) * 100)
          : 0;
        const status = calculateMemberHealth(
          m.contributionTargetCents,
          contributedAmountCents,
          daysElapsed,
          totalDays,
        );
        const prof = profileMap.get(m.userId);

        return {
          memberId: m.id,
          userId: m.userId,
          displayName: prof?.displayName ?? "Unknown",
          avatarUrl: prof?.avatarUrl ?? null,
          role: m.role,
          contributionTargetCents: m.contributionTargetCents,
          contributedAmountCents,
          percentComplete,
          status,
        };
      }),
    );

    // Upcoming activity items
    const targetDate = new Date(featuredJar.targetDate);
    upcomingActivity = [
      {
        type: "jar_target_date",
        title: "Savings Target Date",
        description: `${featuredJar.name} savings goal deadline`,
        date: featuredJar.targetDate,
        jarId: featuredJar.id,
        jarName: featuredJar.name,
      },
    ].filter((item) => new Date(item.date) > new Date());
  }

  // Recent contributions across all jars
  const recentContribs = memberJarIds.length > 0
    ? await db
        .select()
        .from(contributions)
        .where(inArray(contributions.jarId, memberJarIds))
        .orderBy(desc(contributions.createdAt))
        .limit(5)
    : [];

  res.json({
    featuredJar: featuredJarData,
    personalProgress,
    memberProgress,
    upcomingActivity,
    recentContributions: recentContribs,
    totalJars,
    activeJars: activeJarsCount,
    unreadNotifications,
  });
});

export default router;
