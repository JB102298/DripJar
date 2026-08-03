import { Router } from "express";
import { db } from "@workspace/db";
import {
  jars,
  jarMembers,
  contributions,
  profiles,
  agreements,
  agreementAcceptances,
} from "@workspace/db";
import { eq, and, or, desc, sql, inArray } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../lib/auth.js";
import { calculateJarHealth } from "../lib/jar-health.js";
import { logActivity } from "../lib/activity.js";
import { notifyAllMembers } from "../lib/notifications.js";

const router = Router();

// Helper: check jar access and return member info
async function getJarAccess(jarId: string, userId: string) {
  const jar = await db.select().from(jars).where(eq(jars.id, jarId)).limit(1);
  if (!jar[0]) return { jar: null, member: null, isOrganizer: false };

  const member = await db
    .select()
    .from(jarMembers)
    .where(and(eq(jarMembers.jarId, jarId), eq(jarMembers.userId, userId), eq(jarMembers.status, "active")))
    .limit(1);

  const isOrganizer = jar[0].organizerId === userId;
  return { jar: jar[0], member: member[0] ?? null, isOrganizer };
}

// Helper: get total saved for a jar
async function getTotalSaved(jarId: string): Promise<number> {
  const result = await db
    .select({ total: sql<number>`coalesce(sum(${contributions.amountCents}), 0)` })
    .from(contributions)
    .where(
      and(
        eq(contributions.jarId, jarId),
        inArray(contributions.status, ["completed", "simulated"]),
      ),
    );
  return Number(result[0]?.total ?? 0);
}

// Helper: compute daysRemaining
function daysRemaining(targetDate: string): number | null {
  if (!targetDate) return null;
  const diff = new Date(targetDate).getTime() - Date.now();
  return Math.max(0, Math.ceil(diff / 86_400_000));
}

// Helper: build jar summary
async function buildJarSummary(jar: typeof jars.$inferSelect, userId: string) {
  const totalSavedCents = await getTotalSaved(jar.id);
  const percentFunded = jar.goalAmountCents > 0
    ? Math.min(100, Math.round((totalSavedCents / jar.goalAmountCents) * 1000) / 10)
    : 0;

  const memberCount = await db
    .select({ count: sql<number>`count(*)` })
    .from(jarMembers)
    .where(and(eq(jarMembers.jarId, jar.id), eq(jarMembers.status, "active")));

  const userMember = await db
    .select()
    .from(jarMembers)
    .where(and(eq(jarMembers.jarId, jar.id), eq(jarMembers.userId, userId)))
    .limit(1);

  let health = null;
  if (jar.launchedAt && jar.status === "Saving") {
    health = calculateJarHealth(
      jar.goalAmountCents,
      totalSavedCents,
      jar.launchedAt,
      new Date(jar.targetDate),
    );
  }

  return {
    id: jar.id,
    organizerId: jar.organizerId,
    name: jar.name,
    category: jar.category,
    destination: jar.destination,
    coverImageUrl: jar.coverImageUrl,
    targetDate: jar.targetDate,
    goalAmountCents: jar.goalAmountCents,
    currency: jar.currency,
    status: jar.status,
    memberCount: Number(memberCount[0]?.count ?? 0),
    totalSavedCents,
    percentFunded,
    daysRemaining: daysRemaining(jar.targetDate),
    userRole: userMember[0]?.role ?? null,
    health,
  };
}

// GET /jars
router.get("/jars", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const { status } = req.query as { status?: string };

  // Find all jars where user is organizer or active member
  const userMembers = await db
    .select({ jarId: jarMembers.jarId })
    .from(jarMembers)
    .where(and(eq(jarMembers.userId, userId), eq(jarMembers.status, "active")));

  const memberJarIds = userMembers.map((m) => m.jarId);

  let query = db.select().from(jars).where(
    memberJarIds.length > 0
      ? or(eq(jars.organizerId, userId), inArray(jars.id, memberJarIds))
      : eq(jars.organizerId, userId),
  ).orderBy(desc(jars.updatedAt));

  const jarList = await query;
  const filtered = status ? jarList.filter((j) => j.status === status) : jarList;

  const summaries = await Promise.all(
    filtered.map((jar) => buildJarSummary(jar, userId)),
  );

  res.json(summaries);
});

