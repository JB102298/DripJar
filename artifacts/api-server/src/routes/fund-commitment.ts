/**
 * Fund Commitment Routes — Phase 4C
 *
 * Endpoints:
 *   POST /jars/:jarId/commitment/preview  — server-computed snapshot of what
 *                                           a member would commit (FIFO lots)
 *   POST /jars/:jarId/commitment/confirm  — confirm a snapshot, post ledger
 *   GET  /jars/:jarId/commitment/mine     — fetch this member's commitment
 *
 * Lifecycle gate: jar.status = 'Saving' AND cutoffDate IS NOT NULL AND the
 * jar's OWN calendar date (jars.time_zone, not server UTC) >= cutoffDate.
 * Enforced by lifecycleAllowsFundCommitment and re-asserted inside the confirm
 * transaction under a jars row lock.
 * Agreement gate: jar has an active agreement AND caller has accepted it.
 *   - If no agreement configured: preview/confirm are rejected (422 no_active_agreement).
 *   - At confirm time the agreement version is re-checked against the snapshot;
 *     if it changed → 409 snapshot_stale reason=agreement_changed.
 *
 * Idempotency: if fund_commitment already exists for the snapshotToken +
 * memberId + jarId, confirm returns the existing result (HTTP 200) — no
 * second ledger posting.
 *
 * Security:
 *   - Client never submits principalCents, lot IDs, or ledger accounts.
 *   - All amounts are computed server-side from immutable ledger entries.
 *   - snapshotToken is a timing-safe random hex string; never guessable.
 */

