/**
 * Agreement enforcement helpers.
 *
 * The "current agreement" for a jar is the latest agreement row by
 * createdAt. A user has accepted it if there is an acceptance row
 * referencing that agreement's id and that user's id.
 *
 * A new agreement version invalidates old acceptances automatically
 * because the check is per-agreement-id, not per-jar.
 */
import { db } from "@workspace/db";
import { agreements, agreementAcceptances } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import type { Response } from "express";

/**
 * Return the current (latest) agreement for the jar, and whether the
 * given user has accepted it. Returns null for both if no agreement
 * exists yet.
 */
export async function getCurrentAgreementStatus(
  jarId: string,
  userId: string,
): Promise<{
  agreementId: string | null;
  version: string | null;
  accepted: boolean;
}> {
  const [latest] = await db
    .select()
    .from(agreements)
    .where(eq(agreements.jarId, jarId))
    .orderBy(desc(agreements.createdAt))
    .limit(1);

  if (!latest) return { agreementId: null, version: null, accepted: false };

  const [acceptance] = await db
    .select({ id: agreementAcceptances.id })
    .from(agreementAcceptances)
    .where(
      and(
        eq(agreementAcceptances.agreementId, latest.id),
        eq(agreementAcceptances.userId, userId),
      ),
    )
    .limit(1);

  return {
    agreementId: latest.id,
    version: latest.version,
    accepted: !!acceptance,
  };
}

/**
 * Reject the request (409) when the user has not accepted the current
 * agreement for the jar. Returns true if the check passed (caller should
 * continue); false if the response was already sent (caller must return).
 */
export async function enforceAgreement(
  jarId: string,
  userId: string,
  res: Response,
): Promise<boolean> {
  const { agreementId, accepted } = await getCurrentAgreementStatus(jarId, userId);
  if (!agreementId) return true; // No agreement configured — nothing to enforce
  if (accepted) return true;
  res.status(409).json({
    error: "AgreementRequired",
    message: "You must accept the current savings agreement before performing this action.",
  });
  return false;
}
