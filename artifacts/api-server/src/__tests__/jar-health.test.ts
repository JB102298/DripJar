import { describe, it, expect } from "vitest";
import { calculateJarHealth, calculateMemberHealth } from "../lib/jar-health.js";

/**
 * A date `daysFromNow` away, placed mid-day rather than exactly on the tick.
 *
 * `calculateJarHealth` reads its own `new Date()` and derives whole days with
 * `Math.ceil`. An offset landing exactly on a day boundary therefore sits on the
 * discontinuity: if the function is reached within the same millisecond the
 * elapsed span is exactly 60 days and ceils to 60, and if a single millisecond
 * has passed it ceils to 61. The test passed only because it usually won that
 * race, and lost it under full-suite load — `expected 61 to be close to 60`.
 *
 * Shifting by half a day puts every span strictly inside a day, so `ceil` gives
 * the same answer no matter how long the call takes. The assertions below are
 * unchanged; only the ambiguity is removed.
 */
const HALF_DAY_MS = 43_200_000;

function makeDate(daysFromNow: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return new Date(d.getTime() + HALF_DAY_MS);
}

describe("calculateJarHealth", () => {
  it("returns Ahead when actual progress is >10% above expected", () => {
    const launched = makeDate(-60);
    const target = makeDate(108); // 168 total days, 60 elapsed = 35.7% expected
    // Saved 80% actual vs 35.7% expected → diff = +44.3% → Ahead
    const result = calculateJarHealth(1_000_000, 800_000, launched, target);
    expect(result.status).toBe("Ahead");
    expect(result.actualPercentage).toBeCloseTo(80, 0);
    expect(result.amountBehindCents).toBe(0);
  });

  it("returns OnTrack when actual progress is within 10% of expected", () => {
    const launched = makeDate(-50);
    const target = makeDate(50); // 100 total days, 50 elapsed = 50% expected
    // Saved 48% actual → diff = -2% → OnTrack
    const result = calculateJarHealth(1_000_000, 480_000, launched, target);
    expect(result.status).toBe("OnTrack");
  });

  it("returns NeedsAttention when 10-20% behind", () => {
    const launched = makeDate(-50);
    const target = makeDate(50); // 50% expected
    // Saved 35% → diff = -15% → NeedsAttention
    const result = calculateJarHealth(1_000_000, 350_000, launched, target);
    expect(result.status).toBe("NeedsAttention");
    expect(result.amountBehindCents).toBeGreaterThan(0);
  });

  it("returns AtRisk when more than 20% behind", () => {
    const launched = makeDate(-80);
    const target = makeDate(20); // 80% expected
    // Saved 30% → diff = -50% → AtRisk
    const result = calculateJarHealth(1_000_000, 300_000, launched, target);
    expect(result.status).toBe("AtRisk");
  });

  it("calculates daysElapsed and totalDays correctly", () => {
    const launched = makeDate(-60);
    const target = makeDate(108);
    const result = calculateJarHealth(1_000_000, 700_000, launched, target);
    expect(result.daysElapsed).toBeCloseTo(60, 0);
    expect(result.totalDays).toBeCloseTo(168, 0);
  });

  it("handles goalAmountCents of 0 gracefully", () => {
    const launched = makeDate(-10);
    const target = makeDate(90);
    const result = calculateJarHealth(0, 0, launched, target);
    expect(result.actualPercentage).toBe(0);
    expect(result.status).toBeDefined();
  });

  it("caps actualPercentage at 100 when overfunded", () => {
    const launched = makeDate(-10);
    const target = makeDate(90);
    const result = calculateJarHealth(1_000_000, 1_200_000, launched, target);
    expect(result.actualPercentage).toBe(100);
    expect(result.status).toBe("Ahead");
  });

  it("provides an estimated completion date when savings rate exists", () => {
    const launched = makeDate(-60);
    const target = makeDate(108);
    const result = calculateJarHealth(1_000_000, 700_000, launched, target);
    expect(result.estimatedCompletionDate).toBeTruthy();
  });
});

describe("calculateMemberHealth", () => {
  it("returns NotStarted when no contributions made", () => {
    const status = calculateMemberHealth(200_000, 0, 30, 100);
    expect(status).toBe("NotStarted");
  });

  it("returns Ahead when member is significantly ahead", () => {
    const status = calculateMemberHealth(200_000, 180_000, 30, 100);
    // Expected at day 30/100: 30%. Actual: 90%. Diff = +60% → Ahead
    expect(status).toBe("Ahead");
  });

  it("returns AtRisk when member is significantly behind", () => {
    const status = calculateMemberHealth(200_000, 20_000, 80, 100);
    // Expected at day 80/100: 80%. Actual: 10%. Diff = -70% → AtRisk
    expect(status).toBe("AtRisk");
  });
});

describe("Contribution math helpers", () => {
  it("equal split calculation", () => {
    const goalAmountCents = 1_000_000;
    const memberCount = 5;
    const equalShareCents = Math.floor(goalAmountCents / memberCount);
    expect(equalShareCents).toBe(200_000);
    expect(equalShareCents * memberCount).toBe(1_000_000);
  });

  it("custom split validates total does not exceed goal", () => {
    const goalAmountCents = 1_000_000;
    const customSplits = [220_000, 200_000, 180_000, 220_000, 180_000];
    const total = customSplits.reduce((a, b) => a + b, 0);
    expect(total).toBe(1_000_000);
    expect(total <= goalAmountCents).toBe(true);
  });

  it("percentage calculation uses integer cents correctly", () => {
    const target = 200_000;
    const contributed = 164_000;
    const pct = (contributed / target) * 100;
    expect(Math.round(pct)).toBe(82);
  });

  it("amount behind calculation", () => {
    const goal = 1_000_000;
    const saved = 700_000;
    const expectedPct = 71.4;
    const expectedAmount = Math.round((expectedPct / 100) * goal);
    const amountBehind = Math.max(0, expectedAmount - saved);
    expect(amountBehind).toBeGreaterThan(0);
  });
});