import { Router } from "express";
import { db } from "@workspace/db";
import {
  jars,
  jarMembers,
  agreements,
  agreementAcceptances,
  commitmentSnapshots,
  commitmentSnapshotAllocations,
  fundCommitments,
  commitmentAllocations,
  financialTransactions,
} from "@workspace/db";
import { eq, and, desc, inArray, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { requireAuth, type AuthenticatedRequest } from "../lib/auth.js";
import { deriveJarPhase, toUTCDateString } from "../lib/phase.js";
import { lifecycleAllowsFundCommitment, fundCommitmentLifecycleMessage } from "../lib/jar-status.js";
import { getRefundableLots, allocateFromLots } from "../lib/lot-allocation.js";
import { postCommitPrincipalInTx } from "../lib/ledger.js";
import { computeRefundableBalanceInTx } from "../lib/ledger.js";
import { logActivity } from "../lib/activity.js";
import { logger } from "../lib/logger.js";

const router = Router();

/**
 * Thrown inside the confirm transaction when the jar row, once locked, no
 * longer permits committing. Carries the status so the 422 can name it.
 */
class JarLifecycleAbort extends Error {
  constructor(public readonly jarStatus: string) {
    super(`Jar lifecycle no longer permits committing (status: ${jarStatus})`);
    this.name = "JarLifecycleAbort";
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

type DbOrTx = typeof db;

/** Snapshot TTL in milliseconds (15 minutes — per approved Phase 4C architecture). */
const SNAPSHOT_TTL_MS = 15 * 60_000;

/** Fetch the current active agreement for a jar. */
async function getCurrentAgreement(
  jarId: string,
): Promise<{ id: string; version: string } | null> {
  const [latest] = await db
    .select({ id: agreements.id, version: agreements.version })
    .from(agreements)
    .where(eq(agreements.jarId, jarId))
    .orderBy(desc(agreements.createdAt))
    .limit(1);
  return latest ?? null;
}

/** Check whether userId has accepted a specific agreement. */
async function hasAccepted(agreementId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: agreementAcceptances.id })
    .from(agreementAcceptances)
    .where(
      and(
        eq(agreementAcceptances.agreementId, agreementId),
        eq(agreementAcceptances.userId, userId),
      ),
    )
    .limit(1);
  return !!row;
}

// ─── POST /jars/:jarId/commitment/preview ─────────────────────────────────────

router.post("/jars/:jarId/commitment/preview", requireAuth, async (req, res) => {
  const userId = (req as unknown as AuthenticatedRequest).userId;
  const { jarId } = req.params as { jarId: string };

  // Verify jar + membership
  const [jar] = await db.select().from(jars).where(eq(jars.id, jarId)).limit(1);
  if (!jar) {
    res.status(404).json({ error: "NotFound", message: "Jar not found" });
    return;
  }

  const [member] = await db
    .select()
    .from(jarMembers)
    .where(and(eq(jarMembers.jarId, jarId), eq(jarMembers.userId, userId), eq(jarMembers.status, "active")))
    .limit(1);
  if (!member) {
    res.status(403).json({ error: "Forbidden", message: "You are not an active member of this jar" });
    return;
  }

  // Lifecycle gate — lib/jar-status.ts. Allowlist of statuses plus a cutoff
  // date evaluated in the jar's own timezone, not the server's UTC date.
  if (!lifecycleAllowsFundCommitment(jar.status, jar.cutoffDate, jar.timeZone)) {
    res.status(422).json({
      error: "JarLifecycle",
      message: fundCommitmentLifecycleMessage(jar.status),
      phase: deriveJarPhase(jar.status, jar.cutoffDate),
    });
    return;
  }

  // Agreement gate: active agreement required, and caller must have accepted it
  const agreement = await getCurrentAgreement(jarId);
  if (!agreement) {
    res.status(422).json({
      error: "NoActiveAgreement",
      code: "no_active_agreement",
      message: "This jar has no savings agreement. The organizer must create one before members can commit.",
    });
    return;
  }

  const accepted = await hasAccepted(agreement.id, userId);
  if (!accepted) {
    res.status(422).json({
      error: "AgreementNotAccepted",
      code: "agreement_not_accepted",
      message: "You must accept the current savings agreement before committing your funds.",
      agreementId: agreement.id,
      agreementVersion: agreement.version,
    });
    return;
  }

  // Check if already committed
  const [existing] = await db
    .select({ id: fundCommitments.id })
    .from(fundCommitments)
    .where(and(eq(fundCommitments.memberId, member.id), eq(fundCommitments.jarId, jarId)))
    .limit(1);

  if (existing) {
    res.status(409).json({
      error: "AlreadyCommitted",
      message: "You have already committed your funds to this jar.",
      fundCommitmentId: existing.id,
    });
    return;
  }

  // FIFO lot query — find all refundable Stripe contribution lots
  const lots = await getRefundableLots(jarId, member.id);
  if (lots.length === 0) {
    res.status(422).json({
      error: "NothingToCommit",
      message: "You have no refundable Stripe principal to commit. Only Stripe-backed contributions are eligible.",
    });
    return;
  }

  const totalCents = lots.reduce((sum, lot) => sum + lot.remainingCents, 0);

  // Create commitment snapshot
  const snapshotToken = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SNAPSHOT_TTL_MS);

  const [snapshot] = await db
    .insert(commitmentSnapshots)
    .values({
      jarId,
      memberId: member.id,
      agreementId: agreement.id,
      agreementVersion: agreement.version,
      snapshotToken,
      totalPrincipalCents: totalCents,
      status: "pending",
      expiresAt,
    })
    .returning({ id: commitmentSnapshots.id, createdAt: commitmentSnapshots.createdAt });

  if (!snapshot) {
    res.status(500).json({ error: "InternalError", message: "Failed to create commitment snapshot" });
    return;
  }

  // Insert snapshot allocations (one per source lot)
  await db.insert(commitmentSnapshotAllocations).values(
    lots.map((lot) => ({
      snapshotId: snapshot.id,
      sourceFtId: lot.ftId,
      allocatedCents: lot.remainingCents,
    })),
  );

  res.json({
    snapshotToken,
    snapshotId: snapshot.id,
    totalPrincipalCents: totalCents,
    agreementId: agreement.id,
    agreementVersion: agreement.version,
    expiresAt: expiresAt.toISOString(),
    allocations: lots.map((lot) => ({
      sourceFtId: lot.ftId,
      allocatedCents: lot.remainingCents,
    })),
  });
});

