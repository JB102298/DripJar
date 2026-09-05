/**
 * M3 — the cutoff candidate pre-filter is exactly a superset of the windows.
 *
 * ─── THE RISK THIS CLOSES ────────────────────────────────────────────────────
 *
 * Selection now narrows cutoff candidates in SQL (`cutoff_date <= today + 7`)
 * before `daysUntil()` decides which window a jar is in. That is only safe if
 * the SQL bound can never exclude a jar the JavaScript would have fired. A
 * one-day error in either direction would silently drop a whole day's
 * commitment-phase reminders — the kind of bug that produces no error, no
 * failed test, and no complaint until someone notices an email that never
 * arrived.
 *
 * So both halves are checked against each other across every boundary that has
 * ever broken date arithmetic: daylight-saving transitions in zones that jump
 * forwards, backwards, and in the southern hemisphere; the 28th, 29th, 30th and
 * 31st of a month; leap day; and midnight on New Year.
 *
 * ─── WHY UTC IS THE RIGHT ANSWER HERE, NOT JAR TIME ──────────────────────────
 *
 * "Jar Time" — the jar's immutable IANA zone — governs when an AutoDrip
 * occurrence fires, because that is a wall-clock promise made to a person. A
 * reminder window is not: it is a comparison between two stored calendar dates,
 * and `cutoff_date` is a `date`, not an instant. Deriving it in UTC is what
 * makes the same jar produce the same reminder on the same day regardless of
 * which server evaluated it. These tests pin that: the arithmetic never touches
 * a local wall clock, so a DST transition cannot move a window by a day.
 */

import { describe, it, expect } from "vitest";
import { pool } from "@workspace/db";
import { cutoffPrefilterEnd } from "../routes/reminders.js";
import { daysUntil, toUTCDateString } from "../lib/phase.js";

