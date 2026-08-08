/**
 * Jar Time conversion tests (DJ-002).
 *
 * AutoDrip occurrences are defined as 9:00 AM Jar Time on a calendar date, and
 * the backend stores the resulting instant in UTC. These tests assert the
 * round-trip property directly: rendering the computed UTC instant back in the
 * jar's timezone must yield exactly the intended date at 09:00.
 *
 * The previous implementation sampled the zone offset at 09:00 UTC and applied
 * an hours-only difference. That failed in two ways, both covered below:
 *
 *   - Zones at UTC−10 or further west (Pacific/Honolulu, Pacific/Pago_Pago)
 *     were a full day early on every occurrence, because at 09:00 UTC the local
 *     date has already rolled back and an hour difference is ambiguous mod 24h.
 *   - DST transition dates were an hour off, because the offset at 09:00 UTC
 *     differs from the offset at 09:00 local on those days.
 *
 * Verification deliberately uses its own Intl.DateTimeFormat rather than the
 * module's formatInZone helper, so a defect in that helper cannot mask a defect
 * in the conversion.
 */

import { describe, it, expect } from "vitest";
import {
  computeJarTimeRunAt,
  zonedWallClockToUtc,
  formatInZone,
  AUTODRIP_HOUR,
} from "../lib/jar-time.js";

// ─── Independent verifier ─────────────────────────────────────────────────────

/** Render an instant in `tz` as `yyyy-MM-dd HH:mm`, independently of the module. */
function renderInZone(instant: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(instant);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")} ${hour}:${get("minute")}`;
}

// ─── Coverage table ───────────────────────────────────────────────────────────

interface ZoneCase {
  tz: string;
  /** Dates that must resolve to 09:00 local. Includes DST boundaries per zone. */
  dates: string[];
  note: string;
}

// 2026 DST boundaries:
//   US zones            — starts Mar 8,  ends Nov 1
//   Europe/London       — starts Mar 29, ends Oct 25
//   Pacific/Auckland    — ends Apr 5,    starts Sep 27  (southern hemisphere)
const ZONE_CASES: ZoneCase[] = [
  {
    tz: "America/New_York",
    dates: ["2026-01-15", "2026-07-15", "2026-03-08", "2026-03-09", "2026-11-01", "2026-11-02"],
    note: "UTC-5/-4, US DST both boundaries",
  },
  {
    tz: "America/Chicago",
    dates: ["2026-01-15", "2026-07-15", "2026-03-08", "2026-11-01"],
    note: "UTC-6/-5",
  },
  {
    tz: "America/Denver",
    dates: ["2026-01-15", "2026-07-15", "2026-03-08", "2026-11-01"],
    note: "UTC-7/-6",
  },
  {
    tz: "America/Los_Angeles",
    dates: ["2026-01-15", "2026-07-15", "2026-03-08", "2026-03-09", "2026-11-01", "2026-11-02"],
    note: "UTC-8/-7 — regression: was 10:00 on 2026-03-08",
  },
  {
    tz: "America/Anchorage",
    dates: ["2026-01-15", "2026-07-15", "2026-03-08", "2026-11-01"],
    note: "UTC-9/-8 — regression: was 10:00 (Mar) and 08:00 (Nov)",
  },
  {
    tz: "Pacific/Honolulu",
    dates: ["2026-01-15", "2026-07-15", "2026-03-08", "2026-11-01", "2026-12-31"],
    note: "UTC-10, no DST — regression: every date was one day early",
  },
  {
    tz: "Pacific/Pago_Pago",
    dates: ["2026-01-15", "2026-07-15", "2026-03-08", "2026-11-01", "2026-12-31"],
    note: "UTC-11, no DST — regression: every date was one day early",
  },
  {
    tz: "Europe/London",
    dates: ["2026-01-15", "2026-07-15", "2026-03-29", "2026-03-30", "2026-10-25", "2026-10-26"],
    note: "UTC+0/+1, BST both boundaries",
  },
  {
    tz: "Asia/Tokyo",
    dates: ["2026-01-15", "2026-07-15", "2026-12-31"],
    note: "UTC+9, no DST",
  },
  {
    tz: "Pacific/Auckland",
    dates: ["2026-01-15", "2026-07-15", "2026-04-05", "2026-04-06", "2026-09-27", "2026-09-28"],
    note: "UTC+12/+13, southern-hemisphere DST both boundaries",
  },
];

describe("computeJarTimeRunAt — resolves to 9:00 AM Jar Time", () => {
  for (const { tz, dates, note } of ZONE_CASES) {
    describe(`${tz} (${note})`, () => {
      for (const date of dates) {
        it(`${date} → 09:00 local`, () => {
          const instant = computeJarTimeRunAt(date, tz);

          expect(Number.isNaN(instant.getTime())).toBe(false);
          // The single assertion that matters: the stored UTC instant renders
          // as exactly 09:00 on the intended calendar date in the jar's zone.
          expect(renderInZone(instant, tz)).toBe(`${date} 09:00`);
        });
      }
    });
  }
});