// ─── POST /jars/:jarId/commitment/confirm ─────────────────────────────────────

router.post("/jars/:jarId/commitment/confirm", requireAuth, async (req, res) => {
  const userId = (req as unknown as AuthenticatedRequest).userId;
  const { jarId } = req.params as { jarId: string };
  const { snapshotToken } = req.body as { snapshotToken?: unknown };

  if (typeof snapshotToken !== "string" || !snapshotToken.trim()) {
    res.status(400).json({ error: "BadRequest", message: "snapshotToken is required" });
    return;
  }

  // Verify jar + membership
  const [jar] = await db.select().from(jars).where(eq(jars.id, jarId)).limit(1);
  if (!jar) {
    res.status(404).json({ error: "NotFound", message: "Jar not found" });
    return;
  }

  const [member] = await db
    .select()
    .from(jarMembers)
    .where(and(eq(jarMembers.jarId, jarId), eq(jarMembers.userId, userId), eq(jarMembers.status, "active")))
    .limit(1);
  if (!member) {
    res.status(403).json({ error: "Forbidden", message: "You are not an active member of this jar" });
    return;
  }

  // Lifecycle gate — cheap pre-check so an obviously ineligible request is
  // refused before any snapshot or ledger work. This read is NOT authoritative:
  // the jar can be cancelled between here and the write, so the gate is
  // re-asserted inside the transaction under a row lock. See below.
  if (!lifecycleAllowsFundCommitment(jar.status, jar.cutoffDate, jar.timeZone)) {
    res.status(422).json({
      error: "JarLifecycle",
      message: fundCommitmentLifecycleMessage(jar.status),
      phase: deriveJarPhase(jar.status, jar.cutoffDate),
    });
    return;
  }

  // Load snapshot by token
  const [snapshot] = await db
    .select()
    .from(commitmentSnapshots)
    .where(eq(commitmentSnapshots.snapshotToken, snapshotToken))
    .limit(1);

  if (!snapshot) {
    res.status(409).json({ error: "SnapshotNotFound", message: "Snapshot not found or token invalid" });
    return;
  }

  // Validate snapshot ownership
  if (snapshot.memberId !== member.id || snapshot.jarId !== jarId) {
    res.status(403).json({ error: "Forbidden", message: "Snapshot does not belong to you" });
    return;
  }

  // Idempotency: if a fund_commitment already exists for this snapshot, return it
  const [existingCommitment] = await db
    .select()
    .from(fundCommitments)
    .where(eq(fundCommitments.snapshotId, snapshot.id))
    .limit(1);

  if (existingCommitment) {
    res.json({
      fundCommitmentId: existingCommitment.id,
      totalCommittedCents: existingCommitment.totalCommittedCents,
      idempotent: true,
    });
    return;
  }

  // Also check if member already has a commitment via another snapshot (should not happen, but guard)
  const [existingByMember] = await db
    .select({ id: fundCommitments.id })
    .from(fundCommitments)
    .where(and(eq(fundCommitments.memberId, member.id), eq(fundCommitments.jarId, jarId)))
    .limit(1);

  if (existingByMember) {
    res.status(409).json({
      error: "AlreadyCommitted",
      message: "You have already committed your funds to this jar.",
      fundCommitmentId: existingByMember.id,
    });
    return;
  }

  // Check snapshot status and expiry
  if (snapshot.status === "confirmed") {
    res.status(409).json({ error: "SnapshotAlreadyUsed", message: "This snapshot has already been confirmed" });
    return;
  }

  if (snapshot.status !== "pending") {
    res.status(409).json({ error: "SnapshotStale", code: "snapshot_stale", message: "Snapshot is no longer valid" });
    return;
  }

  if (new Date() > snapshot.expiresAt) {
    // Mark expired
    await db
      .update(commitmentSnapshots)
      .set({ status: "expired" })
      .where(eq(commitmentSnapshots.id, snapshot.id));
    res.status(409).json({ error: "SnapshotExpired", code: "snapshot_stale", message: "Snapshot has expired. Please preview again." });
    return;
  }

  // Re-check agreement version hasn't changed since snapshot was taken
  const currentAgreement = await getCurrentAgreement(jarId);
  if (!currentAgreement) {
    res.status(409).json({ error: "SnapshotStale", code: "snapshot_stale", reason: "agreement_changed", message: "The jar agreement has been removed. Please preview again." });
    return;
  }
  if (currentAgreement.id !== snapshot.agreementId || currentAgreement.version !== snapshot.agreementVersion) {
    // Mark snapshot stale
    await db
      .update(commitmentSnapshots)
      .set({ status: "stale" })
      .where(eq(commitmentSnapshots.id, snapshot.id));
    res.status(409).json({
      error: "SnapshotStale",
      code: "snapshot_stale",
      reason: "agreement_changed",
      message: "The savings agreement has been updated since your preview. Please review and accept the new agreement, then preview again.",
    });
    return;
  }

  // Also verify caller has accepted the (re-confirmed) current agreement
  const accepted = await hasAccepted(currentAgreement.id, userId);
  if (!accepted) {
    res.status(422).json({
      error: "AgreementNotAccepted",
      code: "agreement_not_accepted",
      message: "You must accept the current savings agreement before committing.",
      agreementId: currentAgreement.id,
    });
    return;
  }

  // Load snapshot allocations
  const snapshotAllocs = await db
    .select()
    .from(commitmentSnapshotAllocations)
    .where(eq(commitmentSnapshotAllocations.snapshotId, snapshot.id));

  if (snapshotAllocs.length === 0) {
    res.status(409).json({ error: "SnapshotEmpty", message: "Snapshot has no allocations" });
    return;
  }

  const sourceFtIds = snapshotAllocs.map((a) => a.sourceFtId);

  // Validate each snapshotted lot is still individually available
  // (compare current remaining to snapshotted amount)
  const currentLots = await getRefundableLots(jarId, member.id);
  const currentLotMap = new Map(currentLots.map((l) => [l.ftId, l.remainingCents]));

  for (const alloc of snapshotAllocs) {
    const currentRemaining = currentLotMap.get(alloc.sourceFtId) ?? 0;
    if (currentRemaining < Number(alloc.allocatedCents)) {
      // Mark snapshot stale
      await db
        .update(commitmentSnapshots)
        .set({ status: "stale" })
        .where(eq(commitmentSnapshots.id, snapshot.id));
      res.status(409).json({
        error: "SnapshotStale",
        code: "snapshot_stale",
        reason: "balance_changed",
        message: "Your available balance has changed since the preview. Please preview again.",
      });
      return;
    }
  }

  const totalCents = snapshotAllocs.reduce((s, a) => s + Number(a.allocatedCents), 0);

  // Execute commitment within a single atomic transaction
  let fundCommitmentId: string;
  // Captures the winning commitment when a concurrent request already committed under lock.
  // Set inside the transaction callback; checked after the try/catch block.
  let concurrentWinner: { id: string; snapshotId: string; totalCommittedCents: number } | null = null;

  try {
    await db.transaction(async (tx) => {
      const txDb = tx as unknown as DbOrTx;

      // ── Lock order: jars, THEN jar_members. Keep it that way. ──────────────
      //
      // The jar row is locked FIRST and the lifecycle gate re-asserted under
      // that lock. The pre-transaction check above is advisory only: it reads
      // the jar outside any transaction, so `POST /jars/:id/cancel` — a bare
      // `UPDATE jars` — could land between that read and this write and leave a
      // fund commitment sitting on a cancelled jar. That would convert the
      // member's refundable principal into unrecoverable principal after the
      // organizer had already ended the jar.
      //
      // Holding the jar row makes the two orderings deterministic:
      //   cancel first  → this SELECT blocks, then sees "Cancelled" and aborts;
      //                   no commitment, no allocation, nothing posted.
      //   confirm first → cancel's UPDATE blocks until this transaction
      //                   commits, then proceeds; principal committed before
      //                   cancellation stays committed, which is correct.
      //
      // There is no interleaving that produces a commitment after the jar is
      // canonically cancelled.
      const [lockedJar] = await txDb
        .select({ status: jars.status, cutoffDate: jars.cutoffDate, timeZone: jars.timeZone })
        .from(jars)
        .where(eq(jars.id, jarId))
        .for("update");

      if (!lockedJar) throw new Error("Jar not found");

      if (!lifecycleAllowsFundCommitment(lockedJar.status, lockedJar.cutoffDate, lockedJar.timeZone)) {
        throw new JarLifecycleAbort(lockedJar.status);
      }

      // Lock the jar_members row to serialize concurrent operations
      const [locked] = await txDb
        .select({ id: jarMembers.id })
        .from(jarMembers)
        .where(eq(jarMembers.id, member.id))
        .for("update");

      if (!locked) throw new Error("Member not found");

      // Under lock: detect a concurrent confirm that already committed for this member/jar.
      // This covers the race where two requests both pass the pre-tx idempotency check,
      // Request A commits first, and Request B picks up the lock to find the job done.
      const [existingUnderLock] = await txDb
        .select({
          id: fundCommitments.id,
          snapshotId: fundCommitments.snapshotId,
          totalCommittedCents: fundCommitments.totalCommittedCents,
        })
        .from(fundCommitments)
        .where(and(eq(fundCommitments.memberId, member.id), eq(fundCommitments.jarId, jarId)))
        .limit(1);

      if (existingUnderLock) {
        // Record the winner and exit the transaction cleanly (no-op commit, no ledger changes).
        concurrentWinner = {
          id: existingUnderLock.id,
          snapshotId: existingUnderLock.snapshotId,
          totalCommittedCents: Number(existingUnderLock.totalCommittedCents),
        };
        return;
      }

      // Re-verify refundable balance within the locked transaction
      const refundable = await computeRefundableBalanceInTx(txDb, jarId, member.id);
      if (refundable < totalCents) {
        throw new Error(`Insufficient refundable balance: available=${refundable}¢ needed=${totalCents}¢`);
      }

      // Post commitment ledger entries
      const { financialTransactionId } = await postCommitPrincipalInTx(txDb, {
        jarId,
        memberId: member.id,
        amountCents: totalCents,
        currency: jar.currency,
        idempotencyKey: `commit-snapshot:${snapshot.id}`,
      });

      // Insert fund_commitment
      const [fc] = await txDb
        .insert(fundCommitments)
        .values({
          jarId,
          memberId: member.id,
          snapshotId: snapshot.id,
          agreementId: snapshot.agreementId,
          agreementVersion: snapshot.agreementVersion,
          totalCommittedCents: totalCents,
          financialTransactionId,
        })
        .returning({ id: fundCommitments.id });

      if (!fc) throw new Error("Failed to insert fund_commitment");
      fundCommitmentId = fc.id;

      // Insert commitment_allocations (one per snapshot allocation)
      await txDb.insert(commitmentAllocations).values(
        snapshotAllocs.map((a) => ({
          fundCommitmentId: fc.id,
          sourceFtId: a.sourceFtId,
          allocatedCents: a.allocatedCents,
        })),
      );

      // Mark snapshot confirmed
      await txDb
        .update(commitmentSnapshots)
        .set({ status: "confirmed", confirmedAt: new Date() })
        .where(eq(commitmentSnapshots.id, snapshot.id));
    });
  } catch (err) {
    const message = (err as Error).message;
    logger.error({ err: { message }, jarId, memberId: member.id }, "Commitment confirm failed");

    if (err instanceof JarLifecycleAbort) {
      // The jar changed under us between the advisory pre-check and the row
      // lock — almost always a cancellation racing this confirmation. The
      // transaction rolled back, so no commitment, allocation, or ledger
      // posting exists, and the member's principal is still refundable.
      res.status(422).json({
        error: "JarLifecycle",
        message: fundCommitmentLifecycleMessage(err.jarStatus),
      });
    } else if (message.startsWith("Insufficient")) {
      res.status(409).json({ error: "InsufficientBalance", code: "balance_changed", message });
    } else {
      res.status(500).json({ error: "InternalError", message: "Failed to confirm commitment" });
    }
    return;
  }

  // Handle concurrent commitment detected under lock (transaction exited cleanly, no error thrown).
  // Use an explicit `as` cast to preserve the declared type (TypeScript loses the union when a
  // let-variable is written inside an async closure and cannot narrow it reliably afterwards).
  // Extract the snapshot comparison to a const boolean to prevent further property-based
  // discriminant narrowing that would otherwise collapse winner to `never` inside the if branch.
  type WinnerShape = { id: string; snapshotId: string; totalCommittedCents: number };
  const winner = concurrentWinner as WinnerShape | null;
  if (winner !== null) {
    const isSameSnapshot = winner.snapshotId === snapshot.id;
    if (isSameSnapshot) {
      // Same snapshot committed by the winning concurrent request — idempotent result.
      logger.info({ jarId, memberId: member.id, fundCommitmentId: winner.id }, "Concurrent confirm: returning idempotent result");
      res.json({
        fundCommitmentId: winner.id,
        totalCommittedCents: winner.totalCommittedCents,
        idempotent: true,
      });
    } else {
      // Different snapshot — funds already committed via another snapshot.
      res.status(409).json({
        error: "AlreadyCommitted",
        message: "You have already committed your funds to this jar.",
        fundCommitmentId: winner.id,
      });
    }
    return;
  }

  // Fire-and-forget activity log
  void logActivity({
    jarId,
    userId,
    eventType: "fund_committed",
    description: `Member committed ${(totalCents / 100).toFixed(2)} ${jar.currency}`,
    amountCents: totalCents,
    metadata: { fundCommitmentId: fundCommitmentId! },
  });

  res.json({
    fundCommitmentId: fundCommitmentId!,
    totalCommittedCents: totalCents,
    idempotent: false,
  });
});

