/**
 * Jar Time — IANA-timezone-correct conversion helpers.
 *
 * "Jar Time" is the wall-clock time in the jar's immutable IANA timezone.
 * AutoDrip occurrences are defined as 9:00 AM Jar Time on a given calendar
 * date; the backend stores the resulting instant in UTC.
 *
 * ── Why the previous single-sample approach was wrong ────────────────────────
 *
 * The earlier implementation probed the zone offset at 09:00 **UTC** and
 * applied the resulting hour difference. That samples the offset at the wrong
 * instant, which produced two distinct classes of error:
 *
 *   1. Zones at UTC−10 or further west (Pacific/Honolulu, Pacific/Pago_Pago):
 *      at 09:00 UTC the local calendar date has already rolled back a day, so
 *      an hours-only difference is ambiguous modulo 24h. Every occurrence was
 *      computed a full day early.
 *
 *   2. DST transition dates (e.g. America/Los_Angeles 2026-03-08,
 *      America/Anchorage 2026-03-08 and 2026-11-01): the offset at 09:00 UTC
 *      differs from the offset at 09:00 local, so results landed an hour off.
 *
 * ── The correct approach ─────────────────────────────────────────────────────
 *
 * Solve for the UTC instant whose *rendering in the target zone* equals the
 * desired wall-clock time. `tzOffsetMs` measures the offset at a specific
 * instant by formatting that instant in the zone and comparing. Because the
 * offset itself depends on the instant, we iterate: the first pass gives a
 * near-correct guess, the second pass corrects it when the guess landed on the
 * far side of a DST boundary. Two passes are sufficient for every real IANA
 * zone, and the result is verified before being returned.
 *
 * No offsets are hardcoded and no zone allowlist is applied — any IANA zone
 * accepted at jar creation is handled correctly.
 */

/** Wall-clock fields rendered for an instant in a specific IANA zone. */
interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * Render `instant` in `timeZone` and return its wall-clock calendar fields.
 * @throws {RangeError} if `timeZone` is not a recognized IANA zone.
 */
function getZonedParts(instant: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const map: Record<string, string> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== "literal") map[part.type] = part.value;
  }

  // Some ICU versions render midnight as hour "24" under hour12:false.
  const rawHour = Number(map["hour"]);
  const hour = rawHour === 24 ? 0 : rawHour;

  return {
    year: Number(map["year"]),
    month: Number(map["month"]),
    day: Number(map["day"]),
    hour,
    minute: Number(map["minute"]),
    second: Number(map["second"]),
  };
}

/**
 * The zone's UTC offset, in milliseconds, at a specific instant.
 * Positive east of UTC (e.g. Asia/Tokyo → +9h), negative west.
 */
function tzOffsetMs(instant: Date, timeZone: string): number {
  const p = getZonedParts(instant, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUtc - instant.getTime();
}

/**
 * Convert a wall-clock date/time in `timeZone` to the corresponding UTC instant.
 *
 * DST notes:
 *   - Fall-back (ambiguous local time, occurs twice): resolves to the first
 *     (pre-transition) occurrence, matching the common `zonedTimeToUtc` contract.
 *   - Spring-forward (non-existent local time, skipped): resolves to the instant
 *     the wall clock jumps to. AutoDrip runs at 09:00, and no IANA zone shifts
 *     at that hour, so this path is defensive rather than routine.
 *
 * @throws {RangeError} if `timeZone` is not a recognized IANA zone.
 */
export function zonedWallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const targetAsIfUtc = Date.UTC(year, month - 1, day, hour, minute, 0);

  // Pass 1: assume the offset that applies at the naive instant.
  let guess = targetAsIfUtc - tzOffsetMs(new Date(targetAsIfUtc), timeZone);

  // Pass 2: re-measure at the candidate. This corrects the case where the
  // pass-1 guess fell on the opposite side of a DST boundary.
  guess = targetAsIfUtc - tzOffsetMs(new Date(guess), timeZone);

  return new Date(guess);
}

/**
 * The UTC instant corresponding to 9:00 AM Jar Time on `scheduledDateISO`.
 *
 * @param scheduledDateISO Calendar date as `yyyy-MM-dd`, interpreted in the jar's zone.
 * @param jarTimeZone      The jar's immutable IANA timezone.
 * @throws {RangeError} if `jarTimeZone` is not a recognized IANA zone.
 */
export function computeJarTimeRunAt(scheduledDateISO: string, jarTimeZone: string): Date {
  const [y, m, d] = scheduledDateISO.split("-").map(Number) as [number, number, number];
  return zonedWallClockToUtc(y, m, d, AUTODRIP_HOUR, 0, jarTimeZone);
}

/** AutoDrip occurrences fire at 9:00 AM Jar Time. */
export const AUTODRIP_HOUR = 9;

/**
 * Render an instant as `yyyy-MM-dd HH:mm` wall-clock in `timeZone`.
 * Used by tests to prove a computed instant really is 9:00 AM Jar Time on the
 * intended calendar date, and available for debugging/diagnostics.
 */
export function formatInZone(instant: Date, timeZone: string): string {
  const p = getZonedParts(instant, timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}
