import { describe, it, expect } from "vitest";
import {
  computeNextDueDate,
  computePreviousDueDate,
  toISODate,
} from "../lib/schedule-utils.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function d(str: string): Date {
  const [y, m, day] = str.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, day);
}

function makeSchedule(
  startDate: string,
  frequency: string,
  preferredDay?: number | null,
) {
  return { startDate, frequency, preferredDay: preferredDay ?? null };
}

// ─── computeNextDueDate ───────────────────────────────────────────────────────

describe("computeNextDueDate – weekly", () => {
  const schedule = makeSchedule("2026-07-01", "weekly");

  it("returns startDate when afterDate == startDate", () => {
    expect(toISODate(computeNextDueDate(schedule, d("2026-07-01"))!)).toBe("2026-07-01");
  });

  it("returns next weekly occurrence when between two due dates", () => {
    // Start 2026-07-01 (Wed). 7 days later = 2026-07-08
    expect(toISODate(computeNextDueDate(schedule, d("2026-07-02"))!)).toBe("2026-07-08");
    expect(toISODate(computeNextDueDate(schedule, d("2026-07-07"))!)).toBe("2026-07-08");
  });

  it("returns the exact due date when afterDate is on a due date", () => {
    expect(toISODate(computeNextDueDate(schedule, d("2026-07-08"))!)).toBe("2026-07-08");
  });

  it("never returns before startDate when afterDate is in the past", () => {
    expect(toISODate(computeNextDueDate(schedule, d("2026-06-15"))!)).toBe("2026-07-01");
  });
});

describe("computeNextDueDate – biweekly", () => {
  const schedule = makeSchedule("2026-07-01", "biweekly");

  it("returns startDate on same day", () => {
    expect(toISODate(computeNextDueDate(schedule, d("2026-07-01"))!)).toBe("2026-07-01");
  });

  it("returns correct biweekly date", () => {
    expect(toISODate(computeNextDueDate(schedule, d("2026-07-02"))!)).toBe("2026-07-15");
  });
});

describe("computeNextDueDate – monthly", () => {
  it("returns current month when day hasn't passed yet", () => {
    const schedule = makeSchedule("2026-07-10", "monthly");
    expect(toISODate(computeNextDueDate(schedule, d("2026-07-08"))!)).toBe("2026-07-10");
  });

  it("returns next month when the day has passed", () => {
    const schedule = makeSchedule("2026-07-10", "monthly");
    expect(toISODate(computeNextDueDate(schedule, d("2026-07-11"))!)).toBe("2026-08-10");
  });

  it("uses preferredDay when set", () => {
    const schedule = makeSchedule("2026-07-05", "monthly", 15);
    expect(toISODate(computeNextDueDate(schedule, d("2026-07-10"))!)).toBe("2026-07-15");
    expect(toISODate(computeNextDueDate(schedule, d("2026-07-16"))!)).toBe("2026-08-15");
  });

  it("clamps day 31 to last day of February without rollover", () => {
    const schedule = makeSchedule("2026-01-31", "monthly");
    // After Jan 31, next is Feb – but Feb has ≤28/29 days, so clamp to Feb 28
    const next = computeNextDueDate(schedule, d("2026-02-01"))!;
    expect(next.getMonth()).toBe(1); // still February
    expect(next.getFullYear()).toBe(2026);
  });

  it("clamps day 31 in April (30-day month) without rollover", () => {
    const schedule = makeSchedule("2026-03-31", "monthly");
    // After Mar 31, next is April: clamp to Apr 30
    const next = computeNextDueDate(schedule, d("2026-04-01"))!;
    expect(next.getMonth()).toBe(3); // April
    expect(next.getDate()).toBe(30);
  });

  it("never returns before schedule startDate when afterDate is earlier", () => {
    const schedule = makeSchedule("2026-08-15", "monthly");
    const next = computeNextDueDate(schedule, d("2026-07-01"))!;
    expect(toISODate(next)).toBe("2026-08-15");
  });
});