// ─── GET /jars/:jarId/commitment/mine ─────────────────────────────────────────

router.get("/jars/:jarId/commitment/mine", requireAuth, async (req, res) => {
  const userId = (req as unknown as AuthenticatedRequest).userId;
  const { jarId } = req.params as { jarId: string };

  const [jar] = await db.select({ id: jars.id }).from(jars).where(eq(jars.id, jarId)).limit(1);
  if (!jar) {
    res.status(404).json({ error: "NotFound", message: "Jar not found" });
    return;
  }

  const [member] = await db
    .select({ id: jarMembers.id })
    .from(jarMembers)
    .where(and(eq(jarMembers.jarId, jarId), eq(jarMembers.userId, userId), eq(jarMembers.status, "active")))
    .limit(1);
  if (!member) {
    res.status(403).json({ error: "Forbidden", message: "Access denied" });
    return;
  }

  const [commitment] = await db
    .select()
    .from(fundCommitments)
    .where(and(eq(fundCommitments.memberId, member.id), eq(fundCommitments.jarId, jarId)))
    .limit(1);

  if (!commitment) {
    res.json({ commitment: null });
    return;
  }

  const allocs = await db
    .select()
    .from(commitmentAllocations)
    .where(eq(commitmentAllocations.fundCommitmentId, commitment.id));

  res.json({
    commitment: {
      id: commitment.id,
      jarId: commitment.jarId,
      memberId: commitment.memberId,
      totalCommittedCents: commitment.totalCommittedCents,
      agreementId: commitment.agreementId,
      agreementVersion: commitment.agreementVersion,
      createdAt: commitment.createdAt,
      allocations: allocs.map((a) => ({
        id: a.id,
        sourceFtId: a.sourceFtId,
        allocatedCents: a.allocatedCents,
      })),
    },
  });
});

export default router;
