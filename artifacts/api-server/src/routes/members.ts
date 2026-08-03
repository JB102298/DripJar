import { Router } from "express";
import { db } from "@workspace/db";
import { jars, jarMembers, contributions, profiles, contributionSchedules } from "@workspace/db";
import { eq, and, sql, inArray } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../lib/auth.js";
import { calculateMemberHealth } from "../lib/jar-health.js";
import { logActivity } from "../lib/activity.js";
import { createNotification } from "../lib/notifications.js";

const router = Router();

// GET /jars/:jarId/members
router.get("/jars/:jarId/members", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const { jarId } = req.params as { jarId: string };

  // Check access
  const jar = await db.select().from(jars).where(eq(jars.id, jarId)).limit(1);
  if (!jar[0]) { res.status(404).json({ error: "NotFound", message: "Jar not found" }); return; }

  const userMember = await db
    .select()
    .from(jarMembers)
    .where(and(eq(jarMembers.jarId, jarId), eq(jarMembers.userId, userId), eq(jarMembers.status, "active")))
    .limit(1);

  if (jar[0].organizerId !== userId && !userMember[0]) {
    res.status(403).json({ error: "Forbidden", message: "Access denied" });
    return;
  }

  const allMembers = await db
    .select()
    .from(jarMembers)
    .where(and(eq(jarMembers.jarId, jarId), eq(jarMembers.status, "active")));

  const memberProfiles = await db
    .select()
    .from(profiles)
    .where(inArray(profiles.userId, allMembers.map((m) => m.userId)));

  const profileMap = new Map(memberProfiles.map((p) => [p.userId, p]));

  const daysElapsed = jar[0].launchedAt
    ? Math.ceil((Date.now() - jar[0].launchedAt.getTime()) / 86_400_000)
    : 0;
  const totalDays = jar[0].launchedAt
    ? Math.ceil((new Date(jar[0].targetDate).getTime() - jar[0].launchedAt.getTime()) / 86_400_000)
    : 0;

  const result = await Promise.all(
    allMembers.map(async (m) => {
      const contribResult = await db
        .select({ total: sql<number>`coalesce(sum(${contributions.amountCents}), 0)` })
        .from(contributions)
        .where(
          and(
            eq(contributions.jarId, jarId),
            eq(contributions.memberId, m.id),
            inArray(contributions.status, ["completed", "simulated"]),
          ),
        );
      const contributedAmountCents = Number(contribResult[0]?.total ?? 0);
      const percentComplete =
        m.contributionTargetCents > 0
          ? Math.min(100, Math.round((contributedAmountCents / m.contributionTargetCents) * 1000) / 10)
          : 0;

      const healthStatus = calculateMemberHealth(
        m.contributionTargetCents,
        contributedAmountCents,
        daysElapsed,
        totalDays,
      );

      const prof = profileMap.get(m.userId);

      return {
        id: m.id,
        jarId: m.jarId,
        userId: m.userId,
        role: m.role,
        contributionTargetCents: m.contributionTargetCents,
        contributedAmountCents,
        percentComplete,
        status: m.status,
        healthStatus,
        joinedAt: m.joinedAt,
        profile: prof
          ? {
              id: prof.id,
              userId: prof.userId,
              firstName: prof.firstName,
              lastName: prof.lastName,
              displayName: prof.displayName,
              avatarUrl: prof.avatarUrl,
              phone: prof.phone,
              timeZone: prof.timeZone,
              defaultCurrency: prof.defaultCurrency,
              createdAt: prof.createdAt,
            }
          : null,
      };
    }),
  );

  res.json(result);
});

// PATCH /jars/:jarId/members/:memberId
router.patch("/jars/:jarId/members/:memberId", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const { jarId, memberId } = req.params as { jarId: string; memberId: string };

  const jar = await db.select().from(jars).where(eq(jars.id, jarId)).limit(1);
  if (!jar[0]) { res.status(404).json({ error: "NotFound", message: "Jar not found" }); return; }
  if (jar[0].organizerId !== userId) {
    res.status(403).json({ error: "Forbidden", message: "Only organizer can update members" });
    return;
  }

  const { contributionTargetCents, role, status } = req.body as {
    contributionTargetCents?: number;
    role?: string;
    status?: string;
  };

  // Membership lifecycle changes must go through the dedicated leave/remove
  // endpoints so timestamps, schedules, notifications, and activity events
  // stay consistent — PATCH cannot set status.
  if (status !== undefined) {
    res.status(400).json({
      error: "BadRequest",
      message: "Member status cannot be changed here. Use the leave or remove member endpoints.",
    });
    return;
  }

  const updates: Partial<typeof jarMembers.$inferSelect> = {};
  if (contributionTargetCents !== undefined) updates.contributionTargetCents = contributionTargetCents;
  if (role !== undefined && role !== "organizer") updates.role = role;

  const [updated] = await db
    .update(jarMembers)
    .set(updates)
    .where(and(eq(jarMembers.id, memberId), eq(jarMembers.jarId, jarId)))
    .returning();

  if (!updated) { res.status(404).json({ error: "NotFound", message: "Member not found" }); return; }

  res.json({ id: updated.id, jarId: updated.jarId, userId: updated.userId, role: updated.role, contributionTargetCents: updated.contributionTargetCents, status: updated.status });
});

