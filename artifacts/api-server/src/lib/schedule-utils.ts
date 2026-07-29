/**
 * Utilities for computing contribution schedule due dates.
 */

export interface ScheduleLike {
  startDate: string; // ISO date string yyyy-MM-dd
  frequency: string;
  preferredDay?: number | null;
}

/**
 * Given a schedule, find the next due date that is:
 *  - >= afterDate (defaults to today)
 *  - >= schedule.startDate
 *
 * Returns null for manual/custom frequencies.
 */
export function computeNextDueDate(schedule: ScheduleLike, afterDate: Date = new Date()): Date | null {
  const start = parseLocalDate(schedule.startDate);
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
 * Find the most recent due date that is < afterDate (i.e. a due date that has already passed)
 * and is >= schedule.startDate.
 * Returns null if no due date has passed yet.
 */
export function computePreviousDueDate(schedule: ScheduleLike, afterDate: Date = new Date()): Date | null {
  const start = parseLocalDate(schedule.startDate);
  const next = computeNextDueDate(schedule, afterDate);
  if (!next) return null;

  const { frequency, preferredDay } = schedule;

  let prev: Date;
  if (frequency === "weekly") {
    prev = new Date(next);
    prev.setDate(prev.getDate() - 7);
  } else if (frequency === "biweekly") {
    prev = new Date(next);
    prev.setDate(prev.getDate() - 14);
  } else if (frequency === "monthly") {
    // Step back one month, keeping the same clamped day
    prev = safeMonthDate(next.getFullYear(), next.getMonth() - 1, next.getDate());
  } else if (frequency === "twiceMonthly") {
    const firstDay = preferredDay ?? 1;
    const secondDay = Math.min(firstDay + 15, 28);
    const dom = next.getDate();
    if (dom === secondDay) {
      prev = safeMonthDate(next.getFullYear(), next.getMonth(), firstDay);
    } else {
      // dom === firstDay: step to previous month's secondDay
      prev = safeMonthDate(next.getFullYear(), next.getMonth() - 1, secondDay);
    }
  } else {
    return null;
  }

  // Don't return before schedule start
  return stripTime(prev) >= stripTime(start) ? prev : null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Parse a yyyy-MM-dd string as a local-midnight date */
function parseLocalDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}

/** Return the later of two dates (time-stripped comparison) */
function laterDate(a: Date, b: Date): Date {
  return stripTime(a) >= stripTime(b) ? a : b;
}

/**
 * Create a date for year/month/day, clamping day to the last valid day of
 * the month to prevent JS date rollover (e.g. Feb 31 → Mar 3).
 * month is 0-indexed.
 */
function safeMonthDate(year: number, month: number, day: number): Date {
  // Normalise month overflow/underflow (JS does this automatically for Date constructor)
  const candidate = new Date(year, month, day);
  // If month rolled over, JS moved us to the next month. Clamp by using last day.
  if (candidate.getMonth() !== ((month % 12 + 12) % 12)) {
    // Back up to the last day of the intended month
    return new Date(year, month + 1, 0); // day 0 = last day of previous month
  }
  return candidate;
}

/** Advance a periodic date (period = days) until it is >= afterDate */
function advanceByDays(start: Date, afterDate: Date, periodDays: number): Date {
  const after = stripTime(afterDate);
  const s = stripTime(start);
  if (s >= after) return s;

  const diffMs = after.getTime() - s.getTime();
  const diffDays = Math.ceil(diffMs / 86_400_000);
  const periods = Math.ceil(diffDays / periodDays);
  const next = new Date(s);
  next.setDate(next.getDate() + periods * periodDays);
  return next;
}

/** Advance monthly (same day-of-month as start, or preferredDay) until >= afterDate */
function advanceMonthly(start: Date, afterDate: Date, preferredDay: number | null): Date {
  const dom = preferredDay ?? start.getDate();
  const after = stripTime(afterDate);

  // Try same month first (clamped to valid day)
  const candidate = safeMonthDate(after.getFullYear(), after.getMonth(), dom);
  if (candidate >= after) return candidate;

  // Move to next month
  return safeMonthDate(after.getFullYear(), after.getMonth() + 1, dom);
}

/** Advance twice-monthly: days at preferredDay and preferredDay+15 (capped at 28) */
function advanceTwiceMonthly(start: Date, afterDate: Date, preferredDay: number | null): Date {
  const firstDay = preferredDay ?? start.getDate();
  const secondDay = Math.min(firstDay + 15, 28);
  const after = stripTime(afterDate);

  const c1 = safeMonthDate(after.getFullYear(), after.getMonth(), firstDay);
  const c2 = safeMonthDate(after.getFullYear(), after.getMonth(), secondDay);

  if (c1 >= after) return c1;
  if (c2 >= after) return c2;

  // Neither this month — use next month's first day
  return safeMonthDate(after.getFullYear(), after.getMonth() + 1, firstDay);
}

export function stripTime(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Format a Date as yyyy-MM-dd */
export function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