// POST /jars
router.post("/jars", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const {
    name,
    category = "Vacation",
    description,
    destination,
    coverImageUrl,
    startDate,
    endDate,
    targetDate,
    goalAmountCents,
    currency = "USD",
    approvalThreshold = 0.67,
  } = req.body as {
    name?: string;
    category?: string;
    description?: string;
    destination?: string;
    coverImageUrl?: string;
    startDate?: string;
    endDate?: string;
    targetDate?: string;
    goalAmountCents?: number;
    currency?: string;
    approvalThreshold?: number;
  };

  if (!name || !targetDate || !goalAmountCents) {
    res.status(400).json({ error: "BadRequest", message: "name, targetDate, and goalAmountCents are required" });
    return;
  }

  if (goalAmountCents < 100) {
    res.status(400).json({ error: "BadRequest", message: "Goal must be at least $1.00" });
    return;
  }

  // Generate slug
  const baseSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
  const slug = `${baseSlug}-${Date.now().toString(36)}`;

  const [jar] = await db
    .insert(jars)
    .values({
      organizerId: userId,
      name,
      slug,
      category,
      description: description ?? null,
      destination: destination ?? null,
      coverImageUrl: coverImageUrl ?? null,
      startDate: startDate ?? null,
      endDate: endDate ?? null,
      targetDate,
      goalAmountCents,
      currency,
      status: "Draft",
      approvalThreshold: String(approvalThreshold),
    })
    .returning();

  if (!jar) {
    res.status(500).json({ error: "InternalError", message: "Failed to create jar" });
    return;
  }

  // Add organizer as member
  await db.insert(jarMembers).values({
    jarId: jar.id,
    userId,
    role: "organizer",
    contributionTargetCents: 0,
    status: "active",
    joinedAt: new Date(),
  });

  // Create default agreement
  await db.insert(agreements).values({
    jarId: jar.id,
    version: "1.0",
    content: DEFAULT_AGREEMENT_TEXT,
    effectiveDate: new Date().toISOString().split("T")[0]!,
  });

  await logActivity({ jarId: jar.id, userId, eventType: "jar_created", description: `${name} was created` });

  res.status(201).json(await buildJarSummary(jar, userId));
});

// GET /jars/:jarId
router.get("/jars/:jarId", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const { jarId } = req.params as { jarId: string };

  const { jar, member, isOrganizer } = await getJarAccess(jarId, userId);
  if (!jar) {
    res.status(404).json({ error: "NotFound", message: "Jar not found" });
    return;
  }

  if (!isOrganizer && !member) {
    res.status(403).json({ error: "Forbidden", message: "You do not have access to this jar" });
    return;
  }

  const totalSavedCents = await getTotalSaved(jarId);
  const percentFunded = jar.goalAmountCents > 0
    ? Math.min(100, Math.round((totalSavedCents / jar.goalAmountCents) * 1000) / 10)
    : 0;

  const memberCount = await db
    .select({ count: sql<number>`count(*)` })
    .from(jarMembers)
    .where(and(eq(jarMembers.jarId, jarId), eq(jarMembers.status, "active")));

  let health = null;
  if (jar.launchedAt && ["Saving", "CommitmentPending", "Committed"].includes(jar.status)) {
    health = calculateJarHealth(
      jar.goalAmountCents,
      totalSavedCents,
      jar.launchedAt,
      new Date(jar.targetDate),
    );
  }

  res.json({
    id: jar.id,
    organizerId: jar.organizerId,
    name: jar.name,
    slug: jar.slug,
    category: jar.category,
    description: jar.description,
    destination: jar.destination,
    coverImageUrl: jar.coverImageUrl,
    startDate: jar.startDate,
    endDate: jar.endDate,
    targetDate: jar.targetDate,
    goalAmountCents: jar.goalAmountCents,
    currency: jar.currency,
    status: jar.status,
    approvalThreshold: Number(jar.approvalThreshold),
    memberCount: Number(memberCount[0]?.count ?? 0),
    totalSavedCents,
    percentFunded,
    daysRemaining: daysRemaining(jar.targetDate),
    launchedAt: jar.launchedAt,
    createdAt: jar.createdAt,
    updatedAt: jar.updatedAt,
    health,
    userRole: member?.role ?? (isOrganizer ? "organizer" : null),
  });
});

