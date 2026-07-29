import { Router } from "express";
import { db } from "@workspace/db";
import { jars, jarMembers, contributions, profiles } from "@workspace/db";
import { eq, and, sql, inArray } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../lib/auth.js";
import { calculateMemberHealth } from "../lib/jar-health.js";

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
          ? Math.min(100, (contributedAmountCents / m.contributionTargetCents) * 100)
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

  const updates: Partial<typeof jarMembers.$inferSelect> = {};
  if (contributionTargetCents !== undefined) updates.contributionTargetCents = contributionTargetCents;
  if (role !== undefined && role !== "organizer") updates.role = role;
  if (status !== undefined) updates.status = status;

  const [updated] = await db
    .update(jarMembers)
    .set(updates)
    .where(and(eq(jarMembers.id, memberId), eq(jarMembers.jarId, jarId)))
    .returning();

  if (!updated) { res.status(404).json({ error: "NotFound", message: "Member not found" }); return; }

  res.json({ id: updated.id, jarId: updated.jarId, userId: updated.userId, role: updated.role, contributionTargetCents: updated.contributionTargetCents, status: updated.status });
});

export default router;
