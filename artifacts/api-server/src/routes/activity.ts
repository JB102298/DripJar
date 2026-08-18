import { Router } from "express";
import { db } from "@workspace/db";
import { activityEvents, jars, jarMembers, profiles } from "@workspace/db";
import { eq, and, desc, inArray } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../lib/auth.js";
import { resolveActorName } from "../lib/display-name.js";

const router = Router();

// GET /jars/:jarId/activity
router.get("/jars/:jarId/activity", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const { jarId } = req.params as { jarId: string };
  const limit = Math.min(50, parseInt((req.query.limit as string) ?? "20", 10));
  const offset = parseInt((req.query.offset as string) ?? "0", 10);

  const jar = await db.select().from(jars).where(eq(jars.id, jarId)).limit(1);
  if (!jar[0]) { res.status(404).json({ error: "NotFound", message: "Jar not found" }); return; }

  const member = await db.select().from(jarMembers).where(and(eq(jarMembers.jarId, jarId), eq(jarMembers.userId, userId), eq(jarMembers.status, "active"))).limit(1);
  if (jar[0].organizerId !== userId && !member[0]) {
    res.status(403).json({ error: "Forbidden", message: "Access denied" });
    return;
  }

  const events = await db
    .select()
    .from(activityEvents)
    .where(eq(activityEvents.jarId, jarId))
    .orderBy(desc(activityEvents.createdAt))
    .limit(limit)
    .offset(offset);

  const userIds = [...new Set(events.filter((e) => e.userId).map((e) => e.userId!))];
  const actorProfiles = userIds.length > 0
    ? await db.select().from(profiles).where(inArray(profiles.userId, userIds))
    : [];
  const profileMap = new Map(actorProfiles.map((p) => [p.userId, p]));

  const result = events.map((e) => {
    const prof = e.userId ? profileMap.get(e.userId) : null;
    return {
      id: e.id,
      jarId: e.jarId,
      userId: e.userId,
      eventType: e.eventType,
      description: e.description,
      // Resolved at read time, so renaming yourself updates historic entries.
      // Null only for genuine system events with no actor.
      actorName: resolveActorName(prof, Boolean(e.userId)),
      actorAvatarUrl: prof?.avatarUrl ?? null,
      amountCents: e.amountCents,
      metadata: e.metadata,
      createdAt: e.createdAt,
    };
  });

  res.json(result);
});

// GET /activity
router.get("/activity", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;

  const memberships = await db
    .select({ jarId: jarMembers.jarId })
    .from(jarMembers)
    .where(and(eq(jarMembers.userId, userId), eq(jarMembers.status, "active")));

  if (memberships.length === 0) {
    res.json([]);
    return;
  }

  const jarIds = memberships.map((m) => m.jarId);
  const events = await db
    .select()
    .from(activityEvents)
    .where(inArray(activityEvents.jarId, jarIds))
    .orderBy(desc(activityEvents.createdAt))
    .limit(30);

  const userIds = [...new Set(events.filter((e) => e.userId).map((e) => e.userId!))];
  const actorProfiles = userIds.length > 0
    ? await db.select().from(profiles).where(inArray(profiles.userId, userIds))
    : [];
  const profileMap = new Map(actorProfiles.map((p) => [p.userId, p]));

  // Get jar names for context
  const allJars = await db.select({ id: jars.id, name: jars.name }).from(jars).where(inArray(jars.id, jarIds));
  const jarNameMap = new Map(allJars.map((j) => [j.id, j.name]));

  const result = events.map((e) => {
    const prof = e.userId ? profileMap.get(e.userId) : null;
    return {
      id: e.id,
      jarId: e.jarId,
      userId: e.userId,
      eventType: e.eventType,
      description: e.description,
      // Resolved at read time, so renaming yourself updates historic entries.
      // Null only for genuine system events with no actor.
      actorName: resolveActorName(prof, Boolean(e.userId)),
      actorAvatarUrl: prof?.avatarUrl ?? null,
      amountCents: e.amountCents,
      metadata: { ...((e.metadata as Record<string, unknown>) ?? {}), jarName: jarNameMap.get(e.jarId) },
      createdAt: e.createdAt,
    };
  });

  res.json(result);
});

export default router;
