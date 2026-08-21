/**
 * Date precision model.
 *
 * A jar's dates are stored as `YYYY-MM-DD` strings and always will be — the
 * `jars` table has no precision column and this pass does not add one. But a
 * stored day is not the same as a *known* day. "We're saving for a house
 * sometime in 2031" and "the cruise leaves on 14 March 2027" are both written
 * to the same column, and rendering the first one as "January 1, 2031" invents
 * a precision the organizer never claimed.
 *
 * So precision is a property of the *question being asked*, not of the storage:
 *
 *   exact      — a specific calendar day is known (a cruise departure)
 *   monthYear  — the month is known, the day is not (a wedding being planned)
 *   year       — only the year is meaningful (an 18-year college fund)
 *
 * Coarser precisions normalise to the first day of the period, so the stored
 * value stays a valid `YYYY-MM-DD` that every existing server-side comparison
 * (`cutoffDate < targetDate`, schedule maths, reminder windows) keeps working
 * on unchanged. Only the label the user reads is coarsened.
 *
 * KNOWN GAP: because precision is not persisted, screens outside the create
 * flow re-render a coarse date at day precision. Closing that needs a
 * `target_date_precision` column and a migration. See the pass notes.
 *
 * All parsing and formatting is done in LOCAL time at noon. Parsing
 * `new Date("2031-03-14")` yields UTC midnight, which is the previous day in
 * every timezone west of Greenwich — the off-by-one that the create flow
 * already guards against by hand in several places.
 */

export type DatePrecision = 'exact' | 'monthYear' | 'year';

/** Coarse → fine, for rendering selectors in a stable order. */
export const DATE_PRECISIONS: readonly DatePrecision[] = ['exact', 'monthYear', 'year'] as const;

/**
 * Coerce a precision value from the API to one this build understands.
 *
 * Always returns a precision, never undefined. `exact` is the fallback for
 * missing, null, or unrecognised values — which is the safe direction: it is
 * what every jar created before the column existed was implicitly asserting,
 * and what an older server that does not send the field is describing. The
 * mirror of `resolveCategory` in lib/jar-categories.ts, and for the same
 * reason: a screen must always have something renderable.
 */
export function resolvePrecision(value: string | null | undefined): DatePrecision {
  return (DATE_PRECISIONS as readonly string[]).includes(value ?? '')
    ? (value as DatePrecision)
    : 'exact';
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

const MONTH_NAMES_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

export const MONTH_LABELS: readonly string[] = MONTH_NAMES;
export const MONTH_LABELS_SHORT: readonly string[] = MONTH_NAMES_SHORT;

/**
 * Parse a stored `YYYY-MM-DD` into a local Date at noon.
 *
 * Returns `undefined` for anything that is not a well-formed date string rather
 * than an `Invalid Date`, so callers get one falsy case to handle instead of
 * two. Legacy rows and hand-edited data do reach this.
 */
export function parseLocalISO(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const date = new Date(year, month - 1, day, 12, 0, 0, 0);
  // Reject dates that rolled over (e.g. 2027-02-31 → 3 March).
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return undefined;
  }
  return date;
}

/** Serialise a Date to `YYYY-MM-DD` using its LOCAL calendar day. */
export function toLocalISO(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Snap a date to the first day of the period its precision names.
 *
 * `monthYear` → the 1st of that month. `year` → 1 January. `exact` → unchanged.
 * This is what makes the stored string honest: a year-precision answer is
 * stored as the start of that year, not as whatever day the picker happened to
 * be showing when the user tapped it.
 */
export function normalizeToPrecision(date: Date, precision: DatePrecision): Date {
  switch (precision) {
    case 'year':
      return new Date(date.getFullYear(), 0, 1, 12, 0, 0, 0);
    case 'monthYear':
      return new Date(date.getFullYear(), date.getMonth(), 1, 12, 0, 0, 0);
    case 'exact':
    default:
      return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0, 0);
  }
}

