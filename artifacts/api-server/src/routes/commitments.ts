import { Router } from "express";
import { db } from "@workspace/db";
import { jars, jarMembers, commitmentRequests, commitmentVotes, profiles } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../lib/auth.js";
import { logActivity } from "../lib/activity.js";
import { notifyAllMembers } from "../lib/notifications.js";

const router = Router();

async function buildCommitmentWithVotes(cr: typeof commitmentRequests.$inferSelect) {
  const votes = await db.select().from(commitmentVotes).where(eq(commitmentVotes.commitmentRequestId, cr.id));
  const memberIds = [...new Set(votes.map((v) => v.memberId))];
  const members = memberIds.length > 0
    ? await db.select().from(jarMembers).where(inArray(jarMembers.id, memberIds))
    : [];
  const profileMap = new Map<string, string>();
  if (members.length > 0) {
    const profs = await db.select().from(profiles).where(inArray(profiles.userId, members.map((m) => m.userId)));
    for (const p of profs) {
      const m = members.find((mem) => mem.userId === p.userId);
      if (m) profileMap.set(m.id, p.displayName);
    }
  }

  const approvedCount = votes.filter((v) => v.vote === "approve").length;
  const rejectedCount = votes.filter((v) => v.vote === "reject").length;
  const pendingCount = votes.filter((v) => v.vote === "clarification").length;
  const totalVotes = votes.length;
  const approvalPercentage = totalVotes > 0 ? (approvedCount / totalVotes) * 100 : 0;

  return {
    id: cr.id,
    jarId: cr.jarId,
    milestoneId: cr.milestoneId,
    amountCents: cr.amountCents,
    purpose: cr.purpose,
    vendorName: cr.vendorName,
    paymentDeadline: cr.paymentDeadline,
    requiredThreshold: Number(cr.requiredThreshold),
    status: cr.status,
    approvedCount,
    rejectedCount,
    pendingCount,
    approvalPercentage,
    votes: votes.map((v) => ({
      id: v.id,
      commitmentRequestId: v.commitmentRequestId,
      memberId: v.memberId,
      vote: v.vote,
      note: v.note,
      memberName: profileMap.get(v.memberId) ?? null,
      createdAt: v.createdAt,
    })),
    createdAt: cr.createdAt,
  };
}

// GET /jars/:jarId/commitments
router.get("/jars/:jarId/commitments", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const { jarId } = req.params as { jarId: string };

  const jar = await db.select().from(jars).where(eq(jars.id, jarId)).limit(1);
  if (!jar[0]) { res.status(404).json({ error: "NotFound", message: "Jar not found" }); return; }

  const member = await db.select().from(jarMembers).where(and(eq(jarMembers.jarId, jarId), eq(jarMembers.userId, userId), eq(jarMembers.status, "active"))).limit(1);
  if (jar[0].organizerId !== userId && !member[0]) { res.status(403).json({ error: "Forbidden", message: "Access denied" }); return; }

  const crs = await db.select().from(commitmentRequests).where(eq(commitmentRequests.jarId, jarId));
  const result = await Promise.all(crs.map(buildCommitmentWithVotes));
  res.json(result);
});

// POST /jars/:jarId/commitments
router.post("/jars/:jarId/commitments", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const { jarId } = req.params as { jarId: string };

  const jar = await db.select().from(jars).where(eq(jars.id, jarId)).limit(1);
  if (!jar[0]) { res.status(404).json({ error: "NotFound", message: "Jar not found" }); return; }
  if (jar[0].organizerId !== userId) { res.status(403).json({ error: "Forbidden", message: "Only organizer can create commitment requests" }); return; }

  const { milestoneId, amountCents, purpose, vendorName, paymentDeadline, requiredThreshold = 0.67, note } = req.body as {
    milestoneId?: string; amountCents?: number; purpose?: string; vendorName?: string; paymentDeadline?: string; requiredThreshold?: number; note?: string;
  };

  if (!amountCents || !purpose) {
    res.status(400).json({ error: "BadRequest", message: "amountCents and purpose are required" });
    return;
  }

  const [cr] = await db.insert(commitmentRequests).values({
    jarId,
    milestoneId: milestoneId ?? null,
    amountCents,
    purpose,
    vendorName: vendorName ?? null,
    paymentDeadline: paymentDeadline ?? null,
    requiredThreshold: String(requiredThreshold),
    status: "pending",
    note: note ?? null,
    createdByUserId: userId,
  }).returning();

  if (!cr) { res.status(500).json({ error: "InternalError", message: "Failed to create commitment request" }); return; }

  await db.update(jars).set({ status: "CommitmentPending", updatedAt: new Date() }).where(eq(jars.id, jarId));
  await logActivity({ jarId, userId, eventType: "commitment_requested", description: `A commitment request was submitted for $${(amountCents / 100).toFixed(2)}`, amountCents });

  const members = await db.select({ userId: jarMembers.userId }).from(jarMembers).where(and(eq(jarMembers.jarId, jarId), eq(jarMembers.status, "active")));
  await notifyAllMembers({
    jarId,
    memberUserIds: members.map((m) => m.userId),
    type: "commitment_requested",
    title: "Commitment approval needed",
    message: `Review and approve a $${(amountCents / 100).toFixed(2)} commitment request for ${jar[0].name}.`,
    excludeUserId: userId,
  });

  res.status(201).json(await buildCommitmentWithVotes(cr));
});

// POST /jars/:jarId/commitments/:commitmentId/vote
router.post("/jars/:jarId/commitments/:commitmentId/vote", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const { jarId, commitmentId } = req.params as { jarId: string; commitmentId: string };

  const jar = await db.select().from(jars).where(eq(jars.id, jarId)).limit(1);
  if (!jar[0]) { res.status(404).json({ error: "NotFound", message: "Jar not found" }); return; }

  const member = await db.select().from(jarMembers).where(and(eq(jarMembers.jarId, jarId), eq(jarMembers.userId, userId), eq(jarMembers.status, "active"))).limit(1);
  if (!member[0]) { res.status(403).json({ error: "Forbidden", message: "Only members can vote" }); return; }

  const [cr] = await db.select().from(commitmentRequests).where(eq(commitmentRequests.id, commitmentId)).limit(1);
  if (!cr || cr.jarId !== jarId) { res.status(404).json({ error: "NotFound", message: "Commitment request not found" }); return; }
  if (cr.status !== "pending") { res.status(400).json({ error: "BadRequest", message: "This commitment request is no longer pending" }); return; }

  const { vote, note } = req.body as { vote?: string; note?: string };
  if (!vote || !["approve", "reject", "clarification"].includes(vote)) {
    res.status(400).json({ error: "BadRequest", message: "vote must be approve, reject, or clarification" });
    return;
  }

  // Upsert vote (replace existing)
  const existingVote = await db.select().from(commitmentVotes).where(and(eq(commitmentVotes.commitmentRequestId, commitmentId), eq(commitmentVotes.memberId, member[0].id))).limit(1);
  if (existingVote[0]) {
    await db.update(commitmentVotes).set({ vote, note: note ?? null }).where(eq(commitmentVotes.id, existingVote[0].id));
  } else {
    await db.insert(commitmentVotes).values({ commitmentRequestId: commitmentId, memberId: member[0].id, vote, note: note ?? null });
  }

  await logActivity({ jarId, userId, eventType: "approval_submitted", description: `A member ${vote}d the commitment request` });

  const updatedCr = await db.select().from(commitmentRequests).where(eq(commitmentRequests.id, commitmentId)).limit(1);
  res.json(await buildCommitmentWithVotes(updatedCr[0]!));
});

export default router;
