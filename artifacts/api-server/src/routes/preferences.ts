/**
 * GET  /auth/preferences  — read email notification preferences for the current user
 * PATCH /auth/preferences  — update email notification preferences
 *
 * Security emails (password reset, email verification) are always sent
 * regardless of these preferences and cannot be disabled here.
 */
import { Router } from "express";
import { db } from "@workspace/db";
import { profiles } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../lib/auth.js";
import { z } from "zod";

const router = Router();

const preferencesSchema = z.object({
  emailPrefContributionReminders: z.boolean().optional(),
  emailPrefCutoffReminders: z.boolean().optional(),
  emailPrefLifecycle: z.boolean().optional(),
});

function safePrefs(p: typeof profiles.$inferSelect) {
  return {
    emailPrefContributionReminders: p.emailPrefContributionReminders,
    emailPrefCutoffReminders: p.emailPrefCutoffReminders,
    emailPrefLifecycle: p.emailPrefLifecycle,
  };
}

// GET /auth/preferences
router.get("/auth/preferences", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const [profile] = await db.select().from(profiles).where(eq(profiles.userId, userId)).limit(1);
  if (!profile) {
    res.status(404).json({ error: "NotFound", message: "Profile not found" });
    return;
  }
  res.json(safePrefs(profile));
});

// PATCH /auth/preferences
router.patch("/auth/preferences", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;

  const parsed = preferencesSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "BadRequest", message: parsed.error.issues[0]?.message ?? "Invalid preferences" });
    return;
  }

  const updates: Partial<typeof profiles.$inferSelect> = { updatedAt: new Date() };
  const data = parsed.data;
  if (data.emailPrefContributionReminders !== undefined)
    updates.emailPrefContributionReminders = data.emailPrefContributionReminders;
  if (data.emailPrefCutoffReminders !== undefined)
    updates.emailPrefCutoffReminders = data.emailPrefCutoffReminders;
  if (data.emailPrefLifecycle !== undefined)
    updates.emailPrefLifecycle = data.emailPrefLifecycle;

  const [updated] = await db
    .update(profiles)
    .set(updates)
    .where(eq(profiles.userId, userId))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "NotFound", message: "Profile not found" });
    return;
  }

  res.json(safePrefs(updated));
});

export default router;
