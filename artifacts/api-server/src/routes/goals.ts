/**
 * Jar Goals Routes — Phase 4D
 *
 * Goals are planning metadata ONLY.
 * - No ledger_entries created
 * - No financial_transactions created
 * - No Stripe calls
 * - All funding allocation is computed server-side (pure waterfall function)
 *   from the existing ledger at query time
 *
 * Authorization:
 *   GET  /jars/:jarId/goals                    — any active member or organizer
 *   POST /jars/:jarId/goals                    — organizer only
 *   PATCH /jars/:jarId/goals/:goalId           — organizer only
 *   POST /jars/:jarId/goals/:goalId/archive    — organizer only
 *   POST /jars/:jarId/goals/reorder            — organizer only
 */

import { Router } from "express";
import { db } from "@workspace/db";
import { jars, jarMembers, jarGoals } from "@workspace/db";
import { eq, and, sql, asc } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../lib/auth.js";
import { logActivity } from "../lib/activity.js";
import { computeGoalWaterfall } from "../lib/goal-waterfall.js";
import { getJarPrincipalBreakdown } from "../lib/financial-balance.js";

const router = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Jar statuses that permanently close the jar — goal mutations are rejected for these. */
const TERMINAL_STATUSES = ["Cancelled", "Completed"] as const;
const isTerminal = (status: string) => (TERMINAL_STATUSES as readonly string[]).includes(status);

async function getJarAccess(jarId: string, userId: string) {
  const [jar] = await db.select().from(jars).where(eq(jars.id, jarId)).limit(1);
  if (!jar) return { jar: null, member: null, isOrganizer: false };
  const [member] = await db
    .select()
    .from(jarMembers)
    .where(
      and(eq(jarMembers.jarId, jarId), eq(jarMembers.userId, userId), eq(jarMembers.status, "active")),
    )
    .limit(1);
  return { jar, member: member ?? null, isOrganizer: jar.organizerId === userId };
}

// ─── GET /jars/:jarId/goals ───────────────────────────────────────────────────

router.get("/jars/:jarId/goals", requireAuth, async (req, res) => {
  const userId = (req as unknown as AuthenticatedRequest).userId;
  const { jarId } = req.params as { jarId: string };
  const includeArchived = req.query["includeArchived"] === "true";

  const { jar, member, isOrganizer } = await getJarAccess(jarId, userId);
  if (!jar) { res.status(404).json({ error: "NotFound", message: "Jar not found" }); return; }
  if (!isOrganizer && !member) { res.status(403).json({ error: "Forbidden", message: "Access denied" }); return; }

  const [activeGoals, archivedGoals, breakdown] = await Promise.all([
    db
      .select()
      .from(jarGoals)
      .where(and(eq(jarGoals.jarId, jarId), eq(jarGoals.status, "active")))
      .orderBy(asc(jarGoals.sortOrder), asc(jarGoals.createdAt)),
    includeArchived
      ? db
          .select()
          .from(jarGoals)
          .where(and(eq(jarGoals.jarId, jarId), eq(jarGoals.status, "archived")))
          .orderBy(asc(jarGoals.archivedAt))
      : Promise.resolve([]),
    getJarPrincipalBreakdown(jarId),
  ]);

  const activeGoalTargetSum = activeGoals.reduce((s, g) => s + g.targetPrincipalCents, 0);
  const unallocatedCents = Math.max(0, jar.goalAmountCents - activeGoalTargetSum);
  const waterfall = computeGoalWaterfall(
    activeGoals,
    breakdown.savedPrincipalCents,
    breakdown.committedPrincipalCents,
  );

  const unallocatedTargetCents = unallocatedCents;
  const savedTowardUnallocatedCents = Math.min(
    Math.max(0, breakdown.savedPrincipalCents - activeGoalTargetSum),
    unallocatedTargetCents,
  );
  const overTargetCents = Math.max(0, breakdown.savedPrincipalCents - jar.goalAmountCents);

  res.json({
    goals: waterfall.goals,
    ...(includeArchived && { archivedGoals }),
    isOrganizer,
    goalAmountCents: jar.goalAmountCents,
    savedPrincipalCents: breakdown.savedPrincipalCents,
    committedPrincipalCents: breakdown.committedPrincipalCents,
    // Semantic fields (preferred):
    unallocatedTargetCents,
    savedTowardUnallocatedCents,
    overTargetCents,
    // Legacy aliases (backward compat):
    unallocatedCents,
    surplusCents: waterfall.surplusCents,
  });
});

// ─── POST /jars/:jarId/goals ──────────────────────────────────────────────────