describe("computeNextDueDate – twiceMonthly", () => {
  it("returns first occurrence this month if not yet passed", () => {
    const schedule = makeSchedule("2026-07-01", "twiceMonthly", 5);
    // 5th and 20th; today is 3rd
    expect(toISODate(computeNextDueDate(schedule, d("2026-07-03"))!)).toBe("2026-07-05");
  });

  it("returns second occurrence when first has passed", () => {
    const schedule = makeSchedule("2026-07-01", "twiceMonthly", 5);
    expect(toISODate(computeNextDueDate(schedule, d("2026-07-06"))!)).toBe("2026-07-20");
  });

  it("rolls to next month's first day when both have passed", () => {
    const schedule = makeSchedule("2026-07-01", "twiceMonthly", 5);
    expect(toISODate(computeNextDueDate(schedule, d("2026-07-21"))!)).toBe("2026-08-05");
  });

  it("caps second day at 28 to avoid month rollover", () => {
    const schedule = makeSchedule("2026-07-01", "twiceMonthly", 15);
    // secondDay = min(15+15=30, 28) = 28
    const next = computeNextDueDate(schedule, d("2026-07-16"))!;
    expect(next.getDate()).toBe(28);
    expect(next.getMonth()).toBe(6); // July
  });
});

describe("computeNextDueDate – manual/custom returns null", () => {
  it("returns null for manual", () => {
    expect(computeNextDueDate(makeSchedule("2026-07-01", "manual"), d("2026-07-01"))).toBeNull();
  });
  it("returns null for custom", () => {
    expect(computeNextDueDate(makeSchedule("2026-07-01", "custom"), d("2026-07-01"))).toBeNull();
  });
});

// ─── computePreviousDueDate ───────────────────────────────────────────────────

describe("computePreviousDueDate – weekly", () => {
  const schedule = makeSchedule("2026-07-01", "weekly");

  it("returns null when no due date has passed (afterDate == startDate)", () => {
    expect(computePreviousDueDate(schedule, d("2026-07-01"))).toBeNull();
  });

  it("returns null when afterDate is before startDate", () => {
    expect(computePreviousDueDate(schedule, d("2026-06-20"))).toBeNull();
  });

  it("returns the just-passed due date", () => {
    // After 2026-07-08 next = 2026-07-08, prev = 2026-07-01
    expect(toISODate(computePreviousDueDate(schedule, d("2026-07-09"))!)).toBe("2026-07-08");
  });
});

describe("computePreviousDueDate – monthly", () => {
  it("returns null when no prior month due date exists (same month as start)", () => {
    const schedule = makeSchedule("2026-07-15", "monthly");
    // afterDate = 2026-07-16 → next = 2026-08-15, prev = 2026-07-15
    // But 2026-07-15 >= startDate 2026-07-15 → should return 2026-07-15
    const prev = computePreviousDueDate(schedule, d("2026-07-16"))!;
    expect(toISODate(prev)).toBe("2026-07-15");
  });

  it("returns null when the prev date would be before startDate", () => {
    const schedule = makeSchedule("2026-07-15", "monthly");
    // afterDate = 2026-07-14 (before 1st due date) → next = 2026-07-15, prev would be 2026-06-15 < start → null
    expect(computePreviousDueDate(schedule, d("2026-07-14"))).toBeNull();
  });
});

describe("computePreviousDueDate – twiceMonthly", () => {
  const schedule = makeSchedule("2026-07-01", "twiceMonthly", 5);

  it("returns 5th when today is between 20th and 5th next month", () => {
    // afterDate = 2026-07-21 → next = 2026-08-05, prev = 2026-07-20
    const prev = computePreviousDueDate(schedule, d("2026-07-21"))!;
    expect(toISODate(prev)).toBe("2026-07-20");
  });

  it("returns 5th from same month when today is between 5th and 20th", () => {
    // afterDate = 2026-07-06 → next = 2026-07-20, prev = 2026-07-05
    const prev = computePreviousDueDate(schedule, d("2026-07-06"))!;
    expect(toISODate(prev)).toBe("2026-07-05");
  });
});
