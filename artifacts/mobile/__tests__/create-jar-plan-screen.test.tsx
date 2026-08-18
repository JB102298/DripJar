/**
 * Create-jar plan screen — Owner QA item 1
 *
 * The unit tests in savings-cadence.test.ts prove the maths. This proves the
 * screen actually uses it, which is where the bug lived: the module could be
 * perfect and the screen would still be wrong if it kept scaling one base
 * amount ×1/×2/×4 across the three cards.
 *
 * Guards specifically against:
 *   - the hardcoded six-month horizon reappearing
 *   - monthly being rendered as exactly 4× weekly
 *   - card amounts changing when a different card is selected
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import { buildCadencePlan, parseLocalDate } from "../lib/savings-cadence";

// ─── Create-jar state ────────────────────────────────────────────────────────

const { state, updateState } = vi.hoisted(() => ({
  // $25,000, one participant, ~2 years out — the exact reported case.
  state: {
    goalAmountCents: 2_500_000,
    targetDate: "2028-08-11",
    invitees: [] as { email: string }[],
    currency: "USD",
  },
  updateState: vi.fn(),
}));

vi.mock("@/contexts/create-jar-context", () => ({
  useCreateJarContext: () => ({ state, updateState, resetState: vi.fn() }),
}));

vi.mock("expo-router", () => ({
  useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/hooks/useColors", () => ({
  useColors: () => ({
    background: "#fff", foreground: "#000", card: "#fff", primary: "#178B57",
    primaryForeground: "#fff", secondary: "#E8F6EF", secondaryForeground: "#0E5F3B",
    muted: "#eee", mutedForeground: "#657069", border: "#ddd", destructive: "#C94B4B",
    destructiveForeground: "#fff", success: "#2E9D63", warning: "#D99A25",
    darkGreen: "#0E5F3B", lightGreen: "#E8F6EF", radius: 12,
  }),
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock("@expo/vector-icons", () => ({ Feather: () => null }));
vi.mock("@/components/ProgressBar", () => ({ ProgressBar: () => null }));

import CreateJarStep6 from "../app/create-jar/plan";

afterEach(cleanup);

/** All rendered "$X / unit" strings, in card order: weekly, bi-weekly, monthly. */
function renderedAmounts(): string[] {
  // queryAll, not getAll: the no-target-date case legitimately renders none,
  // and getAllByText throws rather than returning [].
  return screen
    .queryAllByText(/\$[\d,]+\.\d{2}\s*\/\s*(week|2 weeks|month)/)
    .map((el) => el.textContent ?? "");
}

describe("plan screen renders real per-cadence amounts", () => {
  it("shows three distinct amounts, one per cadence", () => {
    render(<CreateJarStep6 />);
    const amounts = renderedAmounts();

    expect(amounts).toHaveLength(3);
    expect(new Set(amounts).size).toBe(3);
  });

  it("matches the cadence module exactly", () => {
    render(<CreateJarStep6 />);

    const plan = buildCadencePlan({
      goalAmountCents: 2_500_000,
      participantCount: 1,
      startDate: new Date(),
      targetDate: parseLocalDate("2028-08-11")!,
    });

    const amounts = renderedAmounts().join(" | ");
    const fmt = (c: number) =>
      (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

    expect(amounts).toContain(`${fmt(plan.byFrequency.weekly.amountCents)} / week`);
    expect(amounts).toContain(`${fmt(plan.byFrequency.biweekly.amountCents)} / 2 weeks`);
    expect(amounts).toContain(`${fmt(plan.byFrequency.monthly.amountCents)} / month`);
  });

  it("does not render the hardcoded six-month figures", () => {
    render(<CreateJarStep6 />);
    const joined = renderedAmounts().join(" | ");

    // What the mockup constant produced for this exact input.
    expect(joined).not.toContain("$4,166.67");
    expect(joined).not.toContain("$4,167");
    expect(joined).not.toContain("$8,333");
    expect(joined).not.toContain("$16,666.67");
    expect(joined).not.toContain("$16,667");
  });

  it("does not render monthly as exactly 4x weekly", () => {
    render(<CreateJarStep6 />);

    const parse = (s: string) => Number(s.replace(/[^0-9.]/g, ""));
    const amounts = renderedAmounts();
    const weekly = parse(amounts.find((a) => a.includes("/ week"))!);
    const monthly = parse(amounts.find((a) => a.includes("/ month"))!);

    // Real ratio is ~4.33 (52 weeks vs 12 months), never exactly 4.
    expect(monthly).not.toBeCloseTo(weekly * 4, 2);
    expect(monthly / weekly).toBeGreaterThan(4.2);
  });

  it("keeps the amounts stable when a different cadence is selected", () => {
    render(<CreateJarStep6 />);
    const before = renderedAmounts();

    fireEvent.click(screen.getByText("Weekly"));

    // The old screen recomputed a base amount from the selected frequency, so
    // every card's number moved when the selection changed.
    expect(renderedAmounts()).toEqual(before);
  });
});

describe("plan screen without a target date", () => {
  it("asks for a target date instead of inventing a horizon", () => {
    const original = state.targetDate;
    state.targetDate = "";
    try {
      render(<CreateJarStep6 />);
      expect(screen.getAllByText(/Set a target date to see an estimate/).length).toBe(3);
      expect(renderedAmounts()).toHaveLength(0);
    } finally {
      state.targetDate = original;
    }
  });
});
