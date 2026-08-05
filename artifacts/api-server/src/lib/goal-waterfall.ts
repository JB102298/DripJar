/**
 * Goal Waterfall — Phase 4D
 *
 * Pure function: derives per-goal funding allocation from ordered active goals
 * and current ledger-backed principal balances.
 *
 * Invariants:
 *   - committedAllocated ≤ savedAllocated for every goal
 *   - SUM(savedAllocated) ≤ savedPrincipalCents
 *   - SUM(committedAllocated) ≤ committedPrincipalCents
 *   - No DB calls, no ledger mutations, no Stripe calls
 *   - Result is fully re-derivable from current principal + goal order
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GoalRow {
  id: string;
  name: string;
  description: string | null;
  targetPrincipalCents: number;
  sortOrder: number;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface GoalAllocation extends GoalRow {
  /** Saved principal (refundable + committed) allocated to this goal */
  savedAllocatedCents: number;
  /** Committed-only principal allocated to this goal */
  committedAllocatedCents: number;
  /** savedAllocated / target, 0-100, 1 decimal */
  savedPercent: number;
  /** committedAllocated / target, 0-100, 1 decimal */
  committedPercent: number;
  fundingState: "funded" | "partially_funded" | "unfunded";
}

export interface WaterfallResult {
  goals: GoalAllocation[];
  /**
   * Saved principal remaining after all named active goals are filled.
   * Positive when jar.savedPrincipalCents > SUM(active goal targets).
   * Shown as "Above Goal" display bucket in the UI.
   */
  surplusCents: number;
}

// ─── Pure waterfall function ──────────────────────────────────────────────────

/**
 * Compute the deterministic priority waterfall.
 *
 * @param activeGoals    Active goals, pre-sorted by (sortOrder ASC, createdAt ASC)
 * @param savedPrincipalCents     refundable + committed (ledger-backed, excludes
 *                                refundPending, refunded, fees)
 * @param committedPrincipalCents committed only (subset of saved)
 */
export function computeGoalWaterfall(
  activeGoals: GoalRow[],
  savedPrincipalCents: number,
  committedPrincipalCents: number,
): WaterfallResult {
  let remSaved = Math.max(0, savedPrincipalCents);
  let remCommitted = Math.max(0, committedPrincipalCents);

  const goals: GoalAllocation[] = activeGoals.map((goal) => {
    const savedAllocated = Math.min(goal.targetPrincipalCents, remSaved);
    remSaved -= savedAllocated;

    // Committed is always a sub-slice of saved
    const committedAllocated = Math.min(savedAllocated, remCommitted);
    remCommitted -= committedAllocated;

    const savedPercent =
      goal.targetPrincipalCents > 0
        ? Math.min(100, Math.round((savedAllocated / goal.targetPrincipalCents) * 1000) / 10)
        : 0;
    const committedPercent =
      goal.targetPrincipalCents > 0
        ? Math.min(100, Math.round((committedAllocated / goal.targetPrincipalCents) * 1000) / 10)
        : 0;

    const fundingState: "funded" | "partially_funded" | "unfunded" =
      savedAllocated >= goal.targetPrincipalCents
        ? "funded"
        : savedAllocated > 0
          ? "partially_funded"
          : "unfunded";

    return {
      ...goal,
      savedAllocatedCents: savedAllocated,
      committedAllocatedCents: committedAllocated,
      savedPercent,
      committedPercent,
      fundingState,
    };
  });

  return { goals, surplusCents: remSaved };
}

/**
 * Derive a human-readable status label for a member's financial position.
 * Used in the redacted (non-organizer) member view.
 */
export function memberStatusLabel(params: {
  committedPrincipalCents: number;
  refundPendingCents: number;
  savedPrincipalCents: number;
}): string {
  if (params.committedPrincipalCents > 0) return "Locked In";
  if (params.refundPendingCents > 0) return "Refund Pending";
  if (params.savedPrincipalCents > 0) return "Saving";
  return "Not Started";
}