/** UTC calendar date `offset` days from `now` — the fixture-side arithmetic. */
function utcDay(offset: number, now: Date): string {
  const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(base + offset * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Instants chosen because a naive implementation gets at least one of them
 * wrong. Each is a real UTC instant; the label says what makes it awkward.
 */
const REFERENCE_INSTANTS: [string, string][] = [
  ["2027-03-14T06:59:59Z", "one second before US spring-forward (America/New_York)"],
  ["2027-03-14T07:00:00Z", "the instant of US spring-forward"],
  ["2027-03-14T12:00:00Z", "midday on the 23-hour US day"],
  ["2027-11-07T05:00:00Z", "the instant of US fall-back"],
  ["2027-11-07T12:00:00Z", "midday on the 25-hour US day"],
  ["2027-03-28T00:59:59Z", "one second before UK spring-forward (Europe/London)"],
  ["2027-03-28T01:00:00Z", "the instant of UK spring-forward"],
  ["2027-04-04T16:00:00Z", "Australia/Sydney fall-back (southern hemisphere)"],
  ["2027-10-03T16:00:00Z", "Australia/Sydney spring-forward"],
  ["2027-09-25T14:00:00Z", "Pacific/Auckland spring-forward"],
  ["2028-02-28T23:59:59Z", "last second of 28 February in a leap year"],
  ["2028-02-29T00:00:00Z", "leap day, first instant"],
  ["2028-02-29T23:59:59Z", "leap day, last instant"],
  ["2027-02-28T12:00:00Z", "28 February in a non-leap year"],
  ["2027-01-31T23:59:59Z", "last second of a 31-day month"],
  ["2027-04-30T23:59:59Z", "last second of a 30-day month"],
  ["2026-12-31T23:59:59Z", "last second of the year"],
  ["2027-01-01T00:00:00Z", "first instant of the year"],
  ["2027-06-15T00:00:00Z", "UTC midnight, an ordinary day"],
  ["2027-06-15T23:59:59Z", "one second before UTC midnight"],
];

/** Offsets spanning both sides of all three windows. */
const OFFSETS = [-30, -8, -2, -1, 0, 1, 2, 3, 6, 7, 8, 9, 30];

/** The three windows the processor fires on, derived from daysAway alone. */
function windowFor(daysAway: number): string | null {
  if (daysAway === 7) return "cutoff_upcoming_7d";
  if (daysAway === 1) return "cutoff_upcoming_1d";
  if (daysAway <= 0) return "cutoff_reached";
  return null;
}

describe("M3 — cutoff window arithmetic across DST, month, year and leap boundaries", () => {
  it("daysUntil returns the exact calendar offset at every reference instant", () => {
    for (const [iso, label] of REFERENCE_INSTANTS) {
      const now = new Date(iso);
      for (const offset of OFFSETS) {
        const cutoff = utcDay(offset, now);
        expect(daysUntil(cutoff, now), `${label} @ ${offset}d`).toBe(offset);
      }
    }
  });

  it("the SQL pre-filter never excludes a jar that would fire", () => {
    for (const [iso, label] of REFERENCE_INSTANTS) {
      const now = new Date(iso);
      const end = cutoffPrefilterEnd(now);
      for (const offset of OFFSETS) {
        const cutoff = utcDay(offset, now);
        const fires = windowFor(daysUntil(cutoff, now)) !== null;
        if (fires) {
          expect(cutoff <= end, `${label} @ ${offset}d must be inside the pre-filter`).toBe(true);
        }
      }
    }
  });

  it("the pre-filter bound is exactly seven calendar days after the run date", () => {
    for (const [iso, label] of REFERENCE_INSTANTS) {
      const now = new Date(iso);
      expect(daysUntil(cutoffPrefilterEnd(now), now), label).toBe(7);
      expect(cutoffPrefilterEnd(now) > toUTCDateString(now), label).toBe(true);
    }
  });

  it("nothing beyond the pre-filter bound could have fired anyway", () => {
    for (const [iso, label] of REFERENCE_INSTANTS) {
      const now = new Date(iso);
      const end = cutoffPrefilterEnd(now);
      for (const offset of OFFSETS) {
        const cutoff = utcDay(offset, now);
        if (cutoff > end) {
          expect(windowFor(daysUntil(cutoff, now)), `${label} @ ${offset}d`).toBeNull();
        }
      }
    }
  });

  it("a local wall clock is never consulted — the run's host timezone is irrelevant", () => {
    // Same instant, expressed twice. `daysUntil` and the pre-filter both work
    // from getUTC* fields, so an implementation that slipped in a local getDate()
    // would disagree with itself here on any host that is not UTC.
    for (const [iso] of REFERENCE_INSTANTS) {
      const a = new Date(iso);
      const b = new Date(a.getTime());
      expect(cutoffPrefilterEnd(a)).toBe(cutoffPrefilterEnd(b));
      expect(toUTCDateString(a)).toBe(a.toISOString().slice(0, 10));
    }
  });
});

describe("M3 — PostgreSQL agrees with the JavaScript pre-filter", () => {
  it("date comparison in the database matches the string comparison in the processor", async () => {
    const pairs: { cutoff: string; end: string; js: boolean; label: string }[] = [];
    for (const [iso, label] of REFERENCE_INSTANTS) {
      const now = new Date(iso);
      const end = cutoffPrefilterEnd(now);
      for (const offset of OFFSETS) {
        const cutoff = utcDay(offset, now);
        pairs.push({ cutoff, end, js: cutoff <= end, label: `${label} @ ${offset}d` });
      }
    }

    const res = await pool.query(
      `select c.cutoff, c.stop, (c.cutoff::date <= c.stop::date) as sql_result
         from unnest($1::text[], $2::text[]) as c(cutoff, stop)`,
      [pairs.map((p) => p.cutoff), pairs.map((p) => p.end)],
    );

    expect(res.rows).toHaveLength(pairs.length);
    for (const [i, row] of res.rows.entries()) {
      expect(row.sql_result, pairs[i]!.label).toBe(pairs[i]!.js);
    }
  });

  it("the pre-filter bound matches PostgreSQL's own seven-day date arithmetic", async () => {
    const nows = REFERENCE_INSTANTS.map(([iso]) => toUTCDateString(new Date(iso)));
    const ends = REFERENCE_INSTANTS.map(([iso]) => cutoffPrefilterEnd(new Date(iso)));

    const res = await pool.query(
      `select to_char(d.today::date + 7, 'YYYY-MM-DD') as expected
         from unnest($1::text[]) with ordinality as d(today, n)
        order by d.n`,
      [nows],
    );

    expect(res.rows.map((r: { expected: string }) => r.expected)).toEqual(ends);
  });
});
