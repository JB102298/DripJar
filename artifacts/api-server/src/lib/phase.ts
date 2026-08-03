/**
 * Jar phase derivation.
 *
 * TRUTH TABLE — every stored status maps to exactly one phase (no overlaps):
 *
 *   #  Stored status  cutoffDate condition           → phase
 *   ─  ─────────────  ──────────────────────────────   ─────────────
 *   1  "Draft"        (any)                          → "Draft"
 *   2  "Inviting"     (any)                          → "Inviting"
 *   3  "Saving"       null OR cutoffDate > today UTC → "Saving"
 *   4  "Saving"       cutoffDate ≤ today UTC         → "Commitment"
 *   5  "Cancelled"    (any — overrides time logic)   → "Cancelled"
 *   6  "Completed"    (any — overrides time logic)   → "Completed"
 *
 * Distinctions:
 *   - "Draft" vs "Inviting": the jar owner controls this via the launch flow.
 *     Draft = jar not yet opened to invitees. Inviting = organizer is
 *     recruiting members; savings schedule has not started.
 *   - "Saving" vs "Commitment": time-based. cutoffDate ≤ today UTC triggers
 *     Commitment. An unaccepted agreement does NOT affect phase — phase is
 *     purely time-derived. Agreement-required is a separate member flag.
 *   - "Cancelled"/"Completed" always override any derived time phase.
 *
 * All cutoff comparisons use UTC string ordering (yyyy-MM-dd lexicographic =
 * chronological) to avoid host-machine timezone drift.
 */

export type JarPhase =
  | "Draft"
  | "Inviting"
  | "Saving"
  | "Commitment"
  | "Cancelled"
  | "Completed";

/**
 * Compute the derived jar phase from the stored status, cutoff date, and
 * a reference time (defaults to UTC now). The cutoff comparison is done
 * entirely in UTC string space (yyyy-MM-dd) to avoid timezone drift.
 */
export function deriveJarPhase(
  status: string,
  cutoffDate: string | null | undefined,
  now: Date = new Date(),
): JarPhase {
  if (status === "Cancelled") return "Cancelled";
  if (status === "Completed") return "Completed";
  if (status === "Draft") return "Draft";
  if (status === "Inviting") return "Inviting";
  if (status === "Saving") {
    if (cutoffDate) {
      // UTC-safe: compare yyyy-MM-dd strings directly — lexicographic order
      // equals chronological order for ISO dates.
      const todayUTC = toUTCDateString(now);
      if (todayUTC >= cutoffDate) return "Commitment";
    }
    return "Saving";
  }
  // Fallback for unexpected stored values
  return status as JarPhase;
}

/** Format a Date as UTC yyyy-MM-dd */
export function toUTCDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Days until a date (positive = future, negative = past, 0 = today). UTC-safe. */
export function daysUntil(targetDateISO: string, now: Date = new Date()): number {
  const target = new Date(targetDateISO + "T00:00:00Z");
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor((target.getTime() - todayMs) / 86_400_000);
}
