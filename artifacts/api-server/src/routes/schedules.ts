import { Router } from "express";
import { db } from "@workspace/db";
import { jars, jarMembers, contributionSchedules, contributions } from "@workspace/db";
import { eq, and, gte, inArray } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../lib/auth.js";
import { enforceAgreement } from "../lib/agreement-check.js";
import { computeScheduleStatus } from "../lib/schedule-status.js";
import { deriveJarPhase } from "../lib/phase.js";
import { validateBody, createScheduleSchema, updateScheduleSchema } from "../lib/validation.js";

const router = Router();

async function getMyMembership(jarId: string, userId: string) {
  const [jar] = await db.select().from(jars).where(eq(jars.id, jarId)).limit(1);
  if (!jar) return null;
  const [member] = await db.select().from(jarMembers).where(and(eq(jarMembers.jarId, jarId), eq(jarMembers.userId, userId), eq(jarMembers.status, "active"))).limit(1);
  return { jar, member: member ?? null };
}

/** Compute contributions in ±1 day window around a due date for schedule status */
// GET /jars/:jarId/schedule
router.get("/jars/:jarId/schedule", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const { jarId } = req.params as { jarId: string };

  const membership = await getMyMembership(jarId, userId);
  if (!membership) { res.status(404).json({ error: "NotFound", message: "Jar not found" }); return; }
  const { jar, member } = membership;
  if (!member && jar.organizerId !== userId) { res.status(403).json({ error: "Forbidden", message: "Access denied" }); return; }

  if (!member) { res.json(null); return; }

  const [schedule] = await db.select().from(contributionSchedules)
    .where(and(eq(contributionSchedules.jarId, jarId), eq(contributionSchedules.memberId, member.id), eq(contributionSchedules.isActive, true)))
    .limit(1);

  if (!schedule) { res.json(null); return; }

  const now = new Date();

  // Cumulative obligation accounting (Phase 3 conformance):
  // Sum all member contributions since schedule start to compute outstanding cents.
  const contribRows = await db
    .select({ amountCents: contributions.amountCents })
    .from(contributions)
    .where(
      and(
        eq(contributions.memberId, member.id),
        eq(contributions.jarId, jarId),
        gte(contributions.contributionDate, schedule.startDate),
        inArray(contributions.status, ["completed", "simulated"]),
      ),
    );
  const totalContributedCents = contribRows.reduce((sum, r) => sum + r.amountCents, 0);
  const scheduleStatus = computeScheduleStatus(schedule, now, totalContributedCents);

  res.json({
    id: schedule.id,
    jarId: schedule.jarId,
    memberId: schedule.memberId,
    frequency: schedule.frequency,
    amountCents: schedule.amountCents,
    startDate: schedule.startDate,
    preferredDay: schedule.preferredDay,
    endCondition: schedule.endCondition,
    isPaused: schedule.isPaused,
    isActive: schedule.isActive,
    projectedTotalCents: null,
    estimatedCompletionDate: null,
    createdAt: schedule.createdAt,
    scheduleStatus,
  });
});

// POST /jars/:jarId/schedule
router.post("/jars/:jarId/schedule", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const { jarId } = req.params as { jarId: string };

  const membershipPost = await getMyMembership(jarId, userId);
  if (!membershipPost) { res.status(404).json({ error: "NotFound", message: "Jar not found" }); return; }
  const { jar: jarPost, member: memberPost } = membershipPost;
  if (!memberPost) { res.status(403).json({ error: "Forbidden", message: "You are not a member of this jar" }); return; }

  if (["Cancelled", "Completed"].includes(jarPost.status)) {
    res.status(400).json({ error: "BadRequest", message: "Schedules cannot be changed on a cancelled or completed jar" });
    return;
  }

  // Block schedule changes once the Commitment phase has been reached
  const phase = deriveJarPhase(jarPost.status, jarPost.cutoffDate);
  if (phase === "Commitment") {
    res.status(400).json({ error: "BadRequest", message: "Schedules cannot be changed during the Commitment phase" });
    return;
  }

  // Require current agreement acceptance
  const agreementOk = await enforceAgreement(jarId, userId, res);
  if (!agreementOk) return;

  // Validated here rather than as middleware so the membership, jar-status,
  // phase and agreement checks above still return 403/404 for an unauthorized
  // caller even when the body is malformed.
  const body = validateBody(createScheduleSchema, req.body, res);
  if (!body) return;
  const { frequency, amountCents, startDate, preferredDay, endCondition = "targetDate" } = body;

  // Deactivate existing schedules
  await db.update(contributionSchedules)
    .set({ isActive: false })
    .where(and(eq(contributionSchedules.jarId, jarId), eq(contributionSchedules.memberId, memberPost.id)));

  const [schedule] = await db.insert(contributionSchedules).values({
    jarId,
    memberId: memberPost.id,
    frequency,
    amountCents,
    startDate,
    preferredDay: preferredDay ?? null,
    endCondition,
    isPaused: false,
    isActive: true,
  }).returning();

  if (!schedule) { res.status(500).json({ error: "InternalError", message: "Failed to create schedule" }); return; }

  res.status(201).json({ ...schedule, projectedTotalCents: null, estimatedCompletionDate: null, scheduleStatus: null });
});

// PATCH /jars/:jarId/schedule
router.patch("/jars/:jarId/schedule", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const { jarId } = req.params as { jarId: string };

  const membershipPatch = await getMyMembership(jarId, userId);
  if (!membershipPatch) { res.status(404).json({ error: "NotFound", message: "Jar not found" }); return; }
  const { jar: jarPatch, member: memberPatch } = membershipPatch;
  if (!memberPatch) { res.status(403).json({ error: "Forbidden", message: "Access denied" }); return; }

  if (["Cancelled", "Completed"].includes(jarPatch.status)) {
    res.status(400).json({ error: "BadRequest", message: "Schedules cannot be changed on a cancelled or completed jar" });
    return;
  }

  // Block schedule changes once the Commitment phase has been reached
  const phase = deriveJarPhase(jarPatch.status, jarPatch.cutoffDate);
  if (phase === "Commitment") {
    res.status(400).json({ error: "BadRequest", message: "Schedules cannot be changed during the Commitment phase" });
    return;
  }

  // Require current agreement acceptance
  const agreementOk = await enforceAgreement(jarId, userId, res);
  if (!agreementOk) return;

  // Same rules as creation. Without this, a caller could create a valid
  // schedule and then PATCH it to a negative amount or an out-of-range
  // preferredDay, which would defeat the creation-time validation entirely.
  const patchBody = validateBody(updateScheduleSchema, req.body, res);
  if (!patchBody) return;
  const { frequency, amountCents, preferredDay, isPaused } = patchBody;

  const updates: Partial<typeof contributionSchedules.$inferSelect> = { updatedAt: new Date() };
  if (frequency !== undefined) updates.frequency = frequency;
  if (amountCents !== undefined) updates.amountCents = amountCents;
  if (preferredDay !== undefined) updates.preferredDay = preferredDay;
  if (isPaused !== undefined) updates.isPaused = isPaused;

  const [updated] = await db.update(contributionSchedules)
    .set(updates)
    .where(and(eq(contributionSchedules.jarId, jarId), eq(contributionSchedules.memberId, memberPatch.id), eq(contributionSchedules.isActive, true)))
    .returning();

  if (!updated) { res.status(404).json({ error: "NotFound", message: "No active schedule found" }); return; }

  res.json({ ...updated, projectedTotalCents: null, estimatedCompletionDate: null, scheduleStatus: null });
});

export default router;
