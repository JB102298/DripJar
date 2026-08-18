/**
 * Milestone allocation reconciliation UI — Owner QA item 3
 *
 * The backend half (api-server/src/__tests__/canonical-saved-principal.test.ts)
 * proves `totalAllocated + unallocated === savedPrincipal` always holds and
 * that `reconciles` goes false when attribution cannot be trusted. This proves
 * the screen actually acts on both facts.
 *
 * The original report: Hawaii 2027 showed $5,778 across five milestones while
 * the jar held $7,274. The difference was legitimate untagged money, but no
 * surface named it, so the screen read as "$1,496 has gone missing".
 *
 * Guards specifically against:
 *   - unallocated money going unnamed again
 *   - the displayed parts failing to add up to canonical saved principal
 *   - per-milestone amounts rendering when `reconciles` is false (the API
 *     zeroes them, so they would read as "nothing is funded")
 *   - a not-yet-loaded summary being treated as permission to show the split
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, cleanup, screen } from "@testing-library/react";
import { MilestoneAllocationSummary } from "../components/MilestoneAllocationSummary";
import {
  canShowAllocationBreakdown,
  type MilestoneSummaryResponse,
} from "../hooks/useMilestoneSummary";

vi.mock("@/hooks/useColors", () => ({
  useColors: () => ({
    background: "#fff", foreground: "#000", card: "#fff", primary: "#178B57",
    primaryForeground: "#fff", secondary: "#E8F6EF", secondaryForeground: "#0E5F3B",
    muted: "#eee", mutedForeground: "#657069", border: "#ddd", destructive: "#C94B4B",
    destructiveForeground: "#fff", success: "#2E9D63", warning: "#D99A25",
    darkGreen: "#0E5F3B", lightGreen: "#E8F6EF", radius: 12,
  }),
}));

vi.mock("@expo/vector-icons", () => ({ Feather: () => null }));

/** The reported Hawaii 2027 figures, to the cent. */
const HAWAII: MilestoneSummaryResponse = {
  jarId: "jar-hawaii",
  goalAmountCents: 1_000_000,
  savedPrincipalCents: 727_400,
  totalAllocatedCents: 577_800,
  unallocatedCents: 149_600,
  reconciles: true,
};

const text = (testId: string) => screen.getByTestId(testId).textContent ?? "";

/** Parse a "$1,234.56" label back to cents so the on-screen sum can be checked. */
const centsOf = (testId: string) =>
  Math.round(parseFloat(text(testId).replace(/[$,]/g, "")) * 100);

beforeEach(() => cleanup());
afterEach(cleanup);

// ─── The reconciling case ────────────────────────────────────────────────────