// POST /jars/:jarId/members/leave — the signed-in member leaves the jar.
// Organizers cannot leave their own jar. Contribution history is preserved;
// the member's schedule is deactivated.
router.post("/jars/:jarId/members/leave", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const { jarId } = req.params as { jarId: string };

  const jar = await db.select().from(jars).where(eq(jars.id, jarId)).limit(1);
  if (!jar[0]) { res.status(404).json({ error: "NotFound", message: "Jar not found" }); return; }

  if (jar[0].organizerId === userId) {
    res.status(400).json({
      error: "BadRequest",
      message: "Organizers cannot leave their own jar. Cancel the jar instead.",
    });
    return;
  }

  const [membership] = await db
    .select()
    .from(jarMembers)
    .where(and(eq(jarMembers.jarId, jarId), eq(jarMembers.userId, userId), eq(jarMembers.status, "active")))
    .limit(1);

  if (!membership) {
    res.status(404).json({ error: "NotFound", message: "You are not an active member of this jar" });
    return;
  }

  await db.transaction(async (tx) => {
    await tx
      .update(jarMembers)
      .set({ status: "left", leftAt: new Date() })
      .where(eq(jarMembers.id, membership.id));

    await tx
      .update(contributionSchedules)
      .set({ isActive: false })
      .where(and(eq(contributionSchedules.jarId, jarId), eq(contributionSchedules.memberId, membership.id)));
  });

  const prof = await db.select().from(profiles).where(eq(profiles.userId, userId)).limit(1);
  const name = prof[0]?.displayName ?? "A member";

  await logActivity({
    jarId,
    userId,
    eventType: "member_left",
    description: `${name} left the jar`,
  });

  await createNotification({
    userId: jar[0].organizerId,
    type: "general",
    title: "Member left",
    message: `${name} has left ${jar[0].name}. Their contribution history is preserved.`,
    relatedJarId: jarId,
  });

  res.json({ message: "You have left the jar. Your contribution history is preserved." });
});

// DELETE /jars/:jarId/members/:memberId — organizer removes a member.
// Organizers cannot remove themselves. History is preserved; schedule
// deactivated; the removed member is notified.
router.delete("/jars/:jarId/members/:memberId", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const { jarId, memberId } = req.params as { jarId: string; memberId: string };

  const jar = await db.select().from(jars).where(eq(jars.id, jarId)).limit(1);
  if (!jar[0]) { res.status(404).json({ error: "NotFound", message: "Jar not found" }); return; }
  if (jar[0].organizerId !== userId) {
    res.status(403).json({ error: "Forbidden", message: "Only the organizer can remove members" });
    return;
  }

  const [membership] = await db
    .select()
    .from(jarMembers)
    .where(and(eq(jarMembers.id, memberId), eq(jarMembers.jarId, jarId)))
    .limit(1);

  if (!membership || membership.status !== "active") {
    res.status(404).json({ error: "NotFound", message: "Active member not found" });
    return;
  }

  if (membership.userId === userId) {
    res.status(400).json({ error: "BadRequest", message: "You cannot remove yourself from your own jar" });
    return;
  }

  await db.transaction(async (tx) => {
    await tx
      .update(jarMembers)
      .set({ status: "removed", removedAt: new Date() })
      .where(eq(jarMembers.id, membership.id));

    await tx
      .update(contributionSchedules)
      .set({ isActive: false })
      .where(and(eq(contributionSchedules.jarId, jarId), eq(contributionSchedules.memberId, membership.id)));
  });

  const prof = await db.select().from(profiles).where(eq(profiles.userId, membership.userId)).limit(1);
  const name = prof[0]?.displayName ?? "A member";

  await logActivity({
    jarId,
    userId,
    eventType: "member_removed",
    description: `${name} was removed from the jar`,
  });

  await createNotification({
    userId: membership.userId,
    type: "general",
    title: `You were removed from ${jar[0].name}`,
    message: `The organizer removed you from ${jar[0].name}. Your contribution history is preserved.`,
    relatedJarId: jarId,
  });

  res.json({ message: "Member removed. Their contribution history is preserved." });
});

export default router;
