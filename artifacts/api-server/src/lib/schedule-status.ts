/**
 * Canonical server-side schedule status computation.
 *
 * Uses CUMULATIVE OBLIGATION ACCOUNTING (Phase 3 conformance):
 *
 *   outstandingCents = max(0, requiredCents - totalContributedCents)
 *
 * Where:
 *   requiredCents       = countElapsedPeriods(schedule) × schedule.amountCents
 *   totalContributedCents = sum of all member contributions since schedule.startDate
 *
 * This prevents double-counting: one contribution cent can only satisfy one
 * cent of obligation. Partial contributions, overpayments, and multi-period
 * arrears all resolve correctly.
 *
 * State transitions:
 *   inactive   : schedule.isActive = false
 *   paused     : schedule.isPaused = true
 *   missed     : outstandingCents > 0 (at least one elapsed period unsatisfied)
 *   due_today  : no outstanding + next due date is today
 *   due_soon   : no outstanding + next due date is 1–3 days away
 *   upcoming   : no outstanding + next due date is 4+ days away (or no next date yet)
 *
 * Removed/left members and inactive schedules are handled by the caller (pass
 * isActive=false for such schedules).
 */

import {
  computeNextDueDate,
  computePreviousDueDate,
  countElapsedPeriods,
  stripTime,
  toISODate,
} from "./schedule-utils.js";

export type ScheduleState =
  | "inactive"
  | "paused"
  | "upcoming"
  | "due_soon"
  | "due_today"
  | "missed"
  | "satisfied";

export interface ScheduleStatusResult {
  state: ScheduleState;
  /** ISO date of the next due date, or null */
  nextDueDate: string | null;
  /** ISO date of the most recent past due date, or null */
  prevDueDate: string | null;
  /** Days until next due (0 = today); null if no upcoming due date */
  daysUntilDue: number | null;
  /** Cumulative outstanding obligation in cents (>0 means missed) */
  outstandingCents: number;
}

export interface ScheduleLike {
  startDate: string;
  frequency: string;
  preferredDay?: number | null;
  isActive: boolean;
  isPaused: boolean;
  amountCents: number;
}

/**
 * Compute schedule status using cumulative obligation accounting.
 *
 * @param schedule             The contribution schedule to evaluate.
 * @param now                  Reference "today" (defaults to new Date()).
 * @param totalContributedCents Sum of all the member's contributions since
 *   schedule.startDate that are in completed/simulated status. The caller is
 *   responsible for fetching and summing these from the DB.
 */
export function computeScheduleStatus(
  schedule: ScheduleLike,
  now: Date = new Date(),
  totalContributedCents: number = 0,
): ScheduleStatusResult {
  const todayStr = toISODate(stripTime(now));

  if (!schedule.isActive) {
    return { state: "inactive", nextDueDate: null, prevDueDate: null, daysUntilDue: null, outstandingCents: 0 };
  }
  if (schedule.isPaused) {
    const next = computeNextDueDate(schedule, now);
    const nextStr = next ? toISODate(next) : null;
    const daysUntilDue = nextStr ? daysBetween(todayStr, nextStr) : null;
    return { state: "paused", nextDueDate: nextStr, prevDueDate: null, daysUntilDue, outstandingCents: 0 };
  }

  // ── Cumulative obligation ────────────────────────────────────────────────────
  const elapsedPeriods = countElapsedPeriods(schedule, now);
  const requiredCents = elapsedPeriods * schedule.amountCents;
  const outstandingCents = Math.max(0, requiredCents - totalContributedCents);

  const next = computeNextDueDate(schedule, now);
  const prev = computePreviousDueDate(schedule, now);
  const nextStr = next ? toISODate(next) : null;
  const prevStr = prev ? toISODate(prev) : null;

  // ── Outstanding obligation ──────────────────────────────────────────────────
  if (outstandingCents > 0) {
    const daysUntilDue = nextStr ? daysBetween(todayStr, nextStr) : null;
    return { state: "missed", nextDueDate: nextStr, prevDueDate: prevStr, daysUntilDue, outstandingCents };
  }

  // ── All obligations met: report upcoming state ────────────────────────────
  return reportNextState(todayStr, nextStr, prevStr);
}

function reportNextState(
  todayStr: string,
  nextStr: string | null,
  prevStr: string | null,
): ScheduleStatusResult {
  if (!nextStr) {
    return { state: "upcoming", nextDueDate: null, prevDueDate: prevStr, daysUntilDue: null, outstandingCents: 0 };
  }
  const days = daysBetween(todayStr, nextStr);
  let state: ScheduleState;
  if (days === 0) state = "due_today";
  else if (days <= 3) state = "due_soon";
  else state = "upcoming";
  return { state, nextDueDate: nextStr, prevDueDate: prevStr, daysUntilDue: days, outstandingCents: 0 };
}

/** Days from ISO date `from` to ISO date `to` (positive = future). UTC-safe. */
function daysBetween(from: string, to: string): number {
  const a = new Date(from + "T00:00:00Z");
  const b = new Date(to + "T00:00:00Z");
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}