/** `normalizeToPrecision` applied to a stored string, returning a stored string. */
export function normalizeISOToPrecision(
  value: string,
  precision: DatePrecision,
): string | undefined {
  const parsed = parseLocalISO(value);
  if (!parsed) return undefined;
  return toLocalISO(normalizeToPrecision(parsed, precision));
}

/**
 * Render a date at the precision it was actually chosen with.
 *
 * This is the whole point of the model: `year` precision must never render a
 * month or a day, and `monthYear` must never render a day, because the user
 * never supplied them.
 */
export function formatForPrecision(date: Date, precision: DatePrecision): string {
  switch (precision) {
    case 'year':
      return String(date.getFullYear());
    case 'monthYear':
      return `${MONTH_NAMES[date.getMonth()]} ${date.getFullYear()}`;
    case 'exact':
    default:
      return `${MONTH_NAMES[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
  }
}

/** `formatForPrecision` over a stored string; empty string when unparseable. */
export function formatISOForPrecision(
  value: string | null | undefined,
  precision: DatePrecision,
): string {
  const parsed = parseLocalISO(value);
  if (!parsed) return '';
  return formatForPrecision(parsed, precision);
}

/**
 * How much time is left, phrased at the precision the target was given.
 *
 * A day countdown is an assertion about a day. "6,570 days left" against a
 * college fund whose target is only known to the year reads as though someone
 * chose 1 January 2044 — and it will tick down by one every midnight, which
 * makes the false precision look actively maintained. So a day count is offered
 * only for `exact` targets; coarser ones name the period instead.
 *
 * Returns null when there is nothing meaningful to say (no target, or a
 * missing day count on an exact target), so callers can omit the chip entirely
 * rather than render a placeholder.
 */
export function describeTimeRemaining(
  targetDate: string | null | undefined,
  precision: DatePrecision,
  daysRemaining: number | null | undefined,
): string | null {
  if (precision === 'exact') {
    if (daysRemaining === null || daysRemaining === undefined) return null;
    return `${daysRemaining.toLocaleString('en-US')} ${daysRemaining === 1 ? 'day' : 'days'} left`;
  }
  const label = formatISOForPrecision(targetDate, precision);
  return label ? `by ${label}` : null;
}

/** Short human label for a precision, used on the precision selector. */
export function precisionLabel(precision: DatePrecision): string {
  switch (precision) {
    case 'year':
      return 'Year';
    case 'monthYear':
      return 'Month';
    case 'exact':
    default:
      return 'Exact day';
  }
}

/**
 * One-line explanation of what a precision commits the organizer to. Shown
 * under the selector so "Year" does not read as a downgrade.
 */
export function precisionHelp(precision: DatePrecision): string {
  switch (precision) {
    case 'year':
      return 'Pick a year. Good for long-horizon goals where the exact date is years away.';
    case 'monthYear':
      return 'Pick a month and year. Good when the month is settled but the day is not.';
    case 'exact':
    default:
      return 'Pick an exact day.';
  }
}

/**
 * Year range the picker offers, sized to the goal rather than to a fixed
 * window.
 *
 * A newborn's college fund is an eighteen-year goal, and a picker that stops at
 * "five years out" cannot express it — the organizer's only recourse is 200
 * taps on a month arrow. The default horizon is deliberately generous;
 * `anchorYear` widens it further when an existing value already sits outside.
 */
export const DEFAULT_YEAR_HORIZON = 30;

export function yearRange(
  today: Date,
  anchorYear?: number,
  horizon: number = DEFAULT_YEAR_HORIZON,
): { minYear: number; maxYear: number } {
  const current = today.getFullYear();
  let minYear = current;
  let maxYear = current + horizon;
  if (anchorYear !== undefined) {
    if (anchorYear < minYear) minYear = anchorYear;
    if (anchorYear > maxYear) maxYear = anchorYear;
  }
  return { minYear, maxYear };
}
