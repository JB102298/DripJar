import { db } from "@workspace/db";
import { notifications } from "@workspace/db";

export type NotificationType =
  | "invitation_received"
  | "member_joined"
  | "contribution_recorded"
  | "contribution_due"
  | "contribution_overdue"
  | "jar_halfway_funded"
  | "milestone_funded"
  | "commitment_requested"
  | "member_approved_commitment"
  | "member_rejected_commitment"
  | "lock_date_approaching"
  | "goal_fully_funded"
  | "general";

export async function createNotification(params: {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  relatedJarId?: string;
  actionUrl?: string;
}): Promise<void> {
  try {
    await db.insert(notifications).values({
      userId: params.userId,
      type: params.type,
      title: params.title,
      message: params.message,
      relatedJarId: params.relatedJarId ?? null,
      actionUrl: params.actionUrl ?? null,
      isRead: false,
    });
  } catch (err) {
    // Notification creation is fire-and-forget
    console.error("Failed to create notification:", err);
  }
}

export async function notifyAllMembers(params: {
  jarId: string;
  memberUserIds: string[];
  type: NotificationType;
  title: string;
  message: string;
  excludeUserId?: string;
}): Promise<void> {
  const targets = params.excludeUserId
    ? params.memberUserIds.filter((id) => id !== params.excludeUserId)
    : params.memberUserIds;

  await Promise.all(
    targets.map((userId) =>
      createNotification({
        userId,
        type: params.type,
        title: params.title,
        message: params.message,
        relatedJarId: params.jarId,
      }),
    ),
  );
}