router.post("/jars/:jarId/goals", requireAuth, async (req, res) => {
  const userId = (req as unknown as AuthenticatedRequest).userId;
  const { jarId } = req.params as { jarId: string };

  const { name, description, targetPrincipalCents, sortOrder } = req.body as {
    name?: unknown;
    description?: unknown;
    targetPrincipalCents?: unknown;
    sortOrder?: unknown;
  };

  if (typeof name !== "string" || name.trim().length < 1 || name.trim().length > 100) {
    res.status(400).json({ error: "BadRequest", message: "name must be 1–100 characters" });
    return;
  }
  if (!Number.isInteger(targetPrincipalCents) || (targetPrincipalCents as number) < 1) {
    res.status(400).json({ error: "BadRequest", message: "targetPrincipalCents must be a positive integer" });
    return;
  }
  if (
    description !== undefined &&
    description !== null &&
    (typeof description !== "string" || (description as string).length > 500)
  ) {
    res.status(400).json({ error: "BadRequest", message: "description must be at most 500 characters" });
    return;
  }

  type TxResult =
    | typeof jarGoals.$inferSelect
    | "not_found"
    | "forbidden"
    | "inactive"
    | { constraintViolation: true; currentSum: number; jarTarget: number };

  const txResult: TxResult = await db.transaction(async (tx) => {
    const [jar] = await tx.select().from(jars).where(eq(jars.id, jarId)).limit(1).for("update");
    if (!jar) return "not_found" as const;
    if (jar.organizerId !== userId) return "forbidden" as const;
    if (["Cancelled", "Completed"].includes(jar.status)) return "inactive" as const;

    const [sumRow] = await tx
      .select({ total: sql<number>`coalesce(sum(${jarGoals.targetPrincipalCents}), 0)` })
      .from(jarGoals)
      .where(and(eq(jarGoals.jarId, jarId), eq(jarGoals.status, "active")));

    const currentSum = Number(sumRow?.total ?? 0);
    if (currentSum + (targetPrincipalCents as number) > jar.goalAmountCents) {
      return { constraintViolation: true, currentSum, jarTarget: jar.goalAmountCents };
    }

    // Determine sort_order: explicit if provided, otherwise MAX(existing) + 1
    let resolvedSortOrder: number;
    if (Number.isInteger(sortOrder) && (sortOrder as number) >= 0) {
      resolvedSortOrder = sortOrder as number;
    } else {
      const [maxRow] = await tx
        .select({ maxOrder: sql<number>`coalesce(max(${jarGoals.sortOrder}), 0)` })
        .from(jarGoals)
        .where(and(eq(jarGoals.jarId, jarId), eq(jarGoals.status, "active")));
      resolvedSortOrder = Number(maxRow?.maxOrder ?? 0) + 1;
    }

    const [created] = await tx
      .insert(jarGoals)
      .values({
        jarId,
        name: name.trim(),
        description: typeof description === "string" ? description.trim() || null : null,
        targetPrincipalCents: targetPrincipalCents as number,
        sortOrder: resolvedSortOrder,
        status: "active",
      })
      .returning();

    return created!;
  });

  if (txResult === "not_found") { res.status(404).json({ error: "NotFound", message: "Jar not found" }); return; }
  if (txResult === "forbidden") { res.status(403).json({ error: "Forbidden", message: "Only the jar organizer can create goals" }); return; }
  if (txResult === "inactive") { res.status(400).json({ error: "BadRequest", message: "Cannot create goals on a cancelled or completed jar" }); return; }
  if ("constraintViolation" in txResult) {
    res.status(409).json({
      error: "Conflict",
      message: `Adding this goal would exceed the jar target. Active goals total ${txResult.currentSum} cents; jar target is ${txResult.jarTarget} cents.`,
    });
    return;
  }

  await logActivity({
    jarId,
    userId,
    eventType: "goal_created",
    description: `Goal "${txResult.name}" added`,
    metadata: { goalId: txResult.id, targetPrincipalCents },
  });

  res.status(201).json(txResult);
});

// ─── PATCH /jars/:jarId/goals/:goalId ─────────────────────────────────────────

