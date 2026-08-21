/**
 * Target-date precision normalisation.
 *
 * `jars.target_date` is a real `date` at every precision. A coarse answer is
 * stored as the START of the period it names — the 1st of the month for
 * `monthYear`, 1 January for `year` — which is what keeps every existing
 * comparison working unchanged: `cutoff_date < target_date`, schedule maths,
 * reminder windows, and days-remaining all operate on a real calendar date and
 * neither know nor care that the day was not chosen by a human.
 *
 * WHY THE SERVER NORMALISES RATHER THAN TRUSTING THE CLIENT
 *
 * The mobile picker already snaps its answer before submitting. That is a
 * convenience, not a guarantee: the API is public to any client, and a request
 * carrying `targetDate: 2044-07-19` with `targetDatePrecision: year` would
 * otherwise store a day that no surface will ever display and that no organizer
 * ever chose — the value would then silently drive schedule pacing and
 * days-remaining from a date the user cannot see. Normalising on write makes
 * the stored row self-consistent regardless of what sent it.
 *
 * All arithmetic here is on the date STRING, deliberately. Routing a
 * `yyyy-MM-dd` through `new Date()` parses it as UTC midnight, which is the
 * previous day in every timezone west of Greenwich — the exact off-by-one this
 * codebase has had to guard against by hand elsewhere. String slicing has no
 * timezone at all.
 */

import type { TargetDatePrecision } from "./validation.js";

/**
 * Snap a `yyyy-MM-dd` string to the first day of the period its precision
 * names. `exact` is returned unchanged.
 *
 * Input that is not a well-formed `yyyy-MM-dd` is returned untouched: this
 * function's job is normalisation, not validation, and the create/update
 * handlers reject malformed dates on their own terms.
 */
export function normalizeTargetDate(
  targetDate: string,
  precision: TargetDatePrecision,
): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) return targetDate;

  switch (precision) {
    case "year":
      return `${targetDate.slice(0, 4)}-01-01`;
    case "monthYear":
      return `${targetDate.slice(0, 7)}-01`;
    case "exact":
    default:
      return targetDate;
  }
}
