import { Router } from "express";
import { db } from "@workspace/db";
import { jars, jarMembers, agreements, agreementAcceptances, profiles } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../lib/auth.js";
import { logActivity } from "../lib/activity.js";

const router = Router();

// GET /jars/:jarId/agreements
router.get("/jars/:jarId/agreements", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const { jarId } = req.params as { jarId: string };

  const jar = await db.select().from(jars).where(eq(jars.id, jarId)).limit(1);
  if (!jar[0]) { res.status(404).json({ error: "NotFound", message: "Jar not found" }); return; }

  const member = await db.select().from(jarMembers).where(and(eq(jarMembers.jarId, jarId), eq(jarMembers.userId, userId), eq(jarMembers.status, "active"))).limit(1);
  if (jar[0].organizerId !== userId && !member[0]) { res.status(403).json({ error: "Forbidden", message: "Access denied" }); return; }

  const allAgreements = await db.select().from(agreements).where(eq(agreements.jarId, jarId));

  const result = await Promise.all(
    allAgreements.map(async (ag) => {
      const acceptances = await db.select().from(agreementAcceptances).where(eq(agreementAcceptances.agreementId, ag.id));
      const userIds = acceptances.map((a) => a.userId);
      const memberProfiles = userIds.length > 0
        ? await db.select().from(profiles).where(inArray(profiles.userId, userIds))
        : [];
      const profileMap = new Map(memberProfiles.map((p) => [p.userId, p.displayName]));

      const myAcceptance = acceptances.find((a) => a.userId === userId);

      return {
        id: ag.id,
        jarId: ag.jarId,
        version: ag.version,
        content: ag.content,
        createdAt: ag.createdAt,
        effectiveDate: ag.effectiveDate,
        acceptances: acceptances.map((a) => ({
          id: a.id,
          agreementId: a.agreementId,
          userId: a.userId,
          acceptedAt: a.acceptedAt,
          memberName: profileMap.get(a.userId) ?? null,
        })),
        myAcceptance: myAcceptance
          ? { id: myAcceptance.id, agreementId: myAcceptance.agreementId, userId: myAcceptance.userId, acceptedAt: myAcceptance.acceptedAt, memberName: null }
          : null,
      };
    }),
  );

  res.json(result);
});

// POST /jars/:jarId/agreements/:agreementId/accept
router.post("/jars/:jarId/agreements/:agreementId/accept", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const { jarId, agreementId } = req.params as { jarId: string; agreementId: string };

  const jar = await db.select().from(jars).where(eq(jars.id, jarId)).limit(1);
  if (!jar[0]) { res.status(404).json({ error: "NotFound", message: "Jar not found" }); return; }

  const member = await db.select().from(jarMembers).where(and(eq(jarMembers.jarId, jarId), eq(jarMembers.userId, userId), eq(jarMembers.status, "active"))).limit(1);
  if (jar[0].organizerId !== userId && !member[0]) { res.status(403).json({ error: "Forbidden", message: "Access denied" }); return; }

  const ag = await db.select().from(agreements).where(and(eq(agreements.id, agreementId), eq(agreements.jarId, jarId))).limit(1);
  if (!ag[0]) { res.status(404).json({ error: "NotFound", message: "Agreement not found" }); return; }

  // Check if already accepted
  const existing = await db.select().from(agreementAcceptances).where(and(eq(agreementAcceptances.agreementId, agreementId), eq(agreementAcceptances.userId, userId))).limit(1);
  if (existing[0]) {
    res.json({ id: existing[0].id, agreementId: existing[0].agreementId, userId: existing[0].userId, acceptedAt: existing[0].acceptedAt, memberName: null });
    return;
  }

  const [acceptance] = await db.insert(agreementAcceptances).values({
    agreementId,
    userId,
    acceptedAt: new Date(),
  }).returning();

  if (!acceptance) { res.status(500).json({ error: "InternalError", message: "Failed to record acceptance" }); return; }

  await logActivity({ jarId, userId, eventType: "agreement_accepted", description: "A member accepted the savings agreement" });

  res.json({ id: acceptance.id, agreementId: acceptance.agreementId, userId: acceptance.userId, acceptedAt: acceptance.acceptedAt, memberName: null });
});

export default router;
