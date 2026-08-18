/**
 * Savings cadence — Owner QA item 1
 *
 * The create-jar plan screen hardcoded `const months = 6` with a comment
 * admitting it was a mockup, and never read the target date. A $25,000 goal
 * about two years out recommended $4,167/week, $8,333/2 weeks, and
 * $16,667/month. Those are the six-month figures, and the three cards were
 * one base amount scaled ×1/×2/×4 rather than three real calculations.
 *
 * Table-driven so horizons from three days to eighteen years are covered by
 * data rather than by prose, and so a regression in one horizon cannot hide
 * behind a passing case in another.
 *
 * Dates are constructed with explicit local-time components (`new Date(y, m,
 * d)`) rather than ISO strings, because `new Date("2026-08-11")` parses as UTC
 * and would shift a day in negative-offset timezones — precisely the class of
 * bug that makes "is this past due" flaky.
 */
import { describe, it, expect } from "vitest";
import {
  buildCadencePlan,
  classifyTargetDate,
  daysBetween,
  monthsBetween,
  periodsBetween,
  recommendForFrequency,
  splitPerPerson,
  frequencyUnitLabel,
  SAVINGS_FREQUENCIES,
  type SavingsFrequency,
  type TargetDateRelation,
} from "../lib/savings-cadence";

/** Fixed "today" so every expectation is deterministic. */
const TODAY = new Date(2026, 7, 11); // 11 Aug 2026, local
const d = (y: number, m: number, day: number) => new Date(y, m - 1, day);

const USD_25K = 2_500_000;

// ─── Date classification ─────────────────────────────────────────────────────
//
// The bug this guards against: deriving past-due from the number of complete
// cadence periods. A target three days out has zero complete weekly OR monthly
// periods but is plainly not overdue.

describe("classifyTargetDate", () => {
  const cases: Array<{ name: string; target: Date; expected: TargetDateRelation }> = [
    { name: "3 days in the future", target: d(2026, 8, 14), expected: "future" },
    { name: "later in the same month", target: d(2026, 8, 29), expected: "future" },
    { name: "8 days away", target: d(2026, 8, 19), expected: "future" },
    { name: "20 days away", target: d(2026, 8, 31), expected: "future" },
    { name: "exactly today", target: d(2026, 8, 11), expected: "today" },
    { name: "yesterday", target: d(2026, 8, 10), expected: "past" },
    { name: "a year ago", target: d(2025, 8, 11), expected: "past" },
    { name: "18 years out", target: d(2044, 8, 11), expected: "future" },
  ];

  for (const c of cases) {
    it(`${c.name} → ${c.expected}`, () => {
      expect(classifyTargetDate(TODAY, c.target)).toBe(c.expected);
    });
  }

  it("a short future target is never past due, even with zero complete periods", () => {
    const target = d(2026, 8, 14);

    expect(periodsBetween("weekly", TODAY, target)).toBe(0);
    expect(periodsBetween("monthly", TODAY, target)).toBe(0);

    const plan = buildCadencePlan({
      goalAmountCents: 100_000,
      participantCount: 1,
      startDate: TODAY,
      targetDate: target,
    });

    expect(plan.isPastDue).toBe(false);
    expect(plan.relation).toBe("future");
    expect(plan.byFrequency.weekly.isSinglePayment).toBe(true);
  });

  it("a target later in the same month is future-dated with zero whole months", () => {
    const target = d(2026, 8, 29);
    expect(monthsBetween(TODAY, target)).toBe(0);

    const plan = buildCadencePlan({
      goalAmountCents: 100_000,
      participantCount: 1,
      startDate: TODAY,
      targetDate: target,
    });

    expect(plan.isPastDue).toBe(false);
    expect(plan.byFrequency.monthly.isSinglePayment).toBe(true);
    // 18 days still fits two complete weeks.
    expect(plan.byFrequency.weekly.periods).toBe(2);
    expect(plan.byFrequency.biweekly.periods).toBe(1);
  });
});