// PATCH /jars/:jarId
router.patch("/jars/:jarId", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const { jarId } = req.params as { jarId: string };

  const { jar, isOrganizer } = await getJarAccess(jarId, userId);
  if (!jar) { res.status(404).json({ error: "NotFound", message: "Jar not found" }); return; }
  if (!isOrganizer) { res.status(403).json({ error: "Forbidden", message: "Only organizer can edit the jar" }); return; }

  // Cancelled/Completed jars are read-only.
  if (["Cancelled", "Completed"].includes(jar.status)) {
    res.status(400).json({ error: "BadRequest", message: "This jar can no longer be edited" });
    return;
  }

  const updates: Partial<typeof jar> = { updatedAt: new Date() };
  const allowed = ["name", "description", "destination", "coverImageUrl", "startDate", "endDate", "targetDate", "goalAmountCents", "approvalThreshold"] as const;

  // Financially sensitive fields are only editable before launch — once the
  // jar is Saving, member targets/progress are based on the agreed goal.
  const preLaunchOnly = ["goalAmountCents", "approvalThreshold"] as const;
  const isPreLaunch = ["Draft", "Inviting"].includes(jar.status);
  for (const key of preLaunchOnly) {
    if (req.body[key] !== undefined && !isPreLaunch) {
      res.status(400).json({
        error: "BadRequest",
        message: `${key === "goalAmountCents" ? "The goal amount" : "The approval threshold"} can only be changed before the jar is launched`,
      });
      return;
    }
  }

  const changedKeys: string[] = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined && req.body[key] !== (jar as Record<string, unknown>)[key]) {
      (updates as Record<string, unknown>)[key] = req.body[key];
      changedKeys.push(key);
    }
  }

  const [updated] = await db.update(jars).set(updates).where(eq(jars.id, jarId)).returning();
  if (!updated) { res.status(500).json({ error: "InternalError", message: "Failed to update jar" }); return; }

  if (changedKeys.length > 0) {
    await logActivity({
      jarId,
      userId,
      eventType: "jar_updated",
      description: `Jar settings updated (${changedKeys.join(", ")})`,
    });
  }

  res.json(await buildJarSummary(updated, userId));
});

// POST /jars/:jarId/launch
router.post("/jars/:jarId/launch", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const { jarId } = req.params as { jarId: string };

  const { jar, isOrganizer } = await getJarAccess(jarId, userId);
  if (!jar) { res.status(404).json({ error: "NotFound", message: "Jar not found" }); return; }
  if (!isOrganizer) { res.status(403).json({ error: "Forbidden", message: "Only organizer can launch the jar" }); return; }
  if (!["Draft", "Inviting"].includes(jar.status)) {
    res.status(400).json({ error: "BadRequest", message: "Jar cannot be launched from its current status" });
    return;
  }

  const [updated] = await db
    .update(jars)
    .set({ status: "Saving", launchedAt: new Date(), updatedAt: new Date() })
    .where(eq(jars.id, jarId))
    .returning();

  if (!updated) { res.status(500).json({ error: "InternalError", message: "Failed to launch jar" }); return; }

  await logActivity({ jarId, userId, eventType: "jar_created", description: `${jar.name} is now open for contributions` });

  // Get all member user IDs to notify
  const members = await db
    .select({ userId: jarMembers.userId })
    .from(jarMembers)
    .where(and(eq(jarMembers.jarId, jarId), eq(jarMembers.status, "active")));

  await notifyAllMembers({
    jarId,
    memberUserIds: members.map((m) => m.userId),
    type: "general",
    title: `${jar.name} is now active!`,
    message: "Your jar is now open for contributions. Start saving!",
    excludeUserId: userId,
  });

  res.json(await buildJarSummary(updated, userId));
});

