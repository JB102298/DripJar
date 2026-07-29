import { Router } from "express";
import { db } from "@workspace/db";
import { jars, jarMembers, contributionSchedules } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../lib/auth.js";

const router = Router();

async function getMyMembership(jarId: string, userId: string) {
  const jar = await db.select().from(jars).where(eq(jars.id, jarId)).limit(1);
  if (!jar[0]) return { jar: null, member: null };
  const member = await db.select().from(jarMembers).where(and(eq(jarMembers.jarId, jarId), eq(jarMembers.userId, userId), eq(jarMembers.status, "active"))).limit(1);
  return { jar: jar[0], member: member[0] ?? null };
}

// GET /jars/:jarId/schedule
router.get("/jars/:jarId/schedule", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const { jarId } = req.params as { jarId: string };

  const { jar, member } = await getMyMembership(jarId, userId);
  if (!jar) { res.status(404).json({ error: "NotFound", message: "Jar not found" }); return; }
  if (!member && jar.organizerId !== userId) { res.status(403).json({ error: "Forbidden", message: "Access denied" }); return; }

  if (!member) { res.json(null); return; }

  const schedule = await db.select().from(contributionSchedules)
    .where(and(eq(contributionSchedules.jarId, jarId), eq(contributionSchedules.memberId, member.id), eq(contributionSchedules.isActive, true)))
    .limit(1);

  if (!schedule[0]) { res.json(null); return; }

  res.json({
    id: schedule[0].id,
    jarId: schedule[0].jarId,
    memberId: schedule[0].memberId,
    frequency: schedule[0].frequency,
    amountCents: schedule[0].amountCents,
    startDate: schedule[0].startDate,
    preferredDay: schedule[0].preferredDay,
    endCondition: schedule[0].endCondition,
    isPaused: schedule[0].isPaused,
    isActive: schedule[0].isActive,
    projectedTotalCents: null,
    estimatedCompletionDate: null,
    createdAt: schedule[0].createdAt,
  });
});

// POST /jars/:jarId/schedule
router.post("/jars/:jarId/schedule", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const { jarId } = req.params as { jarId: string };

  const { jar, member } = await getMyMembership(jarId, userId);
  if (!jar) { res.status(404).json({ error: "NotFound", message: "Jar not found" }); return; }
  if (!member) { res.status(403).json({ error: "Forbidden", message: "You are not a member of this jar" }); return; }

  const { frequency, amountCents, startDate, preferredDay, endCondition = "targetDate" } = req.body as {
    frequency?: string; amountCents?: number; startDate?: string; preferredDay?: number; endCondition?: string;
  };

  if (!frequency || !amountCents || !startDate) {
    res.status(400).json({ error: "BadRequest", message: "frequency, amountCents, and startDate are required" });
    return;
  }

  // Deactivate existing schedules
  await db.update(contributionSchedules)
    .set({ isActive: false })
    .where(and(eq(contributionSchedules.jarId, jarId), eq(contributionSchedules.memberId, member.id)));

  const [schedule] = await db.insert(contributionSchedules).values({
    jarId,
    memberId: member.id,
    frequency,
    amountCents,
    startDate,
    preferredDay: preferredDay ?? null,
    endCondition,
    isPaused: false,
    isActive: true,
  }).returning();

  if (!schedule) { res.status(500).json({ error: "InternalError", message: "Failed to create schedule" }); return; }

  res.status(201).json({ ...schedule, projectedTotalCents: null, estimatedCompletionDate: null });
});

// PATCH /jars/:jarId/schedule
router.patch("/jars/:jarId/schedule", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const { jarId } = req.params as { jarId: string };

  const { jar, member } = await getMyMembership(jarId, userId);
  if (!jar) { res.status(404).json({ error: "NotFound", message: "Jar not found" }); return; }
  if (!member) { res.status(403).json({ error: "Forbidden", message: "Access denied" }); return; }

  const { frequency, amountCents, preferredDay, isPaused } = req.body as {
    frequency?: string; amountCents?: number; preferredDay?: number; isPaused?: boolean;
  };

  const updates: Partial<typeof contributionSchedules.$inferSelect> = { updatedAt: new Date() };
  if (frequency !== undefined) updates.frequency = frequency;
  if (amountCents !== undefined) updates.amountCents = amountCents;
  if (preferredDay !== undefined) updates.preferredDay = preferredDay;
  if (isPaused !== undefined) updates.isPaused = isPaused;

  const [updated] = await db.update(contributionSchedules)
    .set(updates)
    .where(and(eq(contributionSchedules.jarId, jarId), eq(contributionSchedules.memberId, member.id), eq(contributionSchedules.isActive, true)))
    .returning();

  if (!updated) { res.status(404).json({ error: "NotFound", message: "No active schedule found" }); return; }

  res.json({ ...updated, projectedTotalCents: null, estimatedCompletionDate: null });
});

export default router;
