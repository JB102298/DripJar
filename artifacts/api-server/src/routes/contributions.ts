import { Router } from "express";
import { db } from "@workspace/db";
import { jars, jarMembers, contributions, profiles, milestones } from "@workspace/db";
import { eq, and, desc, sql, inArray } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../lib/auth.js";
import { getJarSavedPrincipalCents } from "../lib/financial-balance.js";
import { resolveDisplayName } from "../lib/display-name.js";
import { logActivity } from "../lib/activity.js";
import { lifecycleAllowsNewContribution, contributionLifecycleMessage } from "../lib/jar-status.js";
import { notifyJarProgressThresholds } from "../lib/notification-financial.js";
import { contributionLimiter } from "../lib/rate-limit.js";
import { enforceAgreement } from "../lib/agreement-check.js";

const router = Router();

// GET /jars/:jarId/contributions
router.get("/jars/:jarId/contributions", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const { jarId } = req.params as { jarId: string };
  const { memberId } = req.query as { memberId?: string };

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

  let query = db
    .select()
    .from(contributions)
    .where(
      and(
        eq(contributions.jarId, jarId),
        memberId ? eq(contributions.memberId, memberId) : undefined,
        inArray(contributions.status, ["completed", "simulated", "reversed"]),
      ),
    )
    .orderBy(desc(contributions.createdAt)) as any;

  const contribs = await query;

  // Enrich with member names
  const memberIds = [...new Set(contribs.map((c: any) => c.memberId))];
  const members = memberIds.length > 0
    ? await db.select().from(jarMembers).where(inArray(jarMembers.id, memberIds as string[]))
    : [];
  const memberUserIds = [...new Set(members.map((m) => m.userId))];
  const memberProfiles = memberUserIds.length > 0
    ? await db.select().from(profiles).where(inArray(profiles.userId, memberUserIds))
    : [];

  const profileByMemberId = new Map(
    members.map((m) => [m.id, memberProfiles.find((p) => p.userId === m.userId)]),
  );

  const result = contribs.map((c: any) => ({
    id: c.id,
    jarId: c.jarId,
    memberId: c.memberId,
    amountCents: c.amountCents,
    contributionDate: c.contributionDate,
    status: c.status,
    sourceType: c.sourceType,
    milestoneId: c.milestoneId,
    note: c.note,
    memberName: resolveDisplayName(profileByMemberId.get(c.memberId)),
    createdAt: c.createdAt,
  }));

  res.json(result);
});

