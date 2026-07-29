import { Router } from "express";
import { db } from "@workspace/db";
import { jars, jarMembers, milestones, contributions } from "@workspace/db";
import { eq, and, sql, inArray } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../lib/auth.js";
import { logActivity } from "../lib/activity.js";

const router = Router();

async function checkJarAccess(jarId: string, userId: string) {
  const jar = await db.select().from(jars).where(eq(jars.id, jarId)).limit(1);
  if (!jar[0]) return { jar: null, isOrganizer: false, isMember: false };
  const member = await db.select().from(jarMembers).where(and(eq(jarMembers.jarId, jarId), eq(jarMembers.userId, userId), eq(jarMembers.status, "active"))).limit(1);
  return { jar: jar[0], isOrganizer: jar[0].organizerId === userId, isMember: !!member[0] };
}

// GET /jars/:jarId/milestones
router.get("/jars/:jarId/milestones", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const { jarId } = req.params as { jarId: string };

  const { jar, isOrganizer, isMember } = await checkJarAccess(jarId, userId);
  if (!jar) { res.status(404).json({ error: "NotFound", message: "Jar not found" }); return; }
  if (!isOrganizer && !isMember) { res.status(403).json({ error: "Forbidden", message: "Access denied" }); return; }

  const allMilestones = await db.select().from(milestones).where(eq(milestones.jarId, jarId));

  // Calculate allocated amounts from contributions
  const result = await Promise.all(
    allMilestones.map(async (ms) => {
      const allocated = await db
        .select({ total: sql<number>`coalesce(sum(${contributions.amountCents}), 0)` })
        .from(contributions)
        .where(
          and(
            eq(contributions.milestoneId, ms.id),
            inArray(contributions.status, ["completed", "simulated"]),
          ),
        );
      const allocatedAmountCents = Number(allocated[0]?.total ?? 0);
      const percentFunded = ms.targetAmountCents > 0
        ? Math.min(100, (allocatedAmountCents / ms.targetAmountCents) * 100)
        : 0;

      return {
        id: ms.id,
        jarId: ms.jarId,
        name: ms.name,
        description: ms.description,
        targetAmountCents: ms.targetAmountCents,
        allocatedAmountCents,
        percentFunded,
        dueDate: ms.dueDate,
        priority: ms.priority,
        status: ms.status,
        createdAt: ms.createdAt,
      };
    }),
  );

  res.json(result.sort((a, b) => a.priority - b.priority));
});

// POST /jars/:jarId/milestones
router.post("/jars/:jarId/milestones", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const { jarId } = req.params as { jarId: string };

  const { jar, isOrganizer } = await checkJarAccess(jarId, userId);
  if (!jar) { res.status(404).json({ error: "NotFound", message: "Jar not found" }); return; }
  if (!isOrganizer) { res.status(403).json({ error: "Forbidden", message: "Only organizer can manage milestones" }); return; }

  const { name, description, targetAmountCents, dueDate, priority = 0 } = req.body as {
    name?: string;
    description?: string;
    targetAmountCents?: number;
    dueDate?: string;
    priority?: number;
  };

  if (!name || !targetAmountCents) {
    res.status(400).json({ error: "BadRequest", message: "name and targetAmountCents are required" });
    return;
  }

  const [milestone] = await db.insert(milestones).values({
    jarId,
    name,
    description: description ?? null,
    targetAmountCents,
    dueDate: dueDate ?? null,
    priority,
    status: "pending",
  }).returning();

  if (!milestone) { res.status(500).json({ error: "InternalError", message: "Failed to create milestone" }); return; }

  await logActivity({ jarId, userId, eventType: "milestone_created", description: `Milestone "${name}" was created`, amountCents: targetAmountCents });

  res.status(201).json({ ...milestone, allocatedAmountCents: 0, percentFunded: 0 });
});

// PATCH /jars/:jarId/milestones/:milestoneId
router.patch("/jars/:jarId/milestones/:milestoneId", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const { jarId, milestoneId } = req.params as { jarId: string; milestoneId: string };

  const { jar, isOrganizer } = await checkJarAccess(jarId, userId);
  if (!jar) { res.status(404).json({ error: "NotFound", message: "Jar not found" }); return; }
  if (!isOrganizer) { res.status(403).json({ error: "Forbidden", message: "Only organizer can manage milestones" }); return; }

  const { name, description, targetAmountCents, dueDate, priority, status } = req.body as {
    name?: string; description?: string; targetAmountCents?: number; dueDate?: string; priority?: number; status?: string;
  };

  const updates: Partial<typeof milestones.$inferSelect> = { updatedAt: new Date() };
  if (name !== undefined) updates.name = name;
  if (description !== undefined) updates.description = description;
  if (targetAmountCents !== undefined) updates.targetAmountCents = targetAmountCents;
  if (dueDate !== undefined) updates.dueDate = dueDate;
  if (priority !== undefined) updates.priority = priority;
  if (status !== undefined) updates.status = status;

  const [updated] = await db.update(milestones).set(updates).where(and(eq(milestones.id, milestoneId), eq(milestones.jarId, jarId))).returning();
  if (!updated) { res.status(404).json({ error: "NotFound", message: "Milestone not found" }); return; }

  res.json({ ...updated, allocatedAmountCents: 0, percentFunded: 0 });
});

// DELETE /jars/:jarId/milestones/:milestoneId
router.delete("/jars/:jarId/milestones/:milestoneId", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const { jarId, milestoneId } = req.params as { jarId: string; milestoneId: string };

  const { jar, isOrganizer } = await checkJarAccess(jarId, userId);
  if (!jar) { res.status(404).json({ error: "NotFound", message: "Jar not found" }); return; }
  if (!isOrganizer) { res.status(403).json({ error: "Forbidden", message: "Only organizer can delete milestones" }); return; }

  await db.delete(milestones).where(and(eq(milestones.id, milestoneId), eq(milestones.jarId, jarId)));
  res.json({ message: "Milestone deleted" });
});

export default router;
