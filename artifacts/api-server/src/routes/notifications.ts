import { Router } from "express";
import { db } from "@workspace/db";
import { notifications, jars } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { requireAuth, type AuthenticatedRequest } from "../lib/auth.js";

const router = Router();

// GET /notifications
router.get("/notifications", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const { unreadOnly } = req.query as { unreadOnly?: string };

  const whereClause = unreadOnly === "true"
    ? and(eq(notifications.userId, userId), eq(notifications.isRead, false))
    : eq(notifications.userId, userId);

  const allNotifications = await db
    .select()
    .from(notifications)
    .where(whereClause)
    .orderBy(desc(notifications.createdAt))
    .limit(50);

  // Enrich with jar names
  const result = await Promise.all(
    allNotifications.map(async (n) => {
      let relatedJarName: string | null = null;
      if (n.relatedJarId) {
        const jar = await db.select({ name: jars.name }).from(jars).where(eq(jars.id, n.relatedJarId)).limit(1);
        relatedJarName = jar[0]?.name ?? null;
      }
      return {
        id: n.id,
        userId: n.userId,
        type: n.type,
        title: n.title,
        message: n.message,
        isRead: n.isRead,
        relatedJarId: n.relatedJarId,
        relatedJarName,
        actionUrl: n.actionUrl,
        createdAt: n.createdAt,
      };
    }),
  );

  res.json(result);
});

// PATCH /notifications/:notificationId/read
router.patch("/notifications/:notificationId/read", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const { notificationId } = req.params as { notificationId: string };

  const [updated] = await db
    .update(notifications)
    .set({ isRead: true })
    .where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId)))
    .returning();

  if (!updated) { res.status(404).json({ error: "NotFound", message: "Notification not found" }); return; }
  res.json({ ...updated, relatedJarName: null });
});

// POST /notifications/read-all
router.post("/notifications/read-all", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  await db.update(notifications).set({ isRead: true }).where(eq(notifications.userId, userId));
  res.json({ message: "All notifications marked as read" });
});

export default router;