describe("when the split reconciles", () => {
  it("names the unallocated money instead of leaving a silent gap", () => {
    render(<MilestoneAllocationSummary summary={HAWAII} />);
    expect(screen.getByText("Not yet allocated")).toBeTruthy();
    expect(text("milestone-summary-unallocated")).toBe("$1,496.00");
  });

  it("shows allocated, unallocated, and canonical saved principal together", () => {
    render(<MilestoneAllocationSummary summary={HAWAII} />);
    expect(text("milestone-summary-allocated")).toBe("$5,778.00");
    expect(text("milestone-summary-unallocated")).toBe("$1,496.00");
    expect(text("milestone-summary-saved")).toBe("$7,274.00");
  });

  it("visually reconciles — the displayed parts add to the displayed total", () => {
    render(<MilestoneAllocationSummary summary={HAWAII} />);
    const sum = centsOf("milestone-summary-allocated") + centsOf("milestone-summary-unallocated");
    expect(sum).toBe(centsOf("milestone-summary-saved"));
    expect(centsOf("milestone-summary-reconciled-total")).toBe(centsOf("milestone-summary-saved"));
  });

  it("keeps reconciling when the split lands on part-dollar amounts", () => {
    // Whole-dollar rounding would render $5,779 + $1,496 = $7,274 here. The
    // exact-cents formatter exists for this case.
    render(
      <MilestoneAllocationSummary
        summary={{ ...HAWAII, savedPrincipalCents: 727_420, totalAllocatedCents: 577_860, unallocatedCents: 149_560 }}
      />,
    );
    const sum = centsOf("milestone-summary-allocated") + centsOf("milestone-summary-unallocated");
    expect(sum).toBe(centsOf("milestone-summary-saved"));
  });

  it("still shows the unallocated row when it is zero", () => {
    // The identity is the message. A row that disappears at zero teaches the
    // reader nothing about what the remaining rows mean.
    render(
      <MilestoneAllocationSummary
        summary={{ ...HAWAII, totalAllocatedCents: 727_400, unallocatedCents: 0 }}
      />,
    );
    expect(text("milestone-summary-unallocated")).toBe("$0.00");
    expect(screen.getByText(/Every dollar saved in this jar is tagged to a milestone/)).toBeTruthy();
  });

  it("explains what unallocated money is, not just that it exists", () => {
    render(<MilestoneAllocationSummary summary={HAWAII} />);
    expect(screen.getByText(/isn't tagged to a specific milestone/)).toBeTruthy();
    expect(screen.getByText(/still in the jar/)).toBeTruthy();
  });

  it("handles a jar with nothing saved without dividing by zero", () => {
    render(
      <MilestoneAllocationSummary
        summary={{ ...HAWAII, savedPrincipalCents: 0, totalAllocatedCents: 0, unallocatedCents: 0 }}
      />,
    );
    expect(text("milestone-summary-saved")).toBe("$0.00");
    expect(centsOf("milestone-summary-reconciled-total")).toBe(0);
  });

  it("does not tell an empty jar that every dollar is allocated", () => {
    // Real case: Hawaii 2027 reports savedPrincipalCents 0 under the canonical
    // ledger. "Every dollar saved is tagged to a milestone" is vacuously true
    // and reads as nonsense.
    render(
      <MilestoneAllocationSummary
        summary={{ ...HAWAII, savedPrincipalCents: 0, totalAllocatedCents: 0, unallocatedCents: 0 }}
      />,
    );
    expect(screen.queryByText(/Every dollar saved/)).toBeNull();
    expect(screen.getByText(/Nothing has been saved in this jar yet/)).toBeTruthy();
  });
});

// ─── The non-reconciling case ────────────────────────────────────────────────

describe("when the split does not reconcile", () => {
  const broken: MilestoneSummaryResponse = { ...HAWAII, reconciles: false, totalAllocatedCents: 0 };

  it("suppresses the allocation breakdown entirely", () => {
    render(<MilestoneAllocationSummary summary={broken} />);
    expect(screen.queryByTestId("milestone-summary-allocated")).toBeNull();
    expect(screen.queryByTestId("milestone-summary-unallocated")).toBeNull();
    expect(screen.queryByTestId("milestone-summary-reconciled-total")).toBeNull();
  });

  it("still shows canonical saved principal — the one number that is correct", () => {
    render(<MilestoneAllocationSummary summary={broken} />);
    expect(text("milestone-summary-saved")).toBe("$7,274.00");
  });

  it("explains the gap rather than leaving the reader to guess", () => {
    render(<MilestoneAllocationSummary summary={broken} />);
    expect(screen.getByText(/Milestone breakdown unavailable/)).toBeTruthy();
    expect(screen.getByText(/your money is unaffected/)).toBeTruthy();
  });

  it("never claims the allocated total is zero", () => {
    // The API zeroes every allocatedAmountCents in this state. Rendering that
    // would say "nothing is funded", which is wrong in a new way.
    render(<MilestoneAllocationSummary summary={broken} />);
    expect(screen.queryByText("$0.00")).toBeNull();
  });
});

// ─── The gate the screen uses to suppress per-milestone amounts ──────────────

describe("canShowAllocationBreakdown", () => {
  it("permits the breakdown only when the summary says it reconciles", () => {
    expect(canShowAllocationBreakdown(HAWAII)).toBe(true);
  });

  it("refuses when the summary says it does not reconcile", () => {
    expect(canShowAllocationBreakdown({ ...HAWAII, reconciles: false })).toBe(false);
  });

  it("refuses while the summary is absent", () => {
    // Loading or failed. Absence of evidence that the split is sound is not
    // evidence that it is — this is what stops a slow or 500ing summary
    // endpoint from silently re-enabling the misleading display.
    expect(canShowAllocationBreakdown(undefined)).toBe(false);
  });
});