// POST /jars/:jarId/cancel
router.post("/jars/:jarId/cancel", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const { jarId } = req.params as { jarId: string };

  const { jar, isOrganizer } = await getJarAccess(jarId, userId);
  if (!jar) { res.status(404).json({ error: "NotFound", message: "Jar not found" }); return; }
  if (!isOrganizer) { res.status(403).json({ error: "Forbidden", message: "Only organizer can cancel the jar" }); return; }
  if (["Cancelled", "Completed"].includes(jar.status)) {
    res.status(400).json({ error: "BadRequest", message: "Jar is already cancelled or completed" });
    return;
  }

  const [updated] = await db
    .update(jars)
    .set({ status: "Cancelled", updatedAt: new Date() })
    .where(eq(jars.id, jarId))
    .returning();

  if (!updated) { res.status(500).json({ error: "InternalError", message: "Failed to cancel jar" }); return; }

  await logActivity({ jarId, userId, eventType: "jar_cancelled", description: `${jar.name} was cancelled` });

  // Notify all active members that the jar was cancelled
  const activeMembers = await db
    .select({ userId: jarMembers.userId })
    .from(jarMembers)
    .where(and(eq(jarMembers.jarId, jarId), eq(jarMembers.status, "active")));

  await notifyAllMembers({
    jarId,
    memberUserIds: activeMembers.map((m) => m.userId),
    type: "general",
    title: `${jar.name} was cancelled`,
    message: "The organizer cancelled this jar. No further contributions will be recorded.",
    excludeUserId: userId,
  });

  res.json(await buildJarSummary(updated, userId));
});

// GET /jars/:jarId/health
router.get("/jars/:jarId/health", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const { jarId } = req.params as { jarId: string };

  const { jar, member, isOrganizer } = await getJarAccess(jarId, userId);
  if (!jar) { res.status(404).json({ error: "NotFound", message: "Jar not found" }); return; }
  if (!isOrganizer && !member) { res.status(403).json({ error: "Forbidden", message: "Access denied" }); return; }

  if (!jar.launchedAt) {
    res.json({
      status: "OnTrack",
      message: "Jar has not launched yet.",
      actualPercentage: 0,
      expectedPercentage: 0,
      daysElapsed: 0,
      totalDays: Math.ceil((new Date(jar.targetDate).getTime() - Date.now()) / 86_400_000),
      amountBehindCents: 0,
      estimatedCompletionDate: null,
    });
    return;
  }

  const totalSavedCents = await getTotalSaved(jarId);
  const health = calculateJarHealth(
    jar.goalAmountCents,
    totalSavedCents,
    jar.launchedAt,
    new Date(jar.targetDate),
  );

  res.json(health);
});

const DEFAULT_AGREEMENT_TEXT = `M3Jar Savings Agreement

1. SAVING PHASE: All contributions are made voluntarily. During the Saving Phase, contributions remain under the contributing member's control and may be refunded upon request, subject to the terms below.

2. COMMITMENT REQUEST: Before any funds are designated for a specific purchase, the Organizer must submit a Commitment Request identifying the amount, purpose, and intended milestone. Members must approve the request according to the jar's approval threshold.

3. COMMITTED FUNDS: Once a Commitment Request is approved and the Lock Date has passed, designated funds become committed to the specified purpose. Committed funds may not be unilaterally reclaimed by individual members.

4. CANCELLATION: If the Jar is cancelled before any Commitment Request is approved, all members may request a full refund of their simulated contributions. M3Jar does not guarantee refunds for amounts already paid to third-party vendors.

5. REFUNDS: Refund requests are subject to review. M3Jar is not responsible for amounts already transferred to external vendors, airlines, hotels, or other service providers.

6. SIMULATED PAYMENTS: This version of M3Jar uses simulated payment data. No real money is transferred. This agreement will be updated before real financial transactions are enabled.

7. DISCLAIMER: The exact legal and financial terms governing real-money transactions will be provided separately before production payment processing is enabled.

All members agree to treat each other fairly and communicate openly about any inability to meet contribution schedules.`;

export default router;
