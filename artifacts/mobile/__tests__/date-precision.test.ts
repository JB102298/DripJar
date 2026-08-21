/**
 * Date precision model — Owner QA item 8.
 *
 * Three properties are worth pinning.
 *
 * 1. Coarse precisions must never render a day. A jar whose target is "sometime
 *    in 2044" stores 2044-01-01, and displaying that as "January 1, 2044"
 *    invents a precision the organizer never claimed.
 *
 * 2. Everything stays in local time. `new Date("2044-03-14")` is UTC midnight,
 *    which is 13 March in every timezone west of Greenwich — the create flow
 *    previously hand-guarded this in four separate places and got it wrong on
 *    the review screen.
 *
 * 3. The year range must reach a newborn's college fund. An eighteen-year
 *    horizon was not merely inconvenient in the old picker, it was unreachable.
 */
import { describe, it, expect } from "vitest";
import {
  describeTimeRemaining,
  resolvePrecision,
  DATE_PRECISIONS,
  DEFAULT_YEAR_HORIZON,
  formatForPrecision,
  formatISOForPrecision,
  normalizeISOToPrecision,
  normalizeToPrecision,
  parseLocalISO,
  precisionHelp,
  precisionLabel,
  toLocalISO,
  yearRange,
} from "../lib/date-precision";

describe("parseLocalISO", () => {
  it("parses to the local calendar day, not UTC midnight", () => {
    const parsed = parseLocalISO("2044-03-14")!;
    expect(parsed.getFullYear()).toBe(2044);
    expect(parsed.getMonth()).toBe(2);
    expect(parsed.getDate()).toBe(14);
  });

  it("round-trips through toLocalISO", () => {
    for (const iso of ["2026-01-01", "2027-12-31", "2044-03-14", "2028-02-29"]) {
      expect(toLocalISO(parseLocalISO(iso)!)).toBe(iso);
    }
  });

  it("returns undefined rather than an Invalid Date", () => {
    // Legacy rows and hand-edited data do reach this. One falsy case to handle
    // is better than a Date that silently poisons every comparison.
    for (const bad of [null, undefined, "", "not-a-date", "2044-13-01", "2044-3-4", "2044/03/14"]) {
      expect(parseLocalISO(bad)).toBeUndefined();
    }
  });

  it("rejects a day that does not exist in that month", () => {
    // Date() would roll 31 February forward to 3 March and report success.
    expect(parseLocalISO("2027-02-31")).toBeUndefined();
    expect(parseLocalISO("2027-02-28")).toBeDefined();
  });
});