// ─── Period counting across horizons ─────────────────────────────────────────

describe("periodsBetween", () => {
  const cases: Array<{
    name: string;
    target: Date;
    weekly: number;
    biweekly: number;
    monthly: number;
  }> = [
    { name: "3 days", target: d(2026, 8, 14), weekly: 0, biweekly: 0, monthly: 0 },
    { name: "8 days", target: d(2026, 8, 19), weekly: 1, biweekly: 0, monthly: 0 },
    { name: "20 days", target: d(2026, 8, 31), weekly: 2, biweekly: 1, monthly: 0 },
    { name: "~1 year", target: d(2027, 8, 11), weekly: 52, biweekly: 26, monthly: 12 },
    { name: "~2 years", target: d(2028, 8, 11), weekly: 104, biweekly: 52, monthly: 24 },
    { name: "5 years", target: d(2031, 8, 11), weekly: 260, biweekly: 130, monthly: 60 },
    { name: "18 years", target: d(2044, 8, 11), weekly: 939, biweekly: 469, monthly: 216 },
    { name: "today", target: d(2026, 8, 11), weekly: 0, biweekly: 0, monthly: 0 },
    { name: "yesterday", target: d(2026, 8, 10), weekly: 0, biweekly: 0, monthly: 0 },
  ];

  for (const c of cases) {
    it(`${c.name}`, () => {
      expect(periodsBetween("weekly", TODAY, c.target)).toBe(c.weekly);
      expect(periodsBetween("biweekly", TODAY, c.target)).toBe(c.biweekly);
      expect(periodsBetween("monthly", TODAY, c.target)).toBe(c.monthly);
    });
  }

  it("counts calendar months, not days/30", () => {
    // Feb is short; a days/30 approximation drifts here.
    expect(monthsBetween(d(2026, 1, 31), d(2026, 2, 28))).toBe(0);
    expect(monthsBetween(d(2026, 1, 15), d(2026, 2, 15))).toBe(1);
    expect(monthsBetween(d(2026, 1, 15), d(2026, 2, 14))).toBe(0);
    // 18 years is exactly 216 months regardless of leap days.
    expect(monthsBetween(d(2026, 8, 11), d(2044, 8, 11))).toBe(216);
  });

  it("never returns a negative period count", () => {
    for (const f of SAVINGS_FREQUENCIES) {
      expect(periodsBetween(f, TODAY, d(2020, 1, 1))).toBe(0);
    }
    expect(daysBetween(TODAY, d(2026, 8, 10))).toBe(-1);
  });
});

// ─── The original QA regression ──────────────────────────────────────────────

describe("the reported $25,000 / ~24 month case", () => {
  const plan = buildCadencePlan({
    goalAmountCents: USD_25K,
    participantCount: 1,
    startDate: TODAY,
    targetDate: d(2028, 8, 11),
  });

  it("no longer produces the hardcoded six-month figures", () => {
    // $4,167 / $8,333 / $16,667 were what the mockup constant produced.
    expect(plan.byFrequency.weekly.amountCents).not.toBe(416_667);
    expect(plan.byFrequency.biweekly.amountCents).not.toBe(833_333);
    expect(plan.byFrequency.monthly.amountCents).not.toBe(1_666_667);
  });

  it("divides the goal across the real horizon", () => {
    // 104 weeks, 52 fortnights, 24 months.
    expect(plan.byFrequency.weekly.amountCents).toBe(Math.ceil(USD_25K / 104)); // $240.39
    expect(plan.byFrequency.biweekly.amountCents).toBe(Math.ceil(USD_25K / 52)); // $480.77
    expect(plan.byFrequency.monthly.amountCents).toBe(Math.ceil(USD_25K / 24)); // $1,041.67
  });

  it("orders the cadences sensibly: weekly < bi-weekly < monthly", () => {
    // The old screen showed monthly as exactly 4× weekly because it scaled one
    // base amount. Real maths puts monthly at ~4.33× weekly.
    const { weekly, biweekly, monthly } = plan.byFrequency;
    expect(weekly.amountCents).toBeLessThan(biweekly.amountCents);
    expect(biweekly.amountCents).toBeLessThan(monthly.amountCents);
    expect(monthly.amountCents).not.toBe(weekly.amountCents * 4);
  });

  it("each cadence reaches the goal", () => {
    for (const f of SAVINGS_FREQUENCIES) {
      const r = plan.byFrequency[f];
      expect(r.amountCents * r.periods).toBeGreaterThanOrEqual(USD_25K);
    }
  });
});

