/**
 * Create-jar screens read their copy from the category record — Owner QA 6/7.
 *
 * `jar-categories.test.ts` proves the catalogue itself is free of travel
 * framing. That is necessary and not sufficient: the catalogue could be perfect
 * and the screens would still say "When is the trip?" if they kept their
 * hard-coded strings. These tests render the actual screens under a non-travel
 * category and assert the travel wording is gone, then render the same screens
 * under Vacation and assert the trip wording is back — which is what
 * distinguishes "reads the config" from "someone deleted the word trip".
 *
 * `dates.tsx` pulls in `@react-native-community/datetimepicker`, a native
 * module jsdom cannot load, so it is mocked below. A previous test file noted
 * that screen as untestable for exactly this reason; mocking the picker makes
 * it reachable.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React from "react";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

const { state, updateState } = vi.hoisted(() => ({
  state: {
    name: "Ava's College Fund",
    category: "Education" as string | undefined,
    destination: undefined as string | undefined,
    description: undefined as string | undefined,
    startDate: undefined as string | undefined,
    endDate: undefined as string | undefined,
    targetDate: "2044-01-01" as string | undefined,
    cutoffDate: undefined as string | undefined,
    goalAmountCents: 5_000_000,
    milestones: [] as { name: string; targetAmountCents: number }[],
    invitees: [] as { email: string }[],
    targetDatePrecision: undefined as string | undefined,
    eventDatePrecision: undefined as string | undefined,
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
  useColors: () => new Proxy({}, { get: () => "#000000" }),
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock("@expo/vector-icons", () => ({ Feather: () => null }));
vi.mock("@/components/ProgressBar", () => ({ ProgressBar: () => null }));

// Native-only module: not loadable under jsdom.
vi.mock("@react-native-community/datetimepicker", () => ({ default: () => null }));

vi.mock("@workspace/api-client-react", () => ({
  useCreateJar: () => ({ mutateAsync: vi.fn() }),
  CreateJarRequestCategory: {},
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import CreateJarStep1 from "../app/create-jar/index";
import CreateJarStep2 from "../app/create-jar/dates";
import CreateJarStep4 from "../app/create-jar/milestones";
import CreateJarStep8 from "../app/create-jar/review";

/** Wording that presumes the jar is a trip. */
const TRAVEL_FRAMING = /\b(trip|takeoff|flights|itinerary|destination)\b/i;

function bodyText(): string {
  return document.body.textContent ?? "";
}

afterEach(cleanup);

beforeEach(() => {
  state.category = "Education";
  state.destination = undefined;
  state.startDate = undefined;
  state.endDate = undefined;
  state.targetDate = "2044-01-01";
  state.targetDatePrecision = undefined;
  state.eventDatePrecision = undefined;
});

describe("non-travel category (Education) — no travel framing anywhere", () => {
  it("step 1 does not call the jar a trip", () => {
    render(<CreateJarStep1 />);
    expect(bodyText()).not.toMatch(TRAVEL_FRAMING);
  });

  it("step 2 asks a date question that fits the category", () => {
    render(<CreateJarStep2 />);
    const text = bodyText();
    expect(text).not.toMatch(TRAVEL_FRAMING);
    // The specific string that shipped: "When is the trip?"
    expect(text).toContain("When will the money be needed?");
    expect(text).not.toContain("Trip Start Date");
  });

  it("step 2 offers no event window for a category that has no event", () => {
    render(<CreateJarStep2 />);
    expect(screen.queryByTestId("event-start-date")).toBeNull();
    expect(screen.queryByTestId("event-end-date")).toBeNull();
    // The savings target date is still asked for.
    expect(screen.getByTestId("savings-target-date")).toBeTruthy();
  });

  it("step 4 suggests milestones that fit the category", () => {
    render(<CreateJarStep4 />);
    const text = bodyText();
    expect(text).not.toMatch(TRAVEL_FRAMING);
    expect(screen.getByTestId("milestone-suggestion-Tuition")).toBeTruthy();
    expect(screen.queryByTestId("milestone-suggestion-Flights")).toBeNull();
  });

  it("step 8 does not say 'Ready for takeoff!'", () => {
    render(<CreateJarStep8 />);
    const text = bodyText();
    expect(text).not.toMatch(TRAVEL_FRAMING);
    expect(text).toContain("Ready to start saving!");
  });

  it("step 1 hides the place field when the category has no place", () => {
    state.category = "EmergencyFund";
    render(<CreateJarStep1 />);
    expect(screen.queryByTestId("jar-location-input")).toBeNull();
  });

  it("step 8 omits the place row when no place was given", () => {
    // Previously rendered a "Destination" row with an empty value for every
    // jar that had none.
    render(<CreateJarStep8 />);
    expect(bodyText()).not.toContain("Destination");
  });
});

