/**
 * Create-jar date validation blocks progression — pre-commit remediation item 4.
 *
 * The screen already rendered "Commitment date must be before the savings
 * target date" and then let the user press Continue anyway: six more steps,
 * then a 400 from the server at the final "Launch Jar". Explaining why someone
 * is stuck and then not stopping them is worse than doing neither — it reads as
 * a warning that can be ignored, right up until the work is thrown away.
 *
 * The comparison runs on the stored `yyyy-MM-dd` strings, not on parsed Dates,
 * which is what keeps it honest under coarse precision: a `year` target is
 * stored as 1 January, that IS the boundary the server enforces, and no day is
 * invented anywhere in the check.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React from "react";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

const { state, updateState, push } = vi.hoisted(() => ({
  state: {
    name: "Test Jar",
    category: "Vacation" as string,
    startDate: undefined as string | undefined,
    endDate: undefined as string | undefined,
    targetDate: "2027-06-14" as string | undefined,
    cutoffDate: undefined as string | undefined,
    targetDatePrecision: undefined as string | undefined,
    eventDatePrecision: undefined as string | undefined,
  },
  updateState: vi.fn(),
  push: vi.fn(),
}));

vi.mock("@/contexts/create-jar-context", () => ({
  useCreateJarContext: () => ({ state, updateState, resetState: vi.fn() }),
}));

vi.mock("expo-router", () => ({
  useRouter: () => ({ back: vi.fn(), push, replace: vi.fn() }),
}));

vi.mock("@/hooks/useColors", () => ({
  useColors: () => new Proxy({}, { get: () => "#000000" }),
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock("@expo/vector-icons", () => ({ Feather: () => null }));
vi.mock("@/components/ProgressBar", () => ({ ProgressBar: () => null }));
vi.mock("@react-native-community/datetimepicker", () => ({ default: () => null }));

import CreateJarStep2 from "../app/create-jar/dates";

afterEach(cleanup);

beforeEach(() => {
  push.mockClear();
  updateState.mockClear();
  state.category = "Vacation";
  state.startDate = undefined;
  state.endDate = undefined;
  state.targetDate = "2027-06-14";
  state.cutoffDate = undefined;
  state.targetDatePrecision = undefined;
  state.eventDatePrecision = undefined;
});

function continueButton(): HTMLElement {
  return screen.getByTestId("dates-continue");
}

describe("commitment date after the savings target", () => {
  beforeEach(() => {
    state.targetDate = "2027-06-14";
    state.cutoffDate = "2027-08-01"; // after the target — invalid
  });

  it("explains the problem", () => {
    render(<CreateJarStep2 />);
    expect(screen.getByTestId("cutoff-error").textContent).toMatch(
      /commitment date must be before/i,
    );
  });

  it("disables Continue", () => {
    render(<CreateJarStep2 />);
    expect(continueButton().getAttribute("aria-disabled")).toBe("true");
  });

  it("does not navigate even if the press lands", () => {
    render(<CreateJarStep2 />);
    fireEvent.click(continueButton());
    expect(push).not.toHaveBeenCalled();
  });

  it("blocks a commitment date equal to the target, not just after it", () => {
    // The server requires strictly before; the screen must agree or the user
    // gets a 400 at the very last step.
    state.cutoffDate = "2027-06-14";
    render(<CreateJarStep2 />);
    fireEvent.click(continueButton());
    expect(push).not.toHaveBeenCalled();
  });
});

describe("once the dates are valid", () => {
  it("enables Continue and navigates", () => {
    state.targetDate = "2027-06-14";
    state.cutoffDate = "2027-05-01";
    render(<CreateJarStep2 />);

    expect(screen.queryByTestId("cutoff-error")).toBeNull();
    expect(continueButton().getAttribute("aria-disabled")).not.toBe("true");

    fireEvent.click(continueButton());
    expect(push).toHaveBeenCalledWith("/create-jar/goal");
  });

  it("navigates with no commitment date at all — it is optional", () => {
    state.cutoffDate = undefined;
    render(<CreateJarStep2 />);
    fireEvent.click(continueButton());
    expect(push).toHaveBeenCalledWith("/create-jar/goal");
  });
});

describe("validation respects target-date precision without inventing a day", () => {
  it("treats a year-precision target as its stored 1 January boundary", () => {
    // Target "2044" is stored as 2044-01-01. A commitment date in March 2044 is
    // therefore AFTER it, even though "March 2044 is before 2044" looks
    // superficially odd — the stored value is what the server compares.
    state.category = "Education";
    state.targetDate = "2044-01-01";
    state.targetDatePrecision = "year";
    state.cutoffDate = "2044-03-01";

    render(<CreateJarStep2 />);
    fireEvent.click(continueButton());
    expect(push).not.toHaveBeenCalled();
  });

  it("explains a coarse boundary in terms the reader can act on", () => {
    state.category = "Education";
    state.targetDate = "2044-01-01";
    state.targetDatePrecision = "year";
    state.cutoffDate = "2044-03-01";

    render(<CreateJarStep2 />);
    const message = screen.getByTestId("cutoff-error").textContent ?? "";
    // Names the coarse label AND the concrete boundary it resolves to, so the
    // rule is not mysterious.
    expect(message).toContain("2044");
    expect(message).toContain("January 1, 2044");
  });

  it("accepts a commitment date genuinely before the coarse boundary", () => {
    state.category = "Education";
    state.targetDate = "2044-01-01";
    state.targetDatePrecision = "year";
    state.cutoffDate = "2043-11-01";

    render(<CreateJarStep2 />);
    expect(screen.queryByTestId("cutoff-error")).toBeNull();
    fireEvent.click(continueButton());
    expect(push).toHaveBeenCalledWith("/create-jar/goal");
  });

  it("does not fabricate a day for a monthYear target in the message", () => {
    state.category = "Wedding";
    state.targetDate = "2028-09-01";
    state.targetDatePrecision = "monthYear";
    state.cutoffDate = "2028-10-01";

    render(<CreateJarStep2 />);
    const message = screen.getByTestId("cutoff-error").textContent ?? "";
    expect(message).toContain("September 2028");
  });
});

describe("the pre-existing target-vs-event-start rule still blocks", () => {
  it("refuses to continue when the target is after the trip start", () => {
    state.startDate = "2027-06-01";
    state.targetDate = "2027-07-01";
    render(<CreateJarStep2 />);
    fireEvent.click(continueButton());
    expect(push).not.toHaveBeenCalled();
  });

  it("refuses to continue with no target date at all", () => {
    state.targetDate = undefined;
    render(<CreateJarStep2 />);
    fireEvent.click(continueButton());
    expect(push).not.toHaveBeenCalled();
  });
});