// ─── Horizon table ───────────────────────────────────────────────────────────

describe("recommendation across horizons ($25,000, one participant)", () => {
  const cases: Array<{ name: string; target: Date; frequency: SavingsFrequency; cents: number }> = [
    { name: "1 year monthly", target: d(2027, 8, 11), frequency: "monthly", cents: Math.ceil(USD_25K / 12) },
    { name: "2 years monthly", target: d(2028, 8, 11), frequency: "monthly", cents: Math.ceil(USD_25K / 24) },
    { name: "5 years monthly", target: d(2031, 8, 11), frequency: "monthly", cents: Math.ceil(USD_25K / 60) },
    { name: "18 years monthly", target: d(2044, 8, 11), frequency: "monthly", cents: Math.ceil(USD_25K / 216) },
    { name: "18 years weekly", target: d(2044, 8, 11), frequency: "weekly", cents: Math.ceil(USD_25K / 939) },
    { name: "5 years biweekly", target: d(2031, 8, 11), frequency: "biweekly", cents: Math.ceil(USD_25K / 130) },
    { name: "8 days weekly", target: d(2026, 8, 19), frequency: "weekly", cents: USD_25K },
    { name: "20 days biweekly", target: d(2026, 8, 31), frequency: "biweekly", cents: USD_25K },
  ];

  for (const c of cases) {
    it(`${c.name} → ${c.cents}¢`, () => {
      const plan = buildCadencePlan({
        goalAmountCents: USD_25K,
        participantCount: 1,
        startDate: TODAY,
        targetDate: c.target,
      });
      expect(plan.byFrequency[c.frequency].amountCents).toBe(c.cents);
    });
  }

  it("an 18-year college fund is a manageable monthly figure", () => {
    const plan = buildCadencePlan({
      goalAmountCents: USD_25K,
      participantCount: 1,
      startDate: TODAY,
      targetDate: d(2044, 8, 11),
    });
    // ~$115.75/month, not the ~$4,167 the old constant produced.
    expect(plan.byFrequency.monthly.amountCents).toBeLessThan(12_000);
    expect(plan.byFrequency.monthly.periods).toBe(216);
  });
});

// ─── Past due and due today ──────────────────────────────────────────────────

describe("past due and due today", () => {
  it("yesterday is past due and still recommends the full remainder once", () => {
    const plan = buildCadencePlan({
      goalAmountCents: USD_25K,
      participantCount: 1,
      startDate: TODAY,
      targetDate: d(2026, 8, 10),
    });

    expect(plan.isPastDue).toBe(true);
    expect(plan.isDueToday).toBe(false);
    for (const f of SAVINGS_FREQUENCIES) {
      // Not zero merely because it is overdue.
      expect(plan.byFrequency[f].amountCents).toBe(USD_25K);
      expect(plan.byFrequency[f].periods).toBe(1);
      expect(plan.byFrequency[f].isSinglePayment).toBe(true);
    }
  });

  it("today is due today, not past due", () => {
    const plan = buildCadencePlan({
      goalAmountCents: USD_25K,
      participantCount: 1,
      startDate: TODAY,
      targetDate: d(2026, 8, 11),
    });

    expect(plan.relation).toBe("today");
    expect(plan.isDueToday).toBe(true);
    expect(plan.isPastDue).toBe(false);
    expect(plan.byFrequency.monthly.amountCents).toBe(USD_25K);
  });

  it("never returns Infinity, NaN, or a negative amount for any horizon", () => {
    const targets = [d(2020, 1, 1), d(2026, 8, 11), d(2026, 8, 14), d(2044, 8, 11)];
    for (const target of targets) {
      const plan = buildCadencePlan({
        goalAmountCents: USD_25K,
        participantCount: 1,
        startDate: TODAY,
        targetDate: target,
      });
      for (const f of SAVINGS_FREQUENCIES) {
        const amount = plan.byFrequency[f].amountCents;
        expect(Number.isFinite(amount)).toBe(true);
        expect(amount).toBeGreaterThanOrEqual(0);
        expect(plan.byFrequency[f].periods).toBeGreaterThanOrEqual(1);
      }
    }
  });
});