describe("normalizeToPrecision", () => {
  const date = new Date(2044, 2, 14, 12); // 14 March 2044

  it("leaves an exact day alone", () => {
    expect(toLocalISO(normalizeToPrecision(date, "exact"))).toBe("2044-03-14");
  });

  it("snaps monthYear to the 1st of the month", () => {
    expect(toLocalISO(normalizeToPrecision(date, "monthYear"))).toBe("2044-03-01");
  });

  it("snaps year to 1 January", () => {
    expect(toLocalISO(normalizeToPrecision(date, "year"))).toBe("2044-01-01");
  });

  it("is idempotent", () => {
    for (const precision of DATE_PRECISIONS) {
      const once = normalizeToPrecision(date, precision);
      const twice = normalizeToPrecision(once, precision);
      expect(toLocalISO(twice)).toBe(toLocalISO(once));
    }
  });

  it("keeps producing a valid YYYY-MM-DD string", () => {
    // The stored value still has to satisfy every existing server-side date
    // comparison — cutoff < target, schedule maths, reminder windows.
    for (const precision of DATE_PRECISIONS) {
      expect(normalizeISOToPrecision("2044-03-14", precision)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe("formatForPrecision", () => {
  const date = new Date(2044, 2, 14, 12);

  it("renders an exact day in full", () => {
    expect(formatForPrecision(date, "exact")).toBe("March 14, 2044");
  });

  it("renders monthYear without a day", () => {
    expect(formatForPrecision(date, "monthYear")).toBe("March 2044");
  });

  it("renders year alone", () => {
    expect(formatForPrecision(date, "year")).toBe("2044");
  });

  it("never shows a day the organizer did not choose", () => {
    // The whole point: 2044-01-01 chosen at year precision reads "2044", not
    // "January 1, 2044".
    expect(formatISOForPrecision("2044-01-01", "year")).toBe("2044");
    expect(formatISOForPrecision("2044-01-01", "year")).not.toMatch(/\b1\b/);
    expect(formatISOForPrecision("2044-03-01", "monthYear")).toBe("March 2044");
    expect(formatISOForPrecision("2044-03-01", "monthYear")).not.toMatch(/\b1,/);
  });

  it("renders the stored day, not the UTC-shifted one", () => {
    // `new Date("2044-03-14").toLocaleDateString()` yields 13 March in US
    // timezones. This is the bug the review screen shipped with.
    expect(formatISOForPrecision("2044-03-14", "exact")).toBe("March 14, 2044");
  });

  it("returns an empty string for unparseable input rather than 'Invalid Date'", () => {
    expect(formatISOForPrecision(null, "exact")).toBe("");
    expect(formatISOForPrecision("nonsense", "exact")).toBe("");
  });
});

describe("precision labels", () => {
  it("labels and explains every precision", () => {
    for (const precision of DATE_PRECISIONS) {
      expect(precisionLabel(precision).trim()).not.toBe("");
      expect(precisionHelp(precision).trim()).not.toBe("");
    }
  });
});

describe("yearRange — long-horizon goals", () => {
  const today = new Date(2026, 7, 18); // 18 August 2026

  it("reaches an eighteen-year college fund", () => {
    const { minYear, maxYear } = yearRange(today);
    expect(minYear).toBe(2026);
    expect(maxYear).toBeGreaterThanOrEqual(2026 + 18);
  });

  it("defaults to a generous horizon", () => {
    expect(DEFAULT_YEAR_HORIZON).toBeGreaterThanOrEqual(18);
    expect(yearRange(today).maxYear).toBe(2026 + DEFAULT_YEAR_HORIZON);
  });

  it("widens to include a value already outside the window", () => {
    // Editing a jar whose target is further out than the default horizon must
    // not present a picker that cannot show its own current value.
    expect(yearRange(today, 2099).maxYear).toBe(2099);
    expect(yearRange(today, 2001).minYear).toBe(2001);
  });

  it("does not shrink below the default when the anchor is inside", () => {
    const { minYear, maxYear } = yearRange(today, 2030);
    expect(minYear).toBe(2026);
    expect(maxYear).toBe(2026 + DEFAULT_YEAR_HORIZON);
  });
});

describe("resolvePrecision — tolerant of anything the API sends", () => {
  it("passes through the three known values", () => {
    for (const precision of DATE_PRECISIONS) {
      expect(resolvePrecision(precision)).toBe(precision);
    }
  });

  it("falls back to exact for missing or unknown values", () => {
    // 'exact' is the safe direction: it is what every jar created before the
    // precision column existed was implicitly asserting, and what an older
    // server that omits the field is describing.
    for (const input of [null, undefined, "", "decade", "quarter", "EXACT", "Year"]) {
      expect(resolvePrecision(input)).toBe("exact");
    }
  });
});

describe("describeTimeRemaining", () => {
  it("counts days only for an exact target", () => {
    expect(describeTimeRemaining("2027-06-14", "exact", 42)).toBe("42 days left");
    expect(describeTimeRemaining("2027-06-14", "exact", 1)).toBe("1 day left");
    expect(describeTimeRemaining("2027-06-14", "exact", 0)).toBe("0 days left");
  });

  it("names the period instead of counting days for coarse targets", () => {
    // A day countdown on a year-precision goal asserts a day nobody chose —
    // and decrements nightly, so the false precision looks maintained.
    expect(describeTimeRemaining("2044-01-01", "year", 6570)).toBe("by 2044");
    expect(describeTimeRemaining("2044-03-01", "monthYear", 6600)).toBe("by March 2044");
  });

  it("never emits a day for a coarse target, whatever the day count says", () => {
    const label = describeTimeRemaining("2044-01-01", "year", 6570)!;
    expect(label).not.toMatch(/\bdays?\b/);
    expect(label).not.toMatch(/January/);
  });

  it("returns null when there is nothing honest to say", () => {
    expect(describeTimeRemaining("2027-06-14", "exact", null)).toBeNull();
    expect(describeTimeRemaining("2027-06-14", "exact", undefined)).toBeNull();
    expect(describeTimeRemaining(null, "year", 100)).toBeNull();
    expect(describeTimeRemaining("nonsense", "monthYear", 100)).toBeNull();
  });

  it("formats a long horizon readably", () => {
    expect(describeTimeRemaining("2044-06-14", "exact", 6570)).toBe("6,570 days left");
  });
});
