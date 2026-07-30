import { Router } from "express";
import { db } from "@workspace/db";
import { jars, jarMembers, invitations, profiles, users } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../lib/auth.js";
import { logActivity } from "../lib/activity.js";
import { createNotification } from "../lib/notifications.js";
import crypto from "node:crypto";
import { sendInvitationEmail } from "../lib/email.js";
import { invitationLimiter } from "../lib/rate-limit.js";

const router = Router();

// POST /jars/:jarId/invitations
router.post("/jars/:jarId/invitations", requireAuth, invitationLimiter, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const userEmail = (req as AuthenticatedRequest).userEmail;
  const { jarId } = req.params as { jarId: string };

  const jar = await db.select().from(jars).where(eq(jars.id, jarId)).limit(1);
  if (!jar[0]) { res.status(404).json({ error: "NotFound", message: "Jar not found" }); return; }
  if (jar[0].organizerId !== userId) {
    res.status(403).json({ error: "Forbidden", message: "Only organizer can send invitations" });
    return;
  }

  const { email, role = "member", contributionTargetCents } = req.body as {
    email?: string;
    role?: string;
    contributionTargetCents?: number;
  };

  if (!email) { res.status(400).json({ error: "BadRequest", message: "Email is required" }); return; }
  if (email.toLowerCase() === userEmail?.toLowerCase()) {
    res.status(400).json({ error: "BadRequest", message: "You cannot invite yourself" });
    return;
  }

  // Check for existing active invitation
  const existing = await db
    .select()
    .from(invitations)
    .where(and(eq(invitations.jarId, jarId), eq(invitations.email, email.toLowerCase()), eq(invitations.status, "pending")))
    .limit(1);

  if (existing[0]) {
    res.status(409).json({ error: "Conflict", message: "A pending invitation already exists for this email" });
    return;
  }

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000); // 7 days

  const [invitation] = await db.insert(invitations).values({
    jarId,
    email: email.toLowerCase(),
    role,
    contributionTargetCents: contributionTargetCents ?? null,
    status: "pending",
    token,
    sentAt: new Date(),
    expiresAt,
    invitedByUserId: userId,
  }).returning();

  if (!invitation) { res.status(500).json({ error: "InternalError", message: "Failed to create invitation" }); return; }

  // Send invitation email (non-blocking — errors are logged but don't fail the request)
  const inviterProfile = await db.select().from(profiles).where(eq(profiles.userId, userId)).limit(1);
  const inviterName = inviterProfile[0]?.displayName ?? "A TripJar member";
  sendInvitationEmail({
    toEmail: email.toLowerCase(),
    jarName: jar[0].name,
    inviterName,
    token,
  }).catch(() => { /* already logged inside sendInvitationEmail */ });

  await logActivity({
    jarId,
    userId,
    eventType: "invitation_sent",
    description: `Invitation sent to ${email}`,
  });

  // If the invited email belongs to an existing user, notify them
  const invitedUser = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  if (invitedUser[0]) {
    await createNotification({
      userId: invitedUser[0].id,
      type: "invitation_received",
      title: `You're invited to ${jar[0].name}!`,
      message: `Join the ${jar[0].name} savings jar and start saving together.`,
      relatedJarId: jarId,
    });
  }

  res.status(201).json(invitation);
});

// GET /invitations
router.get("/invitations", requireAuth, async (req, res) => {
  const userEmail = (req as AuthenticatedRequest).userEmail;

  const myInvitations = await db
    .select()
    .from(invitations)
    .where(eq(invitations.email, userEmail.toLowerCase()))
    .orderBy(desc(invitations.sentAt));

  // Enrich with jar summaries
  const result = await Promise.all(
    myInvitations.map(async (inv) => {
      const jar = await db.select().from(jars).where(eq(jars.id, inv.jarId)).limit(1);
      const memberCount = jar[0]
        ? await db.select({ c: eq(jarMembers.status, "active") }).from(jarMembers).where(and(eq(jarMembers.jarId, inv.jarId), eq(jarMembers.status, "active")))
        : [];
      return {
        ...inv,
        jar: jar[0]
          ? {
              id: jar[0].id,
              organizerId: jar[0].organizerId,
              name: jar[0].name,
              category: jar[0].category,
              destination: jar[0].destination,
              coverImageUrl: jar[0].coverImageUrl,
              targetDate: jar[0].targetDate,
              goalAmountCents: jar[0].goalAmountCents,
              currency: jar[0].currency,
              status: jar[0].status,
              memberCount: memberCount.length,
              totalSavedCents: 0,
              percentFunded: 0,
              daysRemaining: Math.max(0, Math.ceil((new Date(jar[0].targetDate).getTime() - Date.now()) / 86_400_000)),
              userRole: null,
              health: null,
            }
          : null,
      };
    }),
  );

  res.json(result);
});