// ─── Participants ────────────────────────────────────────────────────────────

describe("participant count", () => {
  it("is the TOTAL including the organizer — the module never adds one", () => {
    // The create-jar flow stores only invited emails, so callers pass
    // `invitees.length + 1` (members.tsx:22, review.tsx:58). If this module
    // also added the organizer, four people would be billed as five.
    const inviteeCount = 3;
    const participantCount = inviteeCount + 1;

    const plan = buildCadencePlan({
      goalAmountCents: 100_000,
      participantCount,
      startDate: TODAY,
      targetDate: d(2027, 8, 11),
    });

    expect(plan.perPersonTargetCents).toBe(25_000); // 100_000 / 4, not / 5
  });

  it("one participant carries the whole goal", () => {
    const plan = buildCadencePlan({
      goalAmountCents: USD_25K,
      participantCount: 1,
      startDate: TODAY,
      targetDate: d(2028, 8, 11),
    });
    expect(plan.perPersonTargetCents).toBe(USD_25K);
  });

  it("multiple participants split the goal", () => {
    const plan = buildCadencePlan({
      goalAmountCents: USD_25K,
      participantCount: 5,
      startDate: TODAY,
      targetDate: d(2028, 8, 11),
    });
    expect(plan.perPersonTargetCents).toBe(500_000);
    expect(plan.byFrequency.monthly.amountCents).toBe(Math.ceil(500_000 / 24));
  });

  it("normalizes zero, negative, and fractional counts to one person", () => {
    for (const count of [0, -3, 0.4]) {
      expect(splitPerPerson(100_000, count)).toBe(100_000);
    }
    // 2.7 people floors to 2 rather than producing fractional participants.
    expect(splitPerPerson(100_000, 2.7)).toBe(50_000);
  });

  it("rounds the split up so the group never undershoots", () => {
    // $10,000 across 3 people: 333_334¢ each totals 1_000_002¢.
    const perPerson = splitPerPerson(1_000_000, 3);
    expect(perPerson).toBe(333_334);
    expect(perPerson * 3).toBeGreaterThanOrEqual(1_000_000);
  });
});

// ─── Already-saved principal ─────────────────────────────────────────────────

describe("already-saved principal", () => {
  it("reduces the remainder without changing the target", () => {
    const plan = buildCadencePlan({
      goalAmountCents: USD_25K,
      participantCount: 1,
      startDate: TODAY,
      targetDate: d(2028, 8, 11),
      alreadySavedCents: 500_000,
    });

    expect(plan.perPersonTargetCents).toBe(USD_25K);
    expect(plan.perPersonRemainingCents).toBe(2_000_000);
    expect(plan.byFrequency.monthly.amountCents).toBe(Math.ceil(2_000_000 / 24));
  });

  it("recommends nothing further once the target is met", () => {
    const plan = buildCadencePlan({
      goalAmountCents: USD_25K,
      participantCount: 1,
      startDate: TODAY,
      targetDate: d(2028, 8, 11),
      alreadySavedCents: USD_25K,
    });

    expect(plan.perPersonRemainingCents).toBe(0);
    for (const f of SAVINGS_FREQUENCIES) {
      expect(plan.byFrequency[f].amountCents).toBe(0);
    }
  });

  it("clamps at zero when more than the target has been saved", () => {
    const plan = buildCadencePlan({
      goalAmountCents: USD_25K,
      participantCount: 1,
      startDate: TODAY,
      targetDate: d(2028, 8, 11),
      alreadySavedCents: USD_25K * 2,
    });

    expect(plan.perPersonRemainingCents).toBe(0);
    expect(plan.byFrequency.monthly.amountCents).toBe(0);
  });

  it("ignores a negative already-saved value rather than inflating the goal", () => {
    const plan = buildCadencePlan({
      goalAmountCents: USD_25K,
      participantCount: 1,
      startDate: TODAY,
      targetDate: d(2028, 8, 11),
      alreadySavedCents: -50_000,
    });
    expect(plan.perPersonRemainingCents).toBe(USD_25K);
  });
});

