import { db } from "@workspace/db";
import { activityEvents } from "@workspace/db";

export type ActivityEventType =
  | "jar_created"
  | "invitation_sent"
  | "member_joined"
  | "contribution_added"
  | "contribution_reversed"
  | "target_changed"
  | "milestone_created"
  | "milestone_funded"
  | "commitment_requested"
  | "approval_submitted"
  | "jar_locked"
  | "jar_completed"
  | "jar_cancelled"
  | "member_left"
  | "member_removed"
  | "invitation_revoked"
  | "jar_updated"
  | "agreement_accepted";

export async function logActivity(params: {
  jarId: string;
  userId?: string;
  eventType: ActivityEventType;
  description: string;
  amountCents?: number;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.insert(activityEvents).values({
      jarId: params.jarId,
      userId: params.userId ?? null,
      eventType: params.eventType,
      description: params.description,
      amountCents: params.amountCents ?? null,
      metadata: params.metadata ?? null,
    });
  } catch (err) {
    // Activity logging is fire-and-forget; never block main request
    console.error("Failed to log activity:", err);
  }
}
