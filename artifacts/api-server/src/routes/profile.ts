import { Router } from "express";
import { db } from "@workspace/db";
import { profiles } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../lib/auth.js";

const router = Router();

// GET /profile
router.get("/profile", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;

  const [profile] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .limit(1);

  if (!profile) {
    res.status(404).json({ error: "NotFound", message: "Profile not found" });
    return;
  }

  res.json({
    id: profile.id,
    userId: profile.userId,
    firstName: profile.firstName,
    lastName: profile.lastName,
    displayName: profile.displayName,
    avatarUrl: profile.avatarUrl,
    phone: profile.phone,
    timeZone: profile.timeZone,
    defaultCurrency: profile.defaultCurrency,
    createdAt: profile.createdAt,
  });
});

// PATCH /profile
router.patch("/profile", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const { firstName, lastName, displayName, avatarUrl, phone, timeZone, defaultCurrency } =
    req.body as {
      firstName?: string;
      lastName?: string;
      displayName?: string;
      avatarUrl?: string | null;
      phone?: string | null;
      timeZone?: string;
      defaultCurrency?: string;
    };

  const [existing] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .limit(1);

  if (!existing) {
    res.status(404).json({ error: "NotFound", message: "Profile not found" });
    return;
  }

  const updates: Partial<typeof existing> = { updatedAt: new Date() };
  if (firstName !== undefined) updates.firstName = firstName;
  if (lastName !== undefined) updates.lastName = lastName;
  if (displayName !== undefined) updates.displayName = displayName;
  if (avatarUrl !== undefined) updates.avatarUrl = avatarUrl;
  if (phone !== undefined) updates.phone = phone;
  if (timeZone !== undefined) updates.timeZone = timeZone;
  if (defaultCurrency !== undefined) updates.defaultCurrency = defaultCurrency;

  const [updated] = await db
    .update(profiles)
    .set(updates)
    .where(eq(profiles.userId, userId))
    .returning();

  if (!updated) {
    res.status(500).json({ error: "InternalError", message: "Failed to update profile" });
    return;
  }

  res.json({
    id: updated.id,
    userId: updated.userId,
    firstName: updated.firstName,
    lastName: updated.lastName,
    displayName: updated.displayName,
    avatarUrl: updated.avatarUrl,
    phone: updated.phone,
    timeZone: updated.timeZone,
    defaultCurrency: updated.defaultCurrency,
    createdAt: updated.createdAt,
  });
});

export default router;