// POST /jars/:jarId/contributions
router.post("/jars/:jarId/contributions", requireAuth, contributionLimiter, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const { jarId } = req.params as { jarId: string };

  const jar = await db.select().from(jars).where(eq(jars.id, jarId)).limit(1);
  if (!jar[0]) { res.status(404).json({ error: "NotFound", message: "Jar not found" }); return; }

  // Centralised lifecycle gate — lib/jar-status.ts. This route used to inline
  // its own status array while the two real money paths had none at all.
  // 422 + `JarLifecycle`, matching every other money-in route. This used to be
  // a generic 400, indistinguishable from a malformed amount. Neither the
  // OpenAPI spec nor any client branches on the old code.
  if (!lifecycleAllowsNewContribution(jar[0].status)) {
    res.status(422).json({ error: "JarLifecycle", message: contributionLifecycleMessage(jar[0].status) });
    return;
  }

  const member = await db
    .select()
    .from(jarMembers)
    .where(and(eq(jarMembers.jarId, jarId), eq(jarMembers.userId, userId), eq(jarMembers.status, "active")))
    .limit(1);

  if (!member[0]) {
    res.status(403).json({ error: "Forbidden", message: "You are not an active member of this jar" });
    return;
  }

  // Require current agreement acceptance before recording a contribution
  const agreementOk = await enforceAgreement(jarId, userId, res);
  if (!agreementOk) return;

  const { amountCents, contributionDate, milestoneId, note } = req.body as {
    amountCents?: number;
    contributionDate?: string;
    milestoneId?: string;
    note?: string;
  };

  if (!amountCents || amountCents < 1) {
    res.status(400).json({ error: "BadRequest", message: "Amount must be at least $0.01" });
    return;
  }

  // Validate milestone belongs to jar
  if (milestoneId) {
    const ms = await db.select().from(milestones).where(and(eq(milestones.id, milestoneId), eq(milestones.jarId, jarId))).limit(1);
    if (!ms[0]) {
      res.status(400).json({ error: "BadRequest", message: "Milestone not found in this jar" });
      return;
    }
  }

  const today = new Date().toISOString().split("T")[0]!;
  const [contribution] = await db.insert(contributions).values({
    jarId,
    memberId: member[0].id,
    amountCents,
    contributionDate: contributionDate ?? today,
    status: "simulated",
    sourceType: "manual",
    milestoneId: milestoneId ?? null,
    note: note ?? null,
  }).returning();

  if (!contribution) { res.status(500).json({ error: "InternalError", message: "Failed to record contribution" }); return; }

  await logActivity({
    jarId,
    userId,
    eventType: "contribution_added",
    description: `A contribution of $${(amountCents / 100).toFixed(2)} was added`,
    amountCents,
  });

  // Check if jar is now fully funded.
  //
  // Uses canonical ledger-backed principal, so Test Mode money cannot flip a
  // jar to FullyFunded. The contribution just recorded above is `simulated`
  // and therefore deliberately does not count toward this.
  const totalSaved = await getJarSavedPrincipalCents(jarId);

  if (totalSaved >= jar[0].goalAmountCents) {
    await db.update(jars).set({ status: "FullyFunded", updatedAt: new Date() }).where(eq(jars.id, jarId));

    // Routed through the canonical threshold emitter rather than a direct
    // broadcast. The figure was already canonical, but the announcement was
    // not idempotent: every subsequent POST to this route re-entered this
    // branch while `saved >= goal` and told the whole jar again.
    await notifyJarProgressThresholds(jarId);
  }

  // ─── NO CONTRIBUTION NOTIFICATION IS SENT FROM THIS ROUTE ──────────────────
  //
  // This route writes `status:'simulated'` — Test Mode principal. It posts
  // nothing to the ledger, and `getJarSavedPrincipalCents` excludes it by
  // design, so the money it records does not exist in canonical accounting.
  //
  // It nevertheless used to broadcast to every other member:
  //
  //   `${resolveDisplayName(prof[0])} added $${(amountCents / 100)...} to ${jar.name}`
  //
  // built from `req.body.amountCents`. Three separate violations in one line:
  // a settled-contribution notification for an unsettled row, an amount taken
  // from a mutable client payload, and other members told that principal had
  // arrived when the jar's canonical balance had not moved. A jar could
  // therefore accumulate "X added $Y" notifications while its saved principal
  // stayed at $0 — the shape of the QA contradiction, reproducible on any jar.
  //
  // Settled-contribution notifications now have exactly one origin: a posted
  // ledger transaction, via lib/notification-financial.ts. Test Mode money
  // announces nothing. If Test Mode ever needs its own visibly-labelled
  // notification, that is a new product decision, not a restoration of this.
  const prof = await db.select().from(profiles).where(eq(profiles.userId, userId)).limit(1);

  res.status(201).json({
    id: contribution.id,
    jarId: contribution.jarId,
    memberId: contribution.memberId,
    amountCents: contribution.amountCents,
    contributionDate: contribution.contributionDate,
    status: contribution.status,
    sourceType: contribution.sourceType,
    milestoneId: contribution.milestoneId,
    note: contribution.note,
    memberName: resolveDisplayName(prof[0]),
    createdAt: contribution.createdAt,
  });
});

// POST /jars/:jarId/contributions/:contributionId/reverse
router.post("/jars/:jarId/contributions/:contributionId/reverse", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const { jarId, contributionId } = req.params as { jarId: string; contributionId: string };

  const jar = await db.select().from(jars).where(eq(jars.id, jarId)).limit(1);
  if (!jar[0]) { res.status(404).json({ error: "NotFound", message: "Jar not found" }); return; }

  const [contrib] = await db.select().from(contributions).where(and(eq(contributions.id, contributionId), eq(contributions.jarId, jarId))).limit(1);
  if (!contrib) { res.status(404).json({ error: "NotFound", message: "Contribution not found" }); return; }

  // Only organizer or the contributing member can reverse
  const member = await db.select().from(jarMembers).where(and(eq(jarMembers.id, contrib.memberId), eq(jarMembers.userId, userId))).limit(1);
  if (jar[0].organizerId !== userId && !member[0]) {
    res.status(403).json({ error: "Forbidden", message: "Only the organizer or contributing member can reverse a contribution" });
    return;
  }

  if (contrib.status === "reversed") {
    res.status(400).json({ error: "BadRequest", message: "Contribution is already reversed" });
    return;
  }

  const { reason } = req.body as { reason?: string };
  const [updated] = await db.update(contributions)
    .set({ status: "reversed", reversedAt: new Date(), reversalNote: reason ?? null })
    .where(eq(contributions.id, contributionId))
    .returning();

  if (!updated) { res.status(500).json({ error: "InternalError", message: "Failed to reverse contribution" }); return; }

  await logActivity({
    jarId,
    userId,
    eventType: "contribution_reversed",
    description: `A contribution of $${(contrib.amountCents / 100).toFixed(2)} was reversed`,
    amountCents: contrib.amountCents,
  });

  res.json({ ...updated, memberName: null });
});

export default router;