describe("switching category clears answers the new category cannot ask for", () => {
  beforeEach(() => {
    updateState.mockClear();
    state.category = "Vacation";
    state.destination = "Maui, Hawaii";
    state.startDate = "2027-06-20";
    state.endDate = "2027-06-27";
  });

  it("clears the place and the event window when moving to a category with neither", () => {
    render(<CreateJarStep1 />);
    fireEvent.click(screen.getByTestId("category-EmergencyFund"));

    // Merely hiding the fields would ship a stale destination the organizer can
    // no longer see or edit — and several screens render it unconditionally.
    expect(updateState).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "EmergencyFund",
        destination: undefined,
        startDate: undefined,
        endDate: undefined,
      }),
    );
  });

  it("keeps them when moving to a category that still has both", () => {
    render(<CreateJarStep1 />);
    fireEvent.click(screen.getByTestId("category-Cruise"));

    const payload = updateState.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.category).toBe("Cruise");
    expect(payload).not.toHaveProperty("destination");
    expect(payload).not.toHaveProperty("startDate");
    expect(payload).not.toHaveProperty("endDate");
  });

  it("clears only the place when the new category keeps an event window", () => {
    render(<CreateJarStep1 />);
    fireEvent.click(screen.getByTestId("category-Wedding"));

    // Wedding has a venue field, so the place survives; so does the window.
    const payload = updateState.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("destination");
    expect(payload).not.toHaveProperty("startDate");
  });
});

describe("travel category (Vacation) — trip wording is restored, not deleted", () => {
  beforeEach(() => {
    state.category = "Vacation";
    state.destination = "Maui, Hawaii";
    state.targetDate = "2027-06-01";
  });

  it("step 2 asks about the trip and offers the trip window", () => {
    render(<CreateJarStep2 />);
    expect(bodyText()).toContain("When is the trip?");
    expect(screen.getByTestId("event-start-date")).toBeTruthy();
    expect(screen.getByTestId("event-end-date")).toBeTruthy();
  });

  it("step 4 suggests flights again", () => {
    render(<CreateJarStep4 />);
    expect(screen.getByTestId("milestone-suggestion-Flights")).toBeTruthy();
  });

  it("step 8 says 'Ready for takeoff!' and labels the destination", () => {
    render(<CreateJarStep8 />);
    const text = bodyText();
    expect(text).toContain("Ready for takeoff!");
    expect(text).toContain("Destination");
    expect(text).toContain("Maui, Hawaii");
  });
});

describe("unknown stored category falls back to Other", () => {
  beforeEach(() => {
    // The column is free text with no server-side enum validation, so values
    // this build has never heard of genuinely arrive here.
    state.category = "GroupTrip";
    state.targetDate = "2030-01-01";
  });

  it("renders neutral copy rather than blank headings", () => {
    render(<CreateJarStep2 />);
    const text = bodyText();
    expect(text).toContain("When do you need the money?");
    expect(text).not.toMatch(TRAVEL_FRAMING);
  });

  it("still renders the review screen", () => {
    render(<CreateJarStep8 />);
    expect(bodyText()).toContain("Ready to start saving!");
  });
});

describe("review screen renders the target date at the chosen precision", () => {
  it("shows a year-precision target as a bare year", () => {
    state.category = "Education";
    state.targetDate = "2044-01-01";
    state.targetDatePrecision = "year";
    render(<CreateJarStep8 />);

    expect(screen.getByTestId("review-target-date").textContent).toBe("2044");
  });

  it("shows an exact-precision target as a full local date", () => {
    state.category = "Vacation";
    state.targetDate = "2027-06-14";
    state.targetDatePrecision = "exact";
    render(<CreateJarStep8 />);

    // The old implementation parsed this as UTC midnight and rendered 13 June
    // in every US timezone.
    expect(screen.getByTestId("review-target-date").textContent).toBe("June 14, 2027");
  });
});