describe("computeJarTimeRunAt — explicit regressions", () => {
  it("Pacific/Honolulu is not a day early (was 2026-01-14)", () => {
    const instant = computeJarTimeRunAt("2026-01-15", "Pacific/Honolulu");
    expect(renderInZone(instant, "Pacific/Honolulu")).toBe("2026-01-15 09:00");
    // UTC-10 with no DST: 09:00 local is 19:00 UTC the same day.
    expect(instant.toISOString()).toBe("2026-01-15T19:00:00.000Z");
  });

  it("Pacific/Pago_Pago is not a day early (was 2026-07-14)", () => {
    const instant = computeJarTimeRunAt("2026-07-15", "Pacific/Pago_Pago");
    expect(renderInZone(instant, "Pacific/Pago_Pago")).toBe("2026-07-15 09:00");
    // UTC-11: 09:00 local is 20:00 UTC the same day.
    expect(instant.toISOString()).toBe("2026-07-15T20:00:00.000Z");
  });

  it("America/Los_Angeles spring-forward is not an hour late (was 10:00)", () => {
    const instant = computeJarTimeRunAt("2026-03-08", "America/Los_Angeles");
    expect(renderInZone(instant, "America/Los_Angeles")).toBe("2026-03-08 09:00");
    // PDT (UTC-7) is already in effect at 09:00 on the transition date.
    expect(instant.toISOString()).toBe("2026-03-08T16:00:00.000Z");
  });

  it("America/Anchorage fall-back is not an hour early (was 08:00)", () => {
    const instant = computeJarTimeRunAt("2026-11-01", "America/Anchorage");
    expect(renderInZone(instant, "America/Anchorage")).toBe("2026-11-01 09:00");
    // AKST (UTC-9) is in effect by 09:00 on the fall-back date.
    expect(instant.toISOString()).toBe("2026-11-01T18:00:00.000Z");
  });
});

describe("computeJarTimeRunAt — offset direction sanity", () => {
  it("east-of-UTC zones resolve earlier in UTC than west-of-UTC zones", () => {
    const tokyo = computeJarTimeRunAt("2026-06-15", "Asia/Tokyo");
    const newYork = computeJarTimeRunAt("2026-06-15", "America/New_York");
    const honolulu = computeJarTimeRunAt("2026-06-15", "Pacific/Honolulu");

    expect(tokyo.getTime()).toBeLessThan(newYork.getTime());
    expect(newYork.getTime()).toBeLessThan(honolulu.getTime());
  });

  it("UTC itself is exactly 09:00Z", () => {
    expect(computeJarTimeRunAt("2026-06-15", "UTC").toISOString()).toBe(
      "2026-06-15T09:00:00.000Z",
    );
  });
});

describe("zonedWallClockToUtc — sub-hour offset zones", () => {
  // These zones have offsets that are not whole hours, which an
  // hours-only difference calculation cannot represent at all.
  const cases: Array<[string, string]> = [
    ["Asia/Kolkata", "2026-06-15"],       // UTC+5:30
    ["Australia/Adelaide", "2026-06-15"], // UTC+9:30
    ["Pacific/Chatham", "2026-06-15"],    // UTC+12:45
    ["Asia/Kathmandu", "2026-06-15"],     // UTC+5:45
  ];

  for (const [tz, date] of cases) {
    it(`${tz} resolves to 09:00 local`, () => {
      const [y, m, d] = date.split("-").map(Number) as [number, number, number];
      const instant = zonedWallClockToUtc(y, m, d, AUTODRIP_HOUR, 0, tz);
      expect(renderInZone(instant, tz)).toBe(`${date} 09:00`);
    });
  }

  it("honours a non-zero minute argument", () => {
    const instant = zonedWallClockToUtc(2026, 6, 15, 14, 30, "America/New_York");
    expect(renderInZone(instant, "America/New_York")).toBe("2026-06-15 14:30");
  });
});

describe("jar-time helpers", () => {
  it("AUTODRIP_HOUR is 9", () => {
    expect(AUTODRIP_HOUR).toBe(9);
  });

  it("formatInZone agrees with an independent formatter", () => {
    const instant = computeJarTimeRunAt("2026-03-08", "America/Los_Angeles");
    expect(formatInZone(instant, "America/Los_Angeles")).toBe(
      renderInZone(instant, "America/Los_Angeles"),
    );
  });

  it("rejects an invalid IANA zone rather than silently defaulting", () => {
    expect(() => computeJarTimeRunAt("2026-06-15", "Not/AZone")).toThrow(RangeError);
  });
});
