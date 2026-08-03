import { Router } from "express";
import { db } from "@workspace/db";
import { jars, jarMembers, agreements, agreementAcceptances, profiles } from "@workspace/db";
import { eq, and, inArray, desc } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../lib/auth.js";
import { logActivity } from "../lib/activity.js";
import { getCurrentAgreementStatus } from "../lib/agreement-check.js";

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

// POST /jars/:jarId/agreements — create a new agreement version (organizer only)
// Previous acceptances are not migrated; all members must re-accept the new version.
router.post("/jars/:jarId/agreements", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const { jarId } = req.params as { jarId: string };

  const jar = await db.select().from(jars).where(eq(jars.id, jarId)).limit(1);
  if (!jar[0]) { res.status(404).json({ error: "NotFound", message: "Jar not found" }); return; }
  if (jar[0].organizerId !== userId) { res.status(403).json({ error: "Forbidden", message: "Only organizer can create a new agreement version" }); return; }
  if (["Cancelled", "Completed"].includes(jar[0].status)) {
    res.status(400).json({ error: "BadRequest", message: "Cannot create a new agreement for a closed jar" });
    return;
  }

  const { version, content, effectiveDate } = req.body as {
    version?: string; content?: string; effectiveDate?: string;
  };

  if (!version || !content || !effectiveDate) {
    res.status(400).json({ error: "BadRequest", message: "version, content, and effectiveDate are required" });
    return;
  }

  // Ensure version is unique within this jar
  const existing = await db.select({ id: agreements.id }).from(agreements)
    .where(and(eq(agreements.jarId, jarId), eq(agreements.version, version))).limit(1);
  if (existing[0]) {
    res.status(409).json({ error: "Conflict", message: `Agreement version ${version} already exists for this jar` });
    return;
  }

  const [ag] = await db.insert(agreements).values({ jarId, version, content, effectiveDate }).returning();
  if (!ag) { res.status(500).json({ error: "InternalError", message: "Failed to create agreement" }); return; }

  await logActivity({
    jarId,
    userId,
    eventType: "agreement_version_changed",
    description: `Savings agreement updated to version ${version}. All members must re-accept.`,
  });

  res.status(201).json({ id: ag.id, jarId: ag.jarId, version: ag.version, content: ag.content, effectiveDate: ag.effectiveDate, createdAt: ag.createdAt });
});

// GET /jars/:jarId/agreements/status — current agreement acceptance status for caller
router.get("/jars/:jarId/agreements/status", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const { jarId } = req.params as { jarId: string };

  const jar = await db.select().from(jars).where(eq(jars.id, jarId)).limit(1);
  if (!jar[0]) { res.status(404).json({ error: "NotFound", message: "Jar not found" }); return; }

  const member = await db.select().from(jarMembers)
    .where(and(eq(jarMembers.jarId, jarId), eq(jarMembers.userId, userId), eq(jarMembers.status, "active"))).limit(1);
  if (jar[0].organizerId !== userId && !member[0]) { res.status(403).json({ error: "Forbidden", message: "Access denied" }); return; }

  const status = await getCurrentAgreementStatus(jarId, userId);
  res.json(status);
});

export default router;