// GET /invitations/token/:token
router.get("/invitations/token/:token", async (req, res) => {
  const { token } = req.params as { token: string };

  const [inv] = await db.select().from(invitations).where(eq(invitations.token, token)).limit(1);
  if (!inv) { res.status(404).json({ error: "NotFound", message: "Invitation not found or expired" }); return; }

  if (inv.status !== "pending" || inv.expiresAt < new Date()) {
    res.status(404).json({ error: "NotFound", message: "Invitation is no longer valid" });
    return;
  }

  const jar = await db.select().from(jars).where(eq(jars.id, inv.jarId)).limit(1);

  res.json({
    ...inv,
    jar: jar[0]
      ? {
          id: jar[0].id,
          organizerId: jar[0].organizerId,
          name: jar[0].name,
          category: jar[0].category,
          destination: jar[0].destination,
          coverImageUrl: jar[0].coverImageUrl,
          targetDate: jar[0].targetDate,
          goalAmountCents: jar[0].goalAmountCents,
          currency: jar[0].currency,
          status: jar[0].status,
          memberCount: 0,
          totalSavedCents: 0,
          percentFunded: 0,
          daysRemaining: Math.max(0, Math.ceil((new Date(jar[0].targetDate).getTime() - Date.now()) / 86_400_000)),
          userRole: null,
          health: null,
        }
      : null,
  });
});

// POST /invitations/:invitationId/accept
router.post("/invitations/:invitationId/accept", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const userEmail = (req as AuthenticatedRequest).userEmail;
  const { invitationId } = req.params as { invitationId: string };

  const [inv] = await db.select().from(invitations).where(eq(invitations.id, invitationId)).limit(1);
  if (!inv) { res.status(404).json({ error: "NotFound", message: "Invitation not found" }); return; }
  if (inv.email !== userEmail.toLowerCase()) {
    res.status(403).json({ error: "Forbidden", message: "This invitation is not for your email address" });
    return;
  }
  if (inv.status !== "pending") {
    res.status(400).json({ error: "BadRequest", message: `Invitation is already ${inv.status}` });
    return;
  }
  if (inv.expiresAt < new Date()) {
    await db.update(invitations).set({ status: "expired" }).where(eq(invitations.id, invitationId));
    res.status(400).json({ error: "BadRequest", message: "Invitation has expired" });
    return;
  }

  // Check if already a member
  const existing = await db
    .select()
    .from(jarMembers)
    .where(and(eq(jarMembers.jarId, inv.jarId), eq(jarMembers.userId, userId)))
    .limit(1);

  if (existing[0]) {
    res.status(409).json({ error: "Conflict", message: "You are already a member of this jar" });
    return;
  }

  const [member] = await db.insert(jarMembers).values({
    jarId: inv.jarId,
    userId,
    role: inv.role,
    contributionTargetCents: inv.contributionTargetCents ?? 0,
    status: "active",
    joinedAt: new Date(),
  }).returning();

  if (!member) { res.status(500).json({ error: "InternalError", message: "Failed to join jar" }); return; }

  await db.update(invitations)
    .set({ status: "accepted", acceptedAt: new Date() })
    .where(eq(invitations.id, invitationId));

  await logActivity({
    jarId: inv.jarId,
    userId,
    eventType: "member_joined",
    description: `A new member joined the jar`,
  });

  // Notify organizer
  const jar = await db.select().from(jars).where(eq(jars.id, inv.jarId)).limit(1);
  if (jar[0]) {
    const prof = await db.select().from(profiles).where(eq(profiles.userId, userId)).limit(1);
    await createNotification({
      userId: jar[0].organizerId,
      type: "member_joined",
      title: "New member joined!",
      message: `${prof[0]?.displayName ?? "Someone"} accepted your invitation to ${jar[0].name}.`,
      relatedJarId: inv.jarId,
    });
  }

  res.json({
    id: member.id,
    jarId: member.jarId,
    userId: member.userId,
    role: member.role,
    contributionTargetCents: member.contributionTargetCents,
    contributedAmountCents: 0,
    percentComplete: 0,
    status: member.status,
    healthStatus: "NotStarted",
    joinedAt: member.joinedAt,
    profile: null,
  });
});

// POST /invitations/:invitationId/decline
router.post("/invitations/:invitationId/decline", requireAuth, async (req, res) => {
  const userEmail = (req as AuthenticatedRequest).userEmail;
  const { invitationId } = req.params as { invitationId: string };

  const [inv] = await db.select().from(invitations).where(eq(invitations.id, invitationId)).limit(1);
  if (!inv) { res.status(404).json({ error: "NotFound", message: "Invitation not found" }); return; }
  if (inv.email !== userEmail.toLowerCase()) {
    res.status(403).json({ error: "Forbidden", message: "This invitation is not for your email" });
    return;
  }

  await db.update(invitations).set({ status: "declined" }).where(eq(invitations.id, invitationId));

  res.json({ message: "Invitation declined" });
});

export default router;
