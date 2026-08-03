/**
 * Utilities for computing contribution schedule due dates.
 *
 * TIMEZONE CONVENTION (Phase 3 conformance):
 * All date arithmetic in this module uses UTC. Internal Date objects represent
 * UTC midnight of their calendar date. `toISODate()` uses `toISOString().slice(0,10)`
 * which is always UTC. This ensures the server produces identical results regardless
 * of the host machine's local timezone setting.
 *
 * User-facing date display is performed in the presentation layer (mobile client),
 * which may render dates in the user's local timezone without affecting server logic.
 */

export interface ScheduleLike {
  startDate: string; // ISO date string yyyy-MM-dd
  frequency: string;
  preferredDay?: number | null;
}

/**
 * Given a schedule, find the next due date that is:
 *  - >= afterDate (UTC calendar comparison)
 *  - >= schedule.startDate
 *
 * Returns null for manual/custom frequencies.
 */
export function computeNextDueDate(schedule: ScheduleLike, afterDate: Date = new Date()): Date | null {
  const start = parseUTCDate(schedule.startDate);
  const { frequency, preferredDay } = schedule;

  // Never return a date before the schedule has started
  const effectiveAfter = laterDate(afterDate, start);

  if (frequency === "weekly") {
    return advanceByDays(start, effectiveAfter, 7);
  }

  if (frequency === "biweekly") {
    return advanceByDays(start, effectiveAfter, 14);
  }

  if (frequency === "monthly") {
    return advanceMonthly(start, effectiveAfter, preferredDay ?? null);
  }

  if (frequency === "twiceMonthly") {
    return advanceTwiceMonthly(start, effectiveAfter, preferredDay ?? null);
  }

  return null;
}

/**
 * Find the most recent due date that is < afterDate (a due date that has already passed)
 * and is >= schedule.startDate. UTC-safe.
 * Returns null if no due date has passed yet.
 */
export function computePreviousDueDate(schedule: ScheduleLike, afterDate: Date = new Date()): Date | null {
  const start = parseUTCDate(schedule.startDate);
  const next = computeNextDueDate(schedule, afterDate);
  if (!next) return null;

  const { frequency, preferredDay } = schedule;

  let prev: Date;
  if (frequency === "weekly") {
    prev = addUTCDays(next, -7);
  } else if (frequency === "biweekly") {
    prev = addUTCDays(next, -14);
  } else if (frequency === "monthly") {
    // Step back one month, keeping the same clamped day
    const dom = next.getUTCDate();
    prev = safeUTCMonthDate(next.getUTCFullYear(), next.getUTCMonth() - 1, dom);
  } else if (frequency === "twiceMonthly") {
    const firstDay = preferredDay ?? 1;
    const secondDay = Math.min(firstDay + 15, 28);
    const dom = next.getUTCDate();
    if (dom === secondDay) {
      prev = safeUTCMonthDate(next.getUTCFullYear(), next.getUTCMonth(), firstDay);
    } else {
      // dom === firstDay: step to previous month's secondDay
      prev = safeUTCMonthDate(next.getUTCFullYear(), next.getUTCMonth() - 1, secondDay);
    }
  } else {
    return null;
  }

  // Don't return before schedule start (UTC comparison)
  return stripTime(prev) >= stripTime(start) ? prev : null;
}

/**
 * Count the number of due dates that have fully passed (strictly < today UTC).
 * Used for cumulative obligation accounting.
 *
 * Examples:
 *   weekly schedule starting 2026-01-01, today = 2026-01-15 (Wednesday)
 *   → due dates that passed: Jan 1, Jan 8 → returns 2
 *   (Jan 15 is today — not yet "elapsed" as it's the current period)
 */