// ─── Degenerate goals and rounding ───────────────────────────────────────────

describe("degenerate goals", () => {
  it("a zero goal recommends zero at every cadence", () => {
    const plan = buildCadencePlan({
      goalAmountCents: 0,
      participantCount: 4,
      startDate: TODAY,
      targetDate: d(2028, 8, 11),
    });

    expect(plan.perPersonTargetCents).toBe(0);
    for (const f of SAVINGS_FREQUENCIES) {
      expect(plan.byFrequency[f].amountCents).toBe(0);
    }
  });

  it("a negative goal is treated as zero", () => {
    expect(splitPerPerson(-100, 2)).toBe(0);
  });
});

describe("rounding", () => {
  it("is deterministic — identical inputs give identical cents", () => {
    const input = {
      goalAmountCents: 999_983,
      participantCount: 7,
      startDate: TODAY,
      targetDate: d(2029, 3, 17),
    };
    expect(buildCadencePlan(input)).toEqual(buildCadencePlan(input));
  });

  it("always reaches or slightly exceeds the target, never under", () => {
    const goals = [999_983, 1, 100, USD_25K, 12_345_678];
    const targets = [d(2027, 8, 11), d(2031, 2, 3), d(2044, 8, 11)];

    for (const goalAmountCents of goals) {
      for (const targetDate of targets) {
        for (const participantCount of [1, 3, 7]) {
          const plan = buildCadencePlan({
            goalAmountCents,
            participantCount,
            startDate: TODAY,
            targetDate,
          });
          for (const f of SAVINGS_FREQUENCIES) {
            const r = plan.byFrequency[f];
            expect(r.amountCents * r.periods).toBeGreaterThanOrEqual(
              plan.perPersonRemainingCents,
            );
          }
          expect(plan.perPersonTargetCents * participantCount).toBeGreaterThanOrEqual(
            goalAmountCents,
          );
        }
      }
    }
  });

  it("produces whole cents only", () => {
    const plan = buildCadencePlan({
      goalAmountCents: 999_983,
      participantCount: 7,
      startDate: TODAY,
      targetDate: d(2029, 3, 17),
    });
    for (const f of SAVINGS_FREQUENCIES) {
      expect(Number.isInteger(plan.byFrequency[f].amountCents)).toBe(true);
    }
    expect(Number.isInteger(plan.perPersonTargetCents)).toBe(true);
  });
});

// ─── Labels ──────────────────────────────────────────────────────────────────

describe("frequencyUnitLabel", () => {
  it("quotes each amount in its own unit", () => {
    expect(frequencyUnitLabel("weekly")).toBe("/ week");
    expect(frequencyUnitLabel("biweekly")).toBe("/ 2 weeks");
    expect(frequencyUnitLabel("monthly")).toBe("/ month");
  });
});

describe("recommendForFrequency", () => {
  it("is usable directly for a single cadence", () => {
    const r = recommendForFrequency("monthly", USD_25K, TODAY, d(2028, 8, 11));
    expect(r.frequency).toBe("monthly");
    expect(r.periods).toBe(24);
    expect(r.isSinglePayment).toBe(false);
  });
});