router.patch("/jars/:jarId/goals/:goalId", requireAuth, async (req, res) => {
  const userId = (req as unknown as AuthenticatedRequest).userId;
  const { jarId, goalId } = req.params as { jarId: string; goalId: string };

  const { name, description, targetPrincipalCents } = req.body as {
    name?: unknown;
    description?: unknown;
    targetPrincipalCents?: unknown;
  };

  if (name !== undefined && (typeof name !== "string" || name.trim().length < 1 || name.trim().length > 100)) {
    res.status(400).json({ error: "BadRequest", message: "name must be 1–100 characters" });
    return;
  }
  if (
    description !== undefined &&
    description !== null &&
    (typeof description !== "string" || (description as string).length > 500)
  ) {
    res.status(400).json({ error: "BadRequest", message: "description must be at most 500 characters" });
    return;
  }
  if (
    targetPrincipalCents !== undefined &&
    (!Number.isInteger(targetPrincipalCents) || (targetPrincipalCents as number) < 1)
  ) {
    res.status(400).json({ error: "BadRequest", message: "targetPrincipalCents must be a positive integer" });
    return;
  }

  type TxResult =
    | typeof jarGoals.$inferSelect
    | "not_found"
    | "forbidden"
    | "inactive"
    | "archived"
    | { constraintViolation: true; otherSum: number; jarTarget: number };

  const txResult: TxResult = await db.transaction(async (tx) => {
    const [jar] = await tx.select().from(jars).where(eq(jars.id, jarId)).limit(1).for("update");
    if (!jar) return "not_found" as const;
    if (jar.organizerId !== userId) return "forbidden" as const;
    if (isTerminal(jar.status)) return "inactive" as const;

    const [goal] = await tx
      .select()
      .from(jarGoals)
      .where(and(eq(jarGoals.id, goalId), eq(jarGoals.jarId, jarId)))
      .limit(1);
    if (!goal) return "not_found" as const;
    if (goal.status === "archived") return "archived" as const;

    if (targetPrincipalCents !== undefined) {
      const [sumRow] = await tx
        .select({ total: sql<number>`coalesce(sum(${jarGoals.targetPrincipalCents}), 0)` })
        .from(jarGoals)
        .where(
          and(
            eq(jarGoals.jarId, jarId),
            eq(jarGoals.status, "active"),
            sql`${jarGoals.id} != ${goalId}`,
          ),
        );
      const otherSum = Number(sumRow?.total ?? 0);
      if (otherSum + (targetPrincipalCents as number) > jar.goalAmountCents) {
        return { constraintViolation: true, otherSum, jarTarget: jar.goalAmountCents };
      }
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (name !== undefined) updates["name"] = (name as string).trim();
    if (description !== undefined) {
      updates["description"] = description === null ? null : (description as string).trim() || null;
    }
    if (targetPrincipalCents !== undefined) updates["targetPrincipalCents"] = targetPrincipalCents;

    const [updated] = await tx
      .update(jarGoals)
      .set(updates as Partial<typeof jarGoals.$inferInsert>)
      .where(eq(jarGoals.id, goalId))
      .returning();

    return updated!;
  });

  if (txResult === "not_found") { res.status(404).json({ error: "NotFound", message: "Goal not found" }); return; }
  if (txResult === "forbidden") { res.status(403).json({ error: "Forbidden", message: "Only the jar organizer can edit goals" }); return; }
  if (txResult === "inactive") { res.status(400).json({ error: "BadRequest", message: "Cannot edit goals on a cancelled or completed jar" }); return; }
  if (txResult === "archived") { res.status(400).json({ error: "BadRequest", message: "Cannot edit an archived goal" }); return; }
  if ("constraintViolation" in txResult) {
    res.status(409).json({
      error: "Conflict",
      message: `Updating this goal's target would exceed the jar target. Other active goals total ${txResult.otherSum} cents; jar target is ${txResult.jarTarget} cents.`,
    });
    return;
  }

  await logActivity({
    jarId,
    userId,
    eventType: "goal_updated",
    description: `Goal "${txResult.name}" updated`,
    metadata: { goalId },
  });

  res.json(txResult);
});

// ─── POST /jars/:jarId/goals/:goalId/archive ──────────────────────────────────

router.post("/jars/:jarId/goals/:goalId/archive", requireAuth, async (req, res) => {
  const userId = (req as unknown as AuthenticatedRequest).userId;
  const { jarId, goalId } = req.params as { jarId: string; goalId: string };

  const [jar] = await db.select().from(jars).where(eq(jars.id, jarId)).limit(1);
  if (!jar) { res.status(404).json({ error: "NotFound", message: "Jar not found" }); return; }
  if (jar.organizerId !== userId) { res.status(403).json({ error: "Forbidden", message: "Only the jar organizer can archive goals" }); return; }
  if (isTerminal(jar.status)) { res.status(400).json({ error: "BadRequest", message: "Cannot modify goals on a cancelled or completed jar" }); return; }

  const [goal] = await db
    .select()
    .from(jarGoals)
    .where(and(eq(jarGoals.id, goalId), eq(jarGoals.jarId, jarId)))
    .limit(1);
  if (!goal) { res.status(404).json({ error: "NotFound", message: "Goal not found" }); return; }
  if (goal.status === "archived") { res.status(400).json({ error: "BadRequest", message: "Goal is already archived" }); return; }

  const isPreLaunch = ["Draft", "Inviting"].includes(jar.status);

  if (isPreLaunch) {
    // Hard delete: jar never launched, members have not seen this goal during active saving
    await db.delete(jarGoals).where(eq(jarGoals.id, goalId));
    await logActivity({
      jarId, userId, eventType: "goal_archived",
      description: `Goal "${goal.name}" deleted`,
      metadata: { goalId, wasHardDeleted: true },
    });
    res.json({ deleted: true });
  } else {
    // Soft archive: preserve for history/audit; exclude from waterfall
    const [archived] = await db
      .update(jarGoals)
      .set({ status: "archived", archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(jarGoals.id, goalId))
      .returning();
    await logActivity({
      jarId, userId, eventType: "goal_archived",
      description: `Goal "${goal.name}" archived`,
      metadata: { goalId, wasHardDeleted: false },
    });
    res.json({ deleted: false, archived: true, goal: archived });
  }
});

// ─── POST /jars/:jarId/goals/reorder ──────────────────────────────────────────

router.post("/jars/:jarId/goals/reorder", requireAuth, async (req, res) => {
  const userId = (req as unknown as AuthenticatedRequest).userId;
  const { jarId } = req.params as { jarId: string };
  const { goalIds } = req.body as { goalIds?: unknown };

  if (!Array.isArray(goalIds) || goalIds.length === 0) {
    res.status(400).json({ error: "BadRequest", message: "goalIds must be a non-empty array" });
    return;
  }
  if ((goalIds as unknown[]).some((id) => typeof id !== "string")) {
    res.status(400).json({ error: "BadRequest", message: "All goalIds must be strings" });
    return;
  }
  if (new Set(goalIds as string[]).size !== (goalIds as string[]).length) {
    res.status(400).json({ error: "BadRequest", message: "goalIds must not contain duplicates" });
    return;
  }

  type ReorderResult =
    | (typeof jarGoals.$inferSelect)[]
    | "not_found"
    | "forbidden"
    | "inactive"
    | "incomplete"
    | `invalid_id:${string}`;

  const txResult: ReorderResult = await db.transaction(async (tx) => {
    const [jar] = await tx.select().from(jars).where(eq(jars.id, jarId)).limit(1).for("update");
    if (!jar) return "not_found" as const;
    if (jar.organizerId !== userId) return "forbidden" as const;
    if (isTerminal(jar.status)) return "inactive" as const;

    const activeGoals = await tx
      .select({ id: jarGoals.id })
      .from(jarGoals)
      .where(and(eq(jarGoals.jarId, jarId), eq(jarGoals.status, "active")));

    const activeIds = new Set(activeGoals.map((g) => g.id));

    // Validate: every provided ID is an active goal in this jar
    for (const id of goalIds as string[]) {
      if (!activeIds.has(id)) {
        return `invalid_id:${id}` as const;
      }
    }
    // Validate: no active goals are missing from the provided list
    if ((goalIds as string[]).length !== activeGoals.length) {
      return "incomplete" as const;
    }

    // Atomically reassign sort_order = 1, 2, 3...
    for (let i = 0; i < (goalIds as string[]).length; i++) {
      await tx
        .update(jarGoals)
        .set({ sortOrder: i + 1, updatedAt: new Date() })
        .where(eq(jarGoals.id, (goalIds as string[])[i]!));
    }

    return tx
      .select()
      .from(jarGoals)
      .where(and(eq(jarGoals.jarId, jarId), eq(jarGoals.status, "active")))
      .orderBy(asc(jarGoals.sortOrder), asc(jarGoals.createdAt));
  });

  if (txResult === "not_found") { res.status(404).json({ error: "NotFound", message: "Jar not found" }); return; }
  if (txResult === "forbidden") { res.status(403).json({ error: "Forbidden", message: "Only the jar organizer can reorder goals" }); return; }
  if (txResult === "inactive") { res.status(400).json({ error: "BadRequest", message: "Cannot modify goals on a cancelled or completed jar" }); return; }
  if (txResult === "incomplete") {
    res.status(400).json({ error: "BadRequest", message: "goalIds must include all active goals — none may be omitted" });
    return;
  }
  if (typeof txResult === "string" && txResult.startsWith("invalid_id:")) {
    res.status(400).json({ error: "BadRequest", message: `Goal ${txResult.slice(11)} is not an active goal in this jar` });
    return;
  }

  await logActivity({
    jarId,
    userId,
    eventType: "goal_reordered",
    description: "Goals reordered",
    metadata: { goalIds },
  });

  res.json({ goals: txResult });
});

export default router;