export function countElapsedPeriods(schedule: ScheduleLike, now: Date = new Date()): number {
  const todayStr = toISODate(stripTime(now));
  if (!schedule.startDate || schedule.startDate >= todayStr) return 0;
  if (!schedule.frequency || schedule.frequency === "manual") return 0;

  let count = 0;
  let current = parseUTCDate(schedule.startDate);

  // Walk forward through all due dates until we reach today
  for (let i = 0; i < 2_000; i++) {
    const currentStr = toISODate(current);
    if (currentStr >= todayStr) break; // Reached today or future — stop
    count++;

    // Find next due date after this one
    const next = computeNextDueDate(schedule, addUTCDays(current, 1));
    if (!next) break;
    const nextStr = toISODate(next);
    if (nextStr <= currentStr) break; // Safety: prevent infinite loop
    current = next;
  }

  return count;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse a yyyy-MM-dd string as UTC midnight.
 * Server-side comparisons are always UTC to avoid host-timezone drift.
 */
function parseUTCDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

/** Create a new Date that is `days` UTC days from `d` */
function addUTCDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

/**
 * Create a UTC date for year/month/day (month is 0-indexed), clamping day to
 * the last valid day of the month to prevent JS date rollover (e.g. Feb 31 → Mar 3).
 */
function safeUTCMonthDate(year: number, month: number, day: number): Date {
  // JS Date.UTC handles month over/underflow by rolling over automatically.
  // To clamp instead, detect rollover and back up to last day of intended month.
  const normalMonth = ((month % 12) + 12) % 12;
  const yearOffset = Math.floor(month / 12);
  const effectiveYear = year + yearOffset;
  const candidate = new Date(Date.UTC(effectiveYear, normalMonth, day));
  if (candidate.getUTCMonth() !== normalMonth) {
    // Day caused rollover: back up to last day of intended month
    return new Date(Date.UTC(effectiveYear, normalMonth + 1, 0));
  }
  return candidate;
}

/** Return the later of two dates (UTC calendar comparison) */
function laterDate(a: Date, b: Date): Date {
  return stripTime(a) >= stripTime(b) ? a : b;
}

/** Advance a periodic date (period = days) until it is >= afterDate, using UTC */
function advanceByDays(start: Date, afterDate: Date, periodDays: number): Date {
  const after = stripTime(afterDate);
  const s = stripTime(start);
  if (s >= after) return s;

  const diffMs = after.getTime() - s.getTime();
  const diffDays = Math.ceil(diffMs / 86_400_000);
  const periods = Math.ceil(diffDays / periodDays);
  return addUTCDays(s, periods * periodDays);
}

/** Advance monthly (same UTC day-of-month as start, or preferredDay) until >= afterDate */
function advanceMonthly(start: Date, afterDate: Date, preferredDay: number | null): Date {
  const dom = preferredDay ?? start.getUTCDate();
  const after = stripTime(afterDate);

  // Try same month first (clamped to valid day)
  const candidate = safeUTCMonthDate(after.getUTCFullYear(), after.getUTCMonth(), dom);
  if (candidate >= after) return candidate;

  // Move to next month
  return safeUTCMonthDate(after.getUTCFullYear(), after.getUTCMonth() + 1, dom);
}

/** Advance twice-monthly: days at preferredDay and preferredDay+15 (capped at 28), UTC */
function advanceTwiceMonthly(start: Date, afterDate: Date, preferredDay: number | null): Date {
  const firstDay = preferredDay ?? start.getUTCDate();
  const secondDay = Math.min(firstDay + 15, 28);
  const after = stripTime(afterDate);

  const c1 = safeUTCMonthDate(after.getUTCFullYear(), after.getUTCMonth(), firstDay);
  const c2 = safeUTCMonthDate(after.getUTCFullYear(), after.getUTCMonth(), secondDay);

  if (c1 >= after) return c1;
  if (c2 >= after) return c2;

  // Neither this month — use next month's first day
  return safeUTCMonthDate(after.getUTCFullYear(), after.getUTCMonth() + 1, firstDay);
}

/** Strip to UTC midnight (calendar day boundary in UTC) */
export function stripTime(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Format a Date as UTC yyyy-MM-dd */
export function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
